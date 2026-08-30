import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/** The output an integration step's stack publishes, naming the function the runner invokes. */
export const INTEG_TEST_FUNCTION_OUTPUT = 'IntegTestFunctionName';

// Placeholder: a real test stack deploys the Lambda that runs the suite.
export class IntegrationTestsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    new CfnOutput(this, INTEG_TEST_FUNCTION_OUTPUT, { value: 'example-integ-tests' });
  }
}
