const REFERENCE_TYPES = new Set([
  "official_photo",
  "construction_photo",
  "official_diagram",
  "official_section"
]);

function issue(code, message, options = {}) {
  return {
    code,
    severity: options.severity || "error",
    owner: options.owner || "fact_check",
    requiresEvidence: Boolean(options.requiresEvidence),
    affectedArtifactIds: options.affectedArtifactIds || [],
    message
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isValidVisualReference(evidence = {}) {
  const referenceType = String(evidence.referenceType || "");
  const sourceUrl = String(evidence.referenceSourceUrl || "");
  const mediaUrl = String(evidence.referenceMediaUrl || "");
  const page = Number(evidence.referencePage || 0);
  return REFERENCE_TYPES.has(referenceType)
    && isHttpUrl(sourceUrl)
    && String(evidence.referenceDescription || "").trim().length > 0
    && (isHttpUrl(mediaUrl) || (/\.pdf(?:$|[?#])/iu.test(sourceUrl) && Number.isInteger(page) && page > 0));
}

export function isHiddenVisualRequirement(value) {
  const text = String(value || "");
  return /(수중|강바닥|내부|지하|매립|가려진)/u.test(text)
    && !/(노출|드러난|개방된|매립\s*전|타설\s*전|시공\s*중|거푸집\s*(안|내부)|외부에서\s*보이는)/u.test(text);
}

export function validateEvidencePacket({ claims = [], visualEvidence = [] } = {}) {
  const supported = new Set(claims
    .filter((claim) => claim?.status === "SUPPORTED" && claim?.useInVideo !== false)
    .map((claim) => String(claim.id)));
  const issues = [];
  const usable = [];
  for (const evidence of visualEvidence) {
    const id = String(evidence?.id || evidence?.state || "").trim();
    const refs = (evidence?.claimRefs || []).map(String);
    if (!id || !refs.length || refs.some((ref) => !supported.has(ref))) {
      issues.push(issue("invalid_claim_evidence_link", `시각 근거 ${id || "미지정"}가 지원된 주장에 연결되지 않습니다.`, { requiresEvidence: true, affectedArtifactIds: id ? [id] : [] }));
      continue;
    }
    if (!isValidVisualReference(evidence)) {
      issues.push(issue("needs_reference", `시각 근거 ${id}에 실제 공식 사진·도면·단면 또는 유효 PDF 페이지가 없습니다.`, { requiresEvidence: true, affectedArtifactIds: [id] }));
      continue;
    }
    usable.push(evidence);
  }
  return { issues, usableEvidence: usable, supportedClaimIds: supported };
}

export function validateProductionBriefEvidence(brief = {}, factCheck = {}) {
  const packet = validateEvidencePacket(factCheck);
  const issues = [...packet.issues];
  const evidenceById = new Map(packet.usableEvidence.map((entry) => [String(entry.id || entry.state), entry]));
  const used = new Set();
  for (const state of brief.visualStates || []) {
    const stateId = String(state?.stateId || "");
    const refs = (state?.evidenceRefs || []).map(String);
    if (!refs.length || refs.some((ref) => !evidenceById.has(ref))) {
      issues.push(issue("unverified_visual_state", `${stateId || "미지정 상태"}가 실제 제작 가능한 근거에 연결되지 않습니다.`, { owner: "production_brief", requiresEvidence: true, affectedArtifactIds: [stateId, ...refs].filter(Boolean) }));
    }
    for (const ref of refs) {
      const evidence = evidenceById.get(ref);
      const reusableDiagram = String(evidence?.referenceType || "") === "official_diagram" && (evidence?.visibleFacts || []).length >= 3;
      if (used.has(ref) && !reusableDiagram) issues.push(issue("unverified_state_split", `${stateId}가 ${ref} 근거를 새 상태로 재사용합니다.`, { owner: "production_brief", affectedArtifactIds: [stateId, ref] }));
      used.add(ref);
    }
    for (const beat of state?.evidenceBeats || []) {
      const hidden = (beat?.requiredVisibleElements || []).filter(isHiddenVisualRequirement);
      const referenced = refs.map((ref) => evidenceById.get(ref)).filter(Boolean);
      const supportsHidden = referenced.some((entry) => ["official_section", "construction_photo"].includes(entry.referenceType));
      if (hidden.length && !supportsHidden) {
        issues.push(issue("occluded_element_required", `${stateId}/${beat?.beatId || "미지정"}가 가려진 요소를 요구하지만 단면·시공 근거가 없습니다.`, { owner: "production_brief", requiresEvidence: true, affectedArtifactIds: [stateId, beat?.beatId, ...refs].filter(Boolean) }));
      }
    }
  }
  return issues;
}

export function validateInfoLayoutContract(layout, item = {}, previousItems = []) {
  const issues = [];
  const spec = item.infoSpec || {};
  const type = String(spec.type || "none");
  const points = Array.isArray(layout?.guidePoints) ? layout.guidePoints : [];
  const labels = Array.isArray(layout?.renderedLabels) ? layout.renderedLabels.map(String) : [];
  const isFactualBadge = String(spec.geometryPolicy || "") === "factual_badge";
  if (type === "none") {
    if (points.length || (layout?.labelPositions || []).length || labels.length) {
      issues.push(issue("info_none_redundant", "INFO 없음 장면에 레이아웃 또는 라벨이 남아 있습니다.", { owner: "info" }));
    }
    if (spec.requiresOverlay === true || item.requiresInfo === true) {
      issues.push(issue("info_none_required", "INFO 필요성 계약이 있는데 type=none으로 우회했습니다.", { owner: "info", requiresEvidence: true }));
    }
    return issues;
  }
  if (!layout) return [issue("info_anchor_missing", "INFO 레이아웃 앵커가 없습니다.", { owner: "info", requiresEvidence: true })];
  const expectedLabels = (spec.labels || []).map(String);
  if (labels.length && JSON.stringify(labels) !== JSON.stringify(expectedLabels)) issues.push(issue("info_label_mismatch", "렌더된 라벨이 INFO 명세와 완전 일치하지 않습니다.", { owner: "info" }));
  if (String(layout.geometryMode || "") === "fact_badge" && !isFactualBadge) issues.push(issue("info_factual_badge_unsourced", "라벨 전용 factual badge에는 명시적 사실 배지 계약이 필요합니다.", { owner: "info", requiresEvidence: true }));
  if (isFactualBadge) {
    if (!["location", "scale_limit"].includes(type)) issues.push(issue("info_factual_badge_type", "사실 배지는 위치 또는 규모 사실에만 사용할 수 있습니다.", { owner: "info", requiresEvidence: true }));
    if (expectedLabels.length !== 1) issues.push(issue("info_factual_badge_label", "사실 배지는 읽을 수 있는 단일 사실 라벨이 필요합니다.", { owner: "info", requiresEvidence: true }));
    if (!isHttpUrl(spec.evidenceSourceUrl) || !String(spec.evidenceStatement || "").trim()) issues.push(issue("info_factual_badge_source", "사실 배지에 공식 출처 URL과 근거 문장이 필요합니다.", { owner: "info", requiresEvidence: true }));
    if (String(layout.geometryMode || "") !== "fact_badge") issues.push(issue("info_factual_badge_geometry", "사실 배지는 label-only fact_badge 도형 모드여야 합니다.", { owner: "info", requiresEvidence: true }));
    if (points.length) issues.push(issue("info_factual_badge_endpoints", "사실 배지는 물리 끝점·치수선·거리선을 포함할 수 없습니다.", { owner: "info" }));
  }
  if (["before_after", "comparison"].includes(type) && points.length >= 3) {
    const [base, first, second] = points;
    if (Math.abs(Number(first.x) - Number(second.x)) < 0.02 && Math.abs(Number(first.y) - Number(second.y)) < 0.02) issues.push(issue("info_comparison_gap_missing", "전후 비교 기준점 간격이 없습니다.", { owner: "info" }));
    if (Math.abs(Number(base.y) - Math.min(Number(first.y), Number(second.y))) < 0.12) issues.push(issue("info_shared_baseline_missing", "전후 비교의 공유 기준선이 부족합니다.", { owner: "info" }));
  }
  if (["flow", "load_path", "sequence"].includes(type) && points.length >= 2) {
    const rule = String(spec.directionRule || "");
    if (!/(에서|시작|출발|from)/iu.test(rule) || !/(으로|로|까지|향|도착|끝|to)/iu.test(rule)) issues.push(issue("info_direction_missing", "화살표 시작·도착 방향 규칙이 없습니다.", { owner: "info" }));
  }
  const signature = JSON.stringify({ type, labels: spec.labels || [], anchors: spec.anchors || [], directionRule: spec.directionRule || "", comparisonRule: spec.comparisonRule || "", geometryPolicy: spec.geometryPolicy || "" });
  if (type !== "none" && previousItems.some((previous) => JSON.stringify({ type: previous?.infoSpec?.type, labels: previous?.infoSpec?.labels || [], anchors: previous?.infoSpec?.anchors || [], directionRule: previous?.infoSpec?.directionRule || "", comparisonRule: previous?.infoSpec?.comparisonRule || "", geometryPolicy: previous?.infoSpec?.geometryPolicy || "" }) === signature)) {
    issues.push(issue("info_structured_duplicate", "같은 CLEAN 또는 인접 장면의 INFO 관계를 반복합니다.", { owner: "info" }));
  }
  return issues;
}

export function compareBenchmarkAssertions(assertions = {}, actual = {}) {
  const issues = [];
  if (assertions.expectedStage && assertions.expectedStage !== actual.stage) issues.push(issue("benchmark_stage_mismatch", `기대 단계 ${assertions.expectedStage}와 실제 ${actual.stage}가 다릅니다.`, { owner: "benchmark" }));
  if (assertions.expectedVerdict && assertions.expectedVerdict !== actual.verdict) issues.push(issue("benchmark_verdict_mismatch", `기대 판정 ${assertions.expectedVerdict}와 실제 ${actual.verdict}가 다릅니다.`, { owner: "benchmark" }));
  const found = new Set((actual.issueCodes || []).map(String));
  for (const code of assertions.requiredIssueCodes || []) if (!found.has(code)) issues.push(issue("benchmark_critical_miss", `필수 이슈 ${code}를 잡지 못했습니다.`, { owner: "benchmark", affectedArtifactIds: [code] }));
  const references = actual.usableEvidence || [];
  if (Number(assertions.minimumVisualReferences || 0) > references.length) issues.push(issue("benchmark_reference_minimum", "실제 시각 참조 수가 기대값보다 적습니다.", { owner: "benchmark", requiresEvidence: true }));
  if (Array.isArray(assertions.allowedReferenceTypes) && assertions.allowedReferenceTypes.length && references.some((entry) => !assertions.allowedReferenceTypes.includes(entry.referenceType))) issues.push(issue("benchmark_reference_type", "허용되지 않은 참조 유형이 사용되었습니다.", { owner: "benchmark" }));
  if (assertions.requireClaimEvidenceStateLinks && actual.claimEvidenceStateLinked !== true) issues.push(issue("benchmark_link_missing", "주장·시각 근거·제작 상태 연결이 완전하지 않습니다.", { owner: "benchmark", requiresEvidence: true }));
  const info = assertions.info || {};
  if (info.expectedAction && info.expectedAction !== actual.infoAction) issues.push(issue("benchmark_info_action", "INFO 기대 조치와 실제 조치가 다릅니다.", { owner: "benchmark" }));
  if (info.requiresAnchor && actual.infoHasAnchor !== true) issues.push(issue("benchmark_info_anchor", "INFO 앵커 계약이 없습니다.", { owner: "benchmark" }));
  if (info.requiresDirection && actual.infoHasDirection !== true) issues.push(issue("benchmark_info_direction", "INFO 방향 계약이 없습니다.", { owner: "benchmark" }));
  if (info.requiresComparison && actual.infoHasComparison !== true) issues.push(issue("benchmark_info_comparison", "INFO 비교 계약이 없습니다.", { owner: "benchmark" }));
  return issues;
}

export function evaluateGoldQualityCase(goldCase = {}) {
  const factCheck = goldCase.factCheck || {};
  const brief = goldCase.productionBrief || {};
  const issues = [
    ...validateEvidencePacket(factCheck).issues,
    ...validateProductionBriefEvidence(brief, factCheck)
  ];
  for (const check of goldCase.infoChecks || []) {
    issues.push(...validateInfoLayoutContract(check.layout || null, check.item || {}, check.previousItems || []));
  }
  const issueCodes = [...new Set(issues.map((entry) => entry.code))];
  const expectedIssueCodes = (goldCase.expectedIssueCodes || []).map(String);
  const misses = expectedIssueCodes.filter((code) => !issueCodes.includes(code));
  return { caseKey: goldCase.caseKey || "", issueCodes, expectedIssueCodes, misses };
}

function isAllowedOfficialUrl(value, allowedHostSuffixes = []) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:"
      && allowedHostSuffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function normalizedPanelCrop(reference = {}) {
  const candidate = reference.panelCrop || reference.focusBounds || reference.metadata?.panelCrop || reference.metadata?.focusBounds;
  if (!Array.isArray(candidate) || candidate.length !== 4) return "";
  const values = candidate.map(Number);
  const [x, y, width, height] = values;
  if (!values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return "";
  return values.map((value) => value.toFixed(6)).join(",");
}

export function validateOfficialVisualPreflight({
  references = [],
  assets = [],
  requireDistinctStillStates = 2,
  allowedHostSuffixes = []
} = {}) {
  const assetById = new Map(assets.map((asset) => [String(asset.referenceId || asset.id), asset]));
  const issues = [];
  const seenStates = new Set();
  const seenMediaRegions = new Set();
  let usableStillStates = 0;
  for (const reference of references) {
    const id = String(reference?.id || "");
    const asset = assetById.get(id);
    const state = String(reference?.stateHint || "");
    const mediaKind = String(reference?.mediaKind || "still");
    const sourceUrl = String(reference?.sourceUrl || "");
    const mediaUrl = String(reference?.mediaUrl || "");
    const sourceIsPdf = /\.pdf(?:$|[?#])/iu.test(sourceUrl);
    const hasPdfPage = sourceIsPdf && Number.isInteger(Number(reference?.referencePage)) && Number(reference.referencePage) > 0;
    if (!/^https:\/\//iu.test(sourceUrl) || (!/^https:\/\//iu.test(mediaUrl) && !hasPdfPage)) {
      issues.push(issue("official_reference_url_invalid", `${id || "미지정"} 공식 reference URL이 HTTPS가 아니거나 PDF 페이지가 없습니다.`, { requiresEvidence: true }));
    }
    if (allowedHostSuffixes.length && (![sourceUrl, mediaUrl, String(asset?.finalUrl || "")].filter(Boolean).every((url) => isAllowedOfficialUrl(url, allowedHostSuffixes)))) {
      issues.push(issue("official_reference_source_untrusted", `${id || "미지정"} reference가 공식 source allowlist 밖입니다.`, { requiresEvidence: true }));
    }
    if (!String(reference?.licenseUrl || "").startsWith("https://") || !String(reference?.licenseNote || "").trim()) issues.push(issue("official_reference_license_missing", `${id || "미지정"} license 근거가 없습니다.`, { requiresEvidence: true }));
    if (!state) issues.push(issue("official_reference_state_missing", `${id || "미지정"} state hint가 없습니다.`, { requiresEvidence: true }));
    if (mediaKind !== "video_reference_only" && (!asset?.verified || !asset?.contentType || !asset?.sha256 || !asset?.cachedPath)) issues.push(issue("official_reference_unverified", `${id || "미지정"} media preflight가 완료되지 않았습니다.`, { requiresEvidence: true }));
    if (asset?.verified && mediaKind !== "video_reference_only") {
      if (!/^image\//iu.test(asset.contentType) && asset.contentType !== "application/pdf") {
        issues.push(issue("official_reference_media_type_invalid", `${id}가 이미지 또는 PDF가 아닌 응답입니다.`, { requiresEvidence: true }));
      }
      const panelCrop = normalizedPanelCrop(reference);
      const hasDeclaredCrop = reference.panelCrop != null || reference.focusBounds != null || reference.metadata?.panelCrop != null || reference.metadata?.focusBounds != null;
      if (hasDeclaredCrop && !panelCrop) issues.push(issue("official_reference_crop_invalid", `${id}의 panel crop이 정규화된 범위가 아닙니다.`, { requiresEvidence: true }));
      const mediaRegion = `${asset.sha256}:${panelCrop || "whole"}`;
      if (seenStates.has(state)) issues.push(issue("official_reference_duplicate_state", `${id}가 같은 시각 상태를 중복합니다.`, { requiresEvidence: true }));
      if (seenMediaRegions.has(mediaRegion)) issues.push(issue("official_reference_duplicate_media", `${id}가 같은 media 또는 panel crop을 재사용합니다.`, { requiresEvidence: true }));
      seenStates.add(state);
      seenMediaRegions.add(mediaRegion);
      if (/^image\//iu.test(asset.contentType) || asset.contentType === "application/pdf") usableStillStates += 1;
      if (reference.requiresSection === true && !["official_section", "construction_photo"].includes(String(reference.referenceType || ""))) {
        issues.push(issue("official_reference_hidden_element_unverified", `${id}가 숨은 요소를 요구하지만 단면·시공 자료가 아닙니다.`, { requiresEvidence: true }));
      }
    }
  }
  if (usableStillStates < requireDistinctStillStates) issues.push(issue("official_reference_insufficient_states", `서로 다른 CLEAN still 상태가 ${usableStillStates}/${requireDistinctStillStates}개입니다.`, { requiresEvidence: true }));
  return { passed: issues.length === 0, issues, usableStillStates };
}
