import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  mkdirSync(path.join(root, "tmp"), { recursive: true });
  const dir = mkdtempSync(path.join(root, "tmp", "pipeline-audit-"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const dbPath = path.join(dir, "fixture.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE topics(id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE jobs(id INTEGER PRIMARY KEY, topic_id INTEGER, type TEXT, status TEXT, result_json TEXT DEFAULT '{}', started_at TEXT, completed_at TEXT);
    CREATE TABLE ai_invocations(id INTEGER PRIMARY KEY, job_id INTEGER, topic_id INTEGER, status TEXT);
    CREATE TABLE quality_runs(id INTEGER PRIMARY KEY, topic_id INTEGER, stage TEXT, status TEXT, metrics_json TEXT DEFAULT '{}', artifact_ref TEXT DEFAULT '', created_at TEXT);
    CREATE TABLE shotlists(id INTEGER PRIMARY KEY, topic_id INTEGER, status TEXT, manifest_path TEXT DEFAULT '');
    CREATE TABLE asset_reviews(id INTEGER PRIMARY KEY, topic_id INTEGER, asset_type TEXT, asset_path TEXT, status TEXT, auto_qc_json TEXT DEFAULT '{}');
    CREATE TABLE video_jobs(id INTEGER PRIMARY KEY, topic_id INTEGER, status TEXT, output_path TEXT, qc_status TEXT, stale_reason TEXT);
    CREATE TABLE tts_runs(id INTEGER PRIMARY KEY, topic_id INTEGER, status TEXT, output_path TEXT);
    CREATE TABLE tts_segments(id INTEGER PRIMARY KEY, topic_id INTEGER, status TEXT, audio_path TEXT);
    CREATE TABLE fact_checks(topic_id INTEGER, claims_json TEXT, raw_json TEXT, status TEXT);
    CREATE TABLE production_briefs(topic_id INTEGER, status TEXT, visual_states_json TEXT);
    CREATE TABLE quality_findings(id INTEGER PRIMARY KEY, topic_id INTEGER, code TEXT, stage TEXT);
    INSERT INTO topics VALUES(1, 'fixture');
  `);
  return { dir, db, dbPath };
}
function cli(script, dbPath, args = []) {
  const child = spawnSync(process.execPath, [path.join(root, "scripts", script), "--db", dbPath, ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, DINOBOX_DB_PATH: dbPath }
  });
  assert.ok(child.stdout.trim(), child.stderr);
  return { status: child.status, report: JSON.parse(child.stdout) };
}

test("audit clean fixture exits 0 and never changes DB bytes", (t) => {
  const f = fixture(t);
  const before = readFileSync(f.dbPath);
  const result = cli("audit-pipeline.mjs", f.dbPath, ["--root", f.dir]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.report.findings, []);
  assert.deepEqual(readFileSync(f.dbPath), before);
});

test("audit detects orphan invocation and completed job with correlated failed quality", (t) => {
  const f = fixture(t);
  f.db.exec(`INSERT INTO jobs VALUES(1,1,'shotlist_generate','completed','{"qualityRunId":2}', '2026-01-01 00:00:00','2026-01-01 00:01:00');
    INSERT INTO ai_invocations VALUES(1,1,1,'running'),(2,NULL,1,'running'),(3,99,1,'running');
    INSERT INTO quality_runs VALUES(2,1,'shotlist_quality','fail','{}','','2026-01-01 00:00:30');`);
  const { status, report } = cli("audit-pipeline.mjs", f.dbPath, ["--root", f.dir]);
  assert.equal(status, 1);
  assert.equal(report.findings.filter(x => x.code === "orphan_invocation").length, 3);
  assert.ok(report.findings.some(x => x.code === "completed_job_quality_fail" && x.qualityRunId === 2));
});

test("audit checks real files, QC sidecars and stored/manifest OK freshness", (t) => {
  const f = fixture(t);
  const folder = path.join(f.dir, 'data/projects/topic-1');
  mkdirSync(path.join(folder, 'clean'), { recursive: true });
  mkdirSync(path.join(folder, 'manifests'), { recursive: true });
  const asset = 'data/projects/topic-1/clean/01_CLEAN.png';
  writeFileSync(path.join(f.dir, asset), Buffer.from('real fixture image bytes'));
  writeFileSync(path.join(f.dir, `${asset}.qc.json`), JSON.stringify({ passed: true, shotlistId: 1 }));
  writeFileSync(path.join(folder, 'manifests/CLEAN_ASSETS.md'), '| 1 | 01_CLEAN.png | OK | approved |\n| 2 | missing_CLEAN.png | OK | approved |\n');
  f.db.exec(`INSERT INTO shotlists VALUES(2,1,'stale','');
    INSERT INTO asset_reviews VALUES(1,1,'clean','${asset}','OK','{"shotlistId":1}');
    INSERT INTO tts_runs VALUES(1,1,'generated','missing.wav');`);
  const { status, report } = cli('audit-pipeline.mjs', f.dbPath, ['--root', f.dir]);
  assert.equal(status, 1);
  for (const code of ['stale_ok', 'missing_file', 'contract_mismatch']) assert.ok(report.findings.some(x => x.code === code), code);
  assert.ok(report.findings.some(x => x.code === 'missing_file' && x.path.endsWith('missing_CLEAN.png')));
});

test("audit accepts matching real artifact contract", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.dir, 'image.png'), 'fixture');
  writeFileSync(path.join(f.dir, 'image.png.qc.json'), '{"passed":true,"shotlistId":2}');
  f.db.exec(`INSERT INTO shotlists VALUES(2,1,'approved',''); INSERT INTO asset_reviews VALUES(1,1,'clean','image.png','OK','{"shotlistId":2}');`);
  assert.equal(cli('audit-pipeline.mjs', f.dbPath, ['--root', f.dir]).status, 0);
});

for (const script of ['audit-pipeline.mjs', 'quality-eval-report.mjs']) {
  test(`${script} missing database exits structured 2 without creating DB`, (t) => {
    const f = fixture(t);
    const missing = path.join(f.dir, 'missing.db');
    const { status, report } = cli(script, missing);
    assert.equal(status, 2);
    assert.equal(report.errors[0].code, 'database_unavailable');
    assert.equal(existsSync(missing), false);
  });
  test(`${script} missing schema exits structured 2`, (t) => {
    const f = fixture(t);
    f.db.exec('DROP TABLE quality_runs; DROP TABLE quality_findings;');
    const { status, report } = cli(script, f.dbPath);
    assert.equal(status, 2);
    assert.equal(report.errors[0].code, 'database_query_failed');
  });
  test(`${script} import has no filesystem/CLI side effects`, (t) => {
    const f = fixture(t);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL(`../scripts/${script}`, import.meta.url).href)})`], {
      cwd: f.dir, encoding: 'utf8', env: { ...process.env, DINOBOX_DB_PATH: path.join(f.dir, 'absent.db') }
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
  });
}

test('audit correlates legacy timestamps and detects manual provenance file hash mismatch', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.dir, 'image.png'), 'changed bytes');
  writeFileSync(path.join(f.dir, 'image.png.qc.json'), '{"shotlistId":2}');
  f.db.exec(`INSERT INTO shotlists VALUES(2,1,'approved','');
    INSERT INTO asset_reviews VALUES(1,1,'clean','image.png','OK','{"manualProvenance":{"assetHashAfter":"wrong"}}');
    INSERT INTO jobs VALUES(1,1,'shotlist_generate','completed','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z');
    INSERT INTO quality_runs VALUES(1,1,'shotlist_quality','fail','{}','','2026-01-01 00:00:30');`);
  const { report } = cli('audit-pipeline.mjs', f.dbPath, ['--root', f.dir]);
  assert.ok(report.findings.some(x => x.code === 'completed_job_quality_fail'));
  assert.ok(report.findings.some(x => x.code === 'contract_mismatch' && x.reason === 'asset_hash'));
});

test('audit validates against actual server DDL without importing server', (t) => {
  const f = fixture(t);
  const actualPath = path.join(f.dir, 'schema.db');
  const actual = new DatabaseSync(actualPath);
  const source = readFileSync(path.join(root, 'server.js'), 'utf8');
  for (const match of source.matchAll(/CREATE TABLE IF NOT EXISTS [\s\S]*?\n  \);/gu)) actual.exec(match[0]);
  for (const match of source.matchAll(/ensureColumn\("([^"]+)", "([^"]+)", "([^"]+)"\)/gu)) {
    if (!actual.prepare(`PRAGMA table_info("${match[1]}")`).all().some(row => row.name === match[2])) actual.exec(`ALTER TABLE "${match[1]}" ADD COLUMN "${match[2]}" ${match[3]}`);
  }
  actual.close();
  const result = cli('audit-pipeline.mjs', actualPath, ['--root', f.dir]);
  assert.equal(result.status, 0, JSON.stringify(result.report));
});

test('quality report historical misses exit 1 rather than success', (t) => {
  const f = fixture(t);
  const { status, report } = cli('quality-eval-report.mjs', f.dbPath);
  assert.equal(status, 1);
  assert.ok(report.totals.recordedKnownBadMisses > 0);
});

test('quality report gold misses fail even without historical misses', async (t) => {
  const f = fixture(t);
  const { runQualityReport } = await import('../scripts/quality-eval-report.mjs');
  const report = runQualityReport({ dbPath: f.dbPath, benchmarks: [], goldCases: [{ caseKey: 'bad', expectedIssueCodes: ['deliberately_missing'], factCheck: {}, productionBrief: {} }] });
  assert.equal(report.exitCode, 1);
  assert.ok(report.totals.goldRegressionMisses > 0);
  assert.equal(runQualityReport({ dbPath: f.dbPath, benchmarks: [], goldCases: [] }).exitCode, 0);
});
