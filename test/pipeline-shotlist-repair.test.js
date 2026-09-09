import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShotlistPatch, selectShotlistRepairTarget, shotlistRepairHash, shotlistRepairHoldReason, shotlistPatchSchema } from '../lib/pipeline-shotlist-repair.js';

const shotlist = () => ({ designSummary: 'fixed', continuityRules: ['fixed direction'], notes: [], scenes: Array.from({ length: 7 }, (_, index) => ({
  sourceSegmentIndex: index + 1, sourceSegmentOrder: 1, visualStateId: `VS${index}`, evidenceBeatId: `VS${index}_B1`,
  cameraMotion: '고정된 카메라의 미세한 push in', narrationAnchor: '승인된 원문', claimRefs: [`C${index}`], evidenceRefs: [`E${index}`],
  physicalState: 'connected supports', forceFlow: 'unchanged', requiredVisibleElements: ['membrane', 'support'],
  cleanContent: 'fixed content', transitionEndState: 'unchanged', motionPolicy: 'first_frame',
  infoGraphic: { type: index === 2 || index === 4 ? 'before_after' : 'none', requiresOverlay: index === 2 || index === 4, labels: ['fixed'] }
})) });
const issue = () => ({ code: 'weak_video_motion', severity: 'error', sceneIndexes: [2], message: 'Unrestrained camera expression', repairInstruction: 'Use restrained wording' });
const review = () => ({ passed: false, issues: [issue()], deterministicIssues: [] });
const newValue = '고정된 카메라의 느린 push in';
function setup() { const original = shotlist(), target = selectShotlistRepairTarget(original, review()); return { original, target, patch: { ...target, newValue } }; }

test('shotlist patch changes exactly one expression and preserves every other scene byte', () => {
  const { original, target, patch } = setup(), before = JSON.stringify(original);
  assert.equal(target.sceneIndex, 2);
  assert.equal(target.field, 'cameraMotion');
  const candidate = applyShotlistPatch(original, patch, target);
  const expected = shotlist(); expected.scenes[1].cameraMotion = newValue;
  assert.equal(JSON.stringify(candidate), JSON.stringify(expected));
  assert.equal(JSON.stringify(original), before);
  assert.notEqual(shotlistRepairHash(candidate), target.beforeHash);
  for (const index of [0, 2, 3, 4, 5, 6]) assert.equal(JSON.stringify(candidate.scenes[index]), JSON.stringify(original.scenes[index]));
  assert.equal(candidate.scenes.filter(scene => scene.infoGraphic.requiresOverlay).length, 2);
  assert.equal(shotlistPatchSchema.properties.field.const, 'cameraMotion');
});

test('shotlist selection accepts one consensus finding, never cherry-picks another clip or owner', () => {
  const base = shotlist();
  assert.ok(selectShotlistRepairTarget(base, { ...review(), issues: [issue(), issue()] }));
  for (const change of [
    { passed: true }, { issues: [] }, { deterministicIssues: ['direction'] },
    { issues: [{ ...issue(), severity: 'warning' }] },
    { issues: [{ ...issue(), sceneIndexes: [] }] }, { issues: [{ ...issue(), sceneIndexes: [2, 3] }] },
    { issues: [{ ...issue(), sceneIndexes: ['2'] }] }, { issues: [{ ...issue(), sceneIndexes: [8] }] },
    { issues: [issue(), { ...issue(), sceneIndexes: [3] }] },
    ...['unsupported_visual', 'repeated_visual_state', 'missing_causal_state', 'impossible_geometry', 'family_mismatch', 'info_overuse', 'insufficient_visual_depth'].map(code => ({ issues: [issue(), { ...issue(), code }] }))
  ]) assert.equal(selectShotlistRepairTarget(base, { ...review(), ...change }), null, JSON.stringify(change));
  assert.match(shotlistRepairHoldReason({ issues: [{ code: 'unsupported_visual' }] }, 'hold'), /owner=visual_evidence;reason=hold/u);
  assert.match(shotlistRepairHoldReason({ issues: [{ code: 'missing_causal_state' }] }, 'hold'), /owner=production_brief/u);
});

test('shotlist patch rejects stale hashes, wrong clips and non-expression keys without mutation', () => {
  const { original, target, patch } = setup(), before = JSON.stringify(original);
  for (const invalid of [
    { ...patch, sceneIndex: 3 }, { ...patch, sceneIndex: '2' }, { ...patch, beforeHash: '0'.repeat(64) },
    { ...patch, scenes: [] }, { ...patch, claimRefs: ['NEW'] }, { ...patch, requiresOverlay: false },
    ...['cleanPrompt', 'cleanContent', 'physicalState', 'forceFlow', 'scenePurpose', 'narrationAnchor', 'claimRefs', 'infoGraphic', 'sourceSegmentOrder', 'visualStateId', 'evidenceBeatId'].map(field => ({ ...patch, field })),
    { ...patch, newValue: '' }, { ...patch, newValue: original.scenes[1].cameraMotion }, { ...patch, newValue: 'x'.repeat(2001) }
  ]) assert.throws(() => applyShotlistPatch(original, invalid, target), /shotlist_repair:/u);
  assert.throws(() => applyShotlistPatch(original, patch, { ...target, sceneIndex: 3 }), /invalid_target/u);
  const changed = shotlist(); changed.scenes[6].claimRefs = ['changed'];
  assert.throws(() => applyShotlistPatch(changed, patch, target), /stale_hash/u);
  assert.equal(JSON.stringify(original), before);
});

test('shotlist expression guard conservatively rejects quantity, condition and direction changes', () => {
  const { original, target, patch } = setup();
  for (const value of [
    '5m push in', '카메라가 두 미터 이동', '왼쪽으로 느린 이동', '오른쪽으로 이동', '아래로 이동', '좌우 이동',
    'clockwise pan', 'pan left', 'rotate one degree', 'first move then settle', 'move before release',
    'move only if deployed', 'without support', '막이 펼쳐진 경우 이동', '막이 펼쳐지면 이동', '조건부 이동'
  ]) assert.throws(() => applyShotlistPatch(original, { ...patch, newValue: value }, target), /shotlist_repair:/u, value);
  original.scenes[1].cameraMotion = '왼쪽으로 느린 이동';
  const directional = selectShotlistRepairTarget(original, review());
  assert.throws(() => applyShotlistPatch(original, { ...directional, newValue }, directional), /direction_or_condition_unsupported/u);
});

test('upstream narration selection requires one exact source row and rejects physical or ambiguous owners', async()=>{
 const {selectUpstreamNarrationTarget}=await import('../lib/pipeline-upstream-repair.js');
 const sequence=shotlist(),script={productionScript:sequence.scenes.map(scene=>({narration:scene.narrationAnchor}))};
 const finding={passed:false,issues:[{code:'narration_expression',severity:'error',sceneIndexes:[2]}]};
 assert.equal(selectUpstreamNarrationTarget(script,sequence,finding).rowIndex,2);
 for(const code of ['unsupported_visual','info_overuse','missing_causal_state','impossible_geometry'])assert.equal(selectUpstreamNarrationTarget(script,sequence,{...finding,issues:[...finding.issues,{...finding.issues[0],code}]}),null);
 sequence.scenes[1].narrationAnchor='wrong row text';assert.equal(selectUpstreamNarrationTarget(script,sequence,finding),null);
});

test('upstream transition binds one narration/segment, retained waveforms and derived timing',async()=>{
 const {validateUpstreamNarrationTransition}=await import('../lib/pipeline-upstream-repair.js');
 const {hashPipelineInputSnapshot}=await import('../lib/pipeline-contract.js');
 const before={stage:'shotlist',schemaVersion:1,topicId:1,fact:{claims:['fixed']},brief:{requiredInfo:true},script:{productionScript:[{narration:'막이 펴졌습니다.'},{narration:'첫 받침이 내려왔습니다.'}],ttsText:'막이 펴졌습니다. 첫 받침이 내려왔습니다.'},tts:{segments:[{segmentIndex:1,text:'막이 펴졌습니다.',audioPath:'one.wav',durationSec:4,estimatedDurationSec:4},{segmentIndex:2,text:'첫 받침이 내려왔습니다.',audioPath:'two.wav',durationSec:4,estimatedDurationSec:4}],totalDurationSec:8.25,estimatedTotalDurationSec:8,outputPath:'master.wav'}};
 const after=structuredClone(before);after.script.productionScript[1].narration='첫 받침이 내려옵니다.';after.script.ttsText='막이 펴졌습니다. 첫 받침이 내려옵니다.';
 Object.assign(after.tts.segments[1],{text:'첫 받침이 내려옵니다.',audioPath:'new.wav',durationSec:2.5,estimatedDurationSec:3});Object.assign(after.tts,{totalDurationSec:6.75,estimatedTotalDurationSec:7,outputPath:'new-master.wav'});
 const transition={type:'shotlist_narration_repair',fromRevision:hashPipelineInputSnapshot(before),toSnapshot:after,rowIndex:2,narration:'첫 받침이 내려옵니다.',beforeAudio:{path:'two.wav'},afterAudio:{durationSec:2.5},masterAudio:{durationSec:6.75},retainedAudio:[{index:1}],failureFingerprint:'finding'};
 assert.equal(validateUpstreamNarrationTransition(before,transition),hashPipelineInputSnapshot(after));
 for(const mutate of [t=>t.rowIndex=1,t=>t.fromRevision='stale',t=>t.toSnapshot.fact.claims=['changed'],t=>t.toSnapshot.brief.requiredInfo=false,t=>t.toSnapshot.tts.segments[0].text='changed',t=>t.toSnapshot.tts.totalDurationSec=99,t=>t.retainedAudio=[],t=>t.narration='첫 받침이 5m 내려옵니다.']){const invalid=structuredClone(transition);mutate(invalid);assert.throws(()=>validateUpstreamNarrationTransition(before,invalid));}
});
