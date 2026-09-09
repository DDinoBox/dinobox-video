import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { deflateSync, inflateSync } from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import net from 'node:net';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scenario = process.argv[2];
const upstream = ['upstream-from-script', 'script-revise', 'tts-pending', 'tts-generating'].includes(scenario);
assert.ok(['convergence', 'api', 'lease', 'info-failure', 'manual', 'stale', 'optout', 'missing-provider', 'info-mutation', 'info-remove-required'].includes(scenario) || upstream);
assert.equal(process.env.DINOBOX_ENABLE_DURABLE_PIPELINE, scenario === 'optout' ? '' : '1');
const inside = (parent, target) => {
  const relative = path.relative(parent, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
assert.ok(process.env.DINOBOX_DATA_DIR, 'Explicit isolated data directory is mandatory');
assert.ok(process.env.DINOBOX_DB_PATH, 'Explicit isolated database is mandatory');
const dataDir = path.resolve(process.env.DINOBOX_DATA_DIR);
assert.ok(inside(path.join(root, 'tmp'), dataDir), 'Refusing production data directory');
assert.ok(inside(dataDir, path.resolve(process.env.DINOBOX_DB_PATH)), 'Refusing non-isolated database');
assert.equal(process.env.DISABLE_BACKGROUND_WORKERS, '1');
assert.equal(process.env.DINOBOX_DISABLE_AUTOMATIC_REMEDIATION, '1');
assert.equal(process.env.PORT, '0');
mkdirSync(dataDir, { recursive: true });

// No AI/network providers or external tools are allowed, even on accidental fallback.
const blockedCalls = [];
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => {
    blockedCalls.push(`child_process.${name}`);
    throw new Error(`External process forbidden in pipeline integration fixture: ${name}`);
  };
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host || 'localhost') || options?.path) {
    blockedCalls.push(`network:${host}`);
    throw new Error(`Non-loopback network forbidden: ${host}`);
  }
  return originalConnect.apply(this, args);
};
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
let origin;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, origin, 'Only this fixture server may receive HTTP requests');
  return originalFetch(input, { ...options, redirect: 'error' });
};

let server;
let pipelineStore;
let database;
try {
  const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8');
  // Fail closed before import when the parent implementation is not ready yet.
  assert.match(serverSource, /export\s*\{[^}]*\bserver\b[^}]*\}/su, 'server.js test exports have not been added yet');
  const imported = await import('../../server.js');
  ({ server, pipelineStore } = imported);
  database = imported.db || pipelineStore?.db;
  const { enqueueAiJob, claimNextAiJob, executeDurablePipelineJob } = imported;
  assert.ok(server && database);
  if (scenario === 'optout') assert.equal(pipelineStore, null);
  else assert.ok(pipelineStore);
  for (const fn of [enqueueAiJob, claimNextAiJob, executeDurablePipelineJob]) assert.equal(typeof fn, 'function');
  if (!server.listening) await once(server, 'listening');
  assert.ok(server.address().port > 0);
  origin = `http://127.0.0.1:${server.address().port}`;
  const db = database;

  function insert(table, values) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    assert.ok(columns.length, `Missing table ${table}`);
    for (const column of columns) {
      if (column.pk || !column.notnull || column.dflt_value !== null || column.name in values) continue;
      values[column.name] = /INT|REAL|NUM/iu.test(column.type) ? 0 : column.name.endsWith('_json') ? '{}' : 'fixture';
    }
    const keys = Object.keys(values);
    for (const key of keys) assert.ok(columns.some(column => column.name === key), `${table}.${key} missing`);
    return Number(db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(key => values[key])).lastInsertRowid);
  }

  const topicId = insert('topics', {
    main_topic: 'engineering', subtopic: 'integration fixture', title: 'Isolated mock pipeline',
    source_url: 'https://example.invalid/pipeline-fixture', run_lane: scenario === 'manual' ? 'production' : 'production_canary'
  });
  if (process.env.DINOBOX_BROWSER_FIXTURE === '1') {
    const { seedBrowserFact } = await import('./dashboard-full-browser.mjs');
    seedBrowserFact(insert, topicId);
  }
  let scriptId;
  let ttsId;
  let shotlistId;
  const voiceId = insert('voice_presets', { name: 'pipeline-server-fixture', engine: 'mock' });
  const versionMatch = serverSource.match(/const INFO_PLAN_VERSION\s*=\s*(\d+)/u);
  assert.ok(versionMatch, 'Cannot determine current INFO plan version');
  const items = Array.from({ length: 7 }, (_, offset) => ({
    index: offset + 1, sceneId: `S${offset + 1}`, fileStub: `${String(offset + 1).padStart(2, '0')}_fixture`,
    infoSpec: { requiresOverlay: offset < 2, type: offset < 2 ? 'force_arrow' : 'none' }
  }));
  function seedScript(status = 'approved') {
    scriptId = insert('scripts', {
      topic_id: topicId, status, production_script_json: JSON.stringify(items.map(item => ({ text: `Fixture line ${item.index}` }))),
      tts_text: items.map(item => `Fixture line ${item.index}`).join('\n'), notes_json: '[]', raw_json: '{"qualityStatus":"passed"}'
    });
    return scriptId;
  }
  function writeMockWav(filename, seconds) {
    // Real PCM container with silence, not synthesized narration.
    const samples = 8000 * seconds;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, wav);
    assert.equal((readFileSync(filename).length - 44) / 16000, seconds);
    return path.relative(root, filename).replace(/\\/gu, '/');
  }
  function seedTts(status = 'generated', audio = false) {
    assert.equal(db.prepare('SELECT status FROM scripts WHERE id = ?').get(scriptId).status, 'approved');
    const outputPath = audio ? writeMockWav(path.join(dataDir, 'audio', 'fixture-mix.wav'), 28) : '';
    ttsId = insert('tts_runs', {
      topic_id: topicId, script_id: scriptId, voice_preset_id: voiceId, status,
      total_duration_sec: status === 'generated' ? 28 : null, engine: 'mock', language: 'ko', output_path: outputPath
    });
    if (audio) for (const item of items) insert('tts_segments', {
      run_id: ttsId, topic_id: topicId, script_id: scriptId, segment_index: item.index,
      label: item.sceneId, text: `Fixture line ${item.index}`, duration_sec: 4, status: 'generated',
      audio_path: writeMockWav(path.join(dataDir, 'audio', `fixture-${item.index}.wav`), 4)
    });
    return ttsId;
  }
  function seedShotlist() {
    assert.equal(db.prepare('SELECT status FROM tts_runs WHERE id = ?').get(ttsId).status, 'generated');
    shotlistId = insert('shotlists', {
      topic_id: topicId, script_id: scriptId, tts_run_id: ttsId, status: 'approved',
      total_duration_sec: 28, clip_count: 7,
      raw_json: JSON.stringify({ qualityStatus: 'passed', infoPlanVersion: Number(versionMatch[1]) })
    });
    for (const item of items) insert('shotlist_items', {
      shotlist_id: shotlistId, topic_id: topicId, sort_index: item.index,
      scene_id: item.sceneId, keyframe_id: `K${item.index}`, clip_id: `C${item.index}`,
      source_segment_index: item.index, start_sec: (item.index - 1) * 4, end_sec: item.index * 4, duration_sec: 4,
      file_stub: item.fileStub, status: 'approved', info_spec_json: JSON.stringify(item.infoSpec),
      claim_refs_json: '[]', clean_prompt: `Mock fixture clip ${item.index}`
    });
    return shotlistId;
  }
  if (!upstream && scenario !== 'optout') {
    seedScript(); seedTts(); seedShotlist();
  } else {
    for (const table of ['scripts', 'tts_runs', 'shotlists']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE topic_id = ?`).get(topicId).count, 0);
  }

  async function request(method, pathname, body, expected = 200) {
    const response = await fetch(`${origin}${pathname}`, {
      method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }

  if (scenario === 'optout') {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 12').get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_runs'").get().count, 0);
    for (const table of ['jobs', 'ai_invocations']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      assert.ok(columns.length);
      assert.ok(!columns.some(column => column.name === 'run_id'));
    }
    await request('POST', '/api/pipeline/runs', { topicId, requestKey: 'disabled' }, 503);
    await request('GET', '/api/pipeline/runs/disabled', undefined, 503);
    const disabled = await request('GET', `/api/pipeline/topics/${topicId}`, undefined, 503);
    assert.equal(disabled.error, 'durable_pipeline_disabled');
    await request('POST', '/api/pipeline/runs/disabled/cancel', {}, 503);
    assert.deepEqual(blockedCalls, []);
    console.log(`PIPELINE_TEST_RESULT ${JSON.stringify({ scenario, verified: true })}`);
  } else if (scenario === 'missing-provider') {
    const queued = enqueueAiJob('clean_image_generate', topicId, { autoConverge: true, clipIndex: 1 });
    const claimed = claimNextAiJob();
    const before = pipelineStore.getRun(queued.runId);
    const result = await executeDurablePipelineJob(claimed);
    assert.equal(result.status, 'held');
    assert.equal(result.error, 'durable_real_provider_not_staged');
    assert.equal(pipelineStore.getRun(queued.runId).status, 'blocked');
    assert.equal(pipelineStore.getRun(queued.runId).invocations_used, before.invocations_used);
    assert.equal(pipelineStore.jobs(queued.runId).length, 1);
    assert.equal(pipelineStore.artifacts(queued.runId).length, 0);
    assert.equal(claimNextAiJob(), null);
    assert.deepEqual(blockedCalls, []);
    console.log(`PIPELINE_TEST_RESULT ${JSON.stringify({ scenario, verified: true })}`);
  } else if (scenario === 'lease' || scenario === 'stale') {
    const queued = enqueueAiJob('clean_image_generate', topicId, { autoConverge: true, clipIndex: 1 });
    const workerA = claimNextAiJob();
    assert.equal(workerA.id, queued.job.id);
    let calls = 0;
    const providers = { clean: async () => { calls++; throw new Error('Provider must not be invoked'); } };
    let workerB;
    if (scenario === 'lease') {
      assert.equal(pipelineStore.recover(Date.now() + 3_600_000), 1);
      workerB = claimNextAiJob();
      assert.equal(workerB.id, workerA.id);
      assert.notEqual(workerB.leaseToken, workerA.leaseToken);
    } else {
      db.prepare('UPDATE shotlist_items SET clean_prompt = ? WHERE shotlist_id = ? AND sort_index = 1').run('Changed after claim', shotlistId);
    }
    const before = pipelineStore.getRun(queued.runId);
    const result = await executeDurablePipelineJob(workerA, providers);
    assert.equal(result.status, 'held');
    assert.match(result.error, scenario === 'lease' ? /lease_lost/u : /input_revision_changed/u);
    assert.equal(calls, 0);
    const after = pipelineStore.getRun(queued.runId);
    assert.equal(after.invocations_used, before.invocations_used);
    assert.equal(after.attempts_used, before.attempts_used);
    assert.equal(pipelineStore.artifacts(queued.runId).length, 0);
    assert.equal(pipelineStore.jobs(queued.runId).length, 1);
    if (workerB) {
      const current = pipelineStore.jobs(queued.runId)[0];
      assert.equal(current.status, 'running');
      assert.equal(current.lease_token, workerB.leaseToken);
      pipelineStore.cancel(queued.runId);
    } else {
      assert.equal(after.status, 'blocked');
    }
    assert.equal(claimNextAiJob(), null);
    assert.deepEqual(blockedCalls, []);
    console.log(`PIPELINE_TEST_RESULT ${JSON.stringify({ scenario, verified: true, providerCalls: calls, error: result.error })}`);
  } else if (scenario === 'api') {
    const body = { topicId, requestKey: 'api-idempotency-fixture' };
    const first = await request('POST', '/api/pipeline/runs', body, 202);
    const duplicate = await request('POST', '/api/pipeline/runs', body);
    assert.equal(duplicate.run.id, first.run.id);
    assert.equal(first.jobs.length, 1);
    assert.deepEqual(duplicate.jobs.map(job => job.id), first.jobs.map(job => job.id));
    const route = `/api/pipeline/runs/${encodeURIComponent(first.run.id)}`;
    const fetched = await request('GET', route);
    assert.equal(fetched.run.id, first.run.id);
    assert.equal(fetched.jobs.length, 1);
    assert.equal(fetched.artifacts.length, 0);
    const canceled = await request('POST', `${route}/cancel`, {});
    const canceledAgain = await request('POST', `${route}/cancel`, {});
    assert.equal(canceled.run.status, 'canceled');
    assert.equal(canceledAgain.run.status, 'canceled');
    assert.equal(canceledAgain.run.revision, canceled.run.revision);
    assert.equal(canceledAgain.jobs.length, 1);
    assert.ok(canceledAgain.jobs.every(job => job.status === 'canceled'));
    const afterCancel = await request('POST', '/api/pipeline/runs', body);
    assert.equal(afterCancel.run.id, first.run.id);
    assert.equal(afterCancel.run.status, 'canceled');
    assert.equal(afterCancel.jobs.length, 1);
    assert.equal(claimNextAiJob(), null);
    assert.deepEqual(blockedCalls, []);
    const { verifyDashboardApi } = await import('./pipeline-dashboard-api.mjs');
    await verifyDashboardApi({ request, topicId, pipelineStore, db, imported, dataDir, insert });
    assert.deepEqual(blockedCalls, []);
    console.log(`PIPELINE_TEST_RESULT ${JSON.stringify({ status: canceledAgain.run.status, jobs: canceledAgain.jobs.length, artifacts: canceledAgain.artifacts.length })}`);
  } else {
    // PNGs and QC are deterministic mocks, not actual renderer/AI quality evidence.
    function png(index, kind) {
      const crc32 = buffer => {
        let crc = 0xffffffff;
        for (const byte of buffer) {
          crc ^= byte;
          for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        return (crc ^ 0xffffffff) >>> 0;
      };
      const chunk = (name, bytes) => {
        const type = Buffer.from(name);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
        return Buffer.concat([length, type, bytes, crc]);
      };
      const header = Buffer.alloc(13);
      header.writeUInt32BE(8, 0);
      header.writeUInt32BE(8, 4);
      header[8] = 8;
      header[9] = 6;
      const scanlines = Buffer.alloc(8 * (1 + 8 * 4));
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const offset = y * 33 + 1 + x * 4;
        scanlines.set([index * 25, kind === 'info' ? 180 : 30, x * 25, 255], offset);
      }
      const compressed = deflateSync(scanlines);
      assert.deepEqual(inflateSync(compressed), scanlines);
      return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
    }
    function asset(item, kind) {
      const absolute = path.join(dataDir, 'projects', `topic-${topicId}`, kind, `${item.fileStub}_${kind.toUpperCase()}.png`);
      mkdirSync(path.dirname(absolute), { recursive: true });
      const bytes = png(item.index, kind);
      writeFileSync(absolute, bytes);
      const passed = !(scenario === 'info-failure' && kind === 'info');
      const autoQc = { passed, shotlistId, independentSemantic: { passed }, mock: true };
      writeFileSync(`${absolute}.qc.json`, JSON.stringify(autoQc));
      const relative = path.relative(root, absolute).replace(/\\/gu, '/');
      insert('asset_reviews', {
        topic_id: topicId, clip_index: item.index, asset_type: kind, asset_path: relative,
        status: 'AI_PASS', note: 'Mock provider QC, not human approval', auto_qc_json: JSON.stringify(autoQc)
      });
      return { topicId, clipIndex: item.index, sceneId: item.sceneId, outputPath: relative, size: bytes.length, autoQc, reused: false };
    }
    const calls = { clean: [], info: 0 };
    const upstreamCalls = [];
    const providers = {
      script: async (payload) => {
        assert.equal(payload.topicId, topicId);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scripts WHERE topic_id = ?').get(topicId).count, 0);
        seedScript('draft');
        upstreamCalls.push('script');
        const quality = scenario === 'script-revise' ? 'revise' : 'pass';
        if (quality === 'pass') db.prepare("UPDATE scripts SET status = 'approved' WHERE id = ?").run(scriptId);
        return { execution: 'succeeded', quality, script: { id: scriptId, status: quality === 'pass' ? 'approved' : 'draft' }, mock: true };
      },
      tts: async (payload) => {
        assert.equal(payload.topicId, topicId);
        assert.deepEqual(upstreamCalls, ['script']);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shotlists WHERE topic_id = ?').get(topicId).count, 0);
        upstreamCalls.push('tts');
        const pending = scenario === 'tts-pending' || scenario === 'tts-generating';
        const status = pending ? scenario.slice(4) : 'generated';
        seedTts(status, !pending);
        return { execution: pending ? status : 'succeeded', quality: 'pass', status, ttsRun: { id: ttsId, status, totalDurationSec: pending ? 0 : 28 }, mock: true };
      },
      shotlist: async (payload) => {
        assert.equal(payload.topicId, topicId);
        assert.deepEqual(upstreamCalls, ['script', 'tts']);
        const segments = db.prepare('SELECT * FROM tts_segments WHERE run_id = ? ORDER BY segment_index').all(ttsId);
        assert.equal(segments.length, 7);
        assert.ok(segments.every(segment => segment.status === 'generated' && segment.duration_sec === 4));
        assert.equal(segments.reduce((sum, segment) => sum + segment.duration_sec, 0), 28);
        for (const segment of segments) assert.equal((readFileSync(path.resolve(root, segment.audio_path)).length - 44) / 16000, 4);
        seedShotlist();
        upstreamCalls.push('shotlist');
        return { execution: 'succeeded', quality: 'pass', shotlist: { id: shotlistId, status: 'approved', clipCount: 7, raw: { qualityStatus: 'passed' } }, mock: true };
      },
      clean: async (payload, context) => {
        if (upstream) assert.deepEqual(upstreamCalls, ['script', 'tts', 'shotlist']);
        assert.equal(payload.topicId, topicId);
        assert.ok(context.signal instanceof AbortSignal);
        const item = items.find(entry => entry.index === Number(payload.clipIndex));
        assert.ok(item, `CLEAN must receive the claimed clipIndex: ${JSON.stringify(payload)}`);
        calls.clean.push(item.index);
        return { ...asset(item, 'clean'), followUpClipIndexes: payload.followUpClipIndexes || [] };
      },
      info: async (payload, context) => {
        assert.equal(payload.topicId, topicId);
        assert.ok(context.signal instanceof AbortSignal);
        assert.equal(calls.clean.length, 7, 'INFO must wait for all CLEAN jobs');
        calls.info++;
        if (['info-mutation', 'info-remove-required'].includes(scenario)) {
          const initial = context.inputSnapshot?.providerContext?.initialShotlistItems;
          assert.equal(initial?.length, 7, 'INFO receives the original immutable shotlist snapshot');
          assert.equal(initial.filter(item => item.infoSpec?.requiresOverlay).length, 2);
          const first = initial.find(item => item.sortIndex === 1);
          const changedSpec = scenario === 'info-remove-required'
            ? { requiresOverlay: false, type: 'none' }
            : { ...first.infoSpec, label: 'Provider-generated INFO annotation' };
          db.prepare('UPDATE shotlist_items SET info_spec_json = ?, info_prompt = ? WHERE shotlist_id = ? AND sort_index = 1')
            .run(JSON.stringify(changedSpec), 'Provider-generated INFO prompt', shotlistId);
          assert.equal(first.infoSpec.requiresOverlay, true, 'Provider context must retain the original requirement');
          assert.notEqual(first.infoSpec.type, 'none');
        }
        const rendered = items.map(item => asset(item, 'info'));
        return { path: '', url: '', specPath: '', specUrl: '', renderedCount: rendered.length, archivedFailedInfoArtifacts: [], rendered };
      }
    };
    let runId;
    if (upstream) {
      const created = await request('POST', '/api/pipeline/runs', { topicId, requestKey: `upstream-${scenario}` }, 202);
      runId = created.run.id;
      assert.equal(created.jobs.length, 1);
      assert.equal(pipelineStore.jobs(runId)[0].pipeline_stage, 'continue');
    } else {
      const initialIds = [];
      // Exercise the legacy entry point: distinct clips, same autoConverge request key.
      for (const item of items) {
        const payload = { autoConverge: true, clipIndex: item.index, scope: 'full' };
        const first = enqueueAiJob('clean_image_generate', topicId, payload);
        const duplicate = enqueueAiJob('clean_image_generate', topicId, payload);
        runId ||= first.runId;
        assert.equal(first.runId, runId);
        assert.equal(duplicate.job.id, first.job.id);
        assert.equal(duplicate.reused, true);
        initialIds.push(first.job.id);
      }
      assert.equal(new Set(initialIds).size, 7);
      assert.equal(pipelineStore.jobs(runId).length, 7);
      assert.deepEqual(pipelineStore.jobs(runId).map(job => job.scope_key).sort(), ['1', '2', '3', '4', '5', '6', '7']);
    }
    let executed = 0;
    for (;;) {
      const job = claimNextAiJob();
      if (!job) break;
      assert.equal(job.runId, runId);
      assert.ok(['script_generate', 'tts_generate', 'shotlist_generate', 'clean_image_generate', 'info_image_generate', 'pipeline_continue'].includes(job.type), `Unexpected provider job: ${job.type}`);
      assert.ok(++executed <= 30, 'Pipeline did not reach a bounded terminal state');
      const result = await executeDurablePipelineJob(job, providers);
      const expectedHold = (['info-failure', 'info-remove-required'].includes(scenario) && job.type === 'info_image_generate')
        || (scenario === 'script-revise' && job.type === 'script_generate')
        || (['tts-pending', 'tts-generating'].includes(scenario) && job.type === 'tts_generate');
      if (expectedHold) {
        assert.equal(result.status, 'held', JSON.stringify(result));
        assert.ok(result.error, 'Hold must have a reason');
        assert.doesNotMatch(result.error, /input_revision_changed/u, 'Provider-owned outputs must not cause false staleness');
        if (scenario === 'info-failure') assert.match(result.error, /artifact_quality|quality/u);
        if (scenario === 'info-remove-required') assert.match(result.error, /required.*info|overlay|required/u);
        const held = pipelineStore.getRun(runId);
        const heldJobs = pipelineStore.jobs(runId);
        assert.equal(held.status, 'blocked');
        // Repeated scheduler polls must not create retries or consume more budget.
        for (let poll = 0; poll < 5; poll++) assert.equal(claimNextAiJob(), null);
        assert.equal(pipelineStore.getRun(runId).invocations_used, held.invocations_used);
        assert.equal(pipelineStore.getRun(runId).attempts_used, held.attempts_used);
        assert.deepEqual(pipelineStore.jobs(runId), heldJobs);
      } else {
        assert.equal(result.status, 'succeeded', JSON.stringify({ job, result, run: pipelineStore.getRun(runId) }));
      }
    }
    const run = pipelineStore.getRun(runId);
    const jobs = pipelineStore.jobs(runId);
    const artifacts = pipelineStore.artifacts(runId);
    const upstreamFailure = upstream && scenario !== 'upstream-from-script';
    const infoFailure = ['info-failure', 'info-remove-required'].includes(scenario);
    const expectedCleanCount = upstreamFailure ? 0 : 7;
    const expectedInfoCalls = upstreamFailure || scenario === 'manual' ? 0 : 1;
    const successfulInfo = ['convergence', 'upstream-from-script', 'info-mutation'].includes(scenario);
    assert.equal(run.status, upstreamFailure || infoFailure ? 'blocked' : 'awaiting_user_review', JSON.stringify(run));
    assert.deepEqual(calls.clean.sort((a, b) => a - b), upstreamFailure ? [] : [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(calls.info, expectedInfoCalls);
    assert.equal(run.invocations_used, expectedCleanCount + expectedInfoCalls + upstreamCalls.length);
    assert.equal(jobs.filter(job => job.pipeline_stage === 'clean').length, expectedCleanCount);
    assert.equal(jobs.filter(job => job.pipeline_stage === 'info').length, expectedInfoCalls);
    if (successfulInfo) assert.ok(jobs.every(job => job.status === 'completed'));
    if (upstream) {
      const expectedStages = scenario === 'script-revise' ? ['script'] : upstreamFailure ? ['script', 'tts'] : ['script', 'tts', 'shotlist'];
      assert.deepEqual(upstreamCalls, expectedStages);
      for (const stage of ['script', 'tts', 'shotlist']) assert.equal(jobs.filter(job => job.pipeline_stage === stage).length, expectedStages.includes(stage) ? 1 : 0);
      if (upstreamFailure) {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shotlists WHERE topic_id = ?').get(topicId).count, 0);
        const failedStage = expectedStages.at(-1);
        assert.equal(jobs.filter(job => job.pipeline_stage === 'continue' && JSON.parse(job.payload_json).previousStage === failedStage).length, 0);
      } else {
        assert.equal(db.prepare('SELECT status FROM scripts WHERE id = ?').get(scriptId).status, 'approved');
        assert.equal(db.prepare('SELECT status FROM tts_runs WHERE id = ?').get(ttsId).status, 'generated');
        assert.equal(db.prepare('SELECT status FROM shotlists WHERE id = ?').get(shotlistId).status, 'approved');
        const fetched = await request('GET', `/api/pipeline/runs/${runId}`);
        assert.equal(fetched.run.status, 'awaiting_user_review');
        assert.equal(fetched.artifacts.length, 14);
      }
    }
    if (scenario === 'manual') {
      assert.equal(run.lane, 'manual');
      assert.equal(run.terminal_reason, 'clean_quality_or_approval_unresolved');
    }
    if (infoFailure) {
      const infoJob = jobs.find(job => job.pipeline_stage === 'info');
      assert.ok(['failed', 'reconcile_required'].includes(infoJob.status));
      assert.equal(infoJob.attempt, 1);
      assert.equal(jobs.filter(job => job.pipeline_stage === 'continue' && JSON.parse(job.payload_json).previousStage === 'info').length, 0);
    }
    assert.equal(artifacts.length, successfulInfo ? 14 : expectedCleanCount);
    for (const kind of ['clean', 'info']) {
      const expected = kind === 'clean' ? expectedCleanCount : successfulInfo ? 7 : 0;
      assert.equal(artifacts.filter(row => row.kind === kind).length, expected);
      assert.equal(new Set(artifacts.filter(row => row.kind === kind).map(row => row.clip_key)).size, expected);
    }
    assert.ok(artifacts.every(row => row.quality === 'pass' && row.freshness === 'current' && row.user_approval === 'pending'));
    assert.equal(items.filter(item => item.infoSpec.requiresOverlay && item.infoSpec.type !== 'none').length, 2);
    const requiredInfo = artifacts.filter(row => row.kind === 'info' && JSON.parse(row.metadata_json).requiredOverlay);
    assert.equal(requiredInfo.length, successfulInfo ? 2 : 0);
    const reviews = db.prepare('SELECT status FROM asset_reviews WHERE topic_id = ?').all(topicId);
    assert.equal(reviews.length, expectedCleanCount + expectedInfoCalls * 7);
    assert.ok(reviews.every(row => row.status === 'AI_PASS'));
    if (!upstreamFailure) {
      const publicAssets = await request('GET', `/api/assets?topicId=${topicId}`);
      assert.equal(publicAssets.clean.length, 7);
      assert.equal(publicAssets.info.length, expectedInfoCalls * 7);
      assert.equal(publicAssets.infoPlanStale, false);
      assert.ok([...publicAssets.clean, ...publicAssets.info].every(row => row.status === 'AI_PASS'));
      if (scenario === 'info-failure') assert.ok(publicAssets.info.every(row => row.autoQc.passed === false));
      if (scenario === 'info-mutation') {
        const updated = db.prepare('SELECT info_spec_json, info_prompt FROM shotlist_items WHERE shotlist_id = ? AND sort_index = 1').get(shotlistId);
        assert.equal(JSON.parse(updated.info_spec_json).label, 'Provider-generated INFO annotation');
        assert.equal(updated.info_prompt, 'Provider-generated INFO prompt');
      }
    }
    const dashboardStatus = await request('GET', `/api/pipeline/topics/${topicId}`);
    assert.equal(dashboardStatus.execution, run.status);
    assert.equal(dashboardStatus.userApproval, 'pending');
    if (successfulInfo) {
      assert.equal(dashboardStatus.quality, 'pass');
      assert.equal(dashboardStatus.inputFreshness, 'current');
    } else assert.notEqual(dashboardStatus.quality, 'pass');
    if (scenario === 'convergence') {
      const { verifyDashboardProjection } = await import('./pipeline-dashboard-projection.mjs');
      await verifyDashboardProjection({ request, topicId, runId: run.id, pipelineStore, db, imported });
      const { verifyDashboardApproval } = await import('./pipeline-dashboard-approval.mjs');
      await verifyDashboardApproval({ request, topicId, runId: run.id, pipelineStore, db, root });
    }
    assert.equal(JSON.parse(run.capabilities_json).h3, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_jobs').get().count, 0);
    assert.ok(jobs.every(job => !/h3|video/iu.test(job.type)));
    assert.equal(claimNextAiJob(), null);
    assert.deepEqual(blockedCalls, []);
    if (process.env.DINOBOX_BROWSER_FIXTURE === '1') {
      const { serveBrowserFixture } = await import('./dashboard-full-browser.mjs');
      await serveBrowserFixture({ app: imported, topicId, runId: run.id, insert, dataDir, origin });
      assert.deepEqual(blockedCalls, []);
    }
    console.log(`PIPELINE_TEST_RESULT ${JSON.stringify({ scenario, verified: true, status: run.status, cleanJobs: calls.clean.length, infoJobs: calls.info, artifacts: artifacts.length, aiPass: reviews.length, videoJobs: 0, mockProviders: true })}`);
  }
} finally {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
      if (process.env.DINOBOX_BROWSER_FIXTURE === '1') server.closeAllConnections?.();
    });
  }
  database?.close();
}
