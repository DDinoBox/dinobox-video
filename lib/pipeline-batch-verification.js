const TYPES = { script: 'script_generate', tts: 'tts_generate', shotlist: 'shotlist_generate', clean: 'clean_image_generate', info: 'info_image_generate', continue: 'pipeline_continue' };
const validCount = value => Number.isSafeInteger(value) && value >= 0;

// Caller owns a read-only SQLite snapshot. No migration, recovery or status writes.
export function verifyBatchLedger(db, selectedRun, contract) {
  const findings = [];
  const add = (code, detail = {}) => findings.push({ code, ...detail });
  const batch = db.prepare('SELECT * FROM pipeline_batches WHERE id=?').get(selectedRun.batch_id);
  if (!batch) throw Error('batch_missing');
  const runs = db.prepare('SELECT * FROM pipeline_runs WHERE batch_id=? ORDER BY rowid').all(batch.id);
  const jobs = db.prepare('SELECT j.* FROM jobs j JOIN pipeline_runs r ON r.id=j.run_id WHERE r.batch_id=? ORDER BY j.id').all(batch.id);
  const attempts = db.prepare('SELECT a.* FROM pipeline_attempts a JOIN pipeline_runs r ON r.id=a.run_id WHERE r.batch_id=? ORDER BY a.id').all(batch.id);
  const artifacts = db.prepare('SELECT a.* FROM pipeline_artifacts a JOIN pipeline_runs r ON r.id=a.run_id WHERE r.batch_id=?').all(batch.id);
  const candidates = JSON.parse(batch.candidates_json);
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > 3) throw Error('batch_candidates_invalid');
  if (batch.status !== 'awaiting_user_review') add('batch_not_awaiting_user_review', { status: batch.status });
  if (batch.next_candidate_index !== runs.length || runs.length > candidates.length || runs.at(-1)?.id !== selectedRun.id
    || new Set(runs.map(run => run.topic_id)).size !== runs.length) add('batch_candidate_order_mismatch');
  for (const [index, run] of runs.entries()) {
    const candidate = candidates[index];
    if (!candidate || run.topic_id !== candidate.topicId || run.input_hash !== candidate.inputHash || run.lane !== batch.lane) add('batch_candidate_contract_mismatch', { runId: run.id });
    if (run.id !== selectedRun.id && (run.status !== 'blocked' || run.terminal_reason !== 'needs_reference')) add('batch_previous_candidate_unresolved', { runId: run.id, status: run.status });
    if (run.deadline_ms !== batch.deadline_ms || run.max_invocations !== batch.max_invocations || run.max_attempts !== batch.max_attempts) add('batch_budget_reset', { runId: run.id });
    const capabilities = JSON.parse(run.capabilities_json);
    if (capabilities.h3 !== false || capabilities.video !== false) add('batch_video_capability_enabled', { runId: run.id });
    const runAttempts = attempts.filter(attempt => attempt.run_id === run.id);
    if (!validCount(run.invocations_used) || !validCount(run.attempts_used) || run.attempts_used !== runAttempts.length
      || run.invocations_used !== runAttempts.reduce((sum, attempt) => sum + attempt.invocation_count, 0)) add('batch_run_ledger_mismatch', { runId: run.id });
  }
  for (const field of ['invocations', 'attempts']) {
    const used = batch[`${field}_used`], max = batch[`max_${field}`];
    if (!validCount(used) || !Number.isSafeInteger(max) || max <= 0 || used > max) add('batch_budget_exceeded', { field });
    if (used !== runs.reduce((sum, run) => sum + run[`${field}_used`], 0)) add('batch_budget_ledger_mismatch', { field });
  }
  const selectedIndex = runs.findIndex(run => run.id === selectedRun.id);
  const initialContract = candidates[selectedIndex]?.startContract;
  if (!initialContract || initialContract.requiredVisualStates !== contract.clips.length
    || !Number.isSafeInteger(initialContract.minimumRequiredInfoOverlays)
    || contract.clips.filter(clip => clip.requiredOverlay).length < initialContract.minimumRequiredInfoOverlays) add('batch_media_contract_mismatch');
  for (const job of jobs) {
    if (TYPES[job.pipeline_stage] !== job.type) add('batch_forbidden_job', { jobId: job.id });
    if (job.status !== 'completed' || job.lease_token || job.lease_expires_ms) add('batch_unfinished_job', { jobId: job.id, status: job.status });
    if (!attempts.some(attempt => attempt.job_id === job.id && attempt.run_id === job.run_id && attempt.status === 'succeeded')) add('batch_successful_attempt_missing', { jobId: job.id });
  }
  if (new Set(jobs.map(job => job.logical_task_key)).size !== jobs.length || jobs.some(job => !job.logical_task_key)) add('batch_duplicate_or_unbound_job');
  for (const attempt of attempts) {
    if (!validCount(attempt.invocation_count) || !['succeeded', 'abandoned_before_provider'].includes(attempt.status)) add('batch_unresolved_attempt', { attemptId: attempt.id, status: attempt.status });
    if (!jobs.some(job => job.id === attempt.job_id && job.run_id === attempt.run_id)) add('batch_attempt_binding_mismatch', { attemptId: attempt.id });
  }
  for (const artifact of artifacts) if (artifact.run_id !== selectedRun.id) add('batch_rejected_candidate_artifact', { artifactId: artifact.id });
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_invocations'").get()) {
    for (const invocation of db.prepare("SELECT id,status FROM ai_invocations WHERE job_id IN (SELECT j.id FROM jobs j JOIN pipeline_runs r ON r.id=j.run_id WHERE r.batch_id=?) AND status IN ('running','queued','reconcile_required')").all(batch.id)) add('batch_orphan_invocation', { invocationId: invocation.id, status: invocation.status });
  }
  return { id: batch.id, status: batch.status, runs: runs.length, jobs: jobs.length, attempts: attempts.length,
    invocations: batch.invocations_used, maxInvocations: batch.max_invocations, deadlineMs: batch.deadline_ms, findings };
}
