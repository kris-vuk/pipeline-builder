const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, relative, isAbsolute, sep } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { App, Stack, Stage, NestedStack, CfnResource, CfnOutput, Aspects } = require('aws-cdk-lib');
const { Code, Function: LambdaFunction, Runtime } = require('aws-cdk-lib/aws-lambda');
const { CloudAssembly } = require('aws-cdk-lib/cx-api');
const {
  Pipeline, CDKDeploymentTarget, IntegrationTestsApprovalStep, BakeTimeApprovalStep,
  StageType, ApprovalFailureAction,
} = require('@foundry/pipeline-builder');

const env = { account: '111111111111', region: 'us-east-1' };
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-pipeline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function setup(t) {
  const outdir = join(temporary(t), 'cdk.out');
  const app = new App({ outdir, autoSynth: false });
  const pipeline = new Pipeline(app, 'Delivery', { pipelineName: 'messaging', env });
  return { app, pipeline, outdir };
}
function target(scope, id = 'IAD', props = {}) {
  const stack = new Stack(scope, id, props);
  new CfnResource(stack, 'Queue', { type: 'AWS::SQS::Queue' });
  return new CDKDeploymentTarget(stack, { id: id.toLowerCase(), source: 'router/iac' });
}
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }

test('synth emits the v2 contract with ordered stages, parallel targets and ordered approvals', t => {
  const { app, pipeline, outdir } = setup(t);
  pipeline.addBuildStage('build', { name: 'Build' })
    .addSource({ path: 'router/iac' })
    .addSource({ path: 'router/service', branch: 'release', tracking: false });
  pipeline.addDefinitionSyncStage('pipeline', { name: 'Pipeline', promotionEnabled: false });
  const alpha = pipeline.addStage('alpha', { name: 'Alpha', description: 'Test deployments' });
  alpha.addDeploymentTarget(target(alpha));
  alpha.addDeploymentTarget(target(alpha, 'PDX', { env: { ...env, region: 'us-west-2' } }));
  const tests = new Stack(alpha, 'tests');
  new CfnResource(tests, 'Results', { type: 'AWS::SQS::Queue' });
  alpha.addApprovalStep(new IntegrationTestsApprovalStep(tests, {
    source: 'router/integ-tests', targetIds: ['iad'],
  }));
  alpha.addApprovalStep(new BakeTimeApprovalStep('bake', { durationSeconds: 1800 }));
  const prod = pipeline.addStage('production');
  prod.addDeploymentTarget(target(prod));
  assert.equal(existsSync(pipeline.pipelineFile), false);
  app.synth();
  assert.ok(pipeline.pipelineFile.startsWith(outdir + sep));
  const definition = readJson(pipeline.pipelineFile);
  assert.deepEqual(definition, pipeline.toDefinition());
  assert.equal(definition.schemaVersion, 2);
  assert.equal(definition.name, 'messaging');
  assert.equal(definition.executionMode, 'sequential');
  assert.deepEqual(definition.stages.map(s => s.type), ['build', 'definition-sync', 'deployment', 'deployment']);
  assert.deepEqual(definition.stages.map(s => s.promotion), [{ enabled: true }, { enabled: false }, { enabled: true }, undefined]);
  assert.deepEqual(definition.stages[0].sources, [
    { path: 'router/iac', branch: 'main', tracking: true },
    { path: 'router/service', branch: 'release', tracking: false },
  ]);
  const deployment = definition.stages[2];
  assert.equal(deployment.targetExecutionMode, 'parallel');
  assert.deepEqual(deployment.targets.map(t => [t.id, t.region, t.awsAccountId]), [
    ['iad', 'us-east-1', env.account], ['pdx', 'us-west-2', env.account],
  ]);
  assert.deepEqual(deployment.approvalSteps, [
    {
      id: 'tests', type: 'integration-tests', targetIds: ['iad'], onFailure: ['block', 'rollback'],
      deployment: {
        region: env.region, awsAccountId: env.account,
        deployments: [{
          engine: 'CDK', source: 'router/integ-tests', resources: [tests.stackName],
          cloudAssembly: { directory: '.', stackArtifactIds: [tests.artifactId] },
        }],
      },
    },
    { id: 'bake', type: 'bake-time', durationSeconds: 1800 },
  ]);
  for (const stage of definition.stages.filter(s => s.type === StageType.Deployment)) {
    for (const target of stage.targets) for (const deployment of target.deployments) {
      const assembly = new CloudAssembly(resolve(pipeline.outdir, deployment.cloudAssembly.directory));
      assert.deepEqual(deployment.cloudAssembly.stackArtifactIds.map(id => assembly.getStackArtifact(id).stackName), deployment.resources);
      assert.equal(deployment.engine, 'CDK');
      assert.equal(deployment.source, 'router/iac');
    }
  }
  const json = readFileSync(pipeline.pipelineFile, 'utf8');
  assert.equal(json.includes(outdir), false);
  app.synth();
  pipeline.synth();
  assert.equal(readFileSync(pipeline.pipelineFile, 'utf8'), json);
});

test('stack resources and outputs added after target registration are synthesized normally', t => {
  const { app, pipeline } = setup(t);
  const alpha = pipeline.addStage('alpha');
  const stack = new Stack(alpha, 'Service');
  alpha.addDeploymentTarget(new CDKDeploymentTarget(stack));
  new CfnResource(stack, 'Queue', { type: 'AWS::SQS::Queue' });
  new CfnOutput(stack, 'TestArn', { value: 'a-test-output' });
  Aspects.of(stack).add({ visit(node) {
    if (node === stack && !stack.node.tryFindChild('AddedByAspect')) {
      new CfnResource(stack, 'AddedByAspect', { type: 'AWS::SNS::Topic' });
    }
  } });
  app.synth();
  const template = readJson(join(pipeline.outdir, stack.templateFile));
  assert.equal(template.Resources.Queue.Type, 'AWS::SQS::Queue');
  assert.equal(template.Resources.AddedByAspect.Type, 'AWS::SNS::Topic');
  assert.equal(template.Outputs.TestArn.Value, 'a-test-output');
});

test('multiple stacks retain CDK dependencies and nested assemblies use relative references', t => {
  const { app, pipeline } = setup(t);
  const alpha = pipeline.addStage('alpha');
  const regional = new Stage(pipeline, 'Regional', { env });
  const first = new Stack(regional, 'Infrastructure');
  new CfnResource(first, 'Queue', { type: 'AWS::SQS::Queue' });
  const second = new Stack(regional, 'Service');
  new CfnResource(second, 'Queue', { type: 'AWS::SQS::Queue' });
  second.addStackDependency(first);
  const direct = new Stack(alpha, 'Direct');
  new CfnResource(direct, 'Queue', { type: 'AWS::SQS::Queue' });
  const deploymentTarget = alpha.addDeploymentTarget(new CDKDeploymentTarget(first));
  assert.equal(deploymentTarget.addStack(second).addStack(direct), deploymentTarget);
  const tests = new Stack(regional, 'Tests');
  new CfnResource(tests, 'Results', { type: 'AWS::SQS::Queue' });
  alpha.addApprovalStep(new IntegrationTestsApprovalStep(tests));
  app.synth();
  const deployments = readJson(pipeline.pipelineFile).stages[0].targets[0].deployments;
  assert.equal(deployments.length, 2);
  const assembly = new CloudAssembly(resolve(pipeline.outdir, deployments[0].cloudAssembly.directory));
  assert.ok(assembly.getStackArtifact(second.artifactId).dependencies.some(d => d.id === first.artifactId));
  assert.equal(deployments[1].cloudAssembly.directory, '.');
  assert.equal(isAbsolute(deployments[0].cloudAssembly.directory), false);
  const testDeployment = readJson(pipeline.pipelineFile).stages[0].approvalSteps[0].deployment.deployments[0];
  assert.equal(testDeployment.cloudAssembly.directory, deployments[0].cloudAssembly.directory);
  assert.equal(assembly.getStackArtifact(testDeployment.cloudAssembly.stackArtifactIds[0]).stackName, tests.stackName);
});

test('separate pipelines never overwrite one another, even with identical display names', t => {
  const { app, pipeline } = setup(t);
  const second = new Pipeline(app, 'Other', { pipelineName: 'messaging', env });
  for (const p of [pipeline, second]) {
    const alpha = p.addStage('alpha');
    alpha.addDeploymentTarget(target(alpha));
  }
  app.synth();
  assert.notEqual(pipeline.pipelineFile, second.pipelineFile);
  for (const p of [pipeline, second]) assert.equal(readJson(p.pipelineFile).name, 'messaging');
});

test('templates, asset manifests and Lambda source remain usable after moving cdk.out', t => {
  const { app, pipeline, outdir } = setup(t);
  const alpha = pipeline.addStage('alpha');
  const stack = new Stack(alpha, 'Service');
  const assetDirectory = temporary(t);
  writeFileSync(join(assetDirectory, 'index.js'), 'exports.handler = async () => ({ passed: true });\n');
  new LambdaFunction(stack, 'Tests', {
    runtime: Runtime.NODEJS_22_X, handler: 'index.handler',
    code: Code.fromAsset(assetDirectory),
  });
  alpha.addDeploymentTarget(new CDKDeploymentTarget(stack));
  app.synth();
  const destination = join(temporary(t), 'relocated');
  cpSync(outdir, destination, { recursive: true });
  rmSync(outdir, { recursive: true });
  const pipelineDirectory = resolve(destination, relative(outdir, pipeline.outdir));
  const definition = readJson(join(pipelineDirectory, 'pipeline.json'));
  const reference = definition.stages[0].targets[0].deployments[0].cloudAssembly;
  const assemblyDir = resolve(pipelineDirectory, reference.directory);
  const assembly = new CloudAssembly(assemblyDir);
  assert.equal(assembly.getStackArtifact(reference.stackArtifactIds[0]).stackName, stack.stackName);
  const manifest = readJson(join(assemblyDir, 'manifest.json'));
  let assetCount = 0;
  for (const artifact of Object.values(manifest.artifacts)) {
    if (artifact.type !== 'cdk:asset-manifest') continue;
    const assets = readJson(join(assemblyDir, artifact.properties.file));
    for (const file of Object.values(assets.files)) {
      const assetPath = resolve(assemblyDir, file.source.path);
      assert.ok(assetPath.startsWith(destination + sep));
      assert.ok(existsSync(assetPath), file.source.path);
      assetCount++;
    }
  }
  assert.ok(assetCount >= 2, 'template and Lambda asset are both staged');
});

test('snapshots and constructor inputs cannot mutate pipeline configuration', t => {
  const { pipeline } = setup(t);
  const build = pipeline.addBuildStage('build');
  const source = { path: 'iac', branch: 'main' };
  build.addSource(source);
  const alpha = pipeline.addStage('alpha');
  alpha.addDeploymentTarget(target(alpha));
  const onFailure = [ApprovalFailureAction.Block];
  alpha.addApprovalStep(new IntegrationTestsApprovalStep(new Stack(alpha, 'tests'), { onFailure }));
  const initial = pipeline.toDefinition();
  source.branch = 'changed';
  onFailure.push(ApprovalFailureAction.Rollback);
  const snapshot = pipeline.toDefinition();
  snapshot.stages[0].sources[0].branch = 'edited';
  snapshot.stages[1].approvalSteps[0].onFailure.push('rollback');
  snapshot.stages[1].approvalSteps[0].deployment.deployments[0].cloudAssembly.stackArtifactIds.push('edited');
  assert.deepEqual(pipeline.toDefinition(), initial);
  build.setPromotionEnabled(false);
  assert.deepEqual(pipeline.toDefinition().stages[0].promotion, { enabled: false });
});

test('duplicate stage, target, source and approval IDs fail locally', t => {
  const { pipeline } = setup(t);
  const build = pipeline.addBuildStage('build').addSource({ path: 'iac' });
  assert.throws(() => build.addSource({ path: 'iac' }), /Duplicate build source/);
  assert.throws(() => pipeline.addStage('build'), /Duplicate stage/);
  const alpha = pipeline.addStage('alpha');
  const deployment = alpha.addDeploymentTarget(target(alpha));
  assert.throws(() => alpha.addDeploymentTarget(deployment), /Duplicate deployment target/);
  const approval = alpha.addApprovalStep(new BakeTimeApprovalStep('bake', { durationSeconds: 1 }));
  assert.throws(() => alpha.addApprovalStep(approval), /Duplicate approval step/);
});

test('missing stages, sources, targets and invalid approval bindings fail synthesis', t => {
  const { pipeline } = setup(t);
  assert.throws(() => pipeline.synth(), /at least one stage/);
  const build = pipeline.addBuildStage('build');
  assert.throws(() => pipeline.synth(), /at least one source/);
  build.addSource({ path: 'iac' });
  const alpha = pipeline.addStage('alpha');
  assert.throws(() => pipeline.synth(), /at least one target/);
  alpha.addDeploymentTarget(target(alpha));
  alpha.addApprovalStep(new IntegrationTestsApprovalStep(new Stack(alpha, 'tests'), { targetIds: ['unknown'] }));
  assert.throws(() => pipeline.synth(), /unknown target unknown/);
  assert.equal(existsSync(pipeline.pipelineFile), false);
});

test('unresolved environments, sibling-app stacks and NestedStacks cannot produce dangling targets', t => {
  const outdir = temporary(t);
  const app = new App({ outdir, autoSynth: false });
  const pipeline = new Pipeline(app, 'Pipeline');
  const alpha = pipeline.addStage('alpha');
  alpha.addDeploymentTarget(new CDKDeploymentTarget(new Stack(alpha, 'Unknown')));
  assert.throws(() => pipeline.synth(), /set Stack.env.account/);
  const foreign = new CDKDeploymentTarget(new Stack(app, 'Sibling', { env }));
  assert.throws(() => foreign.toDefinition({ pipeline }), /must be scoped beneath pipeline/);
  const foreignTests = new IntegrationTestsApprovalStep(new Stack(app, 'SiblingTests', { env }));
  assert.throws(() => foreignTests.toDefinition({ pipeline }), /must be scoped beneath pipeline/);
  const unknownTests = new IntegrationTestsApprovalStep(new Stack(alpha, 'UnknownTests'));
  assert.throws(() => unknownTests.toDefinition({ pipeline }), /set Stack.env.account/);
  const parent = new Stack(alpha, 'Parent', { env });
  assert.throws(() => new CDKDeploymentTarget(new NestedStack(parent, 'Nested')), /not a NestedStack/);
});

test('target stacks must be unique and in the same environment', t => {
  const { pipeline } = setup(t);
  const stack = new Stack(pipeline, 'First');
  const deployment = new CDKDeploymentTarget(stack);
  assert.throws(() => deployment.addStack(stack), /already in target/);
  assert.throws(() => deployment.addStack(new Stack(pipeline, 'OtherAccount', { env: { ...env, account: '222222222222' } })), /same account and region/);
  assert.throws(() => deployment.addStack(new Stack(pipeline, 'OtherRegion', { env: { ...env, region: 'eu-west-1' } })), /same account and region/);
});

test('invalid bake times and failure actions are rejected', t => {
  const { pipeline } = setup(t);
  const tests = new Stack(pipeline, 'tests');
  for (const durationSeconds of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => new BakeTimeApprovalStep('bake', { durationSeconds }), /positive safe integer/);
  }
  for (const onFailure of [[], ['rollback'], ['block', 'block'], ['block', 'ignore'], ['rollback', 'block']]) {
    assert.throws(() => new IntegrationTestsApprovalStep(tests, { onFailure }), /failure actions/);
  }
  assert.throws(() => new IntegrationTestsApprovalStep(tests, { targetIds: [] }), /non-empty and unique/);
});

test('definition changes cannot silently overwrite a cached pipeline assembly', t => {
  const { pipeline } = setup(t);
  const build = pipeline.addBuildStage('build').addSource({ path: 'iac' });
  pipeline.synth();
  const before = readFileSync(pipeline.pipelineFile, 'utf8');
  build.addSource({ path: 'service' });
  assert.throws(() => pipeline.synth(), /definition changed after synthesis/);
  assert.equal(readFileSync(pipeline.pipelineFile, 'utf8'), before);
});

test('schema entry point can load without importing CDK or constructs', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(name, ...args) {
      if (name.startsWith('aws-cdk-lib') || name === 'constructs') throw new Error('CDK import');
      return original.call(this, name, ...args);
    };
    require('@foundry/pipeline-builder/schema');
  `], { cwd: resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('real cdk synth auto-synthesizes the TypeScript example with default and custom output', { timeout: 60000 }, t => {
  const cli = require.resolve('aws-cdk/bin/cdk');
  const tsNode = require.resolve('ts-node/dist/bin.js');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  // Prefixing with exec keeps CDK from treating the enclosing argument quotes
  // as quotes around the entire app command.
  const appCommand = 'exec ' + [process.execPath, tsNode, '--project', resolve(__dirname, '../tsconfig.example.json'), resolve(__dirname, '../examples/pipeline.ts')].map(quote).join(' ');
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
    const manifest = readJson(join(outdir, 'manifest.json'));
    const nested = Object.values(manifest.artifacts).find(a => a.type === 'cdk:cloud-assembly');
    assert.ok(nested);
    const pipelineDir = join(outdir, nested.properties.directoryName);
    const definition = readJson(join(pipelineDir, 'pipeline.json'));
    assert.equal(definition.name, 'messaging-gateway-pipeline');
    assert.deepEqual(definition.stages.map(stage => stage.id), ['alpha']);
    assert.equal(definition.stages[0].targets.length, 1);
    assert.deepEqual(definition.stages[0].approvalSteps.map(step => step.type), ['integration-tests', 'bake-time']);
    const assembly = new CloudAssembly(pipelineDir);
    const integrationTests = definition.stages[0].approvalSteps[0];
    const testDeployment = integrationTests.deployment.deployments[0];
    const testsAssembly = new CloudAssembly(resolve(pipelineDir, testDeployment.cloudAssembly.directory));
    const testsArtifact = testsAssembly.getStackArtifact(testDeployment.cloudAssembly.stackArtifactIds[0]);
    assert.deepEqual(testDeployment.resources, [testsArtifact.stackName]);
    assert.equal(integrationTests.id, 'integration-tests');
    assert.equal(integrationTests.deployment.region, env.region);
    assert.equal(integrationTests.deployment.awsAccountId, env.account);
    const testsTemplate = readJson(join(testsAssembly.directory, testsArtifact.templateFile));
    assert.deepEqual(Object.values(testsTemplate.Resources ?? {}).filter(resource => resource.Type !== 'AWS::CDK::Metadata'), []);
    assert.equal(integrationTests.runner, undefined);
    assert.equal(integrationTests.functionArnOutput, undefined);
    assert.equal(assembly.stacks.length, 2);
    for (const target of definition.stages[0].targets) {
      assert.equal(target.id, 'iad');
      assert.equal(target.name, 'iad');
      assert.equal(target.deployments[0].source, '.');
      const artifact = assembly.getStackArtifact(target.deployments[0].cloudAssembly.stackArtifactIds[0]);
      const resources = Object.values(readJson(join(pipelineDir, artifact.templateFile)).Resources);
      assert.equal(resources.filter(resource => resource.Type === 'AWS::S3::Bucket').length, 1);
      assert.equal(resources.some(resource => resource.Type.startsWith('AWS::Lambda::')), false);
    }
    if (output) assert.equal(existsSync(join(cwd, 'cdk.out')), false);
  }
});
