# @foundry/pipeline-builder

Author Foundry pipelines as TypeScript classes and methods. A normal `cdk synth`
writes the pipeline JSON, CloudFormation templates, asset manifests, and staged
assets beneath `cdk.out`. This package generates configuration; it does not deploy
resources or execute pipelines.

## Try it

```sh
npm ci
npm test
npx cdk synth
```

The included example uses an ordinary CDK `App`, one Alpha stage, an `ExampleStack`
containing one S3 bucket, an empty `IntegrationTestsStack` approval, and a bake period. It needs no AWS
credentials to synthesize because its environments are explicit and it performs
no lookups.

## Use the package

Install the package and its peers in your CDK app. For local development:

```sh
npm install ../pipeline-builder aws-cdk-lib constructs
npm install --save-dev aws-cdk typescript ts-node @types/node
```

Run `npm run build` in `pipeline-builder` before consuming a local directory link.
Packaged installs compile via `prepack` and include JavaScript and declarations.

```ts
import { App } from 'aws-cdk-lib';
import {
  Pipeline,
  CDKDeploymentTarget,
  IntegrationTestsApprovalStep,
  BakeTimeApprovalStep,
} from '@foundry/pipeline-builder';
import { ExampleStack } from './example-stack'; // See examples/example-stack.ts.
import { IntegrationTestsStack } from './integration-tests-stack';

const app = new App();
const pipeline = new Pipeline(app, 'Delivery', {
  pipelineName: 'messaging-gateway',
  env: { account: '111111111111', region: 'us-east-1' },
});

const alpha = pipeline.addStage('alpha', { name: 'Alpha' });
alpha.addDeploymentTarget(new CDKDeploymentTarget(new ExampleStack(alpha, 'Service')));
alpha.addApprovalStep(new IntegrationTestsApprovalStep(new IntegrationTestsStack(alpha, 'integration-tests')));
alpha.addApprovalStep(new BakeTimeApprovalStep('bake', { durationSeconds: 1800 }));

// The CDK CLI triggers App auto-synthesis. For programmatic use: app.synth().
```

`IntegrationTestsStack` is deliberately empty for now. Its stack reference is
included in the approval definition, and its template is synthesized alongside
the S3 stack. Test resources will eventually signal completion to the pipeline;
this example does not implement signaling or claim a passing test result. The
empty stack is a synthesis placeholder, not a runnable test suite. CDK may add
its own metadata resource or warn that the template has no resources.

Set your app command in `cdk.json`, for example:

```json
{ "app": "npx ts-node bin/app.ts" }
```

## Output and CDK integration

`Pipeline` extends CDK `Stage` and overrides its public `synth()` method. The
parent `App` discovers and synthesizes this nested assembly automatically. No
custom app class, patched internals, policy-validation side effects, extra
CloudFormation pipeline stack, or separate export command is required.

For a pipeline with construct ID `Delivery`, output typically looks like:

```text
cdk.out/
  manifest.json
  tree.json
  asset.<hash>/
  assembly-Delivery/
    manifest.json
    pipeline.json
    <stack-artifact-id>.template.json
    <stack-artifact-id>.assets.json
```

`pipeline.pipelineFile` gives the exact absolute JSON path. CDK derives assembly
and stack filenames from construct paths; consumers should follow manifests,
not guess names. Each pipeline gets its own assembly and `pipeline.json`, so
multiple pipelines in one app do not overwrite one another. `cdk synth --output
other-directory` moves the whole output tree together.

Each deployment's `cloudAssembly.directory` is relative to `pipeline.json`.
`cloudAssembly.stackArtifactIds` selects entries in that directory's
`manifest.json`; `resources` contains their CloudFormation stack names. CDK keeps
templates, asset publishing instructions, dependencies, and bootstrap metadata.
Transport the **entire root `cdk.out` directory**: asset paths can point from a
nested assembly to a shared asset at the root.

Scope target stacks beneath the `Pipeline`, commonly beneath a stage returned by
`addStage`. Nested CDK `Stage` assemblies under the pipeline are supported. Stacks
elsewhere in the app or in another app are rejected because they would not be
included when the pipeline is synthesized. `NestedStack` is not an independently
deployable target; wrap its parent `Stack`. Custom stack synthesizers remain
untouched and are responsible for their own CDK artifact/asset behavior.

## Builder behavior

- `addStage(id, props)` returns a deployment stage and appends it in order.
- `addBuildStage(...).addSource(...)` defaults branch to `main` and tracking to
  `true`. `addDefinitionSyncStage(...)` explicitly models definition installation.
- `addDeploymentTarget(new CDKDeploymentTarget(stack, props))` returns the target.
  Target IDs default to the stack construct ID; source defaults to `.`.
  `target.addStack(stack)` groups additional stacks in the same account/Region.
- `addApprovalStep(step)` returns the step. Approvals run in insertion order after
  all parallel targets succeed. `new IntegrationTestsApprovalStep(stack)` wraps
  a CDK test stack and derives its ID and environment from that stack. Its
  `deployment` records relative cloud assembly references, just like deployment
  targets. Integration tests default to all targets and
  `[Block, Rollback]`; `targetIds` and `onFailure: [ApprovalFailureAction.Block]`
  can narrow this. Bake duration is a positive integer number of seconds.
- `promotionEnabled` defaults to `true`; `setPromotionEnabled(false)` disables
  that stage's outgoing transition. The final stage omits `promotion`.
- `pipeline.toDefinition()` returns a fresh snapshot without writing files.
  `app.synth()` or `pipeline.synth()` emits JSON and the CDK assembly. Finish
  configuration before synthesis; CDK caches assemblies. Use a new app to make
  subsequent changes.

Every deployment target needs a concrete account and Region supplied by its
stack or inherited from the pipeline/CDK stage. Unresolved environment tokens
cannot be executed from pipeline JSON and are rejected. Ordinary CloudFormation
tokens inside the stack template remain fully supported.

## Schema and scope

This package owns the evolving **schema version 2** contract, with an explicit
`definition-sync` stage, stack-based integration-test approvals, and CDK assembly
references. Integration-test stack references replace the earlier Lambda runner
and ARN-output bindings described in `pipeline-service/SPEC.md`; the service's
execution/signaling contract still needs to be updated. The website's existing
version 1 fixtures are not changed or silently reinterpreted; migrating those
fixtures and wiring consumers to this package is separate work.

Use `@foundry/pipeline-builder/schema` for the wire types and fixed enum objects
without loading CDK or Node APIs in frontend/service code. The root entry point
also exports these contracts alongside the builder classes.

The intended service graph is Build → DefinitionSync → Deployment stages.
Local validation checks empty stages, duplicate IDs, target environments and
scope, approval target references, and approval settings. It does not yet enforce
the service's full graph semantics or implement completion signaling. No
runtime statuses, commits, test results, or elapsed bake times enter this JSON.

See the AWS documentation for the public
[CDK Stage synthesis contract](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.Stage.html)
and [cloud assembly output](https://docs.aws.amazon.com/cdk/v2/guide/configure-synth.html).

## Verification

`npm test` type-checks the library and example, exercises the builder and invalid
configurations, checks stack/asset references after relocating output, and runs
the real CDK CLI against the TypeScript example with default and custom output
directories. `npm run synth` leaves a local example assembly in `cdk.out`.

CDK deployment itself remains a separate operation. Stacks in nested assemblies
are selected through their assembly's manifest (for example, use that directory as
the deployment command's `--app`); the pipeline JSON does not turn `cdk deploy`
into a Foundry pipeline execution command.
# pipeline-builder
