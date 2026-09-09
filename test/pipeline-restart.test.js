import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const boundary=new URL('./fixtures/pipeline-native-boundary.mjs',import.meta.url).href;
async function child(filename,env,directory){
 const processChild=spawn(process.execPath,[fileURLToPath(new URL(`./fixtures/${filename}`,import.meta.url))],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';processChild.stdout.on('data',chunk=>stdout+=chunk);processChild.stderr.on('data',chunk=>stderr+=chunk);
 const code=await new Promise((resolve,reject)=>{processChild.once('error',reject);processChild.once('close',resolve);});
 fs.writeFileSync(path.join(directory,`${filename}.log`),stdout+'\n'+stderr);
 assert.equal(code,0,`Restart child failed: ${directory}\n${stdout}\n${stderr}`);
 return stdout;
}
for(const scenario of ['restart-resume','restart-unknown','restart-canceled'])test(`real process ${scenario} retains run identity and completed artifacts`,{timeout:180000},async()=>{
 fs.mkdirSync(path.join(root,'tmp'),{recursive:true});const directory=fs.mkdtempSync(path.join(root,'tmp','pipeline-restart-'));
 const dataRoot=path.join(directory,'data'),python=path.join(root,'.venv','Scripts','python.exe');
 const env={...process.env,NODE_OPTIONS:`--import=${boundary}`,DINOBOX_NATIVE_TEST_SCENARIO:scenario,QUALITY_AUTO_REPAIR_LIMIT:'0',
  DINOBOX_ENABLE_DURABLE_PIPELINE:'1',DINOBOX_DATA_DIR:dataRoot,DINOBOX_DB_PATH:path.join(dataRoot,'test.db'),DINOBOX_PIPELINE_PROVIDER_WORKER:'0',DINOBOX_ISOLATED_MOCK_PROVIDER:'1',
  DISABLE_BACKGROUND_WORKERS:'1',DINOBOX_DISABLE_AUTOMATIC_REMEDIATION:'1',DINOBOX_AI_WORKER_TOPIC_ID:'0',DINOBOX_AI_WORKER_JOB_ID:'0',PORT:'0',
  PDF_PYTHON_BIN:python,TTS_PYTHON_BIN:python,PYTHONDONTWRITEBYTECODE:'1',TMP:directory,TEMP:directory,TMPDIR:directory};
 const first=await child('pipeline-native-server-child.mjs',env,directory);assert.match(first,/PIPELINE_RESTART_CHECKPOINT/);
 // A has closed normally before B is created; no in-process module cache reuse.
 const second=await child('pipeline-restart-child.mjs',env,directory);assert.match(second,/PIPELINE_RESTART_RESULT/);
 const result=JSON.parse(fs.readFileSync(path.join(dataRoot,'restart-result.json'),'utf8'));
 assert.notEqual(result.processA,result.processB);assert.equal(result.completedArtifactsPreserved,3);assert.equal(result.approvalsPreserved,3);
 assert.equal(result.active,0);assert.equal(result.orphan,0);assert.equal(result.video,0);
 assert.equal(result.status,scenario==='restart-resume'?'awaiting_user_review':scenario==='restart-unknown'?'blocked':'canceled');
 assert.equal(result.artifacts,scenario==='restart-resume'?14:3);
 if(scenario!=='restart-resume'){assert.equal(result.invocationsAfter,result.invocationsBefore);assert.equal(result.claimed.length,0);}
});
