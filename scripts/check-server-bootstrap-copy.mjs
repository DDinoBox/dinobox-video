import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { once } from 'node:events';
const root=process.cwd();
const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const q=name=>'"'+name.replaceAll('"','""')+'"';
function snapshot(db){
 const tables={};
 for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
  const columns=db.prepare(`PRAGMA table_info(${q(name)})`).all().map(c=>c.name);
  tables[name]={columns,rows:db.prepare(`SELECT * FROM ${q(name)}`).all().map(r=>({...r})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};
 }
 return tables;
}
function compare(before,after){const changes=[];for(const [table,b] of Object.entries(before)){const a=after[table];const projected=a?.rows.map(r=>Object.fromEntries(b.columns.map(c=>[c,r[c]]))).sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));if(JSON.stringify(b.rows)!==JSON.stringify(projected))changes.push({table,beforeRows:b.rows.length,afterRows:a?.rows.length,beforeHash:digest(b.rows),afterHash:digest(projected),changedRows:b.rows.filter(r=>!projected?.some(p=>JSON.stringify(p)===JSON.stringify(r))).map(r=>r.id??r.version)});}return changes;}
if(process.argv[2]==='child'){
 const calls=[];
 for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=()=>{calls.push(name);throw Error('external process forbidden');};
 const connect=net.Socket.prototype.connect;
 net.Socket.prototype.connect=function(...args){const o=Array.isArray(args[0])?args[0][0]:args[0];const host=typeof o==='object'?o.host:typeof args[1]==='string'?args[1]:'localhost';if(!['localhost','127.0.0.1','::1'].includes(host||'localhost')||o?.path){calls.push('network');throw Error('external network forbidden');}return connect.apply(this,args);};
 syncBuiltinESMExports();
 const originalFetch=globalThis.fetch;let origin;
 globalThis.fetch=(url,options)=>{assert.equal(new URL(url).origin,origin);return originalFetch(url,{...options,redirect:'error'});};
 const {server}=await import('../server.js');if(!server.listening)await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`;
 const statuses=[];
 for(const id of [158,159]){const response=await fetch(`${origin}/api/pipeline/topics/${id}`);statuses.push({id,status:response.status,body:await response.json()});}
 assert.ok(statuses.every(s=>s.status===(process.env.DINOBOX_ENABLE_DURABLE_PIPELINE==='1'?200:503)));
 await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
 fs.writeFileSync(process.argv[3],JSON.stringify({calls,statuses},null,2));assert.deepEqual(calls,[]);process.exit(0);
}else{
 const directory=fs.mkdtempSync(path.join(root,'tmp','full-bootstrap-copy-')),data=path.join(directory,'data');fs.mkdirSync(data);
 const sourcePath=path.join(root,'data','shorts.db');
 const originalFileHash=digest(fs.readFileSync(sourcePath));
 const source=new DatabaseSync(sourcePath,{readOnly:true});const original=snapshot(source);
 const baseline=path.join(directory,'online-backup.db');await backup(source,baseline);source.close();
 const copyPath=path.join(data,'shorts.db');fs.copyFileSync(baseline,copyPath);
 const copy=new DatabaseSync(copyPath);const copied=snapshot(copy);assert.deepEqual(copied,original);
 // Copy only latest canary source/decoded references. No proof is persisted as verification.
 const mapped=[],seen=new Set();
 for(const a of copy.prepare('SELECT * FROM official_visual_assets WHERE topic_id IN (158,159) ORDER BY id DESC').all()){
  const key=`${a.topic_id}:${a.reference_id}`;if(seen.has(key))continue;seen.add(key);
  if(!a.cached_path)continue;
  const cached=path.resolve(root,a.cached_path),v=JSON.parse(a.verification_json||'{}');
  const sourceFile=v.contentBinding?.sourcePath?path.resolve(root,v.contentBinding.sourcePath):cached.endsWith('.decoded.png')?cached.slice(0,-12):null;
  for(const file of [sourceFile,cached].filter(Boolean)){
   if(!fs.existsSync(file))continue;const relative=path.relative(path.join(root,'data'),file);assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative));
   const target=path.join(data,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);assert.equal(digest(fs.readFileSync(file)),digest(fs.readFileSync(target)));mapped.push({source:file,target,hash:digest(fs.readFileSync(target))});
  }
 }
 // Exact prefix remapping in copied text only, including nested JSON paths.
 const rewrite=s=>s.replaceAll(path.join(root,'data').replaceAll('\\','\\\\'),data.replaceAll('\\','\\\\')).replaceAll(path.join(root,'data'),data).replaceAll('data/source-cache/',`${data.replaceAll('\\','/')}/source-cache/`);
 let remappedCells=0;
 for(const [table,{columns}] of Object.entries(copied)){
  const textColumns=copy.prepare(`PRAGMA table_info(${q(table)})`).all().filter(c=>/TEXT/i.test(c.type));
  for(const row of copy.prepare(`SELECT rowid AS __copy_rowid__,* FROM ${q(table)}`).all())for(const c of textColumns){const value=row[c.name];if(typeof value==='string'&&rewrite(value)!==value){copy.prepare(`UPDATE ${q(table)} SET ${q(c.name)}=? WHERE rowid=?`).run(rewrite(value),row.__copy_rowid__);remappedCells++;}}
 }
 const remapped=snapshot(copy);copy.close();
 const run=mode=>{const output=path.join(directory,`${mode}-${Date.now()}.json`);const p=childProcess.spawnSync(process.execPath,[path.join(root,'scripts/check-server-bootstrap-copy.mjs'),'child',output],{cwd:root,encoding:'utf8',timeout:120000,env:{...process.env,PORT:'0',DINOBOX_DATA_DIR:data,DINOBOX_DB_PATH:copyPath,DINOBOX_ENABLE_DURABLE_PIPELINE:mode==='disabled'?'':'1',DISABLE_BACKGROUND_WORKERS:'1',DINOBOX_DISABLE_AUTOMATIC_REMEDIATION:'1',DINOBOX_PIPELINE_PROVIDER_WORKER:'',TMP:directory,TEMP:directory,TMPDIR:directory}});fs.writeFileSync(`${output}.log`,p.stdout+p.stderr);if(p.status!==0)throw Error(`bootstrap ${mode}: ${p.stderr} ${p.error||''}`);return JSON.parse(fs.readFileSync(output));};
 const disabled=run('disabled');let check=new DatabaseSync(copyPath);const afterDisabled=snapshot(check);check.close();
 const enabled=run('enabled');check=new DatabaseSync(copyPath);const first=snapshot(check);check.close();
 // Cross a timestamp boundary: idempotence must not be an accidental same-second pass.
 await new Promise(resolve=>setTimeout(resolve,1100));
 const enabledAgain=run('enabled');check=new DatabaseSync(copyPath);const second=snapshot(check);assert.deepEqual(second,first);const integrity=check.prepare('PRAGMA integrity_check').all(),foreignKeys=check.prepare('PRAGMA foreign_key_check').all();check.close();
 const restore=path.join(directory,'restored.db');fs.copyFileSync(baseline,restore);const restored=new DatabaseSync(restore,{readOnly:true});assert.deepEqual(snapshot(restored),original);const restoredIntegrity=restored.prepare('PRAGMA integrity_check').all();restored.close();
 const live=new DatabaseSync(sourcePath,{readOnly:true});assert.deepEqual(snapshot(live),original);live.close();assert.equal(digest(fs.readFileSync(sourcePath)),originalFileHash);
 for(const item of mapped){assert.equal(digest(fs.readFileSync(item.source)),item.hash);assert.equal(digest(fs.readFileSync(item.target)),item.hash);}
 assert.deepEqual(compare(remapped,afterDisabled),[],'disabled bootstrap preserves all existing values');
 assert.deepEqual(compare(afterDisabled,first).map(c=>c.table),['schema_migrations']);
 assert.deepEqual(foreignKeys,[]);assert.ok(integrity.every(r=>r.integrity_check==='ok'));assert.ok(restoredIntegrity.every(r=>r.integrity_check==='ok'));
 const addedColumns=Object.fromEntries(Object.entries(first).filter(([t])=>original[t]).map(([t,a])=>[t,a.columns.filter(c=>!original[t].columns.includes(c))]).filter(([,columns])=>columns.length));
 const canaries=[158,159].map(id=>{const latest=table=>second[table].rows.filter(r=>r.topic_id===id).sort((a,b)=>b.id-a.id)[0];const all=second.official_visual_assets.rows.filter(r=>r.topic_id===id).sort((a,b)=>b.id-a.id), refs=[...new Map(all.map(a=>a.reference_id).map(key=>[key,all.find(a=>a.reference_id===key)] )).values()];return {topicId:id,factStatus:latest('fact_checks')?.status,briefStatus:latest('production_briefs')?.status,latestReferences:refs.length,versionedBindings:refs.filter(a=>JSON.parse(a.verification_json||'{}').contentBinding?.version===1).length,requiredBounds:refs.filter(a=>JSON.parse(a.verification_json||'{}').metadata?.requiredBounds).length,sourceHashesPreserved:true,providerReadiness:'not_probed',legacyReconciliation:'explicit_review_required'};});
 assert.equal(digest(fs.readFileSync(restore)),digest(fs.readFileSync(baseline)));
 const report={directory,originalFileHash,legacyTableCount:Object.keys(original).length,addedColumns,canaries,scope:'full server import on isolated online SQLite backup',originalUnchanged:true,referenceCopies:mapped,remappedCells,disabled,enabled,enabledAgain,disabledChanges:compare(remapped,afterDisabled),enabledChanges:compare(afterDisabled,first),newTables:Object.keys(first).filter(t=>!original[t]),idempotent:true,integrity,foreignKeys,restoredIntegrity,restoreMatchesOriginal:true};
 fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,disabledChanges:report.disabledChanges,enabledChanges:report.enabledChanges,newTables:report.newTables,idempotent:true,foreignKeys:foreignKeys.length,originalUnchanged:true},null,2));
}
