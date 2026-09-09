import { createHash } from "node:crypto";

const STAGES = ["script", "tts", "shotlist", "clean", "info"];
const TIMESTAMPS = new Set(["createdAt", "updatedAt", "approvedAt", "generatedAt"]);
const FACT_FIELDS = ["id", "topicId", "confidence", "coreClaim", "claims", "verifiedFacts", "visualEvidence", "unresolved", "simplifications", "sources", "verdictReason", "nextAction", "enrichmentQueries", "enrichmentSources"];
const BRIEF_FIELDS = ["id", "topicId", "factCheckId", "domainKey", "narrativeType", "scopeStatement", "coreQuestion", "causalChain", "visualStates", "forbiddenInferences", "lengthGuidance"];
const SCRIPT_FIELDS = ["id", "topicId", "coreQuestion", "coreConflict", "coreMechanism", "visibleFlow", "turningPoint", "uniqueDifferentiator", "designIntervention", "tradeoffs", "limitations", "narrativeType", "narrativeReason", "causalContext", "lengthPlan", "signaturePlan", "productionScript", "ttsText", "notes"];
const TTS_FIELDS = ["id", "topicId", "scriptId", "voicePresetId", "engine", "language", "totalDurationSec", "estimatedTotalDurationSec", "outputPath"];
const SEGMENT_FIELDS = ["id", "runId", "topicId", "scriptId", "segmentIndex", "label", "plannedTime", "text", "audioPath", "durationSec", "estimatedDurationSec"];
const SHOTLIST_FIELDS = ["id", "topicId", "scriptId", "ttsRunId", "totalDurationSec", "clipCount"];
const ITEM_FIELDS = ["id", "shotlistId", "topicId", "sortIndex", "sceneId", "keyframeId", "clipId", "sourceSegmentIndex", "sourceSegmentOrder", "visualStateId", "evidenceBeatId", "startSec", "endSec", "durationSec", "scriptExcerpt", "scenePurpose", "cleanContent", "cameraMotion", "shotRole", "visualFamily", "referencePolicy", "motionPolicy", "requiredVisibleElements", "forbiddenVisibleElements", "transitionEndState", "physicalState", "stateChangeReason", "forceFlow", "claimRefs", "cleanPrompt", "fileStub"];

// JSON-only, explicit recursive key ordering; arrays retain semantic order.
// Reject lossy values instead of silently colliding (NaN, Date, cycles, etc.).
export function stableCanonicalStringify(value) {
  const ancestors = new Set();
  function encode(node) {
    if (node === null) return "null";
    if (typeof node === "string" || typeof node === "boolean") return JSON.stringify(node);
    if (typeof node === "number" && Number.isFinite(node)) return JSON.stringify(node);
    if (typeof node !== "object" || node === null || ancestors.has(node)) throw new TypeError("Expected acyclic JSON values");
    if (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) throw new TypeError("Expected plain JSON objects");
    ancestors.add(node);
    let result;
    if (Array.isArray(node)) {
      result = `[${Array.from(node, encode).join(",")}]`;
    } else {
      result = `{${Object.keys(node).sort().map(key => `${JSON.stringify(key)}:${encode(node[key])}`).join(",")}}`;
    }
    ancestors.delete(node);
    return result;
  }
  return encode(value);
}

function semanticCopy(value) {
  // Canonical round-trip also validates data and detaches every nested object.
  const copy = JSON.parse(stableCanonicalStringify(value));
  function strip(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(strip);
    return Object.fromEntries(Object.entries(node).filter(([key]) => !TIMESTAMPS.has(key)).map(([key, child]) => [key, strip(child)]));
  }
  return strip(copy);
}

function pick(value, fields) {
  if (value == null) return null;
  return semanticCopy(Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]])));
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Input is the mapped server records, not raw SQLite rows. Readiness/approval
 * stays in server policy. Nested claim.status is evidence, NOT readiness.
 *
 * Persist this entire initial snapshot before executing a job; pass its original
 * providerContext to retries/providers. Never rebuild that context from mutated
 * INFO rows. Hashing intentionally excludes providerContext: infoSpec/infoFocus/
 * infoPrompt and shotlist.raw are INFO-owned outputs, including requiresOverlay
 * inside infoSpec. The initial copy preserves that requirement for safety gates;
 * canonical source claimRefs and brief.visualStates remain revision-bound.
 * Map getInfoInput(db, item.id) to item.infoInput. User-only edits are bound as
 * sourceInfo on INFO items and override mutable output in the initial context.
 * Provider writes must not increment that user revision. Legacy null infoInput
 * preserves the previous hash shape. This module does not persist or enforce gates.
 */
export function buildPipelineInputSnapshot({ topicId, stage, fact, brief, script, tts, shotlist, cleanHashes, visualReferences, cleanCorrections } = {}) {
  if (!STAGES.includes(stage)) throw new TypeError(`Unsupported pipeline stage: ${stage}`);
  const snapshot = {
    schemaVersion: 1,
    topicId: topicId ?? null,
    stage,
    fact: pick(fact, FACT_FIELDS),
    brief: pick(brief, BRIEF_FIELDS)
  };
  if (stage !== "script") snapshot.script = pick(script, SCRIPT_FIELDS);
  if (["shotlist", "clean", "info"].includes(stage)) {
    snapshot.tts = tts == null ? null : { ...pick(tts, TTS_FIELDS), segments: (tts.segments || []).map(segment => pick(segment, SEGMENT_FIELDS)) };
  }
  if (["clean", "info"].includes(stage)) {
    snapshot.shotlist = shotlist == null ? null : { ...pick(shotlist, SHOTLIST_FIELDS), items: (shotlist.items || []).map(item => pick(item, ITEM_FIELDS)) };
    if (visualReferences !== undefined) snapshot.visualReferences = semanticCopy(visualReferences);
    if (cleanCorrections && Object.keys(cleanCorrections).length) snapshot.cleanCorrections = semanticCopy(cleanCorrections);
  }
  if (stage === "info") {
    snapshot.cleanHashes = semanticCopy(cleanHashes ?? []);
    snapshot.providerContext = {
      initialShotlistItems: (shotlist?.items || []).map((item, index) => {
        const initial = pick(item, [...ITEM_FIELDS, "infoFocus", "infoPrompt", "infoSpec"]);
        if (item.infoInput != null) {
          const source = item.infoInput;
          if (!Number.isSafeInteger(source.revision) || source.revision < 1
            || !source.userSpec || typeof source.userSpec !== "object" || Array.isArray(source.userSpec)
            || typeof source.userPrompt !== "string") throw new TypeError("Invalid INFO user input");
          snapshot.shotlist.items[index].sourceInfo = pick(source, ["revision", "userSpec", "userPrompt"]);
          initial.infoSpec = semanticCopy(source.userSpec);
          initial.infoPrompt = source.userPrompt;
        }
        return initial;
      })
    };
  }
  return freeze(semanticCopy(snapshot));
}

// Completion-only identity. The full generation snapshot/hash below remains the
// lease fence: even a timing edit during generation must still hold publication.
// Keep narration, scene identity, evidence, references and prompts; remove only
// explicit clock/audio-location fields, never whole script/TTS/shotlist records.
export function hashPipelineVisualSnapshot(snapshot) {
  hashPipelineInputSnapshot(snapshot);
  if (!["clean", "info"].includes(snapshot.stage)) throw new TypeError("Expected visual stage");
  const { providerContext, ...input } = semanticCopy(snapshot);
  if (input.script?.productionScript) input.script.productionScript = input.script.productionScript.map(({ time, ...row }) => row);
  if (input.tts) {
    for (const key of ["totalDurationSec", "estimatedTotalDurationSec", "outputPath"]) delete input.tts[key];
    input.tts.segments = input.tts.segments.map(segment => {
      for (const key of ["plannedTime", "durationSec", "estimatedDurationSec", "audioPath"]) delete segment[key];
      return segment;
    });
  }
  if (input.shotlist) {
    delete input.shotlist.totalDurationSec;
    input.shotlist.items = input.shotlist.items.map(({ startSec, endSec, durationSec, ...item }) => item);
  }
  return createHash("sha256").update(stableCanonicalStringify({ visualSchemaVersion: 1, input })).digest("hex");
}

// Narrow completion-only INFO dependency: shared script/evidence/shot contracts
// remain whole-sequence. Only independent clips' CLEAN bytes and user INFO input
// are excluded. Unknown/cross-clip reference policies keep the stage-wide fence.
export function hashPipelineInfoClipSnapshot(snapshot, clipKey) {
  hashPipelineInputSnapshot(snapshot);
  const items = snapshot.shotlist?.items || [];
  const index = items.findIndex(item => String(item.sortIndex) === String(clipKey));
  if (snapshot.stage !== "info" || index < 0 || items.some(item => item.referencePolicy !== "none")
    || snapshot.cleanHashes?.length !== items.length) return null;
  const scoped = scopeCleanCorrection(snapshot, clipKey);
  scoped.cleanHashes = scoped.cleanHashes.map((hash, i) => i === index ? hash : null);
  scoped.shotlist.items.forEach((item, i) => { if (i !== index) delete item.sourceInfo; });
  return createHash("sha256").update(stableCanonicalStringify({ infoClipSchemaVersion: 1,
    clipKey: String(clipKey), fingerprint: hashPipelineVisualSnapshot(scoped) })).digest("hex");
}

function scopeCleanCorrection(snapshot, clipKey) {
  const scoped = semanticCopy(snapshot);
  const own = scoped.cleanCorrections?.[String(clipKey)];
  delete scoped.cleanCorrections;
  if (own) scoped.cleanCorrections = { [String(clipKey)]: own };
  return scoped;
}

export function hashPipelineCleanClipSnapshot(snapshot, clipKey) {
  hashPipelineInputSnapshot(snapshot);
  const items = snapshot.shotlist?.items || [];
  if (snapshot.stage !== 'clean' || !items.some(item => String(item.sortIndex) === String(clipKey))
    || items.some(item => item.referencePolicy !== 'none')) return null;
  return createHash('sha256').update(stableCanonicalStringify({ cleanClipSchemaVersion: 1,
    clipKey: String(clipKey), fingerprint: hashPipelineVisualSnapshot(scopeCleanCorrection(snapshot, clipKey)) })).digest('hex');
}

export function hashPipelineInputSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !STAGES.includes(snapshot.stage)
    || !Object.hasOwn(snapshot, "topicId") || !Object.hasOwn(snapshot, "fact") || !Object.hasOwn(snapshot, "brief")) {
    throw new TypeError("Invalid pipeline input snapshot");
  }
  const { providerContext, ...revisionInput } = snapshot;
  return createHash("sha256").update(stableCanonicalStringify(revisionInput)).digest("hex");
}
