import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = path.join(root, '.venv', 'Scripts', 'python.exe');
const renderer = path.join(root, 'scripts', 'render_official_photo_clean.py');
const directory = mkdtempSync(path.join(root, 'tmp', 'official-required-crop-'));
function run(args) {
  return spawnSync(python, args, { cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TMP: directory, TEMP: directory, TMPDIR: directory, PYTHONDONTWRITEBYTECODE: '1' } });
}
const source = path.join(directory, 'source.png');
const seeded = run(['-c', `from PIL import Image,ImageDraw\nim=Image.new('RGB',(1000,1000),(20,40,60))\nd=ImageDraw.Draw(im)\nd.rectangle((800,200,949,699),fill=(255,0,0))\nim.save(r'${source}')`]);
assert.equal(seeded.status, 0, seeded.stderr);

for (const [name, contract, error] of [
  ['missing explicit rectangle', { panelCrop: [0, 0, 1, 1] }, 'required_bounds_missing'],
  ['impossible wide rectangle', { panelCrop: [0, 0, 1, 1], requiredBounds: [0.1, 0.2, 0.8, 0.5] }, 'required_bounds_infeasible'],
  ['rectangle outside selected panel', { panelCrop: [0, 0, 0.5, 1], requiredBounds: [0.8, 0.2, 0.15, 0.5] }, 'outside_panel'],
  ['legacy focus is not implicit semantic bounds', { focusBounds: [0, 0, 1, 1] }, 'required_bounds_missing'],
  ['sequence cannot ignore per-panel focus', { panelSequence: [{ panelCrop: [0, 0, 0.5, 1], focusBounds: [0.8, 0.2, 0.1, 0.3] }, { panelCrop: [0, 0, 1, 1] }] }, 'outside_panel'],
  ['sequence cannot ignore per-panel required rectangle', { panelSequence: [{ panelCrop: [0, 0, 0.5, 1], requiredBounds: [0.8, 0.2, 0.1, 0.3] }, { panelCrop: [0, 0, 1, 1] }] }, 'outside_panel'],
  ['sequence rejects ambiguous global bounds', { requiredBounds: [0, 0, 1, 1], panelSequence: [{ panelCrop: [0, 0, 1, 1] }, { panelCrop: [0, 0, 1, 1] }] }, 'ambiguous']
]) {
  test(`official crop HOLD: ${name}`, () => {
    const output = path.join(directory, `${error}-${name.replaceAll(' ', '-')}.png`);
    const result = run([renderer, source, output, '--crop-json', JSON.stringify(contract)]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`HOLD official_crop_${error}`));
    assert.equal(existsSync(output), false);
  });
}

test('official cover shifts off-center and preserves the complete required red rectangle', () => {
  const output = path.join(directory, 'positive.png');
  const result = run([renderer, source, output, '--crop-json', JSON.stringify({ panelCrop: [0, 0, 1, 1], requiredBounds: [0.8, 0.2, 0.15, 0.5] })]);
  assert.equal(result.status, 0, result.stderr);
  const check = run(['-c', `from PIL import Image\nim=Image.open(r'${output}')\nassert im.size==(941,1672)\n# The full 150x500 source rectangle survives at scale 1.672, including its right edge.\np=im.load()\nxs=[x for x in range(im.width) if p[x,500][0]>240 and p[x,500][1]<10]\nys=[y for y in range(im.height) if p[800,y][0]>240 and p[800,y][1]<10]\nassert len(xs)>=248,len(xs)\nassert len(ys)>=832,len(ys)\nassert xs[-1]>=939,xs[-1]\nprint('complete rectangle preserved')`]);
  assert.equal(check.status, 0, check.stderr);
});

test('server binds preservation metadata to verified source bytes and input revision', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { buildPipelineInputSnapshot, hashPipelineInputSnapshot } = await import('../lib/pipeline-contract.js');
  const code = readFileSync(path.join(root, 'server.js'), 'utf8');
  const helper = code.slice(code.indexOf('function bindOfficialRequiredBounds('), code.indexOf('async function resolveOfficialPanelSequenceInputs('));
  const normalizeCode = code.slice(code.indexOf('function normalizeNormalizedBounds('));
  const normalize = new Function(`${normalizeCode.slice(0, normalizeCode.indexOf('\n}\n') + 3)}; return normalizeNormalizedBounds;`)();
  const bounds = [0.8, 0.2, 0.15, 0.5];
  const asset = { referenceId: 'ref', verified: true, sourceUrl: 'https://nasa.gov/source', mediaUrl: 'https://nasa.gov/media.png',
    referenceType: 'official_photo', cachedPath: source, sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    verification: { mediaKind: 'image', referencePage: 0, metadata: { requiredBounds: bounds } } };
  const { createReferenceBinding, validateReferenceBinding } = await import('../lib/pipeline-reference-binding.js');
  asset.verification.contentBinding = createReferenceBinding({ sourcePath: source, cachedPath: source, sourceHash: asset.sha256, mediaKind: 'image' });
  const evidence = { id: 'ref', referenceSourceUrl: asset.sourceUrl, referenceMediaUrl: asset.mediaUrl, referenceType: asset.referenceType, referencePage: 0 };
  let current = structuredClone(asset);
  const bind = new Function('getCanaryAssets', 'normalizeNormalizedBounds', 'validateReferenceBinding', '__dirname', 'DATA_DIR', `${helper}; return bindOfficialRequiredBounds;`)(() => [current], normalize, validateReferenceBinding, root, directory);
  assert.deepEqual(bind({ id: 1 }, evidence), { bounds, sourcePath: source, sha256: asset.sha256 });
  for (const change of [item => { item.verified = false; }, item => { item.sha256 = 'bad'; }, item => { item.mediaUrl += '?changed'; }, item => { item.verification.metadata.requiredBounds = [0, 0, 2, 1]; }]) {
    current = structuredClone(asset);
    change(current);
    assert.throws(() => bind({ id: 1 }, evidence), /HOLD official_crop_required_bounds_unbound|reference_binding_mismatch/);
  }
  current = structuredClone(asset);
  assert.throws(() => bind({ id: 1 }, evidence, [0, 0, 1, 1]), /untrusted preservation rectangle/);
  delete current.verification.metadata.requiredBounds;
  assert.equal(bind({ id: 1 }, evidence), null);
  assert.throws(() => bind({ id: 1 }, evidence, bounds), /untrusted preservation rectangle/);
  const revision = item => hashPipelineInputSnapshot(buildPipelineInputSnapshot({ topicId: 1, stage: 'clean', visualReferences: [item] }));
  assert.notEqual(revision(asset), revision(current), 'Preservation metadata participates in durable CLEAN input hash');
});

test('read-only preflight shares cover/panel geometry and never writes output, even on PASS', () => {
  const output = path.join(directory, 'must-not-exist', 'preflight.png');
  for (const [crop, passed, code] of [
    [{ panelCrop: [0, 0, 1, 1] }, false, 'official_crop_required_bounds_missing'],
    [{ panelCrop: [0, 0, 1, 1], requiredBounds: [0, 0, 1, 1] }, false, 'official_crop_required_bounds_infeasible'],
    [{ panelCrop: [0, 0, 1, 1], requiredBounds: [0.8, 0.2, 0.15, 0.5] }, true],
    [{ panelSequence: [{ panelCrop: [0, 0, 1, 1] }, { panelCrop: [0, 0, 1, 1] }] }, true],
    [{ panelSequence: [{ panelCrop: [0, 0, 0.5, 1], requiredBounds: [0.8, 0.2, 0.15, 0.5] }, { panelCrop: [0, 0, 1, 1] }] }, false, 'official_crop_outside_panel']
  ]) {
    const result = run([renderer, source, output, '--preflight', '--crop-json', JSON.stringify(crop)]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.geometryOnly, true);
    assert.equal(report.passed, passed);
    if (code) assert.equal(report.code, code);
    assert.equal(existsSync(path.dirname(output)), false);
  }
});

test('preflight process/decode/argument failures remain errors, never needs_reference', async () => {
  const { validateOfficialCropFeasibility } = await import('../lib/pipeline-feasibility.js');
  const execute = async (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(result.stderr);
    return result;
  };
  const checks = [{ stateId: 'S1', sourcePath: source, crop: { panelCrop: [0, 0, 1, 1] } }];
  const valid = { checks, python, renderer, runProcess: execute };
  assert.equal((await validateOfficialCropFeasibility(valid)).reason, 'needs_reference');
  await assert.rejects(validateOfficialCropFeasibility({ ...valid, python: path.join(directory, 'missing.exe') }), /ENOENT/);
  await assert.rejects(validateOfficialCropFeasibility({ ...valid, renderer: path.join(directory, 'missing.py') }), /can't open file/);
  await assert.rejects(validateOfficialCropFeasibility({ ...valid, checks: [{ ...checks[0], sourcePath: path.join(root, 'package.json') }] }), /UnidentifiedImageError/);
  await assert.rejects(validateOfficialCropFeasibility({ ...valid, checks: [{ ...checks[0], crop: { requiredBounds: [0, 0, 2, 1] } }] }), /normalized/);
  for (const stdout of ['not JSON', '{"passed":true}', '{"version":1,"geometryOnly":true,"passed":false,"code":"unexpected_bug"}']) {
    await assert.rejects(validateOfficialCropFeasibility({ ...valid, runProcess: async () => ({ stdout }) }));
  }
});
