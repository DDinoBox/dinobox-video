import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hashPipelineVisualSnapshot } from '../../lib/pipeline-contract.js';

// Real HTTP projection on the existing isolated, provider-mocked convergence fixture.
export async function verifyDashboardProjection({ request, topicId, runId, pipelineStore, db, imported }) {
  const route = `/api/pipeline/topics/${topicId}`;
  const artifacts = pipelineStore.artifacts(runId);
  const get = () => request('GET', route);
  const mutateDb = async (mutate, verify) => {
    db.exec('SAVEPOINT dashboard_projection');
    try { mutate(); await verify(); }
    finally { db.exec('ROLLBACK TO dashboard_projection; RELEASE dashboard_projection'); }
  };
  const changeQc = async (kind, transform, expected) => {
    const row = artifacts.find(row => row.kind === kind);
    const file = `${JSON.parse(row.metadata_json).sourcePath || row.path}.qc.json`;
    const original = readFileSync(file);
    try {
      writeFileSync(file, JSON.stringify(transform(JSON.parse(original))));
      const status = await get();
      assert.equal(status.evidence.find(entry => entry.id === row.id).quality, expected);
      if (expected !== 'pass') assert.notEqual(status.quality, 'pass');
    } finally { writeFileSync(file, original); }
  };
  for (const kind of ['clean', 'info']) {
    await changeQc(kind, qc => ({ ...qc, passed: true, independentSemantic: { passed: false }, semantic: { passed: true } }), 'not_passed');
  }
  await changeQc('clean', qc => { delete qc.independentSemantic; return { ...qc, passed: true, semantic: { passed: true } }; }, 'unknown');
  await changeQc('info', qc => { delete qc.independentSemantic; return { ...qc, passed: true, semantic: { passed: true } }; }, 'pass');

  const generation = Object.fromEntries(['clean', 'info'].map(kind => [kind, imported.pipelineInputRevision(topicId, kind)]));
  await mutateDb(() => db.prepare('UPDATE tts_runs SET total_duration_sec=total_duration_sec+0.25 WHERE topic_id=?').run(topicId), async () => {
    for (const kind of ['clean', 'info']) assert.notEqual(imported.pipelineInputRevision(topicId, kind), generation[kind]);
    let status = await get();
    assert.equal(status.evidence.length, 14);
    assert.ok(status.evidence.every(row => row.freshness === 'current'));
    assert.equal(status.inputFreshness, 'current', 'complete timing-only reuse ignores historical generation hashes');
    assert.equal(status.quality, 'pass');
    const first = artifacts[0];
    await mutateDb(() => db.prepare("UPDATE jobs SET payload_json=json_remove(payload_json,'$.inputSnapshot') WHERE id=?").run(first.job_id), async () => {
      const missing = await get();
      assert.equal(missing.evidence.find(row => row.id === first.id).freshness, 'stale');
      assert.equal(missing.inputFreshness, 'stale');
      assert.notEqual(missing.quality, 'pass');
    });
    await mutateDb(() => db.prepare('UPDATE pipeline_artifacts SET job_id=? WHERE id=?').run(pipelineStore.jobs(runId).find(job => job.pipeline_stage === 'continue').id, first.id), async () => {
      assert.equal((await get()).evidence.find(row => row.id === first.id).freshness, 'stale');
    });
    await mutateDb(() => db.prepare("UPDATE jobs SET payload_json=json_set(payload_json,'$.inputSnapshot',json(?)) WHERE id=?")
      .run(JSON.stringify(imported.pipelineInputSnapshot(topicId, first.kind)), first.job_id), async () => {
      assert.equal((await get()).evidence.find(row => row.id === first.id).freshness, 'stale', 'replacement origin snapshot must match the original generation hash');
    });
    const manifestFile = path.join(path.dirname(first.path), 'manifest.json');
    const originalManifest = readFileSync(manifestFile);
    try {
      const manifest = JSON.parse(originalManifest);
      manifest.artifacts = manifest.artifacts.filter(row => row.path !== first.path);
      writeFileSync(manifestFile, JSON.stringify(manifest));
      assert.equal((await get()).evidence.find(row => row.id === first.id).freshness, 'stale', 'reuse requires matching publication');
    } finally { writeFileSync(manifestFile, originalManifest); }
    await mutateDb(() => db.prepare('DELETE FROM pipeline_artifacts WHERE id=?').run(first.id), async () => {
      const incomplete = await get();
      assert.equal(incomplete.evidence.length, 13);
      assert.ok(incomplete.evidence.every(row => row.freshness === 'current'));
      assert.equal(incomplete.inputFreshness, 'stale', 'incomplete set retains generation revision guard');
    });
    await mutateDb(() => db.prepare("INSERT INTO jobs(type,topic_id,status,run_id,pipeline_stage,input_revision,payload_json) VALUES ('info_image_generate',?,'queued',?,'info',?,'{}')").run(topicId, runId, generation.info), async () => {
      const pending = await get();
      assert.ok(pending.evidence.every(row => row.freshness === 'current'));
      assert.equal(pending.inputFreshness, 'stale', 'complete artifacts cannot override an unfinished stale job');
    });
    await mutateDb(() => db.prepare("UPDATE shotlist_items SET physical_state=physical_state || ' changed claim' WHERE topic_id=?").run(topicId), async () => {
      const metadata = JSON.parse(first.metadata_json);
      metadata.visualBinding.fingerprint = hashPipelineVisualSnapshot(imported.pipelineInputSnapshot(topicId, first.kind));
      const manifest = JSON.parse(originalManifest);
      manifest.artifacts = manifest.artifacts.map(row => row.path === first.path ? metadata : row);
      try {
        db.prepare('UPDATE pipeline_artifacts SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), first.id);
        writeFileSync(manifestFile, JSON.stringify(manifest));
        const forged = await get();
        assert.equal(forged.evidence.find(row => row.id === first.id).freshness, 'stale', 'forged current fingerprint and manifest cannot bypass original job snapshot');
        assert.notEqual(forged.quality, 'pass');
      } finally { writeFileSync(manifestFile, originalManifest); }
    });
    status = await get();
    assert.equal(status.inputFreshness, 'current');
    assert.equal(status.quality, 'pass');
  });
  assert.equal((await get()).inputFreshness, 'current');
}
