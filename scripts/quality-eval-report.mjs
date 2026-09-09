import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { evaluateGoldQualityCase, validateEvidencePacket, validateProductionBriefEvidence } from "../lib/quality-gates.js";

const currentFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(currentFile), "..");
const benchmarkDir = path.join(root, "benchmarks");

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

export function runQualityReport(options = {}) {
  const dbPath = options.dbPath || process.env.DINOBOX_DB_PATH || path.join(root, "data", "shorts.db");
  const report = { database: dbPath, generatedAt: new Date().toISOString(), errors: [], exitCode: 0 };
  let db;
  let phase = "database_unavailable";
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    phase = "database_query_failed";
    db.exec("BEGIN");
    const queries = {
      topic: db.prepare("SELECT id FROM topics WHERE title LIKE '%' || ? || '%' ORDER BY id DESC LIMIT 1"),
      fact: db.prepare("SELECT claims_json, raw_json, status FROM fact_checks WHERE topic_id = ?"),
      brief: db.prepare("SELECT status, visual_states_json FROM production_briefs WHERE topic_id = ?"),
      findings: db.prepare("SELECT code, stage FROM quality_findings WHERE topic_id = ? ORDER BY id"),
      invocations: db.prepare("SELECT COUNT(*) AS count FROM ai_invocations WHERE topic_id = ?")
    };
    const benchmarks = options.benchmarks ?? readdirSync(benchmarkDir).filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(path.join(benchmarkDir, name), "utf8")));
    const goldCases = options.goldCases ?? JSON.parse(readFileSync(path.join(root, "test", "fixtures", "quality-gold-cases.json"), "utf8")).cases;
    const results = benchmarks.map(benchmark => {
      const topic = queries.topic.get(String(benchmark.topicSelector?.titleIncludes || ""));
      return buildBenchmarkReportCase(benchmark, {
        topic,
        fact: topic ? queries.fact.get(topic.id) : null,
        brief: topic ? queries.brief.get(topic.id) : null,
        findings: topic ? queries.findings.all(topic.id) : [],
        invocationCount: topic ? queries.invocations.get(topic.id).count : 0
      });
    });
    db.exec("COMMIT");
    phase = "quality_evaluation_failed";
    const goldResults = goldCases.map(evaluateGoldQualityCase);
    const goldRegression = {
      caseCount: goldResults.length,
      misses: goldResults.flatMap(result => result.misses.map(code => ({ caseKey: result.caseKey, code }))),
      missCount: goldResults.reduce((total, result) => total + result.misses.length, 0)
    };
    const totals = {
      recordedKnownBadMisses: results.reduce((total, row) => total + row.recordedKnownBadMisses.length, 0),
      goldRegressionMisses: goldRegression.missCount,
      legacyPassReferenceGaps: results.reduce((total, row) => total + row.legacyPassReferenceGaps.length, 0),
      aiInvocations: results.reduce((total, row) => total + row.invocationCount, 0)
    };
    Object.assign(report, { cases: results, goldRegression, totals, exitCode: totals.recordedKnownBadMisses || totals.goldRegressionMisses ? 1 : 0 });
  } catch (error) {
    report.errors.push({ code: phase, message: error.message });
    report.exitCode = 2;
  } finally { db?.close(); }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const args = process.argv.slice(2);
  const valid = !args.length || (args.length === 2 && args[0] === "--db" && !args[1].startsWith("--"));
  const report = valid ? runQualityReport({ dbPath: args[1] }) : { errors: [{ code: "invalid_arguments", message: "Usage: node scripts/quality-eval-report.mjs [--db PATH]" }], exitCode: 2 };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
}
