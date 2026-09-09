import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { PipelineRunner } from '../../lib/pipeline-runner.js';

export async function verifyDashboardApi({ request, topicId, pipelineStore, db, imported, dataDir, insert }) {
  const topicRoute = `/api/pipeline/topics/${topicId}`;
  let status = await request('GET', topicRoute);
  assert.equal(status.execution, 'canceled');
  assert.equal(status.quality, 'unknown');
  assert.equal(status.userApproval, 'pending');
  assert.equal(status.canStart, true);
  await request('GET', '/api/pipeline/topics/999999999', undefined, 404);
  await request('POST', '/api/pipeline/runs', { topicId, requestKey: 'invalid', lane: 'video' }, 400);
  const body = { topicId, requestKey: 'dashboard-active' };
  const { run } = await request('POST', '/api/pipeline/runs', body, 202);
  const concurrent = await Promise.all([request('POST', '/api/pipeline/runs', body), request('POST', '/api/pipeline/runs', body)]);
  assert.ok(concurrent.every(value => value.run.id === run.id));
  await request('POST', '/api/pipeline/runs', { topicId, requestKey: 'different-key' }, 409);
  await request('POST', '/api/pipeline/runs', { ...body, lane: 'manual' }, 409);
  status = await request('GET', topicRoute);
  assert.equal(status.execution, 'queued');
  assert.equal(status.inputFreshness, 'current');
  assert.equal(status.canStart, false);
  assert.equal(status.nextAction.owner, 'worker');
  assert.equal(status.budgets.run.callsUsed, 0);
  assert.equal(status.budgets.run.attemptsUsed, 0);
  assert.ok(status.budgets.run.deadlineMs > Date.now());
  const file = path.join(dataDir, 'dashboard-evidence.png');
  writeFileSync(file, 'local fixture, not visual evidence');
  const contentHash = createHash('sha256').update('local fixture, not visual evidence').digest('hex');
  const job = pipelineStore.jobs(run.id)[0];
  db.prepare(`INSERT INTO pipeline_artifacts(run_id,job_id,clip_key,kind,input_hash,path,content_hash,quality,freshness,user_approval)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(run.id, job.id, '1', 'clean', imported.pipelineInputRevision(topicId, 'clean'), file, contentHash, 'pass', 'current', 'approved');
  status = await request('GET', topicRoute);
  assert.equal(status.evidence[0].freshness, 'stale', 'a continue job and bare ledger row cannot establish original CLEAN evidence');
  assert.equal(status.evidence[0].quality, 'unknown', 'ledger pass without publication/QC is not a pass');
  assert.equal(status.evidence[0].userApproval, 'pending', 'ledger approval is not human review provenance');
  insert('asset_reviews', { topic_id: topicId, clip_index: 1, asset_type: 'clean', asset_path: file, status: 'OK',
    auto_qc_json: JSON.stringify({ manualProvenance: { assetHashAfter: contentHash } }) });
  status = await request('GET', topicRoute);
  assert.equal(status.evidence[0].userApproval, 'pending', 'human provenance cannot upgrade missing original/publication evidence');

  // Synthetic decoded PNG and QC receipt exercise projection, not visual acceptance.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  writeFileSync(file, png);
  writeFileSync(`${file}.qc.json`, JSON.stringify({ passed: true, independentSemantic: { passed: true } }));
  const cleanHash = createHash('sha256').update(png).digest('hex');
  const cleanJob = pipelineStore.claim(pipelineStore.enqueue(run.id, {
    stage: 'clean', scope: '1', type: 'clean_image_generate',
    inputHash: imported.pipelineInputRevision(topicId, 'clean'),
    payload: { inputSnapshot: imported.pipelineInputSnapshot(topicId, 'clean') }
  }).id);
  const result = await new PipelineRunner(pipelineStore, { artifactRoot: dataDir }).execute(cleanJob, async () => ({
    artifacts: [{ path: file, clip: '1', kind: 'clean', inputHash: cleanJob.input_revision,
      contentHash: cleanHash, quality: 'pass', freshness: 'current', userApproval: 'pending' }]
  }));
  assert.equal(result.status, 'succeeded', result.error);
  status = await request('GET', topicRoute);
  assert.equal(status.evidence[0].freshness, 'current');
  assert.equal(status.evidence[0].quality, 'pass');
  assert.equal(status.evidence[0].userApproval, 'pending', 'old approval does not apply to newly published bytes');
  db.prepare("UPDATE asset_reviews SET status='OK',auto_qc_json=? WHERE topic_id=? AND clip_index=1 AND asset_type='clean' AND asset_path=?")
    .run(JSON.stringify({ manualProvenance: { assetHashAfter: cleanHash } }), topicId, file);
  status = await request('GET', topicRoute);
  assert.equal(status.evidence[0].userApproval, 'approved');
  assert.equal(status.userApproval, 'pending', 'one approved artifact is not a complete approved set');
  writeFileSync(file, 'mutated bytes');
  status = await request('GET', topicRoute);
  assert.equal(status.evidence[0].userApproval, 'pending', 'changed bytes invalidate prior human approval');
  assert.equal(status.inputFreshness, 'stale');
  assert.equal(status.quality, 'unknown');
  db.prepare("UPDATE pipeline_runs SET status='awaiting_user_review' WHERE id=?").run(run.id);
  status = await request('GET', topicRoute);
  assert.equal(status.execution, 'awaiting_user_review');
  assert.equal(status.nextAction.owner, 'user');
  assert.equal(status.canStart, false);
  await request('POST', '/api/pipeline/runs', { topicId, requestKey: 'review-duplicate' }, 409);
  const startContract = { stage: 'script', candidatePolicy: 'ordered_existing_only', referenceFailurePolicy: 'next_candidate', requiredVisualStates: 7, minimumRequiredInfoOverlays: 2 };
  await request('POST', '/api/pipeline/batches', { existingTopicIds: [topicId], requestKey: 'batch-conflict', startContract }, 409);
  await request('POST', `/api/pipeline/runs/${run.id}/cancel`, {});
  const nextTopicId = insert('topics', { main_topic: 'engineering', subtopic: 'fixture', title: 'Queued batch candidate', source_url: 'https://example.invalid/queued' });
  const batch = pipelineStore.createBatch({ requestKey: 'dashboard-batch', candidates: [topicId, nextTopicId].map(id => ({ topicId: id, inputHash: imported.pipelineInputRevision(id, 'script'), startContract })), maxInvocations: 9, maxAttempts: 11 });
  const batchRun = pipelineStore.startNextCandidate(batch.id);
  pipelineStore.enqueue(batchRun.id, { stage: 'continue', type: 'pipeline_continue', inputHash: batchRun.input_hash });
  db.prepare('UPDATE pipeline_batches SET invocations_used=3,attempts_used=4 WHERE id=?').run(batch.id);
  status = await request('GET', topicRoute);
  assert.equal(status.batch.id, batch.id);
  assert.deepEqual(status.cancelScope, { type: 'batch', id: batch.id });
  assert.equal(status.budgets.batch.callsUsed, 3);
  assert.equal(status.budgets.batch.attemptsUsed, 4);
  const queued = await request('GET', `/api/pipeline/topics/${nextTopicId}`);
  assert.equal(queued.run, null);
  assert.equal(queued.batch.id, batch.id);
  assert.equal(queued.canStart, false);
  await request('POST', '/api/pipeline/runs', { topicId: nextTopicId, requestKey: 'queued-candidate-duplicate' }, 409);
  await request('POST', `/api/pipeline/batches/${batch.id}/cancel`, {});
  await request('POST', `/api/pipeline/batches/${batch.id}/cancel`, {});
  assert.equal(pipelineStore.getRun(batchRun.id).status, 'canceled');
  assert.equal(pipelineStore.getBatch(batch.id).status, 'canceled');
  assert.ok(pipelineStore.jobs(batchRun.id).every(value => value.status === 'canceled'));
  assert.throws(() => pipelineStore.startNextCandidate(batch.id), /batch_not_active/);
  assert.equal((await request('GET', `/api/pipeline/topics/${nextTopicId}`)).canStart, true);
}
