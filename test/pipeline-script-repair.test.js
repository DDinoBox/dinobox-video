import test from 'node:test';
import assert from 'node:assert/strict';
import { narrationPatchSchema, scriptRepairHash, selectNarrationRepairTarget, applyNarrationPatch } from '../lib/pipeline-script-repair.js';

const candidate = () => ({ title: '구조', productionScript: [
  { narration: '화면 속 물이 수로를 흐릅니다.', visualStateId: 'flow', claimRefs: ['c2', 'c1'], order: 1 },
  { narration: '물이 바퀴를 돌립니다.', visualStateId: 'wheel', claimRefs: ['c3'], order: 2 }
], ttsText: 'old text', notes: { preserved: ['a', 'b'] } });
const review = (overrides = {}) => ({ passed: false, deterministicIssues: [], issues: [{ code: 'repetition', targetField: 'narration', segmentIndex: 1 }], ...overrides });
const patchFor = (script, value = '화면 속 수로를 따라 물이 흐릅니다.') => ({ beforeHash: scriptRepairHash(script), rowIndex: 1, field: 'narration', newValue: value });

test('schema is exact and hash covers whole candidate canonically', () => {
  assert.equal(narrationPatchSchema.additionalProperties, false);
  assert.deepEqual(narrationPatchSchema.required, ['beforeHash', 'rowIndex', 'field', 'newValue']);
  assert.equal(scriptRepairHash({ b: 2, a: 1 }), scriptRepairHash({ a: 1, b: 2 }));
  const a = candidate(), b = candidate(); b.notes.preserved.reverse();
  assert.notEqual(scriptRepairHash(a), scriptRepairHash(b));
  assert.throws(() => scriptRepairHash({ n: NaN }));
});

test('select only one unambiguous narration style target', () => {
  const script = candidate();
  assert.deepEqual(selectNarrationRepairTarget(script, review()), { beforeHash: scriptRepairHash(script), rowIndex: 1, field: 'narration' });
  for (const change of [
    { passed: true }, { passed: 'false' }, { deterministicIssues: ['bad'] }, { deterministicIssues: {} }, { issues: [] },
    { issues: [{ code: 'unsupported_claim', targetField: 'narration', segmentIndex: 1 }] },
    { issues: [{ code: 'causal_gap', targetField: 'narration', segmentIndex: 1 }] },
    ...[0, 3, '1', 1.5].map(segmentIndex => ({ issues: [{ code: 'repetition', targetField: 'narration', segmentIndex }] })),
    { issues: [{ code: 'repetition', targetField: 'claimRefs', segmentIndex: 1 }] },
    { issues: [review().issues[0], { code: 'weak_hook', targetField: 'narration', segmentIndex: 2 }] }
  ]) assert.equal(selectNarrationRepairTarget(script, review(change)), null);
  assert.ok(selectNarrationRepairTarget(script, review({ issues: [...review().issues, { code: 'not_visualizable', targetField: 'narration', segmentIndex: 1 }] })));
});

test('apply changes only selected narration and deterministic ttsText, without mutation', () => {
  const script = candidate(), before = JSON.stringify(script);
  const result = applyNarrationPatch(script, patchFor(script), selectNarrationRepairTarget(script, review()));
  assert.equal(JSON.stringify(script), before);
  assert.notEqual(result, script);
  assert.equal(result.productionScript[0].narration, patchFor(script).newValue);
  assert.equal(result.ttsText, result.productionScript.map(row => row.narration).join(' '));
  const expected = candidate(); expected.productionScript[0].narration = patchFor(script).newValue; expected.ttsText = result.ttsText;
  assert.deepEqual(result, expected);
  assert.equal(JSON.stringify(result.productionScript[1]), JSON.stringify(script.productionScript[1]));
  assert.deepEqual(result.productionScript[0].claimRefs, ['c2', 'c1']);
  result.notes.preserved.push('detached');
  assert.equal(JSON.stringify(script), before);
});

test('reject stale CAS, other rows/fields, extra keys and invalid text', () => {
  const script = candidate(), target = selectNarrationRepairTarget(script, review());
  for (const change of [{ beforeHash: '0'.repeat(64) }, { rowIndex: 2 }, { rowIndex: 0 }, { field: 'claimRefs' },
    { claimRefs: [] }, { newValue: '' }, { newValue: '   ' }, { newValue: 42 }, { newValue: '가'.repeat(2001) },
    { newValue: script.productionScript[0].narration }]) {
    assert.throws(() => applyNarrationPatch(script, { ...patchFor(script), ...change }, target));
  }
  const changed = candidate(); changed.productionScript.reverse();
  assert.throws(() => applyNarrationPatch(changed, patchFor(script), target));
  const changedClaim = candidate(); changedClaim.productionScript[0].claimRefs = ['different'];
  assert.throws(() => applyNarrationPatch(changedClaim, patchFor(script), target));
  assert.throws(() => applyNarrationPatch(script, patchFor(script), null));
});

for (const [before, after] of [
  ['높이는 20미터입니다.', '높이는 30미터입니다.'], ['높이는 20미터입니다.', '높이는 20센티미터입니다.'],
  ['높이는 이십 미터입니다.', '높이는 삼십 미터입니다.'], ['기둥은 세 개입니다.', '기둥은 네 개입니다.'],
  ['길이는 2.5 m입니다.', '길이는 2.6 m입니다.'], ['물이 흐릅니다.', '물이 2초 흐릅니다.'],
  ['각도는 -5도입니다.', '각도는 5도입니다.'], ['비율은 20%입니다.', '비율은 30%입니다.'],
  ['기둥은 스물한 개입니다.', '기둥은 서른한 개입니다.'],
  ['압력은 5psi입니다.', '압력은 5bar입니다.'], ['속력은 5 m/s입니다.', '속력은 5 m/h입니다.'],
  ['첫 받침이 내려왔습니다.', '둘째 받침이 내려왔습니다.']
]) test(`numeric change rejected: ${before}`, () => {
  const script = candidate(); script.productionScript[0].narration = before;
  assert.throws(() => applyNarrationPatch(script, patchFor(script, after), selectNarrationRepairTarget(script, review())), /numeric/);
});

for (const text of ['물이 내려오면 바퀴가 돕니다.', '물이 흐를 때 바퀴가 돕니다.', '물이 흐르는 경우 회전합니다.',
  '수위가 2미터 이상입니다.', '물이 흐르지 않습니다.', '물이 없습니다.', '물이 흐르는 동안 회전합니다.',
  '물이 흐른 후 회전합니다.', '물만 흐릅니다.', '항상 회전합니다.', '절대 멈추지 않습니다.',
  '물이 내려올때 회전합니다.', '물이 안 흐릅니다.', '물이 흐르지 못합니다.', '오직 물이 흐릅니다.', '수위는 2미터 이내입니다.']) {
  test(`conditional input or added condition rejected: ${text}`, () => {
    const script = candidate(), target = selectNarrationRepairTarget(script, review());
    assert.throws(() => applyNarrationPatch(script, patchFor(script, text), target), /condition/);
    script.productionScript[0].narration = text;
    assert.throws(() => applyNarrationPatch(script, patchFor(script), selectNarrationRepairTarget(script, review())), /condition/);
  });
}

test('ordinary 화면/표면 are not conditional 면; unchanged quantities can be restyled', () => {
  const script = candidate(); script.productionScript[0].narration = '화면 속 표면 높이는 20미터입니다.';
  assert.equal(applyNarrationPatch(script, patchFor(script, '화면 속 표면의 높이는 20미터입니다.'), selectNarrationRepairTarget(script, review())).productionScript[0].narration, '화면 속 표면의 높이는 20미터입니다.');
});
