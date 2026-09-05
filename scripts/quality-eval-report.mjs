import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { evaluateGoldQualityCase, validateEvidencePacket, validateProductionBriefEvidence } from "../lib/quality-gates.js";

const currentFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(currentFile), "..");
const benchmarkDir = path.join(root, "benchmarks");
const dbPath = process.env.DINOBOX_DB_PATH || path.join(root, "data", "shorts.db");
const benchmarks = readdirSync(benchmarkDir).filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(path.join(benchmarkDir, name), "utf8")));
const goldCases = JSON.parse(readFileSync(path.join(root, "test", "fixtures", "quality-gold-cases.json"), "utf8")).cases || [];

function safely(getter, fallback) {
  try { return getter(); } catch { return fallback; }
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

export function buildBenchmarkReportCase(benchmark, stored = {}) {
  const fact = stored.fact || null;
  const brief = stored.brief || null;
  const findings = Array.isArray(stored.findings) ? stored.findings : [];
  const raw = fact ? parseJson(fact.raw_json, {}) : {};
  const claims = fact ? parseJson(fact.claims_json, []) : [];
  const visualEvidence = raw.visualEvidence || raw.secondAttempt?.visualEvidence || [];
  const packet = validateEvidencePacket({ claims, visualEvidence });
  const states = brief ? parseJson(brief.visual_states_json, []) : [];
  const currentSnapshotIssueCodes = [...new Set([
    ...packet.issues,
    ...validateProductionBriefEvidence({ visualStates: states }, { claims, visualEvidence })
  ].map((issue) => issue.code))];
  const recordedIssueCodes = [...new Set(findings.map((row) => String(row.code)).filter(Boolean))];
  const requiredIssueCodes = benchmark.expectations?.assertions?.requiredIssueCodes || [];
  const recordedKnownBadMisses = requiredIssueCodes.filter((code) => !recordedIssueCodes.includes(code));
  const legacyPassReferenceGaps = fact?.status === "PASS"
    ? packet.issues.filter((issue) => issue.code === "needs_reference").map((issue) => issue.code)
    : [];
  return {
    caseKey: benchmark.caseKey,
    topicId: stored.topic?.id || null,
    invocationCount: Number(stored.invocationCount || 0),
    recordedIssueCodes,
    recordedKnownBadMisses,
    currentSnapshotIssueCodes,
    referenceHealth: {
      usableReferenceCount: packet.usableEvidence.length,
      issueCodes: [...new Set(packet.issues.map((issue) => issue.code))]
    },
    legacyPassReferenceGaps: [...new Set(legacyPassReferenceGaps)],
    lateDetectionStage: findings.at(-1)?.stage || "not_run"
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  let db = null;
  if (existsSync(dbPath)) db = safely(() => new DatabaseSync(dbPath, { readOnly: true }), null);
  const results = benchmarks.map((benchmark) => {
    const title = String(benchmark.topicSelector?.titleIncludes || "");
    const topic = db ? safely(() => db.prepare("SELECT id FROM topics WHERE title LIKE '%' || ? || '%' ORDER BY id DESC LIMIT 1").get(title), null) : null;
    const fact = topic ? safely(() => db.prepare("SELECT claims_json, raw_json, status FROM fact_checks WHERE topic_id = ?").get(topic.id), null) : null;
    const brief = topic ? safely(() => db.prepare("SELECT status, visual_states_json FROM production_briefs WHERE topic_id = ?").get(topic.id), null) : null;
    const findings = topic ? safely(() => db.prepare("SELECT code, stage FROM quality_findings WHERE topic_id = ? ORDER BY id").all(topic.id), []) : [];
    const invocationCount = topic ? Number(safely(() => db.prepare("SELECT COUNT(*) AS count FROM ai_invocations WHERE topic_id = ?").get(topic.id)?.count, 0)) : 0;
    return buildBenchmarkReportCase(benchmark, { topic, fact, brief, findings, invocationCount });
  });
  const goldResults = goldCases.map(evaluateGoldQualityCase);
  const goldRegression = {
    caseCount: goldResults.length,
    misses: goldResults.flatMap((result) => result.misses.map((code) => ({ caseKey: result.caseKey, code }))),
    missCount: goldResults.reduce((total, result) => total + result.misses.length, 0)
  };
  const totals = {
    recordedKnownBadMisses: results.reduce((total, row) => total + row.recordedKnownBadMisses.length, 0),
    goldRegressionMisses: goldRegression.missCount,
    legacyPassReferenceGaps: results.reduce((total, row) => total + row.legacyPassReferenceGaps.length, 0),
    aiInvocations: results.reduce((total, row) => total + row.invocationCount, 0)
  };
  console.log(JSON.stringify({ database: db ? path.relative(root, dbPath) : "unavailable", generatedAt: new Date().toISOString(), cases: results, goldRegression, totals }, null, 2));
  db?.close();
}
