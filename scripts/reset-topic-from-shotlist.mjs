import { mkdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const topicId = Number(process.argv[2]);
if (!Number.isInteger(topicId) || topicId < 1) {
  throw new Error("Usage: node scripts/reset-topic-from-shotlist.mjs <topicId>");
}

const projectsRoot = path.join(root, "data", "projects");
const projectDir = path.resolve(projectsRoot, `topic-${topicId}`);
if (!projectDir.startsWith(`${path.resolve(projectsRoot)}${path.sep}`)) {
  throw new Error("Project path escaped the workspace projects directory.");
}

const db = new DatabaseSync(path.join(root, "data", "shorts.db"));
db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
try {
  const jobIds = db.prepare(`
    SELECT id FROM jobs
    WHERE topic_id = ? AND type IN ('shotlist_generate', 'clean_image_generate', 'info_image_generate')
  `).all(topicId).map((row) => Number(row.id));
  const shotlistIds = db.prepare("SELECT id FROM shotlists WHERE topic_id = ?").all(topicId).map((row) => Number(row.id));

  for (const jobId of jobIds) db.prepare("DELETE FROM job_events WHERE job_id = ?").run(jobId);
  db.prepare("DELETE FROM jobs WHERE topic_id = ? AND type IN ('shotlist_generate', 'clean_image_generate', 'info_image_generate')").run(topicId);
  db.prepare("DELETE FROM asset_reviews WHERE topic_id = ?").run(topicId);
  db.prepare("DELETE FROM video_jobs WHERE topic_id = ?").run(topicId);
  for (const shotlistId of shotlistIds) db.prepare("DELETE FROM shotlist_items WHERE shotlist_id = ?").run(shotlistId);
  db.prepare("DELETE FROM shotlists WHERE topic_id = ?").run(topicId);
  db.prepare(`
    UPDATE topics
    SET lifecycle_status = 'script', last_error = '', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(topicId);
  db.exec("COMMIT;");
} catch (error) {
  db.exec("ROLLBACK;");
  throw error;
} finally {
  db.close();
}

for (const folder of ["clean", "info", "video"]) {
  const target = path.resolve(projectDir, folder);
  if (!target.startsWith(`${projectDir}${path.sep}`)) throw new Error(`Unsafe target: ${target}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}

for (const file of [
  ["manifests", "IMAGE_SEQUENCE.md"],
  ["manifests", "CLEAN_ASSETS.md"],
  ["manifests", "CLEAN_CONTACT_SHEET.jpg"],
  ["manifests", "SHOTLIST_AI_CACHE.json"],
  ["prompts", "CLEAN_KEYFRAME_PROMPTS.md"],
  ["prompts", "INFOGRAPHIC_KEYFRAME_PROMPTS.md"],
  ["prompts", "VIDEO_GENERATION_PROMPTS.md"]
]) {
  const target = path.resolve(projectDir, ...file);
  if (!target.startsWith(`${projectDir}${path.sep}`)) throw new Error(`Unsafe target: ${target}`);
  await rm(target, { force: true });
}

process.stdout.write(JSON.stringify({ topicId, resetFrom: "shotlist", preserved: ["fact-check", "script", "tts"] }));
