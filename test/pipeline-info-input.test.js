import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { migrateInfoInputs, getInfoInput, recordInfoUserInput } from "../lib/pipeline-info-input.js";
import { buildPipelineInputSnapshot, hashPipelineInputSnapshot } from "../lib/pipeline-contract.js";

function fixture(t) {
  const root = path.resolve("tmp");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "pipeline-info-input-"));
  const db = new DatabaseSync(path.join(dir, "fixture.sqlite"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`PRAGMA user_version = 11;
    CREATE TABLE shotlist_items (id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL, info_spec_json TEXT DEFAULT '{}', info_prompt TEXT DEFAULT '', updated_at TEXT DEFAULT 'old');
    INSERT INTO shotlist_items (id, topic_id, info_spec_json, info_prompt) VALUES (1, 7, '{"type":"arrow","requiresOverlay":true}', 'original');`);
  return db;
}
const row = db => ({ ...db.prepare("SELECT * FROM shotlist_items WHERE id = 1").get() });
function snapshot(db, stage) {
  const item = row(db);
  return buildPipelineInputSnapshot({ topicId: 7, stage, shotlist: { id: 2, items: [{ id: 1, infoSpec: JSON.parse(item.info_spec_json), infoPrompt: item.info_prompt, infoInput: getInfoInput(db, 1) }] } });
}
const hash = (db, stage) => hashPipelineInputSnapshot(snapshot(db, stage));

test("schema 11 read compatibility and explicit idempotent migration", t => {
  const db = fixture(t);
  assert.equal(getInfoInput(db, 1), null);
  assert.equal(db.prepare("PRAGMA table_info(shotlist_items)").all().length, 5);
  migrateInfoInputs(db);
  migrateInfoInputs(db);
  assert.equal(db.prepare("PRAGMA table_info(shotlist_items)").all().length, 7);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 11);
  assert.equal(getInfoInput(db, 1), null);
  assert.equal(getInfoInput(db, 999), null);
});

test("user-only edits invalidate INFO not CLEAN; provider output does not", t => {
  const db = fixture(t);
  migrateInfoInputs(db);
  const clean = hash(db, "clean");
  const initial = hash(db, "info");
  const saved = recordInfoUserInput(db, { itemId: 1, topicId: 7, prompt: "user prompt", expectedRevision: 0 });
  assert.deepEqual(saved, { revision: 1, userSpec: { type: "arrow", requiresOverlay: true }, userPrompt: "user prompt" });
  assert.notEqual(hash(db, "info"), initial);
  assert.equal(hash(db, "clean"), clean);
  const first = hash(db, "info");
  db.exec(`UPDATE shotlist_items SET info_spec_json = '{"type":"none","requiresOverlay":false}', info_prompt = 'provider output' WHERE id = 1`);
  assert.equal(hash(db, "info"), first);
  assert.equal(hash(db, "clean"), clean);
  assert.deepEqual(getInfoInput(db, 1), saved);
  assert.equal(snapshot(db, "info").providerContext.initialShotlistItems[0].infoSpec.requiresOverlay, true);
  const second = recordInfoUserInput(db, { itemId: 1, topicId: 7, spec: { type: "comparison", requiresOverlay: false }, expectedRevision: 1 });
  assert.equal(second.revision, 2);
  assert.equal(second.userPrompt, "user prompt");
  assert.equal(row(db).info_prompt, "user prompt");
  assert.notEqual(hash(db, "info"), first);
  assert.equal(hash(db, "clean"), clean);
  assert.equal(snapshot(db, "info").providerContext.initialShotlistItems[0].infoSpec.requiresOverlay, false);
});

test("stale CAS and wrong topic reject without any row changes", t => {
  const db = fixture(t);
  migrateInfoInputs(db);
  recordInfoUserInput(db, { itemId: 1, topicId: 7, prompt: "first", expectedRevision: 0 });
  const before = row(db);
  assert.throws(() => recordInfoUserInput(db, { itemId: 1, topicId: 7, prompt: "stale", expectedRevision: 0 }), { code: "INFO_INPUT_REVISION_CONFLICT" });
  assert.deepEqual(row(db), before);
  assert.throws(() => recordInfoUserInput(db, { itemId: 1, topicId: 8, prompt: "wrong" }), { code: "INFO_INPUT_ITEM_NOT_FOUND" });
  assert.deepEqual(row(db), before);
});

test("savepoint composes with outer transaction and rolls back on SQL failure", t => {
  const db = fixture(t);
  migrateInfoInputs(db);
  const before = row(db);
  db.exec("BEGIN");
  recordInfoUserInput(db, { itemId: 1, topicId: 7, spec: { requiresOverlay: true } });
  db.exec("ROLLBACK");
  assert.deepEqual(row(db), before);
  db.exec(`CREATE TRIGGER reject_input AFTER UPDATE ON shotlist_items BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END`);
  assert.throws(() => recordInfoUserInput(db, { itemId: 1, topicId: 7, prompt: "rejected" }), /fixture rejection/);
  assert.deepEqual(row(db), before);
});

test("missing migration and invalid input fail without implicit writes", t => {
  const db = fixture(t);
  assert.throws(() => recordInfoUserInput(db, { itemId: 1, topicId: 7, prompt: "x" }), { code: "INFO_INPUT_MIGRATION_REQUIRED" });
  migrateInfoInputs(db);
  const before = row(db);
  for (const invalid of [{}, { spec: null }, { prompt: 1 }, { prompt: "x", expectedRevision: -1 }]) {
    assert.throws(() => recordInfoUserInput(db, { itemId: 1, topicId: 7, ...invalid }));
    assert.deepEqual(row(db), before);
  }
});
