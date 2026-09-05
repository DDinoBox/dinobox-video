const STAGES = Object.freeze(["script", "tts", "shotlist", "clean", "info", "complete"]);

export function getPipelineConvergenceState(snapshot = {}) {
  if (!snapshot.scriptReady) return { stage: "script", terminal: false, requiresActualTts: false };
  if (!snapshot.ttsMeasured) return { stage: "tts", terminal: false, requiresActualTts: true };
  if (!snapshot.shotlistReady) return { stage: "shotlist", terminal: false, requiresActualTts: true };
  if (!snapshot.cleanReady) return { stage: "clean", terminal: false, requiresActualTts: true };
  if (!snapshot.infoReady) return { stage: "info", terminal: false, requiresActualTts: true };
  return { stage: "complete", terminal: true, requiresActualTts: true, h3Allowed: false };
}

export function getNextPipelineJob(snapshot = {}) {
  const state = getPipelineConvergenceState(snapshot);
  const jobTypeByStage = {
    script: "script_generate",
    tts: "tts_generate",
    shotlist: "shotlist_generate",
    clean: "clean_image_generate",
    info: "info_image_generate"
  };
  return {
    ...state,
    jobType: jobTypeByStage[state.stage] || null,
    inputHash: String(snapshot.inputHash || "")
  };
}

export function isPipelineStage(value) {
  return STAGES.includes(String(value || ""));
}
