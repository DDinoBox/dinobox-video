import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const quote = value => `"${value.replaceAll('"', '""')}"`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? { bigint: String(item) } : item instanceof Uint8Array ? { blob: Buffer.from(item).toString('base64') } : item);
const equal = (a, b) => encode(a) === encode(b);
const inside = (root, target) => { const rel = path.relative(root, target); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };
const fail = message => { throw Error(`pipeline_staging:${message}`); };

function safePath(root, target) {
  if (!inside(root, target)) fail('path_escape');
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    if (fs.existsSync(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) fail('symlink');
    } else {
      // existsSync follows links; lstat also detects dangling links.
      try { if (fs.lstatSync(current).isSymbolicLink()) fail('symlink'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return target;
}

function files(root) {
  const result = new Map();
  const walk = dir => {
    safePath(root, dir);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = safePath(root, path.join(dir, entry.name));
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) result.set(path.relative(root, absolute), digest(fs.readFileSync(absolute)));
      else fail('non_regular_file');
    }
  };
  walk(root);
  return result;
}

function durableWrite(file, bytes) {
  const fd = fs.openSync(file, 'w');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function schema(db) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
}

function snapshot(db, normalize) {
  const result = new Map();
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
    const pk = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
    const statement = db.prepare(`SELECT * FROM ${quote(name)}`);
    statement.setReadBigInts(true);
    const rows = statement.all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? normalize(value) : value])));
    if (!pk.length) rows.sort((a, b) => encode(a).localeCompare(encode(b)));
    result.set(name, { columns: columns.map(column => column.name), pk, rows: new Map(rows.map((row, index) => [pk.length ? encode(pk.map(key => row[key])) : String(index), row])) });
  }
  return result;
}

function changes(before, after) {
  const result = [];
  for (const [table, base] of before) {
    const next = after.get(table);
    if (!next) fail('schema_changed');
    for (const key of new Set([...base.rows.keys(), ...next.rows.keys()])) {
      const oldRow = base.rows.get(key), newRow = next.rows.get(key);
      if (!equal(oldRow, newRow)) result.push({ table, key, pk: base.pk, before: oldRow, after: newRow });
    }
  }
  return result;
}

/** The caller must await child exit/close before preparePromotion; no worker is launched here.
 * apply runs inside a caller-owned SQLite transaction. On any failure, ROLLBACK SQLite,
 * then rollback() files. Only after successful COMMIT call committed(). A leftover
 * reconcile_required journal is evidence for manual reconciliation, never auto replay.
 */
export async function createPipelineStage({ db, dataRoot, workspaceRoot, job, assertCurrent, allowedTables = [], includeSourceCache = false }) {
  if (typeof assertCurrent !== 'function') fail('assertCurrent_required');
  const checkLease = () => {
    const result = assertCurrent(job);
    if (result && typeof result.then === 'function') fail('assertCurrent_must_be_sync');
    if (result === false) fail('lease_lost');
  };
  checkLease();
  if (db.isTransaction) fail('snapshot_requires_no_transaction');
  workspaceRoot = path.resolve(workspaceRoot);
  dataRoot = safePath(workspaceRoot, path.resolve(dataRoot));
  if (workspaceRoot === dataRoot) fail('data_root_must_be_workspace_subdirectory');
  const segment = value => { const text = String(value ?? ''); if (!/^[a-zA-Z0-9_-]+$/.test(text)) fail('invalid_job_identity'); return text; };
  const topic = segment(job.topic_id);
  const root = safePath(workspaceRoot, path.join(dataRoot, 'pipeline-staging', segment(job.run_id), segment(job.id), segment(job.lease_token)));
  if (fs.existsSync(root)) fail('stage_already_exists');
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root);
  const stagedData = path.join(root, 'data');
  fs.mkdirSync(stagedData);
  const dbPath = path.join(root, 'provider.sqlite');
  const scopes = ['audio', path.join('projects', `topic-${topic}`), ...(includeSourceCache ? ['source-cache'] : [])];
  const scoped = relative => scopes.some(scope => relative === scope || relative.startsWith(`${scope}${path.sep}`));
  const beforeFiles = new Map();
  for (const scope of scopes) {
    const source = safePath(workspaceRoot, path.join(dataRoot, scope));
    const target = path.join(stagedData, scope);
    fs.mkdirSync(target, { recursive: true });
    for (const [relative, hash] of files(source)) {
      const key = path.join(scope, relative);
      const destination = path.join(target, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(source, relative), destination);
      if (digest(fs.readFileSync(destination)) !== hash) fail('input_changed_during_copy');
      beforeFiles.set(key, hash);
    }
  }
  await backup(db, dbPath);
  checkLease();
  const canonical = dataRoot.replaceAll('\\', '/');
  const staged = stagedData.replaceAll('\\', '/');
  const relativeData = path.relative(workspaceRoot, dataRoot).replaceAll('\\', '/');
  const variants = base => [...new Set([base, base.replaceAll('/', '\\'), base.replaceAll('/', '\\\\')])];
  const replacePath = (text, from, to) => {
    // Strings can be plain paths or JSON containing paths. Do not rewrite URL hosts,
    // larger directory names, or already-rewritten paths nested below the data root.
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`(^|["'\\s=:(])${escaped}(?=$|[/\\\\"'\\s,}\\]])`, 'g'), (_, prefix) => prefix + to);
  };
  const normalize = text => {
    const portable = text.replaceAll('\\', '/');
    if ([canonical, staged, `${relativeData}/`].some(prefix => portable.includes(prefix)) && /\/\.\.(?:\/|$|["'])/.test(portable)) fail('path_escape');
    const stagedRelative = path.relative(workspaceRoot, stagedData).replaceAll('\\', '/');
    for (const from of [...variants(staged), ...variants(stagedRelative), ...variants(`./${stagedRelative}`)].sort((a, b) => b.length - a.length)) text = replacePath(text, from, canonical);
    for (const from of [...variants(canonical), ...variants(relativeData), ...variants(`./${relativeData}`)].sort((a, b) => b.length - a.length)) text = replacePath(text, from, canonical);
    return text;
  };
  const rewrite = text => replacePath(normalize(text), canonical, staged);
  const child = new DatabaseSync(dbPath);
  let before, initialSchema;
  try {
    initialSchema = schema(child);
    before = snapshot(child, normalize);
    child.exec('BEGIN');
    for (const [table, data] of before) {
      // Only TEXT values needing relocation are touched; no-PK tables fail closed.
      for (const row of data.rows.values()) {
        const updated = Object.fromEntries(Object.entries(row).filter(([, value]) => typeof value === 'string' && rewrite(value) !== value).map(([key, value]) => [key, rewrite(value)]));
        if (!Object.keys(updated).length) continue;
        if (!data.pk.length) fail(`rewrite_requires_pk:${table}`);
        child.prepare(`UPDATE ${quote(table)} SET ${Object.keys(updated).map(key => `${quote(key)}=?`).join(',')} WHERE ${data.pk.map(key => `${quote(key)} IS ?`).join(' AND ')}`).run(...Object.values(updated), ...data.pk.map(key => row[key]));
      }
    }
    child.exec('COMMIT');
    if (changes(before, snapshot(child, normalize)).length) fail('rewrite_side_effect');
  } finally { child.close(); }

  // JSON values are copied recursively; keys are untouched, string leaves (including
  // serialized JSON text) are relocated. The caller's value is never mutated.
  const mapJson = (value, transform) => {
    if (typeof value === 'string') return transform(value);
    if (Array.isArray(value)) return value.map(item => mapJson(item, transform));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapJson(item, transform)]));
    return value;
  };
  let prepared = false;
  return {
    root, dbPath, dataRoot: stagedData, before,
    toOriginal: value => mapJson(value, normalize),
    toStaged: value => mapJson(value, rewrite),
    preparePromotion() {
      if (prepared) fail('already_prepared');
      checkLease();
      safePath(workspaceRoot, dbPath);
      const stagedDb = new DatabaseSync(dbPath, { readOnly: true });
      let delta;
      try {
        if (!equal(initialSchema, schema(stagedDb))) fail('schema_changed');
        delta = changes(before, snapshot(stagedDb, normalize));
      } finally { stagedDb.close(); }
      const allowed = new Set(allowedTables);
      for (const change of delta) {
        if (!allowed.has(change.table) || /^(jobs|pipeline_|ai_)/.test(change.table)) fail(`forbidden_table:${change.table}`);
        if (!change.pk.length) fail(`missing_pk:${change.table}`);
        for (const row of [change.before, change.after].filter(Boolean)) {
          const rowTopic = change.table === 'topics' ? row.id : row.topic_id;
          if (rowTopic == null || String(rowTopic) !== topic) fail(`forbidden_topic:${change.table}`);
        }
        if (initialSchema.some(item => item.type === 'trigger' && item.tbl_name === change.table)) fail('trigger_not_supported');
      }
      const stagedFiles = files(stagedData);
      for (const key of stagedFiles.keys()) if (!scoped(key)) fail('file_outside_scope');
      const fileDelta = [...new Set([...beforeFiles.keys(), ...stagedFiles.keys()])].filter(key => beforeFiles.get(key) !== stagedFiles.get(key)).map(key => ({ key, before: beforeFiles.get(key), after: stagedFiles.get(key) }));
      const journalPath = path.join(root, 'promotion-journal.jsonl');
      let state = 'prepared';
      const touched = [];
      // Append-only records preserve the recovery marker even if a later write tears.
      const journal = next => {
        const record = encode({ version: 1, state: next, job: { id: job.id, run_id: job.run_id, lease_token: job.lease_token }, dbPath, dataRoot, changes: delta, files: fileDelta, touched, recovery: 'manual_reconciliation_only' });
        const fd = fs.openSync(safePath(workspaceRoot, journalPath), 'a');
        try { fs.writeFileSync(fd, record + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      };
      const readParentFiles = () => {
        const current = new Map();
        for (const scope of scopes) for (const [relative, hash] of files(safePath(workspaceRoot, path.join(dataRoot, scope)))) current.set(path.join(scope, relative), hash);
        return current;
      };
      const validate = () => {
        if (state !== 'prepared') fail(`invalid_state:${state}`);
        checkLease();
        if (!equal(initialSchema, schema(db))) fail('parent_schema_changed');
        const current = snapshot(db, normalize);
        for (const item of delta) if (!equal(current.get(item.table)?.rows.get(item.key), item.before)) fail(`row_conflict:${item.table}`);
        const currentFiles = readParentFiles();
        // Copied, unchanged files are provider inputs too: reject stale reads,
        // not just conflicting output writes. validate is prepared-state only.
        for (const [key, hash] of beforeFiles) if (currentFiles.get(key) !== hash) fail(`file_conflict:${key}`);
        for (const item of fileDelta) if (currentFiles.get(item.key) !== item.before) fail(`file_conflict:${item.key}`);
        safePath(workspaceRoot, stagedData);
        if (!equal([...files(stagedData)].sort(), [...stagedFiles].sort())) fail('stage_files_changed');
        const checkDb = new DatabaseSync(safePath(workspaceRoot, dbPath), { readOnly: true });
        try {
          if (!equal(initialSchema, schema(checkDb)) || !equal(delta, changes(before, snapshot(checkDb, normalize)))) fail('stage_database_changed');
        } finally { checkDb.close(); }
        return true;
      };
      prepared = true;
      return {
        journalPath, changes: delta, files: fileDelta, validate,
        apply() {
          if (!db.isTransaction) fail('parent_transaction_required');
          validate();
          const current = snapshot(db, normalize);
          // Every backup and the recovery journal are durable before the first mutation.
          const backups = safePath(workspaceRoot, path.join(root, 'backups'));
          fs.mkdirSync(backups);
          for (const [index, item] of fileDelta.entries()) if (item.before !== undefined) {
            const bytes = fs.readFileSync(safePath(workspaceRoot, path.join(dataRoot, item.key)));
            if (digest(bytes) !== item.before) fail(`file_conflict:${item.key}`);
            durableWrite(safePath(workspaceRoot, path.join(backups, String(index))), bytes);
          }
          journal('reconcile_required');
          state = 'applying';
          // Tables are diffed alphabetically, not in dependency order. Keep foreign
          // keys enabled and defer their validation to the caller's COMMIT.
          db.exec('PRAGMA defer_foreign_keys=ON');
          for (const item of delta) {
            if (!item.after) db.prepare(`DELETE FROM ${quote(item.table)} WHERE ${item.pk.map(key => `${quote(key)} IS ?`).join(' AND ')}`).run(...item.pk.map(key => item.before[key]));
            else if (!item.before) db.prepare(`INSERT INTO ${quote(item.table)} (${Object.keys(item.after).map(quote).join(',')}) VALUES (${Object.keys(item.after).map(() => '?').join(',')})`).run(...Object.values(item.after));
            else db.prepare(`UPDATE ${quote(item.table)} SET ${Object.keys(item.after).map(key => `${quote(key)}=?`).join(',')} WHERE ${item.pk.map(key => `${quote(key)} IS ?`).join(' AND ')}`).run(...Object.values(item.after), ...item.pk.map(key => item.before[key]));
          }
          if (!equal(changes(current, snapshot(db, normalize)), delta)) fail('database_side_effect');
          for (const [index, item] of fileDelta.entries()) {
            checkLease();
            const target = safePath(workspaceRoot, path.join(dataRoot, item.key));
            const existing = fs.existsSync(target) ? digest(fs.readFileSync(target)) : undefined;
            if (existing !== item.before) fail(`file_conflict:${item.key}`);
            const bytes = item.after === undefined ? undefined : fs.readFileSync(safePath(workspaceRoot, path.join(stagedData, item.key)));
            if (bytes && digest(bytes) !== item.after) fail('stage_files_changed');
            touched.push(index);
            journal('reconcile_required');
            if (item.after === undefined) fs.unlinkSync(target);
            else {
              fs.mkdirSync(path.dirname(target), { recursive: true });
              durableWrite(target, bytes);
            }
          }
          checkLease();
          state = 'applied';
        },
        rollback() {
          if (db.isTransaction) fail('rollback_sqlite_first');
          if (state === 'prepared') { state = 'rolled_back'; return; }
          if (state === 'rolled_back') return;
          if (!['applying', 'applied'].includes(state)) fail(`invalid_state:${state}`);
          const checkAfterimage = item => {
            const target = safePath(workspaceRoot, path.join(dataRoot, item.key));
            const hash = fs.existsSync(target) ? digest(fs.readFileSync(target)) : undefined;
            if (hash === item.before) return false; // Already restored or never mutated.
            if (hash !== item.after) {
              state = 'reconcile_required';
              journal(state);
              fail(`rollback_file_conflict:${item.key}`);
            }
            return true;
          };
          // Preflight all files before restoring any; recheck immediately before
          // each mutation. Never overwrite/delete a newer external writer's bytes.
          for (const index of touched) checkAfterimage(fileDelta[index]);
          for (const index of [...touched].reverse()) {
            const item = fileDelta[index];
            if (!checkAfterimage(item)) continue;
            const target = safePath(workspaceRoot, path.join(dataRoot, item.key));
            if (item.before === undefined) {
              fs.unlinkSync(target);
            } else {
              const bytes = fs.readFileSync(safePath(workspaceRoot, path.join(root, 'backups', String(index))));
              if (digest(bytes) !== item.before) fail('backup_corrupted');
              durableWrite(target, bytes);
            }
          }
          journal('rolled_back');
          state = 'rolled_back';
        },
        committed() {
          if (db.isTransaction || state !== 'applied') fail('commit_sqlite_first');
          journal('committed');
          state = 'committed';
        },
      };
    },
  };
}
