import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import net from 'node:net';

export const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
export const blockedCalls = [];
export const spawnedWorkers = [];
export function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// This guard is also installed inside each mock worker. This is a test fence,
// not an OS sandbox: real staging must still reject stale/conflicting promotion.
const nativeSpawn = childProcess.spawn;
childProcess.spawn = (command, args = [], options = {}) => {
  const worker = path.resolve(workspaceRoot, 'lib/pipeline-provider-worker.mjs');
  const allowed = path.resolve(command) === path.resolve(process.execPath)
    && args.length === 2 && path.resolve(args[0]) === worker
    && inside(path.join(workspaceRoot, 'tmp'), args[1])
    && options.shell !== true;
  if (!allowed) {
    blockedCalls.push(`spawn:${command}`);
    throw new Error('Only the isolated pipeline provider worker may be spawned');
  }
  const child = nativeSpawn(command, args, options);
  spawnedWorkers.push(child);
  return child;
};
for (const name of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = () => {
  blockedCalls.push(name);
  throw new Error(`External process forbidden: ${name}`);
};
const nativeConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!['localhost', '127.0.0.1', '::1'].includes(host || 'localhost') || options?.path) {
    blockedCalls.push(`network:${host}`);
    throw new Error('Non-loopback network forbidden');
  }
  return nativeConnect.apply(this, args);
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    blockedCalls.push(`fetch:${url.hostname}`);
    throw new Error('External fetch forbidden');
  }
  return nativeFetch(input, { ...options, redirect: 'error' });
};
syncBuiltinESMExports();

export function insert(db, table, values) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  assert.ok(columns.length);
  for (const column of columns) {
    if (column.pk || !column.notnull || column.dflt_value !== null || column.name in values) continue;
    values[column.name] = /INT|REAL|NUM/iu.test(column.type) ? 0 : column.name.endsWith('_json') ? '{}' : 'fixture';
  }
  const keys = Object.keys(values);
  for (const key of keys) assert.ok(columns.some(column => column.name === key), `${table}.${key}`);
  return Number(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => values[key])).lastInsertRowid);
}

export function writeWav(filename, seconds) {
  // Valid 8 kHz mono PCM silence; explicitly not real speech synthesis.
  const bytes = Buffer.alloc(44 + 8000 * seconds * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  return filename;
}

function png(index, kind) {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, bytes) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(8, 0); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(8 * 33);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rows.set([index * 25, kind === 'info' ? 200 : 40, x * 25, 255], y * 33 + 1 + x * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export function assertStaged(dataRoot, db) {
  assert.equal(process.env.DINOBOX_PIPELINE_PROVIDER_WORKER, '1');
  assert.equal(process.env.DINOBOX_ISOLATED_MOCK_PROVIDER, '1');
  assert.ok(inside(path.join(workspaceRoot, 'tmp'), dataRoot));
  assert.ok(path.resolve(dataRoot).split(path.sep).includes('pipeline-staging'));
  assert.equal(path.resolve(dataRoot), path.resolve(process.env.DINOBOX_DATA_DIR));
  if (db) assert.equal(path.resolve(db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file), path.resolve(process.env.DINOBOX_DB_PATH));
}

export default async function mockStage({ db, dataRoot, workspaceRoot: workerWorkspace, job, payload, signal }) {
  assert.equal(path.resolve(workerWorkspace), path.resolve(workspaceRoot));
  assertStaged(dataRoot, db);
  signal.throwIfAborted();
  const topicId = Number(job.topic_id);
  const stage = job.pipeline_stage;
  const manifestDir = path.join(dataRoot, 'projects', `topic-${topicId}`, 'manifests');
  fs.mkdirSync(manifestDir, { recursive: true });
  const receipt = { stage, pid: process.pid, dataRoot, dbPath: process.env.DINOBOX_DB_PATH, mocked: true };
  fs.writeFileSync(path.join(manifestDir, `MOCK_${stage}_${job.scope_key}.json`), JSON.stringify(receipt));
  if (stage === 'script') {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scripts WHERE topic_id = ?').get(topicId).count, 0);
    const productionScript = Array.from({ length: 7 }, (_, index) => ({
      beat: `S${index + 1}`, time: `${index * 4}-${(index + 1) * 4}`,
      narration: `구조물의 힘이 ${index + 1}번째 지점을 지나갑니다.`, claimRefs: []
    }));
    const id = insert(db, 'scripts', {
      topic_id: topicId, status: 'draft', production_script_json: JSON.stringify(productionScript),
      tts_text: productionScript.map(row => row.narration).join('\n'), notes_json: '[]', raw_json: '{"qualityStatus":"passed"}'
    });
    if (payload.testMode === 'late') {
      db.prepare('UPDATE topics SET title = ? WHERE id = ?').run('STAGED ONLY TITLE', topicId);
      fs.writeFileSync(path.join(manifestDir, 'PRIMARY_MANIFEST.md'), 'STAGED ONLY MANIFEST');
      fs.writeFileSync(path.join(manifestDir, 'STAGE_READY.json'), JSON.stringify(receipt));
      // The coordinator cancels after observing staged writes, not on a timing guess.
      await delay(750);
      signal.throwIfAborted();
    }
    assert.deepEqual(blockedCalls, []);
    return { execution: 'succeeded', quality: 'pass', script: { id, status: 'draft' }, mockReceipt: receipt };
  }
  if (stage === 'shotlist') {
    const script = db.prepare('SELECT * FROM scripts WHERE topic_id = ? ORDER BY id DESC LIMIT 1').get(topicId);
    const tts = db.prepare('SELECT * FROM tts_runs WHERE topic_id = ? ORDER BY id DESC LIMIT 1').get(topicId);
    assert.ok(script && tts);
    assert.equal(tts.status, 'generated');
    assert.equal(tts.script_id, script.id);
    assert.equal(tts.total_duration_sec, 28);
    const segments = db.prepare('SELECT * FROM tts_segments WHERE run_id = ? ORDER BY segment_index').all(tts.id);
    assert.equal(segments.length, 7);
    for (const segment of segments) {
      assert.equal(segment.status, 'generated'); assert.equal(segment.duration_sec, 4);
      const audioPath = path.resolve(workspaceRoot, segment.audio_path);
      assert.ok(inside(dataRoot, audioPath), 'TTS references must relocate into this stage');
      assert.equal((fs.readFileSync(audioPath).length - 44) / 16000, 4);
    }
    const version = fs.readFileSync(path.join(workspaceRoot, 'server.js'), 'utf8').match(/const INFO_PLAN_VERSION\s*=\s*(\d+)/u);
    assert.ok(version);
    const id = insert(db, 'shotlists', {
      topic_id: topicId, script_id: script.id, tts_run_id: tts.id, status: 'approved', total_duration_sec: 28, clip_count: 7,
      raw_json: JSON.stringify({ qualityStatus: 'passed', infoPlanVersion: Number(version[1]) })
    });
    for (let index = 1; index <= 7; index++) insert(db, 'shotlist_items', {
      shotlist_id: id, topic_id: topicId, sort_index: index, scene_id: `S${index}`, keyframe_id: `K${index}`, clip_id: `C${index}`,
      source_segment_index: index, start_sec: (index - 1) * 4, end_sec: index * 4, duration_sec: 4,
      file_stub: `${String(index).padStart(2, '0')}_stage_fixture`, status: 'approved', clean_prompt: `Mock scene ${index}`, claim_refs_json: '[]',
      info_spec_json: JSON.stringify({ requiresOverlay: index <= 2, type: index <= 2 ? 'force_arrow' : 'none' })
    });
    assert.deepEqual(blockedCalls, []);
    return { execution: 'succeeded', quality: 'pass', shotlist: { id, status: 'approved' }, mockReceipt: receipt };
  }
  assert.ok(['clean', 'info'].includes(stage), 'TTS must use the native adapter, never this mock module');
  const shotlist = db.prepare('SELECT * FROM shotlists WHERE topic_id = ? ORDER BY id DESC LIMIT 1').get(topicId);
  assert.equal(shotlist.status, 'approved');
  const allItems = db.prepare('SELECT * FROM shotlist_items WHERE shotlist_id = ? ORDER BY sort_index').all(shotlist.id);
  assert.equal(allItems.length, 7);
  if (stage === 'info') {
    const item = allItems[0];
    const beforeInput = db.prepare('SELECT info_input_revision, info_input_json FROM shotlist_items WHERE id = ?').get(item.id);
    const spec = { ...JSON.parse(item.info_spec_json), mockOutputLabel: 'Provider-owned label' };
    db.prepare('UPDATE shotlist_items SET info_spec_json = ?, info_prompt = ? WHERE id = ?')
      .run(JSON.stringify(spec), 'Provider-owned INFO output prompt', item.id);
    assert.deepEqual(db.prepare('SELECT info_input_revision, info_input_json FROM shotlist_items WHERE id = ?').get(item.id), beforeInput);
  }
  const selected = stage === 'clean' ? allItems.filter(item => item.sort_index === Number(payload.clipIndex)) : allItems;
  assert.equal(selected.length, stage === 'clean' ? 1 : 7);
  const rendered = selected.map(item => {
    const filename = path.join(dataRoot, 'projects', `topic-${topicId}`, stage, `${item.file_stub}_${stage.toUpperCase()}.png`);
    assert.ok(inside(dataRoot, filename));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const bytes = png(item.sort_index, stage);
    fs.writeFileSync(filename, bytes);
    const autoQc = { passed: true, shotlistId: shotlist.id, independentSemantic: { passed: true }, mock: true };
    fs.writeFileSync(`${filename}.qc.json`, JSON.stringify(autoQc));
    const outputPath = path.relative(workspaceRoot, filename).replace(/\\/gu, '/');
    insert(db, 'asset_reviews', { topic_id: topicId, clip_index: item.sort_index, asset_type: stage,
      asset_path: outputPath, status: 'AI_PASS', note: 'Staged mock QC, not human approval', auto_qc_json: JSON.stringify(autoQc) });
    return { topicId, clipIndex: item.sort_index, sceneId: item.scene_id, outputPath, size: bytes.length, autoQc, reused: false };
  });
  assert.deepEqual(blockedCalls, []);
  return stage === 'clean'
    ? { ...rendered[0], followUpClipIndexes: [], mockReceipt: receipt }
    : { renderedCount: rendered.length, rendered, path: '', url: '', specPath: '', specUrl: '', archivedFailedInfoArtifacts: [], mockReceipt: receipt };
}
