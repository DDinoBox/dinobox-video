import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPipelineStage } from './pipeline-staging.js';

const workerPath = fileURLToPath(new URL('./pipeline-provider-worker.mjs', import.meta.url));
const TABLES = {
  script: ['scripts', 'topics', 'tts_runs', 'shotlists', 'production_briefs', 'evidence_packets', 'topic_attempts', 'quality_runs', 'quality_findings', 'quality_decisions'],
  tts: ['tts_runs', 'tts_segments', 'shotlists', 'topic_attempts', 'scripts', 'topics', 'quality_runs', 'quality_findings', 'quality_decisions'],
  shotlist: ['shotlists', 'shotlist_items', 'tts_runs', 'tts_segments', 'scripts', 'production_briefs', 'evidence_packets', 'topics', 'topic_attempts', 'quality_runs', 'quality_findings', 'quality_decisions'],
  clean: ['asset_reviews', 'topic_attempts', 'quality_runs', 'quality_findings', 'quality_decisions'],
  info: ['asset_reviews', 'shotlists', 'shotlist_items', 'topic_attempts', 'quality_runs', 'quality_findings', 'quality_decisions']
};

// Reservations are accounted for by the parent's pipeline_attempts ledger only.
// The journal is attempt-local evidence, not an unrestricted ai_invocations promotion.
export function attachInvocationProtocol(child, { control, assertInputs, journalPath }) {
  const invocations = new Map();
  let failure;
  const record = event => appendFileSync(journalPath, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, { flush: true });
  const onMessage = message => {
    if (!['reserve_invocation', 'invocation_result'].includes(message?.type)) return;
    const { type, requestId } = message;
    const reply = { type: `${type}_ack`, requestId };
    try {
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw Error('invalid_invocation_request_id');
      if (type === 'reserve_invocation') {
        if (invocations.has(requestId)) throw Error('duplicate_invocation_reservation');
        if (failure) throw failure;
        control.signal.throwIfAborted();
        assertInputs();
        const reservation = control.reserveInvocation();
        if (reservation && typeof reservation.then === 'function') throw Error('reserve_invocation_must_be_sync');
        invocations.set(requestId, 'reserved');
        record({ type, requestId, status: 'reserved' });
      } else {
        if (invocations.get(requestId) !== 'reserved') throw Error('invocation_not_reserved');
        if (!['completed', 'error'].includes(message.status)) throw Error('invalid_invocation_status');
        // Even after cancellation/lease loss, retain the actual result evidence.
        record({ type, requestId, status: message.status });
        invocations.set(requestId, message.status);
      }
      reply.ok = true;
    } catch (error) {
      failure ||= error;
      reply.ok = false;
      reply.error = String(error.message || error);
    }
    if (child.connected) {
      try { child.send(reply, error => { if (error) failure ||= error; }); }
      catch (error) { failure ||= error; }
    } else failure ||= Error('provider_ipc_disconnected');
  };
  child.on('message', onMessage);
  return {
    dispose: () => child.removeListener('message', onMessage),
    assertComplete() {
      if (failure) throw failure;
      if ([...invocations.values()].includes('reserved')) throw Error('provider_invocation_result_missing');
    }
  };
}

export async function prepareStagedProvider({ store, job, dataRoot, workspaceRoot, control, descriptor = {} }) {
  if (!TABLES[job.pipeline_stage]) throw Error('unsupported_staged_provider');
  const voiceBaseline = job.pipeline_stage === 'tts'
    ? JSON.stringify(store.db.prepare('SELECT * FROM voice_presets ORDER BY id').all()) : null;
  const assertInputs = () => {
    control.assertCurrent();
    if (voiceBaseline !== null && voiceBaseline !== JSON.stringify(store.db.prepare('SELECT * FROM voice_presets ORDER BY id').all())) throw Error('voice_input_revision_changed');
  };
  const stage = await createPipelineStage({ db: store.db, dataRoot, workspaceRoot, job,
    assertCurrent: assertInputs, allowedTables: TABLES[job.pipeline_stage] });
  const requestPath = path.join(stage.root, 'request.json');
  writeFileSync(requestPath, JSON.stringify({ job: stage.toStaged(job),
    payload: stage.toStaged({ ...job.payload, topicId: job.topic_id, id: job.topic_id }),
    mockModule: descriptor.mockModule, voxModule: descriptor.voxModule,
    boundaryModule: descriptor.boundaryModule }));
  control.signal.throwIfAborted();
  assertInputs();
  if (descriptor.mockModule) control.reserveInvocation();
  const response = await new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(process.execPath, [workerPath, requestPath], {
      cwd: workspaceRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, DINOBOX_DATA_DIR: stage.dataRoot, DINOBOX_DB_PATH: stage.dbPath,
        DINOBOX_ENABLE_DURABLE_PIPELINE: '1', DINOBOX_PIPELINE_PROVIDER_WORKER: '1',
        DINOBOX_ISOLATED_MOCK_PROVIDER: descriptor.mockModule || descriptor.voxModule || descriptor.boundaryModule ? '1' : '0',
        DISABLE_BACKGROUND_WORKERS: '1', DINOBOX_DISABLE_AUTOMATIC_REMEDIATION: '1', PORT: '0' }
    });
    const protocol = attachInvocationProtocol(child, { control, assertInputs,
      journalPath: path.join(stage.root, 'provider-invocations.jsonl') });
    // Abort does not imply process-tree termination. The child and descendants
    // only receive attempt paths; never promote until close and a fresh lease.
    const abort = () => { if (child.connected) child.send({ type: 'cancel' }, () => {}); };
    control.signal.addEventListener('abort', abort, { once: true });
    if (control.signal.aborted) abort();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.once('error', error => { control.signal.removeEventListener('abort', abort); protocol.dispose(); reject(error); });
    child.once('close', code => {
      control.signal.removeEventListener('abort', abort);
      protocol.dispose();
      try {
        control.signal.throwIfAborted();
        assertInputs();
        protocol.assertComplete();
        const value = JSON.parse(readFileSync(path.join(stage.root, 'response.json'), 'utf8'));
        if (code !== 0 || value.error) throw Error(value.error || `staged_provider_exit_${code}:${stderr}`);
        resolve(value);
      } catch (error) { reject(error); }
    });
  });
  const artifacts = (response.artifacts || []).map(artifact => {
    const relative = path.relative(stage.dataRoot, path.resolve(artifact.path));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('staged_artifact_path_escape');
    return { ...artifact, sourcePath: stage.toOriginal(artifact.path) };
  });
  const promotion = stage.preparePromotion();
  return { result: stage.toOriginal(response.result), artifacts, promotion,
    stageRoot: stage.root, assertInputs };
}
