import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const start = html.indexOf('    // Durable panel is independent');
const end = html.indexOf('    // End durable panel.');
assert.ok(start > 0 && end > start);
const source = html.slice(start, end);
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const state = (extra = {}) => ({ enabled: true, topicId: 1, execution: 'not_started', quality: 'unknown', inputFreshness: 'unknown', userApproval: 'pending', canStart: true, nextAction: { owner: 'operator', message: '검토 후 시작' }, ...extra });
function harness(fetch, confirm = () => true) {
  const nodes = new Map(['durable-status', 'durable-start', 'durable-cancel', 'durable-refresh', 'durable-clean-review', 'durable-info-review'].map(id => [id, {
    disabled: true, innerHTML: '', textContent: '', listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; }
  }]));
  const context = vm.createContext({ document: { getElementById: id => nodes.get(id) }, fetch, confirm,
    crypto: { randomUUID: () => 'stable-click-key' }, escapeHtml: value => String(value).replaceAll('<', '&lt;'), console });
  vm.runInContext(source, context);
  return { node: id => nodes.get(`durable-${id}`), load: id => vm.runInContext(`loadDurableStatus(${id})`, context) };
}

test('topic read never starts generation; unknown stays unknown and 503 disables actions', async () => {
  const calls = [];
  const h = harness(async (url, options) => { calls.push([url, options]); return response({ error: 'durable_pipeline_disabled' }, 503); });
  await h.load(4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/pipeline/topics/4');
  assert.equal(calls[0][1], undefined);
  assert.equal(h.node('start').disabled, true);
  assert.equal(h.node('cancel').disabled, true);
  assert.match(h.node('status').textContent, /비활성 \(503\)/);
  assert.match(h.node('status').textContent, /unknown/);
});

test('separate state fields, shared budget and review instruction render without approval inference', async () => {
  const h = harness(async () => response(state({ execution: 'awaiting_user_review', quality: 'pass', canStart: false,
    cancelScope: { type: 'batch', id: 'batch-1' }, budgets: { batch: { callsUsed: 2, callsLimit: 9, attemptsUsed: 3, attemptsLimit: 11, deadlineMs: 1800000000000 } } })));
  await h.load(1);
  assert.equal(h.node('start').disabled, true);
  assert.equal(h.node('cancel').disabled, false);
  assert.equal(h.node('cancel').textContent, '공유 batch 전체 취소');
  for (const text of ['기계 품질: pass', '사용자 승인: pending', '입력 최신성: unknown', '호출 2/9', '시도 3/11', '기한', '기존 CLEAN / INFO 검수']) assert.ok(h.node('status').innerHTML.includes(text), text);
});

test('current approved assets show the principle without requesting repeated approval', async () => {
  const h = harness(async () => response(state({ execution: 'awaiting_user_review', inputFreshness: 'current', userApproval: 'approved',
    nextAction: { owner: 'operator', message: '최종 승인 기록됨. 영상은 별도 승인 작업이며 자동 실행하지 않습니다.' } })));
  await h.load(1);
  const rendered = h.node('status').innerHTML;
  assert.ok(rendered.includes('최종 승인 기록됨.'));
  assert.ok(rendered.includes('다음 조치 담당: operator'));
  assert.ok(rendered.includes('기계 PASS ≠ 최종 승인.'));
  assert.ok(!rendered.includes('검수에서 승인하세요'));
});

test('explicit click starts once even with overlapping clicks', async () => {
  const calls = [];
  let resolvePost;
  let active = false;
  const h = harness(async (url, options) => {
    calls.push([url, options]);
    if (options) { await new Promise(resolve => { resolvePost = resolve; }); active = true; return response({ run: { id: 'run-1' } }, 202); }
    return response(state({ canStart: !active, execution: active ? 'queued' : 'not_started' }));
  });
  await h.load(1);
  assert.equal(calls.filter(([, options]) => options).length, 0);
  const first = h.node('start').listeners.click();
  const second = h.node('start').listeners.click();
  assert.equal(h.node('start').disabled, true);
  resolvePost();
  await Promise.all([first, second]);
  const posts = calls.filter(([, options]) => options);
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0][1].body), { topicId: 1, requestKey: 'stable-click-key' });
  assert.equal(h.node('start').disabled, true);
});

test('ambiguous failed start preserves idempotency key for next explicit click', async () => {
  const keys = [];
  const h = harness(async (_url, options) => {
    if (options) { keys.push(JSON.parse(options.body).requestKey); throw Error('connection lost'); }
    return response(state());
  });
  await h.load(1);
  await h.node('start').listeners.click();
  await h.node('start').listeners.click();
  assert.deepEqual(keys, ['stable-click-key', 'stable-click-key']);
});

test('batch cancel confirms shared scope and dispatches only batch endpoint', async () => {
  const posts = [];
  const confirmations = [];
  const h = harness(async (url, options) => {
    if (options) posts.push(url);
    return response(state({ canStart: false, cancelScope: { type: 'batch', id: 'shared' } }));
  }, text => { confirmations.push(text); return true; });
  await h.load(1);
  await h.node('cancel').listeners.click();
  assert.deepEqual(posts, ['/api/pipeline/batches/shared/cancel']);
  assert.match(confirmations[0], /모든 후보와 공유 예산/);
});

test('out-of-order topic response cannot enable actions for previously selected topic', async () => {
  let resolveOld;
  const h = harness(async url => url.endsWith('/1') ? await new Promise(resolve => { resolveOld = resolve; }) : response(state({ topicId: 2, canStart: false, execution: 'running' })));
  const old = h.load(1);
  await h.load(2);
  resolveOld(response(state({ topicId: 1, canStart: true })));
  await old;
  assert.equal(h.node('start').disabled, true);
  assert.ok(h.node('status').innerHTML.includes('실행: running'));
});
