import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export function seedBrowserFact(insert, topicId) {
  return insert('fact_checks', { topic_id: topicId, status: 'PASS', confidence: 90, core_claim: 'Synthetic fixture only — not factual or visual quality evidence',
    verified_facts_json: '[]', unresolved_json: '[]', simplifications_json: '[]', sources_json: '[]', raw_json: '{}' });
}

export async function serveBrowserFixture({ app, topicId, runId, insert, dataDir, origin }) {
  const { db, pipelineStore } = app;
  assert.ok(path.resolve(dataDir).includes(`${path.sep}tmp${path.sep}`));
  db.prepare("UPDATE topics SET title='Synthetic A · CLEAN / INFO 검수',run_lane='production',review_status='pass' WHERE id=?").run(topicId);
  const secondTopicId = insert('topics', { main_topic: 'engineering', subtopic: 'integration fixture', title: 'Synthetic B · race target', source_url: 'https://example.invalid/fixture', run_lane: 'production', review_status: 'pass' });
  seedBrowserFact(insert, secondTopicId);
  const calls = [];
  const artifacts = pipelineStore.artifacts(runId);
  const originals = new Map(artifacts.map(row => { const file = JSON.parse(row.metadata_json).sourcePath || row.path; return [file, readFileSync(file)]; }));
  let detailDelay = 0;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const proxy = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/__fixture/status') return json(200, { topicId, secondTopicId, runId, calls, run: pipelineStore.getRun(runId), reviews: db.prepare('SELECT * FROM asset_reviews WHERE topic_id=?').all(topicId) });
    if (url.pathname === '/__fixture/stop' && req.method === 'POST') { json(200, { stopped: true }); proxy.close(resolveClosed); proxy.closeAllConnections(); return; }
    if (url.pathname === '/__fixture/delay' && req.method === 'POST') { detailDelay = Number(url.searchParams.get('ms') || 0); return json(200, { detailDelay }); }
    if (url.pathname === '/__fixture/mutate' && req.method === 'POST') {
      const row = artifacts.find(row => row.kind === (url.searchParams.get('kind') || 'clean'));
      const file = JSON.parse(row.metadata_json).sourcePath || row.path;
      if (url.searchParams.get('mode') === 'missing') renameSync(file, `${file}.fixture-hidden`);
      else writeFileSync(file, url.searchParams.get('mode') === 'restore' ? originals.get(file) : Buffer.from('mutated fixture bytes'));
      return json(200, { mutated: row.id });
    }
    calls.push({ method: req.method, path: req.url });
    if (req.method === 'POST' && !['/api/assets/review', '/api/assets/clean/finalize', '/api/assets/info/finalize'].includes(url.pathname)) return json(403, { error: 'fixture_generation_forbidden' });
    if (/^\/api\/(video|edit)/u.test(url.pathname)) return json(403, { error: 'fixture_video_entry_forbidden' });
    // Only the environment-facing TTS read boundary is mocked; no GPU/tool probe is allowed.
    if (url.pathname === '/api/tts/status') return json(200, { inspected: false, gpu: {}, engines: [] });
    if (url.pathname === '/api/tts/plan') {
      const row = db.prepare('SELECT * FROM tts_runs WHERE topic_id=? ORDER BY id DESC LIMIT 1').get(Number(url.searchParams.get('topicId')));
      return json(200, { run: row ? { id: row.id, status: row.status, engine: 'mock', totalDurationSec: row.total_duration_sec, estimatedTotalDurationSec: 28, segments: [] } : null, presets: [], environment: { inspected: false, gpu: {}, engines: [] } });
    }
    if (url.pathname === '/api/topics/detail' && Number(url.searchParams.get('id')) === topicId && detailDelay) await new Promise(resolve => setTimeout(resolve, detailDelay));
    const upstream = httpRequest(`${origin}${req.url}`, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, { ...response.headers, 'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'" });
      response.pipe(res);
    });
    upstream.on('error', error => json(502, { error: error.message }));
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const info = { url: `http://127.0.0.1:${proxy.address().port}`, topicId, secondTopicId, runId, dataDir };
  writeFileSync(path.join(dataDir, 'browser-fixture.json'), JSON.stringify(info));
  console.log(`BROWSER_FIXTURE_READY ${JSON.stringify(info)}`);
  const timeout = setTimeout(() => { proxy.close(resolveClosed); proxy.closeAllConnections(); }, 25 * 60000);
  try { await closed; } finally { clearTimeout(timeout); }
  writeFileSync(path.join(dataDir, 'browser-requests.json'), JSON.stringify(calls, null, 2));
}
