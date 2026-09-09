import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrapPipelineStore, validatePipelineBootstrap } from '../lib/pipeline-bootstrap.js';

const root = process.cwd();
function fixture() {
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const data = mkdtempSync(path.join(root, 'tmp', 'pipeline-bootstrap-'));
  return { DINOBOX_ENABLE_DURABLE_PIPELINE: '1', DINOBOX_DATA_DIR: data, DINOBOX_DB_PATH: path.join(data, 'fixture.db'), DISABLE_BACKGROUND_WORKERS: '1', DINOBOX_DISABLE_AUTOMATIC_REMEDIATION: '1' };
}
test('opt-out bootstrap leaves legacy DB bytes and schema untouched', () => {
  const env = fixture();
  const db = new DatabaseSync(env.DINOBOX_DB_PATH);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT); INSERT INTO schema_migrations VALUES(11,'legacy')");
  const before = readFileSync(env.DINOBOX_DB_PATH);
  assert.equal(validatePipelineBootstrap({}, root), false);
  assert.equal(bootstrapPipelineStore(db, false), null);
  assert.deepEqual(readFileSync(env.DINOBOX_DB_PATH), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'pipeline_%'").get().n, 0);
  db.close();
});
test('migration requires explicit isolated directory and disabled workers', () => {
  const env = fixture();
  assert.equal(validatePipelineBootstrap(env, root), true);
  for (const patch of [{ DINOBOX_DB_PATH: path.join(root, 'data', 'shorts.db') }, { DINOBOX_DATA_DIR: path.join(root, 'data') }, { DISABLE_BACKGROUND_WORKERS: '0' }, { DINOBOX_DISABLE_AUTOMATIC_REMEDIATION: '0' }, { DINOBOX_DB_PATH: '' }]) {
    assert.throws(() => validatePipelineBootstrap({ ...env, ...patch }, root), /durable_pipeline_requires/);
  }
  const db = new DatabaseSync(env.DINOBOX_DB_PATH);
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT)');
  const store = bootstrapPipelineStore(db, true);
  assert.ok(store);
  assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=12').get().name, 'durable_pipeline_runs');
  db.close();
});
