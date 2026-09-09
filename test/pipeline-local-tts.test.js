import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { durableLocalTtsEnvironment } from '../lib/pipeline-local-tts.js';
const root=process.cwd(), temp=fs.mkdtempSync(path.join(root,'tmp','offline-tts-'));
const model=path.join(temp,'model');fs.mkdirSync(model);
for(const file of ['config.json','tokenizer.json','audiovae.safetensors','model.safetensors'])fs.writeFileSync(path.join(model,file),'synthetic metadata-only fixture');
const python=path.join(root,'.venv/Scripts/python.exe');
const env={DINOBOX_VOXCPM_MODEL_DIR:model,TTS_PYTHON_BIN:python};
test('durable local model metadata contract is offline, project-scoped and does not probe providers',()=>{
 assert.throws(()=>durableLocalTtsEnvironment({},root,temp),/voxcpm_local_model_missing/);
 assert.throws(()=>durableLocalTtsEnvironment({...env,DINOBOX_VOXCPM_MODEL_DIR:'https://huggingface.co/openbmb/VoxCPM2'},root,temp),/missing|outside_project/);
 const contract=durableLocalTtsEnvironment(env,root,temp);
 assert.equal(contract.python,python);assert.equal(contract.env.HF_HUB_OFFLINE,'1');assert.equal(contract.env.TRANSFORMERS_OFFLINE,'1');assert.ok(contract.env.HF_HOME.startsWith(temp));
 fs.renameSync(path.join(model,'model.safetensors'),path.join(model,'saved'));
 try{assert.throws(()=>durableLocalTtsEnvironment(env,root,temp),/voxcpm_model_file_missing/);}finally{fs.renameSync(path.join(model,'saved'),path.join(model,'model.safetensors'));}
});
test('Python local model call is offline before package imports; legacy contract stays unchanged',()=>{
 const contract=durableLocalTtsEnvironment(env,root,temp);
 const code=`import runpy,os,socket\nsocket.socket=lambda *a,**k: (_ for _ in ()).throw(AssertionError('network forbidden'))\nm=runpy.run_path('scripts/voxcpm_tts.py')\np,kw=m['model_load_contract']()\nassert p==os.environ['DINOBOX_VOXCPM_MODEL_DIR']\nassert kw['local_files_only'] is True and kw['load_denoiser'] is False\nassert os.environ['HF_HUB_OFFLINE']=='1'\nclass FakeVox:\n @staticmethod\n def from_pretrained(p,**kw):\n  assert os.path.isdir(p) and kw['local_files_only']\nFakeVox.from_pretrained(p,**kw)\nos.environ.pop('DINOBOX_PIPELINE_PROVIDER_WORKER')\nassert m['model_load_contract']()==('openbmb/VoxCPM2',{'load_denoiser':False})\n`;
 const p=spawnSync(python,['-c',code],{encoding:'utf8',env:{...process.env,...contract.env,DINOBOX_PIPELINE_PROVIDER_WORKER:'1',PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(p.status,0,p.stderr);
 const job=path.join(temp,'job.json');fs.writeFileSync(job,'{}');
 const missing=spawnSync(python,['scripts/voxcpm_tts.py',job],{encoding:'utf8',env:{...process.env,DINOBOX_PIPELINE_PROVIDER_WORKER:'1',DINOBOX_VOXCPM_MODEL_DIR:'',DINOBOX_VOXCPM_OFFLINE_CACHE:'',PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(missing.status,1);assert.match(missing.stdout,/provider_unavailable:voxcpm_local_model_or_cache_missing/);assert.doesNotMatch(missing.stdout,/런타임이 설치되지/);
});
test('actual isolated entry holds before script/native invocation when local model is absent',async()=>{
 const code=fs.readFileSync('server.js','utf8'),start=code.indexOf('async function runIsolatedProvider('),end=code.indexOf('\n}\n',start);
 const fn=new Function('PIPELINE_PROVIDER_WORKER','process','durableLocalTtsEnvironment','__dirname','DATA_DIR',`${code.slice(start,end+3)};return runIsolatedProvider;`)(true,{env:{}},durableLocalTtsEnvironment,root,temp);
 await assert.rejects(fn('script',{},{}),/provider_unavailable:voxcpm_local_model_missing/);
});
test('renderer default stays local in durable mode without changing Poppler inference or explicit paths',()=>{
 const code=fs.readFileSync('server.js','utf8');
 const declarations=['PDF_PYTHON_BIN','PDFTOPPM_BIN'].map(name=>code.split('\n').find(line=>line.startsWith(`const ${name} =`))).join('\n');
 const evaluate=(env,durable)=>new Function('process','DURABLE_PIPELINE_ENABLED','LOCAL_TTS_PYTHON','BUNDLED_PYTHON','path',`${declarations};return {PDF_PYTHON_BIN,PDFTOPPM_BIN};`)({env},durable,'local-python','legacy-python',path);
 assert.equal(evaluate({},true).PDF_PYTHON_BIN,'local-python');
 assert.equal(evaluate({},false).PDF_PYTHON_BIN,'legacy-python');
 assert.equal(evaluate({},true).PDFTOPPM_BIN,evaluate({},false).PDFTOPPM_BIN);
 assert.deepEqual(evaluate({PDF_PYTHON_BIN:'explicit-python',PDFTOPPM_BIN:'explicit-poppler'},true),{PDF_PYTHON_BIN:'explicit-python',PDFTOPPM_BIN:'explicit-poppler'});
});
