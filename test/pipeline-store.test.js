import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PipelineStore } from '../lib/pipeline-store.js';
import { PipelineRunner } from '../lib/pipeline-runner.js';

function fixture() {
  mkdirSync('tmp', { recursive: true });
  const root = mkdtempSync(path.resolve('tmp/pipeline-store-'));
  const db = new DatabaseSync(path.join(root, 'test.db'));
  const store = new PipelineStore(db);
  return { root, db, store };
}
const task = (clip = 'batch', stage = 'clean') => ({ stage, scope: String(clip), inputHash: 'revision-1', type: `${stage}_image_generate` });

test('stable identity includes clip and operation; request key does not reset budgets', () => {
  const { store, db } = fixture();
  const run = store.createRun({ topicId: 159, lane: 'production_canary', requestKey: 'one', inputHash: 'revision-1' });
  assert.equal(store.createRun({ topicId: 159, lane: 'production_canary', requestKey: 'one', inputHash: 'revision-1' }).id, run.id);
  for (let i = 1; i <= 7; i++) assert.equal(store.enqueue(run.id, task(i)).id, store.enqueue(run.id, task(i)).id);
  assert.equal(store.jobs(run.id).length, 7);
  assert.notEqual(store.enqueue(run.id, { ...task(1), operation: 'repair' }).id, store.enqueue(run.id, task(1)).id);
  assert.notEqual(store.enqueue(run.id, { ...task(1), inputHash: 'revision-2' }).id, store.enqueue(run.id, task(1)).id);
  assert.throws(() => store.enqueue(run.id, { ...task(), type: 'video_generate', stage: 'video' }), /stage/);
  assert.throws(() => store.enqueue(run.id, { ...task(), type: 'video_generate' }), /contract/);
  db.close();
});

test('result and successor rollback together; cancellation fences late results', () => {
  const { store, db } = fixture();
  const run = store.createRun({ topicId: 159, lane: 'production_canary', requestKey: 'atomic', inputHash: 'revision-1' });
  const job = store.claim(store.enqueue(run.id, task(1)).id);
  assert.throws(() => store.complete(job, { successors: [task(2)], beforeCommit() { throw Error('crash'); } }), /crash/);
  assert.equal(store.jobs(run.id).length, 1);
  assert.equal(store.jobs(run.id)[0].status, 'running');
  store.cancel(run.id);
  assert.throws(() => store.complete(job, { successors: [task(2)] }), /lease|canceled/);
  assert.equal(store.jobs(run.id).length, 1);
  db.close();
});

test('expired unknown provider result is reconciled, not replayed; pre-call claim resumes same run', () => {
  const { store, db } = fixture();
  const run = store.createRun({ topicId: 1, lane: 'manual', requestKey: 'recovery', inputHash: 'revision-1' });
  const first = store.claim(store.enqueue(run.id, task(1)).id);
  store.recover(Date.now() + 3600000);
  const second = store.claim(first.id);
  assert.equal(second.run_id, run.id);
  assert.notEqual(second.lease_token, first.lease_token);
  assert.throws(() => store.complete(first, {}), /lease/);
  store.beginProvider(second);
  store.recover(Date.now() + 3600000);
  assert.equal(store.getRun(run.id).status, 'blocked');
  assert.equal(store.jobs(run.id)[0].status, 'reconcile_required');
  db.close();
});

test('invocation budget reservations persist across reopen and stop successor', () => {
  const { store, db } = fixture();
  const run = store.createRun({ topicId: 1, lane: 'production_canary', requestKey: 'budget', inputHash: 'revision-1', maxInvocations: 1 });
  const job = store.claim(store.enqueue(run.id, task(1)).id);
  store.beginProvider(job);
  store.reserveInvocation(job);
  assert.throws(() => new PipelineStore(db).reserveInvocation(job), /budget_exhausted/);
  assert.equal(store.getRun(run.id).invocations_used, 1);
  assert.equal(store.getRun(run.id).terminal_reason, 'budget_exhausted');
  assert.throws(() => store.complete(job, { successors: [task(2)] }), /lease|blocked/);
  db.close();
});

test('mock provider publishes seven CLEAN and INFO files, single INFO batch, review hold and no H3', async () => {
  const { store, db, root } = fixture();
  const run = store.createRun({ topicId: 1, lane: 'production_canary', requestKey: 'files', inputHash: 'revision-1' });
  for (let clip = 1; clip <= 7; clip++) store.enqueue(run.id, task(clip));
  const runner = new PipelineRunner(store, { artifactRoot: root });
  while (true) {
    const row = store.jobs(run.id).find(j => j.status === 'queued');
    if (!row) break;
    const job = store.claim(row.id);
    await runner.execute(job, async () => {
      const clips = job.pipeline_stage === 'clean' ? [Number(job.scope_key)] : [1, 2, 3, 4, 5, 6, 7];
      const artifacts = clips.map(clip => {
        const file = path.join(root, `${clip}-${job.pipeline_stage}.png`);
        writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
        return { path: file, clip, kind: job.pipeline_stage, quality: 'pass', freshness: 'current', userApproval: 'pending', inputHash: 'revision-1', requiredOverlay: clip <= 2, overlayType: 'arrow' };
      });
      return { artifacts, successors: job.pipeline_stage === 'clean' && store.jobs(run.id).filter(j => j.pipeline_stage === 'clean' && j.status === 'completed').length === 6 ? [task('batch', 'info')] : [], status: job.pipeline_stage === 'info' ? 'awaiting_user_review' : undefined };
    });
  }
  assert.equal(store.getRun(run.id).status, 'awaiting_user_review');
  assert.equal(store.jobs(run.id).filter(j => j.pipeline_stage === 'info').length, 1);
  assert.equal(store.artifacts(run.id).length, 14);
  assert.equal(store.artifacts(run.id).filter(a => a.user_approval === 'approved').length, 0);
  assert.throws(() => store.enqueue(run.id, task()), /awaiting_user_review/);
  db.close();
});

for (const hook of ['applyChanges', 'beforeCommit']) for (const limit of ['run', 'batch', 'lease']) test(`${hook} crossing ${limit} expiry rolls back completion`, () => {
  const { store, db } = fixture();
  const batch = limit === 'batch' ? store.createBatch({ requestKey: 'fence', candidates: [{ topicId: 1, inputHash: 'revision-1', startContract: {} }] }) : null;
  const run = batch ? store.startNextCandidate(batch.id) : store.createRun({ topicId: 1, requestKey: 'fence', inputHash: 'revision-1' });
  const job = store.claim(store.enqueue(run.id, task(1)).id);
  const clock = Date.now;
  try {
    assert.throws(() => store.complete(job, { successors: [task(2)], [hook]() { Date.now = () => limit === 'lease' ? job.lease_expires_ms : run.deadline_ms; } }), limit === 'lease' ? /lease_lost/ : /budget_exhausted/);
  } finally { Date.now = clock; }
  assert.equal(store.jobs(run.id).length, 1);
  assert.equal(store.artifacts(run.id).length, 0);
  assert.notEqual(store.jobs(run.id)[0].status, 'completed');
  if (limit !== 'lease') {
    assert.equal(store.getRun(run.id).terminal_reason, 'budget_exhausted');
    if (batch) assert.equal(store.getBatch(batch.id).terminal_reason, 'budget_exhausted');
  }
  db.close();
});

for (const hook of ['validatePublished', 'beforeCommit']) for (const limit of ['run', 'batch', 'lease']) test(`runner restores primary after ${hook} crosses ${limit}`, async () => {
  const { store, db, root } = fixture();
  const batch = limit === 'batch' ? store.createBatch({ requestKey: 'promotion', candidates: [{ topicId: 1, inputHash: 'revision-1', startContract: {} }] }) : null;
  const run = batch ? store.startNextCandidate(batch.id) : store.createRun({ topicId: 1, requestKey: 'promotion', inputHash: 'revision-1' });
  const job = store.claim(store.enqueue(run.id, task(1)).id);
  const primary = path.join(root, 'primary.png'), staged = path.join(root, 'staged.png');
  writeFileSync(primary, 'original'); writeFileSync(staged, 'replacement');
  const clock = Date.now;
  let committed = false;
  try {
    const result = await new PipelineRunner(store, { artifactRoot: root }).execute(job, async () => ({
      artifacts: [{ path: staged, clip: 1, kind: 'clean', quality: 'pass', freshness: 'current', inputHash: 'revision-1' }],
      successors: [task(2)],
      promotion: { apply() { writeFileSync(primary, 'replacement'); }, rollback() { writeFileSync(primary, 'original'); }, committed() { committed = true; } },
      [hook]() { Date.now = () => limit === 'lease' ? job.lease_expires_ms : run.deadline_ms; }
    }));
    assert.equal(result.status, 'held');
    assert.match(result.error, limit === 'lease' ? /lease_lost/ : /budget_exhausted/);
  } finally { Date.now = clock; }
  assert.equal(readFileSync(primary, 'utf8'), 'original'); assert.equal(committed, false);
  assert.equal(store.artifacts(run.id).length, 0); assert.equal(store.jobs(run.id).length, 1);
  assert.notEqual(store.jobs(run.id)[0].status, 'completed');
  if (limit !== 'lease') assert.equal(store.getRun(run.id).terminal_reason, 'budget_exhausted');
  db.close();
});

test('wall deadline at completion persists budget hold without a successor', () => {
  const { store, db } = fixture();
  const run = store.createRun({ topicId: 1, lane: 'manual', requestKey: 'deadline', inputHash: 'revision-1' });
  const job = store.claim(store.enqueue(run.id, task(1)).id);
  db.prepare('UPDATE pipeline_runs SET deadline_ms=0 WHERE id=?').run(run.id);
  assert.throws(() => store.complete(job, { successors: [task(2)] }), /budget_exhausted/);
  assert.equal(store.getRun(run.id).status, 'blocked');
  assert.equal(store.getRun(run.id).terminal_reason, 'budget_exhausted');
  assert.equal(store.jobs(run.id).length, 1);
  db.close();
});

test('missing files and failed INFO are bounded holds, never successful completion', async () => {
  for (const outcome of [{ artifacts: [{ path: 'missing.png', clip: 1, kind: 'clean', quality: 'pass' }] }, { quality: 'revise', status: 'awaiting_user_review' }]) {
    const { store, db, root } = fixture();
    const run = store.createRun({ topicId: 1, lane: 'production_canary', requestKey: 'hold', inputHash: 'revision-1' });
    const job = store.claim(store.enqueue(run.id, task('batch', 'info')).id);
    await new PipelineRunner(store, { artifactRoot: root }).execute(job, async () => outcome);
    assert.equal(store.getRun(run.id).status, 'blocked');
    assert.equal(store.jobs(run.id).length, 1);
    db.close();
  }
});
