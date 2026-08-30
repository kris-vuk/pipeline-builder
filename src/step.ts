import { Stack, Stage } from 'aws-cdk-lib';
import {
  StepType,
  type BakeTimeStepDefinition, type CdkDeploymentStepDefinition, type CdkStackStepFields,
  type IntegrationStepDefinition, type ManualApprovalStepDefinition, type StepDefinition,
  type TrackedPackageDefinition,
} from './schema';
import { requireAccountId, requireLiteral, requirePositiveInteger, requireRegion } from './validation';

/** What the pipeline knows and a step needs: the packages it may deploy from, and their layout. */
export interface StepContext {
  readonly trackedPackages: readonly TrackedPackageDefinition[];
  readonly cdkOutPath: string;
}

export interface IPipelineStep {
  toDefinition(context: StepContext): StepDefinition;
}

export interface CdkStackStepProps {
  /** Repository of the tracked package holding the stack. @default the pipeline's only tracked package */
  readonly source?: string;
  /** Cloud assembly path within that repository. @default the pipeline's cdkOutPath */
  readonly cdkOutPath?: string;
  /** @default stack.artifactId — the ID `cdk deploy` selects on, not the physical stack name */
  readonly stackName?: string;
}

/** Wraps a real CDK stack; the runner deploys it from the repository's own `cdk.out`. */
abstract class CdkStackStep implements IPipelineStep {
  private readonly stack: Stack;
  private readonly props: CdkStackStepProps;

  constructor(stack: Stack, props: CdkStackStepProps = {}) {
    if (!Stack.isStack(stack) || stack.nested) {
      throw new Error('A CDK step requires a deployable Stack, not a NestedStack.');
    }
    this.stack = stack;
    this.props = props;
  }

  protected abstract get type(): typeof StepType.CdkDeployment | typeof StepType.Integration;

  toDefinition(context: StepContext): CdkDeploymentStepDefinition | IntegrationStepDefinition {
    return { type: this.type, ...this.fields(context) } as CdkDeploymentStepDefinition | IntegrationStepDefinition;
  }

  private fields(context: StepContext): CdkStackStepFields {
    const stackName = this.props.stackName ?? this.stack.artifactId;
    requireLiteral(stackName, `Stack ${this.stack.node.path} name`);
    requireAccountId(this.stack.account, `Stack ${this.stack.node.path} AWS account; set Stack.env.account`);
    const region = requireRegion(this.stack.region, `Stack ${this.stack.node.path} region; set Stack.env.region`);
    this.checkTopLevel();
    return {
      source: this.source(context), cdkOutPath: this.cdkOutPath(context), stackName,
      awsAccountId: this.stack.account, region,
    };
  }

  /** A stack in a nested Stage synthesizes into a nested assembly, which `--app cdk.out` cannot select. */
  private checkTopLevel(): void {
    const stage = Stage.of(this.stack);
    if (stage?.parentStage !== undefined) {
      throw new Error(
        `Stack ${this.stack.node.path} must be a top-level stack of the app so the runner can deploy it with "cdk deploy ${this.stack.artifactId} --app <cdkOutPath>".`,
      );
    }
  }

  /** The runner clones tracked packages, so a step can only deploy out of one of them. */
  private source({ trackedPackages }: StepContext): string {
    const repositories = trackedPackages.map(tracked => tracked.repository);
    if (this.props.source === undefined) {
      const [only] = repositories;
      if (repositories.length !== 1 || only === undefined) {
        throw new Error(
          `Stack ${this.stack.node.path} needs an explicit source; the pipeline tracks ${repositories.join(', ') || 'no packages'}.`,
        );
      }
      return only;
    }
    if (!repositories.includes(this.props.source)) {
      throw new Error(
        `"${this.props.source}" is not one of the pipeline's tracked packages: ${repositories.join(', ') || 'none'}.`,
      );
    }
    return this.props.source;
  }

  private cdkOutPath(context: StepContext): string {
    const cdkOutPath = this.props.cdkOutPath ?? context.cdkOutPath;
    requireLiteral(cdkOutPath, `Stack ${this.stack.node.path} cdk.out path`);
    return cdkOutPath;
  }
}

/** Deploys one stack of a tracked package into its account and region. */
export class CdkDeploymentStep extends CdkStackStep {
  protected override get type(): typeof StepType.CdkDeployment { return StepType.CdkDeployment; }
}

/** Deploys a test stack, then fails the stage unless the function it publishes reports a pass. */
export class IntegrationTestsStep extends CdkStackStep {
  protected override get type(): typeof StepType.Integration { return StepType.Integration; }
}

export interface BakeTimeStepProps { readonly durationMinutes: number }

/** Holds the stage before promotion so regressions have time to surface. */
export class BakeTimeStep implements IPipelineStep {
  private readonly durationMinutes: number;

  constructor(props: BakeTimeStepProps) {
    requirePositiveInteger(props.durationMinutes, 'Bake durationMinutes');
    this.durationMinutes = props.durationMinutes;
  }

  toDefinition(): BakeTimeStepDefinition {
    return { type: StepType.BakeTime, durationMinutes: this.durationMinutes };
  }
}

export interface ManualApprovalStepProps { readonly instructions?: string }

/** Waits for a human before the stage promotes. */
export class ManualApprovalStep implements IPipelineStep {
  private readonly instructions: string;

  constructor(props: ManualApprovalStepProps = {}) {
    this.instructions = props.instructions ?? '';
  }

  toDefinition(): ManualApprovalStepDefinition {
    return { type: StepType.ManualApproval, instructions: this.instructions };
  }
}
