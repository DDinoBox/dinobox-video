import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export async function verifyCleanRepair({app,runId,topicId,root,dataRoot,api,providers}) {
 const {pipelineStore,db}=app;
 const before=pipelineStore.artifacts(runId),run=pipelineStore.getRun(runId);
 const files=before.map(a=>({a,source:JSON.parse(a.metadata_json).sourcePath,published:hash(a.path),manifest:path.join(path.dirname(a.path),'manifest.json'),manifestHash:hash(path.join(path.dirname(a.path),'manifest.json'))}));
 for(const a of before.filter(a=>a.clip_key!=='3')) app.reviewAsset({topicId,clipIndex:Number(a.clip_key),assetType:a.kind,assetPath:db.prepare('SELECT asset_path FROM asset_reviews WHERE topic_id=? AND clip_index=? AND asset_type=? ORDER BY id DESC LIMIT 1').get(topicId,Number(a.clip_key),a.kind).asset_path,status:'OK',contentHash:a.content_hash,note:'Synthetic explicit approval'});
 const target=before.find(a=>a.kind==='clean'&&a.clip_key==='3');
 const request={clipIndex:3,requestKey:'synthetic-clean-repair-3',beforeHash:target.content_hash,inputRevision:app.pipelineInputRevision(topicId,'clean'),panelCrop:[0.45,0,0.55,1]};
 const url=`/api/pipeline/runs/${runId}/clean-repairs`;
 const negatives=[{beforeHash:'0'.repeat(64)},{clipIndex:99},{panelCrop:[0,0,1,1]},{panelCrop:[0,0,0.2,1]},{panelCrop:[-0.1,0,1,1]},{physicalState:'changed'}];
 for(const change of negatives){const rejected=await api('POST',url,{...request,...change});assert.equal(rejected.status,409,JSON.stringify({change,rejected}));}
 const targetReview=db.prepare("SELECT * FROM asset_reviews WHERE topic_id=? AND clip_index=3 AND asset_type='clean'").get(topicId);
 db.prepare("UPDATE asset_reviews SET status='OK' WHERE id=?").run(targetReview.id);
 try{assert.equal((await api('POST',url,request)).status,409);}finally{db.prepare('UPDATE asset_reviews SET status=? WHERE id=?').run(targetReview.status,targetReview.id);}
 assert.equal(pipelineStore.cleanRepairs(runId).length,0);
 assert.equal(pipelineStore.getRun(runId).invocations_used,run.invocations_used);
 // Synthetic prior video records only: this harness never creates a video.
 for(let clip=1;clip<=7;clip++)db.prepare("INSERT INTO video_jobs(topic_id,clip_index,status,input_path,output_path) VALUES (?,?,'completed','synthetic-input','synthetic-output')").run(topicId,clip);
 const videos=db.prepare('SELECT * FROM video_jobs ORDER BY id').all();
 const accepted=await api('POST',url,request); assert.equal(accepted.status,202,JSON.stringify(accepted));
 const replay=await api('POST',url,request); assert.equal(replay.status,200,JSON.stringify(replay));
 const scenario=process.env.DINOBOX_NATIVE_TEST_SCENARIO;
 process.env.DINOBOX_NATIVE_CLEAN_REPAIR_PHASE='1';
 const stages=[];
 if(scenario!=='clean-repair-happy') {
  const job=app.claimNextAiJob(); assert.ok(job);
  const traceFile=path.join(dataRoot,'pipeline-staging',runId,String(job.id),job.leaseToken,'native-boundary-events.jsonl');
  let canceled=false;
  const timer=scenario==='clean-repair-cancel'?setInterval(()=>{
   if(!canceled&&fs.existsSync(traceFile)&&fs.readFileSync(traceFile,'utf8').includes('clean-repair-delayed')){canceled=true;pipelineStore.cancel(runId);}
  },10):null;
  let result; try{result=await app.executeDurablePipelineJob(job,providers);}finally{if(timer)clearInterval(timer);}
  assert.notEqual(result.status,'succeeded');
  assert.equal(pipelineStore.getRun(runId).status,scenario==='clean-repair-cancel'?'canceled':'blocked');
  assert.equal(app.claimNextAiJob(),null);assert.deepEqual(pipelineStore.artifacts(runId),before);
  for(const f of files){assert.equal(hash(f.source),f.a.content_hash);assert.equal(hash(f.a.path),f.published);assert.equal(hash(f.manifest),f.manifestHash);}
  const settled=pipelineStore.artifacts(runId);await app.executeDurablePipelineJob(job,providers);assert.deepEqual(pipelineStore.artifacts(runId),settled);
  assert.equal(pipelineStore.jobs(runId).filter(j=>j.pipeline_stage==='info').length,1);
  assert.equal(pipelineStore.cleanRepairs(runId).length,1);
  const evidence={runId,status:pipelineStore.getRun(runId).status,canceled,primaryUnchanged:true,noDownstream:true,invocationsBefore:run.invocations_used,invocationsAfter:pipelineStore.getRun(runId).invocations_used};
  fs.writeFileSync(path.join(dataRoot,'native-clean-repair.json'),JSON.stringify(evidence,null,2));return evidence;
 }
 for(let n=0;n<4;n++) {
  const job=app.claimNextAiJob(); assert.ok(job,JSON.stringify(pipelineStore.getRun(runId)));
  stages.push(pipelineStore.jobs(runId).find(row=>row.id===job.id).pipeline_stage);
  const result=await app.executeDurablePipelineJob(job,providers);
  assert.equal(result.status,'succeeded',JSON.stringify({result,run:pipelineStore.getRun(runId).terminal_reason}));
  if(n===0){const mid=app.pipelineTopicStatus(topicId);assert.deepEqual(mid.evidence.filter(e=>e.freshness==='stale').map(e=>`${e.kind}:${e.clipKey}`),['info:3']);}
 }
 assert.equal(app.claimNextAiJob(),null);
 const after=pipelineStore.getRun(runId),active=pipelineStore.activeArtifacts(runId),state=app.pipelineTopicStatus(topicId);
 assert.equal(after.status,'awaiting_user_review'); assert.equal(active.length,14); assert.equal(pipelineStore.artifacts(runId).length,16);
 assert.equal(after.deadline_ms,run.deadline_ms); assert.equal(after.max_invocations,run.max_invocations);
 assert.equal(state.evidence.filter(e=>e.clipKey!=='3'&&e.freshness==='current'&&e.userApproval==='approved').length,12,JSON.stringify(state));
 assert.equal(state.evidence.filter(e=>e.clipKey==='3'&&e.freshness==='current'&&e.userApproval!=='approved').length,2,JSON.stringify(state));
 for(const f of files){assert.equal(hash(f.a.path),f.published);assert.equal(hash(f.manifest),f.manifestHash);if(f.a.clip_key!=='3')assert.equal(hash(f.source),f.a.content_hash);}
 assert.notEqual(active.find(a=>a.kind==='clean'&&a.clip_key==='3').content_hash,target.content_hash);
 const afterVideos=db.prepare('SELECT * FROM video_jobs ORDER BY id').all();
 assert.equal(afterVideos.length,7);assert.equal(afterVideos.find(v=>v.clip_index===3).status,'stale');
 assert.deepEqual(afterVideos.filter(v=>v.clip_index!==3),videos.filter(v=>v.clip_index!==3));
 const contract=JSON.parse(fs.readFileSync(path.join(dataRoot,'native-run-contract.json'),'utf8'));
 contract.currentInputSnapshots=Object.fromEntries(['clean','info'].map(kind=>[kind,app.pipelineInputSnapshot(topicId,kind)]));
 contract.stageInputHashes=Object.fromEntries(['clean','info'].map(kind=>[kind,app.pipelineInputRevision(topicId,kind)]));
 const {verifyPipelineRun}=await import('../../scripts/verify-pipeline-run.mjs');
 const verified=verifyPipelineRun({root,dbPath:process.env.DINOBOX_DB_PATH,contract,python:process.env.PDF_PYTHON_BIN});
 assert.equal(verified.machinePassed,true,JSON.stringify(verified));
 fs.writeFileSync(path.join(dataRoot,'native-clean-repair-verification.json'),JSON.stringify(verified,null,2));
 const repaired=active.find(a=>a.kind==='clean'&&a.clip_key==='3');
 for(const mutate of [m=>m.supersedesArtifactId=before.find(a=>a.kind==='clean'&&a.clip_key==='2').id,m=>m.cleanClipBinding.clipKey='2']){
  const metadata=JSON.parse(repaired.metadata_json);mutate(metadata);
  try{db.prepare('UPDATE pipeline_artifacts SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata),repaired.id);
   assert.equal(verifyPipelineRun({root,dbPath:process.env.DINOBOX_DB_PATH,contract,python:process.env.PDF_PYTHON_BIN}).machinePassed,false);
  }finally{db.prepare('UPDATE pipeline_artifacts SET metadata_json=? WHERE id=?').run(repaired.metadata_json,repaired.id);}
 }
 assert.equal((await api('POST',url,{...request,requestKey:'second-repair',beforeHash:repaired.content_hash,inputRevision:app.pipelineInputRevision(topicId,'clean'),panelCrop:[0.5,0,0.5,1]})).status,409);
 const evidence={runId,invocationsBefore:run.invocations_used,invocationsAfter:after.invocations_used,active:active.length,history:16,stages,videoGenerated:0,targetVideoStale:true,evidence:state.evidence};
 fs.writeFileSync(path.join(dataRoot,'native-clean-repair.json'),JSON.stringify(evidence,null,2));
 return evidence;
}
