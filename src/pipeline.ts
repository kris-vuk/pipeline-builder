import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Stage, type StageProps, type StageSynthesisOptions } from 'aws-cdk-lib';
import type { CloudAssembly } from 'aws-cdk-lib/cx-api';
import type { Construct } from 'constructs';
import {
  BuildStage, DefinitionSyncStage, DeploymentStage, PipelineStage,
  type DeploymentStageProps, type PipelineStageProps,
} from './pipeline-stage';
import { PipelineExecutionMode, type PipelineDefinition } from './schema';
import { requireLiteral, requireUnique } from './validation';

export interface PipelineProps extends StageProps {
  /** @default construct ID */
  readonly pipelineName?: string;
}

/** A CDK assembly containing a Foundry pipeline definition and its deployment stacks. */
export class Pipeline extends Stage {
  public readonly pipelineName: string;
  private readonly stages: PipelineStage[] = [];
  private synthesizedDefinition: string | undefined;

  constructor(scope: Construct, id: string, props: PipelineProps = {}) {
    super(scope, id, props);
    this.pipelineName = props.pipelineName ?? id;
    requireLiteral(this.pipelineName, 'Pipeline name');
  }

  /** Absolute path to the pipeline JSON in this pipeline's CDK cloud assembly. */
  get pipelineFile(): string { return join(this.outdir, 'pipeline.json'); }

  addStage(id: string, props: DeploymentStageProps = {}): DeploymentStage {
    this.checkStageId(id);
    const stage = new DeploymentStage(this, id, props);
    this.stages.push(stage);
    return stage;
  }

  addBuildStage(id: string, props: PipelineStageProps = {}): BuildStage {
    this.checkStageId(id);
    const stage = new BuildStage(this, id, props);
    this.stages.push(stage);
    return stage;
  }

  addDefinitionSyncStage(id: string, props: PipelineStageProps = {}): DefinitionSyncStage {
    this.checkStageId(id);
    const stage = new DefinitionSyncStage(this, id, props);
    this.stages.push(stage);
    return stage;
  }

  /** Returns a fresh stateless snapshot; does not write files or synthesize stacks. */
  toDefinition(): PipelineDefinition {
    if (!this.stages.length) throw new Error(`Pipeline ${this.pipelineName} requires at least one stage.`);
    return {
      schemaVersion: 2, name: this.pipelineName, executionMode: PipelineExecutionMode.Sequential,
      stages: this.stages.map((stage, index) => stage.toDefinition(this, index < this.stages.length - 1)),
    };
  }

  override synth(options: StageSynthesisOptions = {}): CloudAssembly {
    // CDK invokes this public hook when synthesizing the parent App. Serialize
    // after super.synth so resources added by aspects/preparation are included.
    this.toDefinition();
    const assembly = super.synth(options);
    const json = `${JSON.stringify(this.toDefinition(), null, 2)}\n`;
    if (!options.force && this.synthesizedDefinition !== undefined && this.synthesizedDefinition !== json) {
      throw new Error('Pipeline definition changed after synthesis. Create a new App for a new synthesis.');
    }
    writeFileSync(this.pipelineFile, json, 'utf8');
    this.synthesizedDefinition = json;
    return assembly;
  }

  private checkStageId(id: string): void {
    requireLiteral(id, 'Stage ID');
    requireUnique(this.stages.map(stage => stage.id), id, 'stage');
  }
}
