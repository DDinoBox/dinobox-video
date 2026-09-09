import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('full dashboard fixture serves actual page and closes its server even with a browser SSE connection', { timeout: 60000 }, async () => {
  const dataDir = path.join(mkdtempSync(path.join(root, 'tmp', 'dashboard-browser-')), 'data');
  const child = spawn(process.execPath, ['test/fixtures/pipeline-server-child.mjs', 'convergence'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DINOBOX_BROWSER_FIXTURE: '1', DINOBOX_ENABLE_DURABLE_PIPELINE: '1', DINOBOX_DATA_DIR: dataDir,
      DINOBOX_DB_PATH: path.join(dataDir, 'test.db'), DISABLE_BACKGROUND_WORKERS: '1', DINOBOX_DISABLE_AUTOMATIC_REMEDIATION: '1',
      DINOBOX_AI_WORKER_TOPIC_ID: '0', DINOBOX_AI_WORKER_JOB_ID: '0', PORT: '0' }
  });
  let output = '', error = '', ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  child.stdout.on('data', chunk => {
    output += chunk;
    const line = output.split(/\r?\n/).find(line => line.startsWith('BROWSER_FIXTURE_READY '));
    if (line) ready(JSON.parse(line.slice('BROWSER_FIXTURE_READY '.length)));
  });
  child.stderr.on('data', chunk => { error += chunk; });
  const exit = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const timeout = setTimeout(() => { child.kill(); ready(null); }, 45000);
  const abort = new AbortController();
  try {
    const fixture = await readyPromise;
    assert.ok(fixture, `${output}\n${error}`);
    const html = await (await fetch(fixture.url)).text();
    assert.ok(html.includes('id="topic-workbench-modal"'));
    assert.ok(html.includes('id="durable-clean-review"'));
    const status = await (await fetch(`${fixture.url}/api/pipeline/topics/${fixture.topicId}`)).json();
    assert.equal(status.execution, 'awaiting_user_review');
    assert.equal(status.userApproval, 'pending');
    const events = await fetch(`${fixture.url}/api/jobs/events`, { signal: abort.signal });
    assert.equal(events.status, 200);
    assert.equal((await fetch(`${fixture.url}/__fixture/stop`, { method: 'POST' })).status, 200);
    assert.equal(await exit, 0, `${output}\n${error}`);
  } finally {
    clearTimeout(timeout);
    abort.abort();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
