import path from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// sha256 remains the downloaded source digest; cached output has its own identity.
export function createReferenceBinding({ sourcePath, cachedPath, sourceHash, mediaKind, referencePage = 0 }) {
  if (hash(sourcePath) !== sourceHash) throw Error('reference_source_hash_mismatch');
  return { version: 1, sourcePath, sourceHash, cachedPath, contentHash: hash(cachedPath),
    transform: mediaKind === 'pdf' ? 'pdftoppm-png-130dpi' : 'normalize-reference-image-v1',
    referencePage: Number(referencePage || 0) };
}

export function validateReferenceBinding(asset, workspaceRoot, dataRoot) {
  const binding = asset.verification?.contentBinding;
  if (binding?.version !== 1) throw Error('reference_legacy_unbound');
  const resolve = value => {
    if (typeof value !== 'string' || !value) throw Error('reference_binding_mismatch');
    const file = realpathSync(path.resolve(workspaceRoot, value));
    const relative = path.relative(realpathSync(dataRoot), file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('reference_path_outside_data');
    return file;
  };
  const source = resolve(binding.sourcePath);
  const cached = resolve(binding.cachedPath);
  if (cached !== resolve(asset.cachedPath) || binding.sourceHash !== asset.sha256
    || binding.referencePage !== Number(asset.verification?.referencePage || 0)
    || binding.transform !== (asset.verification?.mediaKind === 'pdf' ? 'pdftoppm-png-130dpi' : 'normalize-reference-image-v1')) throw Error('reference_binding_mismatch');
  if (hash(source) !== binding.sourceHash) throw Error('reference_source_hash_mismatch');
  if (hash(cached) !== binding.contentHash) throw Error('reference_content_hash_mismatch');
  return { sourcePath: source, cachedPath: cached, contentHash: binding.contentHash };
}

// Explicit read-only reconciliation proof. Never writes a binding to a database,
// and normal validation still rejects legacy assets until separately reconciled.
export async function proveLegacyReferenceBinding(asset, { workspaceRoot, dataRoot, tempRoot, python, pdftoppm, runProcess }) {
  const { mkdtempSync } = await import('node:fs');
  const temporary = realpathSync(tempRoot);
  const relativeTemp = path.relative(realpathSync(path.join(workspaceRoot, 'tmp')), temporary);
  if (relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw Error('reference_proof_temp_outside_tmp');
  const kind = asset.verification?.mediaKind;
  const page = Number(asset.verification?.referencePage || 0);
  const cached = path.resolve(workspaceRoot, asset.cachedPath);
  const suffix = kind === 'image' ? '.decoded.png' : kind === 'pdf' && Number.isInteger(page) && page > 0 ? `-page-${page}.png` : null;
  if (!suffix || !cached.endsWith(suffix)) throw Error('reference_legacy_unbound');
  const source = cached.slice(0, -suffix.length);
  for (const file of [source, cached]) {
    const relative = path.relative(realpathSync(dataRoot), realpathSync(file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('reference_path_outside_data');
  }
  if (hash(source) !== asset.sha256) throw Error('reference_source_hash_mismatch');
  const output = path.join(mkdtempSync(path.join(temporary, 'reference-proof-')), 'derived.png');
  if (kind === 'image') await runProcess(python, [path.join(workspaceRoot, 'scripts/normalize_reference_image.py'), source, output]);
  else await runProcess(pdftoppm, ['-f', String(page), '-l', String(page), '-singlefile', '-png', '-r', '130', source, output.slice(0, -4)]);
  if (hash(output) !== hash(cached)) throw Error('reference_legacy_derivation_mismatch');
  const binding = createReferenceBinding({ sourcePath: source, cachedPath: cached, sourceHash: asset.sha256, mediaKind: kind, referencePage: page });
  return { readOnly: true, databaseUpdated: false, binding, proofPath: output };
}
