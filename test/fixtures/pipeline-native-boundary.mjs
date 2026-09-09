import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const python = path.join(root, '.venv', 'Scripts', 'python.exe');
export const denied = [];
export const launches = [];
const worker = path.join(root, 'lib', 'pipeline-provider-worker.mjs');
const deterministic = new Set(['render_official_photo_clean.py', 'render_info_overlay.py', 'media_qc.py', 'normalize_reference_image.py'].map(name => path.join(root, 'scripts', name)));
function allowed(command, args = [], options = {}) {
  if (options.shell) return false;
  if (path.resolve(command) === path.resolve(process.execPath)) return args.length === 2 && path.resolve(args[0]) === worker && path.resolve(args[1]).startsWith(path.join(root, 'tmp') + path.sep);
  if (process.env.DINOBOX_NATIVE_TEST_SCENARIO === 'batch-crop-tool' && command === process.env.PDF_PYTHON_BIN
    && path.resolve(command).startsWith(path.join(root, 'tmp') + path.sep) && !fs.existsSync(command)
    && path.basename(command) === 'missing-python.exe' && args.includes('--preflight')) return true;
  if (path.resolve(command) !== python) return false;
  if (deterministic.has(path.resolve(args[0] || ''))) return true;
  return args.length === 4 && args[0] === '-B' && args[1] === '-c'
    && args[2].includes('from media_qc import inspect_image,inspect_info') && path.resolve(args[3]) === path.join(root, 'scripts');
}
for (const name of ['spawn', 'spawnSync']) {
  const original = childProcess[name];
  childProcess[name] = (command, args = [], options = {}) => {
    if (!allowed(command, args, options)) {
      denied.push({ command, args });
      throw new Error(`NATIVE_TEST_PROCESS_DENIED:${command}:${args[0] || ''}`);
    }
    launches.push({ command, args });
    if (process.env.DINOBOX_NATIVE_TEST_SCENARIO?.startsWith('info-repair-') && path.basename(args[0] || '') === 'render_info_overlay.py') {
      const input = JSON.parse(fs.readFileSync(args[1], 'utf8'));
      trace({type:'info-render',outputPath:input.outputPath,cleanPath:input.cleanPath,cleanHash:createHash('sha256').update(fs.readFileSync(input.cleanPath)).digest('hex'),spec:input.spec,layout:input.layout});
    }
    return original(command, args, options);
  };
}
for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = () => { throw new Error(`NATIVE_TEST_PROCESS_DENIED:${name}`); };
net.Socket.prototype.connect = function () { throw new Error('NATIVE_TEST_NETWORK_DENIED'); };
globalThis.fetch = async () => { throw new Error('NATIVE_TEST_FETCH_DENIED'); };
syncBuiltinESMExports();

// Synthetic initial evidence, NOT downloaded official photography or a truth claim.
// The URLs/IDs bind to the existing canary contract; all local pixels are mocks.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'production-canaries', 'jwst-sunshield.json'), 'utf8'));
export const references = manifest.officialVisualReferences.filter(ref => ref.referenceType !== 'official_motion_reference').slice(0, 7);
export const externalKey = manifest.externalKey;
const narration = ['접힌 막은 어떻게 펼까요?', '첫 받침이 내려왔습니다.', '타워가 위로 솟습니다.', '덮개가 열려 있습니다.', '왼쪽 붐이 나왔습니다.', '오른쪽 붐이 뻗습니다.', '막이 넓게 펴졌습니다.'];
const labels = ['접힌 상태', '받침 전개', '타워 연장', '덮개 개방', '왼쪽 전개', '오른쪽 전개', '막 펼침'];
export const infoSpec = index => ({
  type: [3, 5].includes(index) ? 'before_after' : 'none', requiresOverlay: [3, 5].includes(index),
  labels: [3, 5].includes(index) ? [`이전 축 ${index}`, `이후 축 ${index}`] : [],
  anchors: [3, 5].includes(index) ? ['기존 중심선', '변경 중심선'] : [],
  directionRule: '방향 화살표를 사용하지 않는다.',
  comparisonRule: [3, 5].includes(index) ? '같은 기준점에서 이전 축과 이후 축의 간격을 비교한다.' : '', forbidden: []
});
export const states = references.map((ref, offset) => {
  const index = offset + 1;
  const stateId = `VS${String(index).padStart(2, '0')}_NATIVE_FIXTURE`;
  const requiredVisibleElements = [`${labels[offset]}의 막 표면`, '본체와 연결된 지지대'];
  const purpose = [3, 5].includes(index) ? `${labels[offset]}: 이전과 이후의 막 기울기 비교` : `${labels[offset]}의 서로 다른 물리 상태`;
  const physicalState = `${labels[offset]}의 막과 연결 지지대가 한 시점에 보인다.`;
  return {
    stateId, label: labels[offset], purpose, physicalState, changeFromPrevious: `${labels[offset]}에서 접촉 위치가 달라진다.`,
    requiredVisibleElements, forbiddenVisibleElements: [], claimRefs: [`C${String(index).padStart(2, '0')}`], evidenceRefs: [ref.id],
    panelCrop: [0, 0, 1, 1],
    evidenceBeats: [{ beatId: `${stateId}_B1`, label: labels[offset], purpose, physicalState,
      shotRole: index === 1 ? 'establishing' : index === 7 ? 'conclusion' : 'mechanism', visualFamily: 'exterior',
      requiredVisibleElements, forbiddenVisibleElements: [], cameraMotion: '고정된 카메라의 미세한 push in', motionPolicy: 'first_frame',
      transitionEndState: physicalState, claimRefs: [`C${String(index).padStart(2, '0')}`], evidenceRefs: [ref.id], infoGraphic: infoSpec(index) }]
  };
});
export const claims = states.map((state, index) => ({ id: state.claimRefs[0], statement: narration[index], claim: narration[index], status: 'SUPPORTED', useInVideo: true, sourceRefs: [references[index].sourceUrl], evidenceRefs: state.evidenceRefs }));

function jsonAfter(prompt, marker) {
  const start = prompt.indexOf(marker);
  assert.ok(start >= 0, `Prompt marker missing: ${marker}`);
  const rest = prompt.slice(start + marker.length).trimStart();
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < rest.length; index++) {
    const ch = rest[index];
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { if (--depth === 0) return JSON.parse(rest.slice(0, index + 1)); }
  }
  throw new Error(`Incomplete JSON after ${marker}`);
}
function schemaValue(schema = {}) {
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, schemaValue(value)]));
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return true;
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum || 1;
  return 'Synthetic native boundary fixture';
}
function scriptResponse() {
  return {
    narrativeType: 'process_breakdown', narrativeReason: '서로 다른 일곱 전개 상태를 설명한다.',
    causalContext: claims.map((claim, index) => ({ role: index === 6 ? 'result' : 'mechanism', statement: claim.statement, claimRefs: [claim.id] })),
    lengthPlan: { strategy: 'evidence_bound_native_clips', recommendedMinSec: 20, recommendedMaxSec: 28, compressionNotes: [] },
    signaturePlan: { problemLineUsed: false, pivotLineUsed: false, reason: '상태 설명' },
    coreQuestion: narration[0], coreConflict: '접힌 막과 펼쳐진 막', coreMechanism: '막의 전개', visibleFlow: '일곱 전개 상태', turningPoint: '막이 펼쳐짐',
    uniqueDifferentiator: '서로 다른 전개 상태', designIntervention: '막을 펼친다.', tradeoffs: [], limitations: [],
    productionScript: states.map((state, index) => ({ time: `${index * 4}~${(index + 1) * 4}초`, beat: state.label, importance: 'essential',
      visualStateId: state.stateId, narration: narration[index], visualDirection: state.physicalState, physicalState: state.physicalState,
      mechanismStep: state.purpose, stateChangeReason: state.changeFromPrevious, forceFlow: '연결된 본체에서 막 가장자리로 전달', claimRefs: state.claimRefs, infoGraphic: infoSpec(index + 1) })),
    ttsText: narration.join(' '), notes: ['Synthetic fixture claims and AI responses; not an independent truth/visual assessment.']
  };
}
const scenario = process.env.DINOBOX_NATIVE_TEST_SCENARIO || 'happy';
function trace(event) {
  const staged = path.resolve(process.env.DINOBOX_DATA_DIR);
  assert.ok(staged.includes(`${path.sep}pipeline-staging${path.sep}`));
  fs.appendFileSync(path.join(path.dirname(staged), 'native-boundary-events.jsonl'), JSON.stringify(event) + '\n');
}
export async function aiProvider(args) {
  trace({ type: 'begin', taskName: args.taskName });
  try {
    const result = await aiResponse(args);
    trace({ type: 'completed', taskName: args.taskName, passed: result.passed, score: result.score });
    return result;
  } catch (error) {
    trace({ type: 'error', taskName: args.taskName, message: error.message });
    throw error;
  }
}
async function aiResponse({ prompt, taskName, outputSchema, signal }) {
  signal?.throwIfAborted();
  assert.equal(process.env.DINOBOX_PIPELINE_PROVIDER_WORKER, '1');
  console.log(`NATIVE_AI_BOUNDARY ${taskName}`);
  if (taskName.startsWith('script-narration-patch-') || taskName.startsWith('tts-narration-patch-')) {
    assert.ok(scenario.startsWith('repair-') || scenario.startsWith('tts-repair-') || scenario.startsWith('upstream-repair-'));
    const target = jsonAfter(prompt, 'Patch target:');
    const script = jsonAfter(prompt, 'Current script:');
    const review = jsonAfter(prompt, 'Current review:');
    assert.deepEqual(Object.keys(target).sort(), ['beforeHash', 'field', 'rowIndex']);
    assert.equal(target.rowIndex, 2);
    assert.equal(target.field, 'narration');
    assert.match(target.beforeHash, /^[a-f0-9]{64}$/u);
    assert.equal(script.productionScript[1].narration, '첫 받침이 내려왔습니다.');
    if (taskName.startsWith('tts-narration-patch-')) {
      assert.equal(review.type, 'measured_tts_overrun');
      assert.equal(review.segmentIndex, 2);
      assert.ok(review.durationSec > 4);
      assert.equal(review.limitSec, 4);
    } else if (scenario.startsWith('upstream-repair-')) {
      assert.ok(review.issues.every(issue=>issue.code==='narration_expression'&&issue.sceneIndexes[0]===2));
    } else {
      assert.ok(review.issues.some(issue => issue.segmentIndex === 2 && issue.targetField === 'narration'));
    }
    assert.deepEqual(Object.keys(outputSchema.properties).sort(), ['beforeHash', 'field', 'newValue', 'rowIndex']);
    const patch = { ...target, field: 'narration', newValue: '첫 받침이 내려옵니다.' };
    if (scenario === 'repair-wrong-row' || scenario === 'tts-repair-wrong-row') patch.rowIndex = 3;
    if (scenario.startsWith('tts-repair-')) {
      assert.ok(patch.newValue.length < script.productionScript[1].narration.length);
      trace({ type: 'tts-patch-input', script, review });
    }
    if (scenario === 'upstream-repair-wrong-row') patch.rowIndex = 3;
    if (scenario === 'repair-number-change' || scenario === 'upstream-repair-number') patch.newValue = '첫 받침이 5m 내려옵니다.';
    if (scenario === 'repair-condition-change') patch.newValue = '막이 접힌 경우에만 첫 받침이 내려옵니다.';
    trace({ type: 'patch-response', taskName, patch });
    return patch;
  }
  if (taskName.startsWith('shotlist-expression-patch-')) {
    assert.ok(scenario.startsWith('shotlist-repair-'));
    const target = jsonAfter(prompt, 'Patch target:');
    const shotlist = jsonAfter(prompt, 'Current shotlist:');
    const review = jsonAfter(prompt, 'Current review:');
    assert.deepEqual(Object.keys(target).sort(), ['beforeHash', 'field', 'sceneIndex']);
    assert.match(target.beforeHash, /^[a-f0-9]{64}$/u);
    assert.equal(target.sceneIndex, 2);
    assert.equal(target.field, 'cameraMotion');
    assert.equal(shotlist.scenes.length, 7);
    assert.equal(shotlist.scenes[1].cameraMotion, '고정된 카메라의 미세한 push in');
    assert.ok(review.issues.some(issue => issue.code === 'weak_video_motion' && issue.severity === 'error' && issue.sceneIndexes.includes(2)));
    assert.deepEqual(Object.keys(outputSchema.properties).sort(), ['beforeHash', 'field', 'newValue', 'sceneIndex']);
    const patch = { ...target, newValue: '고정된 카메라의 느린 push in' };
    if (scenario === 'shotlist-repair-wrong-clip') patch.sceneIndex = 3;
    if (scenario === 'shotlist-repair-count-change') patch.scenes = shotlist.scenes.slice(0, 6);
    if (scenario === 'shotlist-repair-claim-change') { patch.field = 'claimRefs'; patch.newValue = ['C99']; }
    if (scenario === 'shotlist-repair-required-info-change') patch.infoGraphic = { type: 'none', requiresOverlay: false };
    trace({ type: 'shotlist-patch-input', taskName, target, shotlist, review });
    trace({ type: 'patch-response', taskName, patch });
    return patch;
  }
  if (/^script-\d+$|^script-revision-/u.test(taskName)) return scriptResponse();
  if (scenario === 'info-reject' && taskName.startsWith('info-revision-')) return { ...schemaValue(outputSchema), spec: jsonAfter(prompt, 'Current specification:') };
  if (taskName.startsWith('shotlist-part-')) {
    const rows = jsonAfter(prompt, '[이번 묶음의 승인 대본 행]');
    return { designSummary: 'Native generation with synthetic lowest-boundary responses', continuityRules: ['한 장면은 한 시점의 물리 상태'], notes: [],
      scenes: rows.map(row => {
        const state = states.find(state => state.stateId === row.visualStateId);
        assert.ok(state);
        const beat = state.evidenceBeats[0];
        return { sourceSegmentIndex: row.sourceSegmentIndex, sourceSegmentOrder: 1, visualStateId: state.stateId, evidenceBeatId: beat.beatId,
          narrationAnchor: row.narration, shotRole: beat.shotRole, visualFamily: beat.visualFamily, referencePolicy: 'none', motionPolicy: beat.motionPolicy,
          requiredVisibleElements: beat.requiredVisibleElements, forbiddenVisibleElements: [], transitionEndState: beat.transitionEndState,
          scenePurpose: beat.purpose, cleanContent: beat.physicalState, infoFocus: beat.infoGraphic.requiresOverlay ? beat.purpose : 'INFO 없음: 실제 물리 상태만 제시', cameraMotion: beat.cameraMotion, physicalState: beat.physicalState,
          stateChangeReason: state.changeFromPrevious, forceFlow: row.forceFlow, claimRefs: row.claimRefs, infoGraphic: beat.infoGraphic };
      }) };
  }
  if (taskName.startsWith('info-layout-patch-')) {
    const target = jsonAfter(prompt, 'Target:');
    const patch = { beforeHash: target.beforeHash, clipIndex: target.clipIndex, field: 'labelPositions', newValue: [{x:0.07,y:0.10},{x:0.60,y:0.20}] };
    if (scenario === 'info-repair-none') patch.spec = { type: 'none' };
    if (scenario === 'info-repair-geometry') patch.field = 'guidePoints';
    if (scenario === 'info-repair-claim') patch.claimRefs = ['UNSUPPORTED'];
    if (scenario === 'info-repair-cancel') { trace({type:'info-repair-delayed',taskName}); await new Promise(resolve=>setTimeout(resolve,1200)); }
    return patch;
  }
  if (taskName.startsWith('info-layout-')) {
    const scenes = jsonAfter(prompt, 'Scenes:');
    return { scenes: scenes.map(scene => ({ clipIndex: scene.clipIndex, geometryMode: 'axis_pair', guidePoints: [{ x: 0.50, y: 0.68 }, { x: 0.42, y: 0.24 }, { x: 0.48, y: 0.24 }],
      labelPositions: [{ x: 0.07, y: 0.14 }, { x: 0.56, y: 0.24 }], confidence: 0.98, note: 'Synthetic anchors for deterministic renderer integration only.' })) };
  }
  if (/script-review-|shotlist-review-|clean-visual-review-|info-visual-review-|production-brief-review-/u.test(taskName)) {
    for (const marker of ['Deterministic issues already found:', 'Deterministic issues:']) {
      if (prompt.includes(marker)) {
        const issues = jsonAfter(prompt, marker);
        if (issues.length) throw new Error(`NATIVE_FIXTURE_DETERMINISTIC_ISSUES:${taskName}:${JSON.stringify(issues)}`);
      }
    }
    const result = schemaValue(outputSchema);
    if ('passed' in result) result.passed = true;
    if ('score' in result) result.score = 0.99;
    if ('action' in result) result.action = 'pass';
    if ('issues' in result) result.issues = [];
    if ('repairInstruction' in result) result.repairInstruction = '';
    if (scenario.startsWith('info-repair-') && /^info-visual-review-\d+-3-/u.test(taskName)
      && (/-3-1-/u.test(taskName) || scenario === 'info-repair-second-fail')) {
      result.passed=false;result.score=0.2;result.action='revise';
      result.issues=[{code:'unreadable',message:'Synthetic single-clip label placement finding'}];
      result.repairInstruction='Move only label positions; preserve all facts and geometry.';
    }
    if (scenario === 'reviewer-drain' && taskName.startsWith('script-review-')) {
      if (taskName.endsWith('-evidence')) throw new Error('NATIVE_REVIEWER_EXPECTED_FAILURE');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (scenario.startsWith('repair-') && taskName.startsWith('script-review-')) {
      const script = jsonAfter(prompt, 'Script:');
      trace({ type: 'review-input', taskName, script });
      const patched = script.productionScript[1].narration === '첫 받침이 내려옵니다.';
      if (!patched || scenario === 'repair-second-review-fail') {
        result.passed = false;
        result.score = 0.2;
        result.issues = [{ code: 'repetition', severity: 'error', segmentIndex: patched ? 3 : 2, targetField: 'narration', message: 'Synthetic row-local narration repetition', repairInstruction: 'Preserve facts and change only narration phrasing' }];
      }
    }
    if (scenario.startsWith('tts-repair-') && taskName.startsWith('script-review-')) {
      const script = jsonAfter(prompt, 'Script:');
      trace({ type: 'tts-review-input', taskName, script });
      if (scenario === 'tts-repair-review-reject' && script.productionScript[1].narration === '첫 받침이 내려옵니다.') {
        result.passed = false;
        result.score = 0.2;
        result.issues = [{ code: 'repetition', severity: 'error', segmentIndex: 2, targetField: 'narration', message: 'Synthetic independent TTS narration rejection', repairInstruction: 'Hold this candidate' }];
      }
    }
    if (scenario.startsWith('shotlist-repair-') && taskName.startsWith('shotlist-review-')) {
      const sequence = jsonAfter(prompt, 'Complete shot sequence:');
      const topicScript = jsonAfter(prompt, 'Topic and approved script:');
      const supportedClaims = jsonAfter(prompt, 'Supported video claims:');
      const visualStateContract = jsonAfter(prompt, 'Approved visual-state contract:');
      trace({ type: 'shotlist-review-input', taskName, sequence, topicScript, supportedClaims, visualStateContract });
      const patched = sequence[1].cameraMotion === '고정된 카메라의 느린 push in';
      if (!patched || scenario === 'shotlist-repair-review-fail') {
        result.passed = false;
        result.score = 0.2;
        result.issues = [{ code: 'weak_video_motion', severity: 'error', sceneIndexes: [2], message: 'Synthetic local camera motion expression finding', repairInstruction: 'Change only scene2 cameraMotion expression' }];
        if (scenario === 'shotlist-repair-upstream-ambiguous') result.issues.push({ code: 'insufficient_visual_depth', severity: 'error', sceneIndexes: [2], message: 'Synthetic upstream evidence ambiguity', repairInstruction: 'Hold for upstream evidence review' });
      }
    }
    if (scenario.startsWith('upstream-repair-') && taskName.startsWith('shotlist-review-')) {
      const sequence=jsonAfter(prompt,'Complete shot sequence:');
      trace({type:'upstream-shotlist-review',taskName,sequence});
      if(sequence[1].narrationAnchor!=='첫 받침이 내려옵니다.' || scenario==='upstream-repair-repeated'){
        result.passed=false;result.score=0.2;
        result.issues=[{code:'narration_expression',severity:'error',sceneIndexes:[2],message:'Synthetic wording-only source narration finding',repairInstruction:'Preserve claims and physical contract; rephrase only script row2'}];
        if(scenario==='upstream-repair-ambiguous')result.issues.push({code:'unsupported_visual',severity:'error',sceneIndexes:[2],message:'Upstream evidence unclear',repairInstruction:'Hold'});
      }
    }
    if(scenario.startsWith('upstream-repair-')&&taskName.startsWith('script-review-')){
      const script=jsonAfter(prompt,'Script:');trace({type:'upstream-script-review',taskName,script});
      if(scenario==='upstream-repair-review-fail'&&script.productionScript[1].narration==='첫 받침이 내려옵니다.'){
        result.passed=false;result.score=0.2;result.issues=[{code:'repetition',severity:'error',segmentIndex:2,targetField:'narration',message:'Synthetic independent rejection',repairInstruction:'Hold'}];
      }
    }
    if (process.env.DINOBOX_NATIVE_CLEAN_REPAIR_PHASE === '1' && scenario === 'clean-repair-cancel' && taskName.startsWith('clean-visual-review-')) {
      trace({ type: 'clean-repair-delayed', taskName });
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    const rejectedPrefix = process.env.DINOBOX_NATIVE_CLEAN_REPAIR_PHASE === '1' && scenario === 'clean-repair-fail' ? 'clean-visual-review-' : { 'script-reject': 'script-review-', 'shotlist-reject': 'shotlist-review-', 'clean-reject': 'clean-visual-review-', 'info-reject': 'info-visual-review-' }[scenario];
    if (rejectedPrefix && taskName.startsWith(rejectedPrefix)) {
      result.passed = false;
      result.score = 0.2;
      if ('action' in result) result.action = 'revise';
      const issue = schemaValue(outputSchema.properties.issues.items);
      issue.message = 'Synthetic semantic rejection: unsupported visual evidence';
      if ('repairInstruction' in issue) issue.repairInstruction = 'Obtain supporting reference evidence';
      if ('severity' in issue) issue.severity = 'error';
      result.issues = [issue];
      if ('repairInstruction' in result) result.repairInstruction = 'Obtain supporting reference evidence';
    }
    return result;
  }
  throw new Error(`NATIVE_FIXTURE_UNSUPPORTED_AI_TASK:${taskName}`);
}
export async function voxProvider(job, context) {
  // Import only in TTS workers: its stricter subprocess guard is compatible there.
  const { default: vox } = await import('./pipeline-vox-mock.mjs');
  trace({ type: 'begin', taskName: 'vox', outputs: job.outputs });
  if ((scenario.startsWith('tts-repair-') || scenario.startsWith('upstream-repair-')) && job.outputs.length === 1) {
    assert.equal(job.outputs[0].index, 2);
    assert.equal(job.outputs[0].text, '첫 받침이 내려옵니다.');
    trace({ type: 'vox-retry-start', outputs: job.outputs });
    if (scenario === 'tts-repair-cancel' || scenario === 'upstream-repair-cancel') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(context.signal.reason); }, { once: true });
      });
      context.signal.throwIfAborted();
    }
    const { writeWav } = await import('./pipeline-stage-mock.mjs');
    const durationSec = scenario === 'tts-repair-second-overrun' ? 5 : scenario.startsWith('upstream-repair-') ? 2 : 2.5;
    writeWav(job.outputs[0].path, durationSec);
    const result = { outputs: [{ ...job.outputs[0], durationSec }] };
    if (job.outputMasterPath) {
      writeWav(job.outputMasterPath, durationSec);
      result.master = { path: job.outputMasterPath, durationSec };
    }
    trace({ type: 'completed', taskName: 'vox', durations: [durationSec], outputs: result.outputs });
    return result;
  }
  const result = await vox(job, context);
  if (scenario === 'tts-overrun' || scenario.startsWith('tts-repair-')) {
    const { writeWav } = await import('./pipeline-stage-mock.mjs');
    const overrun = scenario === 'tts-overrun' ? 0 : 1;
    writeWav(result.outputs[overrun].path, 5);
    result.outputs[overrun].durationSec = 5;
    writeWav(result.master.path, 29);
    result.master.durationSec = 29;
  }
  trace({ type: 'completed', taskName: 'vox', durations: result.outputs.map(output => output.durationSec), outputs: result.outputs.map(output => ({ ...output, sha256: createHash('sha256').update(fs.readFileSync(output.path)).digest('hex') })) });
  return result;
}
export function initialPng(seed) {
  // A portrait fixture preserves its entire source without an undeclared recrop.
  const width = /^(clean-crop-|clean-repair-)/u.test(scenario) ? 960 : 480, height = 853, rows = Buffer.alloc(height * (1 + width * 3));
  let random = seed + 1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const shade = random >>> 26;
    const triangle = y > 120 && y < 650 && Math.abs(x - 240) < (y - 100) / 4;
    const position = y * (1 + width * 3) + 1 + x * 3;
    rows.set(triangle ? [140 + shade, 155 + shade, 145 + shade] : [30 + seed * 7 + shade, 50 + shade, 65 + shade], position);
  }
  const crc32 = buffer => { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (name, bytes) => { const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes]))); return Buffer.concat([length, type, bytes, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
