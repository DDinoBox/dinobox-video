import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { recordInfoUserInput } from '../../lib/pipeline-info-input.js';
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export async function verifyInfoClipReuse({ app, runId, topicId, root, dataRoot }) {
 const {db,pipelineStore,pipelineTopicStatus}=app;
 const artifacts=pipelineStore.artifacts(runId),run=pipelineStore.getRun(runId),jobs=pipelineStore.jobs(runId);
 assert.equal(artifacts.filter(a=>a.kind==='info'&&JSON.parse(a.metadata_json).infoClipBinding?.version===1).length,7);
 const baseline=artifacts.map(a=>({id:a.id,file:a.path,source:JSON.parse(a.metadata_json).sourcePath,fileHash:hash(a.path),sourceHash:hash(JSON.parse(a.metadata_json).sourcePath),manifest:path.join(path.dirname(a.path),'manifest.json'),manifestHash:hash(path.join(path.dirname(a.path),'manifest.json'))}));
 for(const artifact of artifacts) app.reviewAsset({topicId,clipIndex:Number(artifact.clip_key),assetType:artifact.kind,
  assetPath:path.relative(root,JSON.parse(artifact.metadata_json).sourcePath),status:'OK',contentHash:artifact.content_hash,note:'Synthetic fixture explicit approval only'});
 const reviews=db.prepare('SELECT * FROM asset_reviews WHERE topic_id=? ORDER BY id').all(topicId);
 const item=db.prepare('SELECT * FROM shotlist_items WHERE topic_id=? AND sort_index=2 ORDER BY id DESC LIMIT 1').get(topicId);
 const originalRevision=app.pipelineInputRevision(topicId,'info');
 let editState,bytesState;
 try {
  recordInfoUserInput(db,{itemId:item.id,topicId,prompt:'Synthetic clip2 user instruction: keep the original physical state.'});
  assert.notEqual(app.pipelineInputRevision(topicId,'info'),originalRevision,'generation lease remains whole-stage');
  editState=pipelineTopicStatus(topicId);
  assert.equal(editState.evidence.filter(e=>e.kind==='clean'&&e.freshness==='current'&&e.userApproval==='approved').length,7);
  assert.equal(editState.evidence.filter(e=>e.kind==='info'&&e.clipKey!=='2'&&e.userApproval==='approved').length,6);
  assert.deepEqual(editState.evidence.filter(e=>e.kind==='info'&&e.freshness==='stale').map(e=>e.clipKey),['2']);
  const target=artifacts.find(a=>a.kind==='info'&&a.clip_key==='2');
  assert.throws(()=>app.reviewAsset({topicId,clipIndex:2,assetType:'info',assetPath:path.relative(root,JSON.parse(target.metadata_json).sourcePath),status:'OK',contentHash:target.content_hash}),/stale|current|최신|검사|검수|승인/);
 } finally {db.prepare('UPDATE shotlist_items SET info_input_revision=?,info_input_json=? WHERE id=?').run(item.info_input_revision,item.info_input_json,item.id);}
 const clean=artifacts.find(a=>a.kind==='clean'&&a.clip_key==='2'), source=JSON.parse(clean.metadata_json).sourcePath,saved=fs.readFileSync(source);
 try{
  fs.appendFileSync(source,'synthetic bytes replacement, not an approved correction');
  bytesState=pipelineTopicStatus(topicId);
  assert.deepEqual(bytesState.evidence.filter(e=>e.kind==='info'&&e.freshness==='stale').map(e=>e.clipKey),['2']);
  assert.deepEqual(bytesState.evidence.filter(e=>e.kind==='clean'&&e.freshness==='stale').map(e=>e.clipKey),['2']);
 }finally{fs.writeFileSync(source,saved);}
 assert.deepEqual(pipelineStore.artifacts(runId),artifacts);assert.deepEqual(pipelineStore.jobs(runId),jobs);assert.deepEqual(pipelineStore.getRun(runId),run);
 assert.deepEqual(db.prepare('SELECT * FROM asset_reviews WHERE topic_id=? ORDER BY id').all(topicId),reviews);
 for(const b of baseline){assert.equal(hash(b.file),b.fileHash);assert.equal(hash(b.source),b.sourceHash);assert.equal(hash(b.manifest),b.manifestHash);}
 fs.writeFileSync(path.join(dataRoot,'native-info-clip-reuse.json'),JSON.stringify({runId,invocationsBefore:run.invocations_used,invocationsAfter:pipelineStore.getRun(runId).invocations_used,infoEdit:editState.evidence,unapprovedCleanReplacement:bytesState.evidence,allFilesAndManifestsRestored:true,automaticCorrectionImplemented:false},null,2));
}
