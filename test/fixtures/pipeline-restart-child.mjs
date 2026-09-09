import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {root,python,denied,launches} from './pipeline-native-boundary.mjs';
import {verifyPipelineRun} from '../../scripts/verify-pipeline-run.mjs';
const dataRoot=path.resolve(process.env.DINOBOX_DATA_DIR);
assert.ok(dataRoot.startsWith(path.join(root,'tmp')+path.sep));
assert.equal(process.env.DISABLE_BACKGROUND_WORKERS,'1');
assert.equal(process.env.DINOBOX_PIPELINE_PROVIDER_WORKER,'0');
const checkpoint=JSON.parse(fs.readFileSync(path.join(dataRoot,'restart-checkpoint.json'),'utf8'));
assert.notEqual(process.pid,checkpoint.processId);
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// SQLite returns null-prototype records; the process boundary stores JSON values.
const equalJson=(actual,expected,message)=>assert.deepEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(expected)),message);
const boundaryModule=fileURLToPath(new URL('./pipeline-native-boundary.mjs',import.meta.url));
const providers=Object.fromEntries(['script','tts','shotlist','clean','info'].map(stage=>[stage,{boundaryModule}]));
let app;
try{
 app=await import('../../server.js');
 const {pipelineStore,db}=app,{runId,topicId}=checkpoint;
 if(!app.server.listening)await once(app.server,'listening');
 equalJson(pipelineStore.getRun(runId),checkpoint.run,'Fresh import must not reset the run');
 equalJson(pipelineStore.artifacts(runId),checkpoint.artifacts);
 // Controlled recovery clock: expire only the stored lease, without sleeping or
 // changing the run deadline or any production clock.
 pipelineStore.recover(checkpoint.leaseExpiry+1);
 const oldAttempt=db.prepare('SELECT * FROM pipeline_attempts WHERE lease_token=?').get(checkpoint.job.leaseToken);
 let claimed=[];
 if(checkpoint.scenario==='restart-resume'){
  assert.equal(oldAttempt.status,'abandoned_before_provider');assert.equal(oldAttempt.invocation_count,0);
  for(let steps=0;;steps++){
   const job=app.claimNextAiJob();if(!job)break;assert.ok(steps<20);
   assert.equal(job.runId,runId);assert.ok(!checkpoint.completedJobs.some(row=>row.id===job.id));
   if(!claimed.length){assert.equal(job.id,checkpoint.job.id);assert.notEqual(job.leaseToken,checkpoint.job.leaseToken);}
   claimed.push(job.id);
   const result=await app.executeDurablePipelineJob(job,providers);assert.equal(result.status,'succeeded',JSON.stringify(result));
  }
  const run=pipelineStore.getRun(runId),jobs=pipelineStore.jobs(runId),artifacts=pipelineStore.artifacts(runId);
  assert.equal(run.status,'awaiting_user_review');assert.equal(run.invocations_used,32);
  assert.equal(run.attempts_used,23,'22 normal attempts + one abandoned pre-provider claim');
  assert.equal(jobs.filter(j=>j.pipeline_stage==='clean').length,7);assert.equal(jobs.filter(j=>j.pipeline_stage==='info').length,1);
  assert.equal(artifacts.length,14);assert.ok(jobs.every(j=>j.status==='completed'));
  const state=app.pipelineTopicStatus(topicId);
  assert.equal(state.evidence.filter(e=>e.kind==='clean'&&['1','2','3'].includes(e.clipKey)&&e.userApproval==='approved'&&e.freshness==='current').length,3);
  const shotlist=db.prepare('SELECT * FROM shotlists WHERE topic_id=? ORDER BY id DESC LIMIT 1').get(topicId);
  const items=db.prepare('SELECT * FROM shotlist_items WHERE shotlist_id=? ORDER BY sort_index').all(shotlist.id);
  const contract={version:1,runId,runInputHash:run.input_hash,stageInputHashes:Object.fromEntries(['clean','info'].map(kind=>[kind,app.pipelineInputRevision(topicId,kind)])),
   clips:items.map(item=>{const spec=JSON.parse(item.info_spec_json);return {key:String(item.sort_index),requiredOverlay:spec.requiresOverlay===true,infoSpec:spec,claimRefs:JSON.parse(item.claim_refs_json),layoutTrusted:true};})};
  const report=verifyPipelineRun({root,dbPath:process.env.DINOBOX_DB_PATH,contract,python});assert.equal(report.machinePassed,true,JSON.stringify(report));
  fs.writeFileSync(path.join(dataRoot,'restart-verification.json'),JSON.stringify(report,null,2));
 }else{
  const unknown=checkpoint.scenario==='restart-unknown';
  assert.equal(pipelineStore.getRun(runId).status,unknown?'blocked':'canceled');
  if(unknown){assert.equal(oldAttempt.status,'reconcile_required');assert.equal(oldAttempt.invocation_count,1);assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(checkpoint.job.id).status,'reconcile_required');}
  assert.equal(app.claimNextAiJob(),null);
  const late=await app.executeDurablePipelineJob(checkpoint.job,providers);assert.notEqual(late.status,'succeeded');
  assert.equal(app.claimNextAiJob(),null);assert.equal(pipelineStore.getRun(runId).invocations_used,checkpoint.run.invocations_used);
  equalJson(pipelineStore.artifacts(runId),checkpoint.artifacts);
  assert.equal(pipelineStore.jobs(runId).filter(j=>j.pipeline_stage==='info').length,0);
  assert.equal(launches.length,0,'Restarted held/canceled process must launch no provider or renderer');
 }
 const final=pipelineStore.getRun(runId);
 for(const key of ['id','deadline_ms','max_invocations','max_attempts','input_hash','batch_id'])assert.equal(final[key],checkpoint.run[key]);
 if(checkpoint.batch){const batch=pipelineStore.getBatch(checkpoint.batch.id);assert.equal(batch.deadline_ms,checkpoint.batch.deadline_ms);assert.equal(batch.invocations_used,pipelineStore.batchRuns(batch.id).reduce((sum,r)=>sum+r.invocations_used,0));}
 for(const before of checkpoint.completedJobs)equalJson(db.prepare('SELECT * FROM jobs WHERE id=?').get(before.id),before);
 for(const artifact of checkpoint.artifacts)equalJson(pipelineStore.artifacts(runId).find(a=>a.id===artifact.id),artifact);
 for(const review of checkpoint.reviews)equalJson(db.prepare('SELECT * FROM asset_reviews WHERE id=?').get(review.id),review);
 for(const file of checkpoint.files)assert.equal(hash(file.file),file.hash);
 const attempts=db.prepare('SELECT * FROM pipeline_attempts WHERE run_id=?').all(runId);
 assert.equal(final.attempts_used,attempts.length);assert.equal(final.invocations_used,attempts.reduce((sum,a)=>sum+a.invocation_count,0));
 assert.equal(pipelineStore.jobs(runId).filter(j=>['queued','running'].includes(j.status)).length,0);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_invocations WHERE job_id IN (SELECT id FROM jobs WHERE run_id=?) AND status IN ('running','queued')").get(runId).n,0);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_jobs').get().n,0);equalJson(denied,[]);
 const result={scenario:checkpoint.scenario,processA:checkpoint.processId,processB:process.pid,runId,status:final.status,artifacts:pipelineStore.artifacts(runId).length,
  invocationsBefore:checkpoint.run.invocations_used,invocationsAfter:final.invocations_used,attempts:final.attempts_used,claimed,completedArtifactsPreserved:3,approvalsPreserved:3,active:0,orphan:0,video:0};
 fs.writeFileSync(path.join(dataRoot,'restart-result.json'),JSON.stringify(result,null,2));console.log(`PIPELINE_RESTART_RESULT ${JSON.stringify(result)}`);
}finally{
 if(app?.server?.listening)await new Promise((resolve,reject)=>{app.server.close(error=>error?reject(error):resolve());app.server.closeIdleConnections?.();});
 app?.db.close();
}
