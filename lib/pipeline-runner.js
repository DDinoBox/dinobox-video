import path from 'node:path';
import { readFileSync, realpathSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hashPipelineVisualSnapshot, hashPipelineInfoClipSnapshot, hashPipelineCleanClipSnapshot } from './pipeline-contract.js';

// Providers return outcome envelopes, never enqueue their own successors.
export class PipelineRunner {
  constructor(store, { artifactRoot }) { this.store = store; this.artifactRoot = path.resolve(artifactRoot); }
  validateArtifact(artifact, job) {
    const file = realpathSync(path.resolve(this.artifactRoot, artifact.path));
    const relative = path.relative(realpathSync(this.artifactRoot), file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !statSync(file).isFile() || statSync(file).size === 0) throw Error('artifact_path_invalid');
    if (artifact.quality !== 'pass' || artifact.freshness !== 'current' || artifact.inputHash !== job.input_revision) throw Error('artifact_quality_or_revision_failed');
    if (artifact.requiredOverlay && (!artifact.overlayType || artifact.overlayType === 'none')) throw Error('required_info_missing');
    const contentHash = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (artifact.contentHash && artifact.contentHash !== contentHash) throw Error('artifact_hash_mismatch');
    // Bind newly validated bytes only. Legacy records are never upgraded on read.
    const visualBinding = job.payload?.inputSnapshot && ['clean', 'info'].includes(job.pipeline_stage)
      ? { version: 1, fingerprint: hashPipelineVisualSnapshot(job.payload.inputSnapshot) } : undefined;
    const clipFingerprint = job.payload?.inputSnapshot && artifact.kind === 'info'
      ? hashPipelineInfoClipSnapshot(job.payload.inputSnapshot, artifact.clip) : null;
    const cleanFingerprint = job.payload?.inputSnapshot && artifact.kind === 'clean'
      ? hashPipelineCleanClipSnapshot(job.payload.inputSnapshot, artifact.clip) : null;
    return { ...artifact, ...(visualBinding ? { visualBinding } : {}),
      ...(cleanFingerprint ? { cleanClipBinding: { version: 1, clipKey: String(artifact.clip), fingerprint: cleanFingerprint } } : {}),
      ...(clipFingerprint ? { infoClipBinding: { version: 1, clipKey: String(artifact.clip), fingerprint: clipFingerprint } } : {}),
      path: file, contentHash, userApproval: artifact.userApproval || 'pending' };
  }
  async execute(job, provider) {
    const controller = new AbortController();
    const timer = setInterval(() => {
      try { this.store.heartbeat(job); }
      catch (error) { controller.abort(error); }
    }, 1000);
    let promotion;
    let committed = false;
    try {
      this.store.beginProvider(job);
      const outcome = await provider({ signal: controller.signal, assertCurrent: () => this.store.assertLease(job), reserveInvocation: () => this.store.reserveInvocation(job) });
      promotion = outcome.promotion;
      this.store.assertLease(job);
      if (outcome.quality && outcome.quality !== 'pass') throw Error(`quality_${outcome.quality}`);
      const artifacts = (outcome.artifacts || []).map(artifact => this.validateArtifact(artifact, job));
      if (artifacts.length) {
        // Publication and SQLite are not one transaction. Keep an immutable
        // attempt directory and journal so a crash remains reconcilable.
        const attemptDir = path.join(this.artifactRoot, 'pipeline-artifacts', job.run_id, String(job.id), job.lease_token);
        mkdirSync(attemptDir, { recursive: true });
        for (const [index, artifact] of artifacts.entries()) {
          this.store.assertLease(job);
          const published = path.join(attemptDir, `${index}-${artifact.contentHash}${path.extname(artifact.path)}`);
          writeFileSync(`${published}.pending`, readFileSync(artifact.path), { flag: 'wx' });
          renameSync(`${published}.pending`, published);
          artifact.sourcePath ||= artifact.path;
          artifact.path = published;
          if (createHash('sha256').update(readFileSync(published)).digest('hex') !== artifact.contentHash) throw Error('artifact_publish_hash_mismatch');
          if (artifact.infoEvidence) {
            const evidence = {};
            for (const key of ['renderPath', 'overlayPath', 'guidesPath', 'labelsPath']) {
              this.store.assertLease(job);
              const source = this.validateArtifact({ ...artifact, path: artifact.infoEvidence[key], contentHash: undefined }, job);
              const target = path.join(attemptDir, `${index}-${key}-${source.contentHash}${path.extname(source.path)}`);
              writeFileSync(target, readFileSync(source.path), { flag: 'wx' });
              if (createHash('sha256').update(readFileSync(target)).digest('hex') !== source.contentHash) throw Error('artifact_evidence_publish_hash_mismatch');
              evidence[key] = target;
            }
            artifact.infoEvidence = evidence;
          }
        }
        writeFileSync(path.join(attemptDir, 'manifest.json'), JSON.stringify({ jobId: job.id, runId: job.run_id, leaseToken: job.lease_token, artifacts }), { flag: 'wx' });
      }
      this.store.complete(job, { ...outcome, artifacts, applyChanges: () => {
        outcome.validateBeforePublish?.();
        promotion?.apply();
        outcome.validatePublished?.();
      } });
      committed = true;
      promotion?.committed();
      return { status: 'succeeded' };
    } catch (error) {
      if (committed) return { status: 'succeeded', warning: `publication_journal_reconcile_required:${error.message}` };
      try { promotion?.rollback(); }
      catch (rollbackError) { error = new Error(`${error.message}; publication_reconcile_required:${rollbackError.message}`); }
      try { this.store.fail(job, String(error.message || error), /artifact|ENOENT|unknown|revision|staging|reconcile/.test(String(error.message))); }
      catch { /* A canceled/expired worker cannot change the durable result. */ }
      return { status: 'held', error: String(error.message || error) };
    } finally { clearInterval(timer); }
  }
}
