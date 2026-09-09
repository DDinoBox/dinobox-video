import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPipelineInputSnapshot, hashPipelineInputSnapshot, hashPipelineVisualSnapshot, hashPipelineInfoClipSnapshot } from '../lib/pipeline-contract.js';

const input = stage => ({ topicId: 1, stage, fact: { claims: [{ statement: 'supported', status: 'SUPPORTED' }] }, brief: { visualStates: [{ physicalState: 'closed', claimRefs: ['C1'] }] }, script: { id: 1, ttsText: 'same narration', notes: ['same note'], lengthPlan: { targetSec: 28 }, productionScript: [{ time: '0-4', narration: 'same narration', visualStateId: 'V1' }] }, tts: { id: 1, outputPath: 'master.wav', totalDurationSec: 4, segments: [{ id: 1, text: 'same narration', plannedTime: '0-4', durationSec: 4, audioPath: 's1.wav' }] }, shotlist: { id: 1, totalDurationSec: 4, items: [{ id: 1, startSec: 0, endSec: 4, durationSec: 4, cleanPrompt: 'same image', physicalState: 'closed', claimRefs: ['C1'], infoSpec: { requiresOverlay: true, type: 'arrow' } }] }, visualReferences: [{ sha256: 'source', crop: [0, 0, 1, 1] }], cleanHashes: ['clean-bytes'] });
const snapshot = value => buildPipelineInputSnapshot(value);
for (const stage of ['clean', 'info']) {
  test(`${stage} clock correction preserves visual identity but changes generation fence`, () => {
    const original = input(stage), timing = structuredClone(original);
    timing.script.productionScript[0].time = '0-3.5';
    timing.tts.outputPath = 'new-master.wav'; timing.tts.totalDurationSec = 3.5;
    Object.assign(timing.tts.segments[0], { durationSec: 3.5, plannedTime: '0-3.5', audioPath: 'new-s1.wav' });
    timing.shotlist.totalDurationSec = 3.5; Object.assign(timing.shotlist.items[0], { startSec: 0.1, endSec: 3.5, durationSec: 3.4 });
    assert.notEqual(hashPipelineInputSnapshot(snapshot(original)), hashPipelineInputSnapshot(snapshot(timing)));
    assert.equal(hashPipelineVisualSnapshot(snapshot(original)), hashPipelineVisualSnapshot(snapshot(timing)));
  });
  test(`${stage} preserves semantic and identity dependencies conservatively`, () => {
    const original = input(stage), expected = hashPipelineVisualSnapshot(snapshot(original));
    for (const mutate of [
      x => x.script.ttsText += ' changed', x => x.script.notes.push('different expression'),
      x => x.script.lengthPlan.targetSec++, x => x.tts.segments[0].text += ' changed',
      x => x.fact.claims[0].statement += ' different', x => x.shotlist.items[0].physicalState = 'open',
      x => x.shotlist.items[0].cleanPrompt += ' different', x => x.visualReferences[0].crop[0] = 0.1,
      x => x.visualReferences[0].sha256 = 'other bytes', x => x.shotlist.id++
    ]) { const changed = structuredClone(original); mutate(changed); assert.notEqual(hashPipelineVisualSnapshot(snapshot(changed)), expected); }
  });
}
test('INFO-owned user change never invalidates CLEAN visual identity', () => {
  const original = input('clean'), changed = structuredClone(original);
  changed.shotlist.items[0].infoInput = { revision: 1, userSpec: { type: 'arrow', requiresOverlay: true }, userPrompt: 'different label' };
  assert.equal(hashPipelineVisualSnapshot(snapshot(original)), hashPipelineVisualSnapshot(snapshot(changed)));
  original.stage = changed.stage = 'info';
  assert.notEqual(hashPipelineVisualSnapshot(snapshot(original)), hashPipelineVisualSnapshot(snapshot(changed)));
});
test('INFO clip bindings isolate only independent clean bytes and user input, not shared contracts', () => {
  const original = input('info');
  original.shotlist.items = [1,2].map(sortIndex => ({ ...original.shotlist.items[0], id: sortIndex, sortIndex, referencePolicy: 'none' }));
  original.cleanHashes = ['clean1','clean2'];
  const fingerprint = value => hashPipelineInfoClipSnapshot(snapshot(value), '1');
  const expected = fingerprint(original); assert.ok(expected);
  const other = structuredClone(original); other.cleanHashes[1] = 'replaced';
  other.shotlist.items[1].infoInput = {revision:1,userSpec:{requiresOverlay:true,type:'arrow'},userPrompt:'other clip only'};
  assert.equal(fingerprint(other), expected);
  other.cleanHashes[0] = 'replaced'; assert.notEqual(fingerprint(other),expected);
  for (const policy of ['previous_in_family','subject_identity',undefined]) {
    const dependent=structuredClone(original); dependent.shotlist.items[1].referencePolicy=policy;
    if(policy===undefined)delete dependent.shotlist.items[1].referencePolicy;
    assert.equal(fingerprint(dependent),null,'unknown/shared dependencies cannot opt into selective reuse');
  }
  for(const mutate of [x=>x.shotlist.items[1].cleanPrompt+=' changed',x=>x.fact.claims[0].statement+=' changed',x=>x.visualReferences[0].crop[0]=0.2]) {
    const changed=structuredClone(original);mutate(changed);assert.notEqual(fingerprint(changed),expected);
  }
});
test('partial durable CLEAN request cannot silently enqueue every clip or a new run', async () => {
  const {readFileSync}=await import('node:fs');
  const code=readFileSync('server.js','utf8'),start=code.indexOf('async function enqueueCleanImageGeneration('),end=code.indexOf('\n}\n',start);
  const fn=new Function('mapShotlistRow','getLatestShotlistByTopicStatement','getTopicStatement',`${code.slice(start,end+3)};return enqueueCleanImageGeneration;`)(value=>value,{get:()=>({status:'approved',items:[]})},{get:()=>({runLane:'production_canary'})});
  await assert.rejects(fn({topicId:1,autoConverge:true,clipIndexes:[2]}),/durable_local_clean_correction_requires_same_run_adapter/);
});
