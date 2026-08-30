import { App } from 'aws-cdk-lib';
import {
  BakeTimeStep, CdkDeploymentStep, IntegrationTestsStep, Pipeline,
} from '../src';
import { ExampleStack } from './example-stack';
import { IntegrationTestsStack } from './integration-tests-stack';

const app = new App();
const env = { account: '111111111111', region: 'us-east-1' };

// Ordinary top-level stacks: the runner deploys them out of this repository's own cdk.out.
const service = new ExampleStack(app, 'ExampleStack', { env });
const tests = new IntegrationTestsStack(app, 'IntegrationTestsStack', { env });

const pipeline = new Pipeline(app, 'Delivery', {
  pipelineName: 'messaging-gateway',
  trackedPackages: [{ repository: 'https://github.com/kris-vuk/test-repo' }],
  cdkOutPath: 'message-gateway/iac/cdk.out',
});

const alpha = pipeline.addStage('Alpha');
alpha.addStep(new CdkDeploymentStep(service));
alpha.addStep(new IntegrationTestsStep(tests));
alpha.addStep(new BakeTimeStep({ durationMinutes: 30 }));

// The CDK CLI triggers app synthesis, which writes cdk.out/pipeline.json.
