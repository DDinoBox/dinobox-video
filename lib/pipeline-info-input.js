import { stableCanonicalStringify } from "./pipeline-contract.js";

let savepointSequence = 0;
function atomic(db, operation) {
  const name = `pipeline_info_input_${++savepointSequence}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}
function columns(db) {
  return new Set(db.prepare("PRAGMA table_info(shotlist_items)").all().map(row => row.name));
}
function migrated(db) {
  const names = columns(db);
  return names.has("info_input_revision") && names.has("info_input_json");
}
function fail(code) {
  return Object.assign(new Error(code), { code });
}
function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new TypeError("INFO spec must be a JSON object");
  stableCanonicalStringify(spec);
}
function decode(row) {
  if (!row || row.info_input_revision === 0) return null;
  if (!Number.isSafeInteger(row.info_input_revision) || row.info_input_revision < 1) throw fail("INFO_INPUT_INVALID_RECORD");
  const value = JSON.parse(row.info_input_json);
  validateSpec(value?.userSpec);
  if (typeof value.userPrompt !== "string") throw fail("INFO_INPUT_INVALID_RECORD");
  return { revision: row.info_input_revision, userSpec: value.userSpec, userPrompt: value.userPrompt };
}

// Explicit opt-in only. Does not change PRAGMA user_version or any pipeline tables.
export function migrateInfoInputs(db) {
  return atomic(db, () => {
    const names = columns(db);
    if (!names.size) throw fail("INFO_INPUT_TABLE_MISSING");
    if (!names.has("info_input_revision")) db.exec("ALTER TABLE shotlist_items ADD COLUMN info_input_revision INTEGER NOT NULL DEFAULT 0");
    if (!names.has("info_input_json")) db.exec("ALTER TABLE shotlist_items ADD COLUMN info_input_json TEXT NOT NULL DEFAULT '{}'");
  });
}

// Legacy schema remains readable without creating columns or swallowing DB errors.
export function getInfoInput(db, itemId) {
  if (!migrated(db)) return null;
  return decode(db.prepare("SELECT info_input_revision, info_input_json FROM shotlist_items WHERE id = ?").get(itemId));
}

/** User-edit path ONLY; provider output persistence must never call this function.
 * First partial edit captures the existing spec/prompt. Later partial edits merge
 * against saved user input, never against a provider's mutable output. A supplied
 * spec replaces the entire spec. Even an identical edit advances the revision.
 */
export function recordInfoUserInput(db, { itemId, topicId, spec, prompt, expectedRevision } = {}) {
  if (!Number.isSafeInteger(itemId) || itemId < 1 || !Number.isSafeInteger(topicId) || topicId < 1) throw new TypeError("Valid itemId and topicId are required");
  if (spec === undefined && prompt === undefined) throw new TypeError("INFO spec or prompt is required");
  if (spec !== undefined) validateSpec(spec);
  if (prompt !== undefined && typeof prompt !== "string") throw new TypeError("INFO prompt must be a string");
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new TypeError("Invalid expectedRevision");
  if (!migrated(db)) throw fail("INFO_INPUT_MIGRATION_REQUIRED");
  return atomic(db, () => {
    const row = db.prepare("SELECT info_spec_json, info_prompt, info_input_revision, info_input_json FROM shotlist_items WHERE id = ? AND topic_id = ?").get(itemId, topicId);
    if (!row) throw fail("INFO_INPUT_ITEM_NOT_FOUND");
    if (expectedRevision !== undefined && expectedRevision !== row.info_input_revision) throw fail("INFO_INPUT_REVISION_CONFLICT");
    const previous = decode(row);
    const userSpec = spec ?? previous?.userSpec ?? JSON.parse(row.info_spec_json || "{}");
    const userPrompt = prompt ?? previous?.userPrompt ?? row.info_prompt ?? "";
    validateSpec(userSpec);
    if (typeof userPrompt !== "string") throw fail("INFO_INPUT_INVALID_RECORD");
    const revision = row.info_input_revision + 1;
    if (!Number.isSafeInteger(revision)) throw fail("INFO_INPUT_REVISION_OVERFLOW");
    const json = stableCanonicalStringify({ userSpec, userPrompt });
    const result = db.prepare(`UPDATE shotlist_items
      SET info_input_revision = ?, info_input_json = ?, info_spec_json = ?, info_prompt = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND topic_id = ? AND info_input_revision = ?`)
      .run(revision, json, stableCanonicalStringify(userSpec), userPrompt, itemId, topicId, row.info_input_revision);
    if (Number(result.changes) !== 1) throw fail("INFO_INPUT_REVISION_CONFLICT");
    return { revision, ...JSON.parse(json) };
  });
}
