import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { recordInfoUserInput } from '../../lib/pipeline-info-input.js';
import { concatenatePcmWavs } from '../../lib/pipeline-tts-repair.js';

// Do not import pipeline-stage-mock: it installs a different process guard and
// disables this native scenario's allowlisted real image QC subprocess.
function writeWav(filename, seconds) {
  const bytes = Buffer.alloc(44 + Math.round(8000 * seconds) * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  fs.writeFileSync(filename, bytes); // Synthetic silence, not generated speech.
}

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function verifyTimingReuse({ app, runId, topicId, root, dataRoot }) {
  const { verifyInfoClipReuse } = await import('./pipeline-info-clip-reuse.mjs');
  await verifyInfoClipReuse({ app, runId, topicId, root, dataRoot });
  const { db, pipelineStore, getPipelineVisualReuseState, pipelineInputRevision, revisePipelineTiming } = app;
  const artifacts = pipelineStore.artifacts(runId);
  const beforeJobs = pipelineStore.jobs(runId);
  const beforeRun = pipelineStore.getRun(runId);
  const beforeFiles = artifacts.map(row => ({ path: row.path, hash: digest(row.path), source: JSON.parse(row.metadata_json).sourcePath, manifestHash: digest(path.join(path.dirname(row.path), 'manifest.json')) }));
  const approved = artifacts.find(row => row.kind === 'clean');
  app.reviewAsset({ topicId, clipIndex: Number(approved.clip_key), assetType: 'clean', assetPath: path.relative(root, JSON.parse(approved.metadata_json).sourcePath), status: 'OK', note: 'Synthetic test user approval' });
  const reviewsBefore = db.prepare('SELECT * FROM asset_reviews WHERE topic_id = ? ORDER BY id').all(topicId);
  assert.ok(reviewsBefore.some(row => row.status === 'OK'));
  assert.deepEqual(await getPipelineVisualReuseState(runId), { clean: true, info: true });
  const originalJob = beforeJobs.find(job => job.id === approved.job_id);
  for (const payload of [{}, { inputSnapshot: { ...JSON.parse(originalJob.payload_json).inputSnapshot, brief: 'tampered' } }]) {
    db.prepare('UPDATE jobs SET payload_json=? WHERE id=?').run(JSON.stringify(payload), originalJob.id);
    try {
      assert.equal((await getPipelineVisualReuseState(runId)).clean, false);
      assert.equal(app.pipelineTopicStatus(topicId).evidence.find(row => row.id === approved.id).freshness, 'stale');
    } finally { db.prepare('UPDATE jobs SET payload_json=? WHERE id=?').run(originalJob.payload_json, originalJob.id); }
  }
  const publicationPath = path.join(path.dirname(approved.path), 'manifest.json');
  const publicationBytes = fs.readFileSync(publicationPath);
  for (const header of ['runId', 'jobId', 'leaseToken']) {
    try {
      const manifest = JSON.parse(publicationBytes); manifest[header] = 'forged'; fs.writeFileSync(publicationPath, JSON.stringify(manifest));
      assert.equal((await getPipelineVisualReuseState(runId)).clean, false);
      const projected = app.pipelineTopicStatus(topicId).evidence.find(row => row.id === approved.id);
      assert.equal(projected.freshness, 'stale'); assert.equal(projected.userApproval, 'pending');
    } finally { fs.writeFileSync(publicationPath, publicationBytes); }
  }
  assert.deepEqual(await getPipelineVisualReuseState(runId), { clean: true, info: true });
  const generationBefore = Object.fromEntries(['clean', 'info', 'shotlist'].map(kind => [kind, pipelineInputRevision(topicId, kind)]));
  const tts = db.prepare('SELECT * FROM tts_runs WHERE topic_id = ? ORDER BY id DESC LIMIT 1').get(topicId);
  const segments = db.prepare('SELECT * FROM tts_segments WHERE run_id = ? ORDER BY segment_index').all(tts.id);
  const master = path.join(dataRoot, 'timing-corrected-master.wav');
  const durations = segments.map(row => Number(row.duration_sec) - 0.05);
  // Synthetic Vox boundary supplies corrected PCM, not unmeasured DB durations.
  const segmentPaths = segments.map((row, index) => { const file = path.resolve(root, row.audio_path); writeWav(file, durations[index]); return file; });
  concatenatePcmWavs(segmentPaths, master, { gapSec: 0 });
  await assert.rejects(revisePipelineTiming({ topicId, expectedTtsRevision: generationBefore.shotlist, durations: durations.map(value => value - 0.01), outputPath: master }), /timing_measurement_mismatch/u);
  const change = await revisePipelineTiming({ topicId, expectedTtsRevision: generationBefore.shotlist, durations, outputPath: master });
  assert.deepEqual(change.invalidated, ['shotlist_timing', 'captions', 'edit']);
  for (const kind of ['clean', 'info', 'shotlist']) assert.notEqual(pipelineInputRevision(topicId, kind), generationBefore[kind], 'Full generation lease guard still changes');
  assert.deepEqual(await getPipelineVisualReuseState(runId), { clean: true, info: true });
  const shotlist = db.prepare('SELECT * FROM shotlists WHERE topic_id = ? ORDER BY id DESC LIMIT 1').get(topicId);
  assert.equal(shotlist.status, 'stale');
  assert.deepEqual(JSON.parse(shotlist.raw_json).timingRevision, { version: 1, previous: generationBefore.shotlist, current: change.timingRevision, shotlist: 'stale', captions: 'stale', edit: 'stale' });
  const items = db.prepare('SELECT * FROM shotlist_items WHERE shotlist_id = ? ORDER BY sort_index').all(shotlist.id);
  let start = 0;
  items.forEach((item, index) => { assert.equal(item.start_sec, start); start += durations[index]; assert.equal(item.end_sec, start); assert.equal(item.duration_sec, durations[index]); });
  assert.equal(shotlist.total_duration_sec, start);
  assert.ok(fs.readFileSync(path.resolve(root, shotlist.manifest_path), 'utf8').includes(change.timingRevision));
  assert.deepEqual(pipelineStore.artifacts(runId), artifacts, 'Never relabel original bindings, approval, QC or required INFO');
  assert.deepEqual(db.prepare('SELECT * FROM asset_reviews WHERE topic_id = ? ORDER BY id').all(topicId), reviewsBefore, 'User approval remains bound to exactly the same bytes');
  for (const file of beforeFiles) { assert.equal(digest(file.path), file.hash); assert.equal(digest(file.source), file.hash); assert.equal(digest(path.join(path.dirname(file.path), 'manifest.json')), file.manifestHash); }
  const { verifyPipelineRun } = await import('../../scripts/verify-pipeline-run.mjs');
  const { hashPipelineInputSnapshot } = await import('../../lib/pipeline-contract.js');
  const verificationContract = JSON.parse(fs.readFileSync(path.join(dataRoot, 'native-run-contract.json'), 'utf8'));
  verificationContract.currentInputSnapshots = Object.fromEntries(['clean', 'info'].map(kind => [kind, app.pipelineInputSnapshot(topicId, kind)]));
  verificationContract.stageInputHashes = Object.fromEntries(['clean', 'info'].map(kind => [kind, pipelineInputRevision(topicId, kind)]));
  const verify = contract => verifyPipelineRun({ root, dbPath: process.env.DINOBOX_DB_PATH, contract });
  const verified = verify(verificationContract);
  assert.equal(verified.machinePassed, true, JSON.stringify(verified.findings.concat(verified.errors)));
  assert.equal(verified.reusedVisualArtifacts.length, 14);
  assert.equal(verified.visualReviewRequired, true);
  fs.writeFileSync(path.join(dataRoot, 'native-timing-verification.json'), JSON.stringify(verified, null, 2));
  const missingSnapshots = { ...verificationContract, currentInputSnapshots: undefined };
  assert.equal(verify(missingSnapshots).findings.filter(f => f.code === 'artifact_revision_mismatch').length, 14);
  const changedNarration = structuredClone(verificationContract);
  changedNarration.currentInputSnapshots.clean.script.productionScript[0].narration += ' 다른 의미';
  changedNarration.stageInputHashes.clean = hashPipelineInputSnapshot(changedNarration.currentInputSnapshots.clean);
  assert.equal(verify(changedNarration).findings.filter(f => f.code === 'artifact_revision_mismatch').length, 7);
  const bindingManifestPath = path.join(path.dirname(artifacts[0].path), 'manifest.json');
  const bindingManifestBytes = fs.readFileSync(bindingManifestPath);
  try {
    const changed = JSON.parse(bindingManifestBytes);
    delete changed.artifacts[0].visualBinding;
    fs.writeFileSync(bindingManifestPath, JSON.stringify(changed));
    assert.ok(verify(verificationContract).findings.some(f => f.code === 'artifact_manifest_mismatch'));
  } finally { fs.writeFileSync(bindingManifestPath, bindingManifestBytes); }
  const checkMutation = async (name, mutate, expected) => {
    db.exec('SAVEPOINT timing_counterexample');
    try { mutate(); assert.deepEqual(await getPipelineVisualReuseState(runId), expected, name); }
    finally { db.exec('ROLLBACK TO timing_counterexample; RELEASE timing_counterexample'); }
  };
  await checkMutation('narration', () => db.prepare("UPDATE tts_segments SET text = text || ' changed narration' WHERE id = ?").run(segments[0].id), { clean: false, info: false });
  await checkMutation('physical claim', () => db.prepare("UPDATE shotlist_items SET physical_state = physical_state || ' different state' WHERE id = ?").run(items[0].id), { clean: false, info: false });
  await checkMutation('CLEAN prompt', () => db.prepare("UPDATE shotlist_items SET clean_prompt = clean_prompt || ' changed framing' WHERE id = ?").run(items[0].id), { clean: false, info: false });
  await checkMutation('reference crop', () => db.prepare("UPDATE official_visual_assets SET verification_json = json_set(verification_json, '$.panelCrop', json('[0.15,0.15,0.5,0.5]')) WHERE topic_id = ?").run(topicId), { clean: false, info: false });
  await checkMutation('INFO user input', () => recordInfoUserInput(db, { itemId: items[0].id, topicId, prompt: 'Explicit changed INFO label' }), { clean: true, info: false });
  await checkMutation('legacy binding requires explicit reconcile', () => db.prepare("UPDATE pipeline_artifacts SET metadata_json = json_remove(metadata_json, '$.visualBinding') WHERE run_id = ?").run(runId), { clean: false, info: false });
  const firstSource = beforeFiles[0].source;
  const sourceBytes = fs.readFileSync(firstSource);
  try { fs.appendFileSync(firstSource, 'tamper'); assert.equal((await getPipelineVisualReuseState(runId)).clean, false); }
  finally { fs.writeFileSync(firstSource, sourceBytes); }
  const qcPath = `${firstSource}.qc.json`, qcBytes = fs.readFileSync(qcPath);
  try { fs.writeFileSync(qcPath, JSON.stringify({ ...JSON.parse(qcBytes), passed: false })); assert.equal((await getPipelineVisualReuseState(runId)).clean, false); }
  finally { fs.writeFileSync(qcPath, qcBytes); }
  assert.deepEqual(await getPipelineVisualReuseState(runId), { clean: true, info: true });
  assert.deepEqual(pipelineStore.jobs(runId), beforeJobs);
  assert.deepEqual(pipelineStore.getRun(runId), beforeRun);
  const evidence = { syntheticInputs: true, initialClean: 7, initialInfo: 7, additionalCleanProviders: 0, additionalInfoProviders: 0, invocationsBefore: beforeRun.invocations_used, invocationsAfter: pipelineStore.getRun(runId).invocations_used, change, artifacts: beforeFiles, counterexamples: ['narration', 'physical claim', 'CLEAN prompt', 'reference crop', 'INFO user input', 'legacy', 'file tamper', 'QC failure'], state: await getPipelineVisualReuseState(runId) };
  fs.writeFileSync(path.join(dataRoot, 'native-timing-reuse.json'), JSON.stringify(evidence, null, 2));
  return evidence;
}
