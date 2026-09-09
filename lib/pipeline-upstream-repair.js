import { stableCanonicalStringify, hashPipelineInputSnapshot } from './pipeline-contract.js';
import { scriptRepairHash, applyNarrationPatch } from './pipeline-script-repair.js';

export function selectUpstreamNarrationTarget(script, shotlist, review) {
  if (review?.passed !== false || !review.issues?.length || review.deterministicIssues?.length) return null;
  const sceneIndex = review.issues[0].sceneIndexes?.[0];
  if (!Number.isInteger(sceneIndex) || !review.issues.every(issue => issue.code === 'narration_expression'
    && issue.severity === 'error' && issue.sceneIndexes?.length === 1 && issue.sceneIndexes[0] === sceneIndex)) return null;
  const scene = shotlist.scenes?.[sceneIndex - 1], rowIndex = scene?.sourceSegmentIndex;
  if (!Number.isInteger(rowIndex) || !script.productionScript?.[rowIndex - 1]
    || shotlist.scenes.filter(row => row.sourceSegmentIndex === rowIndex).length !== 1
    || scene.narrationAnchor !== script.productionScript[rowIndex - 1].narration) return null;
  return { beforeHash: scriptRepairHash(script), rowIndex, field: 'narration' };
}

// Full snapshot CAS: only one narration/segment and derived audio totals may move.
export function validateUpstreamNarrationTransition(before, transition) {
  const fail = reason => { throw Error(`upstream_repair:${reason}`); };
  if (before?.stage !== 'shotlist' || transition?.type !== 'shotlist_narration_repair'
    || transition.fromRevision !== hashPipelineInputSnapshot(before)) fail('stale_transition');
  const expected = structuredClone(before), after = transition.toSnapshot;
  const target = { beforeHash: scriptRepairHash(expected.script), rowIndex: transition.rowIndex, field: 'narration' };
  expected.script = applyNarrationPatch(expected.script, {...target,newValue:transition.narration},target);
  const segment = expected.tts.segments[transition.rowIndex - 1], next = after?.tts?.segments?.[transition.rowIndex - 1];
  if (!segment || !next || segment.segmentIndex !== transition.rowIndex || next.text !== transition.narration
    || next.audioPath === segment.audioPath || next.durationSec <= 0 || next.durationSec > 4.01) fail('segment_contract');
  for(const key of ['text','audioPath','durationSec','estimatedDurationSec'])segment[key]=next[key];
  expected.tts.totalDurationSec = after.tts.totalDurationSec;
  expected.tts.estimatedTotalDurationSec = after.tts.estimatedTotalDurationSec;
  expected.tts.outputPath = after.tts.outputPath;
  if(stableCanonicalStringify(expected)!==stableCanonicalStringify(after))fail('unexpected_contract_change');
  const retainedIndexes=before.tts.segments.filter(row=>row.segmentIndex!==transition.rowIndex).map(row=>row.segmentIndex);
  if(stableCanonicalStringify(transition.retainedAudio?.map(audio=>audio.index))!==stableCanonicalStringify(retainedIndexes))fail('retained_audio_missing');
  const total=after.tts.segments.reduce((sum,row)=>sum+row.durationSec,0)+0.25*(after.tts.segments.length-1);
  if(!Number.isFinite(total)||Math.abs(total-after.tts.totalDurationSec)>0.001
    || Math.abs(total-transition.masterAudio?.durationSec)>0.001 || transition.afterAudio?.durationSec!==next.durationSec)fail('derived_audio_duration');
  if(Object.keys(transition).sort().join(',')!==['type','fromRevision','toSnapshot','rowIndex','narration','beforeAudio','afterAudio','retainedAudio','masterAudio','failureFingerprint'].sort().join(','))fail('transition_fields');
  return hashPipelineInputSnapshot(expected);
}
