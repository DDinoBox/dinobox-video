import { createHash, randomUUID } from 'node:crypto';
import { stableCanonicalStringify } from './pipeline-contract.js';

const ACTIVE = ['queued', 'running'];
const STAGES = new Set(['script', 'tts', 'shotlist', 'clean', 'info', 'continue']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// No database is opened at import time. The caller owns the connection and migration.
export class PipelineStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY, type TEXT NOT NULL, topic_id INTEGER,
        status TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 1,
        cancel_requested INTEGER NOT NULL DEFAULT 0, lease_owner TEXT NOT NULL DEFAULT '', lease_until TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, started_at TEXT, completed_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS pipeline_batches (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, contract_hash TEXT NOT NULL,
        candidates_json TEXT NOT NULL, lane TEXT NOT NULL CHECK(lane IN ('manual','production_canary')),
        next_candidate_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued', terminal_reason TEXT NOT NULL DEFAULT '',
        max_invocations INTEGER NOT NULL, invocations_used INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL, attempts_used INTEGER NOT NULL DEFAULT 0,
        deadline_ms INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, topic_id INTEGER NOT NULL,
        lane TEXT NOT NULL CHECK(lane IN ('manual','production_canary')),
        capabilities_json TEXT NOT NULL DEFAULT '{"h3":false,"video":false}',
        status TEXT NOT NULL DEFAULT 'queued', current_stage TEXT NOT NULL DEFAULT '', terminal_reason TEXT NOT NULL DEFAULT '',
        input_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        max_invocations INTEGER NOT NULL, invocations_used INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL, attempts_used INTEGER NOT NULL DEFAULT 0,
        deadline_ms INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS pipeline_attempts (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs(id), job_id INTEGER NOT NULL REFERENCES jobs(id),
        lease_token TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'claimed', provider_started INTEGER NOT NULL DEFAULT 0,
        invocation_count INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS pipeline_clean_repairs (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs(id), clip_key TEXT NOT NULL,
        request_key TEXT NOT NULL, before_artifact_id INTEGER NOT NULL, before_hash TEXT NOT NULL,
        contract_json TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(run_id, clip_key), UNIQUE(run_id, request_key)
      );
      CREATE TABLE IF NOT EXISTS pipeline_artifacts (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs(id), job_id INTEGER NOT NULL REFERENCES jobs(id),
        clip_key TEXT NOT NULL, kind TEXT NOT NULL, input_hash TEXT NOT NULL, path TEXT NOT NULL, content_hash TEXT NOT NULL,
        quality TEXT NOT NULL, freshness TEXT NOT NULL, user_approval TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(run_id, kind, clip_key, input_hash)
      );
    `);
    for (const [column, definition] of Object.entries({ run_id: 'TEXT REFERENCES pipeline_runs(id)', pipeline_stage: "TEXT NOT NULL DEFAULT ''", scope_key: "TEXT NOT NULL DEFAULT ''", input_revision: "TEXT NOT NULL DEFAULT ''", operation_kind: "TEXT NOT NULL DEFAULT ''", logical_task_key: 'TEXT', lease_token: "TEXT NOT NULL DEFAULT ''", lease_expires_ms: 'INTEGER' })) {
      if (!db.prepare('PRAGMA table_info(jobs)').all().some(row => row.name === column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`);
    }
    if (!db.prepare('PRAGMA table_info(pipeline_runs)').all().some(row => row.name === 'batch_id')) db.exec('ALTER TABLE pipeline_runs ADD COLUMN batch_id TEXT REFERENCES pipeline_batches(id)');
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_batch_active ON pipeline_runs(batch_id) WHERE batch_id IS NOT NULL AND status IN ('queued','running','awaiting_user_review')");
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_logical_task ON jobs(logical_task_key) WHERE logical_task_key IS NOT NULL');
  }
  transaction(fn) {
    this.db.exec('SAVEPOINT pipeline_tx');
    try { const result = fn(); this.db.exec('RELEASE pipeline_tx'); return result; }
    catch (error) {
      this.db.exec('ROLLBACK TO pipeline_tx; RELEASE pipeline_tx');
      // A deadline rejection rolls back the result, not the budget terminal state.
      if (error.pipelineBudgetBatchId) this.holdBatch(error.pipelineBudgetBatchId, 'budget_exhausted');
      else if (error.pipelineBudgetRunId) this.hold(error.pipelineBudgetRunId, 'budget_exhausted');
      throw error;
    }
  }
  getRun(id) { return this.db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(id); }
  jobs(id) { return this.db.prepare('SELECT * FROM jobs WHERE run_id = ? ORDER BY id').all(id); }
  artifacts(id) { return this.db.prepare('SELECT * FROM pipeline_artifacts WHERE run_id = ? ORDER BY id').all(id); }
  activeArtifacts(id) {
    return this.artifacts(id).filter((row, _, all) => !all.some(next => next.kind === row.kind && next.clip_key === row.clip_key && next.id > row.id));
  }
  cleanRepairs(id) { return this.db.prepare('SELECT * FROM pipeline_clean_repairs WHERE run_id=? ORDER BY created_at,id').all(id); }
  requestCleanRepair(runId, { clipKey, requestKey, beforeArtifactId, beforeHash, contract }) {
    return this.transaction(() => {
      const existing = this.cleanRepairs(runId).find(row => row.request_key === requestKey);
      const json = stableCanonicalStringify(contract);
      if (existing) {
        if (existing.clip_key !== String(clipKey) || existing.before_artifact_id !== beforeArtifactId || existing.before_hash !== beforeHash || existing.contract_json !== json) throw Error('repair_request_key_conflict');
        return { repair: existing, reused: true };
      }
      const run = this.getRun(runId), batch = run?.batch_id ? this.getBatch(run.batch_id) : null;
      if (run?.status !== 'awaiting_user_review' || batch && batch.status !== 'awaiting_user_review' || this.jobs(runId).some(job => ACTIVE.includes(job.status))) throw Error('repair_requires_settled_review_run');
      if (this.cleanRepairs(runId).some(row => row.clip_key === String(clipKey))) throw Error('clean_repair_limit_reached');
      for (const ledger of [run,batch].filter(Boolean)) if (Date.now() >= ledger.deadline_ms || ledger.invocations_used >= ledger.max_invocations || ledger.attempts_used >= ledger.max_attempts) throw Error('repair_budget_exhausted');
      const id = randomUUID();
      this.db.prepare('INSERT INTO pipeline_clean_repairs(id,run_id,clip_key,request_key,before_artifact_id,before_hash,contract_json) VALUES(?,?,?,?,?,?,?)').run(id,runId,String(clipKey),requestKey,beforeArtifactId,beforeHash,json);
      this.db.prepare("UPDATE pipeline_runs SET status='running',terminal_reason='',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(runId);
      if(batch)this.db.prepare("UPDATE pipeline_batches SET status='running',terminal_reason='',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(batch.id);
      return { repair: this.cleanRepairs(runId).find(row=>row.id===id), reused:false };
    });
  }
  getBatch(id) { return this.db.prepare('SELECT * FROM pipeline_batches WHERE id=?').get(id); }
  batchRuns(id) { return this.db.prepare('SELECT * FROM pipeline_runs WHERE batch_id=? ORDER BY rowid').all(id); }
  createBatch({ requestKey, candidates, lane = 'manual', maxInvocations = 60, maxAttempts = 80, maxElapsedMs = 45 * 60000 }) {
    if (typeof requestKey !== 'string' || !requestKey || !['manual', 'production_canary'].includes(lane) || !Array.isArray(candidates) || !candidates.length || candidates.length > 3) throw Error('invalid batch contract');
    for (const value of [maxInvocations, maxAttempts, maxElapsedMs]) if (!Number.isSafeInteger(value) || value <= 0) throw Error('invalid budget');
    for (const candidate of candidates) if (!candidate || !Number.isSafeInteger(candidate.topicId) || candidate.topicId <= 0 || typeof candidate.inputHash !== 'string' || !candidate.inputHash || candidate.startContract === undefined) throw Error('invalid candidate contract');
    if (new Set(candidates.map(candidate => candidate.topicId)).size !== candidates.length) throw Error('duplicate candidate');
    const candidatesJson = stableCanonicalStringify(candidates);
    const contractHash = hash([JSON.parse(candidatesJson), lane, maxInvocations, maxAttempts, maxElapsedMs]);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM pipeline_batches WHERE request_key=?').get(requestKey);
      if (existing) {
        if (existing.contract_hash !== contractHash) throw Error('request_key_contract_mismatch');
        return existing;
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO pipeline_batches (id,request_key,contract_hash,candidates_json,lane,max_invocations,max_attempts,deadline_ms) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, requestKey, contractHash, candidatesJson, lane, maxInvocations, maxAttempts, Date.now() + maxElapsedMs);
      return this.getBatch(id);
    });
  }
  startNextCandidate(batchId) {
    return this.transaction(() => {
      const batch = this.getBatch(batchId);
      if (!batch || !ACTIVE.includes(batch.status)) throw Error(`batch_not_active:${batch?.status || 'missing'}`);
      if (Date.now() >= batch.deadline_ms || batch.attempts_used >= batch.max_attempts || batch.invocations_used >= batch.max_invocations) {
        this.holdBatch(batchId, 'budget_exhausted');
        throw Object.assign(Error('budget_exhausted'), { pipelineBudgetBatchId: batchId });
      }
      const previous = this.batchRuns(batchId).at(-1);
      if (previous && (previous.status !== 'blocked' || previous.terminal_reason !== 'needs_reference')) throw Error('candidate_not_advanceable');
      const candidate = JSON.parse(batch.candidates_json)[batch.next_candidate_index];
      if (!candidate) { this.holdBatch(batchId, 'needs_reference'); return null; }
      const id = randomUUID();
      this.db.prepare('INSERT INTO pipeline_runs (id,request_key,topic_id,lane,input_hash,max_invocations,max_attempts,deadline_ms,batch_id) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, `batch:${batchId}:${batch.next_candidate_index}`, candidate.topicId, batch.lane, candidate.inputHash, batch.max_invocations, batch.max_attempts, batch.deadline_ms, batchId);
      this.db.prepare("UPDATE pipeline_batches SET next_candidate_index=next_candidate_index+1,status='running',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(batchId);
      return this.getRun(id);
    });
  }
  rejectCandidate(runId, reason = 'needs_reference') {
    return this.transaction(() => {
      const run = this.assertActive(runId);
      if (!run.batch_id) throw Error('run_not_batched');
      if (reason === 'needs_reference') this.holdRun(runId, reason);
      else this.hold(runId, reason);
      return this.getRun(runId);
    });
  }
  holdBatch(id, reason, status = 'blocked') {
    this.db.prepare("UPDATE pipeline_batches SET status=?,terminal_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','running','awaiting_user_review')").run(status, reason, id);
    for (const run of this.batchRuns(id)) this.holdRun(run.id, reason, status);
  }
  cancelBatch(id) { return this.transaction(() => { this.holdBatch(id, 'user_canceled', 'canceled'); return this.getBatch(id); }); }
  createRun({ topicId, lane = 'manual', requestKey, inputHash, batchId, maxInvocations = 60, maxAttempts = 80, maxElapsedMs = 45 * 60000 }) {
    if (batchId != null) throw Error('batch_run_requires_startNextCandidate');
    if (!topicId || !requestKey || !inputHash || !['manual', 'production_canary'].includes(lane)) throw Error('invalid run contract');
    for (const value of [maxInvocations, maxAttempts, maxElapsedMs]) if (!Number.isSafeInteger(value) || value <= 0) throw Error('invalid budget');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM pipeline_runs WHERE request_key = ?').get(requestKey);
      if (existing) {
        if (existing.topic_id !== topicId || existing.lane !== lane || existing.input_hash !== inputHash) throw Error('request_key_contract_mismatch');
        return existing;
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO pipeline_runs (id,request_key,topic_id,lane,input_hash,max_invocations,max_attempts,deadline_ms) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, requestKey, topicId, lane, inputHash, maxInvocations, maxAttempts, Date.now() + maxElapsedMs);
      return this.getRun(id);
    });
  }
  assertActive(id) {
    const run = this.getRun(id);
    if (!run || !ACTIVE.includes(run.status)) throw Error(`run_not_active:${run?.status || 'missing'}`);
    if (run.batch_id) {
      const batch = this.getBatch(run.batch_id);
      if (!batch || !ACTIVE.includes(batch.status)) throw Error(`batch_not_active:${batch?.status || 'missing'}`);
      if (Date.now() >= batch.deadline_ms || Date.now() >= run.deadline_ms) {
        this.holdBatch(batch.id, 'budget_exhausted');
        throw Object.assign(Error('budget_exhausted'), { pipelineBudgetBatchId: batch.id });
      }
    }
    return run;
  }
  enqueue(runId, task) {
    const run = this.assertActive(runId);
    if (!STAGES.has(task.stage)) throw Error('unsupported pipeline stage');
    const expectedType = { script: 'script_generate', tts: 'tts_generate', shotlist: 'shotlist_generate', clean: 'clean_image_generate', info: 'info_image_generate', continue: 'pipeline_continue' }[task.stage];
    if (!task.inputHash || task.type !== expectedType) throw Error('invalid task contract');
    const scope = String(task.scope ?? 'batch');
    const operation = task.operation || 'generate';
    const key = hash([runId, task.stage, scope, task.inputHash, operation]);
    const existing = this.db.prepare('SELECT * FROM jobs WHERE logical_task_key = ?').get(key);
    if (existing) return existing;
    const payload = { ...task.payload, autoConverge: true, pipeline: { runId, stage: task.stage, inputHash: task.inputHash }, ...(scope !== 'batch' && task.stage === 'clean' ? { clipIndex: Number(scope) } : {}) };
    const result = this.db.prepare(`INSERT INTO jobs (type,topic_id,payload_json,run_id,pipeline_stage,scope_key,input_revision,operation_kind,logical_task_key,max_attempts) VALUES (?,?,?,?,?,?,?,?,?,2)`)
      .run(task.type, run.topic_id, JSON.stringify(payload), runId, task.stage, scope, task.inputHash, operation, key);
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
  }
  hold(runId, reason, status = 'blocked') {
    const run = this.getRun(runId);
    if (run?.batch_id) this.holdBatch(run.batch_id, reason, status);
    else this.holdRun(runId, reason, status);
  }
  holdRun(runId, reason, status = 'blocked') {
    this.db.prepare("UPDATE pipeline_runs SET status=?,terminal_reason=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (status IN ('queued','running') OR (status='awaiting_user_review' AND ?='canceled'))").run(status, reason, runId, status);
    this.db.prepare("UPDATE jobs SET status='canceled',cancel_requested=1,lease_token='',lease_expires_ms=NULL,error=?,completed_at=CURRENT_TIMESTAMP WHERE run_id=? AND status IN ('queued','running')").run(reason, runId);
    this.db.prepare("UPDATE pipeline_attempts SET status='reconcile_required',error=?,completed_at=CURRENT_TIMESTAMP WHERE run_id=? AND status IN ('claimed','running')").run(reason, runId);
  }
  cancel(id) { return this.transaction(() => { this.hold(id, 'user_canceled', 'canceled'); return this.getRun(id); }); }
  claim(id, now = Date.now()) {
    return this.transaction(() => {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      if (!job || job.status !== 'queued' || job.cancel_requested) return null;
      const run = this.assertActive(job.run_id);
      const batch = run.batch_id ? this.getBatch(run.batch_id) : null;
      if (now >= run.deadline_ms || run.attempts_used >= run.max_attempts || job.attempt >= job.max_attempts || (batch && (now >= batch.deadline_ms || batch.attempts_used >= batch.max_attempts || batch.invocations_used >= batch.max_invocations))) {
        this.hold(run.id, 'budget_exhausted');
        if (batch) throw Object.assign(Error('budget_exhausted'), { pipelineBudgetBatchId: batch.id });
        return null;
      }
      const token = randomUUID();
      this.db.prepare("UPDATE jobs SET status='running',attempt=attempt+1,lease_token=?,lease_expires_ms=?,lease_owner=?,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(token, now + 60000, `local-${process.pid}`, id);
      this.db.prepare("UPDATE pipeline_runs SET status='running',current_stage=?,attempts_used=attempts_used+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.pipeline_stage, run.id);
      if (batch) this.db.prepare("UPDATE pipeline_batches SET status='running',attempts_used=attempts_used+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(batch.id);
      this.db.prepare('INSERT INTO pipeline_attempts (run_id,job_id,lease_token) VALUES (?,?,?)').run(run.id, id, token);
      return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    });
  }
  assertLease(job) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
    if (!row || row.status !== 'running' || row.cancel_requested || row.lease_token !== job.lease_token || row.lease_expires_ms <= Date.now()) throw Error('lease_lost');
    const run = this.assertActive(row.run_id);
    if (Date.now() >= run.deadline_ms) {
      this.hold(run.id, 'budget_exhausted');
      throw Object.assign(Error('budget_exhausted'), { pipelineBudgetRunId: run.id });
    }
    return run;
  }
  heartbeat(job) { this.assertLease(job); this.db.prepare('UPDATE jobs SET lease_expires_ms=? WHERE id=? AND lease_token=?').run(Date.now() + 60000, job.id, job.lease_token); }
  beginProvider(job) { this.assertLease(job); this.db.prepare("UPDATE pipeline_attempts SET provider_started=1,status='running' WHERE lease_token=?").run(job.lease_token); }
  reserveInvocation(job) {
    return this.transaction(() => {
      const run = this.assertLease(job);
      const batch = run.batch_id ? this.getBatch(run.batch_id) : null;
      if (run.invocations_used >= run.max_invocations || (batch && batch.invocations_used >= batch.max_invocations)) {
        this.hold(run.id, 'budget_exhausted');
        throw Object.assign(Error('budget_exhausted'), { pipelineBudgetRunId: run.id, ...(batch ? { pipelineBudgetBatchId: batch.id } : {}) });
      }
      this.db.prepare('UPDATE pipeline_runs SET invocations_used=invocations_used+1 WHERE id=?').run(run.id);
      if (batch) this.db.prepare('UPDATE pipeline_batches SET invocations_used=invocations_used+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(batch.id);
      this.db.prepare('UPDATE pipeline_attempts SET invocation_count=invocation_count+1 WHERE lease_token=?').run(job.lease_token);
    });
  }
  complete(job, { result = {}, artifacts = [], successors = [], status, reason = '', beforeCommit, applyChanges } = {}) {
    return this.transaction(() => {
      this.assertLease(job);
      const lease = this.db.prepare('SELECT lease_expires_ms FROM jobs WHERE id=?').get(job.id);
      const finalFence = () => {
        const run = this.getRun(job.run_id);
        const batch = run.batch_id ? this.getBatch(run.batch_id) : null;
        const now = Date.now();
        if (now >= run.deadline_ms || batch && now >= batch.deadline_ms) throw Object.assign(Error('budget_exhausted'), { pipelineBudgetRunId: run.id, ...(batch ? { pipelineBudgetBatchId: batch.id } : {}) });
        if (now >= lease.lease_expires_ms) throw Error('lease_lost');
      };
      applyChanges?.();
      finalFence();
      this.assertLease(job);
      for (const artifact of artifacts) this.db.prepare(`INSERT INTO pipeline_artifacts (run_id,job_id,clip_key,kind,input_hash,path,content_hash,quality,freshness,user_approval,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,kind,clip_key,input_hash) DO UPDATE SET job_id=excluded.job_id,path=excluded.path,content_hash=excluded.content_hash,quality=excluded.quality,freshness=excluded.freshness,user_approval=excluded.user_approval,metadata_json=excluded.metadata_json`)
        .run(job.run_id, job.id, String(artifact.clip), artifact.kind, artifact.inputHash, artifact.path, artifact.contentHash, artifact.quality, artifact.freshness, artifact.userApproval, JSON.stringify(artifact));
      this.db.prepare("UPDATE jobs SET status='completed',progress=100,result_json=?,lease_token='',lease_expires_ms=NULL,lease_owner='',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(result), job.id);
      this.db.prepare("UPDATE pipeline_attempts SET status='succeeded',completed_at=CURRENT_TIMESTAMP WHERE lease_token=?").run(job.lease_token);
      if (status) {
        if (!['blocked', 'awaiting_user_review'].includes(status)) throw Error('invalid terminal state');
        this.hold(job.run_id, reason || status, status);
      } else for (const successor of successors) this.enqueue(job.run_id, successor);
      beforeCommit?.();
      finalFence();
      return this.getRun(job.run_id);
    });
  }
  fail(job, reason, reconcile = false) {
    return this.transaction(() => {
      this.assertLease(job);
      this.db.prepare("UPDATE jobs SET status=?,error=?,lease_token='',lease_expires_ms=NULL,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(reconcile ? 'reconcile_required' : 'failed', reason, job.id);
      this.db.prepare('UPDATE pipeline_attempts SET status=?,error=?,completed_at=CURRENT_TIMESTAMP WHERE lease_token=?').run(reconcile ? 'reconcile_required' : 'failed', reason, job.lease_token);
      this.hold(job.run_id, reason);
    });
  }
  recover(now = Date.now()) {
    return this.transaction(() => {
      const jobs = this.db.prepare("SELECT * FROM jobs WHERE run_id IS NOT NULL AND status='running' AND lease_expires_ms <= ?").all(now);
      for (const job of jobs) {
        const attempt = this.db.prepare('SELECT * FROM pipeline_attempts WHERE lease_token=?').get(job.lease_token);
        if (attempt?.provider_started) {
          this.db.prepare("UPDATE jobs SET status='reconcile_required',lease_token='',lease_expires_ms=NULL,error='provider_result_unknown' WHERE id=?").run(job.id);
          this.hold(job.run_id, 'provider_result_unknown');
        } else {
          this.db.prepare("UPDATE jobs SET status='queued',lease_token='',lease_expires_ms=NULL WHERE id=?").run(job.id);
          this.db.prepare("UPDATE pipeline_attempts SET status='abandoned_before_provider',completed_at=CURRENT_TIMESTAMP WHERE lease_token=?").run(job.lease_token);
        }
      }
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_invocations'").get()) {
        this.db.exec("UPDATE ai_invocations SET status='reconcile_required',completed_at=CURRENT_TIMESTAMP,error='pipeline lease ended; result unknown' WHERE status='running' AND job_id IN (SELECT id FROM jobs WHERE run_id IS NOT NULL AND status NOT IN ('queued','running'))");
      }
      return jobs.length;
    });
  }
}
