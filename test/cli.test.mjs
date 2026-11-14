import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

test('CLI has one entry point without optional modes, hosts or file configuration', () => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  for (const args of [['--dry-run'], ['--tasks', 'daily'], ['--host', 'red'], ['--state', 'custom.json'], ['--report', 'custom.json'], ['--help']]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, CIVITAI_API_KEY: '' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /without additional arguments/);
  }
});

test('missing key logs all task failures and unknown balance without writing files', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'civitai-cli-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const summaryFile = join(directory, 'summary.md');
  const result = spawnSync(process.execPath, [cli], {
    cwd: directory, timeout: 5000, encoding: 'utf8',
    env: { ...process.env, CIVITAI_API_KEY: '', CIVITAI_EXECUTE: '', CIVITAI_HOST: 'com', CIVITAI_TASKS: 'daily', GITHUB_STEP_SUMMARY: summaryFile },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CIVITAI_API_KEY/);
  for (const label of ['Daily Boost', 'Image reactions', 'First follows']) {
    assert.ok(result.stdout.includes(`[${label}] BLOCKED`));
  }
  assert.match(result.stdout, /Current Blue Buzz: UNKNOWN/);
  assert.deepEqual(await readdir(directory), []);
});

const workflow = parseYaml(await readFile(new URL('../.github/workflows/checkin.yml', import.meta.url), 'utf8'));

test('workflow only checks out code, sets up Node, installs dependencies and runs checkin', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.deepEqual(workflow.on.schedule, [{ cron: '0 2 * * *' }]);
  const steps = workflow.jobs.checkin.steps;
  assert.equal(steps.length, 4);
  assert.equal(steps[0].uses, 'actions/checkout@v4');
  assert.equal(steps[1].uses, 'actions/setup-node@v4');
  assert.equal(steps[1].with['node-version'], '24');
  assert.equal(steps[2].run, 'npm ci --ignore-scripts --no-audit --no-fund');
  assert.equal(steps[3].run, 'npm run checkin');
  assert.deepEqual(steps[3].env, { CIVITAI_API_KEY: '${{ secrets.CIVITAI_API_KEY }}' });
  assert.doesNotMatch(JSON.stringify(workflow), /vars\./);
  assert.equal(workflow.jobs.checkin['timeout-minutes'], 20);
});