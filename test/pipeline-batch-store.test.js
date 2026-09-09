import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PipelineStore } from '../lib/pipeline-store.js';

function fixture(t) {
  mkdirSync('tmp', { recursive: true });
  const file = path.join(mkdtempSync(path.resolve('tmp/pipeline-batch-store-')), 'test.db');
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  return { db, file, store: new PipelineStore(db) };
}
const candidates = [1, 2, 3].map(topicId => ({ topicId, inputHash: `hash-${topicId}`, startContract: { reference: `ref-${topicId}`, opaque: [true, null] } }));
const contract = overrides => ({ requestKey: 'batch-request', candidates, lane: 'manual', ...overrides });
const task = (scope = 'batch') => ({ stage: 'continue', type: 'pipeline_continue', inputHash: 'input', scope });

test('additive migration, ordered contract persistence, duplicate identity and strict candidate limit', t => {
  const { db, file, store } = fixture(t);
  const legacy = store.createRun({ topicId: 9, requestKey: 'legacy', inputHash: 'legacy' });
  assert.equal(legacy.batch_id, null);
  const batch = store.createBatch(contract());
  assert.deepEqual(JSON.parse(batch.candidates_json), candidates);
  assert.equal(batch.next_candidate_index, 0);
  assert.equal(store.createBatch(contract()).id, batch.id);
  for (const change of [{ candidates: [...candidates].reverse() }, { candidates: [{ ...candidates[0], startContract: { changed: true } }] }, { maxAttempts: 10 }, { lane: 'production_canary' }]) {
    assert.throws(() => store.createBatch(contract(change)), /contract_mismatch/);
  }
  for (const invalid of [[], [...candidates, candidates[0]], [{ topicId: 1, inputHash: 'h' }]]) assert.throws(() => store.createBatch(contract({ candidates: invalid })), /contract/);
  const reopened = new DatabaseSync(file);
  try {
    const second = new PipelineStore(reopened);
    assert.equal(second.getBatch(batch.id).deadline_ms, batch.deadline_ms);
    assert.equal(second.getRun(legacy.id).batch_id, null);
  } finally { reopened.close(); }
  assert.ok(db.prepare('PRAGMA table_info(pipeline_runs)').all().some(row => row.name === 'batch_id'));
});

test('only ordered structural rejection advances and allocation plus enqueue rolls back atomically', t => {
  const { store } = fixture(t);
  const batch = store.createBatch(contract());
  assert.throws(() => store.createRun({ ...candidates[0], requestKey: 'bypass', batchId: batch.id }), /requires_startNextCandidate/);
  const first = store.startNextCandidate(batch.id);
  assert.equal(first.request_key, `batch:${batch.id}:0`);
  assert.equal(first.deadline_ms, batch.deadline_ms);
  assert.throws(() => store.startNextCandidate(batch.id), /not_advanceable/);
  const queued = store.enqueue(first.id, task());
  assert.throws(() => store.transaction(() => {
    store.rejectCandidate(first.id);
    const second = store.startNextCandidate(batch.id);
    store.enqueue(second.id, task());
    throw Error('crash');
  }), /crash/);
  assert.equal(store.getRun(first.id).status, 'queued');
  assert.equal(store.jobs(first.id)[0].id, queued.id);
  assert.equal(store.getBatch(batch.id).next_candidate_index, 1);
  assert.equal(store.batchRuns(batch.id).length, 1);
  store.rejectCandidate(first.id);
  assert.equal(store.jobs(first.id)[0].status, 'canceled');
  const second = store.startNextCandidate(batch.id);
  assert.equal(second.topic_id, 2);
  store.rejectCandidate(second.id);
  const third = store.startNextCandidate(batch.id);
  store.rejectCandidate(third.id);
  assert.equal(store.startNextCandidate(batch.id), null);
  assert.equal(store.getBatch(batch.id).terminal_reason, 'needs_reference');
  assert.equal(store.getBatch(batch.id).status, 'blocked');
  assert.equal(store.getBatch(batch.id).next_candidate_index, 3);
});

test('attempts and invocations are shared across candidates, with fixed deadline after reopen', t => {
  const { store, db } = fixture(t);
  const batch = store.createBatch(contract({ maxInvocations: 2, maxAttempts: 4 }));
  const first = store.startNextCandidate(batch.id);
  const job1 = store.claim(store.enqueue(first.id, task()).id);
  store.reserveInvocation(job1);
  store.rejectCandidate(first.id);
  const restarted = new PipelineStore(db);
  const second = restarted.startNextCandidate(batch.id);
  const job2 = restarted.claim(restarted.enqueue(second.id, task()).id);
  restarted.enqueue(second.id, task('sibling'));
  restarted.reserveInvocation(job2);
  assert.equal(restarted.getBatch(batch.id).attempts_used, 2);
  assert.equal(restarted.getBatch(batch.id).invocations_used, 2);
  assert.equal(second.deadline_ms, batch.deadline_ms);
  assert.equal(restarted.getRun(first.id).invocations_used, 1);
  assert.equal(restarted.getRun(second.id).invocations_used, 1);
  assert.throws(() => restarted.transaction(() => restarted.transaction(() => restarted.reserveInvocation(job2))), /budget_exhausted/);
  assert.equal(restarted.getBatch(batch.id).status, 'blocked');
  assert.equal(restarted.getBatch(batch.id).invocations_used, 2);
  assert.ok(restarted.jobs(second.id).every(job => job.status === 'canceled'));
  assert.throws(() => restarted.startNextCandidate(batch.id), /batch_not_active/);
});

test('shared attempt exhaustion fences all jobs and persists across an outer rollback', t => {
  const { store } = fixture(t);
  const batch = store.createBatch(contract({ maxAttempts: 2 }));
  const first = store.startNextCandidate(batch.id);
  store.claim(store.enqueue(first.id, task()).id);
  store.rejectCandidate(first.id);
  const second = store.startNextCandidate(batch.id);
  store.claim(store.enqueue(second.id, task()).id);
  const waiting = store.enqueue(second.id, task('second'));
  assert.throws(() => store.transaction(() => store.claim(waiting.id)), /budget_exhausted/);
  assert.equal(store.getBatch(batch.id).attempts_used, 2);
  assert.equal(store.getBatch(batch.id).terminal_reason, 'budget_exhausted');
  assert.ok(store.jobs(second.id).every(job => job.status === 'canceled'));
});

test('claim and invocation counters roll back together on ordinary transaction failure', t => {
  const { store } = fixture(t);
  const batch = store.createBatch(contract());
  const run = store.startNextCandidate(batch.id);
  const queued = store.enqueue(run.id, task());
  assert.throws(() => store.transaction(() => { store.claim(queued.id); throw Error('crash'); }), /crash/);
  assert.equal(store.getBatch(batch.id).attempts_used, 0);
  assert.equal(store.getRun(run.id).attempts_used, 0);
  assert.equal(store.jobs(run.id)[0].status, 'queued');
  const job = store.claim(queued.id);
  assert.throws(() => store.transaction(() => { store.reserveInvocation(job); throw Error('crash'); }), /crash/);
  assert.equal(store.getBatch(batch.id).invocations_used, 0);
  assert.equal(store.getRun(run.id).invocations_used, 0);
});

test('original batch deadline fences enqueue and survives nested transaction rollback', t => {
  const { store, db } = fixture(t);
  const batch = store.createBatch(contract());
  const run = store.startNextCandidate(batch.id);
  store.enqueue(run.id, task());
  db.prepare('UPDATE pipeline_batches SET deadline_ms=? WHERE id=?').run(Date.now() - 1, batch.id);
  assert.throws(() => store.transaction(() => store.enqueue(run.id, task('late'))), /budget_exhausted/);
  assert.equal(store.getBatch(batch.id).terminal_reason, 'budget_exhausted');
  assert.equal(store.getRun(run.id).status, 'blocked');
  assert.equal(store.jobs(run.id)[0].status, 'canceled');
});

test('ordinary failure ends batch; review holds it; cancellation includes review and fences callbacks', t => {
  const { store } = fixture(t);
  const failed = store.createBatch(contract());
  const bad = store.startNextCandidate(failed.id);
  store.rejectCandidate(bad.id, 'provider_error');
  assert.equal(store.getBatch(failed.id).terminal_reason, 'provider_error');
  assert.throws(() => store.startNextCandidate(failed.id), /batch_not_active/);
  const review = store.createBatch(contract({ requestKey: 'review' }));
  const run = store.startNextCandidate(review.id);
  const job = store.claim(store.enqueue(run.id, task()).id);
  store.complete(job, { status: 'awaiting_user_review' });
  assert.equal(store.getBatch(review.id).status, 'awaiting_user_review');
  assert.throws(() => store.startNextCandidate(review.id), /batch_not_active/);
  store.cancelBatch(review.id);
  assert.equal(store.getRun(run.id).status, 'canceled');
  assert.equal(store.getBatch(review.id).status, 'canceled');
  assert.throws(() => store.complete(job), /lease/);
  assert.throws(() => store.startNextCandidate(review.id), /batch_not_active/);
  const active = store.createBatch(contract({ requestKey: 'active' }));
  const activeRun = store.startNextCandidate(active.id);
  store.claim(store.enqueue(activeRun.id, task()).id);
  store.enqueue(activeRun.id, task('pending'));
  store.cancelBatch(active.id);
  assert.ok(store.jobs(activeRun.id).every(job => job.status === 'canceled' && job.cancel_requested === 1));
});

test('old run schema migrates additively without changing existing identity or budgets', t => {
  const { store, db } = fixture(t);
  const legacy = store.createRun({ topicId: 9, requestKey: 'old', inputHash: 'h', maxInvocations: 7 });
  db.exec('DROP INDEX idx_pipeline_batch_active; ALTER TABLE pipeline_runs DROP COLUMN batch_id');
  const migrated = new PipelineStore(db);
  assert.deepEqual(migrated.getRun(legacy.id), legacy);
  assert.equal(migrated.createBatch(contract()).status, 'queued');
});

test('new allocation cannot reset an exhausted budget and parent status fences child activity', t => {
  const { store, db } = fixture(t);
  const batch = store.createBatch(contract({ maxInvocations: 1 }));
  const run = store.startNextCandidate(batch.id);
  const job = store.claim(store.enqueue(run.id, task()).id);
  store.reserveInvocation(job);
  store.rejectCandidate(run.id);
  assert.throws(() => store.transaction(() => store.startNextCandidate(batch.id)), /budget_exhausted/);
  assert.equal(store.batchRuns(batch.id).length, 1);
  assert.equal(store.getBatch(batch.id).next_candidate_index, 1);
  assert.equal(store.getBatch(batch.id).status, 'blocked');
  const other = store.createBatch(contract({ requestKey: 'parent-fence' }));
  const child = store.startNextCandidate(other.id);
  db.prepare("UPDATE pipeline_batches SET status='canceled' WHERE id=?").run(other.id);
  assert.throws(() => store.assertActive(child.id), /batch_not_active:canceled/);
  assert.throws(() => store.enqueue(child.id, task()), /batch_not_active:canceled/);
});
