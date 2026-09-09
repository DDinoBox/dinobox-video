import { createHash } from 'node:crypto';
import { stableCanonicalStringify } from './pipeline-contract.js';

export const infoLayoutPatchSchema = {
  type: 'object', additionalProperties: false,
  required: ['beforeHash', 'clipIndex', 'field', 'newValue'],
  properties: {
    beforeHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    clipIndex: { type: 'integer', minimum: 1 },
    field: { type: 'string', const: 'labelPositions' },
    newValue: { type: 'array', minItems: 1, maxItems: 2, items: {
      type: 'object', additionalProperties: false, required: ['x', 'y'],
      properties: { x: { type: 'number', minimum: 0.04, maximum: 0.96 }, y: { type: 'number', minimum: 0.04, maximum: 0.96 } }
    } }
  }
};
export const infoRepairHash = value => createHash('sha256').update(stableCanonicalStringify(value)).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function selectInfoRepairTarget(contract, review) {
  if (!contract?.cleanHash || contract.spec?.type === 'none' || !Array.isArray(contract.layout?.labelPositions)
    || !contract.layout.labelPositions.length || review?.passed !== false || review.action !== 'revise'
    || !review.issues?.length || review.issues.some(issue => !['unreadable', 'clutter'].includes(issue.code)
      || !Array.isArray(issue.sceneIndexes) || issue.sceneIndexes.length !== 1 || issue.sceneIndexes[0] !== contract.clipIndex)) return null;
  return { beforeHash: infoRepairHash(contract), clipIndex: contract.clipIndex, field: 'labelPositions',
    failureFingerprint: infoRepairHash({ inputHash: infoRepairHash(contract), codes: [...new Set(review.issues.map(issue => issue.code))].sort() }) };
}
// Only label placement is expression-only. Spec, claim text, anchors, directions,
// quantities and guide geometry remain byte-for-byte unchanged; other findings HOLD.
export function applyInfoLayoutPatch(contract, patch, target) {
  const fail = reason => { throw Error(`info_repair:${reason}`); };
  if (!exact(patch, ['beforeHash','clipIndex','field','newValue'])) fail('invalid_keys');
  if (patch.beforeHash !== infoRepairHash(contract) || target.beforeHash !== patch.beforeHash) fail('stale_hash');
  if (patch.clipIndex !== contract.clipIndex || patch.clipIndex !== target.clipIndex || patch.field !== 'labelPositions') fail('invalid_target');
  if (!Array.isArray(patch.newValue) || patch.newValue.length !== contract.layout.labelPositions.length
    || patch.newValue.some(point => !exact(point,['x','y']) || [point.x,point.y].some(n => !Number.isFinite(n) || n < 0.04 || n > 0.96))) fail('invalid_positions');
  if (stableCanonicalStringify(patch.newValue) === stableCanonicalStringify(contract.layout.labelPositions)) fail('no_change');
  return { ...structuredClone(contract.layout), labelPositions: structuredClone(patch.newValue) };
}
