# @foundry/pipeline-builder

Author Foundry pipelines as TypeScript, in the same CDK app as the stacks they
deploy. A normal `cdk synth` writes `cdk.out/pipeline.json` — the exact body
Foundry's `POST /pipelines` takes — beside the templates the pipeline names. This
package generates configuration; it does not deploy resources or run pipelines.

## Try it

```sh
npm ci
npm test
npx cdk synth
```

The included example is an ordinary CDK `App` with two stacks and one `Alpha`
stage that deploys the first, integration-tests the second, and bakes for thirty
minutes. It needs no AWS credentials to synthesize.

## Use the package

Install the package and its peers in your CDK app:

```sh
npm install 'git+https://github.com/kris-vuk/pipeline-builder.git#<commit-sha>' aws-cdk-lib constructs
```

Git authentication must have read access to the repository. Do not put tokens in
the URL or disable lifecycle scripts: `prepare` builds `lib` from the Git source.
For HTTPS-only credentials, configure Git's `url.https://github.com/.insteadOf`
for `ssh://git@github.com/` and `git@github.com:` too; npm can normalize the
lockfile's GitHub URL to SSH. For local development, `npm install ../pipeline-builder`
after running `npm run build` here.

```ts
import { App } from 'aws-cdk-lib';
import { CdkDeploymentStep, IntegrationTestsStep, Pipeline } from '@foundry/pipeline-builder';
import { MessageGatewayStack } from '../lib/message-gateway-stack';
import { MessageGatewayIntegTestsStack } from '../lib/message-gateway-integ-tests-stack';

const env = { account: '486554617966', region: 'us-east-1' };

const app = new App();
const service = new MessageGatewayStack(app, 'MessageGatewayStack', { env });
const tests = new MessageGatewayIntegTestsStack(app, 'MessageGatewayIntegTestsStack', { env });

const pipeline = new Pipeline(app, 'Delivery', {
  pipelineName: 'message-gateway',
  trackedPackages: [{ repository: 'https://github.com/kris-vuk/test-repo', branch: 'main' }],
  cdkOutPath: 'message-gateway/iac/cdk.out',
});

const sandbox = pipeline.addStage('sandbox');
sandbox.addStep(new CdkDeploymentStep(service));
sandbox.addStep(new IntegrationTestsStep(tests));
```

Set your app command in `cdk.json`, for example
`{ "app": "npx ts-node bin/app.ts" }`, then `cdk synth`. Create the pipeline with
the file it writes:

```sh
curl -X POST "$FOUNDRY_API/pipelines" -H 'content-type: application/json' -d @cdk.out/pipeline.json
```

## What it emits

Schema version 1, the contract `pipeline-orchestrator` validates and the website
edits:

```json
{
  "pipelineName": "message-gateway",
  "definition": {
    "schemaVersion": 1,
    "build": {
      "command": "make build",
      "trackedPackages": [{ "repository": "https://github.com/kris-vuk/test-repo", "branch": "main" }]
    },
    "stages": [
      {
        "name": "sandbox",
        "steps": [
          {
            "type": "cdk-deployment",
            "source": "https://github.com/kris-vuk/test-repo",
            "cdkOutPath": "message-gateway/iac/cdk.out",
            "stackName": "MessageGatewayStack",
            "awsAccountId": "486554617966",
            "region": "us-east-1"
          }
        ]
      }
    ]
  }
}
```

The build step is implicit and fixed: Foundry clones every tracked package and
runs `make build` in each one. Each stage is an ordered list of steps:

| Step | Class | What Foundry does |
| --- | --- | --- |
| `cdk-deployment` | `CdkDeploymentStep(stack, props?)` | `cdk deploy <stackName> --app <source>/<cdkOutPath>` |
| `integration` | `IntegrationTestsStep(stack, props?)` | Deploys the stack, then invokes the function it publishes as `IntegTestFunctionName` and fails on a red report |
| `bake-time` | `BakeTimeStep({ durationMinutes })` | Holds the stage before promotion |
| `manual-approval` | `ManualApprovalStep({ instructions })` | Waits for a human |

## Builder behavior

- `new Pipeline(app, id, props)` takes `pipelineName` (default: the construct ID),
  `trackedPackages`, a default `cdkOutPath` (default `cdk.out`), and a `fileName`
  (default `pipeline.json`). `addTrackedPackage(...)` defaults `branch` to `main`.
- `addStage(id, props?)` appends a stage; its `name` defaults to the construct ID.
  `addStep(step)` appends a step, and steps run in the order they are added.
- A CDK step reads its account and Region from the stack, and names the stack by
  `stack.artifactId` — the ID `cdk deploy` selects on, not the physical stack name.
  `source` defaults to the pipeline's only tracked package and `cdkOutPath` to the
  pipeline's; both can be set per step, along with `stackName`.
- `pipeline.toDefinition()` and `toCreateRequest()` return fresh snapshots without
  writing anything. Synthesis writes `pipeline.json` into the app's `cdk.out`;
  `pipeline.pipelineFile` is its absolute path, and `writeDefinition()` writes it
  on demand.

Deployment stacks stay top-level in the app: the runner deploys them from the
repository's own `cdk.out` with `--app`, which cannot select into a nested
assembly. Stacks in a nested `Stage`, `NestedStack`s, unresolved environment
tokens, regions outside `us-east-1` / `us-west-2` / `eu-west-1`, and steps whose
`source` is not a tracked package are all rejected locally, before anything is
written.

Use `@foundry/pipeline-builder/schema` for the wire types and enum objects without
loading CDK or Node APIs in frontend or service code.

## Verification

`npm test` type-checks the library and example, exercises the builder and its
invalid configurations, and runs the real CDK CLI against the TypeScript example
with default and custom output directories, checking that every stack a step names
is selectable from the assembly it was written beside. `npm run synth` leaves an
example assembly in `cdk.out`.
