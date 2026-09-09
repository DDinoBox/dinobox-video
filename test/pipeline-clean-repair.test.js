import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PipelineStore } from '../lib/pipeline-store.js';
import {buildPipelineInputSnapshot,hashPipelineInputSnapshot,hashPipelineCleanClipSnapshot,hashPipelineInfoClipSnapshot} from '../lib/pipeline-contract.js';

for(const batched of [false,true])test(`CLEAN repair preserves ${batched?'batch':'run'} budget, deadline, idempotency and one-shot limit`,()=>{
 const db=new DatabaseSync(':memory:'),store=new PipelineStore(db);
 try{
 const batch=batched?store.createBatch({requestKey:'batch',candidates:[{topicId:1,inputHash:'input',startContract:{}}],lane:'production_canary'}):null;
 const run=batch?store.startNextCandidate(batch.id):store.createRun({topicId:1,inputHash:'input',requestKey:'run',lane:'production_canary'});
 db.prepare("UPDATE pipeline_runs SET status='awaiting_user_review',invocations_used=10,attempts_used=12 WHERE id=?").run(run.id);
 if(batch)db.prepare("UPDATE pipeline_batches SET status='awaiting_user_review',invocations_used=10,attempts_used=12 WHERE id=?").run(batch.id);
 const request={clipKey:3,requestKey:'repair',beforeArtifactId:1,beforeHash:'old',contract:{panelCrop:[0.45,0,0.55,1]}};
 for(const [column,value] of [['invocations_used',60],['attempts_used',80],['deadline_ms',1]]){
  const table=batch?'pipeline_batches':'pipeline_runs',id=batch?.id||run.id,original=db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id=?`).get(id).value;
  db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(value,id);
  assert.throws(()=>store.requestCleanRepair(run.id,request),/budget_exhausted/);assert.equal(store.cleanRepairs(run.id).length,0);
  db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(original,id);
 }
 const before=store.getRun(run.id),accepted=store.requestCleanRepair(run.id,request);
 assert.equal(accepted.reused,false);assert.equal(store.requestCleanRepair(run.id,request).repair.id,accepted.repair.id);
 assert.throws(()=>store.requestCleanRepair(run.id,{...request,beforeHash:'different'}),/request_key_conflict/);
 const after=store.getRun(run.id);for(const key of ['deadline_ms','invocations_used','attempts_used','max_invocations','max_attempts'])assert.equal(after[key],before[key]);
 if(batch){assert.equal(store.getBatch(batch.id).status,'running');assert.equal(store.getBatch(batch.id).invocations_used,10);}
 db.prepare("UPDATE pipeline_runs SET status='awaiting_user_review' WHERE id=?").run(run.id);
 if(batch)db.prepare("UPDATE pipeline_batches SET status='awaiting_user_review' WHERE id=?").run(batch.id);
 assert.throws(()=>store.requestCleanRepair(run.id,{...request,requestKey:'again'}),/limit_reached/);
 }finally{db.close();}
});

for(const stage of ['clean','info'])test(`${stage} CLEAN repair isolates correction binding but not shared physical contracts`,()=>{
 const original={topicId:1,stage,shotlist:{id:1,items:[1,2].map(sortIndex=>({sortIndex,referencePolicy:'none',physicalState:'closed'}))},cleanHashes:['one','two']};
 const build=buildPipelineInputSnapshot,clip=stage==='clean'?hashPipelineCleanClipSnapshot:hashPipelineInfoClipSnapshot;
 const changed=structuredClone(original);changed.cleanCorrections={'2':{repairId:'repair',panelCrop:[0.4,0,0.6,1]}};
 assert.notEqual(hashPipelineInputSnapshot(build(original)),hashPipelineInputSnapshot(build(changed)));
 assert.equal(clip(build(original),'1'),clip(build(changed),'1'));assert.notEqual(clip(build(original),'2'),clip(build(changed),'2'));
 changed.shotlist.items[1].physicalState='open';assert.notEqual(clip(build(original),'1'),clip(build(changed),'1'));
 changed.shotlist.items[1].referencePolicy='previous_in_family';assert.equal(clip(build(changed),'1'),null);
});
