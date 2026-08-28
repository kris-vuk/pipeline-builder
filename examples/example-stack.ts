import { Stack, type StackProps } from 'aws-cdk-lib';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export class ExampleStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    new Bucket(this, 'Bucket');
  }
}
