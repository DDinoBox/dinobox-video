import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { PipelineStore } from './pipeline-store.js';

function canonical(candidate) {
  if (existsSync(candidate)) return realpathSync(candidate);
  return path.join(canonical(path.dirname(candidate)), path.basename(candidate));
}
function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Production migration/execution is intentionally unavailable until the real
// adapters have attempt-scoped writes. Validate BEFORE opening the application DB.
export function validatePipelineBootstrap(env, projectRoot) {
  if (env.DINOBOX_ENABLE_DURABLE_PIPELINE !== '1') return false;
  const root = canonical(path.resolve(projectRoot, 'tmp'));
  if (!env.DINOBOX_DATA_DIR || !env.DINOBOX_DB_PATH || env.DISABLE_BACKGROUND_WORKERS !== '1'
    || env.DINOBOX_DISABLE_AUTOMATIC_REMEDIATION !== '1') throw Error('durable_pipeline_requires_isolated_opt_in');
  const data = canonical(path.resolve(env.DINOBOX_DATA_DIR));
  const db = canonical(path.resolve(env.DINOBOX_DB_PATH));
  const attemptDatabase = env.DINOBOX_PIPELINE_PROVIDER_WORKER === '1'
    && data.split(path.sep).includes('pipeline-staging')
    && db === path.join(path.dirname(data), 'provider.sqlite');
  if (!inside(root, data) || (!inside(data, db) && !attemptDatabase)) throw Error('durable_pipeline_requires_project_tmp');
  return true;
}

export function bootstrapPipelineStore(db, enabled) {
  if (!enabled) return null;
  const store = new PipelineStore(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name) VALUES (12,'durable_pipeline_runs')").run();
  return store;
}
