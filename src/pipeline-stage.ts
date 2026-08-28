import { Construct } from 'constructs';
import { Stage as CDKStage } from 'aws-cdk-lib';
import type { IApprovalStep } from './approval-step';
import type { IDeploymentTarget } from './deployment-target';
import {
  ApprovalStepType, StageType, TargetExecutionMode,
  type BuildSource, type BuildStageDefinition, type DefinitionSyncStageDefinition,
  type DeploymentStageDefinition, type StageDefinition, type StageDefinitionBase,
} from './schema';
import { requireLiteral, requireUnique } from './validation';

export interface PipelineStageProps {
  readonly name?: string;
  /** Controls promotion to the next stage. @default true */
  readonly promotionEnabled?: boolean;
}

export abstract class PipelineStage extends Construct {
  public readonly name: string;
  private promotionEnabled: boolean;

  constructor(scope: Construct, public readonly id: string, props: PipelineStageProps = {}) {
    super(scope, id);
    requireLiteral(id, 'Stage ID');
    this.name = props.name ?? id;
    requireLiteral(this.name, 'Stage name');
    this.promotionEnabled = props.promotionEnabled ?? true;
  }

  setPromotionEnabled(enabled: boolean): this { this.promotionEnabled = enabled; return this; }

  protected base(hasNext: boolean): StageDefinitionBase {
    return { id: this.id, name: this.name, ...(hasNext ? { promotion: { enabled: this.promotionEnabled } } : {}) };
  }

  abstract toDefinition(pipeline: CDKStage, hasNext: boolean): StageDefinition;
}

export interface BuildSourceProps {
  readonly path: string;
  readonly branch?: string;
  readonly tracking?: boolean;
}

export class BuildStage extends PipelineStage {
  private readonly sources: BuildSource[] = [];

  addSource(props: BuildSourceProps): this {
    requireLiteral(props.path, 'Build source path');
    requireLiteral(props.branch ?? 'main', 'Build source branch');
    requireUnique(this.sources.map(source => source.path), props.path, 'build source');
    this.sources.push({ path: props.path, branch: props.branch ?? 'main', tracking: props.tracking ?? true });
    return this;
  }

  override toDefinition(_pipeline: CDKStage, hasNext: boolean): BuildStageDefinition {
    if (!this.sources.length) throw new Error(`Build stage ${this.id} requires at least one source.`);
    return { ...this.base(hasNext), type: StageType.Build, sources: structuredClone(this.sources) };
  }
}

export class DefinitionSyncStage extends PipelineStage {
  override toDefinition(_pipeline: CDKStage, hasNext: boolean): DefinitionSyncStageDefinition {
    return { ...this.base(hasNext), type: StageType.DefinitionSync };
  }
}

export interface DeploymentStageProps extends PipelineStageProps { readonly description?: string }

export class DeploymentStage extends PipelineStage {
  private readonly description: string | undefined;
  private readonly targets: IDeploymentTarget[] = [];
  private readonly approvals: IApprovalStep[] = [];

  constructor(scope: Construct, id: string, props: DeploymentStageProps = {}) {
    super(scope, id, props);
    this.description = props.description;
  }

  addDeploymentTarget<T extends IDeploymentTarget>(target: T): T {
    requireLiteral(target.id, 'Target ID');
    requireUnique(this.targets.map(existing => existing.id), target.id, 'deployment target');
    this.targets.push(target);
    return target;
  }

  addApprovalStep<T extends IApprovalStep>(step: T): T {
    requireLiteral(step.id, 'Approval ID');
    requireUnique(this.approvals.map(existing => existing.id), step.id, 'approval step');
    this.approvals.push(step);
    return step;
  }

  override toDefinition(pipeline: CDKStage, hasNext: boolean): DeploymentStageDefinition {
    if (!this.targets.length) throw new Error(`Deployment stage ${this.id} requires at least one target.`);
    const approvalSteps = this.approvals.map(step => step.toDefinition({ pipeline }));
    for (const step of approvalSteps) {
      if (step.type !== ApprovalStepType.IntegrationTests) continue;
      for (const targetId of step.targetIds ?? []) {
        if (!this.targets.some(target => target.id === targetId)) {
          throw new Error(`Approval ${step.id} references unknown target ${targetId} in stage ${this.id}.`);
        }
      }
    }
    return {
      ...this.base(hasNext), type: StageType.Deployment,
      ...(this.description === undefined ? {} : { description: this.description }),
      targetExecutionMode: TargetExecutionMode.Parallel,
      targets: this.targets.map(target => target.toDefinition({ pipeline })), approvalSteps,
    };
  }
}
