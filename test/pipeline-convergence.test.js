import assert from "node:assert/strict";
import test from "node:test";
import { getNextPipelineJob, getPipelineConvergenceState } from "../lib/pipeline-convergence.js";

test("pipeline converges through measured TTS and ends at INFO without H3", () => {
  const snapshots = [
    [{}, "script", "script_generate"],
    [{ scriptReady: true }, "tts", "tts_generate"],
    [{ scriptReady: true, ttsMeasured: true }, "shotlist", "shotlist_generate"],
    [{ scriptReady: true, ttsMeasured: true, shotlistReady: true }, "clean", "clean_image_generate"],
    [{ scriptReady: true, ttsMeasured: true, shotlistReady: true, cleanReady: true }, "info", "info_image_generate"]
  ];
  for (const [snapshot, stage, jobType] of snapshots) {
    const next = getNextPipelineJob(snapshot);
    assert.equal(next.stage, stage);
    assert.equal(next.jobType, jobType);
    assert.equal(next.terminal, false);
  }
  const complete = getPipelineConvergenceState({ scriptReady: true, ttsMeasured: true, shotlistReady: true, cleanReady: true, infoReady: true });
  assert.deepEqual(complete, { stage: "complete", terminal: true, requiresActualTts: true, h3Allowed: false });
});

test("pipeline carries a supplied dedupe input hash", () => {
  assert.equal(getNextPipelineJob({ inputHash: "abc" }).inputHash, "abc");
});
