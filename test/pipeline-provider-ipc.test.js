import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PipelineStore } from '../lib/pipeline-store.js';
import { attachInvocationProtocol } from '../lib/pipeline-provider-adapter.js';
import { createInvocationClient } from '../lib/pipeline-provider-worker.mjs';

function fixture(t, maxInvocations = 10) {
  mkdirSync('tmp', { recursive: true });
  const root = mkdtempSync(path.resolve('tmp/provider-ipc-'));
  const db = new DatabaseSync(path.join(root, 'test.sqlite'));
  const store = new PipelineStore(db);
  const run = store.createRun({ topicId: 1, lane: 'manual', requestKey: 'ipc', inputHash: 'v1', maxInvocations });
  const job = store.claim(store.enqueue(run.id, { stage: 'clean', scope: '1', inputHash: 'v1', type: 'clean_image_generate' }).id);
  store.beginProvider(job);
  const controller = new AbortController();
  const parent = new EventEmitter();
  const child = new EventEmitter();
  parent.connected = child.connected = true;
  parent.send = (message, callback) => { queueMicrotask(() => child.emit('message', message)); callback?.(); };
  child.send = (message, callback) => { queueMicrotask(() => parent.emit('message', message)); callback?.(); };
  let inputError;
  const journalPath = path.join(root, 'provider-invocations.jsonl');
  const protocol = attachInvocationProtocol(parent, {
    control: { signal: controller.signal, reserveInvocation: () => store.reserveInvocation(job) },
    assertInputs: () => { store.assertLease(job); if (inputError) throw Error(inputError); }, journalPath
  });
  const client = createInvocationClient(child, controller.signal, { timeoutMs: 100 });
  t.after(() => { client.dispose(); protocol.dispose(); db.close(); });
  return { db, store, run, job, controller, parent, child, protocol, client,
    setInputError: value => { inputError = value; },
    records: () => existsSync(journalPath) ? readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('each actual boundary reserves once and both ACKs precede completion', async t => {
  const f = fixture(t);
  const held = [];
  f.parent.send = (message, callback) => { held.push(message); callback?.(); };
  let reserved = false;
  const waiting = f.client.reserveInvocation().then(finish => { reserved = true; return finish; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reserved, false);
  assert.equal(f.store.getRun(f.run.id).invocations_used, 1);
  f.child.emit('message', held.shift());
  const finish = await waiting;
  let completed = false;
  const finishing = finish('completed').then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(f.records()[1].status, 'completed');
  f.child.emit('message', held.shift());
  await finishing;
  f.parent.send = (message, callback) => { queueMicrotask(() => f.child.emit('message', message)); callback?.(); };
  const second = await f.client.reserveInvocation();
  await second('error');
  assert.equal(f.store.getRun(f.run.id).invocations_used, 2);
  assert.equal(f.db.prepare('SELECT invocation_count FROM pipeline_attempts WHERE lease_token=?').get(f.job.lease_token).invocation_count, 2);
  assert.equal(f.records().filter(record => record.type === 'reserve_invocation').length, 2);
  f.client.assertComplete();
  f.protocol.assertComplete();
  await assert.rejects(second('error'), /already_finished/);
});

test('budget denial prevents another provider invocation', async t => {
  const f = fixture(t, 1);
  await (await f.client.reserveInvocation())('completed');
  await assert.rejects(f.client.reserveInvocation(), /budget_exhausted/);
  assert.equal(f.store.getRun(f.run.id).invocations_used, 1);
  assert.equal(f.records().length, 2);
  assert.throws(() => f.protocol.assertComplete(), /budget_exhausted/);
});

for (const reason of ['canceled', 'lease', 'input']) {
  test(`parent rejects reservation after ${reason} without consuming budget`, async t => {
    const f = fixture(t);
    // Send directly to test the parent's fence, independent of the child's check.
    if (reason === 'canceled') f.controller.abort(Error('canceled'));
    if (reason === 'lease') f.store.cancel(f.run.id);
    if (reason === 'input') f.setInputError('input_changed');
    const reply = new Promise(resolve => f.child.once('message', resolve));
    f.parent.emit('message', { type: 'reserve_invocation', requestId: 'direct-1' });
    assert.equal((await reply).ok, false);
    assert.equal(f.store.getRun(f.run.id).invocations_used, 0);
    assert.equal(f.records().length, 0);
  });
}

test('completed result still journals and ACKs after cancellation and lease loss', async t => {
  const f = fixture(t);
  const finish = await f.client.reserveInvocation();
  f.controller.abort(Error('canceled'));
  f.store.cancel(f.run.id);
  await finish('error');
  assert.equal(f.records()[1].status, 'error');
  f.protocol.assertComplete();
  f.client.assertComplete();
});

test('missing result blocks promotion; duplicate reservation never double counts', async t => {
  const f = fixture(t);
  await f.client.reserveInvocation();
  assert.throws(() => f.protocol.assertComplete(), /result_missing/);
  assert.throws(() => f.client.assertComplete(), /result_missing/);
  const reply = new Promise(resolve => f.child.once('message', resolve));
  f.parent.emit('message', { type: 'reserve_invocation', requestId: 'invocation-1' });
  assert.match((await reply).error, /duplicate/);
  assert.equal(f.store.getRun(f.run.id).invocations_used, 1);
});

test('unknown result and invalid status fail closed', async t => {
  const f = fixture(t);
  const reply = new Promise(resolve => f.child.once('message', resolve));
  f.parent.emit('message', { type: 'invocation_result', requestId: 'unknown', status: 'completed' });
  assert.match((await reply).error, /not_reserved/);
  assert.throws(() => f.protocol.assertComplete(), /not_reserved/);
});

test('disconnect rejects pending reservation instead of hanging', async t => {
  const f = fixture(t);
  f.child.send = () => {};
  const waiting = f.client.reserveInvocation();
  f.child.connected = false;
  f.child.emit('disconnect');
  await assert.rejects(waiting, /disconnected/);
  assert.equal(f.store.getRun(f.run.id).invocations_used, 0);
});

test('lost result acknowledgment fails closed even if parent recorded completion', async t => {
  const f = fixture(t);
  const finish = await f.client.reserveInvocation();
  f.parent.send = () => {};
  await assert.rejects(finish('completed'), /ack_timeout/);
  assert.equal(f.records()[1].status, 'completed');
  assert.throws(() => f.client.assertComplete(), /ack_timeout/);
});

test('concurrent boundaries correlate independent results and reserve each once', async t => {
  const f = fixture(t);
  const [first, second] = await Promise.all([f.client.reserveInvocation(), f.client.reserveInvocation()]);
  await second('error');
  await first('completed');
  assert.deepEqual(f.records().filter(record => record.type === 'invocation_result').map(record => record.requestId), ['invocation-2', 'invocation-1']);
  assert.equal(f.store.getRun(f.run.id).invocations_used, 2);
  f.protocol.assertComplete();
  f.client.assertComplete();
});

test('invalid result status is not acknowledged as completion', async t => {
  const f = fixture(t);
  const finish = await f.client.reserveInvocation();
  await assert.rejects(finish('success'), /invalid_invocation_status/);
  const reply = new Promise(resolve => f.child.once('message', resolve));
  f.parent.emit('message', { type: 'invocation_result', requestId: 'invocation-1', status: 'success' });
  assert.match((await reply).error, /invalid_invocation_status/);
  assert.equal(f.records().length, 1);
});

test('IPC send failure rejects reservation and prevents successful outcome', async t => {
  const f = fixture(t);
  f.child.send = (message, callback) => callback(Error('send_failed'));
  await assert.rejects(f.client.reserveInvocation(), /send_failed/);
  assert.throws(() => f.client.assertComplete(), /send_failed/);
  assert.equal(f.store.getRun(f.run.id).invocations_used, 0);
});
