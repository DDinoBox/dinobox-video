import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { root, python, references, externalKey, states, claims, initialPng, denied } from './pipeline-native-boundary.mjs';
import { verifyPipelineRun } from '../../scripts/verify-pipeline-run.mjs';

assert.equal(process.env.DINOBOX_ENABLE_DURABLE_PIPELINE, '1');
assert.equal(process.env.DISABLE_BACKGROUND_WORKERS, '1');
assert.equal(process.env.DINOBOX_DISABLE_AUTOMATIC_REMEDIATION, '1');
assert.equal(process.env.DINOBOX_PIPELINE_PROVIDER_WORKER, '0');
assert.equal(process.env.PORT, '0');
assert.ok(process.env.DINOBOX_DATA_DIR && process.env.DINOBOX_DB_PATH);
const dataRoot = path.resolve(process.env.DINOBOX_DATA_DIR);
assert.ok(dataRoot.startsWith(path.join(root, 'tmp') + path.sep));
assert.ok(path.resolve(process.env.DINOBOX_DB_PATH).startsWith(dataRoot + path.sep));
assert.ok(fs.existsSync(python));
fs.mkdirSync(dataRoot, { recursive: true });
const boundaryModule = fileURLToPath(new URL('./pipeline-native-boundary.mjs', import.meta.url));
const providers = Object.fromEntries(['script', 'tts', 'shotlist', 'clean', 'info'].map(stage => [stage, { boundaryModule }]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = filename => path.relative(root, filename).replace(/\\/gu, '/');

let app;
try {
  app = await import('../../server.js');
  const { db, server, pipelineStore, enqueueAiJob, claimNextAiJob, executeDurablePipelineJob } = app;
  if (!server.listening) await once(server, 'listening');
  function seed(table, values) {
    // Only upstream inputs can be seeded. No scripts/TTS/shotlists/assets shortcut.
    assert.ok(['topics', 'fact_checks', 'production_briefs', 'voice_presets', 'official_visual_assets'].includes(table));
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    for (const column of columns) {
      if (column.pk || !column.notnull || column.dflt_value !== null || column.name in values) continue;
      values[column.name] = /INT|REAL|NUM/iu.test(column.type) ? 0 : column.name.endsWith('_json') ? '{}' : 'Synthetic native fixture';
    }
    const keys = Object.keys(values);
    for (const key of keys) assert.ok(columns.some(column => column.name === key), `${table}.${key}`);
    return Number(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => values[key])).lastInsertRowid);
  }
  const topicId = seed('topics', {
    title: 'Synthetic native generator integration — NOT real NASA imagery', hook: '접힌 막은 어떻게 펼까요?',
    main_topic: 'engineering', subtopic: 'space systems', source_title: 'Synthetic contract fixture',
    source_url: 'https://example.invalid/native-generator-fixture', external_key: externalKey, run_lane: 'production_canary',
    candidate_json: JSON.stringify({ syntheticInputs: true, productionRequirements: { minimumVisualStates: 7, targetVisualStateRange: [7, 7], minimumRequiredInfoOverlays: 2 } })
  });
  const projectDir = path.join(dataRoot, 'projects', `topic-${topicId}`);
  const referenceDir = path.join(projectDir, 'references');
  fs.mkdirSync(referenceDir, { recursive: true });
  const visualEvidence = references.map((ref, index) => {
    const page = ref.referencePage || 0;
    const key = createHash('sha256').update(`${ref.mediaUrl || ref.sourceUrl}#${page}`).digest('hex').slice(0, 16);
    const filename = path.join(referenceDir, `${ref.id.replace(/[^0-9a-z_-]/giu, '_')}-${key}.png`);
    const bytes = initialPng(index + 1);
    assert.ok(bytes.length > 50000);
    fs.writeFileSync(filename, bytes);
    seed('official_visual_assets', {
      topic_id: topicId, reference_id: ref.id, state_hint: ref.stateHint, reference_type: ref.referenceType,
      source_url: ref.sourceUrl, media_url: ref.mediaUrl, final_url: ref.mediaUrl, content_type: 'image/png', byte_size: bytes.length,
      sha256: hash(bytes), cached_path: relative(filename), license_url: ref.licenseUrl, license_note: 'Synthetic pixels for contract testing, not fetched official media',
      status: 'verified', verification_json: JSON.stringify({ mediaKind: 'image', referencePage: page, panelCrop: ref.panelCrop || null, focusBounds: ref.focusBounds || null, syntheticFixture: true,
        contentBinding: { version: 1, sourcePath: relative(filename), cachedPath: relative(filename), sourceHash: hash(bytes), contentHash: hash(bytes), referencePage: page, transform: 'normalize-reference-image-v1' },
        metadata: /^(clean-crop-|clean-repair-)/u.test(process.env.DINOBOX_NATIVE_TEST_SCENARIO || '') ? {
          requiredBounds: process.env.DINOBOX_NATIVE_TEST_SCENARIO === 'clean-crop-happy' || process.env.DINOBOX_NATIVE_TEST_SCENARIO?.startsWith('clean-repair-') ? [0.8, 0.2, 0.15, 0.5] : [0, 0, 1, 1]
        } : {} })
    });
    return {
      id: ref.id, state: ref.stateHint, claimRefs: states[index].claimRefs, referenceType: ref.referenceType,
      referenceSourceUrl: ref.sourceUrl, referenceMediaUrl: ref.mediaUrl, referencePage: page,
      referenceDescription: 'Synthetic local test image bound to an existing allowlist identifier; not official photography.',
      panelCrop: ref.panelCrop || null, focusBounds: ref.focusBounds || null,
      visibleFacts: [states[index].physicalState, ...states[index].requiredVisibleElements], syntheticFixture: true
    };
  });
  const factId = seed('fact_checks', {
    topic_id: topicId, status: 'PASS', confidence: 100, core_claim: 'Synthetic seven-state deployment fixture', claims_json: JSON.stringify(claims),
    verified_facts_json: JSON.stringify(claims.map(claim => claim.statement)), unresolved_json: '[]', simplifications_json: '[]',
    sources_json: JSON.stringify(references.map(ref => ({ title: 'Synthetic reference contract', url: ref.sourceUrl }))),
    raw_json: JSON.stringify({ visualEvidence, syntheticFixture: true })
  });
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const version = Number(source.match(/const PRODUCTION_BRIEF_CONTRACT_VERSION\s*=\s*(\d+)/u)?.[1]);
  assert.ok(version);
  seed('production_briefs', {
    topic_id: topicId, fact_check_id: factId, status: 'ready', domain_key: 'engineering', narrative_type: 'process_breakdown',
    scope_statement: 'Synthetic native renderer integration only', core_question: '접힌 막은 어떻게 펼까요?',
    causal_chain_json: JSON.stringify(claims.map(claim => ({ role: 'mechanism', statement: claim.statement, claimRefs: [claim.id] }))),
    visual_states_json: JSON.stringify(states), forbidden_inferences_json: '[]',
    length_guidance_json: JSON.stringify({ strategy: 'evidence_bound_native_clips', recommendedMinSec: 20, recommendedMaxSec: 28 }),
    quality_json: '{"passed":true,"issues":[]}', raw_json: JSON.stringify({ contractVersion: version, syntheticFixture: true })
  });
  const voiceReference = path.join(dataRoot, 'audio', 'reference.wav');
  fs.mkdirSync(path.dirname(voiceReference), { recursive: true });
  const wav = Buffer.alloc(16044); wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40); fs.writeFileSync(voiceReference, wav);
  db.prepare('UPDATE voice_presets SET is_default = 0').run();
  const voiceId = seed('voice_presets', { name: 'native-boundary-voice', engine: 'voxcpm', language: 'ko', is_default: 1,
    sample_audio_path: relative(voiceReference), sample_text: '합성 입력입니다.' });
  for (const table of ['scripts', 'tts_runs', 'tts_segments', 'shotlists', 'shotlist_items', 'asset_reviews']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE topic_id = ?`).get(topicId).count, 0);
  nativeScenario: {
  const scenario = process.env.DINOBOX_NATIVE_TEST_SCENARIO || 'happy';
  const optOut = scenario === 'repair-review-only' || scenario === 'repair-limit-zero';
  const payload = { autoConverge: true, voicePresetId: voiceId, requestKey: 'native-lowest-boundary' };
  if (scenario === 'repair-review-only') payload.reviewOnly = true;
  if (scenario === 'repair-limit-zero') payload.scriptRepairLimit = 0;
  if (scenario === 'info-repair-review-only') payload.reviewOnly = true;
  if (scenario === 'info-repair-limit-zero') payload.infoRepairLimit = 0;
  if (scenario === 'tts-overrun') payload.ttsRepairLimit = 0;
  if (scenario === 'shotlist-repair-review-only') payload.reviewOnly = true;
  if (scenario === 'shotlist-repair-limit-zero') payload.shotlistRepairLimit = 0;
  // Exercise the real HTTP request listener without relaxing the network-deny boundary.
  async function api(method, url, body) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json' } });
    return new Promise((resolve, reject) => {
      let status;
      const res = { writeHead(code) { status = code; }, end(bytes) {
        try { resolve({ status, body: JSON.parse(String(bytes)) }); } catch (error) { reject(error); }
      } };
      server.emit('request', req, res);
    });
  }
  function missingReferenceTopic() {
    const original = db.prepare('SELECT * FROM topics WHERE id=?').get(topicId);
    delete original.id;
    original.external_key = '';
    // Match startup normalization so an unrelated candidate is not rewritten in staged workers.
    original.review_status = 'unverified';
    original.source_url += `?missing-reference=${db.prepare('SELECT COUNT(*) AS count FROM topics').get().count}`;
    const id = seed('topics', original);
    const fact = db.prepare('SELECT * FROM fact_checks WHERE id=?').get(factId);
    delete fact.id;
    const clonedFactId = seed('fact_checks', { ...fact, topic_id: id });
    const brief = db.prepare('SELECT * FROM production_briefs WHERE topic_id=?').get(topicId);
    delete brief.id;
    seed('production_briefs', { ...brief, topic_id: id, fact_check_id: clonedFactId });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM official_visual_assets WHERE topic_id=?').get(id).count, 0);
    return id;
  }
  let batchId;
  let runId;
  async function batchEvidence() {
    const response = await api('GET', `/api/pipeline/batches/${batchId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { batch, runs } = response.body;
    assert.equal(batch.id, batchId);
    assert.deepEqual(runs.map(run => run.id), pipelineStore.batchRuns(batchId).map(run => run.id));
    assert.equal(batch.invocations_used, runs.reduce((sum, run) => sum + run.invocations_used, 0));
    assert.equal(batch.attempts_used, runs.reduce((sum, run) => sum + run.attempts_used, 0));
    const attempts = runs.flatMap(run => db.prepare('SELECT * FROM pipeline_attempts WHERE run_id=? ORDER BY id').all(run.id));
    let reservedRemaining = 0;
    for (const run of runs) {
      assert.equal(run.deadline_ms, batch.deadline_ms);
      const runAttempts = attempts.filter(attempt => attempt.run_id === run.id);
      assert.equal(run.attempts_used, runAttempts.length);
      assert.equal(run.invocations_used, runAttempts.reduce((sum, attempt) => sum + attempt.invocation_count, 0));
      assert.ok(pipelineStore.jobs(run.id).every(job => !['queued', 'running'].includes(job.status)));
    }
    for (const attempt of attempts) {
      assert.ok(!['claimed', 'running'].includes(attempt.status));
      const journalPath = path.join(dataRoot, 'pipeline-staging', attempt.run_id, String(attempt.job_id), attempt.lease_token, 'provider-invocations.jsonl');
      if (!fs.existsSync(journalPath)) continue; // In-process error descriptor has no worker journal.
      const journal = readEvents(journalPath);
      assert.equal(journal.filter(event => event.type === 'reserve_invocation').length, attempt.invocation_count);
      const reservations = new Map();
      for (const event of journal) {
        if (event.type === 'invocation_result') assert.equal(reservations.get(event.requestId), 'reserved');
        reservations.set(event.requestId, event.status);
      }
      reservedRemaining += [...reservations.values()].filter(status => status === 'reserved').length;
    }
    assert.equal(reservedRemaining, 0);
    assert.deepEqual(denied, []);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_jobs').get().count, 0);
    const evidence = { batchId, batch, runs, attempts, reservedRemaining, evidenceRoot: dataRoot };
    fs.writeFileSync(path.join(dataRoot, 'native-batch-ledger.json'), JSON.stringify(evidence, null, 2));
    return evidence;
  }
  if (scenario.startsWith('batch-')) {
    let impossibleId;
    if (scenario === 'batch-crop-next') {
      impossibleId = missingReferenceTopic();
      for (const asset of db.prepare('SELECT * FROM official_visual_assets WHERE topic_id=?').all(topicId)) {
        delete asset.id;
        seed('official_visual_assets', { ...asset, topic_id: impossibleId });
      }
      const impossibleStates = structuredClone(states);
      // Synthetic declared crop, not a guessed rectangle in any real canary.
      impossibleStates[0].panelCrop = [0, 0, 1, 0.5];
      db.prepare('UPDATE production_briefs SET visual_states_json=? WHERE topic_id=?').run(JSON.stringify(impossibleStates), impossibleId);
    }
    const existingTopicIds = scenario === 'batch-happy' ? [missingReferenceTopic(), topicId]
      : scenario === 'batch-crop-next' ? [impossibleId, topicId]
      : scenario === 'batch-all-invalid' ? [missingReferenceTopic(), missingReferenceTopic()]
        : [topicId, missingReferenceTopic()];
    const body = { requestKey: `native-${scenario}`, existingTopicIds, startContract: {
      stage: 'script', candidatePolicy: 'ordered_existing_only', referenceFailurePolicy: 'next_candidate', requiredVisualStates: 7, minimumRequiredInfoOverlays: 2
    }, ...(scenario === 'batch-budget' ? { maxInvocations: 2 } : {}) };
    const created = await api('POST', '/api/pipeline/batches', body);
    assert.equal(created.status, 202, JSON.stringify(created.body));
    batchId = created.body.batch.id;
    assert.equal(created.body.runs.length, 1);
    runId = created.body.runs[0].id;
    const duplicate = await api('POST', '/api/pipeline/batches', body);
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.batch.id, batchId);
    assert.deepEqual(duplicate.body.runs, created.body.runs);
    const reordered = await api('POST', '/api/pipeline/batches', { ...body, startContract: Object.fromEntries(Object.entries(body.startContract).reverse()) });
    assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
    assert.equal((await api('POST', '/api/pipeline/batches', { ...body, existingTopicIds: [...existingTopicIds].reverse() })).status, 409);
    assert.equal((await api('POST', '/api/pipeline/batches', { ...body, maxAttempts: 79 })).status, 409);
    assert.equal((await api('POST', '/api/pipeline/batches', { ...body, requestKey: 'too-many', existingTopicIds: [...existingTopicIds, ...existingTopicIds] })).status, 400);
    assert.equal((await api('POST', '/api/pipeline/runs', { requestKey: 'cannot-reset-batch', topicId, batchId })).status, 400);
    if (['batch-happy', 'batch-crop-next'].includes(scenario)) {
      const bad = claimNextAiJob();
      assert.ok(bad);
      assert.equal(bad.runId, runId);
      assert.equal(pipelineStore.jobs(runId).find(row => row.id === bad.id).pipeline_stage, 'continue');
      await executeDurablePipelineJob(bad, providers);
      const first = pipelineStore.getRun(runId);
      assert.equal(first.status, 'blocked');
      assert.equal(first.terminal_reason, 'needs_reference');
      assert.equal(first.invocations_used, 0);
      assert.equal(pipelineStore.jobs(first.id).filter(row => row.pipeline_stage === 'script').length, 0);
      const runs = pipelineStore.batchRuns(batchId);
      assert.equal(runs.length, 2);
      runId = runs[1].id;
      assert.equal(runs[1].topic_id, topicId);
    } else {
      if (scenario === 'batch-cancel') {
        const canceled = await api('POST', `/api/pipeline/batches/${batchId}/cancel`, {});
        assert.equal(canceled.status, 200, JSON.stringify(canceled.body));
      }
      if (scenario === 'batch-stale') db.prepare('UPDATE fact_checks SET claims_json=? WHERE id=?').run(JSON.stringify(claims.map((claim, index) => index === 0 ? { ...claim, statement: `${claim.statement} changed after POST` } : claim)), factId);
      const batchProviders = scenario === 'batch-provider-error' ? { ...providers, script: async () => { throw Error('NATIVE_EXPECTED_PROVIDER_AUTH_ERROR'); } } : providers;
      let count = 0;
      for (;;) {
        const job = claimNextAiJob();
        if (!job) break;
        assert.ok(++count <= 8, 'Batch failure must be bounded');
        assert.equal(pipelineStore.getRun(job.runId).batch_id, batchId);
        await executeDurablePipelineJob(job, batchProviders);
      }
      const evidence = await batchEvidence();
      assert.equal(evidence.batch.status, scenario === 'batch-cancel' ? 'canceled' : 'blocked');
      assert.equal(evidence.runs.length, scenario === 'batch-all-invalid' ? 2 : 1, 'Only structural reference failures may replace a topic');
      if (scenario === 'batch-all-invalid') {
        assert.ok(evidence.runs.every(run => run.terminal_reason === 'needs_reference'));
        assert.equal(evidence.batch.terminal_reason, 'needs_reference');
      }
      if (scenario === 'batch-budget') {
        assert.equal(evidence.batch.invocations_used, 2);
        assert.match(evidence.batch.terminal_reason, /budget/u);
      } else if (scenario === 'batch-provider-error') assert.match(evidence.batch.terminal_reason, /provider|auth/iu);
      else assert.equal(evidence.batch.invocations_used, 0);
      if (scenario === 'batch-crop-tool') {
        assert.match(evidence.batch.terminal_reason, /ENOENT/iu);
        assert.equal(evidence.runs.length, 1);
        assert.equal(pipelineStore.jobs(evidence.runs[0].id).filter(row => row.pipeline_stage === 'script').length, 0);
      }
      if (scenario === 'batch-stale') assert.match(evidence.batch.terminal_reason, /stale|input/iu);
      if (scenario === 'batch-cancel') assert.equal(evidence.batch.attempts_used, 0);
      for (const run of evidence.runs) {
        const jobs = pipelineStore.jobs(run.id);
        assert.equal(jobs.filter(row => ['tts', 'shotlist', 'clean', 'info'].includes(row.pipeline_stage)).length, 0);
        if (['batch-all-invalid', 'batch-cancel', 'batch-stale'].includes(scenario)) assert.equal(jobs.filter(row => row.pipeline_stage === 'script').length, 0);
        assert.equal(pipelineStore.artifacts(run.id).length, 0);
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scripts').get().count, 0);
      for (let retry = 0; retry < 3; retry++) assert.equal(claimNextAiJob(), null);
      console.log(`PIPELINE_NATIVE_RESULT ${JSON.stringify({ scenario, status: evidence.batch.status, syntheticInputs: true, primaryUnchanged: true, noDownstream: true, reservedRemaining: 0, ...evidence })}`);
      break nativeScenario;
    }
  } else runId = enqueueAiJob('script_generate', topicId, payload).runId;
  const failureStage = scenario.startsWith('upstream-repair-') && scenario !== 'upstream-repair-happy' ? 'shotlist' : scenario.startsWith('info-repair-') && scenario !== 'info-repair-happy' ? 'info' : scenario.startsWith('shotlist-repair-') && scenario !== 'shotlist-repair-happy' ? 'shotlist' : { 'script-reject': 'script', 'tts-overrun': 'tts', 'shotlist-reject': 'shotlist', 'clean-reject': 'clean', 'clean-crop-hold': 'script', 'info-reject': 'info', 'budget-two': 'script', 'reviewer-drain': 'script', 'repair-wrong-row': 'script', 'repair-number-change': 'script', 'repair-condition-change': 'script', 'repair-second-review-fail': 'script', 'repair-review-only': 'script', 'repair-limit-zero': 'script', 'tts-repair-second-overrun': 'tts', 'tts-repair-wrong-row': 'tts', 'tts-repair-review-reject': 'tts', 'tts-repair-cancel': 'tts' }[scenario];
  if (!batchId) db.prepare('UPDATE pipeline_runs SET max_invocations = ? WHERE id = ?').run(scenario === 'budget-two' ? 2 : 60, runId);
  function files(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory() ? files(filename) : [[filename, hash(fs.readFileSync(filename))]];
    }).sort((a, b) => a[0].localeCompare(b[0]));
  }
  function snapshot() {
    const tables = ['topics', 'scripts', 'tts_runs', 'tts_segments', 'shotlists', 'shotlist_items', 'asset_reviews', 'quality_runs', 'quality_decisions', 'topic_attempts'];
    return { rows: tables.map(table => [table, db.prepare(`SELECT * FROM ${table} WHERE ${table === 'topics' ? 'id' : 'topic_id'} = ? ORDER BY id`).all(topicId)]), files: [...files(projectDir), ...files(path.join(dataRoot, 'audio'))], artifacts: pipelineStore.artifacts(runId) };
  }
  function readEvents(filename) {
    return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  }
  function verifyRepair(attemptRoot) {
    const events = readEvents(path.join(attemptRoot, 'native-boundary-events.jsonl'));
    const begins = events.filter(event => event.type === 'begin');
    assert.equal(begins.filter(event => /^script-\d+$/u.test(event.taskName)).length, 1, 'Generate original script once');
    assert.equal(begins.filter(event => event.taskName.startsWith('script-revision-')).length, 0, 'Never regenerate entire script');
    assert.equal(begins.filter(event => event.taskName.startsWith('script-narration-patch-')).length, optOut ? 0 : 1, 'Respect explicit opt-out; otherwise exactly one local patch');
    const reviews = events.filter(event => event.type === 'review-input');
    const secondRound = ['repair-happy', 'repair-second-review-fail'].includes(scenario);
    assert.equal(reviews.length, secondRound ? 4 : 2);
    for (const role of ['evidence', 'production']) assert.equal(reviews.filter(event => event.taskName.endsWith(`-${role}`)).length, secondRound ? 2 : 1);
    const original = reviews[0].script;
    assert.equal(original.productionScript[1].narration, '첫 받침이 내려왔습니다.');
    assert.equal(original.productionScript.length, 7);
    const expected = structuredClone(original);
    expected.productionScript[1].narration = '첫 받침이 내려옵니다.';
    expected.ttsText = expected.productionScript.map(row => row.narration).join(' ');
    for (const review of reviews.slice(0, 2)) assert.equal(JSON.stringify(review.script), JSON.stringify(original));
    for (const review of reviews.slice(2)) {
      assert.equal(JSON.stringify(review.script.productionScript), JSON.stringify(expected.productionScript), 'Only row2 narration may change; every other byte, row order and reference stays');
      assert.equal(review.script.ttsText, expected.ttsText);
    }
    if (scenario === 'repair-happy') {
      const published = db.prepare('SELECT * FROM scripts WHERE topic_id = ? ORDER BY id DESC LIMIT 1').get(topicId);
      assert.ok(published);
      assert.equal(published.tts_text, expected.ttsText);
    }
  }
  function verifyTtsRepair(attemptRoot, job, beforeScript) {
    const events = readEvents(path.join(attemptRoot, 'native-boundary-events.jsonl'));
    const begins = events.filter(event => event.type === 'begin');
    assert.equal(begins.filter(event => event.taskName.startsWith('tts-narration-patch-')).length, 1);
    assert.equal(begins.filter(event => /^script-\d+$|^script-revision-|^script-narration-patch-/u.test(event.taskName)).length, 0);
    const rejectedBeforeRetry = ['tts-repair-wrong-row', 'tts-repair-review-reject'].includes(scenario);
    const voxBegins = begins.filter(event => event.taskName === 'vox');
    assert.equal(voxBegins.length, rejectedBeforeRetry ? 1 : 2);
    assert.equal(voxBegins[0].outputs.length, 7);
    if (!rejectedBeforeRetry) assert.deepEqual(voxBegins[1].outputs.map(output => output.index), [2]);
    const firstAudio = events.find(event => event.taskName === 'vox' && event.type === 'completed');
    assert.deepEqual(firstAudio.durations, [4, 5, 4, 4, 4, 4, 4]);
    const originalRows = JSON.parse(beforeScript.production_script_json);
    const expectedRows = structuredClone(originalRows);
    expectedRows[1].narration = '첫 받침이 내려옵니다.';
    const reviews = events.filter(event => event.type === 'tts-review-input');
    assert.equal(reviews.length, scenario === 'tts-repair-wrong-row' ? 0 : 2);
    for (const review of reviews) {
      assert.equal(JSON.stringify(review.script.productionScript), JSON.stringify(expectedRows));
      assert.equal(review.script.ttsText, expectedRows.map(item => item.narration).join(' '));
    }
    for (const output of firstAudio.outputs) assert.equal(hash(fs.readFileSync(output.path)), output.sha256, 'Original seven WAV files, including overrun, remain byte-identical');
    if (scenario !== 'tts-repair-happy') return;
    const script = db.prepare('SELECT * FROM scripts WHERE topic_id = ?').get(topicId);
    assert.equal(script.production_script_json, JSON.stringify(expectedRows));
    assert.equal(script.tts_text, expectedRows.map(item => item.narration).join(' '));
    const segments = db.prepare('SELECT * FROM tts_segments WHERE topic_id = ? ORDER BY segment_index').all(topicId);
    assert.equal(segments.length, 7);
    const retry = events.filter(event => event.taskName === 'vox' && event.type === 'completed')[1];
    assert.deepEqual(retry.durations, [2.5]);
    const primaryAudio = stagedPath => path.join(dataRoot, path.relative(path.join(attemptRoot, 'data'), stagedPath));
    for (let index = 0; index < 7; index++) {
      assert.equal(segments[index].text, expectedRows[index].narration);
      assert.equal(segments[index].duration_sec, index === 1 ? 2.5 : 4);
      const audioPath = path.resolve(root, segments[index].audio_path);
      const source = index === 1 ? retry.outputs[0] : firstAudio.outputs[index];
      assert.equal(hash(fs.readFileSync(audioPath)), index === 1 ? hash(fs.readFileSync(source.path)) : source.sha256);
      assert.equal(audioPath, primaryAudio(source.path), 'Only row2 audio path changes; the six original paths survive promotion');
      if (index === 1) {
        assert.notEqual(source.path, firstAudio.outputs[1].path, 'Repair retains old overrun rather than overwriting it');
        assert.equal(hash(fs.readFileSync(primaryAudio(firstAudio.outputs[1].path))), firstAudio.outputs[1].sha256);
      }
    }
    const tts = db.prepare('SELECT * FROM tts_runs WHERE topic_id = ? ORDER BY id DESC LIMIT 1').get(topicId);
    assert.equal(tts.total_duration_sec, 28);
    const master = fs.readFileSync(path.resolve(root, tts.output_path));
    assert.equal(master.toString('ascii', 0, 4), 'RIFF');
    let byteRate = 0, dataBytes = 0;
    for (let offset = 12; offset + 8 <= master.length;) {
      const kind = master.toString('ascii', offset, offset + 4), size = master.readUInt32LE(offset + 4);
      if (kind === 'fmt ') byteRate = master.readUInt32LE(offset + 16);
      if (kind === 'data') dataBytes += size;
      offset += 8 + size + size % 2;
    }
    assert.ok(byteRate > 0);
    assert.equal(dataBytes / byteRate, 28, 'Actual concatenated PCM is 6*4 + 2.5 + 6*0.25 seconds');
    const transition = JSON.parse(pipelineStore.jobs(runId).find(item => item.id === job.id).result_json).inputTransition;
    assert.equal(transition.type, 'measured_tts_narration_repair');
    assert.equal(transition.rowIndex, 2);
    assert.equal(transition.narration, expectedRows[1].narration);
    assert.equal(transition.fromRevision, job.inputRevision || pipelineStore.jobs(runId).find(item => item.id === job.id).input_revision);
    assert.ok(transition.toSnapshot && transition.beforeAudio && transition.afterAudio);
  }
  function upstreamSnapshot() {
    return {
      rows: ['scripts', 'tts_runs', 'tts_segments'].map(table => [table, db.prepare(`SELECT * FROM ${table} WHERE topic_id = ? ORDER BY id`).all(topicId)]),
      files: [...files(projectDir), ...files(path.join(dataRoot, 'audio'))],
      jobs: pipelineStore.jobs(runId).filter(item => ['script', 'tts'].includes(item.pipeline_stage))
    };
  }
  function verifyShotlistRepair(attemptRoot, row, upstream) {
    const events = readEvents(path.join(attemptRoot, 'native-boundary-events.jsonl'));
    const begins = events.filter(event => event.type === 'begin');
    const noPatch = ['shotlist-repair-review-only', 'shotlist-repair-limit-zero', 'shotlist-repair-upstream-ambiguous'].includes(scenario);
    const secondRound = ['shotlist-repair-happy', 'shotlist-repair-review-fail'].includes(scenario);
    assert.equal(begins.filter(event => event.taskName.startsWith('shotlist-part-')).length, 7, 'Generate original seven chunks once');
    assert.equal(begins.filter(event => event.taskName.startsWith('shotlist-revision-')).length, 0);
    assert.equal(begins.filter(event => event.taskName.startsWith('shotlist-expression-patch-')).length, noPatch ? 0 : 1);
    assert.equal(begins.filter(event => /^(?:script-|tts-|vox$)/u.test(event.taskName)).length, 0, 'Shotlist repair cannot regenerate upstream inputs');
    const reviews = events.filter(event => event.type === 'shotlist-review-input');
    assert.equal(reviews.length, secondRound ? 4 : 2);
    for (const role of ['evidence', 'production']) {
      assert.equal(reviews.filter(event => event.taskName.endsWith(`-1-${role}`)).length, 1);
      assert.equal(reviews.filter(event => event.taskName.endsWith(`-2-${role}`)).length, secondRound ? 1 : 0);
    }
    const original = reviews[0];
    assert.equal(original.sequence.length, 7);
    assert.equal(original.sequence.filter(scene => scene.infoGraphic.requiresOverlay).length, 2);
    assert.equal(original.sequence[1].cameraMotion, '고정된 카메라의 미세한 push in');
    assert.equal(original.supportedClaims.length, 7);
    assert.equal(original.visualStateContract.length, 7);
    assert.ok(original.topicScript.title && original.topicScript.ttsText);
    const expected = structuredClone(original.sequence);
    expected[1].cameraMotion = '고정된 카메라의 느린 push in';
    for (const [index, review] of reviews.entries()) {
      assert.equal(JSON.stringify(review.sequence), JSON.stringify(index < 2 ? original.sequence : expected), 'Only scene2 cameraMotion changes; count/order/claims/required INFO and all other scene fields stay identical');
      for (const key of ['topicScript', 'supportedClaims', 'visualStateContract']) assert.deepEqual(review[key], original[key], `${key} context must stay identical in fresh reviews`);
    }
    const after = upstreamSnapshot();
    assert.deepEqual(after.rows, upstream.rows, 'Script/TTS database rows stay byte-identical');
    assert.deepEqual(after.jobs, upstream.jobs, 'Prior jobs, results and input revisions remain unchanged');
    const afterFiles = new Map(after.files);
    for (const [filename, digest] of upstream.files) assert.equal(afterFiles.get(filename), digest, `Upstream file unchanged: ${filename}`);
    const settledJob = pipelineStore.jobs(runId).find(item => item.id === row.id);
    assert.equal(settledJob.input_revision, row.input_revision);
    const journal = readEvents(path.join(attemptRoot, 'provider-invocations.jsonl'));
    const reservations = new Map();
    for (const event of journal) {
      if (event.type === 'invocation_result') assert.equal(reservations.get(event.requestId), 'reserved');
      reservations.set(event.requestId, event.status);
    }
    assert.equal([...reservations.values()].filter(status => status === 'reserved').length, 0);
    if (scenario === 'shotlist-repair-happy') {
      const items = db.prepare('SELECT * FROM shotlist_items WHERE topic_id = ? ORDER BY sort_index').all(topicId);
      assert.equal(items.length, 7);
      assert.equal(items[1].camera_motion, expected[1].cameraMotion);
    }
  }
  const completedStages = [];
  let blocked = false;
  let steps = 0;
  for (;;) {
    const job = claimNextAiJob();
    if (!job) break;
    assert.equal(job.runId, runId);
    assert.ok(++steps <= 30, 'Native stage loop did not terminate');
    const row = pipelineStore.jobs(runId).find(row => row.id === job.id);
    if(scenario.startsWith('restart-')&&row.pipeline_stage==='clean'&&row.scope_key==='4'){
      const {saveRestartCheckpoint}=await import('./pipeline-restart-checkpoint.mjs');
      saveRestartCheckpoint({app,job,scenario,root,dataRoot});
      break nativeScenario; // Normal process exit closes server/DB in finally; claimed lease remains durable.
    }
    if(scenario==='upstream-repair-approved'&&row.pipeline_stage==='shotlist')db.prepare("UPDATE scripts SET status='approved' WHERE topic_id=?").run(topicId); // Synthetic explicit approval fixture only.
    const before = row.pipeline_stage === failureStage ? snapshot() : null;
    const ttsRepair = scenario.startsWith('tts-repair-') && row.pipeline_stage === 'tts';
    const shotlistRepair = scenario.startsWith('shotlist-repair-') && row.pipeline_stage === 'shotlist';
    const beforeUpstream = shotlistRepair || scenario.startsWith('upstream-repair-') && row.pipeline_stage === 'shotlist' ? upstreamSnapshot() : null;
    const beforeScript = ttsRepair ? db.prepare('SELECT * FROM scripts WHERE topic_id = ?').get(topicId) : null;
    const scriptJob = ttsRepair ? pipelineStore.jobs(runId).find(item => item.pipeline_stage === 'script') : null;
    const attemptRoot = path.join(dataRoot, 'pipeline-staging', runId, String(job.id), job.leaseToken);
    let canceled = false;
    const cancelTimer = (scenario === 'tts-repair-cancel' && ttsRepair || scenario === 'info-repair-cancel' && row.pipeline_stage === 'info' || scenario === 'upstream-repair-cancel' && row.pipeline_stage === 'shotlist') ? setInterval(() => {
      if (!canceled && readEvents(path.join(attemptRoot, 'native-boundary-events.jsonl')).some(event => event.type === (scenario === 'info-repair-cancel' ? 'info-repair-delayed' : 'vox-retry-start'))) {
        canceled = true;
        pipelineStore.cancel(runId);
      }
    }, 10) : null;
    let result;
    try { result = await executeDurablePipelineJob(job, providers); }
    finally { if (cancelTimer) clearInterval(cancelTimer); }
    console.log(`NATIVE_STAGE ${row.pipeline_stage}:${row.scope_key} ${JSON.stringify(result)}`);
    if (scenario.startsWith('upstream-repair-') && row.pipeline_stage === 'shotlist') {
      const {verifyUpstreamRepair}=await import('./pipeline-upstream-repair.mjs');
      await verifyUpstreamRepair({app,job,attemptRoot,scenario,dataRoot,before:beforeUpstream,result,providers});
      if(scenario==='upstream-repair-cancel')assert.equal(canceled,true);
    }
    if (scenario.startsWith('info-repair-') && row.pipeline_stage === 'info') {
      const { verifyInfoRepair } = await import('./pipeline-info-repair.mjs');
      await verifyInfoRepair({app,job,attemptRoot,scenario,dataRoot,result,providers});
      if (scenario === 'info-repair-cancel') assert.equal(canceled,true);
    }
    if (scenario === 'clean-crop-hold' && row.pipeline_stage === 'script') {
      assert.equal(readEvents(path.join(attemptRoot, 'native-boundary-events.jsonl')).length, 0, 'Geometry HOLD precedes script and every provider');
      const attempt = db.prepare('SELECT * FROM pipeline_attempts WHERE run_id=? AND job_id=?').get(runId, job.id);
      assert.equal(attempt.invocation_count, 0);
      assert.equal(pipelineStore.getRun(runId).status, 'blocked');
      assert.equal(pipelineStore.getRun(runId).terminal_reason, 'needs_reference');
      assert.match(JSON.stringify(pipelineStore.jobs(runId)), /official_crop_required_bounds_infeasible/);
      // A successfully committed preflight HOLD is not a failed job execution.
      result = { status: 'held', reason: 'needs_reference' };
    }
    if (row.pipeline_stage === 'tts' && !ttsRepair) {
      const calls = readEvents(path.join(attemptRoot, 'native-boundary-events.jsonl')).filter(event => event.type === 'begin');
      assert.equal(calls.filter(event => event.taskName.startsWith('tts-narration-patch-')).length, 0);
      assert.equal(calls.filter(event => event.taskName === 'vox').length, 1);
    }
    if ((scenario.startsWith('repair-') && row.pipeline_stage === 'script') || ttsRepair || shotlistRepair) {
      if (shotlistRepair) verifyShotlistRepair(attemptRoot, row, beforeUpstream);
      else if (ttsRepair) {
        verifyTtsRepair(attemptRoot, job, beforeScript);
        assert.deepEqual(pipelineStore.jobs(runId).find(item => item.id === scriptJob.id), scriptJob, 'Prior script job result and snapshot are immutable');
        if (scenario === 'tts-repair-cancel') assert.equal(canceled, true);
      } else verifyRepair(attemptRoot);
      const settled = { run: pipelineStore.getRun(runId), jobs: pipelineStore.jobs(runId), attempts: db.prepare('SELECT * FROM pipeline_attempts WHERE run_id = ?').all(runId), business: snapshot(), events: readEvents(path.join(attemptRoot, 'native-boundary-events.jsonl')) };
      for (let retry = 0; retry < 3; retry++) {
        const repeated = await executeDurablePipelineJob(job, providers);
        assert.notEqual(repeated.status, 'succeeded', 'A settled job cannot execute again');
        if (result.status !== 'succeeded') assert.equal(claimNextAiJob(), null);
      }
      assert.deepEqual({ run: pipelineStore.getRun(runId), jobs: pipelineStore.jobs(runId), attempts: db.prepare('SELECT * FROM pipeline_attempts WHERE run_id = ?').all(runId), business: snapshot(), events: readEvents(path.join(attemptRoot, 'native-boundary-events.jsonl')) }, settled, 'Repeated execution must not patch, reset budgets, or mutate settled outputs');
    }
    if (result.status !== 'succeeded') {
      const attemptRoot = path.join(dataRoot, 'pipeline-staging', runId, String(job.id), job.leaseToken);
      const responsePath = path.join(attemptRoot, 'response.json');
      const response = fs.existsSync(responsePath) ? fs.readFileSync(responsePath, 'utf8') : 'No worker response';
      assert.equal(row.pipeline_stage, failureStage, JSON.stringify({ result, response }));
      assert.doesNotMatch(response, /NATIVE_FIXTURE_UNSUPPORTED|NATIVE_FIXTURE_DETERMINISTIC|AssertionError/u);
      assert.deepEqual(snapshot(), before, 'Failed native output must not change primary business state or files');
      const run = pipelineStore.getRun(runId);
      assert.equal(run.status, ['tts-repair-cancel','info-repair-cancel','upstream-repair-cancel'].includes(scenario) ? 'canceled' : 'blocked');
      const order = ['script', 'tts', 'shotlist', 'clean', 'info'];
      assert.equal(pipelineStore.jobs(runId).filter(item => order.indexOf(item.pipeline_stage) > order.indexOf(failureStage)).length, 0);
      assert.equal(pipelineStore.artifacts(runId).filter(item => item.kind === failureStage).length, 0);
      assert.equal(pipelineStore.jobs(runId).filter(item => item.pipeline_stage === 'continue' && item.scope_key === String(job.id)).length, 0, 'Failed job must not enqueue continuation');
      const attempts = db.prepare('SELECT * FROM pipeline_attempts WHERE run_id = ?').all(runId);
      assert.equal(run.invocations_used, attempts.reduce((sum, attempt) => sum + attempt.invocation_count, 0));
      let reservedRemaining = 0;
      for (const attempt of attempts) {
        const directory = path.join(dataRoot, 'pipeline-staging', runId, String(attempt.job_id), attempt.lease_token);
        const journal = readEvents(path.join(directory, 'provider-invocations.jsonl'));
        assert.equal(journal.filter(event => event.type === 'reserve_invocation').length, attempt.invocation_count, 'Invocation journal must account for every charged call');
        const state = new Map();
        for (const event of journal) {
          if (event.type === 'invocation_result') assert.equal(state.get(event.requestId), 'reserved');
          state.set(event.requestId, event.status);
        }
        reservedRemaining += [...state.values()].filter(status => status === 'reserved').length;
      }
      assert.equal(reservedRemaining, 0);
      const trace = readEvents(path.join(attemptRoot, 'native-boundary-events.jsonl'));
      if (scenario === 'clean-crop-hold') assert.equal(trace.length, 0, 'Deterministic crop HOLD must never enter an AI provider');
      else assert.ok(trace.length, 'Lowest provider boundary must actually execute');
      if (scenario.endsWith('-reject')) assert.ok(trace.some(event => event.type === 'completed' && event.passed === false));
      if (scenario === 'tts-overrun') assert.equal(trace.find(event => event.taskName === 'vox' && event.type === 'completed').durations[0], 5);
      if (scenario === 'budget-two') {
        assert.equal(run.invocations_used, 2);
        assert.match(run.terminal_reason, /budget/u);
        assert.ok(trace.filter(event => event.type === 'begin').length <= 2, 'Denied reservation must not reach provider');
      } else assert.doesNotMatch(run.terminal_reason || '', /budget/u);
      if (scenario === 'reviewer-drain') {
        assert.ok(trace.some(event => event.type === 'error' && event.message === 'NATIVE_REVIEWER_EXPECTED_FAILURE'));
        assert.ok(trace.some(event => event.type === 'completed' && event.taskName.endsWith('-production')));
      }
      for (let retry = 0; retry < 5; retry++) assert.equal(claimNextAiJob(), null);
      assert.deepEqual(pipelineStore.getRun(runId), run);
      assert.deepEqual(db.prepare('SELECT * FROM pipeline_attempts WHERE run_id = ?').all(runId), attempts);
      assert.deepEqual(denied, []);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_jobs').get().count, 0);
      blocked = true;
      console.log(`PIPELINE_NATIVE_RESULT ${JSON.stringify({ scenario, status: run.status, syntheticInputs: true, primaryUnchanged: true, noDownstream: true, reservedRemaining })}`);
      break;
    }
    if (row.pipeline_stage !== 'continue') completedStages.push(row.pipeline_stage);
  }
  assert.equal(blocked, Boolean(failureStage), 'Expected semantic hold must not silently succeed');
  if (!blocked) {
  assert.deepEqual(completedStages, ['script', 'tts', 'shotlist', ...Array(7).fill('clean'), 'info']);
  const run = pipelineStore.getRun(runId);
  const jobs = pipelineStore.jobs(runId);
  const artifacts = pipelineStore.artifacts(runId);
  assert.equal(run.status, 'awaiting_user_review');
  if (['repair-happy', 'shotlist-repair-happy'].includes(scenario)) assert.equal(run.invocations_used, 35, 'Original 32 calls plus one patch and two independent reviewers');
  if(scenario==='upstream-repair-happy'){
    assert.equal(run.invocations_used,38,'32 baseline + patch + two script reviewers + one segment Vox + two shotlist reviewers');
    const evidencePath=path.join(dataRoot,'native-upstream-repair.json');
    fs.writeFileSync(evidencePath,JSON.stringify({...JSON.parse(fs.readFileSync(evidencePath,'utf8')),finalRun:run,artifacts:artifacts.length},null,2));
  }
  assert.equal(artifacts.length, 14);
  assert.equal(jobs.filter(job => job.pipeline_stage === 'clean').length, 7);
  assert.equal(jobs.filter(job => job.pipeline_stage === 'info').length, 1);
  assert.ok(jobs.every(job => job.status === 'completed'));
  const settledAttempts = db.prepare('SELECT * FROM pipeline_attempts WHERE run_id = ?').all(runId);
  for (let retry = 0; retry < 5; retry++) assert.equal(claimNextAiJob(), null);
  assert.deepEqual(pipelineStore.getRun(runId), run);
  assert.deepEqual(pipelineStore.jobs(runId), jobs);
  assert.deepEqual(db.prepare('SELECT * FROM pipeline_attempts WHERE run_id = ?').all(runId), settledAttempts);
  assert.ok(db.prepare('SELECT status FROM asset_reviews WHERE topic_id = ?').all(topicId).every(row => row.status === 'AI_PASS'));
  const shotlist = db.prepare('SELECT * FROM shotlists WHERE topic_id = ? ORDER BY id DESC LIMIT 1').get(topicId);
  const items = db.prepare('SELECT * FROM shotlist_items WHERE shotlist_id = ? ORDER BY sort_index').all(shotlist.id);
  const contract = { version: 1, runId, runInputHash: run.input_hash,
    stageInputHashes: Object.fromEntries(['clean', 'info'].map(kind => [kind, artifacts.find(artifact => artifact.kind === kind).input_hash])),
    clips: items.map(item => { const spec = JSON.parse(item.info_spec_json); return { key: String(item.sort_index), requiredOverlay: spec.requiresOverlay === true, infoSpec: spec, claimRefs: JSON.parse(item.claim_refs_json), layoutTrusted: true }; }) };
  assert.ok(contract.clips.filter(clip => clip.requiredOverlay).length >= 2);
  fs.writeFileSync(path.join(dataRoot, 'native-run-contract.json'), JSON.stringify({ ...contract, ...(batchId ? { batchId } : {}) }, null, 2));
  const report = verifyPipelineRun({ root, dbPath: process.env.DINOBOX_DB_PATH, contract, python });
  fs.writeFileSync(path.join(dataRoot, 'native-verification.json'), JSON.stringify(report, null, 2));
  assert.equal(report.machinePassed, true, JSON.stringify(report));
  assert.deepEqual(denied, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_jobs').get().count, 0);
  const evidence = batchId ? await batchEvidence() : {};
  if (scenario === 'timing-reuse') {
    const { verifyTimingReuse } = await import('./pipeline-timing-reuse.mjs');
    evidence.timingReuse = await verifyTimingReuse({ app, runId, topicId, root, dataRoot });
    evidence.evidenceRoot = dataRoot;
  }
  if (scenario.startsWith('clean-repair-')) {
    const { verifyCleanRepair } = await import('./pipeline-clean-repair.mjs');
    evidence.cleanRepair = await verifyCleanRepair({ app, runId, topicId, root, dataRoot, api, providers });
    evidence.evidenceRoot = dataRoot;
  }
  if (batchId) assert.equal(evidence.batch.status, 'awaiting_user_review');
  console.log(`PIPELINE_NATIVE_RESULT ${JSON.stringify({ scenario, status: run.status, artifacts: artifacts.length, syntheticInputs: true, verifierPassed: report.machinePassed, ...evidence })}`);
  }
  }
} finally {
  if (app?.server?.listening) await new Promise((resolve, reject) => { app.server.close(error => error ? reject(error) : resolve()); app.server.closeIdleConnections?.(); });
  app?.db.close();
}
