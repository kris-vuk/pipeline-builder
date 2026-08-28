import { App } from 'aws-cdk-lib';
import {
  BakeTimeApprovalStep, CDKDeploymentTarget, IntegrationTestsApprovalStep, Pipeline,
} from '../src';
import { ExampleStack } from './example-stack';
import { IntegrationTestsStack } from './integration-tests-stack';

const app = new App();
const pipeline = new Pipeline(app, 'MessagingPipeline', {
  pipelineName: 'messaging-gateway-pipeline',
  env: { account: '111111111111', region: 'us-east-1' },
});

const alpha = pipeline.addStage('alpha', { name: 'Alpha' });

alpha.addDeploymentTarget(new CDKDeploymentTarget(new ExampleStack(alpha, 'iad')));

alpha.addApprovalStep(new IntegrationTestsApprovalStep(new IntegrationTestsStack(alpha, 'integration-tests')));
alpha.addApprovalStep(new BakeTimeApprovalStep('bake', { durationSeconds: 1800 }));

// App auto-synthesis is enabled by the CDK CLI. No separate pipeline export call.
