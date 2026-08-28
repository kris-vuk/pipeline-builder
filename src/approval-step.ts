import { Stack } from 'aws-cdk-lib';
import { CDKDeploymentTarget, type CDKDeploymentTargetProps, type DeploymentTargetContext } from './deployment-target';
import {
  ApprovalFailureAction, ApprovalStepType,
  type ApprovalStepDefinition, type BakeTimeApprovalDefinition,
  type IntegrationTestsApprovalDefinition,
} from './schema';
import { requireLiteral } from './validation';

export interface IApprovalStep {
  readonly id: string;
  toDefinition(context: DeploymentTargetContext): ApprovalStepDefinition;
}

export interface IntegrationTestsApprovalStepProps extends Pick<CDKDeploymentTargetProps, 'id' | 'source'> {
  readonly targetIds?: readonly string[];
  /** @default [ApprovalFailureAction.Block, ApprovalFailureAction.Rollback] */
  readonly onFailure?: readonly ApprovalFailureAction[];
}

export class IntegrationTestsApprovalStep implements IApprovalStep {
  public readonly id: string;
  private readonly target: CDKDeploymentTarget;
  private readonly definition: Omit<IntegrationTestsApprovalDefinition, 'deployment'>;

  constructor(stack: Stack, props: IntegrationTestsApprovalStepProps = {}) {
    this.target = new CDKDeploymentTarget(stack, props);
    this.id = this.target.id;
    const onFailure = [...(props.onFailure ?? [ApprovalFailureAction.Block, ApprovalFailureAction.Rollback])];
    if (onFailure[0] !== ApprovalFailureAction.Block
      || onFailure.length > 2
      || (onFailure.length === 2 && onFailure[1] !== ApprovalFailureAction.Rollback)) {
      throw new Error('Integration test failure actions must be [Block] or [Block, Rollback].');
    }
    if (props.targetIds !== undefined) {
      if (props.targetIds.length === 0 || new Set(props.targetIds).size !== props.targetIds.length) {
        throw new Error('Test target IDs must be non-empty and unique.');
      }
      props.targetIds.forEach(targetId => requireLiteral(targetId, 'Test target ID'));
    }
    this.definition = {
      id: this.id, type: ApprovalStepType.IntegrationTests,
      ...(props.targetIds === undefined ? {} : { targetIds: [...props.targetIds] }),
      onFailure,
    };
  }

  toDefinition(context: DeploymentTargetContext): IntegrationTestsApprovalDefinition {
    const { region, awsAccountId, deployments } = this.target.toDefinition(context);
    return { ...structuredClone(this.definition), deployment: { region, awsAccountId, deployments } };
  }
}

export interface BakeTimeApprovalStepProps { readonly durationSeconds: number }

export class BakeTimeApprovalStep implements IApprovalStep {
  private readonly durationSeconds: number;

  constructor(public readonly id: string, props: BakeTimeApprovalStepProps) {
    requireLiteral(id, 'Approval ID');
    if (!Number.isSafeInteger(props.durationSeconds) || props.durationSeconds <= 0) {
      throw new Error('Bake durationSeconds must be a positive safe integer.');
    }
    this.durationSeconds = props.durationSeconds;
  }

  toDefinition(): BakeTimeApprovalDefinition {
    return { id: this.id, type: ApprovalStepType.BakeTime, durationSeconds: this.durationSeconds };
  }
}
