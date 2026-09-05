import assert from "node:assert/strict";

const baseUrl = process.env.DASHBOARD_URL || "http://localhost:5174";

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.ok, true, `${path} returned ${response.status}`);
  return response.json();
}

const [health, jobs, topics] = await Promise.all([
  getJson("/api/health"),
  getJson("/api/jobs?limit=3"),
  getJson("/api/topics?mainTopic=%EC%97%AD%EC%82%AC")
]);

assert.equal(health.ok, true);
assert.equal(health.database.integrity, "ok");
assert.equal(health.database.schemaVersion >= 2, true);
assert.equal(Array.isArray(jobs.jobs), true);
assert.equal(jobs.concurrency >= 1, true);
assert.equal(Array.isArray(topics.candidates), true);

console.log(JSON.stringify({
  ok: true,
  database: health.database,
  workers: health.workers,
  checkedTopics: topics.candidates.length,
  checkedJobs: jobs.jobs.length
}, null, 2));
