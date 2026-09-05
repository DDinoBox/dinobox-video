import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const dashboard = await readFile(new URL("../dashboard/index.html", import.meta.url), "utf8");

test("durable AI job API remains wired", () => {
  for (const route of [
    "/api/health",
    "/api/quality/benchmarks",
    "/api/quality/benchmarks/advance",
    "/api/quality/benchmarks/advance-all",
    "/api/quality/benchmarks/remediate-all",
    "/api/quality/replay",
    "/api/jobs",
    "/api/jobs/events",
    "/api/jobs/cancel",
    "/api/topics/fact-check",
    "/api/topics/script",
    "/api/topics/script/update",
    "/api/shotlists/approve",
    "/api/images/clean/generate",
    "/api/images/info/generate",
    "/api/assets/clean/finalize",
    "/api/assets/info/finalize",
    "/api/assets/review",
    "/api/scenes/prompt",
    "/api/prompts/info/save",
    "/api/video/generate",
    "/api/video/review",
    "/api/edit/plan",
    "/api/edit/open"
  ]) {
    assert.match(server, new RegExp(route.replaceAll("/", "\\/")));
  }
  assert.match(server, /runStreamed/);
  assert.match(server, /BEGIN IMMEDIATE/);
  assert.match(server, /isReadableSourceDocument/);
  assert.match(server, /기본 출처가 차단되어 공식·전문 출처 보강 경로로 전환합니다/);
  assert.match(server, /USAGE_GUARD_ENABLED/);
  assert.match(server, /CODEX_MODEL_ATTEMPT_LIMIT/);
  assert.match(server, /AI_JOB_TIMEOUT_MS/);
  assert.match(server, /FACT_CHECK_JOB_TIMEOUT_MINUTES/);
  assert.match(server, /CLEAN_IMAGE_JOB_TIMEOUT_MINUTES/);
  assert.match(server, /attempt >= max_attempts/);
  assert.match(server, /서버 재시작 시 재시도 한도를 소진해 작업을 중단했습니다/);
  assert.match(server, /imageProductionUnlocked/);
  assert.match(server, /const existingAssets = await listProjectAssetsForTopic\(topicId\)/);
  assert.match(server, /대표 CLEAN·INFO 검수를 먼저 통과해야 전체 이미지를 생성할 수 있습니다/);
  assert.match(server, /invalidComparisonLayouts/);
  assert.match(server, /geometryMode: "none"/);
  assert.match(server, /사용량 보호 중에는 제작 주제를 한 번에 하나만 처리합니다/);
  assert.match(server, /if \(USAGE_GUARD_ENABLED\) return;/);
  assert.match(dashboard, /사용량 보호/);
  assert.match(dashboard, /예상 작업량/);
  assert.match(dashboard, /탈락 후보를 몰래 추가 보충하지 않습니다/);
  assert.match(dashboard, /검토 AI · 5개 공학 벤치마크/);
  assert.match(dashboard, /benchmark-status-grid/);
  assert.match(dashboard, /전체 다음 단계/);
  assert.match(dashboard, /근거·설계 보강 필요/);
  assert.match(dashboard, /교차 비교 대기/);
  assert.match(dashboard, /진행 가능한 단계 없음/);
  assert.match(dashboard, /보강 작업 시작/);
  assert.match(dashboard, /도면·참조 이미지 필요/);
  assert.match(dashboard, /대본 범위 축소 필요/);
  assert.match(dashboard, /remediateAllBenchmarks/);
  assert.match(dashboard, /검증 시각 근거 부족/);
  assert.match(dashboard, /advanceAllBenchmarks/);
  assert.match(dashboard, /loadBenchmarkQuality\(\)\.catch/);
});

test("production contract revision uses a scoped timeout and bounded retry", () => {
  const enqueue = server.slice(
    server.indexOf("function isProductionContractRevisionJob"),
    server.indexOf("function claimNextAiJob")
  );
  const context = server.slice(
    server.indexOf("function createJobContext"),
    server.indexOf("function maintainDiscoveryVerificationQueue")
  );
  const revision = server.slice(
    server.indexOf("async function reviseProductionBriefFromQualityFeedback"),
    server.indexOf("function compactEvidenceText")
  );
  const execution = server.slice(
    server.indexOf("async function executeAiJob"),
    server.indexOf("function maintainBenchmarkRemediationQueue")
  );
  const retryCatch = execution.slice(execution.lastIndexOf("} catch (error)"));

  assert.match(server, /PRODUCTION_CONTRACT_REVISION_JOB_TIMEOUT_MS = clampConfiguredNumber\(process\.env\.PRODUCTION_CONTRACT_REVISION_JOB_TIMEOUT_MINUTES, 12, 8, 20\)/);
  assert.match(server, /PRODUCTION_CONTRACT_REVISION_CODEX_TIMEOUT_MS = clampConfiguredNumber\(process\.env\.PRODUCTION_CONTRACT_REVISION_CODEX_TIMEOUT_MINUTES, 7, 5, 12\)/);
  assert.match(server, /PRODUCTION_CONTRACT_REVISION_MAX_ATTEMPTS = clampConfiguredInteger\(process\.env\.PRODUCTION_CONTRACT_REVISION_MAX_ATTEMPTS, 2, 1, 2\)/);
  assert.match(enqueue, /type === "production_brief_generate" && payload\?\.remediationRoute === "production_contract_revision"/);
  assert.match(enqueue, /const maxAttempts = isProductionContractRevisionJob\(type, payload\)[\s\S]*?PRODUCTION_CONTRACT_REVISION_MAX_ATTEMPTS[\s\S]*?: 1/);
  assert.match(context, /isProductionContractRevisionJob\(job\.type, job\.payload\)[\s\S]*?PRODUCTION_CONTRACT_REVISION_JOB_TIMEOUT_MS[\s\S]*?AI_JOB_TIMEOUT_MS\[job\.type\]/);
  assert.match(revision, /const codexTimeoutMs = assetQualityFeedback\?\.findings\?\.length[\s\S]*?PRODUCTION_CONTRACT_REVISION_CODEX_TIMEOUT_MS[\s\S]*?: 240000/);
  assert.match(revision, /production-brief-quality-revision-\$\{topic\.id\}`, codexTimeoutMs/);
  assert.match(revision, /beforeContractHash === revisedContractHash/);
  assert.match(retryCatch, /isProductionContractRevisionJob\(job\.type, job\.payload\)[\s\S]*?timedOut[\s\S]*?job\.attempt < job\.maxAttempts/);
  assert.match(retryCatch, /status = 'queued'[\s\S]*?attempt < max_attempts/);
  assert.match(retryCatch, /appendJobEvent\(job\.id, job\.topicId, "retry"/);
  assert.doesNotMatch(retryCatch, /result_json|payload_json/);
});

test("configured six-state scripts use a compact manifest-bound generation contract", () => {
  const stateBounded = server.slice(
    server.indexOf("function requiresStateBoundedScript"),
    server.indexOf("async function generateScript")
  );
  const generation = server.slice(
    server.indexOf("async function generateScript"),
    server.indexOf("function updateTopicStatus")
  );
  const validation = server.slice(
    server.indexOf("function validateScriptContract"),
    server.indexOf("function getScriptQualityIssues")
  );

  assert.match(stateBounded, /minimumVisualStates >= 6/);
  assert.match(stateBounded, /productionScript는 정확히 \$\{stateCards\.length\}행/);
  assert.match(stateBounded, /requiredInfoGraphics가 있는 서로 다른 상태 중 최소/);
  assert.match(stateBounded, /supportedClaims/);
  assert.match(generation, /const stateBoundedScript = requiresStateBoundedScript\(topic, productionBrief\)/);
  assert.match(generation, /buildStateBoundedScriptPrompt\(topic, factCheck, productionBrief, productionRequirements, downstreamFeedback, scriptFeedback\)/);
  assert.match(generation, /runCodexJson\(generationPrompt, `script-\$\{id\}`/);
  assert.match(generation, /validateScriptContract\(normalizeScriptResult\(rawResult\), productionBrief, stateBoundedScript\)/);
  assert.match(validation, /requireExactStateSequence = false/);
  assert.match(validation, /JSON\.stringify\(actualStateIds\) !== JSON\.stringify\(expectedStateIds\)/);
});

test("dashboard exposes current production stages and job feedback", () => {
  for (const label of [
    "조사 / 사실 검증",
    "대본 생성",
    "대본 승인",
    "TTS 생성",
    "CLEAN 이미지",
    "INFO 이미지",
    "H3 영상",
    "백그라운드 작업",
    "생성 프로필",
    "영상 승인",
    "OpenShot에서 편집"
  ]) {
    assert.match(dashboard, new RegExp(label));
  }
  assert.match(dashboard, />INFO 검수</);
  assert.match(dashboard, /CLEAN 검수/);
  assert.match(dashboard, /clean-review-workspace/);
  assert.match(dashboard, /CLEAN 전체 승인/);
  assert.match(dashboard, /data-viewer-type="info"/);
  assert.match(dashboard, /INFO 이미지 생성/);
  assert.match(dashboard, /INFO 다시 설계·생성/);
  assert.match(dashboard, /파일·합성 검사/);
  assert.match(dashboard, /new EventSource/);
  assert.match(dashboard, /startTtsGenerationFeedback/);
  assert.match(dashboard, /tts-generation-elapsed/);
  assert.match(dashboard, /장면별 대사를 순서대로 합성하고 실제 길이를 측정하고 있습니다/);
  assert.match(dashboard, /대본 수정/);
  assert.match(dashboard, /action = "approve-script"/);
  assert.match(dashboard, /수정 저장 \/ 승인/);
  assert.match(dashboard, /수정 저장/);
  assert.match(dashboard, /교체 생성/);
  assert.match(dashboard, /CLEAN 이미지 생성/);
  assert.match(dashboard, /data-info-review-index/);
  assert.match(dashboard, /info-review-workspace/);
  assert.match(dashboard, /INFO 교체/);
  assert.match(dashboard, /전체 승인/);
  assert.match(dashboard, /영상 전체 생성/);
  assert.match(dashboard, /검증된 주제 찾기/);
  assert.match(dashboard, /실제 사례 주제 탐색/);
  assert.match(server, /TOPIC_DISCOVERY_OUTPUT_SCHEMA/);
  assert.match(server, /구체적 대상.*눈에 보이는 이상한 현상\/반전.*단일 메커니즘/);
  assert.match(server, /topic_discovery/);
  assert.match(server, /caseStudySeeds/);
  assert.match(server, /source: "topic_discovery"/);
  assert.match(server, /maintainDiscoveryVerificationQueue/);
  assert.match(server, /fetchCrossrefEvidence/);
  assert.match(server, /fetchEnglishWikipediaTitle/);
  assert.match(server, /extractPdfText/);
  assert.match(server, /selectRelevantSourceExcerpt/);
  assert.match(server, /relevant source section/);
  assert.match(server, /application\/pdf/);
  assert.match(server, /%PDF-/);
  assert.match(server, /extract_pdf_text\.py/);
  assert.match(server, /PDF_PYTHON_BIN/);
  assert.match(server, /\.slice\(0, 8\)/);
  assert.match(server, /숫자나 단위가 없다는 이유만으로 HOLD 또는 REJECT하지 마세요/);
  assert.match(server, /메커니즘 하나로 영상 범위를 좁히세요/);
});

test("original MD CLEAN to INFO contract is enforced", async () => {
  const workflow = await readFile(new URL("../workflows/minimax_h3_i2v_api.json", import.meta.url), "utf8");
  const engineering = await readFile(new URL("../domains/engineering.yaml", import.meta.url), "utf8");
  assert.match(server, /core_mechanism/);
  assert.match(server, /state_change_reason/);
  assert.match(server, /asset_reviews/);
  assert.match(server, /generationReady/);
  assert.match(workflow, /"last_frame"/);
  assert.match(engineering, /edit_same_clean/);
  assert.match(engineering, /0\.0~0\.4/);
  assert.match(server, /INFO_PLAN_VERSION/);
  assert.match(server, /첫 TTS 구간은 문제와 대상을 영상으로 먼저 보여주고 INFO를 사용하지 않음/);
  assert.match(server, /INFO 장면이 \$\{count\}개라 핵심 하나로 제한해야 함/);
  assert.match(server, /제작용 방위가 시청자 라벨에 노출됨/);
  assert.match(server, /infoPlanStale/);
  assert.match(server, /geometryMode/);
  assert.match(server, /실제 화면에 고정할 수 없는 INFO 장면/);
  assert.doesNotMatch(server, /AI 앵커 분석이 실패해 안전한 기본 레이아웃으로 계속합니다/);
});

test("media generation uses deterministic INFO layers and automatic QC", async () => {
  const infoRenderer = await readFile(new URL("../scripts/render_info_overlay.py", import.meta.url), "utf8");
  const mediaQc = await readFile(new URL("../scripts/media_qc.py", import.meta.url), "utf8");
  assert.match(server, /INFO_RENDERER/);
  assert.match(server, /MEDIA_QC_RUNNER/);
  assert.match(server, /_INFO_GUIDES\.png/);
  assert.match(server, /_INFO_LABELS\.png/);
  assert.match(server, /composeInfoOverlayVideo/);
  assert.match(server, /inspectInfoAsset/);
  assert.match(server, /mode: "info"/);
  assert.match(server, /finalizeInfoAssets/);
  assert.match(server, /runVideoAutoQc/);
  assert.match(server, /reviewCleanImageWithAi/);
  assert.match(server, /shouldContinueQualityRepair\(independentReview, qualityCycle, qualityStartedAt, 1\)/);
  assert.match(server, /\[Independent reviewer correction\]/);
  assert.match(server, /\[Geometry correction contract\]/);
  assert.match(server, /do not average, blend, or borrow components from other stages/);
  assert.match(server, /Any elements described as connected must visibly touch at their anchors with no floating gap/);
  assert.match(server, /reviewInfoImageWithAi/);
  assert.match(server, /independentSemantic/);
  assert.match(server, /action: \{ type: "string", enum: \["pass", "revise", "drop"\] \}/);
  assert.match(server, /품질 수렴 판단에 따라 INFO 실패 원인만 교정합니다/);
  assert.match(server, /auto_qc_json/);
  assert.match(infoRenderer, /labelFontPath/);
  assert.match(infoRenderer, /alpha_composite/);
  assert.match(mediaQc, /aspectRatio/);
  assert.match(mediaQc, /closestReferences/);
  assert.match(mediaQc, /layoutTrusted/);
  assert.match(mediaQc, /settlement_rotation/);
});

test("H3 quality profile uses native attention and official prompt sections", () => {
  assert.match(server, /integrated_multimodal_description:/);
  assert.match(server, /overall_soundscape:/);
  assert.match(server, /non_diegetic_music:/);
  assert.match(server, /label: "품질"[\s\S]*?sageAttention: false,[\s\S]*?memoryEfficientAttention: false/);
  assert.match(server, /getH3EffectiveDuration/);
});

test("shotlist generation is an AI job with deterministic validation", () => {
  assert.match(server, /SHOTLIST_OUTPUT_SCHEMA/);
  assert.match(server, /shotlist_generate/);
  assert.match(server, /SHOTLIST_REVIEW_OUTPUT_SCHEMA/);
  assert.match(server, /runShotlistQualityLoop/);
  assert.match(server, /normalizeAiShotlistInfoPlan/);
  assert.match(server, /usedSegments\.has\(segmentIndex\)/);
  assert.match(server, /repeated_visual_state/);
  assert.match(server, /검수에서 보류된 장면표와 실패 근거를 저장했습니다/);
  assert.match(server, /affectedSegmentIndexes/);
  assert.match(server, /Use the complete sequence context to avoid creating a state/);
  assert.match(server, /Every CLEAN frame must be one continuous camera view of one physical state/);
  assert.match(server, /Graphic comparison concepts belong only in INFO/);
  assert.match(server, /SHOTLIST_REVISION_PROGRESS\.json/);
  assert.match(server, /hasExpandedContract/);
  assert.match(server, /PRODUCTION_BRIEF_SCAFFOLD_OUTPUT_SCHEMA/);
  assert.match(server, /SHOTLIST_CONTRACT_VERSION = 7/);
  assert.match(server, /function buildOrderedNarrationAnchors/);
  assert.match(server, /hasExplicitBaseline/);
  assert.match(server, /normalizeVisibilityRequirements/);
  assert.match(server, /PRODUCTION_BRIEF_CONTRACT_VERSION = 4/);
  assert.match(server, /unverified_state_split/);
  assert.match(server, /evidenceRefs/);
  assert.match(server, /referenceMediaUrl/);
  assert.match(server, /ensureVisualReferenceBitmap/);
  assert.match(server, /fact_contract_revision/);
  assert.match(server, /SCRIPT_CONTRACT_VERSION = 8/);
  assert.match(server, /NATIVE_CLIP_DURATION_SEC = 4/);
  assert.match(server, /SCRIPT_STATE_TTS_BUDGET_SEC = 3\.5/);
  assert.match(server, /검증 시각 상태 용량 부족/);
  assert.match(server, /production_canary_measured_tts_capacity_rebuild/);
  assert.match(server, /canary_ai_pass_at = NULL/);
  assert.match(server, /evidenceDurationCapacitySec/);
  assert.match(server, /SCRIPT_AI_CACHE\.json/);
  assert.match(server, /script_generate: 12 \* 60 \* 1000/);
  assert.match(server, /cachedReviews/);
  assert.match(server, /cacheHasSameUpstreamRecords/);
  assert.match(server, /cacheMatchesCurrentContract/);
  assert.match(server, /reviewOnly \? "script_review_replay"/);
  assert.match(server, /cached\.productionBriefId/);
  assert.match(server, /bestCandidate/);
  assert.match(server, /await onCandidate\?\.\(script, candidateReviews, bestCandidate\?\.candidateHash === candidateHash/);
  assert.match(server, /Bind the opening narration to the first approved visual state/);
  assert.match(server, /Judge the opening narration together with the first approved visual state/);
  assert.match(server, /conservative target at least 0\.7 seconds below/);
  assert.match(server, /최고점 후보/);
  assert.match(server, /getLatestUpstreamQualityFeedback/);
  assert.match(server, /scriptFeedbackSignature/);
  assert.match(server, /benchmarkContractResetId/);
  assert.match(server, /normalizeScriptInfoPlan/);
  assert.match(server, /최근 장면표에서 반환된 상위 계약 피드백/);
  assert.match(server, /Never place closed and open, before and after/);
  assert.match(server, /submerged, occluded, internal/);
  assert.match(server, /clean_cutaway_forbidden/);
  assert.match(server, /occluded_element_required/);
  assert.match(server, /buildShotlistEvidenceHash/);
  assert.match(server, /candidate\.evidenceHash === evidenceHash/);
  assert.match(server, /productionContractHash/);
  assert.match(server, /shotlist_claim_scope/);
  assert.match(server, /narrationClaimRefs/);
  assert.doesNotMatch(server, /timeoutAttempt <= 2/);
  assert.match(server, /designShotlistWithAi/);
  assert.match(server, /requiredShotCount/);
  assert.match(server, /minimumCoverageCount/);
  assert.match(server, /const minimumCoverage = Math\.ceil\(duration \/ 4\)/);
  assert.match(server, /const contentPacedTarget = Math\.ceil\(duration \/ 3\.4\)/);
  assert.doesNotMatch(server, /clampInteger\(Math\.ceil\(duration \/ 3\.4\), 16/);
  assert.match(server, /failure_simulation/);
  assert.match(server, /requiredVisibleElements/);
  assert.match(server, /referencePolicy/);
  assert.match(server, /inferScreenDirectionContract/);
  assert.match(server, /getAiSceneContractIssues/);
  assert.match(server, /chunkResult\.scenes\.length > assignedCount/);
  assert.match(server, /필요한 \$\{assignedCount\}개 장면을 반환하지 않았습니다/);
  assert.match(server, /SHOTLIST_AI_CACHE\.json/);
  assert.match(server, /Promise\.allSettled/);
  assert.match(server, /검증되지 않은 주장 ID/);
  const evidenceBoundShotCount = server.slice(
    server.indexOf("function determineEvidenceBoundShotCount"),
    server.indexOf("function allocateShotCounts")
  );
  assert.match(evidenceBoundShotCount, /return minimumCoverageCount/);
  assert.doesNotMatch(evidenceBoundShotCount, /determineShotCount/);
  assert.equal((server.match(/const measuredTtsTimeline = getShotlistTimeline\(ttsRun\)/g) || []).length >= 2, true);
  const shotlistPreflight = server.slice(
    server.indexOf("function recordShotlistEvidenceCapacityFailure"),
    server.indexOf("async function generateShotlist")
  );
  assert.match(shotlistPreflight, /actualTtsDurationSec/);
  assert.match(shotlistPreflight, /minimumCoverageCount/);
  assert.match(shotlistPreflight, /verifiedEvidenceCapacity/);
  assert.match(shotlistPreflight, /recordTopicAttempt\(topic\.id, "shotlist_quality", "failed"/);
  assert.match(shotlistPreflight, /evaluateQualityConvergence/);
  assert.match(shotlistPreflight, /UPDATE shotlists SET status = 'stale'/);
  const shotlistGeneration = server.slice(
    server.indexOf("async function generateShotlist"),
    server.indexOf("function renderCleanPromptsMarkdown")
  );
  const preflightIndex = shotlistGeneration.indexOf("recordShotlistEvidenceCapacityFailure");
  assert.ok(preflightIndex >= 0);
  assert.ok(preflightIndex < shotlistGeneration.indexOf("await reviseShotlistWithAi"));
  assert.ok(preflightIndex < shotlistGeneration.indexOf("await designShotlistWithAi"));
  const repairOwnerClassifier = server.slice(
    server.indexOf("function classifyQualityRepairOwner"),
    server.indexOf("function buildQualityRepairPlan")
  );
  assert.match(repairOwnerClassifier, /stage === "shotlist_quality" && codes\.has\("insufficient_visual_depth"\)/);
  assert.match(repairOwnerClassifier, /route: "source_enrichment"/);
  const upstreamFactRemediation = server.slice(
    server.indexOf("if (['fact_contract_revision', 'visual_reference_enrichment', 'source_enrichment'].includes(route))"),
    server.indexOf("if (route === 'production_contract_revision')")
  );
  assert.match(upstreamFactRemediation, /enqueueAiJob\('fact_check'/);
  assert.doesNotMatch(upstreamFactRemediation, /enqueueAiJob\('(script_generate|shotlist_generate)'/);
  const sourceEnrichmentTarget = upstreamFactRemediation.slice(
    upstreamFactRemediation.indexOf("const reportedMinimumCoverageCount"),
    upstreamFactRemediation.indexOf(": Math.min(5")
  );
  assert.match(sourceEnrichmentTarget, /minimumCoverageCount/);
  assert.match(sourceEnrichmentTarget, /Math\.max\(2, reportedMinimumCoverageCount, durationCoverageCount\)/);
  assert.doesNotMatch(sourceEnrichmentTarget, /Math\.min\(5,/);
  const factCheckTarget = server.slice(
    server.indexOf("async function runFactCheck"),
    server.indexOf("function isOfficialCanaryUrl")
  );
  assert.match(factCheckTarget, /Number\.isFinite\(requestedVisualEvidenceCount\)/);
  assert.doesNotMatch(factCheckTarget, /Math\.min\(5,/);
  assert.match(factCheckTarget, /recordTopicAttempt\(\s*id,\s*"source_enrichment"/);
  assert.match(server, /sourceEnrichmentShortfall/);
  assert.match(server, /route: "script_scope_compression"/);
  assert.match(server, /targetDurationSec: Number\(sourceEnrichmentDetails\.targetDurationSec \|\| 0\)/);
  assert.match(server, /latestShotlistDecision/);
  assert.match(server, /stages\.shotlist = "needs_evidence"/);
  assert.match(server, /route: "source_enrichment"/);
  assert.match(dashboard, /AI 장면 설계 중/);
  assert.match(dashboard, /PretendardStd-Regular\.ttf/);
  assert.match(dashboard, /shotlist-workspace/);
  assert.match(dashboard, /shotlist-detail-pane/);
  assert.match(dashboard, /workbenchContent\.classList\.toggle\("shotlist-active"/);
});

test("approved shotlists can enqueue visible CLEAN image jobs", () => {
  assert.match(server, /clean_image_generate/);
  assert.match(server, /status: "AI_PASS"/);
  assert.match(server, /isAiVerifiedAssetStatus/);
  assert.match(server, /generateCleanImage/);
  assert.match(server, /Use the \$imagegen skill and its built-in image generation tool/);
  assert.match(server, /Scoped visual reference/);
  assert.match(server, /Independent generation/);
  assert.match(server, /_CLEAN\.png/);
  assert.match(dashboard, /data-clean-review-index/);
  assert.match(dashboard, /generate-clean/);
});

test("all generative stages use the shared independent review consensus", () => {
  assert.match(server, /QUALITY_REVIEWER_ROLES/);
  assert.match(server, /label: "통합 품질 검수"/);
  assert.match(server, /async function runQualityConsensus/);
  assert.match(server, /const ambiguous = Boolean/);
  assert.match(server, /판정이 경계 구간이라 두 번째 독립 검수만 추가합니다/);
  assert.match(server, /role: "adjudicator"/);
  assert.match(server, /decisive_single_pass/);
  assert.match(server, /reviewScriptConsensus/);
  assert.match(server, /reviewShotlistConsensus/);
  assert.match(server, /reviewCleanImageConsensus/);
  assert.match(server, /reviewInfoImageConsensus/);
  assert.match(server, /reviewVideoConsensus/);
  assert.match(server, /quality_decisions/);
  assert.match(server, /evaluateQualityConvergence/);
  assert.match(server, /shouldContinueQualityRepair/);
  assert.match(server, /retry_targeted/);
  assert.match(server, /revise_shared_contract/);
  assert.match(server, /BENCHMARK_FEEDBACK_APPLICATION_LIMIT = 1/);
  assert.match(server, /manual_evidence_required/);
  assert.match(server, /script_scope_compression/);
  assert.match(server, /local_targeted_revision/);
  assert.match(server, /reviseProductionBriefFromQualityFeedback/);
  assert.match(server, /existing\.raw\?\.source === "quality-remediation"/);
  assert.match(server, /let repairCycle = 0/);
  assert.match(server, /source_enrichment/);
  assert.match(server, /revise_upstream_contract/);
  assert.match(server, /awaiting_benchmark_comparison/);
  assert.match(server, /sharedFindings: findingRows\.filter/);
  assert.match(server, /async function advanceBenchmarkQuality/);
  assert.match(server, /async function advanceAllBenchmarkQuality/);
  assert.match(server, /function applySharedBenchmarkFindings/);
  assert.match(server, /"tts_generate"/);
  assert.match(server, /tts_heartbeat/);
  assert.match(dashboard, /applySharedFindings: true/);
  assert.match(server, /quality_benchmark_batch/);
  assert.match(server, /automaticRepairLimit: 0/);
  assert.match(server, /COUNT\(DISTINCT qf\.topic_id\) AS topicCount/);
  assert.doesNotMatch(server, /maximumRepairAttempts/);
});

test("media assets are bound to the shotlist version that produced them", () => {
  assert.match(server, /function isAssetCurrentForShotlist/);
  assert.match(server, /autoQc\.shotlistId = shotlist\.id/);
  assert.match(server, /현재 장면표에서 생성한 이미지만 승인할 수 있습니다/);
  assert.match(server, /markStaleShotlistAssets/);
  assert.match(server, /staleCleanCount/);
  assert.match(server, /staleInfoCount/);
});

test("CLEAN review finalizes the full set before INFO generation", () => {
  assert.match(server, /finalizeCleanAssetsAndGenerateInfo/);
  assert.match(server, /runDbTransaction/);
  assert.doesNotMatch(server, /db\.transaction/);
  assert.match(server, /자동 QC를 통과하지 못한 CLEAN/);
  assert.match(server, /DELETE FROM asset_reviews[\s\S]*?asset_type = 'clean'/);
  assert.match(dashboard, /finalize-clean-and-generate-info/);
  assert.match(dashboard, /data-replace-clean/);
  assert.match(dashboard, /showWorkbenchActionError/);
  const cleanFinalization = server.match(/async function finalizeCleanAssetsAndGenerateInfo[\s\S]*?async function finalizeInfoAssets/u)?.[0] || "";
  assert.doesNotMatch(cleanFinalization, /enqueueAiJob\("info_image_generate"/);
});

test("H3 uses one approved physical state instead of looping the same frame", () => {
  assert.match(server, /delete graph\["105:104"\]\.inputs\.last_frame/);
  assert.doesNotMatch(server, /graph\["105:104"\]\.inputs\.last_frame = \["115", 0\]/);
  assert.match(server, /Do not loop back to the opening pose or composition/);
  assert.match(server, /VIDEO_VISUAL_REVIEW_OUTPUT_SCHEMA/);
  assert.match(server, /reviewVideoConsensus/);
  assert.match(server, /video_visual_quality/);
  assert.match(server, /qc_status = \?, qc_note = \?/);
  assert.match(dashboard, /AI 검수 실패/);
});

test("OpenShot edit bridge keeps native-speed video and narration on separate tracks", () => {
  const bridgePath = new URL("../integrations/openshot/dinobox.py", import.meta.url);
  assert.match(server, /HD Vertical 720p 24 fps/);
  assert.match(server, /placeholderIndexes/);
  assert.match(server, /buildCaptionCues/);
  assert.match(server, /topic-\$\{topicId\}\.srt/);
  assert.match(server, /culture-heritage-care-bold/);
  assert.match(server, /MunhwajaeDolbom Bold/);
  assert.match(server, /문화재돌봄체 Bold\.ttf/);
  assert.match(server, /windowsHide: true/);
  assert.match(dashboard, /영상 원음/);
  assert.match(dashboard, /TTS 트랙/);
  assert.match(dashboard, /자막 트랙/);
  assert.match(server, /playbackPolicy: "native_1x_trim_only"/);
  assert.match(server, /playbackRate: 1/);
  assert.doesNotMatch(server, /h3IntroDurationSec/);
  return readFile(bridgePath, "utf8").then((bridge) => {
    assert.match(bridge, /CreateEffect\("Caption"\)/);
    assert.match(bridge, /caption_text/);
    assert.match(bridge, /caption_font/);
    assert.doesNotMatch(bridge, /infoClips/);
    assert.doesNotMatch(bridge, /DinoBox Verified INFO/);
  });
});

test("script generation uses evidence-aware narrative and optional signature lines", async () => {
  const engineering = await readFile(new URL("../domains/engineering.yaml", import.meta.url), "utf8");
  assert.match(server, /visualEvidence/);
  assert.match(server, /fact_check_impact/);
  assert.match(server, /QUALITY_ENGINE_VERSION = "bounded-benchmark-v4"/);
  assert.match(server, /Number\(issue\?\.segmentIndex \|\| 0\) !== 0/);
  assert.match(server, /QUALITY_AUTO_REPAIR_LIMIT \|\| 0/);
  assert.match(server, /one_decisive_review_then_borderline_adjudication/);
  assert.match(server, /awaiting_benchmark_comparison/);
  assert.match(server, /qualityStatus: qualityResult\.passed \? "passed" : "needs_revision"/);
  assert.match(server, /UPDATE shotlists SET status = 'needs_revision'/);
  assert.match(server, /buildQualityContractHash/);
  assert.match(server, /json_extract\(qd\.details_json, '\$\.contractHash'\)/);
  assert.match(server, /requiresNewEvidence/);
  assert.match(server, /insufficient_visual_depth/);
  assert.match(server, /영상 제작용 시각 근거/);
  assert.match(server, /의미가 같은 주장은 기존 claim id를 그대로 유지/);
  assert.match(server, /previousFactCheck: force \? existing : null/);
  assert.match(server, /problem_solution/);
  assert.match(server, /hidden_mechanism/);
  assert.match(server, /content_first/);
  assert.match(server, /importance/);
  assert.match(server, /아~ 어질어질합니다\./);
  assert.match(server, /그래서 생각의 판을 완전히 엎었습니다\./);
  assert.match(engineering, /signature_policy/);
  assert.match(engineering, /maximum_sec: 180/);
  assert.match(server, /before_after/);
  assert.match(server, /Pretendard SemiBold/);
  assert.match(server, /Pretendard-Bold/);
  assert.match(server, /SCRIPT_REVIEW_OUTPUT_SCHEMA/);
  assert.match(server, /runScriptQualityLoop/);
  assert.match(server, /misleading_premise/);
  assert.match(server, /titleOverride/);
  assert.match(server, /raw\.finalScript \|\| raw\.generation \|\| raw/);
  assert.match(server, /unsupported floating mass/);
  assert.match(server, /blockingWarnings/);
  assert.match(server, /\["repetition", "weak_hook", "not_visualizable"\]/);
  assert.match(server, /distinct evidence-bearing physical states/);
  assert.doesNotMatch(server, /evidenceStateCapacitySec/);
  assert.match(server, /Duration is a production-contract failure/);
  assert.match(server, /상태 하나당 \$\{NATIVE_CLIP_DURATION_SEC\}초 원본 클립 하나만 허용/);
  assert.doesNotMatch(server, /maxSec > 180/);
  assert.match(server, /function normalizeInfoText/);
  assert.match(server, /three or more independent inputs/);
  assert.match(server, /Do not invent operator actions, monitoring screens/);
  assert.doesNotMatch(server, /"recommendedMinSec": 70/);
  assert.match(server, /출처 검수용 메타 언어/);
  assert.match(server, /review list as cumulative/);
  assert.match(server, /everyday term.*technical term/);
  assert.match(server, /verified path from A to B does not prove the local direction/);
  assert.match(server, /대본 품질 수렴을 중단했습니다/);
  assert.match(server, /독립 대본 검수 \$\{attempt\}/);
  assert.match(server, /finalFactCheck\.revisedTitle \|\| topic\.title/);
  assert.match(engineering, /labels: Pretendard SemiBold/);
});

test("script cache reviews are bound to their normalized candidate", () => {
  const candidateContract = server.slice(
    server.indexOf("function normalizeScriptCandidateForQuality"),
    server.indexOf("function buildScriptUpstreamContractHash")
  );
  const qualityLoop = server.slice(
    server.indexOf("async function runScriptQualityLoop"),
    server.indexOf("function reviewStatusFromFactStatus")
  );
  const scriptGeneration = server.slice(
    server.indexOf("async function generateScript"),
    server.indexOf("async function generateShotlist")
  );

  assert.match(candidateContract, /function buildScriptCandidateHash/);
  assert.match(candidateContract, /visualStateId: text\(row\?\.visualStateId\)/);
  assert.match(candidateContract, /narration: text\(row\?\.narration\)/);
  assert.match(candidateContract, /claimRefs: textList\(row\?\.claimRefs\)/);
  assert.match(candidateContract, /infoGraphic: normalizeInfoGraphic\(row\?\.infoGraphic\)/);
  assert.match(candidateContract, /ttsText: text\(script\?\.ttsText\)/);
  assert.match(candidateContract, /function filterScriptReviewsForCandidate/);
  assert.match(qualityLoop, /Object\.assign\(review, binding\)/);
  assert.match(qualityLoop, /review\.reviewHash = hashScriptReview\(review\)/);
  assert.match(qualityLoop, /const cachedPass = reviews\.find\(\(entry\) => entry\.passed === true\)/);
  assert.match(qualityLoop, /await onCandidate\?\.\(script, candidateReviews/);
  assert.match(qualityLoop, /script = await reviseScriptWithAi[\s\S]*?reviews = \[\];/);
  assert.match(scriptGeneration, /candidateHash,/);
  assert.match(scriptGeneration, /const cacheHasMatchingCandidateHash = cached\.candidateHash === loadedCandidateHash/);
  assert.match(scriptGeneration, /cachedReviews = cacheHasMatchingCandidateHash[\s\S]*?filterScriptReviewsForCandidate\(cached\.reviews, loadedCandidateHash, loadedBinding\)/);
  assert.match(scriptGeneration, /candidateHash: initialCandidateHash/);
  assert.match(scriptGeneration, /\{ reviewerTargeted: true \}/);
});

test("script cache, INFO requirements, and auto convergence stay contract-bound", () => {
  assert.match(server, /function scriptReviewBinding/);
  assert.match(server, /contractVersion: SCRIPT_CONTRACT_VERSION/);
  assert.match(server, /factCheckId: Number\(factCheckId\)/);
  assert.match(server, /productionBriefId: Number\(productionBriefId\)/);
  assert.match(server, /reviewHash === hashScriptReview\(review\)/);
  assert.match(server, /function enqueuePipelineSuccessor/);
  assert.match(server, /const ttsRun = mapTtsRunRow\(getLatestTtsRunByTopicStatement\.get\(topicId\)\)/);
  assert.match(server, /ttsRun,\n    shotlistId: shotlist\?\.id \|\| null/);
  assert.match(server, /recordCanaryAiPass\(\{ topicId: job\.topicId, reviewer: "pipeline_auto_converge" \}\)/);
  assert.match(server, /detail\.script\.status === "approved"[\s\S]*?detail\.script\.status === "draft" && canaryHasAiPass/);
  assert.match(server, /const pipeline = \{ stage: next\.stage, inputHash: next\.inputHash \}/);
  assert.match(server, /blocked: "quality_not_passed"/);
  assert.match(server, /const autoConverge = payload\.autoConverge === true/);
  assert.match(server, /source: autoConverge \? "pipeline_auto_converge" : "quality_benchmark_remediation"/);
  assert.match(server, /autoConverge: true, pipeline: payload\.pipeline \|\| null/);
  assert.match(server, /assetQualityFeedback,[\s\S]*?targetClipIndexes: assetQualityFeedback\.clipIndexes \|\| \[\]/);
  assert.match(server, /auto_converge_hold/);
  assert.match(server, /필수 INFO 오버레이는 geometryMode none으로 대체할 수 없음/);
  assert.match(server, /function preserveRequiredInfoGraphic/);
  assert.match(server, /normalized\.requiresOverlay && normalized\.type === "none" && fallback\.type !== "none"/);
  assert.match(server, /Math\.max\(maximumInfo, requiredInfoCount\)/);
  assert.match(server, /Math\.min\(2, chunks\.length\)/);
  assert.match(server, /const reviewerRoles = requiredReviewerRoles\.length \? requiredReviewerRoles : \["evidence", "production"\]/);
  assert.match(server, /await Promise\.all\(reviewerRoles\.slice\(0, 2\)/);
  assert.match(server, /json_extract\(details_json, '\$\.narrationHash'\) = \? LIMIT 1/);
  assert.match(server, /const repeatedNarration = Boolean\(measuredOverruns\.length && priorOverrun\)/);
  assert.match(server, /job\.type === "tts_generate" && next\.stage === "tts"/);
  assert.match(server, /hold: "measured_tts_unresolved"/);
});

test("production brief reviewer findings persist with the hold decision", () => {
  assert.match(server, /function mergeProductionBriefIssues/);
  assert.match(server, /productionBriefIssueKey/);
  assert.match(server, /raw\?\.briefReview/);
  assert.match(server, /summary: raw\.briefReview\.summary/);
  assert.match(server, /evidencePacketHash: evidencePacket/);
  assert.match(server, /reviewerReason/);
  assert.match(server, /issues: Array\.isArray\(raw\.briefReview\.issues\)/);
  assert.match(server, /productionBrief\?\.visualStates\?\.length/);
  assert.match(server, /productionBrief\.visualStates\.map\(\(state\) => String\(state\.stateId/);
});

test("production brief enforces configured evidence-beat INFO overlay minimums and preserves them downstream", () => {
  const briefIssues = server.slice(
    server.indexOf("function getProductionBriefIssues"),
    server.indexOf("function createEvidencePacket")
  );
  const productionBriefFlow = server.slice(
    server.indexOf("async function repairProductionBriefFromReviewer"),
    server.indexOf("function compactEvidenceText")
  );

  assert.match(server, /function getConfiguredProductionRequirements\(topic = \{\}\)/);
  assert.match(server, /minimumRequiredInfoOverlays: Number\.isInteger\(overlays\) && overlays >= 0 \? overlays : null/);
  assert.match(briefIssues, /const requiredInfoOverlayBeatKeys = new Set\(\)/);
  assert.match(briefIssues, /infoGraphic\.requiresOverlay === true[\s\S]*?infoGraphic\.type !== "none"[\s\S]*?getInfoGraphicSpecIssues\(infoGraphic\)/);
  assert.match(briefIssues, /requirements\.minimumRequiredInfoOverlays > 0[\s\S]*?requiredInfoOverlayBeatKeys\.size < requirements\.minimumRequiredInfoOverlays/);
  assert.match(briefIssues, /code: "insufficient_required_info_overlays"/);
  assert.equal((productionBriefFlow.match(/Configured production requirements:/g) || []).length, 4);
  assert.equal((productionBriefFlow.match(/complete, valid non-none infoGraphic and requiresOverlay=true/g) || []).length, 4);
  assert.match(server, /requiresOverlay: evidenceBeat\?\.infoGraphic\?\.requiresOverlay === true \|\| visualState\?\.infoGraphic\?\.requiresOverlay === true/);
  assert.match(server, /infoGraphic: normalizeInfoGraphicSpec\(scene\.infoGraphic \|\| \{ type: "none" \}, scene\)/);
  assert.match(server, /requiresOverlay: item\.infoSpec\?\.requiresOverlay === true/);
});

test("quality replay reuses stored INFO without a generation path", () => {
  const replay = server.match(/async function runQualityReplay[\s\S]*?\n}\n\n(?=async function saveInfoPrompts)/)?.[0] || "";
  const dryRun = server.match(/if \(payload\.dryRun === true\)[\s\S]*?sendJson\(res, 200,[\s\S]*?return;/)?.[0] || "";
  assert.match(server, /quality_replay/);
  assert.match(server, /buildQualityReplayPlan/);
  assert.match(server, /hashQualityReplayArtifacts/);
  assert.match(server, /reviewInfoImageConsensus/);
  assert.match(server, /requiredReviewerRoles: \["evidence", "production"\]/);
  assert.match(replay, /before\.cleanHash !== after\.cleanHash/);
  assert.doesNotMatch(replay, /saveInfoPrompts|planInfoLayouts|INFO_RENDERER|generateCleanImage|runJsonPython/);
  assert.doesNotMatch(dryRun, /enqueueAiJob|recordTopicAttempt|runQualityReplay/);
});

test("production canary API keeps official preflight, lanes and video blocking bounded", () => {
  for (const route of [
    "/api/production-canaries/import",
    "/api/production-canaries/advance",
    "/api/production-canaries/ai-pass",
    "/api/production-canaries/shotlist-ai-pass"
  ]) assert.match(server, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(server, /loadProductionCanaryManifest/);
  assert.match(server, /validateOfficialVisualPreflight/);
  assert.match(server, /canaryFactAllowlistResult/);
  assert.match(server, /production_brief_generate/);
  assert.match(server, /payload\.retryStage === "production_brief"/);
  assert.match(server, /payload\.retryStage === "production_brief_review"/);
  assert.match(server, /payload\.retryStage === "production_brief_repair"/);
  assert.match(server, /production_canary_review_retry/);
  assert.match(server, /production_canary_review_replay/);
  assert.match(server, /production_canary_reviewer_repair/);
  assert.match(server, /production_canary_fact_contract_refresh/);
  assert.match(server, /productionBrief\?\.status === "stale"/);
  assert.match(server, /repairProductionBriefFromReviewer/);
  assert.match(server, /reviewOnly: true/);
  assert.match(server, /payload\.retryStage === "script"/);
  assert.match(server, /payload\.retryStage === "fact_contract"/);
  assert.match(server, /production_canary_script_feedback/);
  assert.match(server, /production_canary_script_review_retry/);
  assert.match(server, /measuredTtsOverruns/);
  assert.match(server, /measuredTtsTimeline = getShotlistTimeline/);
  assert.match(server, /existingMeasuredCompressionScript/);
  assert.match(server, /payload\.measuredTtsOverruns/);
  assert.match(server, /Required measured-TTS repairs/);
  assert.match(server, /A listed row may not retain its current narration/);
  assert.match(server, /실제 TTS가 원본 클립을 넘긴 대본 행만 다시 압축합니다/);
  assert.match(server, /payload\.retryStage === "shotlist"/);
  assert.match(server, /payload\.retryStage === "shotlist_rebuild"/);
  assert.match(server, /production_canary_shotlist_review_retry/);
  assert.match(server, /production_canary_evidence_bound_rebuild/);
  assert.match(server, /getShotlistEvidenceCapacity/);
  assert.match(server, /remainingGapSec/);
  assert.match(server, /function determineEvidenceBoundShotCount\(_script, _productionBrief, _totalDurationSec, minimumCoverageCount\)/);
  assert.match(server, /return minimumCoverageCount/);
  assert.match(server, /previousShotlist\?\.raw\?\.qualityReviews\?\.at\(-1\)/);
  assert.match(server, /remediationRoute: "local_targeted_revision"/);
  assert.match(server, /productionBrief\.revision \|\| 0\) <= 2/);
  assert.match(server, /official_diagram/);
  assert.match(server, /cameraMotion must be a static hold or crop\/scale/);
  assert.match(server, /run_lane = 'production'/);
  assert.match(server, /run_lane != 'production_canary'/);
  assert.match(server, /H3\/video를 큐에 넣지 않습니다/);
  assert.match(server, /factJobQueued: false/);
  assert.match(server, /run_lane AS runLane/);
  assert.match(server, /run_lane = 'production_canary'/);
  assert.match(server, /status === "generated" && !detail\.shotlist/);
  assert.match(server, /awaiting_shotlist_review/);
  assert.match(server, /approveCanaryShotlistWithAi/);
  assert.match(server, /approvalType: "canary_ai_consensus"/);
  assert.match(server, /독립 장면표 검수 PASS 이력/);
  assert.match(server, /manual_asset_review_required/);
  assert.match(dashboard, /candidate\.runLane === "production_canary"/);
  assert.match(dashboard, /전용 canary API로 단계 진행/);
});

test("production canary fact checks carry manifest scope and reject in-video excluded claims", async () => {
  const manifest = JSON.parse(await readFile(new URL("../production-canaries/jwst-sunshield.json", import.meta.url), "utf8"));
  assert.equal(manifest.scope.includes("전개 순서"), true);
  assert.deepEqual(manifest.hiddenMechanismExclusions, ["내부 모터", "래치", "정밀 장력", "열성능"]);
  assert.deepEqual(manifest.factSources.map((source) => source.url), [
    "https://science.nasa.gov/mission/webb/deployment/",
    "https://science.nasa.gov/asset/webb/webbs-5-layer-sunshield/"
  ]);
  assert.equal(manifest.officialVisualReferences.find((reference) => reference.id === "JWST-SUNSHIELD-VIDEO-REFERENCE")?.referenceType, "official_motion_reference");
  assert.deepEqual(manifest.productionRequirements, { minimumVisualStates: 7, targetVisualStateRange: [7, 7], minimumRequiredInfoOverlays: 2 });
  assert.deepEqual(manifest.officialVisualReferences
    .filter((reference) => reference.metadata?.sourceKind === "official_multi_panel_diagram")
    .map((reference) => reference.panelCrop), [[0, 0, .2, .5], [.2, 0, .2, .5], [.4, 0, .2, .5], [.6, 0, .2, .5], [.8, .5, .2, .5]]);
  const fairingReference = manifest.officialVisualReferences.find((reference) => reference.id === "JWST-ARIANE-5-FAIRING-PACKED");
  const foldedReference = manifest.officialVisualReferences.find((reference) => reference.id === "JWST-DIAGRAM-01-FOLDED");
  const portMidboomReference = manifest.officialVisualReferences.find((reference) => reference.id === "JWST-DEPLOYMENT-EXPLORER-PORT-MIDBOOM");
  const starboardMidboomReference = manifest.officialVisualReferences.find((reference) => reference.id === "JWST-DEPLOYMENT-EXPLORER-STARBOARD-MIDBOOM");
  assert.deepEqual([fairingReference?.sourceUrl, fairingReference?.mediaUrl], [
    "https://science.nasa.gov/mission/webb/deployment/",
    "https://assets.science.nasa.gov/dynamicimage/assets/science/missions/webb/engineering/ariane4.jpg?w=1024&h=3468&fit=clip&crop=faces%2Cfocalpoint"
  ]);
  assert.equal(fairingReference?.referenceType, "official_section");
  assert.equal(fairingReference?.metadata?.sourceKind, "official_static_nasa_fairing_section");
  assert.equal(fairingReference?.metadata?.requiredForClaim, "C01");
  assert.equal(fairingReference?.metadata?.productionVisualStateId, "VS01_FOLDED_LAUNCH_CONFIGURATION");
  assert.equal(fairingReference?.metadata?.productionInfoSpec, undefined);
  assert.equal(foldedReference?.metadata?.requiredForClaim, "C01");
  assert.equal(foldedReference?.metadata?.productionVisualStateId, undefined);
  assert.equal(foldedReference?.metadata?.productionInfoSpec, undefined);
  assert.deepEqual([portMidboomReference?.sourceUrl, portMidboomReference?.mediaUrl, starboardMidboomReference?.sourceUrl, starboardMidboomReference?.mediaUrl], [
    "https://webb.nasa.gov/content/webbLaunch/deploymentExplorer.html",
    "https://webb.nasa.gov/content/webbLaunch/assets/images/deployment/1000pxWide/112.png",
    "https://webb.nasa.gov/content/webbLaunch/deploymentExplorer.html",
    "https://webb.nasa.gov/content/webbLaunch/assets/images/deployment/1000pxWide/113.png"
  ]);
  assert.equal(portMidboomReference?.metadata?.requiredForClaim, "C02");
  assert.equal(portMidboomReference?.metadata?.motionEvidence, "JWST-SUNSHIELD-VIDEO-REFERENCE");
  assert.equal(portMidboomReference?.metadata?.sequencePresentation, "official_two_panel_explanatory_sequence");
  assert.deepEqual(portMidboomReference?.metadata?.panelSequence, [
    { order: 1, side: "port", referenceId: "JWST-DEPLOYMENT-EXPLORER-PORT-MIDBOOM", sourceUrl: "https://webb.nasa.gov/content/webbLaunch/deploymentExplorer.html", mediaUrl: "https://webb.nasa.gov/content/webbLaunch/assets/images/deployment/1000pxWide/112.png", panelCrop: [0, 0, 1, 1] },
    { order: 2, side: "starboard", referenceId: "JWST-DEPLOYMENT-EXPLORER-STARBOARD-MIDBOOM", sourceUrl: "https://webb.nasa.gov/content/webbLaunch/deploymentExplorer.html", mediaUrl: "https://webb.nasa.gov/content/webbLaunch/assets/images/deployment/1000pxWide/113.png", panelCrop: [0, 0, 1, 1] }
  ]);
  assert.match(portMidboomReference?.metadata?.continuityNote || "", /연속 물리 사진·움직임·합성 중간 상태/);
  assert.equal(starboardMidboomReference?.metadata?.productionVisualStateId, undefined);
  const towerReference = manifest.officialVisualReferences.find((reference) => reference.id === "JWST-DIAGRAM-03-TOWER");
  assert.deepEqual(towerReference?.metadata?.productionInfoSpec?.labels, ["약 2m 연장"]);
  assert.equal(towerReference?.metadata?.productionInfoSpec?.geometryPolicy, "factual_badge");
  assert.match(towerReference?.metadata?.productionInfoSpec?.evidenceSourceUrl || "", /^https:\/\/science\.nasa\.gov\//);
  const productionBindings = manifest.officialVisualReferences
    .filter((reference) => reference.metadata?.productionVisualStateId)
    .map((reference) => [reference.metadata.productionVisualStateId, reference.id]);
  assert.equal(productionBindings.length, 7);
  assert.deepEqual(productionBindings, [
    ["VS01_FOLDED_LAUNCH_CONFIGURATION", "JWST-ARIANE-5-FAIRING-PACKED"],
    ["VS02_PALLETS_DEPLOYED", "JWST-DIAGRAM-02-PALLET"],
    ["VS03_TOWER_EXTENDED", "JWST-DIAGRAM-03-TOWER"],
    ["VS04_COVERS_RELEASED", "JWST-DIAGRAM-04-COVERS"],
    ["VS05_BOTH_MIDBOOMS_EXTENDED", "JWST-DEPLOYMENT-EXPLORER-PORT-MIDBOOM"],
    ["VS06_FIVE_LAYERS_SEPARATED_COMPLETE_DIAGRAM", "JWST-DIAGRAM-06-FIVE-LAYERS"],
    ["VS07_FIVE_LAYER_GROUND_TEST_PHOTO", "JWST-SUNSHIELD-GROUND-TEST"]
  ]);
  assert.deepEqual(manifest.officialVisualReferences
    .filter((reference) => reference.metadata?.productionInfoSpec?.requiresOverlay)
    .map((reference) => [reference.metadata.productionVisualStateId, reference.metadata.productionInfoSpec.type]), [
    ["VS03_TOWER_EXTENDED", "scale_limit"],
    ["VS05_BOTH_MIDBOOMS_EXTENDED", "sequence"],
    ["VS07_FIVE_LAYER_GROUND_TEST_PHOTO", "location"]
  ]);
  assert.ok(manifest.officialVisualReferences
    .filter((reference) => reference.metadata?.productionVisualStateId)
    .every((reference) => reference.metadata.productionVisibleElements?.length >= 2));
  assert.equal(manifest.officialVisualReferences.find((reference) => reference.id === "JWST-SUNSHIELD-GROUND-TEST")?.metadata?.requiredForClaim, "C03");
  const canaryManifestEvidence = server.match(/function materializeCanaryManifestVisualEvidence[\s\S]*?\n}\n\nfunction buildCanaryDraftScriptFactContractRefresh/)?.[0] || "";
  const canaryDraftRefresh = server.match(/function buildCanaryDraftScriptFactContractRefresh[\s\S]*?\n}\n\nfunction saveCanaryDraftScriptFactContractRefresh/)?.[0] || "";
  assert.match(server, /payload\.source === "production_canary_fact_contract_refresh"/);
  assert.match(server, /\["draft", "stale"\]\.includes\(existingDraftScript\?\.status\)/);
  assert.match(canaryManifestEvidence, /manifestBindingsByStateId\.size !== scriptStateIds\.length/);
  assert.match(canaryManifestEvidence, /const bindings = scriptRows\.map/);
  assert.match(canaryManifestEvidence, /binding\.claimRefs\.filter/);
  assert.match(canaryManifestEvidence, /asset\.verification\?\.mediaKind !== "video_reference_only"/);
  assert.match(canaryManifestEvidence, /panelCrop: reference\.panelCrop/);
  assert.match(canaryManifestEvidence, /metadata: reference\.metadata/);
  assert.match(canaryDraftRefresh, /materializeCanaryManifestVisualEvidence\(topic, factCheck, script\)/);
  assert.match(canaryDraftRefresh, /reference\.metadata\?\.productionVisibleElements/);
  assert.match(canaryDraftRefresh, /productionVisibleElements\.length >= 2/);
  assert.match(canaryDraftRefresh, /: state\.requiredVisibleElements/);
  assert.match(canaryDraftRefresh, /requiredVisibleElements,\n      evidenceRefs: \[reference\.id\]/);
  assert.match(canaryDraftRefresh, /infoGraphic: productionInfoSpec \|\| beat\.infoGraphic/);
  assert.match(canaryDraftRefresh, /isTwoPanelSequence/);
  assert.match(canaryDraftRefresh, /requiredVisibleElements,\n        infoGraphic:/);
  assert.match(canaryManifestEvidence, /activeStillReferenceIds/);
  assert.match(canaryManifestEvidence, /filter\(\(evidence\) => activeStillReferenceIds\.has/);
  assert.match(canaryDraftRefresh, /static hold or crop\/scale within the same official reference frame/);
  assert.doesNotMatch(canaryManifestEvidence, /runCodexJson|enqueueAiJob/);
  assert.match(server, /finalFactCheck = materializeCanaryManifestVisualEvidence\(topic, finalFactCheck, currentScript\)\.factCheck/);
  assert.ok(server.indexOf("finalFactCheck = materializeCanaryManifestVisualEvidence") < server.indexOf("saveFactCheck(id, finalFactCheck, finalRawResult, finalAttempt, enrichment)"));
  assert.match(server, /UPDATE scripts SET status = 'draft'/);
  assert.match(server, /UPDATE tts_runs SET status = 'generated'/);
  assert.match(server, /canaryRequiredCausalIds/);
  assert.match(server, /payload\.remediationRoute === "fact_contract_revision"/);
  assert.match(server, /function extractOfficialCropContract/);
  assert.match(server, /deterministic_cover_crop/);
  assert.match(server, /minimumRequiredInfoOverlays/);
  assert.match(server, /pinned: true/);
  assert.match(server, /getCanaryAssets\(topic\.id\)/);
  assert.match(server, /mediaKind=video_reference_only/);
  assert.match(server, /asset\.verification\?\.mediaKind !== "video_reference_only"/);
  assert.match(server, /function getCanaryFactScope/);
  assert.match(server, /\[Canary 사실 주장 범위\]/);
  assert.match(server, /\$\{canaryScopeBlock\}/);
  assert.match(server, /useInVideo=false/);
  assert.match(server, /outOfScopeClaims\.length === 0/);
  const canaryQueries = server.match(/if \(topic\.runLane === "production_canary"\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(canaryQueries, /canaryScope\.scope/);
  assert.match(canaryQueries, /canaryScope\.factSources/);
  assert.doesNotMatch(canaryQueries, /bearing|hinge|contact|load path/);
  assert.match(server, /factSources/);
});

test("project documentation records architecture and acceptance criteria", async () => {
  const documents = await Promise.all([
    "PRODUCT_PLAN_KR.md",
    "ARCHITECTURE_KR.md",
    "IMPLEMENTATION_PLAN_KR.md",
    "FACT_CHECK_GATE_KR.md"
  ].map((name) => readFile(new URL(`../docs/${name}`, import.meta.url), "utf8")));

  assert.match(documents[0], /후보 수집/);
  assert.match(documents[1], /job_events/);
  assert.match(documents[2], /완료 조건/);
  assert.match(documents[3], /SUPPORTED/);
  const pipelineSpec = await readFile(new URL("../docs/MD_PIPELINE_SPEC_KR.md", import.meta.url), "utf8");
  assert.match(pipelineSpec, /CLEAN 기반 4초 영상 생성과 정확한 INFO 레이어 합성/);
});

test("data root and asset-quality remediation remain process-local and bounded", () => {
  assert.match(server, /DINOBOX_DATA_DIR/);
  assert.match(server, /path\.resolve\(process\.env\.DINOBOX_DATA_DIR \|\| path\.join\(__dirname, "data"\)\)/);
  assert.match(server, /process\.env\.DINOBOX_DB_PATH \|\| path\.join\(DATA_DIR, "shorts\.db"\)/);
  assert.match(server, /DINOBOX_AI_WORKER_TOPIC_ID/);
  assert.match(server, /DINOBOX_AI_WORKER_JOB_ID/);
  const scopedWorker = server.slice(server.indexOf("function claimNextAiJob"), server.indexOf("function createJobContext"));
  assert.match(scopedWorker, /AI_WORKER_JOB_ID[\s\S]*?id = \?/);
  assert.match(scopedWorker, /AI_WORKER_TOPIC_ID[\s\S]*?topic_id = \?/);
  assert.match(server, /function scheduleAiWorkers\(\) \{\s*if \(DISABLE_BACKGROUND_WORKERS \|\| aiWorkerScheduled\) return;/);
  for (const directory of ["audio", "tts-jobs", "source-cache", "projects", "media-jobs", "openshot-home"]) {
    assert.match(server, new RegExp(`path\\.join\\(DATA_DIR, "${directory}"\\)`));
  }
  assert.match(server, /listProjectAssetsForTopic/);
  assert.doesNotMatch(server, /new URL\(`http:\/\/localhost:\$\{PORT\}\/api\/assets/);
  assert.match(server, /getLatestAssetQualityRemediations/);
  const assetClassifier = server.match(/function classifyAssetQualityRemediation[\s\S]*?\n}\n\n(?=function evaluateQualityConvergence)/)?.[0] || "";
  assert.match(assetClassifier, /\["retry_targeted", "awaiting_benchmark_comparison", "revise_upstream_contract", "revise_shared_contract"\]\.includes\(action\)/);
  assert.match(assetClassifier, /return null;/);
  assert.match(assetClassifier, /decisionReason/);
  assert.match(assetClassifier, /repairInstruction/);
  assert.match(server, /clean_targeted_replacement/);
  assert.match(server, /info_targeted_repair/);
  assert.match(server, /assetRepairInstruction\s*\|\|\s*row\.remediation\?\.assetDecisionReason/);
  assert.doesNotMatch(server, /row\.latestDecision\?\.reason \|\| '독립 검수의 확인된 INFO 문제만 교정하세요\.'/);
  assert.match(server, /function getDeterministicInfoLayout/);
  assert.match(server, /geometryMode: "none",[\s\S]*?guidePoints: \[\],[\s\S]*?labelPositions: \[\],[\s\S]*?confidence: 1/);
  assert.match(server, /const renderLayout = getDeterministicInfoLayout\(item, layout\)/);
  assert.match(server, /layout: renderLayout/);
  assert.match(server, /hasQueuedBenchmarkAssetRepair/);
  assert.match(server, /archiveFailedAssetForQualityRepair/);
  assert.match(server, /preserveFailedArtifact: true, replacementForQualityRepair: true/);
  assert.match(server, /path\.join\(getProjectDir\(topicId\), assetType, "rejected"\)/);
  assert.match(server, /artifactPaths: \[cleanPath, `\$\{cleanPath\}\.qc\.json`\]/);
  assert.match(server, /artifactPaths: \[outputPath, `\$\{outputPath\}\.qc\.json`, overlayPath, guidesPath, labelsPath, metadataPath\]/);
  assert.match(server, /shouldContinueQualityRepair\(renderResult\.semanticReview, qualityCycle, qualityStartedAt, 1, topic\.runLane === "production_canary" \? "autoConverge" : "benchmark"\)/);
  assert.match(server, /type === "none"/);
  assert.match(server, /INFO 없음 필요성·중복 계약을 통과/);
});

test("aggregated CLEAN failures carry scoped feedback through upstream correction", () => {
  const remediation = server.slice(
    server.indexOf("async function remediateAllBenchmarkQuality"),
    server.indexOf("function cancelJob")
  );
  const assetRemediation = server.slice(
    server.indexOf("function buildAssetQualityPromptDetails"),
    server.indexOf("function evaluateQualityConvergence")
  );
  const productionStage = server.slice(
    server.indexOf("async function runProductionBriefStage"),
    server.indexOf("async function generateScript")
  );
  const shotlistGeneration = server.slice(
    server.indexOf("async function generateShotlist"),
    server.indexOf("function renderCleanPromptsMarkdown")
  );
  const benchmarkAdvance = server.slice(
    server.indexOf("async function advanceBenchmarkQuality"),
    server.indexOf("async function advanceAllBenchmarkQuality")
  );

  assert.match(assetRemediation, /promptDetails/);
  assert.match(assetRemediation, /assetQualityFeedback/);
  assert.match(assetRemediation, /cleanPrompt/);
  assert.match(assetRemediation, /requiredVisibleElements/);
  assert.match(assetRemediation, /forbiddenVisibleElements/);
  assert.match(remediation, /for \(const clipIndex of clipIndexes\)/);
  assert.doesNotMatch(remediation, /const clipIndex = clipIndexes\[0\]/);
  assert.match(remediation, /assetQualityFeedback,/);
  assert.match(remediation, /targetClipIndexes: assetQualityFeedback\.clipIndexes/);
  assert.match(productionStage, /reviseProductionBriefFromQualityFeedback\(topic, factCheck, existing, jobContext, payload\.assetQualityFeedback\)/);
  assert.match(server, /Deterministic CLEAN quality correction scope/);
  assert.match(server, /동일 프롬프트 재생성을 중단했습니다/);
  assert.match(shotlistGeneration, /assetQualityFeedback\.clipIndexes/);
  assert.match(server, /CLEAN quality correction scope \(only these clip indexes may change/);
  assert.match(shotlistGeneration, /changedContractPromptClipIndexes/);
  assert.match(benchmarkAdvance, /remediationRoute: "local_targeted_revision"/);
  assert.match(benchmarkAdvance, /changedContractPromptClipIndexes/);
  assert.match(benchmarkAdvance, /제작 계약이 바뀌지 않은 CLEAN 프롬프트는 다시 생성하지 않습니다/);
});

test("benchmark replacement discovery persists only qualified external visual candidates", () => {
  const replacementDiscovery = server.slice(
    server.indexOf("function normalizeReplacementDiscoveryRequest"),
    server.indexOf("function cleanupNoisyTopics")
  );
  const replacementQualification = server.slice(
    server.indexOf("const REPLACEMENT_DIRECT_REFERENCE_TYPES"),
    server.indexOf("function recordTopicAttempt")
  );
  const discoveryRun = server.slice(
    server.indexOf("async function runTopicDiscovery"),
    server.indexOf("function findTopics")
  );

  assert.match(server, /CREATE TABLE IF NOT EXISTS benchmark_replacement_candidates/);
  assert.match(server, /candidate_topic_id INTEGER NOT NULL UNIQUE/);
  assert.match(server, /FOREIGN KEY \(original_topic_id\) REFERENCES topics\(id\)/);
  assert.match(server, /idx_benchmark_replacement_candidates_original/);
  assert.match(server, /\(11, 'benchmark_replacement_candidates'\)/);
  assert.match(replacementDiscovery, /replacementForTopicIds/);
  assert.match(replacementDiscovery, /replacementSlots/);
  assert.match(replacementDiscovery, /minimumQualifiedPerSlot/);
  assert.match(replacementDiscovery, /clampInteger\(requestedSlots, 0, 12/);
  assert.doesNotMatch(replacementDiscovery, /\b114\b/);
  assert.match(replacementDiscovery, /benchmark_cases\.topic_id = topics\.id/);
  assert.doesNotMatch(replacementDiscovery, /UPDATE benchmark_cases|DELETE FROM benchmark_cases/);
  assert.match(discoveryRun, /replacementCandidateLinkId/);
  assert.match(discoveryRun, /replacementOriginTopicIds/);
  assert.match(discoveryRun, /fact_check_job_id/);
  assert.match(replacementQualification, /official_photo", "construction_photo", "official_diagram", "official_section/);
  assert.match(replacementQualification, /\.pdf/);
  assert.match(replacementQualification, /directReferences\.size < 3 \|\| visibleStates\.size < 3/);
  assert.match(replacementQualification, /hidden_or_non_external_visual_requirement/);
  assert.match(replacementQualification, /no_direct_official_visual_states/);
  assert.match(replacementQualification, /candidate_verified/);
  assert.match(replacementQualification, /async function preflightReplacementVisualReference/);
  assert.match(replacementQualification, /image\/PDF signature 또는 content type 검증에 실패했습니다/);
  assert.match(replacementQualification, /PDF page render 검증에 실패했습니다/);
  assert.match(replacementQualification, /direct_media_preflight_failed/);
  assert.match(replacementQualification, /directMediaPreflight/);
  assert.match(replacementQualification, /UPDATE benchmark_replacement_candidates/);
  assert.match(server, /\/api\/quality\/replacements/);
  assert.match(server, /listBenchmarkReplacementCandidates\(url\.searchParams\.get\("originalTopicId"\)\)/);
  assert.match(server, /updateReplacementCandidateFromFactCheck\(payload, topic, factCheck\)/);
  assert.match(server, /landingPreflight/);
  assert.match(server, /replacementSeed/);
});

test("seeded replacement candidates persist untrusted inputs and durable fact-check links", () => {
  const seedRoute = server.slice(server.indexOf("function normalizeSeedReplacementReferences"), server.indexOf("function listBenchmarkReplacementCandidates"));
  assert.match(server, /POST" && url\.pathname === "\/api\/quality\/replacements\/seeds/);
  assert.match(seedRoute, /untrustedSeed: true/);
  assert.match(seedRoute, /benchmark_cases\.topic_id = topics\.id/);
  assert.doesNotMatch(seedRoute, /UPDATE benchmark_cases|DELETE FROM benchmark_cases/);
  assert.match(seedRoute, /source_route = 'seed_replacement'/);
  assert.match(seedRoute, /enqueueAiJob\("fact_check"/);
  assert.match(seedRoute, /fact_check_job_id/);
  assert.match(seedRoute, /reference\?\.sourceUrl \|\| landingUrl/);
  assert.match(server, /async function persistSeedReplacementPreflight/);
  assert.match(server, /seed_direct_media_preflight_failed/);
  assert.match(server, /\/api\/quality\/replacements\/retry-seed/);
  assert.match(server, /bounded fallback 한도를 소진했습니다/);
  assert.match(server, /await persistSeedReplacementPreflight\(payload, topic\)/);
  assert.match(server, /검증 전 replacement media 후보/);
});
