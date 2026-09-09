import { scriptRepairHash, applyNarrationPatch } from './pipeline-script-repair.js';

// The native shot schema has no cleanPrompt: that prompt is derived later.
// Only weak_video_motion has an unambiguous expression-only target today.
// Geometry, CLEAN content, INFO and physical-state findings belong upstream.
export const shotlistPatchSchema = {
  type: 'object', additionalProperties: false,
  required: ['beforeHash', 'sceneIndex', 'field', 'newValue'],
  properties: {
    beforeHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    sceneIndex: { type: 'integer', minimum: 1 },
    field: { type: 'string', const: 'cameraMotion' },
    newValue: { type: 'string', minLength: 1, maxLength: 2000 }
  }
};

export const shotlistRepairHash = scriptRepairHash;
const fail = reason => { throw Error(`shotlist_repair:owner=shotlist_expression;reason=${reason}`); };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function selectShotlistRepairTarget(shotlist, review) {
  if (!Array.isArray(shotlist?.scenes) || !shotlist.scenes.length || review?.passed !== false
    || !Array.isArray(review.issues) || !review.issues.length
    || (review.deterministicIssues !== undefined && (!Array.isArray(review.deterministicIssues) || review.deterministicIssues.length))) return null;
  const index = review.issues[0]?.sceneIndexes?.[0];
  // Consensus may repeat the same finding from independent reviewers. No other
  // scene/code/warning is silently dropped to make a candidate repairable.
  if (!Number.isInteger(index) || index < 1 || index > shotlist.scenes.length
    || !review.issues.every(issue => issue?.code === 'weak_video_motion' && issue.severity === 'error'
      && Array.isArray(issue.sceneIndexes) && issue.sceneIndexes.length === 1 && issue.sceneIndexes[0] === index)
    || typeof shotlist.scenes[index - 1]?.cameraMotion !== 'string') return null;
  return { beforeHash: shotlistRepairHash(shotlist), sceneIndex: index, field: 'cameraMotion' };
}

// These are conservative rejection heuristics, not semantic equivalence proof.
// Directional/conditional camera instructions are deliberately not locally edited.
const UNSAFE_MOTION = /\b(?:left|right|up|down|upward|downward|clockwise|counterclockwise|north|south|east|west|before|after|if|unless|until|while|only|not|never|without|more|less|above|below|toward|away|forward|backward|zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|first|second|third)\b|왼|오른|좌측|우측|좌우|상하|상향|하향|시계|반시계|북쪽|남쪽|동쪽|서쪽|위로|위쪽|아래|앞으로|뒤로|향해|방향|조건|반대/iu;

export function applyShotlistPatch(shotlist, patch, target) {
  if (!exactKeys(patch, ['beforeHash', 'sceneIndex', 'field', 'newValue'])
    || !exactKeys(target, ['beforeHash', 'sceneIndex', 'field'])) fail('invalid_keys');
  if (patch.beforeHash !== shotlistRepairHash(shotlist) || target.beforeHash !== patch.beforeHash) fail('stale_hash');
  if (patch.field !== 'cameraMotion' || target.field !== 'cameraMotion'
    || !Number.isInteger(patch.sceneIndex) || patch.sceneIndex !== target.sceneIndex
    || patch.sceneIndex < 1 || patch.sceneIndex > (shotlist.scenes?.length || 0)) fail('invalid_target');
  const before = shotlist.scenes[patch.sceneIndex - 1].cameraMotion;
  if (typeof before !== 'string' || typeof patch.newValue !== 'string') fail('invalid_value');
  if (UNSAFE_MOTION.test(before) || UNSAFE_MOTION.test(patch.newValue)) fail('direction_or_condition_unsupported');
  // Reuse the established bounded-string/quantity/condition guard. Its temporary
  // narration object is never persisted; neither narration nor TTS can be changed.
  const guard = { productionScript: [{ narration: before }] };
  const guardTarget = { beforeHash: scriptRepairHash(guard), rowIndex: 1, field: 'narration' };
  try { applyNarrationPatch(guard, { ...guardTarget, newValue: patch.newValue }, guardTarget); }
  catch (error) { fail(error.message); }
  const candidate = structuredClone(shotlist);
  candidate.scenes[patch.sceneIndex - 1].cameraMotion = patch.newValue;
  return candidate;
}

export function shotlistRepairHoldReason(review, reason) {
  const codes = (review?.issues || []).map(issue => issue?.code);
  const owner = codes.some(code => ['unsupported_visual', 'impossible_geometry', 'insufficient_visual_depth'].includes(code))
    ? 'visual_evidence' : codes.some(code => ['missing_causal_state', 'repeated_visual_state', 'family_mismatch', 'info_overuse'].includes(code))
      ? 'production_brief' : 'shotlist_expression';
  return `shotlist_repair:owner=${owner};reason=${reason}`;
}
