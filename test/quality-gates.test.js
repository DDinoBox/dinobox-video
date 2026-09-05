import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  compareBenchmarkAssertions,
  evaluateGoldQualityCase,
  isValidVisualReference,
  validateEvidencePacket,
  validateInfoLayoutContract,
  validateOfficialVisualPreflight,
  validateProductionBriefEvidence
} from "../lib/quality-gates.js";
import { buildBenchmarkReportCase } from "../scripts/quality-eval-report.mjs";

const validEvidence = {
  id: "EV-01", claimRefs: ["C-01"], referenceType: "official_section",
  referenceSourceUrl: "https://example.org/report.pdf", referenceMediaUrl: "",
  referencePage: 2, referenceDescription: "공식 단면의 기초와 냉각관"
};
const claims = [{ id: "C-01", status: "SUPPORTED", useInVideo: true }];

test("quality gates require usable official visual references", () => {
  assert.equal(isValidVisualReference(validEvidence), true);
  assert.equal(isValidVisualReference({ ...validEvidence, referencePage: 0 }), false);
  assert.equal(isValidVisualReference({ ...validEvidence, referenceDescription: "" }), false);
  const result = validateEvidencePacket({ claims, visualEvidence: [{ ...validEvidence, referenceType: "none" }] });
  assert.equal(result.usableEvidence.length, 0);
  assert.equal(result.issues[0].code, "needs_reference");
});

test("official visual preflight requires verified NASA still states and PDF pages", () => {
  const reference = (id, stateHint, overrides = {}) => ({
    id, stateHint, referenceType: "official_photo",
    sourceUrl: "https://science.nasa.gov/webb", mediaUrl: `https://assets.science.nasa.gov/${id}.png`,
    licenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/", licenseNote: "NASA usage guidance", ...overrides
  });
  const references = [reference("A", "folded"), reference("B", "deployed")];
  const assets = references.map((entry, index) => ({
    referenceId: entry.id, verified: true, finalUrl: entry.mediaUrl, contentType: "image/png",
    sha256: `hash-${index}`, cachedPath: `data/source-cache/${entry.id}.png`
  }));
  assert.equal(validateOfficialVisualPreflight({ references, assets, allowedHostSuffixes: ["nasa.gov"] }).passed, true);
  const pdf = reference("PDF", "sequence", {
    referenceType: "official_diagram", sourceUrl: "https://science.nasa.gov/webb.pdf", mediaUrl: "", referencePage: 4
  });
  assert.equal(validateOfficialVisualPreflight({ references: [references[0], pdf], assets: [assets[0], { ...assets[1], referenceId: "PDF", finalUrl: pdf.sourceUrl, contentType: "application/pdf", cachedPath: "data/source-cache/webb-page-4.png" }], allowedHostSuffixes: ["nasa.gov"] }).passed, true);
  const missingPage = validateOfficialVisualPreflight({ references: [references[0], { ...pdf, referencePage: 0 }], assets, allowedHostSuffixes: ["nasa.gov"] });
  assert.ok(missingPage.issues.some((entry) => entry.code === "official_reference_url_invalid"));
  const motionReference = reference("MOTION", "deployment_motion", {
    referenceType: "official_motion_reference", mediaKind: "video_reference_only", mediaUrl: "https://svs.gsfc.nasa.gov/deployment.mp4"
  });
  assert.equal(validateOfficialVisualPreflight({ references: [...references, motionReference], assets, allowedHostSuffixes: ["nasa.gov"] }).passed, true);
});

test("official visual preflight permits distinct cropped panels from one diagram", () => {
  const reference = (id, stateHint, panelCrop) => ({
    id, stateHint, panelCrop, referenceType: "official_diagram",
    sourceUrl: "https://science.nasa.gov/webb", mediaUrl: "https://assets.science.nasa.gov/deployment.png",
    licenseUrl: "https://www.nasa.gov/license", licenseNote: "NASA"
  });
  const references = [reference("A", "folded", [0, 0, .2, .5]), reference("B", "deployed", [.2, 0, .2, .5])];
  const assets = references.map((entry) => ({ referenceId: entry.id, verified: true, finalUrl: entry.mediaUrl, contentType: "image/png", sha256: "shared", cachedPath: `cache/${entry.id}` }));
  assert.equal(validateOfficialVisualPreflight({ references, assets, allowedHostSuffixes: ["nasa.gov"] }).passed, true);
  const duplicate = validateOfficialVisualPreflight({ references: [references[0], { ...references[1], panelCrop: [0, 0, .2, .5] }], assets, allowedHostSuffixes: ["nasa.gov"] });
  assert.ok(duplicate.issues.some((entry) => entry.code === "official_reference_duplicate_media"));
});

test("official visual preflight rejects HTML masquerade, duplicates, license gaps and hidden photos", () => {
  const references = [
    { id: "A", stateHint: "same", referenceType: "official_photo", sourceUrl: "https://science.nasa.gov/a", mediaUrl: "https://assets.science.nasa.gov/a.png", licenseUrl: "", licenseNote: "", requiresSection: true },
    { id: "B", stateHint: "same", referenceType: "official_photo", sourceUrl: "https://science.nasa.gov/b", mediaUrl: "https://assets.science.nasa.gov/b.png", licenseUrl: "https://www.nasa.gov/license", licenseNote: "NASA" }
  ];
  const assets = [
    { referenceId: "A", verified: true, finalUrl: references[0].mediaUrl, contentType: "text/html", sha256: "same", cachedPath: "a.html" },
    { referenceId: "B", verified: true, finalUrl: references[1].mediaUrl, contentType: "image/png", sha256: "same", cachedPath: "b.png" }
  ];
  const codes = validateOfficialVisualPreflight({ references, assets, allowedHostSuffixes: ["nasa.gov"] }).issues.map((entry) => entry.code);
  assert.ok(codes.includes("official_reference_license_missing"));
  assert.ok(codes.includes("official_reference_media_type_invalid"));
  assert.ok(codes.includes("official_reference_duplicate_state"));
  assert.ok(codes.includes("official_reference_duplicate_media"));
  assert.ok(codes.includes("official_reference_hidden_element_unverified"));
});

test("production brief blocks reused evidence and hidden external requirements", () => {
  const brief = { visualStates: [
    { stateId: "VS-1", evidenceRefs: ["EV-01"], evidenceBeats: [{ beatId: "B-1", requiredVisibleElements: ["외부 구조", "매립 냉각관"] }] },
    { stateId: "VS-2", evidenceRefs: ["EV-01"], evidenceBeats: [{ beatId: "B-2", requiredVisibleElements: ["외부 구조", "지지부"] }] }
  ] };
  const codes = validateProductionBriefEvidence(brief, { claims, visualEvidence: [{ ...validEvidence, referenceType: "official_photo", referenceMediaUrl: "https://example.org/photo.jpg", referencePage: 0 }] }).map((item) => item.code);
  assert.ok(codes.includes("occluded_element_required"));
  assert.ok(codes.includes("unverified_state_split"));
});

test("multi-panel official diagrams can support distinct production states", () => {
  const diagram = {
    ...validEvidence,
    referenceType: "official_diagram",
    referenceMediaUrl: "https://example.org/sequence.png",
    referencePage: 0,
    visibleFacts: ["접힌 상태", "팔레트 전개", "타워 연장"]
  };
  const brief = { visualStates: [
    { stateId: "VS-1", evidenceRefs: ["EV-01"], evidenceBeats: [] },
    { stateId: "VS-2", evidenceRefs: ["EV-01"], evidenceBeats: [] }
  ] };
  assert.equal(validateProductionBriefEvidence(brief, { claims, visualEvidence: [diagram] }).some((entry) => entry.code === "unverified_state_split"), false);
});

test("usable section evidence does not over-block a normal visual state", () => {
  const brief = { visualStates: [{
    stateId: "VS-1", evidenceRefs: ["EV-01"],
    evidenceBeats: [{ beatId: "B-1", requiredVisibleElements: ["공식 단면", "매립 냉각관"] }]
  }] };
  assert.deepEqual(validateProductionBriefEvidence(brief, { claims, visualEvidence: [validEvidence] }), []);
});

test("INFO contract catches missing direction, baseline and structured duplicate", () => {
  const item = { infoSpec: { type: "comparison", labels: ["이전", "이후"], anchors: ["축"], directionRule: "", comparisonRule: "" } };
  const issues = validateInfoLayoutContract({ guidePoints: [{ x: .5, y: .7 }, { x: .5, y: .6 }, { x: .5, y: .6 }] }, item, [item]);
  const codes = issues.map((entry) => entry.code);
  assert.ok(codes.includes("info_comparison_gap_missing"));
  assert.ok(codes.includes("info_shared_baseline_missing"));
  assert.ok(codes.includes("info_structured_duplicate"));
});

test("factual badges require a source and reject endpoint geometry", () => {
  const factualBadge = {
    infoSpec: {
      type: "scale_limit",
      labels: ["약 2m 연장"],
      anchors: ["분리 타워"],
      geometryPolicy: "factual_badge",
      evidenceSourceUrl: "https://science.nasa.gov/mission/webb/deployment/",
      evidenceStatement: "NASA는 분리 타워가 약 2미터 연장됐다고 설명한다."
    }
  };
  const validLayout = { geometryMode: "fact_badge", guidePoints: [], labelPositions: [{ x: .08, y: .12 }], renderedLabels: ["약 2m 연장"] };
  assert.deepEqual(validateInfoLayoutContract(validLayout, factualBadge), []);
  assert.ok(validateInfoLayoutContract({ ...validLayout, guidePoints: [{ x: .3, y: .4 }] }, factualBadge)
    .some((entry) => entry.code === "info_factual_badge_endpoints"));
  assert.ok(validateInfoLayoutContract(validLayout, { infoSpec: { ...factualBadge.infoSpec, geometryPolicy: "anchored_geometry" } })
    .some((entry) => entry.code === "info_factual_badge_unsourced"));
});

test("five data-driven gold known-bad cases are caught by the shared evaluator", async () => {
  const gold = JSON.parse(await readFile(new URL("./fixtures/quality-gold-cases.json", import.meta.url), "utf8"));
  assert.equal(gold.cases.length, 5);
  for (const knownBad of gold.cases) {
    const result = evaluateGoldQualityCase(knownBad);
    assert.deepEqual(result.misses, [], knownBad.caseKey);
  }
});

test("benchmark assertion and INFO none gates reject missing contracts", () => {
  const comparison = compareBenchmarkAssertions({ requireClaimEvidenceStateLinks: true, info: { expectedAction: "drop", requiresAnchor: true } }, {
    claimEvidenceStateLinked: false, infoAction: "pass", infoHasAnchor: false
  }).map((entry) => entry.code);
  assert.deepEqual(comparison, ["benchmark_link_missing", "benchmark_info_action", "benchmark_info_anchor"]);
  const noneIssues = validateInfoLayoutContract({ guidePoints: [{ x: .4, y: .4 }] }, { infoSpec: { type: "none", requiresOverlay: true } });
  assert.deepEqual(noneIssues.map((entry) => entry.code), ["info_none_redundant", "info_none_required"]);
});

test("quality report calls legacy PASS reference gaps by their correct name", () => {
  const benchmark = { caseKey: "legacy-pass", expectations: { assertions: { requiredIssueCodes: ["needs_reference"] } } };
  const report = buildBenchmarkReportCase(benchmark, {
    topic: { id: 1 },
    fact: {
      status: "PASS",
      claims_json: JSON.stringify(claims),
      raw_json: JSON.stringify({ visualEvidence: [{ ...validEvidence, referenceType: "none", referencePage: 0, referenceMediaUrl: "" }] })
    },
    findings: [],
    invocationCount: 0
  });
  assert.deepEqual(report.legacyPassReferenceGaps, ["needs_reference"]);
  assert.deepEqual(report.recordedKnownBadMisses, ["needs_reference"]);
  assert.deepEqual(report.referenceHealth.issueCodes, ["needs_reference"]);
  assert.equal(Object.hasOwn(report, "falseBlocks"), false);
  assert.equal(Object.hasOwn(report, "currentGateCriticalMisses"), false);
});

test("current snapshots are not scored against historical known-bad expectations", () => {
  const benchmark = { caseKey: "resolved-thames", expectations: { assertions: { requiredIssueCodes: ["unverified_state_split"] } } };
  const report = buildBenchmarkReportCase(benchmark, {
    fact: { status: "PASS", claims_json: JSON.stringify(claims), raw_json: JSON.stringify({ visualEvidence: [validEvidence] }) },
    brief: { visual_states_json: JSON.stringify([{ stateId: "VS-1", evidenceRefs: ["EV-01"], evidenceBeats: [] }]) },
    findings: []
  });
  assert.deepEqual(report.currentSnapshotIssueCodes, []);
  assert.deepEqual(report.recordedKnownBadMisses, ["unverified_state_split"]);
  assert.equal(Object.hasOwn(report, "currentGateCriticalMisses"), false);
});
