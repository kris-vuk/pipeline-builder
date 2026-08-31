const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { App, Stack, Stage, NestedStack, CfnResource } = require('aws-cdk-lib');
const {
  Pipeline, CdkDeploymentStep, IntegrationTestsStep, BakeTimeStep, ManualApprovalStep, StepType,
} = require('@foundry/pipeline-builder');

const env = { account: '111111111111', region: 'us-east-1' };
const REPOSITORY = 'https://github.com/kris-vuk/test-repo';
const CDK_OUT_PATH = 'message-gateway/iac/cdk.out';

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-pipeline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, props = {}) {
  const outdir = join(temporary(t), 'cdk.out');
  const app = new App({ outdir, autoSynth: false });
  const pipeline = new Pipeline(app, 'Delivery', {
    pipelineName: 'message-gateway',
    trackedPackages: [{ repository: REPOSITORY }],
    cdkOutPath: CDK_OUT_PATH,
    ...props,
  });
  return { app, pipeline, outdir };
}

function stack(app, id = 'MessageGatewayStack', props = {}) {
  const created = new Stack(app, id, { env, ...props });
  new CfnResource(created, 'Queue', { type: 'AWS::SQS::Queue' });
  return created;
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

test('synth writes the POST /pipelines body with ordered stages and steps', t => {
  const { app, pipeline, outdir } = setup(t);
  const service = stack(app);
  const tests = stack(app, 'MessageGatewayIntegTestsStack');
  const sandbox = pipeline.addStage('sandbox');
  sandbox.addStep(new CdkDeploymentStep(service));
  sandbox.addStep(new IntegrationTestsStep(tests));
  const production = pipeline.addStage('production', { name: 'prod' });
  production.addStep(new BakeTimeStep({ durationMinutes: 30 }));
  production.addStep(new ManualApprovalStep({ instructions: 'Check the dashboards.' }));
  assert.equal(existsSync(pipeline.pipelineFile), false);

  app.synth();

  assert.equal(pipeline.pipelineFile, join(outdir, 'pipeline.json'));
  const request = readJson(pipeline.pipelineFile);
  assert.deepEqual(request, pipeline.toCreateRequest());
  assert.deepEqual(request, {
    pipelineName: 'message-gateway',
    definition: {
      schemaVersion: 1,
      build: { command: 'make build', trackedPackages: [{ repository: REPOSITORY, branch: 'main' }] },
      stages: [
        {
          name: 'sandbox',
          steps: [
            {
              type: 'cdk-deployment', source: REPOSITORY, cdkOutPath: CDK_OUT_PATH,
              stackName: 'MessageGatewayStack', awsAccountId: env.account, region: env.region,
            },
            {
              type: 'integration', source: REPOSITORY, cdkOutPath: CDK_OUT_PATH,
              stackName: 'MessageGatewayIntegTestsStack', awsAccountId: env.account, region: env.region,
            },
          ],
        },
        {
          name: 'prod',
          steps: [
            { type: 'bake-time', durationMinutes: 30 },
            { type: 'manual-approval', instructions: 'Check the dashboards.' },
          ],
        },
      ],
      selfMutate: { source: REPOSITORY, path: `${CDK_OUT_PATH}/pipeline.json` },
    },
  });
});

test('self-mutation names the file the pipeline itself writes, and can be turned off', t => {
  const off = setup(t, { selfMutate: false });
  off.pipeline.addStage('sandbox').addStep(new BakeTimeStep({ durationMinutes: 1 }));
  assert.equal(off.pipeline.toDefinition().selfMutate, undefined);

  const renamed = setup(t, { fileName: 'delivery.json' });
  renamed.pipeline.addStage('sandbox').addStep(new BakeTimeStep({ durationMinutes: 1 }));
  assert.deepEqual(renamed.pipeline.toDefinition().selfMutate, {
    source: REPOSITORY, path: `${CDK_OUT_PATH}/delivery.json`,
  });
});

test('self-mutation needs a named source once more than one package is tracked', t => {
  const { pipeline } = setup(t);
  const other = 'https://github.com/kris-vuk/other-repo';
  pipeline.addTrackedPackage({ repository: other });
  pipeline.addStage('sandbox').addStep(new BakeTimeStep({ durationMinutes: 1 }));
  assert.equal(pipeline.toDefinition().selfMutate, undefined);

  const named = setup(t, { selfMutateSource: other, trackedPackages: [{ repository: REPOSITORY }, { repository: other }] });
  named.pipeline.addStage('sandbox').addStep(new BakeTimeStep({ durationMinutes: 1 }));
  assert.deepEqual(named.pipeline.toDefinition().selfMutate, { source: other, path: `${CDK_OUT_PATH}/pipeline.json` });

  const asked = setup(t, { selfMutate: true, trackedPackages: [{ repository: REPOSITORY }, { repository: other }] });
  asked.pipeline.addStage('sandbox').addStep(new BakeTimeStep({ durationMinutes: 1 }));
  assert.throws(() => asked.pipeline.toDefinition(), /selfMutateSource must name the one holding pipeline.json/);

  const untracked = setup(t, { selfMutateSource: 'https://github.com/kris-vuk/untracked' });
  untracked.pipeline.addStage('sandbox').addStep(new BakeTimeStep({ durationMinutes: 1 }));
  assert.throws(() => untracked.pipeline.toDefinition(), /not one of the pipeline's tracked packages/);
});

test('a step names the stack artifact cdk deploy selects, not its physical name', t => {
  const { app, pipeline } = setup(t);
  const service = stack(app, 'MessageGatewayStack', { stackName: 'message-gateway' });
  pipeline.addStage('sandbox').addStep(new CdkDeploymentStep(service));
  const [step] = pipeline.toDefinition().stages[0].steps;
  assert.equal(service.stackName, 'message-gateway');
  assert.equal(step.stackName, 'MessageGatewayStack');
});

test('source, cdk.out path and stack name can be set per step', t => {
  const other = 'https://github.com/kris-vuk/other-repo';
  const { app, pipeline } = setup(t, { trackedPackages: [{ repository: REPOSITORY, branch: 'release' }] });
  pipeline.addTrackedPackage({ repository: other });
  pipeline.addStage('sandbox').addStep(new CdkDeploymentStep(stack(app), {
    source: other, cdkOutPath: 'iac/cdk.out', stackName: 'Renamed',
  }));
  const definition = pipeline.toDefinition();
  assert.deepEqual(definition.build.trackedPackages, [
    { repository: REPOSITORY, branch: 'release' }, { repository: other, branch: 'main' },
  ]);
  assert.deepEqual(definition.stages[0].steps[0], {
    type: StepType.CdkDeployment, source: other, cdkOutPath: 'iac/cdk.out',
    stackName: 'Renamed', awsAccountId: env.account, region: env.region,
  });
});

test('a step cannot deploy from a repository the pipeline does not track', t => {
  const { app, pipeline } = setup(t);
  const sandbox = pipeline.addStage('sandbox');
  sandbox.addStep(new CdkDeploymentStep(stack(app), { source: 'https://github.com/kris-vuk/untracked' }));
  assert.throws(() => pipeline.toDefinition(), /not one of the pipeline's tracked packages/);
});

test('a step needs an explicit source once more than one package is tracked', t => {
  const { app, pipeline } = setup(t);
  pipeline.addTrackedPackage({ repository: 'https://github.com/kris-vuk/other-repo' });
  pipeline.addStage('sandbox').addStep(new CdkDeploymentStep(stack(app)));
  assert.throws(() => pipeline.toDefinition(), /needs an explicit source/);
});

test('empty pipelines and empty stages fail before anything is written', t => {
  const { app, pipeline } = setup(t, { trackedPackages: [] });
  assert.throws(() => pipeline.toDefinition(), /at least one tracked package/);
  pipeline.addTrackedPackage({ repository: REPOSITORY });
  pipeline.addStage('sandbox');
  assert.throws(() => app.synth(), /Stage sandbox requires at least one step/);
  assert.equal(existsSync(pipeline.pipelineFile), false);
});

test('stacks outside a concrete supported environment are rejected', t => {
  const unresolved = setup(t);
  unresolved.pipeline.addStage('sandbox').addStep(new CdkDeploymentStep(new Stack(unresolved.app, 'Unresolved')));
  assert.throws(() => unresolved.pipeline.toDefinition(), /set Stack.env.account/);
  const unsupported = setup(t);
  unsupported.pipeline.addStage('sandbox').addStep(
    new CdkDeploymentStep(stack(unsupported.app, 'ApSouth', { env: { ...env, region: 'ap-south-1' } })),
  );
  assert.throws(() => unsupported.pipeline.toDefinition(), /must be one of us-east-1, us-west-2, eu-west-1/);
});

test('nested stacks and stacks in nested stages cannot be deployed by the runner', t => {
  const { app, pipeline } = setup(t);
  const parent = stack(app, 'Parent');
  assert.throws(() => new CdkDeploymentStep(new NestedStack(parent, 'Nested')), /not a NestedStack/);
  const regional = new Stage(app, 'Regional', { env });
  pipeline.addStage('sandbox').addStep(new CdkDeploymentStep(stack(regional, 'Inner')));
  assert.throws(() => pipeline.toDefinition(), /must be a top-level stack of the app/);
});

test('bake times must be a positive whole number of minutes', () => {
  for (const durationMinutes of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => new BakeTimeStep({ durationMinutes }), /positive safe integer/);
  }
  assert.deepEqual(new ManualApprovalStep().toDefinition(), { type: 'manual-approval', instructions: '' });
});

test('duplicate tracked packages, stage IDs and pipeline files fail locally', t => {
  const { app, pipeline } = setup(t);
  assert.throws(() => pipeline.addTrackedPackage({ repository: REPOSITORY }), /Duplicate tracked package/);
  pipeline.addStage('sandbox').addStep(new BakeTimeStep({ durationMinutes: 1 }));
  assert.throws(() => pipeline.addStage('sandbox'), /already a Construct with name 'sandbox'/);
  const second = new Pipeline(app, 'Other', { trackedPackages: [{ repository: REPOSITORY }] });
  second.addStage('sandbox').addStep(new BakeTimeStep({ durationMinutes: 1 }));
  assert.throws(() => app.synth(), /both write pipeline.json/);
  assert.equal(existsSync(pipeline.pipelineFile), false);
});

test('a second pipeline in the same app writes its own file', t => {
  const { app, pipeline, outdir } = setup(t);
  pipeline.addStage('sandbox').addStep(new BakeTimeStep({ durationMinutes: 1 }));
  const second = new Pipeline(app, 'Other', {
    trackedPackages: [{ repository: REPOSITORY }], fileName: 'other-pipeline.json',
  });
  second.addStage('sandbox').addStep(new BakeTimeStep({ durationMinutes: 2 }));
  app.synth();
  assert.equal(second.pipelineFile, join(outdir, 'other-pipeline.json'));
  assert.equal(readJson(pipeline.pipelineFile).pipelineName, 'message-gateway');
  assert.equal(readJson(second.pipelineFile).pipelineName, 'Other');
});

test('snapshots and constructor inputs cannot mutate pipeline configuration', t => {
  const { app, pipeline } = setup(t);
  const trackedPackage = { repository: 'https://github.com/kris-vuk/other-repo', branch: 'main' };
  pipeline.addTrackedPackage(trackedPackage);
  pipeline.addStage('sandbox').addStep(new CdkDeploymentStep(stack(app), { source: REPOSITORY }));
  const initial = pipeline.toDefinition();
  trackedPackage.branch = 'changed';
  const snapshot = pipeline.toDefinition();
  snapshot.build.trackedPackages[0].branch = 'edited';
  snapshot.stages[0].steps.push({ type: 'bake-time', durationMinutes: 1 });
  assert.deepEqual(pipeline.toDefinition(), initial);
});

test('schema entry point can load without importing CDK or constructs', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(name, ...args) {
      if (name.startsWith('aws-cdk-lib') || name === 'constructs') throw new Error('CDK import');
      return original.call(this, name, ...args);
    };
    const { SCHEMA_VERSION, BUILD_COMMAND } = require('@foundry/pipeline-builder/schema');
    if (SCHEMA_VERSION !== 1 || BUILD_COMMAND !== 'make build') throw new Error('unexpected contract');
  `], { cwd: resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('real cdk synth writes the pipeline beside the templates it deploys', { timeout: 60000 }, t => {
  const cli = require.resolve('aws-cdk/bin/cdk');
  const tsNode = require.resolve('ts-node/dist/bin.js');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  // Prefixing with exec keeps CDK from treating the enclosing argument quotes
  // as quotes around the entire app command.
  const appCommand = 'exec ' + [
    process.execPath, tsNode, '--project', resolve(__dirname, '../tsconfig.example.json'),
    resolve(__dirname, '../examples/pipeline.ts'),
  ].map(quote).join(' ');
  for (const output of [undefined, 'custom-assembly']) {
    const cwd = temporary(t);
    const args = [cli, 'synth', '--app', appCommand, '--quiet', '--no-notices', '--no-lookups'];
    if (output) args.push('--output', output);
    const result = spawnSync(process.execPath, args, {
      cwd, encoding: 'utf8', timeout: 25000,
      env: { ...process.env, CDK_DISABLE_CLI_TELEMETRY: '1', AWS_EC2_METADATA_DISABLED: 'true' },
    });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
    const outdir = join(cwd, output ?? 'cdk.out');
    const { pipelineName, definition } = readJson(join(outdir, 'pipeline.json'));
    assert.equal(pipelineName, 'messaging-gateway');
    assert.deepEqual(definition.stages.map(stage => stage.name), ['Alpha']);
    assert.deepEqual(definition.stages[0].steps.map(step => step.type), [
      'cdk-deployment', 'integration', 'bake-time',
    ]);
    // Every CDK step names a template that cdk deploy can select from this assembly.
    const manifest = readJson(join(outdir, 'manifest.json'));
    for (const step of definition.stages[0].steps.filter(step => step.stackName)) {
      const artifact = manifest.artifacts[step.stackName];
      assert.ok(artifact, `${step.stackName} is missing from the assembly manifest`);
      assert.ok(existsSync(join(outdir, artifact.properties.templateFile)));
    }
    if (output) assert.equal(existsSync(join(cwd, 'cdk.out')), false);
  }
});
