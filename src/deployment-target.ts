import { relative, sep } from 'node:path';
import { Stack, Stage } from 'aws-cdk-lib';
import { DeploymentEngine, type CDKDeploymentDefinition, type DeploymentTargetDefinition } from './schema';
import { requireLiteral } from './validation';

export interface DeploymentTargetContext { readonly pipeline: Stage }

export interface IDeploymentTarget {
  readonly id: string;
  toDefinition(context: DeploymentTargetContext): DeploymentTargetDefinition;
}

export interface CDKDeploymentTargetProps {
  /** @default stack.node.id */
  readonly id?: string;
  /** @default id */
  readonly name?: string;
  /** IaC package path in the release. @default "." */
  readonly source?: string;
}

/** Wraps actual CDK stacks; never replaces their synthesizers or copies templates. */
export class CDKDeploymentTarget implements IDeploymentTarget {
  public readonly id: string;
  public readonly name: string;
  private readonly source: string;
  private readonly stacks: Stack[] = [];

  constructor(stack: Stack, props: CDKDeploymentTargetProps = {}) {
    if (!Stack.isStack(stack)) throw new Error('CDKDeploymentTarget requires a CDK Stack.');
    this.id = props.id ?? stack.node.id;
    this.name = props.name ?? this.id;
    this.source = props.source ?? '.';
    requireLiteral(this.id, 'Target ID');
    requireLiteral(this.name, 'Target name');
    requireLiteral(this.source, 'Deployment source');
    this.addStack(stack);
  }

  addStack(stack: Stack): this {
    if (!Stack.isStack(stack) || stack.nested) {
      throw new Error('A CDK deployment target requires a deployable Stack, not a NestedStack.');
    }
    if (this.stacks.includes(stack)) throw new Error(`Stack ${stack.node.path} is already in target ${this.id}.`);
    const first = this.stacks[0];
    if (first && (stack.account !== first.account || stack.region !== first.region)) {
      throw new Error(`All stacks in target ${this.id} must have the same account and region.`);
    }
    this.stacks.push(stack);
    return this;
  }

  toDefinition({ pipeline }: DeploymentTargetContext): DeploymentTargetDefinition {
    const first = this.stacks[0]!;
    requireLiteral(first.account, `Target ${this.id} AWS account; set Stack.env.account`);
    requireLiteral(first.region, `Target ${this.id} region; set Stack.env.region`);
    const deployments = new Map<Stage, { stacks: Stack[]; directory: string }>();
    for (const stack of this.stacks) {
      if (!stack.node.scopes.includes(pipeline)) {
        throw new Error(`Stack ${stack.node.path} must be scoped beneath pipeline ${pipeline.node.path} so its artifacts are synthesized together.`);
      }
      requireLiteral(stack.stackName, `Stack ${stack.node.path} name`);
      const stage = Stage.of(stack)!;
      const group = deployments.get(stage) ?? {
        stacks: [], directory: relative(pipeline.outdir, stage.outdir).split(sep).join('/') || '.',
      };
      group.stacks.push(stack);
      deployments.set(stage, group);
    }
    return {
      id: this.id, name: this.name, region: first.region, awsAccountId: first.account,
      deployments: [...deployments.values()].map((group): CDKDeploymentDefinition => ({
        engine: DeploymentEngine.Cdk, source: this.source,
        resources: group.stacks.map(stack => stack.stackName),
        cloudAssembly: {
          directory: group.directory, stackArtifactIds: group.stacks.map(stack => stack.artifactId),
        },
      })),
    };
  }
}
