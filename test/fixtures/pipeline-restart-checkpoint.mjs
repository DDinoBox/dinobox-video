import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function saveRestartCheckpoint({app,job,scenario,root,dataRoot}){
 const {db,pipelineStore}=app,runId=job.runId;
 const raw=db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
 assert.equal(raw.pipeline_stage,'clean');assert.equal(raw.scope_key,'4');
 const artifacts=pipelineStore.artifacts(runId);assert.equal(artifacts.length,3);
 for(const artifact of artifacts){
  const review=db.prepare('SELECT asset_path FROM asset_reviews WHERE topic_id=? AND asset_type=? AND clip_index=?').get(job.topicId,artifact.kind,Number(artifact.clip_key));
  app.reviewAsset({topicId:job.topicId,clipIndex:Number(artifact.clip_key),assetType:artifact.kind,assetPath:review.asset_path,status:'OK',contentHash:artifact.content_hash,note:'Synthetic explicit approval before process restart'});
 }
 if(scenario==='restart-unknown'){pipelineStore.beginProvider(raw);pipelineStore.reserveInvocation(raw);}
 if(scenario==='restart-canceled')pipelineStore.cancel(runId);
 const run=pipelineStore.getRun(runId);
 const files=artifacts.flatMap(a=>[a.path,JSON.parse(a.metadata_json).sourcePath,`${JSON.parse(a.metadata_json).sourcePath}.qc.json`,path.join(path.dirname(a.path),'manifest.json')]).map(file=>({file,hash:hash(file)}));
 const checkpoint={scenario,processId:process.pid,runId,topicId:job.topicId,job,run,batch:run.batch_id?pipelineStore.getBatch(run.batch_id):null,
  artifacts:pipelineStore.artifacts(runId),completedJobs:pipelineStore.jobs(runId).filter(row=>row.status==='completed'),
  reviews:db.prepare('SELECT * FROM asset_reviews WHERE topic_id=? ORDER BY id').all(job.topicId),files,
  leaseExpiry:raw.lease_expires_ms,attempts:db.prepare('SELECT * FROM pipeline_attempts WHERE run_id=? ORDER BY id').all(runId)};
 fs.writeFileSync(path.join(dataRoot,'restart-checkpoint.json'),JSON.stringify(checkpoint,null,2));
 console.log(`PIPELINE_RESTART_CHECKPOINT ${JSON.stringify({runId,processId:process.pid,scenario,artifacts:3})}`);
}
