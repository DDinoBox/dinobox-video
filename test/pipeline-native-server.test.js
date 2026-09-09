import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/pipeline-native-server-child.mjs', import.meta.url));
const boundary = new URL('./fixtures/pipeline-native-boundary.mjs', import.meta.url).href;

async function runNativeScenario(scenario) {
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const directory = mkdtempSync(path.join(root, 'tmp', 'pipeline-native-server-'));
  const dataRoot = path.join(directory, 'data');
  const python = path.join(root, '.venv', 'Scripts', 'python.exe');
  const child = spawn(process.execPath, [fixture], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, NODE_OPTIONS: `--import=${boundary}`,
      DINOBOX_NATIVE_TEST_SCENARIO: scenario, QUALITY_AUTO_REPAIR_LIMIT: '0',
      DINOBOX_ENABLE_DURABLE_PIPELINE: '1', DINOBOX_DATA_DIR: dataRoot, DINOBOX_DB_PATH: path.join(dataRoot, 'test.db'),
      DINOBOX_PIPELINE_PROVIDER_WORKER: '0', DINOBOX_ISOLATED_MOCK_PROVIDER: '1',
      DISABLE_BACKGROUND_WORKERS: '1', DINOBOX_DISABLE_AUTOMATIC_REMEDIATION: '1',
      DINOBOX_AI_WORKER_TOPIC_ID: '0', DINOBOX_AI_WORKER_JOB_ID: '0', PORT: '0',
      PDF_PYTHON_BIN: scenario === 'batch-crop-tool' ? path.join(directory, 'missing-python.exe') : python,
      TTS_PYTHON_BIN: python, PYTHONDONTWRITEBYTECODE: '1', TMP: directory, TEMP: directory, TMPDIR: directory
    }
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 280_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, `Native integration failed; retained at ${directory}\n${stdout}\n${stderr}`);
    const line = stdout.split(/\r?\n/u).find(line => line.startsWith('PIPELINE_NATIVE_RESULT '));
    assert.ok(line, stdout);
    const result = JSON.parse(line.slice('PIPELINE_NATIVE_RESULT '.length));
    assert.equal(result.scenario, scenario);
    assert.equal(result.syntheticInputs, true);
    if (scenario.startsWith('batch-')) {
      assert.ok(result.batchId);
      assert.equal(result.batch.id, result.batchId);
      assert.equal(result.evidenceRoot, dataRoot);
      assert.equal(result.batch.invocations_used, result.runs.reduce((sum, run) => sum + run.invocations_used, 0));
      assert.equal(result.batch.attempts_used, result.runs.reduce((sum, run) => sum + run.attempts_used, 0));
      for (const run of result.runs) assert.equal(run.deadline_ms, result.batch.deadline_ms);
    }
    if (['happy', 'upstream-repair-happy', 'info-repair-happy', 'timing-reuse', 'clean-repair-happy', 'repair-happy', 'tts-repair-happy', 'shotlist-repair-happy', 'batch-happy', 'batch-crop-next', 'clean-crop-happy'].includes(scenario)) {
      assert.equal(result.status, 'awaiting_user_review');
      assert.equal(result.artifacts, 14);
      assert.equal(result.verifierPassed, true);
    } else if (scenario.startsWith('clean-repair-')) {
      assert.equal(result.cleanRepair.status,scenario==='clean-repair-cancel'?'canceled':'blocked');
      assert.equal(result.cleanRepair.primaryUnchanged,true);
      assert.equal(result.cleanRepair.noDownstream,true);
    } else {
      assert.equal(result.status, ['tts-repair-cancel', 'upstream-repair-cancel', 'info-repair-cancel', 'batch-cancel'].includes(scenario) ? 'canceled' : 'blocked');
      assert.equal(result.primaryUnchanged, true);
      assert.equal(result.noDownstream, true);
      assert.equal(result.reservedRemaining, 0);
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

for (const [scenario, description] of [
  ...['happy','wrong-row','number','ambiguous','repeated','review-fail','cancel','approved'].map(suffix=>[`upstream-repair-${suffix}`,`native upstream repair ${suffix} preserves one-row rollback contract`]),
  ...['happy','second-fail','none','geometry','claim','cancel','review-only','limit-zero'].map(suffix=>[`info-repair-${suffix}`,`native INFO repair ${suffix} respects one-shot layout-only contract`]),
  ['clean-repair-happy', 'native CLEAN repair replaces one pair within the same run and preserves twelve approvals'],
  ['clean-repair-fail', 'native CLEAN repair rejected independent review preserves primary files'],
  ['clean-repair-cancel', 'native CLEAN repair cancellation drains late reviewers without publication'],
  ['happy', 'native generators and deterministic renderers complete seven pairs using synthetic boundaries'],
  ['timing-reuse', 'native timing-only mutation reuses seven CLEAN and INFO pairs without providers and holds semantic counterexamples'],
  ['repair-happy', 'native one-shot narration repair independently reviews and completes seven pairs'],
  ['repair-wrong-row', 'native narration repair rejects wrong row without publishing'],
  ['repair-number-change', 'native narration repair rejects new number without publishing'],
  ['repair-condition-change', 'native narration repair rejects new condition without publishing'],
  ['repair-second-review-fail', 'native narration repair holds failed independent review without a second patch'],
  ['repair-review-only', 'native reviewOnly opt-out holds explicit narration finding without patching'],
  ['repair-limit-zero', 'native scriptRepairLimit zero opt-out holds explicit narration finding without patching'],
  ['script-reject', 'native script rejection never publishes or queues TTS'],
  ['tts-overrun', 'native TTS over-four-second measurement never publishes or queues shotlist'],
  ['tts-repair-happy', 'native measured TTS repair completes seven pairs using only row2 regeneration'],
  ['tts-repair-second-overrun', 'native measured TTS repair holds second overrun without another patch'],
  ['tts-repair-wrong-row', 'native measured TTS repair rejects wrong row before Vox retry'],
  ['tts-repair-review-reject', 'native measured TTS repair holds semantic rejection before Vox retry'],
  ['tts-repair-cancel', 'native measured TTS repair cancellation before retry completes preserves primary state'],
  ['shotlist-repair-happy', 'native shotlist repair independently reviews one cameraMotion patch and renders seven pairs'],
  ['shotlist-repair-wrong-clip', 'native shotlist repair rejects wrong clip without publishing'],
  ['shotlist-repair-count-change', 'native shotlist repair rejects scene count changes without publishing'],
  ['shotlist-repair-claim-change', 'native shotlist repair rejects claim changes without publishing'],
  ['shotlist-repair-required-info-change', 'native shotlist repair rejects required INFO changes without publishing'],
  ['shotlist-repair-review-fail', 'native shotlist repair holds independent review failure without another patch'],
  ['shotlist-repair-review-only', 'native shotlist repair respects reviewOnly opt-out'],
  ['shotlist-repair-limit-zero', 'native shotlist repair respects shotlistRepairLimit zero opt-out'],
  ['shotlist-repair-upstream-ambiguous', 'native shotlist repair holds upstream ambiguity without patching'],
  ['shotlist-reject', 'native shotlist rejection never publishes or queues CLEAN'],
  ['clean-reject', 'native CLEAN semantic rejection never publishes or queues INFO'],
  ['clean-crop-hold', 'native impossible official crop holds before semantic AI and publication'],
  ['clean-crop-happy', 'native feasible off-center official crop preserves verified bounds and completes'],
  ['info-reject', 'native INFO semantic rejection never publishes or queues continuation'],
  ['budget-two', 'third native invocation is refused before boundary entry and all reservations settle'],
  ['reviewer-drain', 'native failed reviewer drains its delayed sibling and leaves no reserved invocation'],
  ['batch-happy', 'native batch happy replaces reference-infeasible candidate and completes seven pairs'],
  ['batch-crop-next', 'native batch crop-infeasible skips script and shares budget with feasible next candidate'],
  ['batch-crop-tool', 'native batch missing Python holds without provider calls or candidate replacement'],
  ['batch-all-invalid', 'native batch all-invalid exhausts ordered candidates without generation'],
  ['batch-budget', 'native batch budget refuses a third invocation without replacing candidate'],
  ['batch-provider-error', 'native batch provider-error holds without replacing candidate'],
  ['batch-cancel', 'native batch cancel before claim prevents every generation'],
  ['batch-stale', 'native batch stale input blocks without generation or replacement']
]) {
  test(description, { timeout: 300_000 }, async () => runNativeScenario(scenario));
}
