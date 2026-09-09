import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { workspaceRoot, insert, writeWav, inside, blockedCalls, spawnedWorkers } from './pipeline-stage-mock.mjs';

const scenario = process.argv[2];
assert.ok(['full-chain', 'cancel-late', 'info-user-edit'].includes(scenario));
assert.equal(process.env.DINOBOX_ENABLE_DURABLE_PIPELINE, '1');
assert.equal(process.env.DISABLE_BACKGROUND_WORKERS, '1');
assert.equal(process.env.DINOBOX_DISABLE_AUTOMATIC_REMEDIATION, '1');
assert.equal(process.env.DINOBOX_PIPELINE_PROVIDER_WORKER, '0');
assert.equal(process.env.PORT, '0');
assert.ok(process.env.DINOBOX_DATA_DIR && process.env.DINOBOX_DB_PATH);
const dataRoot = path.resolve(process.env.DINOBOX_DATA_DIR);
assert.ok(inside(path.join(workspaceRoot, 'tmp'), dataRoot));
assert.ok(inside(dataRoot, path.resolve(process.env.DINOBOX_DB_PATH)));
fs.mkdirSync(dataRoot, { recursive: true });
const mockModule = fileURLToPath(new URL('./pipeline-stage-mock.mjs', import.meta.url));
const voxModule = fileURLToPath(new URL('./pipeline-vox-mock.mjs', import.meta.url));
const providers = {
  script: { mockModule }, tts: { voxModule }, shotlist: { mockModule }, clean: { mockModule }, info: { mockModule }
};
assert.ok(!('mockModule' in providers.tts), 'TTS must go through native generateTts');

function contentSnapshot(root) {
  const result = {};
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) result[path.relative(root, filename)] = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      else assert.fail('Unexpected non-regular fixture file');
    }
  }
  walk(root);
  return result;
}
function stagedRoot(job) {
  return path.join(dataRoot, 'pipeline-staging', job.runId, String(job.id), job.leaseToken);
}

let app;
try {
  app = await import('../../server.js');
  const { server, db, pipelineStore, enqueueAiJob, claimNextAiJob, executeDurablePipelineJob } = app;
  assert.ok(server && db && pipelineStore);
  if (!server.listening) await once(server, 'listening');
  const topicId = insert(db, 'topics', {
    main_topic: 'engineering', subtopic: 'staged integration', title: 'PRIMARY TITLE',
    source_url: `https://example.invalid/staged-${scenario}`, run_lane: 'production_canary'
  });
  const reference = writeWav(path.join(dataRoot, 'audio', 'fixture-reference.wav'), 1);
  db.prepare('UPDATE voice_presets SET is_default = 0').run();
  const voiceId = insert(db, 'voice_presets', {
    name: 'staged-vox-fixture', engine: 'voxcpm', language: 'ko', is_default: 1,
    sample_audio_path: path.relative(workspaceRoot, reference).replace(/\\/gu, '/'), sample_text: '같은 목소리의 기준 문장입니다.'
  });
  for (const table of ['scripts', 'tts_runs', 'tts_segments', 'shotlists', 'shotlist_items']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE topic_id = ?`).get(topicId).count, 0);
  }
  const projectDir = path.join(dataRoot, 'projects', `topic-${topicId}`);
  const manifest = path.join(projectDir, 'manifests', 'PRIMARY_MANIFEST.md');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, 'PRIMARY MANIFEST');
  const queued = enqueueAiJob('script_generate', topicId, {
    autoConverge: true, requestKey: `staged-${scenario}`, voicePresetId: voiceId,
    ...(scenario === 'cancel-late' ? { testMode: 'late' } : {})
  });
  const runId = queued.runId;
  assert.ok(runId);
  if (scenario === 'cancel-late') {
    const job = claimNextAiJob();
    assert.equal(job.type, 'script_generate');
    const beforeTopic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
    const beforeProjects = contentSnapshot(projectDir);
    const beforeAudio = contentSnapshot(path.join(dataRoot, 'audio'));
    const root = stagedRoot(job);
    const marker = path.join(root, 'data', 'projects', `topic-${topicId}`, 'manifests', 'STAGE_READY.json');
    let settled = false;
    const execution = executeDurablePipelineJob(job, providers).then(result => { settled = true; return result; });
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(marker) && !settled && Date.now() < deadline) await delay(10);
    if (!fs.existsSync(marker)) {
      if (!settled) pipelineStore.cancel(runId);
      const result = await execution;
      assert.fail(`Staged write marker was never reached: ${JSON.stringify(result)}`);
    }
    const stagedDb = new DatabaseSync(path.join(root, 'provider.sqlite'), { readOnly: true });
    try {
      assert.equal(stagedDb.prepare('SELECT title FROM topics WHERE id = ?').get(topicId).title, 'STAGED ONLY TITLE');
      assert.equal(stagedDb.prepare('SELECT COUNT(*) AS count FROM scripts WHERE topic_id = ?').get(topicId).count, 1);
    } finally { stagedDb.close(); }
    assert.equal(fs.readFileSync(path.join(path.dirname(marker), 'PRIMARY_MANIFEST.md'), 'utf8'), 'STAGED ONLY MANIFEST');
    assert.deepEqual(db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId), beforeTopic);
    pipelineStore.cancel(runId);
    const result = await execution;
    assert.equal(result.status, 'held', JSON.stringify(result));
    assert.equal(pipelineStore.getRun(runId).status, 'canceled');
    assert.deepEqual(db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId), beforeTopic);
    assert.deepEqual(contentSnapshot(projectDir), beforeProjects);
    assert.deepEqual(contentSnapshot(path.join(dataRoot, 'audio')), beforeAudio);
    for (const table of ['scripts', 'tts_runs', 'shotlists', 'asset_reviews']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE topic_id = ?`).get(topicId).count, 0);
    assert.equal(pipelineStore.artifacts(runId).length, 0);
    assert.equal(pipelineStore.jobs(runId).length, 1);
    assert.equal(claimNextAiJob(), null);
    assert.deepEqual(blockedCalls, []);
    console.log(`PIPELINE_STAGE_RESULT ${JSON.stringify({ status: 'canceled', parentUnchanged: true, providerWroteStagedData: true })}`);
  } else {
    const stageOrder = [];
    let steps = 0;
    for (;;) {
      const job = claimNextAiJob();
      if (!job) break;
      assert.equal(job.runId, runId);
      assert.ok(++steps <= 30);
      const stage = db.prepare('SELECT pipeline_stage FROM jobs WHERE id = ?').get(job.id).pipeline_stage;
      if (stage !== 'continue') {
        stageOrder.push(stage);
        if (stage === 'tts') {
          const script = db.prepare('SELECT * FROM scripts WHERE topic_id = ?').get(topicId);
          assert.equal(script.status, 'draft');
          assert.equal(JSON.parse(script.production_script_json).length, 7);
          assert.ok(db.prepare('SELECT canary_ai_pass_at FROM topics WHERE id = ?').get(topicId).canary_ai_pass_at);
        }
      }
      const infoInputs = () => db.prepare('SELECT id, info_input_revision, info_input_json FROM shotlist_items WHERE topic_id = ? ORDER BY sort_index').all(topicId);
      const beforeInfoInputs = stage === 'info' ? infoInputs() : null;
      if (stage === 'info' && scenario === 'info-user-edit') {
        const claimed = pipelineStore.jobs(runId).find(row => row.id === job.id);
        assert.equal(claimed.status, 'running');
        const cleanJob = pipelineStore.jobs(runId).find(row => row.pipeline_stage === 'clean' && row.scope_key === '1');
        const cleanFiles = contentSnapshot(path.join(projectDir, 'clean'));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scenes/prompt`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ topicId, clipIndex: 1, type: 'info', prompt: 'User revised INFO direction', expectedInfoRevision: beforeInfoInputs[0].info_input_revision })
        });
        const edited = await response.json();
        assert.equal(response.status, 200, JSON.stringify(edited));
        assert.equal(edited.ok, true);
        const afterInfoInputs = infoInputs();
        assert.equal(afterInfoInputs[0].info_input_revision, beforeInfoInputs[0].info_input_revision + 1);
        assert.equal(JSON.parse(afterInfoInputs[0].info_input_json).userPrompt, 'User revised INFO direction');
        assert.deepEqual(afterInfoInputs.slice(1), beforeInfoInputs.slice(1));
        // Enqueue through the real server entry point to observe fresh hashes;
        // cancel these probe runs without claiming or invoking their providers.
        const freshInfo = enqueueAiJob('info_image_generate', topicId, { autoConverge: true, requestKey: 'info-revision-probe' });
        const freshClean = enqueueAiJob('clean_image_generate', topicId, { autoConverge: true, clipIndex: 1, requestKey: 'clean-revision-probe' });
        assert.notEqual(pipelineStore.jobs(freshInfo.runId)[0].input_revision, claimed.input_revision);
        assert.equal(pipelineStore.jobs(freshClean.runId)[0].input_revision, cleanJob.input_revision);
        pipelineStore.cancel(freshInfo.runId);
        pipelineStore.cancel(freshClean.runId);
        const workerCount = spawnedWorkers.length;
        const invocationCount = pipelineStore.getRun(runId).invocations_used;
        const result = await executeDurablePipelineJob(job, providers);
        assert.equal(result.status, 'held', JSON.stringify(result));
        assert.match(result.error, /input_revision_changed/u);
        assert.equal(spawnedWorkers.length, workerCount, 'Stale INFO must not launch a provider worker');
        assert.equal(pipelineStore.getRun(runId).invocations_used, invocationCount);
        assert.equal(pipelineStore.getRun(runId).status, 'blocked');
        assert.equal(pipelineStore.artifacts(runId).length, 7);
        assert.ok(pipelineStore.artifacts(runId).every(row => row.kind === 'clean'));
        assert.deepEqual(contentSnapshot(path.join(projectDir, 'clean')), cleanFiles);
        assert.ok(!fs.existsSync(stagedRoot(job)), 'Stale INFO must be rejected before staging');
        assert.equal(claimNextAiJob(), null);
        break;
      }
      const result = await executeDurablePipelineJob(job, providers);
      assert.equal(result.status, 'succeeded', JSON.stringify({ stage, result, run: pipelineStore.getRun(runId) }));
      if (stage === 'info') {
        assert.deepEqual(infoInputs(), beforeInfoInputs, 'Provider-owned INFO output must not advance user input revision');
        const output = db.prepare('SELECT info_prompt, info_spec_json FROM shotlist_items WHERE topic_id = ? AND sort_index = 1').get(topicId);
        assert.equal(output.info_prompt, 'Provider-owned INFO output prompt');
        assert.equal(JSON.parse(output.info_spec_json).mockOutputLabel, 'Provider-owned label');
      }
      if (stage !== 'continue') {
        const root = stagedRoot(job);
        assert.ok(fs.existsSync(path.join(root, 'provider.sqlite')), 'An actual isolated database must be created');
        const response = JSON.parse(fs.readFileSync(path.join(root, 'response.json'), 'utf8'));
        assert.ok(!response.error, JSON.stringify(response));
        if (stage !== 'tts') {
          const receipt = response.result.mockReceipt;
          assert.ok(receipt && receipt.pid !== process.pid);
          assert.equal(path.resolve(receipt.dataRoot), path.resolve(root, 'data'));
        }
      }
    }
    assert.deepEqual(stageOrder, ['script', 'tts', 'shotlist', ...Array(7).fill('clean'), 'info']);
    if (scenario === 'info-user-edit') {
      assert.equal(spawnedWorkers.length, 10);
      assert.deepEqual(blockedCalls, []);
      console.log(`PIPELINE_STAGE_RESULT ${JSON.stringify({ status: 'blocked', infoHashChanged: true, cleanHashUnchanged: true, staleProviderCalls: 0 })}`);
    } else {
    const run = pipelineStore.getRun(runId);
    const jobs = pipelineStore.jobs(runId);
    const artifacts = pipelineStore.artifacts(runId);
    assert.equal(run.status, 'awaiting_user_review', JSON.stringify(run));
    assert.ok(jobs.every(job => job.status === 'completed'));
    assert.equal(jobs.filter(job => job.pipeline_stage === 'clean').length, 7);
    assert.equal(jobs.filter(job => job.pipeline_stage === 'info').length, 1);
    assert.equal(artifacts.length, 14);
    for (const kind of ['clean', 'info']) {
      const rows = artifacts.filter(row => row.kind === kind);
      assert.equal(rows.length, 7);
      assert.equal(new Set(rows.map(row => row.clip_key)).size, 7);
      for (const row of rows) {
        assert.equal(row.quality, 'pass'); assert.equal(row.freshness, 'current'); assert.equal(row.user_approval, 'pending');
        assert.ok(inside(dataRoot, row.path));
        assert.equal(createHash('sha256').update(fs.readFileSync(row.path)).digest('hex'), row.content_hash);
      }
    }
    assert.equal(artifacts.filter(row => row.kind === 'info' && JSON.parse(row.metadata_json).requiredOverlay).length, 2);
    const reviews = db.prepare('SELECT * FROM asset_reviews WHERE topic_id = ?').all(topicId);
    assert.equal(reviews.length, 14);
    assert.ok(reviews.every(row => row.status === 'AI_PASS'));
    for (const row of reviews) {
      const filename = path.resolve(workspaceRoot, row.asset_path);
      assert.ok(inside(dataRoot, filename));
      assert.ok(!filename.split(path.sep).includes('pipeline-staging'), 'Published DB paths must not retain stage references');
      const png = fs.readFileSync(filename);
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), 8); assert.equal(png.readUInt32BE(20), 8);
      assert.equal(JSON.parse(fs.readFileSync(`${filename}.qc.json`, 'utf8')).passed, true);
    }
    const tts = db.prepare('SELECT * FROM tts_runs WHERE topic_id = ?').get(topicId);
    assert.equal(tts.status, 'generated'); assert.equal(tts.voice_preset_id, voiceId); assert.equal(tts.total_duration_sec, 28);
    const segments = db.prepare('SELECT * FROM tts_segments WHERE run_id = ? ORDER BY segment_index').all(tts.id);
    assert.equal(segments.length, 7);
    for (const segment of segments) {
      assert.equal(segment.status, 'generated'); assert.equal(segment.duration_sec, 4);
      const filename = path.resolve(workspaceRoot, segment.audio_path);
      assert.ok(inside(dataRoot, filename));
      assert.ok(!filename.split(path.sep).includes('pipeline-staging'));
      const bytes = fs.readFileSync(filename);
      assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
      assert.equal((bytes.length - 44) / 16000, 4);
    }
    const master = path.resolve(workspaceRoot, tts.output_path);
    assert.equal((fs.readFileSync(master).length - 44) / 16000, 28);
    const voxReceipt = JSON.parse(fs.readFileSync(path.join(path.dirname(master), 'VOX_MOCK_RECEIPT.json'), 'utf8'));
    assert.equal(voxReceipt.actualGenerateTts, true); assert.equal(voxReceipt.mockedVoxOnly, true);
    assert.notEqual(voxReceipt.pid, process.pid);
    assert.equal(voxReceipt.texts.length, 7);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_jobs').get().count, 0);
    assert.equal(JSON.parse(run.capabilities_json).h3, false);
    assert.equal(spawnedWorkers.length, 11);
    assert.deepEqual(blockedCalls, []);
    console.log(`PIPELINE_STAGE_RESULT ${JSON.stringify({ status: run.status, artifacts: artifacts.length, cleanJobs: 7, infoJobs: 1, nativeTts: true })}`);
    }
  }
} finally {
  // Only children spawned by this isolated fixture are eligible for cleanup.
  for (const worker of spawnedWorkers) {
    if (worker.exitCode === null && worker.signalCode === null) {
      const closed = once(worker, 'close');
      worker.kill();
      await closed;
    }
  }
  if (app?.server?.listening) await new Promise((resolve, reject) => {
    app.server.close(error => error ? reject(error) : resolve());
    app.server.closeIdleConnections?.();
  });
  app?.db.close();
}
