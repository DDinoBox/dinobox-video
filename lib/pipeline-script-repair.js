import { createHash } from 'node:crypto';
import { stableCanonicalStringify } from './pipeline-contract.js';

const MAX_NARRATION_LENGTH = 2000;
const STYLE_CODES = new Set(['repetition', 'weak_hook', 'not_visualizable']);
export const narrationPatchSchema = {
  type: 'object', additionalProperties: false,
  required: ['beforeHash', 'rowIndex', 'field', 'newValue'],
  properties: {
    beforeHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    rowIndex: { type: 'integer', minimum: 1 },
    field: { type: 'string', const: 'narration' },
    newValue: { type: 'string', minLength: 1, maxLength: MAX_NARRATION_LENGTH }
  }
};

export function scriptRepairHash(script) {
  return createHash('sha256').update(stableCanonicalStringify(script)).digest('hex');
}

function validRows(script) {
  return Array.isArray(script?.productionScript) && script.productionScript.length > 0
    && script.productionScript.every(row => row && typeof row === 'object' && !Array.isArray(row)
      && typeof row.narration === 'string' && row.narration.trim());
}

export function selectNarrationRepairTarget(script, review) {
  if (!validRows(script) || review?.passed !== false
    || (review.deterministicIssues !== undefined && (!Array.isArray(review.deterministicIssues) || review.deterministicIssues.length))
    || !Array.isArray(review.issues) || !review.issues.length) return null;
  const rowIndex = review.issues[0]?.segmentIndex;
  if (!Number.isInteger(rowIndex) || rowIndex < 1 || rowIndex > script.productionScript.length
    || !review.issues.every(issue => issue?.targetField === 'narration' && issue.segmentIndex === rowIndex && STYLE_CODES.has(issue.code))) return null;
  try { return { beforeHash: scriptRepairHash(script), rowIndex, field: 'narration' }; }
  catch { return null; }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

// These are rejection heuristics, NOT proof of semantic equivalence. Conditional
// narration is unsupported locally; independent AI review must recheck all edits.
function hasUnsupportedCondition(text) {
  if (/(?:경우|동안|이상|이하|미만|초과|이내|항상|절대|오직|만약|않|없|이전|이후|직전|직후)/u.test(text)) return true;
  return (text.match(/[가-힣]+/gu) || []).some(word =>
    /^(?:전|후)(?:에|는|에는|에도|부터|까지)?$/u.test(word)
    || /때(?:에|는|에는|에도|부터|까지)?$/u.test(word)
    || word === '안' || word.startsWith('못') || /(?:부터|까지)$/u.test(word)
    || (word.endsWith('면') && !/^(?:화면|표면|단면|측면|정면|후면|뒷면|앞면|평면|곡면|내면|외면|지면|수면|장면)$/u.test(word))
    || /만(?:은|이|을|의|큼)?$/u.test(word));
}

const UNIT = '(?:킬로미터|센티미터|밀리미터|마이크로미터|미터|킬로그램|밀리그램|그램|밀리초|퍼센트|리터|제곱미터|세제곱미터|시간|개월|km|cm|mm|kg|mg|ms|m|g|s|%|℃|°C|°|초|분|년|월|일|도|배|개|명|대|톤|층|번|회|원|달러)';
const QUANTITY = new RegExp(`[+-]?\\d+(?:[,，]\\d{3})*(?:\\.\\d+)?(?:\\s*${UNIT})?|[영공일이삼사오육칠팔구십백천만억조]+\\s*${UNIT}|(?:(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|스물|서른|마흔|쉰|예순|일흔|여든|아흔)\\s*)+${UNIT}`, 'gu');
function quantities(text) {
  // Freeze complete digit-bearing tokens (and a following unit token for a
  // standalone number), so an unknown unit or compound unit cannot slip through
  // the finite dictionary above. This deliberately rejects some harmless edits.
  const words = text.match(/\S+/gu) || [];
  const numericTokens = words.flatMap((word, index) => /\p{N}/u.test(word)
    ? [word, ...(/^[+-]?[\d.,]+$/u.test(word) && words[index + 1] ? [words[index + 1]] : [])] : []);
  const ordinals = text.match(/첫째|첫|둘째|셋째|넷째|다섯째|여섯째|일곱째|여덟째|아홉째|열째|(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*번째/gu) || [];
  return JSON.stringify({ quantities: (text.match(QUANTITY) || []).map(value => value.replace(/\s+/gu, '')), numericTokens, ordinals });
}

export function applyNarrationPatch(script, patch, target) {
  if (!validRows(script)) throw Error('narration_patch_invalid_script');
  if (!exactKeys(patch, ['beforeHash', 'rowIndex', 'field', 'newValue'])
    || !exactKeys(target, ['beforeHash', 'rowIndex', 'field'])) throw Error('narration_patch_invalid_keys');
  const beforeHash = scriptRepairHash(script);
  if (patch.beforeHash !== beforeHash || target.beforeHash !== beforeHash) throw Error('narration_patch_stale_hash');
  if (!Number.isInteger(patch.rowIndex) || patch.rowIndex < 1 || patch.rowIndex > script.productionScript.length
    || patch.rowIndex !== target.rowIndex || patch.field !== 'narration' || target.field !== 'narration') throw Error('narration_patch_invalid_target');
  const before = script.productionScript[patch.rowIndex - 1].narration;
  if (typeof patch.newValue !== 'string' || !patch.newValue.trim() || patch.newValue.length > MAX_NARRATION_LENGTH
    || patch.newValue.trim() === before.trim()) throw Error('narration_patch_invalid_value');
  if (hasUnsupportedCondition(before) || hasUnsupportedCondition(patch.newValue)) throw Error('narration_patch_condition_unsupported');
  if (quantities(before) !== quantities(patch.newValue)) throw Error('narration_patch_numeric_change');
  // JSON validation above covers the entire candidate. Preserve original key and
  // array order while detaching every nested value, not just the edited row.
  const result = JSON.parse(JSON.stringify(script));
  result.productionScript[patch.rowIndex - 1].narration = patch.newValue;
  result.ttsText = result.productionScript.map(row => row.narration).join(' ');
  return result;
}
