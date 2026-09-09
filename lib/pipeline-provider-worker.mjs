import path from 'node:path';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Await reservation before calling the provider; await finish('completed'|'error')
// after the actual call settles. Result acknowledgments remain usable after abort.
export function createInvocationClient(channel, signal, { timeoutMs = 30000 } = {}) {
  let sequence = 0;
  let failure;
  const pending = new Map();
  const active = new Set();
  const rejectPending = error => {
    failure ||= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const onDisconnect = () => rejectPending(Error('provider_ipc_disconnected'));
  const onMessage = message => {
    const key = `${message?.type}:${message?.requestId}`;
    const request = pending.get(key);
    if (!request) return;
    pending.delete(key);
    if (message.ok === true) request.resolve();
    else {
      failure ||= Error(message.error || 'provider_ipc_rejected');
      request.reject(failure);
    }
  };
  channel.on('message', onMessage);
  channel.on('disconnect', onDisconnect);
  const exchange = (type, requestId, status) => new Promise((resolve, reject) => {
    if (!channel.connected) return reject(Error('provider_ipc_disconnected'));
    const key = `${type}_ack:${requestId}`;
    const timer = setTimeout(() => {
      pending.delete(key);
      failure ||= Error('provider_ipc_ack_timeout');
      reject(failure);
    }, timeoutMs);
    const settle = callback => value => { clearTimeout(timer); callback(value); };
    const request = { resolve: settle(resolve), reject: settle(reject) };
    pending.set(key, request);
    const failed = error => {
      if (!error || !pending.has(key)) return;
      pending.delete(key);
      failure ||= error;
      request.reject(error);
    };
    try { channel.send({ type, requestId, ...(status ? { status } : {}) }, failed); }
    catch (error) { failed(error); }
  });
  return {
    async reserveInvocation() {
      signal.throwIfAborted();
      if (failure) throw failure;
      const requestId = `invocation-${++sequence}`;
      await exchange('reserve_invocation', requestId);
      active.add(requestId);
      let finishing = false;
      return async status => {
        if (!['completed', 'error'].includes(status)) throw Error('invalid_invocation_status');
        if (finishing) throw Error('invocation_already_finished');
        finishing = true;
        await exchange('invocation_result', requestId, status);
        active.delete(requestId);
      };
    },
    assertComplete() {
      if (failure) throw failure;
      if (pending.size || active.size) throw Error('provider_invocation_result_missing');
    },
    dispose() {
      channel.removeListener('message', onMessage);
      channel.removeListener('disconnect', onDisconnect);
      rejectPending(Error('provider_ipc_closed'));
    }
  };
}

async function testModule(filename) {
  const file = realpathSync(path.resolve(filename));
  const root = realpathSync(path.join(workspaceRoot, 'test', 'fixtures'));
  if (process.env.DINOBOX_ISOLATED_MOCK_PROVIDER !== '1' || !file.startsWith(`${root}${path.sep}`)) throw Error('invalid_mock_provider_module');
  return import(pathToFileURL(file).href);
}

async function main() {
  const requestPath = path.resolve(process.argv[2] || '');
  const dataRoot = path.resolve(process.env.DINOBOX_DATA_DIR || '');
  if (process.env.DINOBOX_PIPELINE_PROVIDER_WORKER !== '1' || process.env.DISABLE_BACKGROUND_WORKERS !== '1'
    || !requestPath.startsWith(`${path.dirname(dataRoot)}${path.sep}`)) throw Error('invalid_provider_worker_request');
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  const controller = new AbortController();
  const cancel = message => { if (message?.type === 'cancel') controller.abort(Error('provider_canceled')); };
  process.on('message', cancel);
  const client = createInvocationClient(process, controller.signal);
  let app;
  try {
    app = await import('../server.js');
    let result;
    if (request.mockModule) {
      const module = await testModule(request.mockModule);
      result = await module.default({ db: app.db, dataRoot, workspaceRoot, job: request.job, payload: request.payload, signal: controller.signal });
    } else {
      const boundary = request.boundaryModule ? await testModule(request.boundaryModule) : {};
      const { default: ignoredDefault, ...exports } = boundary;
      const options = { ...exports, job: request.job, signal: controller.signal, reserveInvocation: client.reserveInvocation };
      if (request.voxModule) options.voxProvider = (await testModule(request.voxModule)).default;
      result = await app.runIsolatedProvider(request.job.pipeline_stage, request.payload, options);
    }
    client.assertComplete();
    controller.signal.throwIfAborted();
    const outcome = await app.collectIsolatedStageOutcome(request.job, result);
    writeFileSync(path.join(path.dirname(requestPath), 'response.json'), JSON.stringify(outcome));
  } catch (error) {
    writeFileSync(path.join(path.dirname(requestPath), 'response.json'), JSON.stringify({ error: String(error.message || error) }));
    process.exitCode = 1;
  } finally {
    client.dispose();
    process.removeListener('message', cancel);
    app?.db.close();
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
