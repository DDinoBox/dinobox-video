import path from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';

// Metadata-only readiness check. Does not import torch, load weights, probe GPU or download.
export function durableLocalTtsEnvironment(env, workspaceRoot, dataRoot) {
  const root = realpathSync(workspaceRoot);
  const local = (value, label) => {
    if (!value) throw Error(`provider_unavailable:${label}_missing`);
    const lexical = path.relative(root, path.resolve(value));
    if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical)) throw Error(`provider_unavailable:${label}_outside_project`);
    if (!existsSync(value)) throw Error(`provider_unavailable:${label}_missing`);
    const resolved = realpathSync(value), relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error(`provider_unavailable:${label}_outside_project`);
    return resolved;
  };
  const model = local(env.DINOBOX_VOXCPM_MODEL_DIR, 'voxcpm_local_model');
  if (!statSync(model).isDirectory()) throw Error('provider_unavailable:voxcpm_local_model_not_directory');
  for (const names of [['config.json'], ['tokenizer.json', 'tokenizer.model'], ['audiovae.safetensors', 'audiovae.pth'], ['model.safetensors', 'pytorch_model.bin']]) {
    if (!names.some(name => existsSync(path.join(model, name)) && statSync(path.join(model, name)).isFile())) throw Error(`provider_unavailable:voxcpm_model_file_missing:${names.join('|')}`);
    for (const name of names.filter(name => existsSync(path.join(model, name)))) local(path.join(model, name), 'voxcpm_model_file');
  }
  const python = local(env.TTS_PYTHON_BIN || path.join(root, '.venv', 'Scripts', 'python.exe'), 'tts_python');
  const cache = path.join(dataRoot, 'provider-cache', 'huggingface');
  const relative = path.relative(root, path.resolve(cache));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('provider_unavailable:cache_outside_project');
  return { python, env: { DINOBOX_VOXCPM_MODEL_DIR: model, DINOBOX_VOXCPM_OFFLINE_CACHE: cache,
    HF_HOME: cache, HF_HUB_CACHE: path.join(cache, 'hub'), TRANSFORMERS_CACHE: path.join(cache, 'transformers'),
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' } };
}
