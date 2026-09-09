import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export async function verifyDashboardApproval({ request, topicId, runId, pipelineStore, db, root }) {
  const before = pipelineStore.getRun(runId);
  const jobs = pipelineStore.jobs(runId);
  const reviewsBefore = db.prepare('SELECT * FROM asset_reviews WHERE topic_id=?').all(topicId);
  try {
    const artifacts = pipelineStore.artifacts(runId);
    for (const kind of ['clean', 'info']) {
      const row = artifacts.find(row => row.kind === kind);
      const file = JSON.parse(row.metadata_json).sourcePath || row.path;
      const original = readFileSync(file);
      const body = { topicId, clipIndex: Number(row.clip_key), assetType: kind, assetPath: path.relative(root, file), status: 'OK', previousAssetHash: row.content_hash };
      const finalRoute = `/api/assets/${kind}/finalize`;
      try {
        writeFileSync(file, Buffer.from('mutated approval fixture'));
        const stale = await request('GET', `/api/assets?topicId=${topicId}`);
        assert.equal(stale[kind][0].status, 'REPLACE_CANDIDATE');
        assert.equal(stale[kind][0].autoQc.passed, false);
        await request('POST', '/api/assets/review', body, 500);
        await request('POST', finalRoute, { topicId }, 500);
        writeFileSync(file, original);
        renameSync(file, `${file}.approval-fixture-hidden`);
        const missing = await request('GET', `/api/assets?topicId=${topicId}`);
        assert.equal(missing[kind].length, 6);
        await request('POST', '/api/assets/review', body, 500);
        await request('POST', finalRoute, { topicId }, 500);
      } finally { writeFileSync(file, original); }
      await request('POST', '/api/assets/review', { ...body, previousAssetHash: 'stale-browser-hash' }, 500);
      const approved = await request('POST', '/api/assets/review', body);
      assert.equal(approved.provenance.assetHashAfter, row.content_hash);
      assert.equal(approved.provenance.assetHashBefore, row.content_hash);
      const partial = await request('GET', `/api/pipeline/topics/${topicId}`);
      assert.equal(partial.evidence.find(item => item.id === row.id).userApproval, 'approved');
      assert.equal(partial.userApproval, 'pending');
      // Prior human OK cannot survive changed bytes in the displayed asset list.
      try {
        writeFileSync(file, Buffer.from('mutated after approval'));
        const staleApproval = await request('GET', `/api/assets?topicId=${topicId}`);
        assert.equal(staleApproval[kind][0].status, 'REPLACE_CANDIDATE');
        assert.equal((await request('GET', `/api/pipeline/topics/${topicId}`)).evidence.find(item => item.id === row.id).userApproval, 'pending');
      } finally { writeFileSync(file, original); }
    }
    await request('POST', '/api/assets/clean/finalize', { topicId });
    await request('POST', '/api/assets/info/finalize', { topicId });
    const status = await request('GET', `/api/pipeline/topics/${topicId}`);
    assert.equal(status.quality, 'pass');
    assert.equal(status.userApproval, 'approved');
    assert.equal(status.inputFreshness, 'current');
    assert.equal(status.nextAction.owner, 'operator');
    assert.equal(status.nextAction.message, '최종 승인 기록됨. 영상은 별도 승인 작업이며 자동 실행하지 않습니다.');
    assert.equal(status.execution, 'awaiting_user_review', 'review does not invent a terminal run transition');
    assert.deepEqual(pipelineStore.jobs(runId), jobs, 'review never queues H3/video/provider work');
    assert.deepEqual(pipelineStore.getRun(runId), before);
  } finally {
    // This fixture owns the isolated DB; restore reviews without wrapping HTTP finalizers' own transactions.
    db.prepare('DELETE FROM asset_reviews WHERE topic_id=?').run(topicId);
    for (const row of reviewsBefore) {
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO asset_reviews (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
    }
  }
}
