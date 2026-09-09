import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function verifyInfoRepair({app,job,attemptRoot,scenario,dataRoot,result,providers}) {
 const events=fs.readFileSync(path.join(attemptRoot,'native-boundary-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const calls=events.filter(e=>e.type==='begin'),patches=calls.filter(e=>e.taskName.startsWith('info-layout-patch-'));
 const optOut=['info-repair-review-only','info-repair-limit-zero'].includes(scenario);
 assert.equal(patches.length,optOut?0:1);
 const renders=events.filter(e=>e.type==='info-render');
 const clip=e=>Number(path.basename(e.outputPath).slice(0,2));
 const second=['info-repair-happy','info-repair-second-fail'].includes(scenario);
 assert.equal(renders.filter(e=>clip(e)===3).length,second?2:1);
 for(let i=1;i<=7;i++)if(i!==3)assert.ok(renders.filter(e=>clip(e)===i).length<=1,'Other INFO must never rerender');
 const target=renders.filter(e=>clip(e)===3);
 if(second){assert.deepEqual(target[1].spec,target[0].spec);assert.deepEqual(target[1].layout.guidePoints,target[0].layout.guidePoints);assert.equal(target[1].cleanHash,target[0].cleanHash);assert.notDeepEqual(target[1].layout.labelPositions,target[0].layout.labelPositions);}
 for(const role of ['evidence','production']) assert.equal(calls.filter(e=>new RegExp(`^info-visual-review-\\d+-3-\\d+-${role}$`).test(e.taskName)).length,second?2:1);
 const artifacts=app.pipelineStore.artifacts(job.runId);
 for(const artifact of artifacts.filter(a=>a.kind==='clean')){assert.equal(hash(artifact.path),artifact.content_hash);assert.equal(hash(JSON.parse(artifact.metadata_json).sourcePath),artifact.content_hash);}
 const run=app.pipelineStore.getRun(job.runId);
 if(scenario==='info-repair-happy'){assert.equal(result.status,'succeeded');assert.equal(run.invocations_used,35);assert.equal(renders.length,8);}
 else {assert.notEqual(result.status,'succeeded');const before=app.pipelineStore.artifacts(job.runId);await app.executeDurablePipelineJob(job,providers);assert.deepEqual(app.pipelineStore.artifacts(job.runId),before);assert.equal(app.pipelineStore.jobs(job.runId).filter(j=>j.pipeline_stage==='info').length,1);}
 const attempts=app.db.prepare('SELECT invocation_count FROM pipeline_attempts WHERE run_id=?').all(job.runId);
 assert.equal(run.invocations_used,attempts.reduce((sum,a)=>sum+a.invocation_count,0));
 fs.writeFileSync(path.join(dataRoot,'native-info-repair.json'),JSON.stringify({runId:job.runId,scenario,patchCalls:patches.length,renderCounts:Object.fromEntries([1,2,3,4,5,6,7].map(i=>[i,renders.filter(e=>clip(e)===i).length])),target,invocations:run.invocations_used,deadline:run.deadline_ms,primaryPublished:result.status==='succeeded'},null,2));
}
