import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PipelineStore } from "../lib/pipeline-store.js";
import { hashPipelineInputSnapshot } from "../lib/pipeline-contract.js";
const snapshots = Object.fromEntries(['clean', 'info'].map(stage => [stage, { schemaVersion: 1, topicId: 1, stage, fact: null, brief: null }]));
const revisions = Object.fromEntries(Object.entries(snapshots).map(([stage, snapshot]) => [stage, hashPipelineInputSnapshot(snapshot)]));
import { PipelineRunner } from "../lib/pipeline-runner.js";
import { verifyPipelineRun } from "../scripts/verify-pipeline-run.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = path.join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");

test("real renderers produce 7+7 decoded artifacts; read-only acceptance rejects corrupt, stale and missing evidence", async t => {
  mkdirSync(path.join(root, "tmp"), { recursive: true });
  const dir = mkdtempSync(path.join(root, "tmp/pipeline-verification-"));
  const dbPath = path.join(dir, "run.db");
  const generated = spawnSync(python, ["-B", path.join(root, "test/fixtures/render-pipeline-media.py"), dir], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 120000, env: { ...process.env, PYTHONIOENCODING: "utf-8" }
  });
  assert.equal(generated.status, 0, generated.stderr);
  const clips = JSON.parse(generated.stdout);
  const db = new DatabaseSync(dbPath);
  try {
    const store = new PipelineStore(db);
    const run = store.createRun({ topicId: 1, lane: "production_canary", requestKey: "real-renderer-fixture", inputHash: "initial-contract" });
    const runner = new PipelineRunner(store, { artifactRoot: dir });
    const task = (stage, scope = "batch") => ({ stage, scope, inputHash: revisions[stage], payload: { inputSnapshot: snapshots[stage] }, type: `${stage}_image_generate` });
    for (const clip of clips) store.enqueue(run.id, task("clean", clip.key));
    for (const clip of clips) {
      const row = store.jobs(run.id).find(job => job.scope_key === clip.key);
      const result = await runner.execute(store.claim(row.id), async () => ({
        artifacts: [{ path: clip.cleanPath, clip: clip.key, kind: "clean", quality: "pass", freshness: "current", userApproval: "pending", inputHash: revisions.clean }],
        successors: clip.key === "7" ? [task("info")] : []
      }));
      assert.equal(result.status, "succeeded", result.error);
    }
    const infoJob = store.jobs(run.id).find(job => job.pipeline_stage === "info");
    assert.equal((await runner.execute(store.claim(infoJob.id), async () => ({ artifacts: clips.map(clip => ({
      path: clip.infoPath, clip: clip.key, kind: "info", quality: "pass", freshness: "current", userApproval: "pending", inputHash: revisions.info,
      requiredOverlay: clip.requiredOverlay, overlayType: clip.infoSpec.type, infoEvidence: clip.infoEvidence
    })), status: "awaiting_user_review" }))).status, "succeeded");
    const contract = { version: 1, runId: run.id, runInputHash: "initial-contract", stageInputHashes: { clean: revisions.clean, info: revisions.info }, clips };
    const verify = override => verifyPipelineRun({ root, dbPath, python, contract: override || contract });
    for (const payload of [{}, { inputSnapshot: { ...snapshots.info, brief: 'tampered' } }]) await t.test('same revision requires the original snapshot: ' + JSON.stringify(payload), () => {
      db.prepare('UPDATE jobs SET payload_json=? WHERE id=?').run(JSON.stringify(payload), infoJob.id);
      try { assert.ok(verify().findings.some(f => f.code === 'artifact_original_snapshot_mismatch')); }
      finally { db.prepare('UPDATE jobs SET payload_json=? WHERE id=?').run(infoJob.payload_json, infoJob.id); }
    });
    for (const header of ['runId', 'jobId', 'leaseToken']) await t.test('manifest header binding rejects ' + header, () => {
      const artifact = store.artifacts(run.id)[0];
      const file = path.join(path.dirname(artifact.path), 'manifest.json');
      const bytes = readFileSync(file);
      try {
        const manifest = JSON.parse(bytes); manifest[header] = 'forged'; writeFileSync(file, JSON.stringify(manifest));
        assert.ok(verify().findings.some(f => f.code === 'artifact_manifest_mismatch'));
      } finally { writeFileSync(file, bytes); }
    });
    await t.test("actual image QC, immutable hashes and ledger pass without changing SQLite or granting user approval", () => {
      const before = hash(dbPath);
      const result = verify();
      assert.equal(result.exitCode, 0, JSON.stringify(result.findings.concat(result.errors)));
      assert.equal(result.machinePassed, true);
      assert.equal(result.visualReviewRequired, true);
      assert.equal(result.scope, "single_run_ledger_and_media");
      assert.equal(result.counts.clean, 7);
      assert.equal(result.counts.info, 7);
      assert.equal(result.counts.requiredInfo, 2);
      assert.equal(result.media.length, 14);
      assert.equal(hash(dbPath), before);
      assert.equal(store.artifacts(run.id).every(artifact => artifact.user_approval === "pending"), true);
    });
    await t.test("a pending ledger job prevents a green result", () => {
      db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(infoJob.id);
      const result = verify();
      assert.equal(result.machinePassed, false);
      assert.ok(result.findings.some(f => f.code === "unfinished_job"));
      db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(infoJob.id);
    });
    await t.test("a new expected input revision cannot reuse old pass metadata", () => {
      const changed = structuredClone(contract);
      changed.stageInputHashes.clean = "clean-new-revision";
      const result = verify(changed);
      assert.equal(result.machinePassed, false);
      assert.equal(result.findings.filter(f => f.code === "artifact_revision_mismatch").length, 7);
    });
    await t.test("missing INFO layers fail closed despite stored quality pass", () => {
      const changed = structuredClone(contract);
      changed.clips[0].infoEvidence.overlayPath = path.join(dir, "missing.png");
      const result = verify(changed);
      assert.equal(result.machinePassed, false);
      assert.ok(result.findings.some(f => f.code === "info_evidence_invalid"));
    });
    await t.test("repeating one image under different clip keys cannot satisfy the count", () => {
      const artifacts = store.artifacts(run.id).filter(a => a.kind === "clean");
      db.prepare("UPDATE pipeline_artifacts SET content_hash=? WHERE id=?").run(artifacts[0].content_hash, artifacts[1].id);
      try {
        const result = verify();
        assert.equal(result.machinePassed, false);
        assert.ok(result.findings.some(f => f.code === "duplicate_image_content"));
      } finally { db.prepare("UPDATE pipeline_artifacts SET content_hash=? WHERE id=?").run(artifacts[1].content_hash, artifacts[1].id); }
    });
    await t.test("PNG signature alone is not an image, even when DB and manifest hashes are updated", () => {
      const artifact = store.artifacts(run.id).find(a => a.kind === "clean" && a.clip_key === "1");
      const original = readFileSync(artifact.path);
      const manifestPath = path.join(path.dirname(artifact.path), "manifest.json");
      const manifestBytes = readFileSync(manifestPath);
      try {
        writeFileSync(artifact.path, Buffer.from("89504e470d0a1a0a", "hex"));
        const brokenHash = hash(artifact.path);
        db.prepare("UPDATE pipeline_artifacts SET content_hash=? WHERE id=?").run(brokenHash, artifact.id);
        const manifest = JSON.parse(manifestBytes);
        manifest.artifacts[0].contentHash = brokenHash;
        writeFileSync(manifestPath, JSON.stringify(manifest));
        const result = verify();
        assert.equal(result.machinePassed, false);
        assert.ok(result.findings.some(f => f.code === "decoded_media_qc_failed" && f.identity === "clean:1"));
      } finally {
        writeFileSync(artifact.path, original);
        writeFileSync(manifestPath, manifestBytes);
        db.prepare("UPDATE pipeline_artifacts SET content_hash=? WHERE id=?").run(artifact.content_hash, artifact.id);
      }
    });
    await t.test("the acceptance contract cannot reduce required INFO count to zero", () => {
      const changed = structuredClone(contract);
      for (const clip of changed.clips) { clip.requiredOverlay = false; clip.infoSpec.requiresOverlay = false; }
      const result = verify(changed);
      assert.equal(result.machinePassed, false);
      assert.equal(result.exitCode, 2);
      assert.match(result.errors[0].message, /at_least_two/);
    });
    await t.test("CLI requires explicit database and contract; no production default", () => {
      const result = spawnSync(process.execPath, ["scripts/verify-pipeline-run.mjs"], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 2);
      assert.match(JSON.parse(result.stdout).errors[0].message, /no live default/);
    });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("batch verification includes rejected candidates rather than only the winner", async t => {
  const { verifyBatchLedger } = await import("../lib/pipeline-batch-verification.js");
  const db = new DatabaseSync(":memory:");
  try {
    const store = new PipelineStore(db);
    const startContract = { requiredVisualStates: 7, minimumRequiredInfoOverlays: 2 };
    const batch = store.createBatch({ requestKey: "audit-batch", lane: "production_canary", candidates: [
      { topicId: 1, inputHash: "first", startContract }, { topicId: 2, inputHash: "second", startContract }
    ] });
    const first = store.startNextCandidate(batch.id);
    const task = inputHash => ({ stage: "continue", type: "pipeline_continue", inputHash });
    const firstJob = store.claim(store.enqueue(first.id, task("first")).id);
    store.complete(firstJob);
    store.rejectCandidate(first.id);
    const selected = store.startNextCandidate(batch.id);
    const selectedJob = store.claim(store.enqueue(selected.id, task("second")).id);
    store.reserveInvocation(selectedJob);
    store.complete(selectedJob, { status: "awaiting_user_review" });
    const contract = { clips: Array.from({ length: 7 }, (_, index) => ({ key: String(index + 1), requiredOverlay: index < 2 })) };
    const verify = (input = contract) => verifyBatchLedger(db, store.getRun(selected.id), input);
    await t.test("settled ordered candidates reconcile with shared counters and leave DB unchanged", () => {
      const before = db.prepare("SELECT total_changes() AS count").get().count;
      const report = verify();
      assert.deepEqual(report.findings, []);
      assert.equal(report.runs, 2);
      assert.equal(report.attempts, 2);
      assert.equal(report.invocations, 1);
      assert.equal(db.prepare("SELECT total_changes() AS count").get().count, before);
    });
    async function corrupt(name, mutation, expectedCode) {
      await t.test(name, () => {
        db.exec("SAVEPOINT tamper");
        try {
          mutation();
          assert.ok(verify().findings.some(item => item.code === expectedCode), JSON.stringify(verify().findings));
        } finally { db.exec("ROLLBACK TO tamper; RELEASE tamper"); }
      });
    }
    await corrupt("unfinished earlier job cannot hide behind a successful winner", () => {
      db.prepare("UPDATE jobs SET status='running',lease_token='orphan' WHERE id=?").run(firstJob.id);
    }, "batch_unfinished_job");
    await corrupt("earlier H3 job is forbidden even when completed", () => {
      db.prepare("UPDATE jobs SET type='h3_generate' WHERE id=?").run(firstJob.id);
    }, "batch_forbidden_job");
    await corrupt("earlier orphan invocation is included", () => {
      db.exec("CREATE TABLE ai_invocations(id INTEGER,job_id INTEGER,status TEXT)");
      db.prepare("INSERT INTO ai_invocations VALUES(1,?,'running')").run(firstJob.id);
    }, "batch_orphan_invocation");
    await corrupt("earlier unresolved attempt is included", () => {
      db.prepare("UPDATE pipeline_attempts SET status='reconcile_required' WHERE job_id=?").run(firstJob.id);
    }, "batch_unresolved_attempt");
    await corrupt("shared counter reset cannot pass", () => {
      db.prepare("UPDATE pipeline_batches SET invocations_used=0 WHERE id=?").run(batch.id);
    }, "batch_budget_ledger_mismatch");
    await corrupt("candidate deadline extension cannot pass", () => {
      db.prepare("UPDATE pipeline_runs SET deadline_ms=deadline_ms+1000 WHERE id=?").run(selected.id);
    }, "batch_budget_reset");
    await corrupt("changed candidate input cannot pass", () => {
      db.prepare("UPDATE pipeline_runs SET input_hash='changed' WHERE id=?").run(first.id);
    }, "batch_candidate_contract_mismatch");
    await corrupt("general failure cannot be disguised as a replaceable reference failure", () => {
      db.prepare("UPDATE pipeline_runs SET terminal_reason='provider_error' WHERE id=?").run(first.id);
    }, "batch_previous_candidate_unresolved");
    await corrupt("rejected candidate artifacts cannot be ignored", () => {
      db.prepare("INSERT INTO pipeline_artifacts(run_id,job_id,clip_key,kind,input_hash,path,content_hash,quality,freshness,user_approval) VALUES(?,?,1,'clean','first','unused','hash','pass','current','pending')").run(first.id, firstJob.id);
    }, "batch_rejected_candidate_artifact");
    await t.test("verification cannot lower the initial scene or required INFO contract", () => {
      assert.ok(verify({ clips: contract.clips.slice(0, 6) }).findings.some(f => f.code === "batch_media_contract_mismatch"));
      assert.ok(verify({ clips: contract.clips.map(clip => ({ ...clip, requiredOverlay: false })) }).findings.some(f => f.code === "batch_media_contract_mismatch"));
    });
  } finally { db.close(); }
});
