import { readFileSync, realpathSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyBatchLedger } from "../lib/pipeline-batch-verification.js";
import { hashPipelineInputSnapshot, hashPipelineVisualSnapshot, hashPipelineCleanClipSnapshot, hashPipelineInfoClipSnapshot } from "../lib/pipeline-contract.js";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), "..");
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");

// This read-only gate verifies decoded images and the run's ledger, including
// its parent batch when present. It does not prove semantics or human approval.
export function verifyPipelineRun({ root = projectRoot, dbPath, contract, python } = {}) {
  const report = { readOnly: true, scope: "single_run_ledger_and_media", runId: contract?.runId, machinePassed: false, visualReviewRequired: true, findings: [], errors: [], counts: {}, exitCode: 2 };
  const finding = (code, detail = {}) => report.findings.push({ code, ...detail });
  let db;
  try {
    const boundary = realpathSync(root);
    const safeFile = value => {
      if (typeof value !== "string" || !value) throw Error("file_path_missing");
      const file = realpathSync(path.resolve(boundary, value));
      const relative = path.relative(boundary, file);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !statSync(file).isFile()) throw Error("unsafe_file_path");
      return file;
    };
    if (contract?.version !== 1 || !contract.runId || !contract.runInputHash || !contract.stageInputHashes?.clean || !contract.stageInputHashes?.info
      || !Array.isArray(contract.clips) || !contract.clips.length) throw Error("invalid_verification_contract");
    const keys = contract.clips.map(clip => String(clip.key));
    if (new Set(keys).size !== keys.length || keys.some(key => !/^[1-9]\d*$/u.test(key))) throw Error("invalid_clip_keys");
    if (contract.clips.some(clip => typeof clip.requiredOverlay !== "boolean" || !clip.infoSpec || clip.infoSpec.requiresOverlay !== clip.requiredOverlay)) throw Error("overlay_contract_missing");
    if (contract.clips.filter(clip => clip.requiredOverlay).length < 2) throw Error("at_least_two_required_info_clips");
    db = new DatabaseSync(safeFile(dbPath), { readOnly: true });
    db.exec("BEGIN");
    const run = db.prepare("SELECT * FROM pipeline_runs WHERE id=?").get(contract.runId);
    if (!run) throw Error("pipeline_run_missing");
    if (contract.batchId && contract.batchId !== run.batch_id) finding("batch_binding_mismatch");
    if (run.batch_id) {
      report.scope = "batch_ledger_and_selected_run_media";
      report.batch = verifyBatchLedger(db, run, contract);
      report.findings.push(...report.batch.findings);
    }
    if (run.input_hash !== contract.runInputHash) finding("run_revision_mismatch");
    if (run.status !== "awaiting_user_review") finding("run_not_awaiting_user_review", { status: run.status });
    const capabilities = JSON.parse(run.capabilities_json);
    if (capabilities.h3 !== false || capabilities.video !== false) finding("video_capability_enabled");
    if (run.invocations_used > run.max_invocations || run.attempts_used > run.max_attempts) finding("budget_exceeded");
    const jobs = db.prepare("SELECT * FROM jobs WHERE run_id=? ORDER BY id").all(run.id);
    const attempts = db.prepare("SELECT * FROM pipeline_attempts WHERE run_id=? ORDER BY id").all(run.id);
    const artifacts = db.prepare("SELECT * FROM pipeline_artifacts WHERE run_id=? ORDER BY id").all(run.id);
    report.counts = { jobs: jobs.length, attempts: attempts.length, clean: artifacts.filter(a => a.kind === "clean").length, info: artifacts.filter(a => a.kind === "info").length, requiredInfo: 0 };
    if (run.attempts_used !== attempts.length || run.invocations_used !== attempts.reduce((sum, a) => sum + a.invocation_count, 0)) finding("budget_ledger_mismatch");
    const allowedStages = new Set(["script", "tts", "shotlist", "clean", "info", "continue"]);
    for (const job of jobs) {
      if (!allowedStages.has(job.pipeline_stage) || /h3|video/iu.test(job.type)) finding("forbidden_job", { jobId: job.id });
      if (job.status !== "completed") finding("unfinished_job", { jobId: job.id, status: job.status });
      if (job.lease_token || job.lease_expires_ms) finding("residual_lease", { jobId: job.id });
      if (!attempts.some(a => a.job_id === job.id && a.status === "succeeded")) finding("successful_attempt_missing", { jobId: job.id });
    }
    const repairs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pipeline_clean_repairs'").get()
      ? db.prepare('SELECT * FROM pipeline_clean_repairs WHERE run_id=?').all(run.id) : [];
    if (jobs.filter(job => job.pipeline_stage === "info").length !== 1 + repairs.length) finding("info_batch_count_mismatch");
    if (new Set(jobs.map(job => job.logical_task_key)).size !== jobs.length || jobs.some(job => !job.logical_task_key)) finding("duplicate_or_unbound_job");
    for (const attempt of attempts) if (!["succeeded", "abandoned_before_provider"].includes(attempt.status)) finding("unresolved_attempt", { attemptId: attempt.id, status: attempt.status });
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_invocations'").get()) {
      for (const invocation of db.prepare("SELECT id,status FROM ai_invocations WHERE job_id IN (SELECT id FROM jobs WHERE run_id=?) AND status IN ('running','queued','reconcile_required')").all(run.id)) finding("orphan_invocation", { invocationId: invocation.id, status: invocation.status });
    }
    const selected = new Map();
    const watched = new Map();
    for (const artifact of artifacts) {
      const identity = `${artifact.kind}:${artifact.clip_key}`;
      if (!["clean", "info"].includes(artifact.kind) || !keys.includes(artifact.clip_key)) { finding("unexpected_artifact", { artifactId: artifact.id }); continue; }
      const metadata = JSON.parse(artifact.metadata_json);
      const previous = selected.get(identity);
      if (previous) {
        const repair = repairs.find(row => row.id === metadata.cleanRepairId && row.clip_key === artifact.clip_key);
        const repairContract = repair && JSON.parse(repair.contract_json);
        const expected = artifact.kind === 'clean' ? repair?.before_artifact_id : repairContract?.beforeInfoArtifactId;
        const repairJob = jobs.find(row => row.id === artifact.job_id);
        if (!repair || expected !== previous.id || metadata.supersedesArtifactId !== previous.id
          || JSON.parse(repairJob?.payload_json || '{}').cleanRepairId !== repair.id
          || repairJob?.operation_kind !== (artifact.kind === 'clean' ? 'explicit_clean_repair' : 'clean_repair_info')) finding("duplicate_artifact", { identity });
      }
      selected.set(identity, artifact);
      const superseded = artifacts.some(row => row.id > artifact.id && row.kind === artifact.kind && row.clip_key === artifact.clip_key);
      const revisionChanged = !superseded && artifact.input_hash !== contract.stageInputHashes[artifact.kind];
      if (artifact.quality !== "pass" || artifact.freshness !== "current") finding("artifact_not_current_pass", { identity });
      if (!["pending", "approved"].includes(artifact.user_approval)) finding("invalid_user_approval", { identity });
      const job = jobs.find(job => job.id === artifact.job_id);
      if (!job || job.run_id !== run.id || job.topic_id !== run.topic_id || job.status !== 'completed' || job.pipeline_stage !== artifact.kind || job.input_revision !== artifact.input_hash) finding("artifact_job_contract_mismatch", { identity });
      try {
        const original = JSON.parse(job?.payload_json || '{}').inputSnapshot;
        if (original?.topicId !== run.topic_id || original?.stage !== artifact.kind || hashPipelineInputSnapshot(original) !== artifact.input_hash) finding('artifact_original_snapshot_mismatch', { identity });
      } catch { finding('artifact_original_snapshot_mismatch', { identity }); }
      const clipBinding = metadata[artifact.kind === 'clean' ? 'cleanClipBinding' : 'infoClipBinding'];
      if (clipBinding) {
        const original = JSON.parse(job?.payload_json || '{}').inputSnapshot;
        const fingerprint = artifact.kind === 'clean' ? hashPipelineCleanClipSnapshot : hashPipelineInfoClipSnapshot;
        if (clipBinding.version !== 1 || clipBinding.clipKey !== artifact.clip_key || original?.topicId !== run.topic_id
          || original?.stage !== artifact.kind || hashPipelineInputSnapshot(original) !== artifact.input_hash
          || fingerprint(original, artifact.clip_key) !== clipBinding.fingerprint) finding('artifact_original_clip_binding_mismatch', { identity });
      }
      let reusedFingerprint, bindingKey = 'visualBinding';
      if (revisionChanged) {
        try {
          const current = contract.currentInputSnapshots?.[artifact.kind];
          const original = JSON.parse(job?.payload_json || "{}").inputSnapshot;
          if (current?.stage === artifact.kind && current.topicId === run.topic_id
            && original?.stage === artifact.kind && original.topicId === run.topic_id
            && hashPipelineInputSnapshot(current) === contract.stageInputHashes[artifact.kind]
            && hashPipelineInputSnapshot(original) === artifact.input_hash) {
            const clipKey = artifact.kind === 'clean' ? 'cleanClipBinding' : 'infoClipBinding';
            for (const key of ['visualBinding', clipKey]) {
              const binding = metadata[key];
              const fingerprint = snapshot => key === 'visualBinding' ? hashPipelineVisualSnapshot(snapshot)
                : (artifact.kind === 'clean' ? hashPipelineCleanClipSnapshot : hashPipelineInfoClipSnapshot)(snapshot, artifact.clip_key);
              if (binding?.version === 1 && (key === 'visualBinding' || binding.clipKey === artifact.clip_key)
                && fingerprint(original) === binding.fingerprint && fingerprint(current) === binding.fingerprint) {
                reusedFingerprint = binding.fingerprint; bindingKey = key; break;
              }
            }
          }
        } catch { /* Missing/legacy/malformed bindings never acquire fresh approval. */ }
        if (!reusedFingerprint) finding("artifact_revision_mismatch", { identity });
      }
      try {
        artifact.file = safeFile(artifact.path);
        watched.set(artifact.file, sha(artifact.file));
        if (watched.get(artifact.file) !== artifact.content_hash) finding("artifact_hash_mismatch", { identity });
        const manifestPath = safeFile(path.join(path.dirname(artifact.file), "manifest.json"));
        watched.set(manifestPath, sha(manifestPath));
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const published = manifest.artifacts?.find(a => String(a.clip) === artifact.clip_key && a.kind === artifact.kind
          && a.contentHash === artifact.content_hash && a.inputHash === artifact.input_hash && path.resolve(a.path) === artifact.file);
        if (manifest.runId !== run.id || manifest.jobId !== artifact.job_id || !published
          || !attempts.some(a => a.job_id === artifact.job_id && a.lease_token === manifest.leaseToken && a.status === "succeeded")
          || ['cleanClipBinding','infoClipBinding','cleanRepairId','supersedesArtifactId'].some(key => JSON.stringify(published[key]) !== JSON.stringify(metadata[key]))
          || (reusedFingerprint && (published[bindingKey]?.version !== 1 || published[bindingKey].fingerprint !== reusedFingerprint))) finding("artifact_manifest_mismatch", { identity });
        else if (reusedFingerprint) (report.reusedVisualArtifacts ||= []).push(identity);
      } catch (error) { finding("artifact_file_invalid", { identity, message: error.message }); }
    }
    for (const kind of ["clean", "info"]) {
      const rows = [...selected.values()].filter(artifact => artifact.kind === kind);
      report.counts[kind] = rows.length;
      if (new Set(rows.map(artifact => artifact.content_hash)).size !== rows.length) finding("duplicate_image_content", { kind });
    }
    const qcJobs = [];
    const evidenceFile = value => { const file = safeFile(value); watched.set(file, sha(file)); return file; };
    for (const clip of contract.clips) {
      const clean = selected.get(`clean:${clip.key}`);
      const info = selected.get(`info:${clip.key}`);
      if (!clean || !info) { finding("clip_pair_missing", { clip: clip.key }); continue; }
      if (clean.file) qcJobs.push({ mode: "image", path: clean.file, identity: `clean:${clip.key}` });
      try {
        const metadata = JSON.parse(info.metadata_json);
        if (clip.requiredOverlay && (!metadata.requiredOverlay || metadata.overlayType === "none" || !metadata.overlayType || clip.infoSpec.type === "none")) finding("required_info_missing", { clip: clip.key });
        const evidence = clip.infoEvidence || metadata.infoEvidence;
        if (!evidence) throw Error("info_evidence_missing");
        const render = JSON.parse(readFileSync(evidenceFile(evidence.renderPath), "utf8"));
        for (const label of render.labelBoxes || []) label.fontPath = evidenceFile(label.fontPath);
        qcJobs.push({ mode: "info", identity: `info:${clip.key}`, cleanPath: clean.file, infoPath: info.file,
          overlayPath: evidenceFile(evidence.overlayPath), guidesPath: evidenceFile(evidence.guidesPath), labelsPath: evidenceFile(evidence.labelsPath),
          spec: clip.infoSpec, claimRefs: clip.claimRefs || [], layoutTrusted: clip.layoutTrusted === true, render, required: clip.requiredOverlay });
      } catch (error) { finding("info_evidence_invalid", { clip: clip.key, message: error.message }); }
    }
    const executable = python || (process.platform === "win32" ? path.join(projectRoot, ".venv/Scripts/python.exe") : path.join(projectRoot, ".venv/bin/python"));
    if (!existsSync(executable)) throw Error("python_environment_missing");
    const result = spawnSync(executable, ["-B", "-c", [
      "import sys,json",
      "sys.path.insert(0,sys.argv[1])",
      "from media_qc import inspect_image,inspect_info",
      "results=[]",
      "for job in json.load(sys.stdin):",
      "    try:",
      "        qc=inspect_image(job['path'],[]) if job['mode']=='image' else inspect_info(job)",
      "    except Exception as error:",
      "        qc={'passed':False,'errors':[str(error)]}",
      "    results.append({'identity':job['identity'],'required':job.get('required',False),'qc':qc})",
      "print(json.dumps(results,ensure_ascii=False))"
    ].join("\n"), path.join(projectRoot, "scripts")], { input: JSON.stringify(qcJobs), encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    if (result.status !== 0) throw Error(`media_qc_execution_failed:${result.error?.message || result.stderr}`);
    report.media = JSON.parse(result.stdout);
    for (const item of report.media) {
      if (item.qc.passed !== true) finding("decoded_media_qc_failed", { identity: item.identity, errors: item.qc.errors });
      if (item.required && item.qc.passed === true && item.qc.visibleOverlayCoverage >= 0.0005) report.counts.requiredInfo++;
    }
    if (report.media.length !== contract.clips.length * 2) finding("media_verification_incomplete");
    if (report.counts.requiredInfo !== contract.clips.filter(c => c.requiredOverlay).length) finding("required_info_count_mismatch");
    for (const [file, hash] of watched) if (sha(file) !== hash) finding("file_changed_during_verification", { file });
    db.exec("COMMIT");
    report.machinePassed = report.findings.length === 0;
    report.exitCode = report.machinePassed ? 0 : 1;
  } catch (error) {
    report.errors.push({ code: "verification_failed", message: error.message });
  } finally { db?.close(); }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  let report;
  try {
    const options = {};
    const flags = { "--db": "dbPath", "--root": "root", "--contract": "contractPath", "--python": "python" };
    for (let index = 2; index < process.argv.length; index += 2) {
      if (!flags[process.argv[index]] || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw Error("Usage: node scripts/verify-pipeline-run.mjs --db PATH --contract PATH [--root PATH] [--python PATH]");
      options[flags[process.argv[index]]] = path.resolve(process.argv[index + 1]);
    }
    if (!options.dbPath || !options.contractPath) throw Error("--db and --contract are required; there is no live default");
    report = verifyPipelineRun({ ...options, contract: JSON.parse(readFileSync(options.contractPath, "utf8")) });
  } catch (error) { report = { exitCode: 2, errors: [{ code: "invalid_arguments", message: error.message }] }; }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
}
