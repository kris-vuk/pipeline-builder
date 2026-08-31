import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { App, Aspects, type IAspect } from 'aws-cdk-lib';
import { Construct, type IConstruct } from 'constructs';
import { PipelineStage, type PipelineStageProps } from './pipeline-stage';
import {
  BUILD_COMMAND, SCHEMA_VERSION,
  type CreatePipelineRequest, type PipelineDefinition, type SelfMutateDefinition,
  type TrackedPackageDefinition,
} from './schema';
import type { StepContext } from './step';
import { requireLiteral, requireUnique } from './validation';

/** Default file name; the whole `POST /pipelines` body, so it can be posted as-is. */
export const PIPELINE_FILE_NAME = 'pipeline.json';

/** The cloud assembly the runner deploys from, relative to the repository root. */
export const DEFAULT_CDK_OUT_PATH = 'cdk.out';

export interface TrackedPackageProps {
  readonly repository: string;
  /** @default 'main' */
  readonly branch?: string;
}

export interface PipelineProps {
  /** @default the construct ID */
  readonly pipelineName?: string;
  /** Cloned and `make build`-ed on every change; at least one is required. */
  readonly trackedPackages?: readonly TrackedPackageProps[];
  /** Where each tracked package leaves its cloud assembly. @default 'cdk.out' */
  readonly cdkOutPath?: string;
  /** Written into the app's `cdk.out`. @default 'pipeline.json' */
  readonly fileName?: string;
  /**
   * Whether every run re-reads this file and updates the stored pipeline from it, so a change
   * to the pipeline ships like any other. @default true when exactly one package is tracked
   */
  readonly selfMutate?: boolean;
  /** Which tracked package the build reads it from. @default the only tracked package */
  readonly selfMutateSource?: string;
}

/** Writes the pipeline JSON once the app it belongs to is synthesized. */
class WriteDefinition implements IAspect {
  constructor(private readonly app: App, private readonly pipeline: Pipeline) {}

  visit(node: IConstruct): void {
    if (node === this.app) this.pipeline.writeDefinition();
  }
}

/** A Foundry pipeline defined alongside the CDK stacks its stages deploy. */
export class Pipeline extends Construct {
  public readonly pipelineName: string;
  private readonly app: App;
  private readonly fileName: string;
  private readonly cdkOutPath: string;
  private readonly selfMutate: boolean | undefined;
  private readonly selfMutateSource: string | undefined;
  private readonly trackedPackages: TrackedPackageDefinition[] = [];
  private readonly stages: PipelineStage[] = [];

  constructor(scope: Construct, id: string, props: PipelineProps = {}) {
    super(scope, id);
    const app = this.node.root;
    if (!App.isApp(app)) throw new Error('A Pipeline must be created within a CDK App.');
    this.app = app;
    this.pipelineName = props.pipelineName ?? id;
    requireLiteral(this.pipelineName, 'Pipeline name');
    this.fileName = props.fileName ?? PIPELINE_FILE_NAME;
    requireLiteral(this.fileName, 'Pipeline file name');
    this.cdkOutPath = props.cdkOutPath ?? DEFAULT_CDK_OUT_PATH;
    requireLiteral(this.cdkOutPath, 'Pipeline cdk.out path');
    this.selfMutate = props.selfMutate;
    this.selfMutateSource = props.selfMutateSource;
    if (this.selfMutateSource !== undefined) requireLiteral(this.selfMutateSource, 'Pipeline self-mutate source');
    (props.trackedPackages ?? []).forEach(tracked => this.addTrackedPackage(tracked));
    Aspects.of(app).add(new WriteDefinition(app, this));
  }

  /** Absolute path of the JSON this pipeline writes into the app's cloud assembly. */
  get pipelineFile(): string { return join(this.app.outdir, this.fileName); }

  addTrackedPackage(props: TrackedPackageProps): this {
    requireLiteral(props.repository, 'Tracked package repository');
    requireLiteral(props.branch ?? 'main', 'Tracked package branch');
    requireUnique(this.trackedPackages.map(tracked => tracked.repository), props.repository, 'tracked package');
    this.trackedPackages.push({ repository: props.repository, branch: props.branch ?? 'main' });
    return this;
  }

  addStage(id: string, props: PipelineStageProps = {}): PipelineStage {
    requireLiteral(id, 'Stage ID');
    const stage = new PipelineStage(this, id, props);
    this.stages.push(stage);
    return stage;
  }

  /** A fresh snapshot; writes nothing, so it is safe to inspect mid-configuration. */
  toDefinition(): PipelineDefinition {
    if (!this.trackedPackages.length) {
      throw new Error(`Pipeline ${this.pipelineName} requires at least one tracked package.`);
    }
    const context: StepContext = {
      trackedPackages: structuredClone(this.trackedPackages), cdkOutPath: this.cdkOutPath,
    };
    const selfMutate = this.selfMutateDefinition();
    return {
      schemaVersion: SCHEMA_VERSION,
      build: { command: BUILD_COMMAND, trackedPackages: context.trackedPackages },
      stages: this.stages.map(stage => stage.toDefinition(context)),
      ...(selfMutate ? { selfMutate } : {}),
    };
  }

  /** The file this pipeline writes, as the runner sees it: repository-relative, inside the assembly. */
  private selfMutateDefinition(): SelfMutateDefinition | undefined {
    const repositories = this.trackedPackages.map(tracked => tracked.repository);
    const [only] = repositories;
    const source = this.selfMutateSource ?? (repositories.length === 1 ? only : undefined);
    if (this.selfMutate === false) return undefined;
    if (source === undefined) {
      if (this.selfMutate !== true) return undefined;
      throw new Error(
        `Pipeline ${this.pipelineName} tracks ${repositories.length} packages, so selfMutateSource must name the one holding ${this.fileName}.`,
      );
    }
    if (!repositories.includes(source)) {
      throw new Error(`"${source}" is not one of the pipeline's tracked packages: ${repositories.join(', ') || 'none'}.`);
    }
    return { source, path: `${this.cdkOutPath}/${this.fileName}` };
  }

  /** The `POST /pipelines` body: the definition plus the name it is created under. */
  toCreateRequest(): CreatePipelineRequest {
    return { pipelineName: this.pipelineName, definition: this.toDefinition() };
  }

  /** Called for you when the app synthesizes; returns the file it wrote. */
  writeDefinition(): string {
    this.checkFileIsUnclaimed();
    writeFileSync(this.pipelineFile, `${JSON.stringify(this.toCreateRequest(), null, 2)}\n`, 'utf8');
    return this.pipelineFile;
  }

  private checkFileIsUnclaimed(): void {
    const clash = this.app.node.findAll()
      .find(node => node !== this && node instanceof Pipeline && node.pipelineFile === this.pipelineFile);
    if (clash) {
      throw new Error(
        `Pipelines ${this.node.path} and ${clash.node.path} both write ${this.fileName}; set a different fileName.`,
      );
    }
  }
}
