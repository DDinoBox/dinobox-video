import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function verifyUpstreamRepair({app,job,attemptRoot,scenario,dataRoot,before,result,providers}){
 const events=fs.readFileSync(path.join(attemptRoot,'native-boundary-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse),calls=events.filter(e=>e.type==='begin');
 const patches=calls.filter(e=>e.taskName.startsWith('script-narration-patch-'));
 assert.equal(patches.length,['upstream-repair-ambiguous','upstream-repair-approved'].includes(scenario)?0:1);
 assert.equal(calls.filter(e=>e.taskName.startsWith('shotlist-part-')).length,7);
 assert.equal(calls.filter(e=>e.taskName.startsWith('shotlist-revision-')).length,0);
 const completedRepair=['upstream-repair-happy','upstream-repair-repeated'].includes(scenario);
 const vox=calls.filter(e=>e.taskName==='vox');assert.equal(vox.length,completedRepair||scenario==='upstream-repair-cancel'?1:0);
 if(vox.length){assert.equal(vox[0].outputs.length,1);assert.equal(vox[0].outputs[0].index,2);}
 const scriptReviews=events.filter(e=>e.type==='upstream-script-review');
 assert.equal(scriptReviews.length,['upstream-repair-wrong-row','upstream-repair-number','upstream-repair-ambiguous','upstream-repair-approved'].includes(scenario)?0:2);
 const shots=events.filter(e=>e.type==='upstream-shotlist-review');assert.equal(shots.length,completedRepair?4:2);
 for(const [file,expected] of before.files.filter(([file])=>file.endsWith('.wav')))assert.equal(hash(file),expected);
 const segments=before.rows.find(([table])=>table==='tts_segments')[1];
 const after=app.db.prepare('SELECT * FROM tts_segments WHERE topic_id=? ORDER BY id').all(job.topicId);
 if(scenario==='upstream-repair-happy'){
  assert.equal(result.status,'succeeded');
  assert.deepEqual(after.filter(s=>s.segment_index!==2),segments.filter(s=>s.segment_index!==2));
  assert.equal(after.find(s=>s.segment_index===2).text,'첫 받침이 내려옵니다.');
  assert.equal(after.find(s=>s.segment_index===2).duration_sec,2);
  const timeline=app.db.prepare('SELECT * FROM shotlist_items WHERE topic_id=? ORDER BY sort_index').all(job.topicId);
  assert.equal(timeline[1].duration_sec,3.5);assert.equal(timeline[2].start_sec,7.5);
  assert.equal(timeline.at(-1).end_sec,27.5);
  const expected=structuredClone(shots[0].sequence);expected[1].narrationAnchor='첫 받침이 내려옵니다.';
  for(const reviewed of shots.slice(2))assert.deepEqual(reviewed.sequence,expected);
 }else{
  assert.notEqual(result.status,'succeeded');assert.deepEqual(after,segments);
  const artifacts=app.pipelineStore.artifacts(job.runId);await app.executeDurablePipelineJob(job,providers);assert.deepEqual(app.pipelineStore.artifacts(job.runId),artifacts);
 }
 assert.deepEqual(app.pipelineStore.jobs(job.runId).filter(j=>['script','tts'].includes(j.pipeline_stage)),before.jobs);
 fs.writeFileSync(path.join(dataRoot,'native-upstream-repair.json'),JSON.stringify({runId:job.runId,scenario,patchCalls:patches.length,voxCalls:vox.length,retainedWavs:6,originalWavsUnchanged:true,scriptReviewerCalls:scriptReviews.length,shotlistReviewerCalls:shots.length,run:app.pipelineStore.getRun(job.runId)},null,2));
}
