import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/pipeline-stage-server-child.mjs', import.meta.url));

async function runScenario(scenario) {
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const directory = mkdtempSync(path.join(root, 'tmp', 'pipeline-stage-server-'));
  const dataRoot = path.join(directory, 'data');
  const child = spawn(process.execPath, [fixture, scenario], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_OPTIONS: '',
      DINOBOX_ENABLE_DURABLE_PIPELINE: '1', DINOBOX_DATA_DIR: dataRoot,
      DINOBOX_DB_PATH: path.join(dataRoot, 'test.db'),
      DISABLE_BACKGROUND_WORKERS: '1', DINOBOX_DISABLE_AUTOMATIC_REMEDIATION: '1',
      DINOBOX_PIPELINE_PROVIDER_WORKER: '0', DINOBOX_ISOLATED_MOCK_PROVIDER: '1',
      DINOBOX_AI_WORKER_TOPIC_ID: '0', DINOBOX_AI_WORKER_JOB_ID: '0', PORT: '0'
    }
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(timedOut, false, `Timed out; isolated artifacts retained at ${directory}\n${stdout}\n${stderr}`);
    assert.equal(code, 0, `Child failed; isolated artifacts retained at ${directory}\n${stdout}\n${stderr}`);
    const line = stdout.split(/\r?\n/u).find(line => line.startsWith('PIPELINE_STAGE_RESULT '));
    assert.ok(line, stdout);
    return JSON.parse(line.slice('PIPELINE_STAGE_RESULT '.length));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

test('isolated staged script → native TTS with mocked Vox → shotlist → seven CLEAN/INFO pairs promote with fenced publication', { timeout: 100_000 }, async () => {
  const result = await runScenario('full-chain');
  assert.equal(result.status, 'awaiting_user_review');
  assert.equal(result.artifacts, 14);
  assert.equal(result.cleanJobs, 7);
  assert.equal(result.infoJobs, 1);
  assert.equal(result.nativeTts, true);
});

test('late canceled staged script cannot publish its database title or project manifest', { timeout: 100_000 }, async () => {
  const result = await runScenario('cancel-late');
  assert.equal(result.status, 'canceled');
  assert.equal(result.parentUnchanged, true);
  assert.equal(result.providerWroteStagedData, true);
});

test('user INFO prompt API changes only INFO revision and fences an already claimed INFO provider', { timeout: 100_000 }, async () => {
  const result = await runScenario('info-user-edit');
  assert.equal(result.status, 'blocked');
  assert.equal(result.infoHashChanged, true);
  assert.equal(result.cleanHashUnchanged, true);
  assert.equal(result.staleProviderCalls, 0);
});
