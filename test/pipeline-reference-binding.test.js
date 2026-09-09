import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReferenceBinding, validateReferenceBinding } from '../lib/pipeline-reference-binding.js';
const root=process.cwd(), dir=fs.mkdtempSync(path.join(root,'tmp','reference-binding-'));
const python=path.join(root,'.venv/Scripts/python.exe');
const normalizer=path.join(root,'scripts/normalize_reference_image.py');
const poppler=path.join(root,'.venv/native/poppler/Library/bin/pdftoppm.exe');
const hash=b=>createHash('sha256').update(b).digest('hex');
const runProcess=async (bin,args)=>{const p=spawnSync(bin,args,{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});if(p.error)throw p.error;if(p.status)throw Error(p.stderr);return p;};
const source=path.join(dir,'source.jpg'), pdf=path.join(dir,'source.pdf');
await runProcess(python,['-c',`from PIL import Image\nim=Image.new('RGB',(100,180),(40,80,120))\nim.save(r'${source}')\nim.save(r'${pdf}','PDF')`]);
const code=fs.readFileSync('server.js','utf8');
const extract=name=>{const m=new RegExp(`^(?:async )?function ${name}\\(`,'m').exec(code);const s=code.slice(m.index);return s.slice(0,s.indexOf('\n}\n')+3);};
function providers(bytes,type){
 const dependencies={fetch:async()=>({ok:true,url:'https://www.nasa.gov/test',headers:{get:key=>key==='content-type'?type:null},arrayBuffer:async()=>bytes}),AbortSignal,Buffer,createHash,path,mkdir:fs.promises.mkdir,writeFile:fs.promises.writeFile,stat:fs.promises.stat,existsSync:fs.existsSync,runProcess: async (bin,args) => {
   if(bin!==poppler)return runProcess(bin,args);
   // No local Poppler installation: test PDF page/transform binding at its process boundary.
   assert.deepEqual(args.slice(0,8),['-f','1','-l','1','-singlefile','-png','-r','130']);
   return runProcess(python,[normalizer,source,`${args.at(-1)}.png`]);
  },
  PDF_PYTHON_BIN:python,PDFTOPPM_BIN:poppler,REFERENCE_IMAGE_RUNNER:normalizer,CANARY_ASSET_CACHE_DIR:path.join(dir,'canary'),SOURCE_CACHE_DIR:dir,
  toRelativeWorkspacePath:p=>path.relative(root,p),isOfficialCanaryUrl:()=>true,isHttpsUrl:()=>true,createReferenceBinding};
 return new Function(...Object.keys(dependencies),`${['detectOfficialMedia','verifyOfficialCanaryReference','preflightReplacementVisualReference'].map(extract).join('\n')}\nreturn {verifyOfficialCanaryReference,preflightReplacementVisualReference};`)(...Object.values(dependencies));
}
for(const kind of ['image','pdf'])test(`both download paths bind ${kind} raw source and actual normalized output without network`,async()=>{
 const bytes=fs.readFileSync(kind==='image'?source:pdf), p=providers(bytes,kind==='image'?'image/jpeg':'application/pdf'),page=kind==='pdf'?1:0;
 for(const asset of [await p.verifyOfficialCanaryReference({id:`test-${kind}`,mediaUrl:'https://www.nasa.gov/test',mediaKind:kind,referencePage:page}),await p.preflightReplacementVisualReference({referenceMediaUrl:'https://www.nasa.gov/test',referencePage:page})]){
  assert.equal(asset.verified,true,asset.error);assert.equal(asset.sha256,hash(bytes));
  const b=asset.verification.contentBinding;assert.notEqual(b.contentHash,b.sourceHash);assert.equal(b.referencePage,page);
  assert.equal(validateReferenceBinding(asset,root,dir).contentHash,b.contentHash);
  for(const [field,error] of [['sourcePath','reference_source_hash_mismatch'],['cachedPath','reference_content_hash_mismatch']]){
   const file=path.resolve(root,b[field]),saved=fs.readFileSync(file);try{fs.appendFileSync(file,'changed');assert.throws(()=>validateReferenceBinding(asset,root,dir),new RegExp(error));}finally{fs.writeFileSync(file,saved);}
  }
  const missing=structuredClone(asset);delete missing.verification.contentBinding;assert.throws(()=>validateReferenceBinding(missing,root,dir),/legacy_unbound/);
  if(kind==='image') {
   const { proveLegacyReferenceBinding }=await import('../lib/pipeline-reference-binding.js');
   const options={workspaceRoot:root,dataRoot:dir,tempRoot:dir,python,pdftoppm:poppler,runProcess};
   const proof=await proveLegacyReferenceBinding(missing,options);
   assert.equal(proof.databaseUpdated,false);assert.equal(proof.binding.contentHash,b.contentHash);
   assert.throws(()=>validateReferenceBinding(missing,root,dir),/legacy_unbound/,'proof never silently promotes legacy');
   const file=path.resolve(root,b.cachedPath),saved=fs.readFileSync(file);
   try{fs.appendFileSync(file,'changed');await assert.rejects(proveLegacyReferenceBinding(missing,options),/legacy_derivation_mismatch/);}finally{fs.writeFileSync(file,saved);}
  }
  const changed=structuredClone(asset);changed.verification.referencePage++;assert.throws(()=>validateReferenceBinding(changed,root,dir),/binding_mismatch/);
  const replacement=structuredClone(asset);replacement.cachedPath=source;assert.throws(()=>validateReferenceBinding(replacement,root,dir),/binding_mismatch/);
 }
});
