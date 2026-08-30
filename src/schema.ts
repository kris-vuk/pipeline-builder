/** Foundry's pipeline definition, version 1. This entry point deliberately has no CDK imports. */
export const SCHEMA_VERSION = 1;

/** The build step is fixed: clone every tracked package, then run this in each one. */
export const BUILD_COMMAND = 'make build';

export const StepType = {
  CdkDeployment: 'cdk-deployment',
  Integration: 'integration',
  BakeTime: 'bake-time',
  ManualApproval: 'manual-approval',
} as const;
export type StepType = typeof StepType[keyof typeof StepType];

export const Region = { UsEast1: 'us-east-1', UsWest2: 'us-west-2', EuWest1: 'eu-west-1' } as const;
export type Region = typeof Region[keyof typeof Region];

export const REGIONS: readonly Region[] = Object.values(Region);

/** A repository the pipeline tracks: cloned, built, and watched for new commits. */
export interface TrackedPackageDefinition {
  readonly repository: string;
  readonly branch: string;
}

/** Both CDK step types name one stack inside a tracked package's `cdk.out`. */
export interface CdkStackStepFields {
  /** The repository of the tracked package holding the stack; matched against `build.trackedPackages`. */
  readonly source: string;
  /** Path to the cloud assembly within that repository, used as `cdk deploy --app`. */
  readonly cdkOutPath: string;
  /** What `cdk deploy` selects on: the stack's artifact ID, not its physical name. */
  readonly stackName: string;
  readonly awsAccountId: string;
  readonly region: Region;
}

export interface CdkDeploymentStepDefinition extends CdkStackStepFields {
  readonly type: typeof StepType.CdkDeployment;
}

/** Deploys a test stack, then invokes the function it publishes as `IntegTestFunctionName`. */
export interface IntegrationStepDefinition extends CdkStackStepFields {
  readonly type: typeof StepType.Integration;
}

export interface BakeTimeStepDefinition {
  readonly type: typeof StepType.BakeTime;
  readonly durationMinutes: number;
}

export interface ManualApprovalStepDefinition {
  readonly type: typeof StepType.ManualApproval;
  readonly instructions: string;
}

export type StepDefinition =
  | CdkDeploymentStepDefinition
  | IntegrationStepDefinition
  | BakeTimeStepDefinition
  | ManualApprovalStepDefinition;

/** Steps run in order; the stage promotes once the last one succeeds. */
export interface StageDefinition {
  readonly name: string;
  readonly steps: readonly StepDefinition[];
}

export interface BuildDefinition {
  readonly command: typeof BUILD_COMMAND;
  readonly trackedPackages: readonly TrackedPackageDefinition[];
}

export interface PipelineDefinition {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly build: BuildDefinition;
  readonly stages: readonly StageDefinition[];
}

/** The `POST /pipelines` body, which is what the synthesized `pipeline.json` holds. */
export interface CreatePipelineRequest {
  readonly pipelineName: string;
  readonly definition: PipelineDefinition;
}

export const isCdkStackStep = (
  step: StepDefinition,
): step is CdkDeploymentStepDefinition | IntegrationStepDefinition =>
  step.type === StepType.CdkDeployment || step.type === StepType.Integration;
