import path from 'node:path';
import { validateReferenceBinding } from './pipeline-reference-binding.js';
import { realpathSync, statSync } from 'node:fs';
import { validateEvidencePacket, validateProductionBriefEvidence, validateOfficialVisualPreflight, isHiddenVisualRequirement } from './quality-gates.js';

// Only deterministic, structural reference failures may advance an existing-candidate batch.
const REFERENCE_CODES = new Set(['needs_reference', 'unverified_visual_state', 'unverified_state_split', 'occluded_element_required',
  'official_reference_url_invalid', 'official_reference_source_untrusted', 'official_reference_license_missing',
  'official_reference_state_missing', 'official_reference_unverified', 'official_reference_media_type_invalid',
  'official_reference_crop_invalid', 'official_reference_duplicate_state', 'official_reference_duplicate_media',
  'official_reference_hidden_element_unverified', 'official_reference_insufficient_states', 'reference_file_missing',
  'reference_hash_mismatch', 'reference_binding_mismatch', 'visual_state_coverage_missing', 'info_reference_contract_missing']);

export function validateBatchStartContract(contract) {
  if (!contract || contract.stage !== 'script' || contract.candidatePolicy !== 'ordered_existing_only'
    || contract.referenceFailurePolicy !== 'next_candidate' || !Number.isSafeInteger(contract.requiredVisualStates)
    || contract.requiredVisualStates < 1 || !Number.isSafeInteger(contract.minimumRequiredInfoOverlays)
    || contract.minimumRequiredInfoOverlays < 0 || contract.minimumRequiredInfoOverlays > contract.requiredVisualStates) throw Error('invalid batch start contract');
  return contract;
}

export function validatePipelineFeasibility({ detail, assets, startContract, workspaceRoot, dataRoot, allowedHostSuffixes = [] }) {
  validateBatchStartContract(startContract);
  const { factCheck, productionBrief: brief } = detail;
  if (!factCheck || factCheck.status !== 'PASS') return { passed: false, reason: 'fact_evidence_not_current', issues: [] };
  if (!brief || brief.status !== 'ready' || brief.factCheckId !== factCheck.id || brief.quality?.passed !== true) return { passed: false, reason: 'production_brief_not_current', issues: [] };
  const usedReferenceIds = new Set((factCheck.visualEvidence || []).map(entry => entry.id));
  if (assets.some(asset => usedReferenceIds.has(asset.referenceId) && (asset.status === 'failed' || asset.verification?.error))) {
    // A stored download/auth/provider error is not proof of structural absence.
    return { passed: false, reason: 'reference_verification_failed', issues: [] };
  }
  const issues = [...validateEvidencePacket(factCheck).issues, ...validateProductionBriefEvidence(brief, factCheck)];
  const add = code => issues.push({ code });
  const states = brief.visualStates || [];
  if (states.length !== startContract.requiredVisualStates || new Set(states.map(state => state.stateId)).size !== states.length
    || new Set(states.map(state => String(state.physicalState || '').trim())).size !== states.length
    || states.some(state => !state.stateId || !state.physicalState)) add('visual_state_coverage_missing');
  let requiredInfo = 0;
  for (const state of states) {
    for (const beat of state.evidenceBeats || []) {
      const spec = beat.infoGraphic || {};
      if (!spec.requiresOverlay) continue;
      requiredInfo++;
      if (!spec.type || spec.type === 'none' || !(spec.anchors || []).length
        || (['before_after', 'comparison'].includes(spec.type) && !String(spec.comparisonRule || '').trim())
        || (['flow', 'load_path', 'sequence'].includes(spec.type) && !String(spec.directionRule || '').trim())) add('info_reference_contract_missing');
    }
  }
  if (requiredInfo < startContract.minimumRequiredInfoOverlays) add('info_reference_contract_missing');
  const evidence = factCheck.visualEvidence || [];
  const references = evidence.map(entry => {
    const asset = assets.find(item => item.referenceId === entry.id);
    const required = states.filter(state => (state.evidenceRefs || []).includes(entry.id));
    return { id: entry.id, stateHint: entry.state, referenceType: entry.referenceType,
      sourceUrl: entry.referenceSourceUrl, mediaUrl: entry.referenceMediaUrl, referencePage: entry.referencePage,
      panelCrop: entry.panelCrop, focusBounds: entry.focusBounds,
      licenseUrl: asset?.licenseUrl, licenseNote: asset?.licenseNote,
      requiresSection: required.some(state => [...(state.requiredVisibleElements || []), ...(state.evidenceBeats || []).flatMap(beat => beat.requiredVisibleElements || [])].some(isHiddenVisualRequirement)) };
  });
  for (const entry of evidence) {
    const asset = assets.find(item => item.referenceId === entry.id);
    if (!asset?.verified) { add('official_reference_unverified'); continue; }
    if (asset.sourceUrl !== entry.referenceSourceUrl || asset.mediaUrl !== entry.referenceMediaUrl
      || asset.referenceType !== entry.referenceType || Number(asset.verification?.referencePage || 0) !== Number(entry.referencePage || 0)
      || JSON.stringify(asset.verification?.panelCrop || asset.verification?.focusBounds || null) !== JSON.stringify(entry.panelCrop || entry.focusBounds || null)) add('reference_binding_mismatch');
    try {
      const file = realpathSync(path.resolve(workspaceRoot, asset.cachedPath));
      const relative = path.relative(realpathSync(dataRoot), file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('reference_path_outside_data');
      if (!statSync(file).isFile() || statSync(file).size <= 0) { add('reference_file_missing'); continue; }
      validateReferenceBinding(asset, workspaceRoot, dataRoot);
    } catch (error) {
      if (error.code === 'ENOENT') add('reference_file_missing');
      else if (['reference_source_hash_mismatch', 'reference_content_hash_mismatch'].includes(error.message)) add('reference_hash_mismatch');
      else throw error; // Permission, I/O and code failures are not candidate failures.
    }
  }
  issues.push(...validateOfficialVisualPreflight({ references, assets, requireDistinctStillStates: startContract.requiredVisualStates, allowedHostSuffixes }).issues);
  return { passed: issues.length === 0, reason: issues.length ? (issues.every(issue => REFERENCE_CODES.has(issue.code)) ? 'needs_reference' : 'feasibility_contract_invalid') : '', issues };
}

// Geometry is owned by the renderer, never reimplemented in JavaScript. A failed
// process or malformed response is a HOLD, not evidence against a candidate.
export async function validateOfficialCropFeasibility({ checks, python, renderer, runProcess }) {
  const issues = [], geometry = [];
  const structural = new Set(['official_crop_empty', 'official_crop_outside_panel',
    'official_crop_required_bounds_infeasible', 'official_crop_required_bounds_missing']);
  for (const check of checks) {
    const args = [renderer, check.sourcePath, '--preflight', '--crop-json', JSON.stringify(check.crop)];
    if (check.panelPaths?.length) args.push('--panel-sequence-inputs', ...check.panelPaths);
    const { stdout } = await runProcess(python, args, { timeoutMs: 120000, signal: AbortSignal.timeout(120000),
      env: { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
    const result = JSON.parse(stdout);
    if (result.version !== 1 || result.geometryOnly !== true || typeof result.passed !== 'boolean'
      || (!result.passed && !structural.has(result.code))
      || (result.passed && (!Array.isArray(result.boxes) || !Array.isArray(result.sourceSizes)))) throw Error('official_crop_preflight_response_invalid');
    geometry.push({ stateId: check.stateId, ...result });
    if (!result.passed) issues.push({ stateId: check.stateId, code: result.code });
  }
  return { passed: !issues.length, reason: issues.length ? 'needs_reference' : '', issues, geometryOnly: true, geometry };
}
