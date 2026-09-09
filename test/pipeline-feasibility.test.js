import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validatePipelineFeasibility, validateBatchStartContract } from '../lib/pipeline-feasibility.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('tmp', 'batch-feasibility-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'reference.png');
  fs.writeFileSync(filename, 'synthetic local reference bytes');
  const reference = { id: 'R1', state: 'deployed', claimRefs: ['C1'], referenceType: 'official_photo', referenceSourceUrl: 'https://nasa.gov/source', referenceMediaUrl: 'https://nasa.gov/photo.png', referenceDescription: 'Visible deployed physical state' };
  return { workspaceRoot: root, dataRoot: root,
    startContract: { stage: 'script', candidatePolicy: 'ordered_existing_only', referenceFailurePolicy: 'next_candidate', requiredVisualStates: 1, minimumRequiredInfoOverlays: 1 },
    detail: { factCheck: { id: 1, status: 'PASS', claims: [{ id: 'C1', status: 'SUPPORTED' }], visualEvidence: [reference] },
      productionBrief: { factCheckId: 1, status: 'ready', quality: { passed: true }, visualStates: [{ stateId: 'S1', physicalState: 'deployed', evidenceRefs: ['R1'], evidenceBeats: [{ infoGraphic: { requiresOverlay: true, type: 'before_after', anchors: ['common axis'], comparisonRule: 'shared baseline' } }] }] } },
    assets: [{ referenceId: 'R1', verified: true, sourceUrl: reference.referenceSourceUrl, mediaUrl: reference.referenceMediaUrl, referenceType: reference.referenceType,
      contentType: 'image/png', sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), cachedPath: filename, licenseUrl: 'https://nasa.gov/license', licenseNote: 'fixture', verification: { mediaKind: 'image', contentBinding: { version: 1, sourcePath: filename, cachedPath: filename, sourceHash: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), contentHash: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), referencePage: 0, transform: 'normalize-reference-image-v1' } } }] };
}

test('feasibility binds supported claims, physical state, INFO contract and verified local hash', t => {
  assert.equal(validatePipelineFeasibility(fixture(t)).passed, true);
});
test('reference URLs alone never pass and missing local files advance only as needs_reference', t => {
  const input = fixture(t);
  input.assets = [];
  assert.equal(validatePipelineFeasibility(input).reason, 'needs_reference');
  const missing = fixture(t);
  fs.unlinkSync(missing.assets[0].cachedPath);
  assert.equal(validatePipelineFeasibility(missing).reason, 'needs_reference');
});
test('changed bytes, source binding and invalid crops fail before generation', t => {
  for (const mutate of [i => fs.writeFileSync(i.assets[0].cachedPath, 'changed'), i => { i.assets[0].sourceUrl += '/other'; }, i => { i.detail.factCheck.visualEvidence[0].panelCrop = [1, 0, 1, 1]; }]) {
    const input = fixture(t); mutate(input);
    assert.equal(validatePipelineFeasibility(input).reason, 'needs_reference');
  }
});
test('claim semantics and stale upstream state cannot be recategorized as reference failures', t => {
  const input = fixture(t);
  input.detail.factCheck.claims[0].status = 'UNSUPPORTED';
  assert.equal(validatePipelineFeasibility(input).reason, 'feasibility_contract_invalid');
  input.detail.factCheck.status = 'HOLD';
  assert.equal(validatePipelineFeasibility(input).reason, 'fact_evidence_not_current');
  input.detail.factCheck.status = 'PASS';
  input.detail.productionBrief.status = 'stale';
  assert.equal(validatePipelineFeasibility(input).reason, 'production_brief_not_current');
  for (const error of ['HTTP 401', 'provider_result_unknown', 'ECONNRESET']) {
    const failed = fixture(t);
    failed.assets[0].status = 'failed';
    failed.assets[0].verified = false;
    failed.assets[0].verification.error = error;
    assert.equal(validatePipelineFeasibility(failed).reason, 'reference_verification_failed');
  }
});
test('hidden elements, duplicate states and absent INFO anchors fail structural coverage', t => {
  for (const mutate of [i => { i.detail.productionBrief.visualStates[0].requiredVisibleElements = ['가려진 내부']; }, i => { i.detail.productionBrief.visualStates.push(i.detail.productionBrief.visualStates[0]); }, i => { i.detail.productionBrief.visualStates[0].evidenceBeats[0].infoGraphic.anchors = []; }]) {
    const input = fixture(t); mutate(input);
    assert.equal(validatePipelineFeasibility(input).reason, 'needs_reference');
  }
});
test('out-of-root verified paths are code/security errors, never candidate replacements', t => {
  const input = fixture(t);
  input.assets[0].cachedPath = path.resolve('package.json');
  assert.throws(() => validatePipelineFeasibility(input), /reference_path_outside_data/);
});
test('start contract requires explicit bounded state and replacement policy', () => {
  assert.throws(() => validateBatchStartContract({}), /invalid batch start contract/);
  assert.throws(() => validateBatchStartContract({ stage: 'script', candidatePolicy: 'ordered_existing_only', referenceFailurePolicy: 'next_candidate', requiredVisualStates: 7, minimumRequiredInfoOverlays: 8 }), /invalid batch start contract/);
});
