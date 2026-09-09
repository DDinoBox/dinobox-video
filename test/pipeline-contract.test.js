import test from "node:test";
import assert from "node:assert/strict";
import { buildPipelineInputSnapshot, hashPipelineInputSnapshot, stableCanonicalStringify } from "../lib/pipeline-contract.js";

function input(stage = "info") {
  return {
    topicId: 7, stage,
    fact: { id: 1, status: "PASS", coreClaim: "water moves", claims: [{ id: "c1", text: "pressure", status: "SUPPORTED" }], updatedAt: "old" },
    brief: { id: 2, revision: 1, status: "approved", visualStates: [{ id: "v1", geometry: { x: 1 }, infoGraphic: { requiresOverlay: true }, claimRefs: ["c1"] }] },
    script: { id: 3, status: "approved", coreMechanism: "pressure", productionScript: [{ narration: "water", claimRefs: ["c1"] }], ttsText: "water" },
    tts: { id: 4, scriptId: 3, status: "generated", totalDurationSec: 2, segments: [{ id: 40, segmentIndex: 1, text: "water", durationSec: 2, audioPath: "audio.wav", status: "generated" }] },
    shotlist: { id: 5, status: "approved", raw: { infoPlanVersion: 1 }, items: [{ id: 6, sortIndex: 1, fileStub: "001", sceneId: "s1", visualStateId: "v1", cleanPrompt: "water", requiredVisibleElements: ["pipe"], physicalState: { geometry: { x: 1 } }, claimRefs: ["c1"], infoFocus: "pressure", infoPrompt: "label", infoSpec: { type: "arrow", requiresOverlay: true, anchors: [{ x: 1 }], labels: ["pressure"] } }] },
    cleanHashes: ["abc"]
  };
}
const hash = (value) => hashPipelineInputSnapshot(buildPipelineInputSnapshot(value));

test("canonical JSON sorts keys recursively but preserves array order", () => {
  assert.equal(stableCanonicalStringify({ z: [{ b: 2, a: 1 }], a: false }), '{"a":false,"z":[{"a":1,"b":2}]}');
  assert.equal(hash(input()), hash(JSON.parse(stableCanonicalStringify(input()))));
  assert.notEqual(stableCanonicalStringify([1, 2]), stableCanonicalStringify([2, 1]));
  assert.throws(() => stableCanonicalStringify({ x: NaN }), /JSON/);
  assert.throws(() => stableCanonicalStringify(new Date()), /JSON/);
});

test("INFO replanning and derived outputs do not invalidate INFO or CLEAN", () => {
  for (const stage of ["info", "clean"]) {
    const before = input(stage);
    const after = structuredClone(before);
    Object.assign(after.shotlist.items[0], { infoFocus: "new focus", infoPrompt: "new prompt", infoSpec: { type: "none", requiresOverlay: false }, updatedAt: "new" });
    after.shotlist.raw = { infoPlanVersion: 2, infoPlan: [{ labels: ["new"] }] };
    assert.equal(hash(before), hash(after));
  }
});

test("initial INFO provider context retains immutable original overlay and claims", () => {
  const value = input();
  const snapshot = buildPipelineInputSnapshot(value);
  const original = snapshot.providerContext.initialShotlistItems[0];
  assert.equal(original.infoSpec.requiresOverlay, true);
  assert.deepEqual(original.claimRefs, ["c1"]);
  value.shotlist.items[0].infoSpec.requiresOverlay = false;
  value.shotlist.items[0].claimRefs.push("c2");
  assert.equal(original.infoSpec.requiresOverlay, true);
  assert.deepEqual(original.claimRefs, ["c1"]);
  assert.throws(() => { original.infoSpec.requiresOverlay = false; }, TypeError);
  assert.equal(hashPipelineInputSnapshot(snapshot), hashPipelineInputSnapshot(JSON.parse(JSON.stringify(snapshot))));
});

test("readiness and bookkeeping changes are not content changes", () => {
  const before = input();
  const after = structuredClone(before);
  for (const key of ["fact", "brief", "script", "tts", "shotlist"]) {
    Object.assign(after[key], { status: "pending", updatedAt: "new", createdAt: "new", approvedAt: "new" });
  }
  after.tts.segments[0].status = "pending";
  after.tts.segments[0].updatedAt = "new";
  after.script.qualityReviews = [{ status: "passed" }];
  assert.equal(hash(before), hash(after));
});

test("meaningful source text, geometry, required semantics and claims invalidate", () => {
  const changes = [
    v => { v.fact.claims[0].text = "different"; },
    v => { v.fact.claims[0].status = "UNSUPPORTED"; },
    v => { v.brief.visualStates[0].geometry.x = 2; },
    v => { v.brief.visualStates[0].infoGraphic.requiresOverlay = false; },
    v => { v.script.productionScript[0].narration = "different"; },
    v => { v.tts.segments[0].durationSec = 3; },
    v => { v.tts.segments[0].text = "different"; },
    v => { v.shotlist.items[0].physicalState.geometry.x = 2; },
    v => { v.shotlist.items[0].requiredVisibleElements.push("valve"); },
    v => { v.shotlist.items[0].claimRefs = ["c2"]; },
    v => { v.shotlist.items[0].cleanPrompt = "different"; },
    v => { v.cleanHashes[0] = "def"; }
  ];
  for (const change of changes) {
    const before = input();
    const after = structuredClone(before);
    change(after);
    assert.notEqual(hash(before), hash(after), change.toString());
  }
});

test("each stage excludes its own output and downstream artifacts", () => {
  for (const [stage, excluded] of [["script", ["script", "tts", "shotlist", "cleanHashes"]], ["tts", ["tts", "shotlist", "cleanHashes"]], ["shotlist", ["shotlist", "cleanHashes"]], ["clean", ["cleanHashes"]]]) {
    for (const key of excluded) {
      const before = input(stage);
      const after = structuredClone(before);
      after[key] = null;
      assert.equal(hash(before), hash(after), `${stage}: ${key}`);
    }
  }
  assert.notEqual(hash(input("clean")), hash(input("info")));
});

test("versioned user INFO input is hashed only for INFO and supplies original context", () => {
  const before = input();
  const after = structuredClone(before);
  after.shotlist.items[0].infoInput = { revision: 1, userSpec: { type: "none", requiresOverlay: false }, userPrompt: "user" };
  assert.notEqual(hash(before), hash(after));
  assert.equal(hash({ ...before, stage: "clean" }), hash({ ...after, stage: "clean" }));
  const snapshot = buildPipelineInputSnapshot(after);
  assert.deepEqual(snapshot.shotlist.items[0].sourceInfo, after.shotlist.items[0].infoInput);
  assert.equal(snapshot.providerContext.initialShotlistItems[0].infoSpec.requiresOverlay, false);
  assert.equal(snapshot.providerContext.initialShotlistItems[0].infoPrompt, "user");
  for (const field of ["revision", "userSpec", "userPrompt"]) {
    const changed = structuredClone(after);
    changed.shotlist.items[0].infoInput[field] = field === "revision" ? 2 : field === "userSpec" ? { type: "arrow" } : "changed";
    assert.notEqual(hash(after), hash(changed));
  }
  after.shotlist.items[0].infoSpec = { requiresOverlay: true };
  assert.equal(hash(after), hashPipelineInputSnapshot(snapshot));
});

test("null inputs are deterministic; invalid stages fail closed", () => {
  assert.equal(hash({ topicId: 7, stage: "script" }), hash({ topicId: 7, stage: "script", fact: null, brief: null }));
  assert.throws(() => buildPipelineInputSnapshot({ topicId: 7, stage: "video" }), /stage/);
  assert.throws(() => hashPipelineInputSnapshot({}), /snapshot/);
});
