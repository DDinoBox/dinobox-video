import { existsSync, readFileSync, realpathSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const currentFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(currentFile), "..");

export function auditPipeline({ root = defaultRoot, dbPath = process.env.DINOBOX_DB_PATH || path.join(root, "data/shorts.db"), projectsDir = path.join(root, "data/projects") } = {}) {
  const report = { database: dbPath, readOnly: true, generatedAt: new Date().toISOString(), findings: [], errors: [], exitCode: 0 };
  let db;
  let phase = "database_unavailable";
  const finding = (code, detail) => report.findings.push({ code, ...detail });
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    phase = "database_query_failed";
    db.exec("BEGIN");
    // Explicit projections validate the required legacy schema even for empty tables.
    const queries = {
      topics: "SELECT id FROM topics", jobs: "SELECT id, topic_id, type, status, result_json, started_at, completed_at FROM jobs",
      invocations: "SELECT id, job_id, topic_id, status FROM ai_invocations",
      quality: "SELECT id, topic_id, stage, status, metrics_json, artifact_ref, created_at FROM quality_runs",
      shotlists: "SELECT id, topic_id, status, manifest_path FROM shotlists ORDER BY id",
      reviews: "SELECT id, topic_id, asset_type, asset_path, status, auto_qc_json FROM asset_reviews",
      videos: "SELECT id, topic_id, status, output_path, qc_status, stale_reason FROM video_jobs",
      tts: "SELECT id, topic_id, status, output_path FROM tts_runs",
      segments: "SELECT id, topic_id, status, audio_path FROM tts_segments"
    };
    const rows = Object.fromEntries(Object.entries(queries).map(([name, sql]) => [name, db.prepare(sql).all()]));
    phase = "audit_failed";
    const json = (value, context) => {
      try { return JSON.parse(value || "{}"); }
      catch (error) { finding("invalid_json", { ...context, message: error.message }); return {}; }
    };
    const boundary = realpathSync(root);
    const inside = (file) => { const rel = path.relative(boundary, file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
    const checkFile = (value, context = {}) => {
      const file = path.resolve(root, String(value || "").replace(/\\/gu, "/"));
      if (!inside(file)) { finding("unsafe_path", { ...context, path: value }); return null; }
      try {
        if (!value) { finding("missing_file", { ...context, path: value }); return null; }
        if (!inside(realpathSync(file))) { finding("unsafe_path", { ...context, path: value }); return null; }
        const stat = statSync(file);
        if (!stat.isFile() || stat.size === 0) { finding("missing_file", { ...context, path: value, reason: "not_a_nonempty_file" }); return null; }
        return file;
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error.code)) finding("missing_file", { ...context, path: value });
        else throw error;
        return null;
      }
    };
    const jobs = new Map(rows.jobs.map(row => [row.id, row]));
    for (const invocation of rows.invocations) {
      const job = jobs.get(invocation.job_id);
      if (invocation.status === "running" && (!job || job.status !== "running")) finding("orphan_invocation", { invocationId: invocation.id, jobId: invocation.job_id, jobStatus: job?.status || null, topicId: invocation.topic_id });
    }
    const timestamp = value => Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/u.test(value || "") ? `${value.replace(" ", "T")}Z` : value);
    const stageMap = { fact_check: "fact", production_brief_generate: "production_brief", script_generate: "script", shotlist_generate: "shotlist", clean_image_generate: "clean", info_image_generate: "info" };
    for (const job of rows.jobs.filter(row => row.status === "completed")) {
      const result = json(job.result_json, { jobId: job.id });
      const explicitlyBound = rows.quality.filter(run => run.id === result.qualityRunId || run.id === result.convergence?.runId);
      const candidates = explicitlyBound.length ? explicitlyBound : rows.quality.filter(run => {
        const prefix = stageMap[job.type];
        return prefix && run.topic_id === job.topic_id && (run.stage === prefix || run.stage.startsWith(`${prefix}_`))
          && job.started_at && job.completed_at && timestamp(run.created_at) >= timestamp(job.started_at) && timestamp(run.created_at) <= timestamp(job.completed_at);
      }).sort((a, b) => b.id - a.id).slice(0, 1);
      for (const run of candidates) if (["fail", "failed", "reject", "hold"].includes(run.status.toLowerCase())) finding("completed_job_quality_fail", { jobId: job.id, topicId: job.topic_id, qualityRunId: run.id, stage: run.stage, correlation: explicitlyBound.length ? "explicit_id" : "topic_stage_time_window" });
    }
    const latest = new Map(rows.shotlists.map(row => [row.topic_id, row]));
    const auditAsset = (assetPath, topicId, status, stored = {}, source = "asset_reviews") => {
      const context = { topicId, path: assetPath, source };
      const file = checkFile(assetPath, context);
      let disk = {};
      if (file) {
        const qcPath = checkFile(`${file}.qc.json`, { topicId, source: "qc_sidecar" });
        if (qcPath) disk = json(readFileSync(qcPath, "utf8"), { path: qcPath });
      }
      const shotlist = latest.get(topicId);
      const qc = { ...disk, ...stored };
      const mismatched = !shotlist || Number(qc.shotlistId || 0) !== shotlist.id;
      const disagreement = disk.shotlistId !== undefined && stored.shotlistId !== undefined && Number(disk.shotlistId) !== Number(stored.shotlistId);
      if (mismatched || disagreement) finding("contract_mismatch", { ...context, expectedShotlistId: shotlist?.id || null, storedShotlistId: stored.shotlistId ?? null, fileShotlistId: disk.shotlistId ?? null });
      const recordedHash = stored.manualProvenance?.assetHashAfter || stored.assetHashAfter;
      if (file && recordedHash && createHash("sha256").update(readFileSync(file)).digest("hex") !== recordedHash) finding("contract_mismatch", { ...context, reason: "asset_hash" });
      if (status === "OK" && (mismatched || disagreement || shotlist?.status === "stale" || qc.stale || disk.stale)) finding("stale_ok", context);
    };
    for (const review of rows.reviews) auditAsset(review.asset_path, review.topic_id, review.status, json(review.auto_qc_json, { reviewId: review.id }));
    for (const topic of rows.topics) {
      const project = path.join(projectsDir, `topic-${topic.id}`);
      const manifest = path.join(project, "manifests/CLEAN_ASSETS.md");
      const reviewed = new Set(rows.reviews.filter(row => row.topic_id === topic.id).map(row => path.resolve(root, row.asset_path)));
      const manifested = new Set();
      if (existsSync(manifest)) {
        const safe = checkFile(manifest, { topicId: topic.id, source: "manifest" });
        if (safe) for (const line of readFileSync(safe, "utf8").split(/\r?\n/u)) {
          const cells = line.split("|").map(cell => cell.trim()).filter(Boolean);
          if (!/^\d+$/u.test(cells[0] || "") || cells.length < 3) continue;
          const asset = path.join(project, "clean", cells[1]);
          manifested.add(asset);
          // Manifest approval is independent of the DB review status and must also be audited.
          auditAsset(asset, topic.id, cells[2], {}, "manifest");
        }
      }
      for (const kind of ["clean", "info"]) {
        const folder = path.join(project, kind);
        if (!existsSync(folder)) continue;
        if (!inside(realpathSync(folder))) { finding("unsafe_path", { path: folder }); continue; }
        for (const name of readdirSync(folder).filter(name => name.endsWith(`_${kind.toUpperCase()}.png`))) {
          const file = path.join(folder, name);
          if (!reviewed.has(file) && !manifested.has(file)) auditAsset(file, topic.id, "REVIEW", {}, "project_file");
        }
      }
    }
    for (const row of rows.shotlists) if (row.manifest_path) checkFile(row.manifest_path, { shotlistId: row.id });
    for (const row of rows.tts) if (row.output_path || row.status === "generated") checkFile(row.output_path, { ttsRunId: row.id });
    for (const row of rows.segments) if (row.audio_path || row.status === "generated") checkFile(row.audio_path, { ttsSegmentId: row.id });
    for (const row of rows.videos) {
      if (row.output_path && row.status !== "queued" || row.status === "completed") checkFile(row.output_path, { videoJobId: row.id });
      if (["approved", "OK"].includes(row.qc_status) && (row.status === "stale" || row.stale_reason)) finding("stale_ok", { videoJobId: row.id });
    }
    db.exec("COMMIT");
    report.exitCode = report.findings.length ? 1 : 0;
  } catch (error) {
    report.errors.push({ code: phase, message: error.message });
    report.exitCode = 2;
  } finally { db?.close(); }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const options = {};
  const flags = { "--db": "dbPath", "--root": "root", "--projects": "projectsDir" };
  let invalid = false;
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!flags[process.argv[i]] || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) { invalid = true; break; }
    options[flags[process.argv[i]]] = path.resolve(process.argv[i + 1]);
  }
  const report = invalid ? { errors: [{ code: "invalid_arguments", message: "Usage: node scripts/audit-pipeline.mjs [--db PATH] [--root PATH] [--projects PATH]" }], exitCode: 2 } : auditPipeline(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
}
