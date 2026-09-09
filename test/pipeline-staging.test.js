import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createPipelineStage } from '../lib/pipeline-staging.js';

function fixture(t) {
  fs.mkdirSync('tmp', { recursive: true });
  const workspaceRoot = fs.mkdtempSync(path.resolve('tmp/pipeline-staging-test-'));
  const dataRoot = path.join(workspaceRoot, 'data');
  const project = path.join(dataRoot, 'projects', 'topic-1');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'audio'));
  fs.writeFileSync(path.join(project, 'image.png'), 'original-image');
  const db = new DatabaseSync(path.join(workspaceRoot, 'parent.sqlite'));
  db.exec(`CREATE TABLE topics(id INTEGER PRIMARY KEY,title TEXT,path TEXT);
    CREATE TABLE clips(id INTEGER PRIMARY KEY,topic_id INTEGER,path TEXT);
    CREATE TABLE jobs(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE generic(id INTEGER PRIMARY KEY,value TEXT);
    INSERT INTO jobs VALUES(1,'running'); INSERT INTO generic VALUES(1,'input');`);
  db.prepare('INSERT INTO topics VALUES(?,?,?)').run(1, 'original', 'data/projects/topic-1/image.png');
  db.prepare('INSERT INTO topics VALUES(?,?,?)').run(2, 'other', '');
  db.prepare('INSERT INTO clips VALUES(?,?,?)').run(1, 1, path.join(project, 'image.png'));
  let active = true;
  const args = { db, dataRoot, workspaceRoot, job: { id: 1, run_id: 'run-1', lease_token: 'token-1', topic_id: 1 }, assertCurrent: () => { if (!active) throw Error('lease_lost'); }, allowedTables: ['topics', 'clips', 'generic', 'jobs'] };
  t.after(() => db.close());
  // Fixtures are retained in tmp; never remove pre-existing user files.
  return { db, project, args, cancel() { active = false; db.exec("UPDATE jobs SET status='canceled' WHERE id=1"); }, async stage() { return createPipelineStage(args); } };
}

function worker(stage, extra = '') {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import path from 'node:path'; import {DatabaseSync} from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]); const data = process.argv[2];
    const project = path.join(data,'projects','topic-1');
    const existing = db.prepare('SELECT path FROM clips WHERE id=1').get().path;
    if (!existing.replaceAll('\\\\','/').startsWith(data.replaceAll('\\\\','/'))) throw Error('not relocated');
    db.prepare('UPDATE topics SET title=? WHERE id=1').run('generated');
    db.prepare('INSERT INTO clips VALUES(?,?,?)').run(2,1,path.join(project,'manifest.json'));
    fs.writeFileSync(path.join(project,'image.png'),'generated-image');
    fs.writeFileSync(path.join(project,'manifest.json'),JSON.stringify({ok:true}));
    ${extra}
    db.close();`, stage.dbPath, stage.dataRoot], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function pristine(f) {
  assert.equal(f.db.prepare('SELECT title FROM topics WHERE id=1').get().title, 'original');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM clips').get().n, 1);
  assert.equal(fs.readFileSync(path.join(f.project, 'image.png'), 'utf8'), 'original-image');
  assert.equal(fs.existsSync(path.join(f.project, 'manifest.json')), false);
}

test('real subprocess is isolated; cancellation before preparation preserves parent', async t => {
  const f = fixture(t); const stage = await f.stage(); worker(stage); f.cancel();
  assert.throws(() => stage.preparePromotion(), /lease_lost/); pristine(f);
});

test('late worker completion after cancellation cannot promote', async t => {
  const f = fixture(t); const stage = await f.stage(); f.cancel(); worker(stage);
  assert.throws(() => stage.preparePromotion(), /lease_lost/); pristine(f);
});

test('happy promotion uses explicit parent transaction and canonical paths', async t => {
  const f = fixture(t); const stage = await f.stage(); worker(stage); pristine(f);
  const plan = stage.preparePromotion(); assert.equal(plan.validate(), true);
  assert.throws(() => plan.apply(), /parent_transaction_required/);
  f.db.exec('BEGIN IMMEDIATE'); plan.apply(); f.db.exec('COMMIT'); plan.committed();
  assert.equal(f.db.prepare('SELECT title FROM topics WHERE id=1').get().title, 'generated');
  assert.equal(path.resolve(f.db.prepare('SELECT path FROM clips WHERE id=2').get().path), path.join(f.project, 'manifest.json'));
  assert.equal(fs.readFileSync(path.join(f.project, 'image.png'), 'utf8'), 'generated-image');
  assert.equal(JSON.parse(fs.readFileSync(plan.journalPath, 'utf8').trim().split('\n').at(-1)).state, 'committed');
});

test('lease lost after plan creation preserves primary', async t => {
  const f = fixture(t); const stage = await f.stage(); worker(stage); const plan = stage.preparePromotion(); f.cancel();
  f.db.exec('BEGIN IMMEDIATE'); assert.throws(() => plan.apply(), /lease_lost/); f.db.exec('ROLLBACK'); pristine(f);
});

test('beforeimage row conflicts and new ID collisions reject', async t => {
  for (const sql of ["UPDATE topics SET title='concurrent' WHERE id=1", "INSERT INTO clips VALUES(2,2,'unrelated')"]) {
    const f = fixture(t); const stage = await f.stage(); worker(stage); const plan = stage.preparePromotion();
    f.db.exec(sql); assert.throws(() => plan.validate(), /row_conflict/);
    assert.equal(fs.readFileSync(path.join(f.project, 'image.png'), 'utf8'), 'original-image');
  }
});

test('file conflict preserves concurrently edited parent file', async t => {
  const f = fixture(t); const stage = await f.stage(); worker(stage); const plan = stage.preparePromotion();
  fs.writeFileSync(path.join(f.project, 'image.png'), 'user-edit');
  assert.throws(() => plan.validate(), /file_conflict/);
  assert.equal(fs.readFileSync(path.join(f.project, 'image.png'), 'utf8'), 'user-edit');
});

test('SQLite rollback restores files and removes newly generated files', async t => {
  const f = fixture(t); const stage = await f.stage(); worker(stage); const plan = stage.preparePromotion();
  f.db.exec('BEGIN IMMEDIATE'); plan.apply();
  assert.equal(JSON.parse(fs.readFileSync(plan.journalPath, 'utf8').trim().split('\n').at(-1)).state, 'reconcile_required');
  assert.throws(() => plan.rollback(), /rollback_sqlite_first/);
  f.db.exec('ROLLBACK'); plan.rollback(); pristine(f);
  assert.equal(JSON.parse(fs.readFileSync(plan.journalPath, 'utf8').trim().split('\n').at(-1)).state, 'rolled_back');
});

test('forbidden table, unrelated topic and generic input changes reject', async t => {
  for (const [sql, pattern] of [
    ["UPDATE jobs SET status='done'", /forbidden_table/],
    ["UPDATE topics SET title='bad' WHERE id=2", /forbidden_topic/],
    ["UPDATE generic SET value='bad'", /forbidden_topic/],
    ["INSERT INTO clips VALUES(3,2,'bad')", /forbidden_topic/],
  ]) {
    const f = fixture(t); const stage = await f.stage(); worker(stage, `db.exec(${JSON.stringify(sql)});`);
    assert.throws(() => stage.preparePromotion(), pattern); pristine(f);
  }
});

test('schema changes and writes outside copied subtrees reject', async t => {
  const f = fixture(t); const stage = await f.stage(); worker(stage, "fs.writeFileSync(path.join(data,'escape.txt'),'bad');");
  assert.throws(() => stage.preparePromotion(), /file_outside_scope/); pristine(f);
  const g = fixture(t); const other = await g.stage(); worker(other, "db.exec('CREATE TABLE surprise(id INTEGER)');");
  assert.throws(() => other.preparePromotion(), /schema_changed/); pristine(g);
});

test('unsafe identities and symlink inputs reject', async t => {
  const f = fixture(t);
  await assert.rejects(createPipelineStage({ ...f.args, job: { ...f.args.job, lease_token: '../escape' } }), /invalid_job_identity/);
  const link = path.join(f.args.dataRoot, 'audio', 'linked');
  try { fs.symlinkSync(f.project, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlink privilege unavailable'); return; } throw error; }
  await assert.rejects(f.stage(), /symlink/); pristine(f);
});

test('stage file mutation after preparation rejects', async t => {
  const f = fixture(t); const stage = await f.stage(); worker(stage); const plan = stage.preparePromotion();
  fs.writeFileSync(path.join(stage.dataRoot, 'projects', 'topic-1', 'image.png'), 'late');
  assert.throws(() => plan.validate(), /stage_files_changed/); pristine(f);
});

test('real deferred SQLite COMMIT failure restores promoted files', async t => {
  const f = fixture(t);
  f.db.exec('PRAGMA foreign_keys=ON; CREATE TABLE refs(id INTEGER PRIMARY KEY, topic_id INTEGER REFERENCES topics(id) DEFERRABLE INITIALLY DEFERRED)');
  const stage = await f.stage(); worker(stage); const plan = stage.preparePromotion();
  f.db.exec('BEGIN IMMEDIATE'); plan.apply();
  f.db.exec('INSERT INTO refs VALUES(1,999)');
  assert.throws(() => f.db.exec('COMMIT'), /FOREIGN KEY/);
  f.db.exec('ROLLBACK'); plan.rollback(); pristine(f);
});

test('stage database changes after preparation reject', async t => {
  const f = fixture(t); const stage = await f.stage(); worker(stage); const plan = stage.preparePromotion();
  const child = new DatabaseSync(stage.dbPath);
  child.exec("UPDATE topics SET title='late' WHERE id=1"); child.close();
  assert.throws(() => plan.validate(), /stage_database_changed/); pristine(f);
});

test('duplicate no-PK forbidden rows cannot hide a deletion', async t => {
  const f = fixture(t);
  f.db.exec("CREATE TABLE bag(value TEXT); INSERT INTO bag VALUES('x'),('x')");
  const stage = await f.stage(); worker(stage, 'db.exec("DELETE FROM bag WHERE rowid=1");');
  assert.throws(() => stage.preparePromotion(), /forbidden_table/); pristine(f);
});

test('TEXT JSON and relative paths relocate without fake database deltas', async t => {
  const f = fixture(t);
  f.db.prepare('UPDATE generic SET value=?').run(JSON.stringify({ relative: 'data/audio/a.wav', absolute: path.join(f.args.dataRoot, 'audio', 'a.wav') }));
  const stage = await f.stage();
  const child = new DatabaseSync(stage.dbPath);
  const value = JSON.parse(child.prepare('SELECT value FROM generic').get().value); child.close();
  assert.equal(path.resolve(value.relative), path.join(stage.dataRoot, 'audio', 'a.wav'));
  assert.equal(path.resolve(value.absolute), path.join(stage.dataRoot, 'audio', 'a.wav'));
  assert.deepEqual(stage.preparePromotion().changes, []); pristine(f);
});

test('deep JSON API normalizes staged-relative paths and bookkeeping rows', async t => {
  const f = fixture(t);
  f.db.exec("ALTER TABLE jobs ADD COLUMN payload_json TEXT DEFAULT '{}'");
  f.db.prepare('UPDATE jobs SET payload_json=?').run(JSON.stringify({ path: 'data/audio/a.wav' }));
  const stage = await f.stage();
  const relative = path.relative(f.args.workspaceRoot, path.join(stage.dataRoot, 'audio', 'a.wav')).replaceAll('\\', '/');
  const input = { nested: [relative, { path: `./${relative}`, count: 3, ok: true, empty: null }], json: JSON.stringify({ path: relative }) };
  const result = stage.toOriginal(input);
  const expected = path.join(f.args.dataRoot, 'audio', 'a.wav').replaceAll('\\', '/');
  assert.equal(result.nested[0], expected);
  assert.equal(result.nested[1].path, expected);
  assert.equal(JSON.parse(result.json).path, expected);
  assert.equal(input.nested[0], relative);
  assert.equal(stage.toStaged(result).nested[0], path.join(stage.dataRoot, 'audio', 'a.wav').replaceAll('\\', '/'));
  const child = new DatabaseSync(stage.dbPath);
  child.prepare('UPDATE jobs SET payload_json=?').run(JSON.stringify({ path: relative }));
  child.close();
  assert.deepEqual(stage.preparePromotion().changes, []);
  assert.equal(JSON.parse(f.db.prepare('SELECT payload_json FROM jobs').get().payload_json).path, 'data/audio/a.wav');
  assert.equal(stage.dbPath, path.join(stage.root, 'provider.sqlite'));
});

test('alphabetical child-before-parent inserts defer actual immediate foreign keys', async t => {
  const f = fixture(t);
  f.db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE shotlists(id INTEGER PRIMARY KEY, topic_id INTEGER REFERENCES topics(id));
    CREATE TABLE shotlist_items(id INTEGER PRIMARY KEY, topic_id INTEGER REFERENCES topics(id), shotlist_id INTEGER REFERENCES shotlists(id));`);
  f.args.allowedTables.push('shotlists', 'shotlist_items');
  const stage = await f.stage();
  worker(stage, "db.exec('PRAGMA foreign_keys=ON; INSERT INTO shotlists VALUES(1,1); INSERT INTO shotlist_items VALUES(1,1,1)');");
  const plan = stage.preparePromotion();
  assert.ok(plan.changes.findIndex(row => row.table === 'shotlist_items') < plan.changes.findIndex(row => row.table === 'shotlists'));
  f.db.exec('BEGIN IMMEDIATE'); plan.apply();
  assert.equal(f.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  f.db.exec('COMMIT'); plan.committed();
  assert.equal(f.db.prepare('SELECT shotlist_id FROM shotlist_items').get().shotlist_id, 1);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('deferred immediate foreign keys still reject invalid references at COMMIT', async t => {
  const f = fixture(t);
  f.db.exec('PRAGMA foreign_keys=ON; CREATE TABLE refs(id INTEGER PRIMARY KEY,topic_id INTEGER, target INTEGER REFERENCES topics(id))');
  f.args.allowedTables.push('refs');
  const stage = await f.stage();
  worker(stage, "db.exec('INSERT INTO refs VALUES(1,1,2)');");
  const plan = stage.preparePromotion();
  f.db.exec('BEGIN IMMEDIATE'); plan.apply();
  f.db.exec('DELETE FROM topics WHERE id=2');
  assert.equal(f.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => f.db.exec('COMMIT'), /FOREIGN KEY/);
  f.db.exec('ROLLBACK'); plan.rollback(); pristine(f);
});

test('rollback CAS preserves outside writes to both overwritten and newly created files', async t => {
  for (const filename of ['image.png', 'manifest.json']) {
    const f = fixture(t); const stage = await f.stage(); worker(stage); const plan = stage.preparePromotion();
    f.db.exec('BEGIN IMMEDIATE'); plan.apply(); f.db.exec('ROLLBACK');
    fs.writeFileSync(path.join(f.project, filename), 'outside-writer');
    assert.throws(() => plan.rollback(), /rollback_file_conflict/);
    assert.equal(fs.readFileSync(path.join(f.project, filename), 'utf8'), 'outside-writer');
    assert.equal(JSON.parse(fs.readFileSync(plan.journalPath, 'utf8').trim().split('\n').at(-1)).state, 'reconcile_required');
    assert.equal(f.db.prepare('SELECT title FROM topics WHERE id=1').get().title, 'original');
    // Preflight must also leave the non-conflicting file untouched.
    assert.equal(fs.existsSync(path.join(f.project, 'manifest.json')), true);
  }
});

test('copied read-only input changes reject promotion before any primary mutation', async t => {
  for (const remove of [false, true]) {
    const f = fixture(t);
    const input = path.join(f.args.dataRoot, 'audio', 'input.wav');
    fs.writeFileSync(input, 'input-audio');
    const stage = await f.stage();
    const child = new DatabaseSync(stage.dbPath);
    child.exec("UPDATE topics SET title='generated' WHERE id=1"); child.close();
    fs.writeFileSync(path.join(stage.dataRoot, 'projects', 'topic-1', 'manifest.json'), 'generated');
    const plan = stage.preparePromotion();
    assert.equal(plan.validate(), true);
    assert.equal(plan.files.some(item => item.key === path.join('audio', 'input.wav')), false);
    if (remove) fs.unlinkSync(input); else fs.writeFileSync(input, 'new-input-audio');
    assert.throws(() => plan.validate(), /file_conflict:audio/);
    f.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => plan.apply(), /file_conflict:audio/);
    f.db.exec('ROLLBACK'); plan.rollback();
    pristine(f);
    if (remove) assert.equal(fs.existsSync(input), false);
    else assert.equal(fs.readFileSync(input, 'utf8'), 'new-input-audio');
  }
});

test('copied input validation is not rerun against promoted afterimages', async t => {
  const f = fixture(t); const stage = await f.stage();
  fs.writeFileSync(path.join(stage.dataRoot, 'projects', 'topic-1', 'image.png'), 'generated-image');
  const plan = stage.preparePromotion();
  f.db.exec('BEGIN IMMEDIATE'); plan.apply();
  assert.throws(() => plan.validate(), /invalid_state:applied/);
  f.db.exec('COMMIT'); plan.committed();
  assert.equal(fs.readFileSync(path.join(f.project, 'image.png'), 'utf8'), 'generated-image');
});
