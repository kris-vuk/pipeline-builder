/** Stateless wire contract. This entry point deliberately has no CDK imports. */
export const PipelineExecutionMode = { Sequential: 'sequential' } as const;
export type PipelineExecutionMode = typeof PipelineExecutionMode[keyof typeof PipelineExecutionMode];
export const StageType = { Build: 'build', DefinitionSync: 'definition-sync', Deployment: 'deployment' } as const;
export type StageType = typeof StageType[keyof typeof StageType];
export const TargetExecutionMode = { Parallel: 'parallel' } as const;
export type TargetExecutionMode = typeof TargetExecutionMode[keyof typeof TargetExecutionMode];
export const DeploymentEngine = { Cdk: 'CDK' } as const;
export type DeploymentEngine = typeof DeploymentEngine[keyof typeof DeploymentEngine];
export const ApprovalStepType = { IntegrationTests: 'integration-tests', BakeTime: 'bake-time' } as const;
export type ApprovalStepType = typeof ApprovalStepType[keyof typeof ApprovalStepType];
export const ApprovalFailureAction = { Block: 'block', Rollback: 'rollback' } as const;
export type ApprovalFailureAction = typeof ApprovalFailureAction[keyof typeof ApprovalFailureAction];

export interface BuildSource {
  readonly path: string;
  readonly branch: string;
  readonly tracking: boolean;
}

export interface IntegrationTestsApprovalDefinition {
  readonly id: string;
  readonly type: typeof ApprovalStepType.IntegrationTests;
  /** The test stack to deploy for this approval. Completion signaling is not yet specified. */
  readonly deployment: Omit<DeploymentTargetDefinition, 'id' | 'name'>;
  /** Omitted means all deployment targets in this stage. */
  readonly targetIds?: readonly string[];
  readonly onFailure: readonly ApprovalFailureAction[];
}

export interface BakeTimeApprovalDefinition {
  readonly id: string;
  readonly type: typeof ApprovalStepType.BakeTime;
  readonly durationSeconds: number;
}

export type ApprovalStepDefinition = IntegrationTestsApprovalDefinition | BakeTimeApprovalDefinition;

export interface CDKDeploymentDefinition {
  readonly engine: typeof DeploymentEngine.Cdk;
  readonly source: string;
  readonly resources: readonly string[];
  readonly cloudAssembly: {
    /** Relative to the pipeline JSON file; stack IDs resolve in this manifest. */
    readonly directory: string;
    readonly stackArtifactIds: readonly string[];
  };
}

export interface DeploymentTargetDefinition {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly awsAccountId: string;
  readonly deployments: readonly CDKDeploymentDefinition[];
}

export interface StageDefinitionBase {
  readonly id: string;
  readonly name: string;
  /** Configures the outgoing transition; omitted on the final stage. */
  readonly promotion?: { readonly enabled: boolean };
}

export interface BuildStageDefinition extends StageDefinitionBase {
  readonly type: typeof StageType.Build;
  readonly sources: readonly BuildSource[];
}

export interface DefinitionSyncStageDefinition extends StageDefinitionBase {
  readonly type: typeof StageType.DefinitionSync;
}

export interface DeploymentStageDefinition extends StageDefinitionBase {
  readonly type: typeof StageType.Deployment;
  readonly description?: string;
  readonly targetExecutionMode: typeof TargetExecutionMode.Parallel;
  readonly targets: readonly DeploymentTargetDefinition[];
  readonly approvalSteps: readonly ApprovalStepDefinition[];
}

export type StageDefinition = BuildStageDefinition | DefinitionSyncStageDefinition | DeploymentStageDefinition;

export interface PipelineDefinition {
  readonly schemaVersion: 2;
  readonly name: string;
  readonly executionMode: PipelineExecutionMode;
  readonly stages: readonly StageDefinition[];
}
