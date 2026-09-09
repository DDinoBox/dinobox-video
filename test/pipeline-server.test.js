import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const childPath = fileURLToPath(new URL('./fixtures/pipeline-server-child.mjs', import.meta.url));

// Never import server.js into the test runner: it opens a database and listens.
async function isolatedScenario(scenario) {
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const directory = mkdtempSync(path.join(root, 'tmp', 'pipeline-server-'));
  const dataDir = path.join(directory, 'data');
  const child = spawn(process.execPath, [childPath, scenario], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      DINOBOX_ENABLE_DURABLE_PIPELINE: scenario === 'optout' ? '' : '1',
      DINOBOX_DATA_DIR: dataDir,
      DINOBOX_DB_PATH: path.join(dataDir, 'test.db'),
      DISABLE_BACKGROUND_WORKERS: '1',
      DINOBOX_DISABLE_AUTOMATIC_REMEDIATION: '1',
      DINOBOX_AI_WORKER_TOPIC_ID: '0',
      DINOBOX_AI_WORKER_JOB_ID: '0',
      PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let timedOut = false;
  // Only this test's subprocess may be terminated; never touch a live server.
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45_000);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(timedOut, false, `Child timed out. Isolated data retained: ${directory}\n${stdout}\n${stderr}`);
    assert.equal(code, 0, `Child failed (${signal || code}). Isolated data retained: ${directory}\n${stdout}\n${stderr}`);
    const result = stdout.split(/\r?\n/u).find(line => line.startsWith('PIPELINE_TEST_RESULT '));
    assert.ok(result, `Missing child result:\n${stdout}\n${stderr}`);
    return JSON.parse(result.slice('PIPELINE_TEST_RESULT '.length));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

test('real server queue, claim, runner and continuation converge seven mock CLEAN/INFO pairs', { timeout: 60_000 }, async () => {
  const result = await isolatedScenario('convergence');
  assert.equal(result.status, 'awaiting_user_review');
  assert.equal(result.cleanJobs, 7);
  assert.equal(result.infoJobs, 1);
  assert.equal(result.artifacts, 14);
  assert.equal(result.aiPass, 14);
  assert.equal(result.videoJobs, 0);
  assert.equal(result.mockProviders, true);
});

test('real pipeline HTTP API creates, gets and cancels idempotently on an ephemeral loopback port', { timeout: 60_000 }, async () => {
  const result = await isolatedScenario('api');
  assert.equal(result.status, 'canceled');
  assert.equal(result.jobs, 1);
  assert.equal(result.artifacts, 0);
});

for (const [scenario, description] of [
  ['lease', 'recovered worker A cannot invoke a provider using worker B lease'],
  ['info-failure', 'failed INFO QC stops once without successors or further budget usage'],
  ['manual', 'manual lane waits for user review after seven AI_PASS CLEAN images'],
  ['stale', 'changed input revision holds the claimed CLEAN before provider invocation'],
  ['optout', 'default startup leaves durable schema absent and pipeline API unavailable'],
  ['missing-provider', 'missing durable provider holds without invoking real adapters'],
  ['upstream-from-script', 'HTTP-created run completes script through seven CLEAN and INFO mock artifacts'],
  ['script-revise', 'script quality revise holds before TTS'],
  ['tts-pending', 'pending TTS result holds without a shotlist successor'],
  ['tts-generating', 'generating TTS result holds without a shotlist successor'],
  ['info-mutation', 'INFO-owned specification and prompt updates do not falsely invalidate input'],
  ['info-remove-required', 'INFO cannot remove the initial required overlay contract']
]) {
  test(description, { timeout: 60_000 }, async () => {
    const result = await isolatedScenario(scenario);
    assert.equal(result.scenario, scenario);
    assert.equal(result.verified, true);
  });
}
