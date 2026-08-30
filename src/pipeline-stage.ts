import { Construct } from 'constructs';
import type { IPipelineStep, StepContext } from './step';
import type { StageDefinition } from './schema';
import { requireLiteral } from './validation';

export interface PipelineStageProps {
  /** @default the construct ID */
  readonly name?: string;
}

/** One stage of the pipeline: an ordered list of steps a change moves through. */
export class PipelineStage extends Construct {
  public readonly name: string;
  private readonly steps: IPipelineStep[] = [];

  constructor(scope: Construct, id: string, props: PipelineStageProps = {}) {
    super(scope, id);
    this.name = props.name ?? id;
    requireLiteral(this.name, 'Stage name');
  }

  /** Steps run in the order they are added. */
  addStep<T extends IPipelineStep>(step: T): T {
    this.steps.push(step);
    return step;
  }

  toDefinition(context: StepContext): StageDefinition {
    if (!this.steps.length) throw new Error(`Stage ${this.name} requires at least one step.`);
    return { name: this.name, steps: this.steps.map(step => step.toDefinition(context)) };
  }
}
