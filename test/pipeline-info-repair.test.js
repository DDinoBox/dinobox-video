import test from 'node:test';
import assert from 'node:assert/strict';
import {infoRepairHash,selectInfoRepairTarget,applyInfoLayoutPatch} from '../lib/pipeline-info-repair.js';
const contract={clipIndex:3,cleanHash:'clean',claimRefs:['C03'],spec:{type:'before_after',requiresOverlay:true,labels:['before','after']},layout:{geometryMode:'axis_pair',guidePoints:[{x:0.5,y:0.7}],labelPositions:[{x:0.1,y:0.1},{x:0.6,y:0.2}]}};
const review={passed:false,action:'revise',issues:[{code:'unreadable',sceneIndexes:[3]}]};
test('INFO repair changes only one clip label placement and binds failure to exact input',()=>{
 const target=selectInfoRepairTarget(contract,review),patch={beforeHash:target.beforeHash,clipIndex:3,field:'labelPositions',newValue:[{x:0.1,y:0.15},{x:0.6,y:0.25}]};
 const result=applyInfoLayoutPatch(contract,patch,target);assert.deepEqual(result.guidePoints,contract.layout.guidePoints);assert.notDeepEqual(result.labelPositions,contract.layout.labelPositions);
 assert.equal(target.failureFingerprint,selectInfoRepairTarget(contract,review).failureFingerprint);
 assert.notEqual(target.failureFingerprint,selectInfoRepairTarget({...contract,cleanHash:'other'},review).failureFingerprint);
 for(const change of [{spec:{type:'none'}},{claimRefs:['other']},{field:'guidePoints'},{clipIndex:4},{beforeHash:'stale'},{newValue:contract.layout.labelPositions},{newValue:[{x:-1,y:0}]}])assert.throws(()=>applyInfoLayoutPatch(contract,{...patch,...change},target),/info_repair:/);
 assert.throws(()=>applyInfoLayoutPatch({...contract,spec:{...contract.spec,labels:['changed']}},patch,target),/stale_hash/);
 assert.equal(infoRepairHash(contract),target.beforeHash);
});
test('INFO ambiguous, upstream, multi-clip or none findings never gain local repair authority',()=>{
 for(const altered of [{...review,action:'drop'},{...review,issues:[{code:'claim_mismatch',sceneIndexes:[3]}]},{...review,issues:[{code:'unreadable',sceneIndexes:[3,4]}]},{...review,issues:[{code:'unreadable',sceneIndexes:[4]}]}])assert.equal(selectInfoRepairTarget(contract,altered),null);
 assert.equal(selectInfoRepairTarget({...contract,spec:{type:'none'}},review),null);
});
