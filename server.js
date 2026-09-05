import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, readFile, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";
import { validateEvidencePacket, validateInfoLayoutContract, validateOfficialVisualPreflight, validateProductionBriefEvidence } from "./lib/quality-gates.js";
import { getNextPipelineJob } from "./lib/pipeline-convergence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5174);
const DATA_DIR = path.resolve(process.env.DINOBOX_DATA_DIR || path.join(__dirname, "data"));
const DB_PATH = process.env.DINOBOX_DB_PATH || path.join(DATA_DIR, "shorts.db");
const DISABLE_BACKGROUND_WORKERS = process.env.DISABLE_BACKGROUND_WORKERS === "1";
const DISABLE_AUTOMATIC_REMEDIATION = process.env.DINOBOX_DISABLE_AUTOMATIC_REMEDIATION === "1";
const AI_WORKER_TOPIC_ID = Math.max(0, Math.trunc(Number(process.env.DINOBOX_AI_WORKER_TOPIC_ID || 0)));
const AI_WORKER_JOB_ID = Math.max(0, Math.trunc(Number(process.env.DINOBOX_AI_WORKER_JOB_ID || 0)));
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const TTS_JOB_DIR = path.join(DATA_DIR, "tts-jobs");
const SOURCE_CACHE_DIR = path.join(DATA_DIR, "source-cache");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const MEDIA_JOB_DIR = path.join(DATA_DIR, "media-jobs");
const BENCHMARK_DIR = path.join(__dirname, "benchmarks");
const PRODUCTION_CANARY_DIR = path.join(__dirname, "production-canaries");
const CANARY_ASSET_CACHE_DIR = path.join(SOURCE_CACHE_DIR, "production-canaries");
const OFFICIAL_CANARY_HOST_SUFFIXES = Object.freeze(["nasa.gov", "usbr.gov"]);
const H3_WORKFLOW_PATH = path.join(__dirname, "workflows", "minimax_h3_i2v_api.json");
const H3_TURBO_LORA = "minimax_h3_fl2v_lightx2v_turbo_4step_v1.0_768p_resized_avg_rank_31_bf16.safetensors";
const H3_VIDEO_PROFILES = Object.freeze({
  quality: {
    id: "quality",
    label: "품질",
    description: "기본 H3 20스텝. 최종 후보와 품질 기준 생성에 사용.",
    steps: 20,
    megapixels: 0.86,
    loraName: "",
    loraStrength: 0,
    sageAttention: false,
    memoryEfficientAttention: false
  },
  balanced: {
    id: "balanced",
    label: "균형",
    description: "LightX2V Turbo LoRA 8스텝. 품질과 시간을 비교하는 기본 가속 후보.",
    steps: 8,
    megapixels: 0.86,
    loraName: H3_TURBO_LORA,
    loraStrength: 1,
    sageAttention: false,
    memoryEfficientAttention: true
  },
  fast: {
    id: "fast",
    label: "빠름",
    description: "LightX2V Turbo LoRA 4스텝. 초안과 움직임 확인용.",
    steps: 4,
    megapixels: 0.86,
    loraName: H3_TURBO_LORA,
    loraStrength: 1,
    sageAttention: false,
    memoryEfficientAttention: true
  }
});
const COMFYUI_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188";
const USAGE_GUARD_ENABLED = process.env.DINOBOX_USAGE_GUARD !== "0";
const AI_WORKER_CONCURRENCY = USAGE_GUARD_ENABLED
  ? 1
  : Math.max(1, Math.min(3, Number(process.env.AI_WORKER_CONCURRENCY || 2)));
const CODEX_MODEL_ATTEMPT_LIMIT = USAGE_GUARD_ENABLED ? 2 : 4;
const VIDEO_JOB_TIMEOUT_MS = Math.max(10, Number(process.env.VIDEO_JOB_TIMEOUT_MINUTES || 45)) * 60 * 1000;
const AI_JOB_TIMEOUT_MS = Object.freeze({
  topic_discovery: 5 * 60 * 1000,
  fact_check: Math.max(6, Number(process.env.FACT_CHECK_JOB_TIMEOUT_MINUTES || 10)) * 60 * 1000,
  production_brief_generate: 6 * 60 * 1000,
  script_generate: 12 * 60 * 1000,
  tts_generate: 40 * 60 * 1000,
  shotlist_generate: Math.max(12, Number(process.env.SHOTLIST_JOB_TIMEOUT_MINUTES || 20)) * 60 * 1000,
  clean_image_generate: Math.max(10, Number(process.env.CLEAN_IMAGE_JOB_TIMEOUT_MINUTES || 15)) * 60 * 1000,
  info_image_generate: 12 * 60 * 1000,
  quality_replay: 6 * 60 * 1000
});
function clampConfiguredNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function clampConfiguredInteger(value, fallback, minimum, maximum) {
  return Math.trunc(clampConfiguredNumber(value, fallback, minimum, maximum));
}

const FACT_CHECK_CODEX_TIMEOUT_MS = clampConfiguredNumber(process.env.FACT_CHECK_CODEX_TIMEOUT_MINUTES, 7, 4, 9) * 60 * 1000;
const PRODUCTION_CONTRACT_REVISION_JOB_TIMEOUT_MS = clampConfiguredNumber(process.env.PRODUCTION_CONTRACT_REVISION_JOB_TIMEOUT_MINUTES, 12, 8, 20) * 60 * 1000;
const PRODUCTION_CONTRACT_REVISION_CODEX_TIMEOUT_MS = clampConfiguredNumber(process.env.PRODUCTION_CONTRACT_REVISION_CODEX_TIMEOUT_MINUTES, 7, 5, 12) * 60 * 1000;
const PRODUCTION_CONTRACT_REVISION_MAX_ATTEMPTS = clampConfiguredInteger(process.env.PRODUCTION_CONTRACT_REVISION_MAX_ATTEMPTS, 2, 1, 2);
const QUALITY_REPAIR_WALL_MS = Math.max(2, Number(process.env.QUALITY_REPAIR_WALL_MINUTES || 4)) * 60 * 1000;
const QUALITY_AUTO_REPAIR_LIMIT = Math.max(0, Math.min(1, Number(process.env.QUALITY_AUTO_REPAIR_LIMIT || 0)));
const QUALITY_ENGINE_VERSION = "bounded-benchmark-v4";
const PRODUCTION_AI_JOB_TYPES = new Set([
  "script_generate",
  "tts_generate",
  "shotlist_generate",
  "clean_image_generate",
  "info_image_generate",
  "quality_replay"
]);
const TTS_EXAMPLE_TEXT = "조선의 봉수는 단순한 불빛이 아니었다. 밤에는 횃불, 낮에는 연기로 국경의 위기 정보를 한양까지 이어 보낸 국가 통신망이었다.";
const FONT_DIR = path.join(__dirname, "assets", "fonts");
const DEFAULT_CAPTION_PRESET = Object.freeze({
  id: "culture-heritage-care-bold",
  label: "문화재돌봄체 굵은체",
  fontFamily: "MunhwajaeDolbom Bold",
  fontPath: path.join(FONT_DIR, "culture-heritage-care", "문화재돌봄체 Bold.ttf"),
  fallbackFontFamily: "Malgun Gothic Bold",
  fontSize: 46,
  strokeWidth: 4,
  top: 0.76,
  left: 0.08,
  right: 0.92,
  maxCharsPerLine: 17,
  maxLines: 2
});
const INFO_FONT_PRESET = Object.freeze({
  id: "pretendard",
  label: "Pretendard",
  labelFontFamily: "Pretendard SemiBold",
  labelFontPath: path.join(FONT_DIR, "pretendard", "Pretendard-SemiBold.otf"),
  valueFontFamily: "Pretendard",
  valueFontWeight: "Bold",
  valueFontPath: path.join(FONT_DIR, "pretendard", "Pretendard-Bold.otf"),
  fallbackFontFamily: "Malgun Gothic",
  sourceVersion: "1.3.9"
});
const INFO_PLAN_VERSION = 3;
const PRODUCTION_BRIEF_CONTRACT_VERSION = 4;
const SCRIPT_CONTRACT_VERSION = 8;
const SHOTLIST_CONTRACT_VERSION = 7;
const NATIVE_CLIP_DURATION_SEC = 4;
const SCRIPT_STATE_TTS_BUDGET_SEC = 3.5;
const LOCAL_TTS_PYTHON = path.join(__dirname, ".venv", "Scripts", "python.exe");
const BUNDLED_PYTHON = "C:\\Users\\com\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
const PYTHON_BIN = process.env.TTS_PYTHON_BIN || (existsSync(LOCAL_TTS_PYTHON) ? LOCAL_TTS_PYTHON : BUNDLED_PYTHON);
const PDF_PYTHON_BIN = process.env.PDF_PYTHON_BIN || BUNDLED_PYTHON;
const VOXCPM_RUNNER = path.join(__dirname, "scripts", "voxcpm_tts.py");
const PDF_TEXT_RUNNER = path.join(__dirname, "scripts", "extract_pdf_text.py");
const REFERENCE_IMAGE_RUNNER = path.join(__dirname, "scripts", "normalize_reference_image.py");
const OFFICIAL_PHOTO_CLEAN_RUNNER = path.join(__dirname, "scripts", "render_official_photo_clean.py");
const PDFTOPPM_BIN = path.join(path.dirname(PDF_PYTHON_BIN), "..", "native", "poppler", "Library", "bin", "pdftoppm.exe");
const INFO_RENDERER = path.join(__dirname, "scripts", "render_info_overlay.py");
const MEDIA_QC_RUNNER = path.join(__dirname, "scripts", "media_qc.py");
const USER_CODEX_HOME = path.join(process.env.USERPROFILE || "C:\\Users\\com", ".codex");
const CODEX_HOME = process.env.CODEX_HOME || USER_CODEX_HOME;
const CODEX_BIN = process.platform === "win32"
  ? path.join(__dirname, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe")
  : path.join(__dirname, "node_modules", ".bin", "codex");
const FFMPEG_BIN = process.env.FFMPEG_BIN || findLocalExecutable(path.join(__dirname, "tools", "ffmpeg"), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg") || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_BIN || findLocalExecutable(path.join(__dirname, "tools", "ffmpeg"), process.platform === "win32" ? "ffprobe.exe" : "ffprobe") || "ffprobe";
const OPENSHOT_DIR = process.env.OPENSHOT_DIR || findExistingDirectory([
  path.join(__dirname, "tools", "openshot"),
  "C:\\Program Files\\OpenShot Video Editor",
  path.join(process.env.LOCALAPPDATA || "", "Programs", "OpenShot Video Editor")
]);
const OPENSHOT_BIN = OPENSHOT_DIR ? path.join(OPENSHOT_DIR, "openshot-qt.exe") : "";
const OPENSHOT_CLI_BIN = OPENSHOT_DIR ? path.join(OPENSHOT_DIR, "openshot-qt-cli.exe") : "";
const OPENSHOT_VERTICAL_PROFILE = OPENSHOT_DIR
  ? path.join(OPENSHOT_DIR, "profiles", "00720x1280p0024_09-16")
  : "";
const OPENSHOT_HOME = path.join(DATA_DIR, "openshot-home");
const COMFYUI_DIR = process.env.COMFYUI_DIR || findExistingDirectory([
  path.join(__dirname, "tools", "comfyui-h3"),
  path.join(__dirname, "ComfyUI"),
  "C:\\ComfyUI",
  "C:\\AI\\ComfyUI",
  path.join(process.env.USERPROFILE || "C:\\Users\\com", "ComfyUI")
]);

await mkdir(DATA_DIR, { recursive: true });
await mkdir(AUDIO_DIR, { recursive: true });
await mkdir(TTS_JOB_DIR, { recursive: true });
await mkdir(SOURCE_CACHE_DIR, { recursive: true });
await mkdir(PROJECTS_DIR, { recursive: true });
await mkdir(MEDIA_JOB_DIR, { recursive: true });
await mkdir(OPENSHOT_HOME, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    main_topic TEXT NOT NULL,
    subtopic TEXT NOT NULL,
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'hold',
    lifecycle_status TEXT NOT NULL DEFAULT 'candidate',
    verification_score INTEGER NOT NULL,
    visual_score INTEGER NOT NULL,
    novelty_score INTEGER NOT NULL,
    length_fit_score INTEGER NOT NULL,
    distortion_risk_score INTEGER NOT NULL,
    source_title TEXT NOT NULL,
    source_url TEXT NOT NULL UNIQUE,
    topic_format TEXT NOT NULL DEFAULT 'legacy',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS topic_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    main_topic TEXT NOT NULL,
    subtopic TEXT NOT NULL,
    requested_count INTEGER NOT NULL,
    returned_count INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS fact_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL,
    confidence INTEGER NOT NULL,
    core_claim TEXT NOT NULL,
    verified_facts_json TEXT NOT NULL,
    unresolved_json TEXT NOT NULL,
    simplifications_json TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    verdict_reason TEXT NOT NULL,
    next_action TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    enrichment_queries_json TEXT NOT NULL DEFAULT '[]',
    enrichment_sources_json TEXT NOT NULL DEFAULT '[]',
    raw_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );

  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft',
    core_question TEXT NOT NULL,
    core_conflict TEXT NOT NULL,
    visible_flow TEXT NOT NULL,
    turning_point TEXT NOT NULL,
    production_script_json TEXT NOT NULL,
    tts_text TEXT NOT NULL,
    notes_json TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );

  CREATE TABLE IF NOT EXISTS voice_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    engine TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'preset',
    language TEXT NOT NULL DEFAULT 'ko',
    style_instruction TEXT NOT NULL,
    speaker_key TEXT NOT NULL DEFAULT '',
    reference_audio_path TEXT NOT NULL DEFAULT '',
    sample_text TEXT NOT NULL DEFAULT '',
    sample_audio_path TEXT NOT NULL DEFAULT '',
    sample_duration_sec REAL,
    notes TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tts_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    script_id INTEGER NOT NULL,
    voice_preset_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared',
    engine TEXT NOT NULL,
    language TEXT NOT NULL,
    total_duration_sec REAL,
    estimated_total_duration_sec REAL NOT NULL DEFAULT 0,
    output_path TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id),
    FOREIGN KEY (script_id) REFERENCES scripts(id),
    FOREIGN KEY (voice_preset_id) REFERENCES voice_presets(id)
  );

  CREATE TABLE IF NOT EXISTS tts_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    topic_id INTEGER NOT NULL,
    script_id INTEGER NOT NULL,
    segment_index INTEGER NOT NULL,
    label TEXT NOT NULL,
    planned_time TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    audio_path TEXT NOT NULL DEFAULT '',
    duration_sec REAL,
    estimated_duration_sec REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'prepared',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (run_id) REFERENCES tts_runs(id),
    FOREIGN KEY (topic_id) REFERENCES topics(id),
    FOREIGN KEY (script_id) REFERENCES scripts(id)
  );

  CREATE TABLE IF NOT EXISTS shotlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    script_id INTEGER NOT NULL,
    tts_run_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    total_duration_sec REAL NOT NULL DEFAULT 0,
    clip_count INTEGER NOT NULL DEFAULT 0,
    manifest_path TEXT NOT NULL DEFAULT '',
    notes_json TEXT NOT NULL DEFAULT '[]',
    raw_json TEXT NOT NULL DEFAULT '{}',
    approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id),
    FOREIGN KEY (script_id) REFERENCES scripts(id),
    FOREIGN KEY (tts_run_id) REFERENCES tts_runs(id)
  );

  CREATE TABLE IF NOT EXISTS shotlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shotlist_id INTEGER NOT NULL,
    topic_id INTEGER NOT NULL,
    sort_index INTEGER NOT NULL,
    scene_id TEXT NOT NULL,
    keyframe_id TEXT NOT NULL,
    clip_id TEXT NOT NULL,
    source_segment_index INTEGER NOT NULL,
    start_sec REAL NOT NULL,
    end_sec REAL NOT NULL,
    duration_sec REAL NOT NULL,
    script_excerpt TEXT NOT NULL,
    scene_purpose TEXT NOT NULL,
    clean_content TEXT NOT NULL,
    info_focus TEXT NOT NULL,
    camera_motion TEXT NOT NULL,
    file_stub TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (shotlist_id) REFERENCES shotlists(id),
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );

  CREATE TABLE IF NOT EXISTS video_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    clip_index INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    prompt_id TEXT NOT NULL DEFAULT '',
    input_path TEXT NOT NULL,
    output_path TEXT NOT NULL,
    requested_duration_sec REAL NOT NULL DEFAULT 4,
    actual_duration_sec REAL,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    topic_id INTEGER,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '작업 대기 중',
    payload_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT NOT NULL DEFAULT '',
    lease_until TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );

  CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    topic_id INTEGER,
    level TEXT NOT NULL DEFAULT 'info',
    event_type TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );

  CREATE INDEX IF NOT EXISTS idx_topics_scope ON topics(main_topic, subtopic);
  CREATE INDEX IF NOT EXISTS idx_topics_lifecycle ON topics(lifecycle_status);
  CREATE INDEX IF NOT EXISTS idx_fact_checks_topic ON fact_checks(topic_id);
  CREATE INDEX IF NOT EXISTS idx_scripts_topic ON scripts(topic_id);
  CREATE INDEX IF NOT EXISTS idx_tts_runs_topic ON tts_runs(topic_id);
  CREATE INDEX IF NOT EXISTS idx_tts_segments_run ON tts_segments(run_id);
  CREATE INDEX IF NOT EXISTS idx_shotlists_topic ON shotlists(topic_id);
  CREATE INDEX IF NOT EXISTS idx_shotlist_items_shotlist ON shotlist_items(shotlist_id);
  CREATE INDEX IF NOT EXISTS idx_video_jobs_topic ON video_jobs(topic_id, clip_index, id DESC);
  CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status, id);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id);
  CREATE INDEX IF NOT EXISTS idx_jobs_topic ON jobs(topic_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, id);
  CREATE INDEX IF NOT EXISTS idx_job_events_topic ON job_events(topic_id, id);
`);

function seedBenchmarkCases() {
  if (!existsSync(BENCHMARK_DIR)) return;
  const upsert = db.prepare(`
    INSERT INTO benchmark_cases (
      case_key, topic_id, label, domain_key, mechanism_type,
      required_stages_json, expectations_json, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(case_key) DO UPDATE SET
      topic_id = excluded.topic_id,
      label = excluded.label,
      domain_key = excluded.domain_key,
      mechanism_type = excluded.mechanism_type,
      required_stages_json = excluded.required_stages_json,
      expectations_json = excluded.expectations_json,
      updated_at = CURRENT_TIMESTAMP
  `);
  for (const name of readdirSync(BENCHMARK_DIR).filter((entry) => entry.endsWith(".json"))) {
    try {
      const fixture = JSON.parse(readFileSync(path.join(BENCHMARK_DIR, name), "utf8"));
      const selector = fixture.topicSelector || {};
      const titleNeedle = String(selector.titleIncludes || "").trim();
      const sourceNeedle = String(selector.sourceTitleIncludes || "").trim();
      const externalKey = `benchmark:${fixture.caseKey}`;
      let topic = db.prepare("SELECT id FROM topics WHERE external_key = ? LIMIT 1").get(externalKey);
      if (!topic) {
        topic = db.prepare(`
          SELECT id FROM topics
          WHERE run_lane != 'production_canary'
            AND (? = '' OR title LIKE '%' || ? || '%')
            AND (? = '' OR source_title LIKE '%' || ? || '%')
          ORDER BY id ASC LIMIT 1
        `).get(titleNeedle, titleNeedle, sourceNeedle, sourceNeedle);
        if (topic) db.prepare("UPDATE topics SET run_lane = 'benchmark', external_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND external_key = ''").run(externalKey, topic.id);
      }
      upsert.run(
        fixture.caseKey,
        topic?.id || null,
        fixture.label,
        fixture.domainKey,
        fixture.mechanismType,
        JSON.stringify(fixture.requiredStages || []),
        JSON.stringify(fixture.expectations || {})
      );
    } catch (error) {
      console.error(`Benchmark fixture load failed (${name}):`, error.message);
    }
  }
}

db.exec("UPDATE video_jobs SET status = 'queued', error = '' WHERE status = 'running'");
db.exec(`
  INSERT OR IGNORE INTO schema_migrations (version, name) VALUES
    (1, 'initial_schema'),
    (2, 'durable_background_jobs'),
    (3, 'h3_video_profiles_and_qc'),
    (4, 'video_media_probe'),
    (5, 'multi_shot_physical_storyboard');

  UPDATE jobs
  SET status = CASE
        WHEN cancel_requested = 1 OR attempt >= max_attempts THEN 'canceled'
        ELSE 'queued'
      END,
      message = CASE
        WHEN cancel_requested = 1 THEN '서버 재시작 중 취소 요청을 반영했습니다.'
        WHEN attempt >= max_attempts THEN '서버 재시작 시 재시도 한도를 소진해 작업을 중단했습니다.'
        ELSE '서버 재시작 후 작업을 복구했습니다.'
      END,
      lease_owner = '',
      lease_until = NULL,
      completed_at = CASE
        WHEN cancel_requested = 1 OR attempt >= max_attempts THEN CURRENT_TIMESTAMP
        ELSE completed_at
      END,
      updated_at = CURRENT_TIMESTAMP
  WHERE status = 'running';
`);

function ensureColumn(table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function runDbTransaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

ensureColumn("fact_checks", "attempt", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("fact_checks", "enrichment_queries_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("fact_checks", "enrichment_sources_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("fact_checks", "claims_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("scripts", "approved_at", "TEXT");
ensureColumn("scripts", "core_mechanism", "TEXT NOT NULL DEFAULT ''");
ensureColumn("scripts", "unique_differentiator", "TEXT NOT NULL DEFAULT ''");
ensureColumn("scripts", "design_intervention", "TEXT NOT NULL DEFAULT ''");
ensureColumn("scripts", "tradeoffs_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("scripts", "limitations_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("shotlist_items", "physical_state", "TEXT NOT NULL DEFAULT ''");
ensureColumn("shotlist_items", "state_change_reason", "TEXT NOT NULL DEFAULT ''");
ensureColumn("shotlist_items", "force_flow", "TEXT NOT NULL DEFAULT ''");
ensureColumn("shotlist_items", "claim_refs_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("shotlist_items", "clean_prompt", "TEXT NOT NULL DEFAULT ''");
ensureColumn("shotlist_items", "info_prompt", "TEXT NOT NULL DEFAULT ''");
ensureColumn("shotlist_items", "info_spec_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("shotlist_items", "video_prompt", "TEXT NOT NULL DEFAULT ''");
ensureColumn("shotlist_items", "source_segment_order", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("shotlist_items", "shot_role", "TEXT NOT NULL DEFAULT 'context'");
ensureColumn("shotlist_items", "visual_family", "TEXT NOT NULL DEFAULT 'environment'");
ensureColumn("shotlist_items", "reference_policy", "TEXT NOT NULL DEFAULT 'none'");
ensureColumn("shotlist_items", "motion_policy", "TEXT NOT NULL DEFAULT 'first_frame'");
ensureColumn("shotlist_items", "required_visible_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("shotlist_items", "forbidden_visible_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("shotlist_items", "transition_end_state", "TEXT NOT NULL DEFAULT ''");
ensureColumn("shotlist_items", "visual_state_id", "TEXT NOT NULL DEFAULT ''");
ensureColumn("shotlist_items", "evidence_beat_id", "TEXT NOT NULL DEFAULT ''");
ensureColumn("voice_presets", "sample_text", "TEXT NOT NULL DEFAULT ''");
ensureColumn("voice_presets", "sample_audio_path", "TEXT NOT NULL DEFAULT ''");
ensureColumn("voice_presets", "sample_duration_sec", "REAL");
ensureColumn("topics", "last_error", "TEXT NOT NULL DEFAULT ''");
ensureColumn("topics", "topic_format", "TEXT NOT NULL DEFAULT 'legacy'");
ensureColumn("topics", "angle_attempt", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("topics", "evidence_score", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("video_jobs", "profile_id", "TEXT NOT NULL DEFAULT 'quality'");
ensureColumn("video_jobs", "settings_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("video_jobs", "seed", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("video_jobs", "qc_status", "TEXT NOT NULL DEFAULT 'pending'");
ensureColumn("video_jobs", "qc_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("video_jobs", "width", "INTEGER");
ensureColumn("video_jobs", "height", "INTEGER");
ensureColumn("video_jobs", "video_codec", "TEXT NOT NULL DEFAULT ''");
ensureColumn("video_jobs", "has_audio", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("video_jobs", "file_size", "INTEGER");
ensureColumn("video_jobs", "raw_output_path", "TEXT NOT NULL DEFAULT ''");
ensureColumn("video_jobs", "auto_qc_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("video_jobs", "source_fingerprint", "TEXT NOT NULL DEFAULT ''");
ensureColumn("video_jobs", "stale_reason", "TEXT NOT NULL DEFAULT ''");
ensureColumn("video_jobs", "stale_at", "TEXT");

db.exec(`
  CREATE TABLE IF NOT EXISTS topic_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER,
    stage TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );
  CREATE INDEX IF NOT EXISTS idx_topic_attempts_topic ON topic_attempts(topic_id, id DESC);

  CREATE TABLE IF NOT EXISTS production_briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL UNIQUE,
    fact_check_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    domain_key TEXT NOT NULL,
    narrative_type TEXT NOT NULL,
    scope_statement TEXT NOT NULL,
    core_question TEXT NOT NULL,
    causal_chain_json TEXT NOT NULL DEFAULT '[]',
    visual_states_json TEXT NOT NULL DEFAULT '[]',
    forbidden_inferences_json TEXT NOT NULL DEFAULT '[]',
    length_guidance_json TEXT NOT NULL DEFAULT '{}',
    quality_json TEXT NOT NULL DEFAULT '{}',
    raw_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id),
    FOREIGN KEY (fact_check_id) REFERENCES fact_checks(id)
  );
  CREATE INDEX IF NOT EXISTS idx_production_briefs_topic ON production_briefs(topic_id, id DESC);

  CREATE TABLE IF NOT EXISTS benchmark_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_key TEXT NOT NULL UNIQUE,
    topic_id INTEGER,
    label TEXT NOT NULL,
    domain_key TEXT NOT NULL,
    mechanism_type TEXT NOT NULL,
    required_stages_json TEXT NOT NULL DEFAULT '[]',
    expectations_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );
  CREATE INDEX IF NOT EXISTS idx_benchmark_cases_enabled ON benchmark_cases(enabled, id);

  CREATE TABLE IF NOT EXISTS quality_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    benchmark_case_id INTEGER,
    topic_id INTEGER,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    artifact_ref TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (benchmark_case_id) REFERENCES benchmark_cases(id),
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );
  CREATE INDEX IF NOT EXISTS idx_quality_runs_topic ON quality_runs(topic_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_quality_runs_case ON quality_runs(benchmark_case_id, id DESC);

  CREATE TABLE IF NOT EXISTS quality_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quality_run_id INTEGER NOT NULL,
    topic_id INTEGER,
    stage TEXT NOT NULL,
    code TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    repair_instruction TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'deterministic',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (quality_run_id) REFERENCES quality_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );
  CREATE INDEX IF NOT EXISTS idx_quality_findings_run ON quality_findings(quality_run_id, id);
  CREATE INDEX IF NOT EXISTS idx_quality_findings_topic ON quality_findings(topic_id, id DESC);

  CREATE TABLE IF NOT EXISTS quality_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quality_run_id INTEGER NOT NULL UNIQUE,
    benchmark_case_id INTEGER,
    topic_id INTEGER,
    stage TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    finding_signature TEXT NOT NULL DEFAULT '',
    score_delta REAL NOT NULL DEFAULT 0,
    repeated_signature_count INTEGER NOT NULL DEFAULT 0,
    cross_topic_count INTEGER NOT NULL DEFAULT 0,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (quality_run_id) REFERENCES quality_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (benchmark_case_id) REFERENCES benchmark_cases(id),
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );
  CREATE INDEX IF NOT EXISTS idx_quality_decisions_topic ON quality_decisions(topic_id, stage, id DESC);
  CREATE INDEX IF NOT EXISTS idx_quality_decisions_signature ON quality_decisions(stage, finding_signature, id DESC);

  CREATE TABLE IF NOT EXISTS asset_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    clip_index INTEGER NOT NULL,
    asset_type TEXT NOT NULL,
    asset_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'REVIEW',
    note TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(topic_id, clip_index, asset_type, asset_path),
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );
  CREATE INDEX IF NOT EXISTS idx_asset_reviews_topic ON asset_reviews(topic_id, asset_type, clip_index);

  CREATE TABLE IF NOT EXISTS evidence_packets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    fact_check_id INTEGER NOT NULL,
    fact_check_revision INTEGER NOT NULL DEFAULT 1,
    claims_json TEXT NOT NULL,
    visual_evidence_json TEXT NOT NULL,
    source_snapshot_json TEXT NOT NULL,
    contract_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id),
    FOREIGN KEY (fact_check_id) REFERENCES fact_checks(id)
  );
  CREATE INDEX IF NOT EXISTS idx_evidence_packets_topic ON evidence_packets(topic_id, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_packets_contract ON evidence_packets(topic_id, fact_check_id, contract_hash);

  CREATE TABLE IF NOT EXISTS ai_invocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    stage TEXT NOT NULL,
    topic_id INTEGER,
    job_id INTEGER,
    model TEXT NOT NULL DEFAULT '',
    prompt_hash TEXT NOT NULL,
    schema_hash TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    duration_ms INTEGER,
    fallback_count INTEGER NOT NULL DEFAULT 0,
    usage_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (topic_id) REFERENCES topics(id),
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_ai_invocations_topic ON ai_invocations(topic_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_invocations_task ON ai_invocations(task, id DESC);

  INSERT OR IGNORE INTO schema_migrations (version, name) VALUES
    (5, 'md_pipeline_contract'),
    (6, 'production_quality_system'),
    (7, 'quality_convergence_decisions'),
    (8, 'evidence_packets_and_ai_invocations');
`);

ensureColumn("asset_reviews", "auto_qc_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("topics", "run_lane", "TEXT NOT NULL DEFAULT 'production'");
ensureColumn("topics", "external_key", "TEXT NOT NULL DEFAULT ''");
ensureColumn("topics", "candidate_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("topics", "visual_preflight_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("topics", "canary_ai_pass_at", "TEXT");
ensureColumn("topics", "canary_ai_pass_json", "TEXT NOT NULL DEFAULT '{}'");
db.exec(`
  CREATE TABLE IF NOT EXISTS official_visual_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    reference_id TEXT NOT NULL,
    state_hint TEXT NOT NULL,
    reference_type TEXT NOT NULL,
    source_url TEXT NOT NULL,
    media_url TEXT NOT NULL,
    final_url TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT '',
    byte_size INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    cached_path TEXT NOT NULL DEFAULT '',
    license_url TEXT NOT NULL DEFAULT '',
    license_note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    verification_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );
  CREATE INDEX IF NOT EXISTS idx_official_visual_assets_topic ON official_visual_assets(topic_id, id);
  CREATE TABLE IF NOT EXISTS benchmark_replacement_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_topic_id INTEGER NOT NULL,
    candidate_topic_id INTEGER NOT NULL UNIQUE,
    discovery_job_id INTEGER,
    fact_check_job_id INTEGER,
    source_route TEXT NOT NULL DEFAULT 'topic_discovery',
    status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'preflight_failed', 'qualified')),
    direct_reference_count INTEGER NOT NULL DEFAULT 0,
    distinct_visible_state_count INTEGER NOT NULL DEFAULT 0,
    rejection_reason TEXT NOT NULL DEFAULT '',
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (original_topic_id) REFERENCES topics(id),
    FOREIGN KEY (candidate_topic_id) REFERENCES topics(id),
    FOREIGN KEY (discovery_job_id) REFERENCES jobs(id),
    FOREIGN KEY (fact_check_job_id) REFERENCES jobs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_benchmark_replacement_candidates_original ON benchmark_replacement_candidates(original_topic_id, status, id DESC);
  CREATE INDEX IF NOT EXISTS idx_benchmark_replacement_candidates_candidate ON benchmark_replacement_candidates(candidate_topic_id, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_external_key ON topics(external_key) WHERE external_key != '';
  INSERT OR IGNORE INTO schema_migrations (version, name) VALUES
    (9, 'production_canary_visual_preflight'),
    (10, 'production_canary_stage_approval'),
    (11, 'benchmark_replacement_candidates');
`);

seedBenchmarkCases();

db.prepare(`
  UPDATE video_jobs
  SET profile_id = 'legacy',
      settings_json = '{"id":"legacy","label":"기존 4스텝","steps":4,"loraName":""}'
  WHERE settings_json = '{}'
`).run();

function registerUntrackedLegacyVideos() {
  if (!existsSync(PROJECTS_DIR)) return;
  for (const projectEntry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    const topicId = Number(projectEntry.name.match(/^topic-(\d+)$/u)?.[1] || 0);
    if (!projectEntry.isDirectory() || !topicId) continue;
    const videoDir = path.join(PROJECTS_DIR, projectEntry.name, "video");
    if (!existsSync(videoDir)) continue;
    const latestByClip = new Map();
    for (const name of readdirSync(videoDir).filter((entry) => entry.toLowerCase().endsWith(".mp4")).sort()) {
      const clipIndex = Number(name.match(/^(\d+)/u)?.[1] || 0);
      if (clipIndex) latestByClip.set(clipIndex, name);
    }
    for (const [clipIndex, name] of latestByClip) {
      const tracked = db.prepare(`
        SELECT id FROM video_jobs
        WHERE topic_id = ? AND clip_index = ? AND status = 'completed'
        LIMIT 1
      `).get(topicId, clipIndex);
      if (tracked) continue;
      const absolute = path.join(videoDir, name);
      const media = probeVideoMetadata(absolute);
      db.prepare(`
        INSERT INTO video_jobs (
          topic_id, clip_index, status, input_path, output_path, requested_duration_sec,
          actual_duration_sec, profile_id, settings_json, seed, qc_status, started_at, completed_at
        ) VALUES (?, ?, 'completed', '', ?, 4, ?, 'legacy', ?, 0, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        topicId,
        clipIndex,
        toRelativeWorkspacePath(absolute),
        media.duration,
        JSON.stringify({ id: "legacy", label: "기존 4스텝", steps: 4, loraName: "" })
      );
    }
  }
}

registerUntrackedLegacyVideos();

function backfillVideoMetadata() {
  const rows = db.prepare(`
    SELECT id, output_path FROM video_jobs
    WHERE status = 'completed' AND (width IS NULL OR height IS NULL OR video_codec = '' OR file_size IS NULL)
  `).all();
  const update = db.prepare(`
    UPDATE video_jobs
    SET actual_duration_sec = COALESCE(?, actual_duration_sec), width = ?, height = ?,
        video_codec = ?, has_audio = ?, file_size = ?
    WHERE id = ?
  `);
  for (const row of rows) {
    const absolute = resolveWorkspacePath(row.output_path);
    if (!existsSync(absolute)) continue;
    const media = probeVideoMetadata(absolute);
    update.run(media.duration, media.width, media.height, media.videoCodec, media.hasAudio ? 1 : 0, media.fileSize, row.id);
  }
}

backfillVideoMetadata();

db.exec(`
  UPDATE topics
  SET review_status = CASE (SELECT status FROM fact_checks WHERE fact_checks.topic_id = topics.id)
        WHEN 'PASS' THEN 'verified'
        WHEN 'REJECT' THEN 'rejected'
        ELSE 'hold'
      END,
      lifecycle_status = CASE (SELECT status FROM fact_checks WHERE fact_checks.topic_id = topics.id)
        WHEN 'PASS' THEN 'script'
        WHEN 'REJECT' THEN 'dropped'
        ELSE 'fact_checking'
      END,
      last_error = '이전 재검증 작업이 완료되지 않아 마지막 저장 결과로 복구했습니다.',
      updated_at = CURRENT_TIMESTAMP
  WHERE review_status = 'checking'
    AND EXISTS (SELECT 1 FROM fact_checks WHERE fact_checks.topic_id = topics.id);

  UPDATE topics
  SET review_status = 'prechecked',
      lifecycle_status = 'candidate',
      last_error = '이전 검증 작업이 완료되지 않아 다시 실행할 수 있도록 복구했습니다.',
      updated_at = CURRENT_TIMESTAMP
  WHERE review_status = 'checking'
    AND NOT EXISTS (SELECT 1 FROM fact_checks WHERE fact_checks.topic_id = topics.id);

  UPDATE tts_runs
  SET status = 'failed',
      error = '서버가 재시작되어 이전 TTS 작업이 중단되었습니다.',
      updated_at = CURRENT_TIMESTAMP
  WHERE status = 'generating';
`);

const defaultVoicePreset = {
  name: "역사 다큐 기본 남성",
  engine: "VoxCPM2",
  mode: "preset",
  language: "ko",
  styleInstruction: "A calm male documentary narrator, deep voice, cinematic tension",
  speakerKey: "default-documentary-male",
  referenceAudioPath: "",
  sampleText: TTS_EXAMPLE_TEXT,
  notes: "초기 기본값. 브라우저 샘플 테스트 후 실제 로컬 엔진의 speaker key로 교체."
};

const insertDefaultVoicePresetStatement = db.prepare(`
  INSERT OR IGNORE INTO voice_presets (
    name,
    engine,
    mode,
    language,
    style_instruction,
    speaker_key,
    reference_audio_path,
    sample_text,
    notes,
    is_default
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);

insertDefaultVoicePresetStatement.run(
  defaultVoicePreset.name,
  defaultVoicePreset.engine,
  defaultVoicePreset.mode,
  defaultVoicePreset.language,
  defaultVoicePreset.styleInstruction,
  defaultVoicePreset.speakerKey,
  defaultVoicePreset.referenceAudioPath,
  defaultVoicePreset.sampleText,
  defaultVoicePreset.notes
);

const knownSourceStatement = db.prepare(`
  SELECT id, lifecycle_status
  FROM topics
  WHERE source_url = ? OR source_title = ?
  LIMIT 1
`);

const insertTopicStatement = db.prepare(`
  INSERT INTO topics (
    main_topic,
    subtopic,
    title,
    hook,
    review_status,
    lifecycle_status,
    verification_score,
    visual_score,
    novelty_score,
    length_fit_score,
    distortion_risk_score,
    source_title,
    source_url,
    topic_format,
    candidate_json
  )
  VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, 'focused_v2', ?)
`);

const insertSearchStatement = db.prepare(`
  INSERT INTO topic_searches (main_topic, subtopic, requested_count, returned_count)
  VALUES (?, ?, ?, ?)
`);

const updateLifecycleStatement = db.prepare(`
  UPDATE topics
  SET lifecycle_status = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const updateTopicReviewStatement = db.prepare(`
  UPDATE topics
  SET review_status = ?,
      lifecycle_status = ?,
      last_error = '',
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const updateTopicFailureStatement = db.prepare(`
  UPDATE topics
  SET review_status = ?,
      lifecycle_status = ?,
      last_error = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const getTopicStatement = db.prepare(`
  SELECT
    id,
    main_topic AS mainTopic,
    subtopic,
    title,
    hook,
    review_status AS reviewStatus,
    lifecycle_status AS lifecycleStatus,
    verification_score AS verification,
    visual_score AS visual,
    novelty_score AS novelty,
    length_fit_score AS lengthFit,
    distortion_risk_score AS distortionRisk,
    source_title AS sourceTitle,
    source_url AS sourceUrl,
    run_lane AS runLane,
    external_key AS externalKey,
    candidate_json AS candidateJson,
    visual_preflight_json AS visualPreflightJson,
    canary_ai_pass_at AS canaryAiPassAt,
    canary_ai_pass_json AS canaryAiPassJson,
    last_error AS lastError
  FROM topics
  WHERE id = ?
`);

const getFactCheckByTopicStatement = db.prepare(`
  SELECT
    id,
    topic_id AS topicId,
    status,
    confidence,
    core_claim AS coreClaim,
    claims_json AS claimsJson,
    verified_facts_json AS verifiedFactsJson,
    unresolved_json AS unresolvedJson,
    simplifications_json AS simplificationsJson,
    sources_json AS sourcesJson,
    verdict_reason AS verdictReason,
    next_action AS nextAction,
    attempt,
    enrichment_queries_json AS enrichmentQueriesJson,
    enrichment_sources_json AS enrichmentSourcesJson,
    raw_json AS rawJson,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM fact_checks
  WHERE topic_id = ?
`);

const upsertFactCheckStatement = db.prepare(`
  INSERT INTO fact_checks (
    topic_id,
    status,
    confidence,
    core_claim,
    claims_json,
    verified_facts_json,
    unresolved_json,
    simplifications_json,
    sources_json,
    verdict_reason,
    next_action,
    attempt,
    enrichment_queries_json,
    enrichment_sources_json,
    raw_json
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(topic_id) DO UPDATE SET
    status = excluded.status,
    confidence = excluded.confidence,
    core_claim = excluded.core_claim,
    claims_json = excluded.claims_json,
    verified_facts_json = excluded.verified_facts_json,
    unresolved_json = excluded.unresolved_json,
    simplifications_json = excluded.simplifications_json,
    sources_json = excluded.sources_json,
    verdict_reason = excluded.verdict_reason,
    next_action = excluded.next_action,
    attempt = excluded.attempt,
    enrichment_queries_json = excluded.enrichment_queries_json,
    enrichment_sources_json = excluded.enrichment_sources_json,
    raw_json = excluded.raw_json,
    updated_at = CURRENT_TIMESTAMP
`);

const getProductionBriefByTopicStatement = db.prepare(`
  SELECT
    id,
    topic_id AS topicId,
    fact_check_id AS factCheckId,
    status,
    domain_key AS domainKey,
    narrative_type AS narrativeType,
    scope_statement AS scopeStatement,
    core_question AS coreQuestion,
    causal_chain_json AS causalChainJson,
    visual_states_json AS visualStatesJson,
    forbidden_inferences_json AS forbiddenInferencesJson,
    length_guidance_json AS lengthGuidanceJson,
    quality_json AS qualityJson,
    raw_json AS rawJson,
    revision,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM production_briefs
  WHERE topic_id = ?
`);

const upsertProductionBriefStatement = db.prepare(`
  INSERT INTO production_briefs (
    topic_id, fact_check_id, status, domain_key, narrative_type, scope_statement,
    core_question, causal_chain_json, visual_states_json, forbidden_inferences_json,
    length_guidance_json, quality_json, raw_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(topic_id) DO UPDATE SET
    fact_check_id = excluded.fact_check_id,
    status = excluded.status,
    domain_key = excluded.domain_key,
    narrative_type = excluded.narrative_type,
    scope_statement = excluded.scope_statement,
    core_question = excluded.core_question,
    causal_chain_json = excluded.causal_chain_json,
    visual_states_json = excluded.visual_states_json,
    forbidden_inferences_json = excluded.forbidden_inferences_json,
    length_guidance_json = excluded.length_guidance_json,
    quality_json = excluded.quality_json,
    raw_json = excluded.raw_json,
    revision = production_briefs.revision + 1,
    updated_at = CURRENT_TIMESTAMP
`);

const insertQualityRunStatement = db.prepare(`
  INSERT INTO quality_runs (benchmark_case_id, topic_id, stage, status, score, metrics_json, artifact_ref)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertQualityFindingStatement = db.prepare(`
  INSERT INTO quality_findings (
    quality_run_id, topic_id, stage, code, severity, message, repair_instruction, source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertQualityDecisionStatement = db.prepare(`
  INSERT INTO quality_decisions (
    quality_run_id, benchmark_case_id, topic_id, stage, action, reason,
    finding_signature, score_delta, repeated_signature_count, cross_topic_count, details_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(quality_run_id) DO UPDATE SET
    action = excluded.action,
    reason = excluded.reason,
    finding_signature = excluded.finding_signature,
    score_delta = excluded.score_delta,
    repeated_signature_count = excluded.repeated_signature_count,
    cross_topic_count = excluded.cross_topic_count,
    details_json = excluded.details_json
`);

const getBenchmarkCaseByTopicStatement = db.prepare(`
  SELECT
    id,
    case_key AS caseKey,
    topic_id AS topicId,
    label,
    domain_key AS domainKey,
    mechanism_type AS mechanismType,
    required_stages_json AS requiredStagesJson,
    expectations_json AS expectationsJson,
    enabled,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM benchmark_cases
  WHERE topic_id = ? AND enabled = 1
  ORDER BY id LIMIT 1
`);

const getScriptByTopicStatement = db.prepare(`
  SELECT
    id,
    topic_id AS topicId,
    status,
    core_question AS coreQuestion,
    core_conflict AS coreConflict,
    core_mechanism AS coreMechanism,
    visible_flow AS visibleFlow,
    turning_point AS turningPoint,
    unique_differentiator AS uniqueDifferentiator,
    design_intervention AS designIntervention,
    tradeoffs_json AS tradeoffsJson,
    limitations_json AS limitationsJson,
    production_script_json AS productionScriptJson,
    tts_text AS ttsText,
    notes_json AS notesJson,
    approved_at AS approvedAt,
    raw_json AS rawJson,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM scripts
  WHERE topic_id = ?
`);

const getLatestScriptTopicStatement = db.prepare(`
  SELECT topic_id AS topicId
  FROM scripts
  ORDER BY updated_at DESC, id DESC
  LIMIT 1
`);

const upsertScriptStatement = db.prepare(`
  INSERT INTO scripts (
    topic_id,
    status,
    core_question,
    core_conflict,
    core_mechanism,
    visible_flow,
    turning_point,
    unique_differentiator,
    design_intervention,
    tradeoffs_json,
    limitations_json,
    production_script_json,
    tts_text,
    notes_json,
    raw_json
  )
  VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(topic_id) DO UPDATE SET
    status = 'draft',
    core_question = excluded.core_question,
    core_conflict = excluded.core_conflict,
    core_mechanism = excluded.core_mechanism,
    visible_flow = excluded.visible_flow,
    turning_point = excluded.turning_point,
    unique_differentiator = excluded.unique_differentiator,
    design_intervention = excluded.design_intervention,
    tradeoffs_json = excluded.tradeoffs_json,
    limitations_json = excluded.limitations_json,
    production_script_json = excluded.production_script_json,
    tts_text = excluded.tts_text,
    notes_json = excluded.notes_json,
    approved_at = NULL,
    raw_json = excluded.raw_json,
    updated_at = CURRENT_TIMESTAMP
`);

const approveScriptStatement = db.prepare(`
  UPDATE scripts
  SET status = 'approved',
      approved_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE topic_id = ?
`);

const updateApprovedScriptStatement = db.prepare(`
  UPDATE scripts
  SET status = 'approved',
      production_script_json = ?,
      tts_text = ?,
      raw_json = ?,
      approved_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE topic_id = ?
`);

const listVoicePresetsStatement = db.prepare(`
  SELECT
    id,
    name,
    engine,
    mode,
    language,
    style_instruction AS styleInstruction,
    speaker_key AS speakerKey,
    reference_audio_path AS referenceAudioPath,
    sample_text AS sampleText,
    sample_audio_path AS sampleAudioPath,
    sample_duration_sec AS sampleDurationSec,
    notes,
    is_default AS isDefault,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM voice_presets
  ORDER BY is_default DESC, updated_at DESC, id DESC
`);

const getVoicePresetStatement = db.prepare(`
  SELECT
    id,
    name,
    engine,
    mode,
    language,
    style_instruction AS styleInstruction,
    speaker_key AS speakerKey,
    reference_audio_path AS referenceAudioPath,
    sample_text AS sampleText,
    sample_audio_path AS sampleAudioPath,
    sample_duration_sec AS sampleDurationSec,
    notes,
    is_default AS isDefault,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM voice_presets
  WHERE id = ?
`);

const getDefaultVoicePresetStatement = db.prepare(`
  SELECT
    id,
    name,
    engine,
    mode,
    language,
    style_instruction AS styleInstruction,
    speaker_key AS speakerKey,
    reference_audio_path AS referenceAudioPath,
    sample_text AS sampleText,
    sample_audio_path AS sampleAudioPath,
    sample_duration_sec AS sampleDurationSec,
    notes,
    is_default AS isDefault,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM voice_presets
  ORDER BY is_default DESC, id ASC
  LIMIT 1
`);

const insertVoicePresetStatement = db.prepare(`
  INSERT INTO voice_presets (
    name,
    engine,
    mode,
    language,
    style_instruction,
    speaker_key,
    reference_audio_path,
    sample_text,
    notes,
    is_default
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateVoicePresetSampleStatement = db.prepare(`
  UPDATE voice_presets
  SET sample_text = ?,
      sample_audio_path = ?,
      sample_duration_sec = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const clearDefaultVoicePresetsStatement = db.prepare(`
  UPDATE voice_presets
  SET is_default = 0,
      updated_at = CURRENT_TIMESTAMP
`);

const insertTtsRunStatement = db.prepare(`
  INSERT INTO tts_runs (
    topic_id,
    script_id,
    voice_preset_id,
    status,
    engine,
    language,
    estimated_total_duration_sec
  )
  VALUES (?, ?, ?, 'prepared', ?, ?, ?)
`);

const updateTtsRunStatement = db.prepare(`
  UPDATE tts_runs
  SET status = ?,
      total_duration_sec = ?,
      output_path = ?,
      error = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const insertTtsSegmentStatement = db.prepare(`
  INSERT INTO tts_segments (
    run_id,
    topic_id,
    script_id,
    segment_index,
    label,
    planned_time,
    text,
    estimated_duration_sec,
    status
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared')
`);

const clearTtsSegmentsByRunStatement = db.prepare(`
  DELETE FROM tts_segments
  WHERE run_id = ?
`);

const updateTtsSegmentOutputStatement = db.prepare(`
  UPDATE tts_segments
  SET audio_path = ?,
      duration_sec = ?,
      status = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE run_id = ?
    AND segment_index = ?
`);

const getLatestTtsRunByTopicStatement = db.prepare(`
  SELECT
    id,
    topic_id AS topicId,
    script_id AS scriptId,
    voice_preset_id AS voicePresetId,
    status,
    engine,
    language,
    total_duration_sec AS totalDurationSec,
    estimated_total_duration_sec AS estimatedTotalDurationSec,
    output_path AS outputPath,
    error,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM tts_runs
  WHERE topic_id = ?
  ORDER BY id DESC
  LIMIT 1
`);

const listTtsSegmentsByRunStatement = db.prepare(`
  SELECT
    id,
    run_id AS runId,
    topic_id AS topicId,
    script_id AS scriptId,
    segment_index AS segmentIndex,
    label,
    planned_time AS plannedTime,
    text,
    audio_path AS audioPath,
    duration_sec AS durationSec,
    estimated_duration_sec AS estimatedDurationSec,
    status,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM tts_segments
  WHERE run_id = ?
  ORDER BY segment_index ASC
`);

const insertShotlistStatement = db.prepare(`
  INSERT INTO shotlists (
    topic_id,
    script_id,
    tts_run_id,
    status,
    total_duration_sec,
    clip_count,
    manifest_path,
    notes_json,
    raw_json
  )
  VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)
`);

const insertShotlistItemStatement = db.prepare(`
  INSERT INTO shotlist_items (
    shotlist_id,
    topic_id,
    sort_index,
    scene_id,
    keyframe_id,
    clip_id,
    source_segment_index,
    source_segment_order,
    visual_state_id,
    evidence_beat_id,
    start_sec,
    end_sec,
    duration_sec,
    script_excerpt,
    scene_purpose,
    clean_content,
    info_focus,
    camera_motion,
    shot_role,
    visual_family,
    reference_policy,
    motion_policy,
    required_visible_json,
    forbidden_visible_json,
    transition_end_state,
    physical_state,
    state_change_reason,
    force_flow,
    claim_refs_json,
    clean_prompt,
    info_prompt,
    info_spec_json,
    video_prompt,
    file_stub,
    status
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
`);

const getLatestShotlistByTopicStatement = db.prepare(`
  SELECT
    id,
    topic_id AS topicId,
    script_id AS scriptId,
    tts_run_id AS ttsRunId,
    status,
    total_duration_sec AS totalDurationSec,
    clip_count AS clipCount,
    manifest_path AS manifestPath,
    notes_json AS notesJson,
    raw_json AS rawJson,
    approved_at AS approvedAt,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM shotlists
  WHERE topic_id = ?
  ORDER BY id DESC
  LIMIT 1
`);

const listShotlistItemsStatement = db.prepare(`
  SELECT
    id,
    shotlist_id AS shotlistId,
    topic_id AS topicId,
    sort_index AS sortIndex,
    scene_id AS sceneId,
    keyframe_id AS keyframeId,
    clip_id AS clipId,
    source_segment_index AS sourceSegmentIndex,
    source_segment_order AS sourceSegmentOrder,
    visual_state_id AS visualStateId,
    evidence_beat_id AS evidenceBeatId,
    start_sec AS startSec,
    end_sec AS endSec,
    duration_sec AS durationSec,
    script_excerpt AS scriptExcerpt,
    scene_purpose AS scenePurpose,
    clean_content AS cleanContent,
    info_focus AS infoFocus,
    camera_motion AS cameraMotion,
    shot_role AS shotRole,
    visual_family AS visualFamily,
    reference_policy AS referencePolicy,
    motion_policy AS motionPolicy,
    required_visible_json AS requiredVisibleJson,
    forbidden_visible_json AS forbiddenVisibleJson,
    transition_end_state AS transitionEndState,
    physical_state AS physicalState,
    state_change_reason AS stateChangeReason,
    force_flow AS forceFlow,
    claim_refs_json AS claimRefsJson,
    clean_prompt AS cleanPrompt,
    info_prompt AS infoPrompt,
    info_spec_json AS infoSpecJson,
    video_prompt AS videoPrompt,
    file_stub AS fileStub,
    status,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM shotlist_items
  WHERE shotlist_id = ?
  ORDER BY sort_index ASC
`);

const listTopicsStatement = db.prepare(`
  SELECT
    id AS dbId,
    title,
    hook,
    review_status AS status,
    lifecycle_status AS lifecycleStatus,
    verification_score AS verification,
    visual_score AS visual,
    novelty_score AS novelty,
    length_fit_score AS lengthFit,
    distortion_risk_score AS distortionRisk,
    source_title AS sourceTitle,
    source_url AS sourceUrl,
    run_lane AS runLane,
    EXISTS(SELECT 1 FROM fact_checks WHERE fact_checks.topic_id = topics.id) AS hasFactCheck,
    COALESCE((SELECT attempt FROM fact_checks WHERE fact_checks.topic_id = topics.id), 0) AS factAttempt,
    COALESCE((SELECT confidence FROM fact_checks WHERE fact_checks.topic_id = topics.id), 0) AS factConfidence,
    EXISTS(
      SELECT 1 FROM jobs
      WHERE jobs.topic_id = topics.id AND jobs.type = 'fact_check' AND jobs.status IN ('queued', 'running')
    ) AS hasActiveFactJob,
    EXISTS(SELECT 1 FROM scripts WHERE scripts.topic_id = topics.id) AS hasScript,
    COALESCE((SELECT status FROM scripts WHERE scripts.topic_id = topics.id ORDER BY id DESC LIMIT 1), '') AS scriptStatus,
    COALESCE((SELECT status FROM tts_runs WHERE tts_runs.topic_id = topics.id ORDER BY id DESC LIMIT 1), '') AS ttsStatus,
    COALESCE((SELECT status FROM shotlists WHERE shotlists.topic_id = topics.id ORDER BY id DESC LIMIT 1), '') AS shotlistStatus
  FROM topics
  WHERE main_topic = ?
    AND (? IS NULL OR subtopic = ?)
    AND lifecycle_status != 'dropped'
    AND (
      (run_lane = 'production' AND EXISTS(
        SELECT 1 FROM fact_checks
        WHERE fact_checks.topic_id = topics.id AND fact_checks.status = 'PASS'
      ))
      OR run_lane = 'production_canary'
    )
  ORDER BY updated_at DESC, id DESC
  LIMIT ?
`);

const domainLabels = {
  history: "역사",
  engineering: "공학",
  science: "과학"
};

const queryHints = {
  history: ["역사", "제도", "사건", "기술", "도시", "전쟁", "통신"],
  engineering: ["원리", "구조", "설계", "하중", "흐름", "장치"],
  science: ["원리", "현상", "실험", "관측", "구조", "변화"]
};

const questionTemplates = {
  history: [
    "{subject} 어떻게 조선의 정보, 권력, 물자의 흐름을 바꿨나?",
    "{object} 지도 위에서 보면 어떤 흐름이 보이나?",
    "{subject} 왜 조선의 운영 방식에서 중요했나?",
    "{subject} 어떤 제도와 현장으로 움직였나?"
  ],
  engineering: [
    "{subject} 어떤 힘을 어디로 흘려보내는가?",
    "{subject} 왜 겉모양보다 하중 경로가 중요할까?",
    "{subject} 어떤 설계 개입으로 실패를 막는가?",
    "{object} 단면으로 보면 무엇이 보이나?"
  ],
  science: [
    "{subject} 왜 눈에 보이는 결과보다 조건이 중요할까?",
    "{subject} 어떤 보이지 않는 흐름을 드러내나?",
    "{subject} 어떻게 작은 변화가 큰 결과를 만들까?",
    "{object} 스케일을 바꿔 보면 무엇이 달라지나?"
  ]
};

const searchSeeds = {
  history: {
    "조선시대": ["봉수", "측우기", "한양도성", "대동법", "판옥선", "의궤", "장시", "금속활자", "수원 화성", "과거제", "암행어사", "세곡"],
    "고려/삼국": ["팔만대장경", "고려 역참", "한강 유역", "고구려 산성", "골품제", "백제 해상 교류", "무신정변", "불국사", "철 생산", "벽란도"],
    "중세 유럽": ["중세 성", "해자", "길드", "장궁", "고딕 건축", "흑사병", "바이킹 선박", "수도원", "십자군", "성벽 도시"],
    "근현대": ["철도 표준시", "전신", "컨테이너 운송", "냉전 핫라인", "지하철", "라디오 방송", "파이프라인", "고속도로", "초기 컴퓨터", "위성항법"]
  },
  engineering: {
    "건축공학": [
      "동조 질량 감쇠기", "아치", "내진 설계", "지진공학", "철근 콘크리트",
      "프리스트레스트 콘크리트", "트러스", "말뚝", "전단벽", "마천루",
      "돔", "공간 프레임", "캔틸레버", "철골 구조", "커튼월", "좌굴",
      "공진", "감쇠", "면진", "기초"
    ],
    "토목공학": ["현수교", "사장교", "터널 굴착", "중력식 댐", "흙막이", "말뚝 기초", "옹벽", "도로 배수", "철도 궤도", "지반 액상화"],
    "도시공학": ["상수도 압력", "하수도 월류", "교통 신호", "지역난방", "도시 홍수", "지하 공동구", "전력망", "대중교통 환승", "빗물 저류", "도시 열섬"],
    "기계공학": ["기어", "터빈", "내연기관", "베어링", "열교환기", "압축기", "펌프", "캠샤프트", "클러치", "브레이크"],
    "항공공학": ["양력", "항력", "제트 엔진", "실속", "플랩", "날개", "터보팬", "충격파", "복합재", "비행 제어"],
    "유체역학": ["와류", "베르누이 원리", "캐비테이션", "층류", "난류", "항력 계수", "경계층", "수격 작용", "파랑", "압력 손실"],
    "밀리터리 엔지니어링": ["복합 장갑", "경사 장갑", "반응 장갑", "요새 환기", "교량 가설", "방탄 유리", "폭압 완화", "잠수함 압력선체", "함정 격벽", "활주로 복구"]
  },
  science: {
    "우주": ["궤도", "중력 렌즈", "라그랑주점", "블랙홀", "초신성", "혜성", "조석력", "우주 배경 복사", "외계 행성", "로켓 방정식"],
    "생물": ["광합성", "미토콘드리아", "DNA 복제", "면역 반응", "진화", "공생", "감각 기관", "신경 전달", "세포막", "생태계"],
    "화학": ["촉매", "산화 환원", "고분자", "전기분해", "용해도", "pH", "화학 평형", "배터리", "반응 속도", "결정 구조"],
    "지구과학": ["판 구조론", "지진파", "화산", "해류", "대기 순환", "태풍", "빙하", "침식", "단층", "엘니뇨"]
  }
};

const caseStudySeeds = {
  engineering: {
    "건축공학": [
      "타이베이 101", "롯데월드타워", "부르즈 할리파", "밀레니엄 브리지",
      "피사의 사탑", "판테온", "사그라다 파밀리아", "시드니 오페라 하우스",
      "마리나 베이 샌즈", "에덴 프로젝트", "폼피두 센터", "30 세인트 메리 액스",
      "상하이 타워", "존 핸콕 센터", "씨티그룹 센터", "도쿄 스카이트리",
      "경복궁 근정전", "창덕궁", "수원 화성", "석굴암",
      "윌리스 타워", "페트로나스 트윈 타워", "허스트 타워", "CCTV 본사 빌딩",
      "에펠탑", "로이드 빌딩", "메트로폴 파라솔", "엠파이어 스테이트 빌딩",
      "30 허드슨 야드", "원 월드 트레이드 센터", "뱅크 오브 차이나 타워",
      "킹덤 센터", "게이트웨이 아치", "루브르 피라미드", "킴벨 미술관",
      "솔로몬 R. 구겐하임 미술관", "빌바오 구겐하임 미술관", "하비타트 67",
      "피렌체 대성당", "세인트 폴 대성당", "베이징 국가체육장"
    ],
    "토목공학": [
      "후버 댐", "파나마 운하", "간사이 국제공항", "인천대교", "영종대교",
      "델타 계획", "세이칸 터널", "고트하르트 베이스 터널", "금문교",
      "밀라우 고가교", "채널 터널", "새만금 방조제", "보령 해저터널"
    ],
    "도시공학": [
      "청계천", "난지도", "반포대교 잠수교", "동부간선도로", "서울 지하철",
      "도쿄 수도권 외곽 방수로", "싱가포르 마리나 배라지", "하이라인",
      "하마비 허스타드", "템스 배리어"
    ]
  }
};

const caseStudySources = {
  engineering: {
    "건축공학": [
      ["Taipei 101", "https://en.wikipedia.org/wiki/Taipei_101"],
      ["Burj Khalifa", "https://en.wikipedia.org/wiki/Burj_Khalifa"],
      ["Millennium Bridge London", "https://en.wikipedia.org/wiki/Millennium_Bridge,_London"],
      ["Leaning Tower of Pisa", "https://en.wikipedia.org/wiki/Leaning_Tower_of_Pisa"],
      ["Pantheon Rome", "https://en.wikipedia.org/wiki/Pantheon,_Rome"],
      ["Sagrada Familia", "https://en.wikipedia.org/wiki/Sagrada_Fam%C3%ADlia"],
      ["Sydney Opera House", "https://en.wikipedia.org/wiki/Sydney_Opera_House"],
      ["Marina Bay Sands", "https://en.wikipedia.org/wiki/Marina_Bay_Sands"],
      ["Eden Project", "https://en.wikipedia.org/wiki/Eden_Project"],
      ["Centre Pompidou", "https://en.wikipedia.org/wiki/Centre_Pompidou"],
      ["30 St Mary Axe", "https://en.wikipedia.org/wiki/30_St_Mary_Axe"],
      ["Shanghai Tower", "https://en.wikipedia.org/wiki/Shanghai_Tower"],
      ["John Hancock Center", "https://en.wikipedia.org/wiki/John_Hancock_Center"],
      ["Citigroup Center", "https://en.wikipedia.org/wiki/Citigroup_Center"],
      ["Tokyo Skytree", "https://en.wikipedia.org/wiki/Tokyo_Skytree"],
      ["Lotte World Tower", "https://en.wikipedia.org/wiki/Lotte_World_Tower"],
      ["Willis Tower", "https://en.wikipedia.org/wiki/Willis_Tower"],
      ["Petronas Towers", "https://en.wikipedia.org/wiki/Petronas_Towers"],
      ["Hearst Tower", "https://en.wikipedia.org/wiki/Hearst_Tower_(Manhattan)"],
      ["CCTV Headquarters", "https://en.wikipedia.org/wiki/CCTV_Headquarters"],
      ["Eiffel Tower", "https://en.wikipedia.org/wiki/Eiffel_Tower"],
      ["Lloyd's building", "https://en.wikipedia.org/wiki/Lloyd%27s_building"],
      ["Metropol Parasol", "https://en.wikipedia.org/wiki/Metropol_Parasol"],
      ["Empire State Building", "https://en.wikipedia.org/wiki/Empire_State_Building"],
      ["30 Hudson Yards", "https://en.wikipedia.org/wiki/30_Hudson_Yards"],
      ["One World Trade Center", "https://en.wikipedia.org/wiki/One_World_Trade_Center"],
      ["Bank of China Tower", "https://en.wikipedia.org/wiki/Bank_of_China_Tower_(Hong_Kong)"],
      ["Kingdom Centre", "https://en.wikipedia.org/wiki/Kingdom_Centre"],
      ["Gateway Arch", "https://en.wikipedia.org/wiki/Gateway_Arch"],
      ["Louvre Pyramid", "https://en.wikipedia.org/wiki/Louvre_Pyramid"],
      ["Kimbell Art Museum", "https://en.wikipedia.org/wiki/Kimbell_Art_Museum"],
      ["Solomon R. Guggenheim Museum", "https://en.wikipedia.org/wiki/Solomon_R._Guggenheim_Museum"],
      ["Guggenheim Museum Bilbao", "https://en.wikipedia.org/wiki/Guggenheim_Museum_Bilbao"],
      ["Habitat 67", "https://en.wikipedia.org/wiki/Habitat_67"],
      ["Florence Cathedral", "https://en.wikipedia.org/wiki/Florence_Cathedral"],
      ["St Paul's Cathedral", "https://en.wikipedia.org/wiki/St_Paul%27s_Cathedral"],
      ["Beijing National Stadium", "https://en.wikipedia.org/wiki/Beijing_National_Stadium"],
      ["Golden Gate Bridge", "https://en.wikipedia.org/wiki/Golden_Gate_Bridge"],
      ["Thames Barrier", "https://en.wikipedia.org/wiki/Thames_Barrier"]
    ].map(([title, url]) => ({ title, seed: title, url }))
  }
};

function discoverySeedsFor(mainTopic, subtopic) {
  return [
    ...(caseStudySources[mainTopic]?.[subtopic] || []).map((source) => source.title),
    ...(caseStudySeeds[mainTopic]?.[subtopic] || []),
    ...(searchSeeds[mainTopic]?.[subtopic] || [subtopic])
  ];
}

const engineeringEvidenceQueries = {
  "동조 질량 감쇠기": "tuned mass damper structural vibration energy dissipation building",
  "아치": "arch structural behavior horizontal thrust",
  "내진 설계": "seismic design load path ductility energy dissipation building",
  "지진공학": "earthquake engineering seismic load path ductility structural response",
  "철근 콘크리트": "steel reinforced concrete beam flexural behavior compression tension",
  "철근 콘크리트 공학": "steel reinforced concrete beam flexural behavior compression tension",
  "프리스트레스트 콘크리트": "prestressed concrete tendon compression load transfer cracking",
  "트러스": "truss axial tension compression member load path",
  "말뚝": "pile foundation load transfer skin friction end bearing",
  "전단벽": "shear wall lateral load path overturning building",
  "마천루": "tall building lateral load system core outrigger wind",
  "돔": "structural dome membrane compression load path ring tension",
  "공간 프레임": "space frame structural load path axial force",
  "캔틸레버": "cantilever bending moment shear load path fixed support",
  "철골 구조": "steel frame structural load path bracing moment frame",
  "커튼월": "curtain wall wind load transfer anchors building structure",
  "좌굴": "column buckling bracing slenderness",
  "공진": "structural resonance natural frequency dynamic amplification building",
  "감쇠": "structural damping energy dissipation seismic response building",
  "면진": "base isolation seismic force reduction structural response",
  "기초": "foundation load transfer bearing capacity"
};

const caseEvidenceSources = {
  "Taipei 101": [
    {
      title: "Structural Design of Taipei 101",
      url: "https://global.ctbuh.org/resources/papers/1650-Poon_2004_StructuralDesignTaipei.pdf"
    },
    {
      title: "Taipei 101 tuned mass damper",
      url: "https://www.motioneering.ca/zh/our-work/taipei-101"
    }
  ],
  "Burj Khalifa": [
    { title: "Burj Khalifa structural system", url: "https://www.burjkhalifa.ae/the-tower/structures/" },
    { title: "Burj Khalifa engineering", url: "https://www.som.com/projects/burj-khalifa/" }
  ],
  "John Hancock Center": [
    {
      title: "875 North Michigan Avenue structural engineering",
      url: "https://www.som.com/projects/875-north-michigan-avenue-formerly-john-hancock-center/"
    },
    {
      title: "Reflections on the Hancock Concept",
      url: "https://global.ctbuh.org/resources/papers/download/1231-reflections-on-the-hancock-concept.pdf"
    }
  ],
  "Sydney Opera House": [
    { title: "Sydney Opera House design principles", url: "https://www.sydneyoperahouse.com/our-story/sydney-opera-house-history/designing-an-icon" },
    { title: "Sydney Opera House engineering", url: "https://www.arup.com/projects/sydney-opera-house/" }
  ],
  "Millennium Bridge London": [
    { title: "Millennium Bridge engineering", url: "https://www.arup.com/projects/millennium-bridge/" },
    { title: "London Millennium Footbridge", url: "https://www.fosterandpartners.com/projects/millennium-bridge" }
  ],
  "Shanghai Tower": [
    { title: "Shanghai Tower project", url: "https://www.gensler.com/projects/shanghai-tower" },
    { title: "Shanghai Tower", url: "https://www.skyscrapercenter.com/building/shanghai-tower/56" }
  ],
  "Willis Tower": [
    { title: "Willis Tower structural engineering", url: "https://www.som.com/projects/willis-tower-formerly-sears-tower/" },
    { title: "Willis Tower", url: "https://www.skyscrapercenter.com/building/willis-tower/169" }
  ],
  "Hearst Tower": [
    { title: "Hearst Headquarters", url: "https://www.fosterandpartners.com/projects/hearst-headquarters" },
    { title: "Hearst Tower", url: "https://www.skyscrapercenter.com/building/hearst-tower/2684" }
  ],
  "CCTV Headquarters": [
    { title: "CCTV Headquarters engineering", url: "https://www.arup.com/projects/cctv-headquarters/" },
    { title: "CCTV Headquarters", url: "https://www.oma.com/projects/cctv-headquarters" }
  ],
  "Petronas Towers": [
    { title: "Petronas Towers", url: "https://www.skyscrapercenter.com/complex/89" },
    { title: "Petronas Towers project", url: "https://pcparch.com/work/petronas-towers" }
  ],
  "Eiffel Tower": [
    { title: "The construction of the Eiffel Tower", url: "https://www.toureiffel.paris/en/the-monument/history" },
    { title: "Eiffel Tower structure", url: "https://structurae.net/en/structures/eiffel-tower" }
  ],
  "30 St Mary Axe": [
    { title: "30 St Mary Axe", url: "https://www.fosterandpartners.com/projects/30-st-mary-axe" },
    { title: "30 St Mary Axe", url: "https://www.skyscrapercenter.com/building/30-st-mary-axe/1655" }
  ],
  "Florence Cathedral": [
    { title: "Brunelleschi's Dome", url: "https://duomo.firenze.it/en/discover/dome" },
    { title: "Florence Cathedral dome", url: "https://www.britannica.com/topic/Cathedral-of-Santa-Maria-del-Fiore" }
  ],
  "Solomon R. Guggenheim Museum": [
    { title: "Frank Lloyd Wright and the Guggenheim", url: "https://www.guggenheim.org/about-us/architecture/frank-lloyd-wright-and-the-guggenheim" },
    { title: "The Architecture of the Guggenheim Museum", url: "https://www.guggenheim.org/wp-content/uploads/2016/10/guggenheim-education-architecture-teacher-resource-final.pdf" }
  ],
  "Louvre Pyramid": [
    { title: "A pyramid for a symbol", url: "https://www.louvre.fr/en/explore/the-palace/a-pyramid-for-a-symbol" },
    { title: "Ieoh Ming Pei and the Grand Louvre", url: "https://presse.louvre.fr/ieoh-ming-pei-2/?lang=en" }
  ],
  "Kimbell Art Museum": [
    { title: "Kahn Building in Detail", url: "https://kimbellart.org/content/kahn-building-detail" }
  ],
  "Eden Project": [
    { title: "Eden Project Architecture", url: "https://www.edenproject.com/mission/architecture" }
  ],
  "Lloyd's building": [
    { title: "Lloyd's of London", url: "https://rshp.com/projects/office/lloyds-of-london/" }
  ],
  "30 Hudson Yards": [
    { title: "Hudson Yards Eastern Platform", url: "https://www.related.com/press-releases/2014-03-19/related-companies-and-oxford-properties-group-commence-construction" },
    { title: "Hudson Yards platform engineering", url: "https://www.related.com/news-articles/2014/03/19/hudson-yards-starts-next-phase-deck-begins/News-Bloomberg-Platform-20140319.pdf" }
  ],
  "One World Trade Center": [
    { title: "One World Trade Center", url: "https://www.som.com/projects/one-world-trade-center/" },
    { title: "One World Trade Center crowned tallest", url: "https://www.som.com/news/one-world-trade-center-crowned-tallest-building-in-u-s/" }
  ],
  "Bank of China Tower": [
    { title: "Bank of China Tower by Pei Cobb Freed", url: "https://pcf-prod.typeco.de/projects/bank-of-china-tower/" },
    { title: "About BOC Tower", url: "https://www.bochk.com/m/en/aboutus/corpprofile/boctower.html" }
  ],
  "Citigroup Center": [
    { title: "Citicorp Center lessons", url: "https://www.nspe.org/career-growth/pe-magazine/issue-1-2026/engineering-innovation-risk-discovery-ethical-reflection" },
    { title: "Modern reassessment of Citicorp Building", url: "https://www.nist.gov/publications/modern-reassessment-citicorp-building-design-wind-loads" },
    { title: "The Citicorp Tower structural reference", url: "https://www.suncam.com/miva/downloads/docs/373.pdf" }
  ],
  "Metropol Parasol": [
    { title: "Metropol Parasol by J.MAYER.H", url: "https://jmayerh.de/metropol-parasol/" },
    { title: "Metropol Parasol structural reference", url: "https://www.dlubal.com/en/downloads-and-information/references/customer-projects/000480" }
  ],
  "Habitat 67": [
    { title: "Habitat 67 building system", url: "https://www.pci.org/PCI_Docs/Publications/PCI%20Journal/1967/February-1967/Habitat%2067%20-%20Towards%20the%20Development%20of%20a%20Building%20System.pdf" }
  ],
  "Marina Bay Sands": [
    { title: "Marina Bay Sands", url: "https://www.safdiearchitects.com/projects/marina-bay-sands" },
    { title: "Marina Bay Sands engineering", url: "https://www.arup.com/projects/marina-bay-sands/" }
  ],
  "Beijing National Stadium": [
    { title: "Chinese National Stadium engineering", url: "https://www.arup.com/en-us/projects/chinese-national-stadium/" },
    { title: "National Stadium by Herzog & de Meuron", url: "https://www.herzogdemeuron.com/projects/226-national-stadium/" }
  ],
  "Centre Pompidou": [
    { title: "Centre Pompidou engineering", url: "https://www.arup.com/projects/centre-pompidou/" },
    { title: "Centre Pompidou engineering retrospective", url: "https://www.arup.com/globalassets/downloads/arup-journal/the-arup-journal-50th-anniversary-issue.pdf" },
    { title: "Centre Pompidou overview", url: "https://en.wikipedia.org/wiki/Centre_Pompidou" }
  ],
  "Beijing National Aquatics Center": [
    { title: "National Aquatics Center engineering", url: "https://www.arup.com/en-us/projects/national-aquatics-center-water-cube/" },
    { title: "Beijing National Aquatics Center overview", url: "https://en.wikipedia.org/wiki/Beijing_National_Aquatics_Center" }
  ],
  "Hoover Dam": [
    { title: "Hoover Dam concrete cooling", url: "https://www.usbr.gov/lc/hooverdam/history/essays/concrete.html" },
    { title: "Hoover Dam historical construction photographs", url: "https://www.usbr.gov/lc/hooverdam/gallery/historicviews.html" },
    { title: "Bureau of Reclamation historical essays", url: "https://www.usbr.gov/history/Symposium_2008/Historical_Essays.pdf" },
    { title: "Hoover Dam ASCE landmark", url: "https://www.asce.org/about-civil-engineering/history-and-heritage/historic-landmarks/hoover-dam/" },
    { title: "Hoover Dam National Park Service", url: "https://www.nps.gov/articles/nevada-and-arizona-hoover-dam.htm" }
  ],
  "Falkirk Wheel": [
    { title: "The Falkirk Wheel", url: "https://www.scottishcanals.co.uk/visit/canals/visit-the-forth-clyde-canal/attractions/the-falkirk-wheel" },
    { title: "Falkirk Wheel engineering", url: "https://www.asme.org/topics-resources/content/symbol-of-the-millennium-the-falkirk-wheel" }
  ],
  "Eden Project": [
    { title: "Eden Project architecture", url: "https://www.edenproject.com/mission/architecture" },
    { title: "Creating the Eden environment", url: "https://www.arup.com/globalassets/downloads/arup-journal/the-arup-journal-2002-issue-1.pdf" }
  ],
  "Millau Viaduct": [
    { title: "Millau Viaduct", url: "https://www.fosterandpartners.com/projects/millau-viaduct" },
    { title: "Millau Viaduct construction", url: "https://www.eiffagegeniecivil.com/milau-viaduct" }
  ],
  "Golden Gate Bridge": [
    { title: "How the Bridge Spans the Golden Gate", url: "https://www.goldengate.org/exhibits/how-the-bridge-spans-the-golden-gate/" },
    { title: "Golden Gate Bridge Design and Construction Stats", url: "https://www.goldengate.org/bridge/history-research/statistics-data/design-construction-stats/" },
    { title: "Golden Gate Bridge FHWA fact sheet", url: "https://www.fhwa.dot.gov/candc/factsheets/goldengatebridge.pdf" },
    { title: "Golden Gate Bridge ASCE landmark", url: "https://www.asce.org/about-civil-engineering/history-and-heritage/historic-landmarks/golden-gate-bridge" }
  ],
  "Thames Barrier": [
    { title: "The Thames Barrier", url: "https://www.gov.uk/guidance/the-thames-barrier" },
    { title: "Thames Barrier closed for 200th time", url: "https://www.gov.uk/government/news/thames-barrier-closed-for-200th-time" },
    { title: "Thames Barrier engineering", url: "https://www.ice.org.uk/what-is-civil-engineering/infrastructure-projects/thames-barrier" }
  ],
  "Lotte World Tower": [
    { title: "Review of wind tunnel tests of Lotte World Tower", url: "https://structurae.net/en/literature/conference-paper/review-of-wind-tunnel-tests-of-lotte-world-tower/preview-download" },
    { title: "Lotte World Tower: Seoul's First Supertall", url: "https://global.ctbuh.org/resources/papers/download/3603-lotte-world-tower-seouls-first-supertall.pdf" },
    { title: "Lotte World Tower wind engineering", url: "https://www.tesolution.com/pedestrianwindenvtest-kr.html" }
  ]
};

const caseEvidenceAliases = {
  "롯데월드타워": "Lotte World Tower",
  "솔로몬 R. 구겐하임 미술관": "Solomon R. Guggenheim Museum",
  "구겐하임 미술관": "Solomon R. Guggenheim Museum",
  "루브르 피라미드": "Louvre Pyramid",
  "킴벨 미술관": "Kimbell Art Museum",
  "원 월드 트레이드 센터": "One World Trade Center",
  "중국은행 타워": "Bank of China Tower",
  "뱅크 오브 차이나 타워": "Bank of China Tower",
  "시티그룹 센터": "Citigroup Center",
  "씨티그룹 센터": "Citigroup Center",
  "메트로폴 파라솔": "Metropol Parasol",
  "해비타트 67": "Habitat 67",
  "마리나 베이 샌즈": "Marina Bay Sands",
  "시드니 오페라 하우스": "Sydney Opera House",
  "밀레니엄 브리지": "Millennium Bridge London",
  "30 세인트 메리 액스": "30 St Mary Axe",
  "윌리스 타워": "Willis Tower",
  "타이베이 101": "Taipei 101",
  "부르즈 할리파": "Burj Khalifa",
  "골든게이트교": "Golden Gate Bridge",
  "골든 게이트 브리지": "Golden Gate Bridge",
  "템스 배리어": "Thames Barrier"
};

function evidenceSourcesForCase(sourceTitle) {
  return caseEvidenceSources[caseEvidenceAliases[sourceTitle] || sourceTitle] || [];
}

const visualKeywords = [
  "성", "도시", "산", "강", "바다", "길", "지도", "배", "철도", "터널",
  "다리", "댐", "바람", "압력", "흐름", "파도", "항공", "우주", "지진",
  "화산", "전쟁", "통신", "시장", "궁궐", "건축", "구조", "기계"
];

const riskKeywords = [
  "음모", "비밀", "학살", "민족", "종교", "전쟁범죄", "논란", "정치",
  "성별", "인종", "범죄"
];

const sourceEvidenceKeywords = {
  history: [
    "조선", "세종", "실록", "제도", "관청", "군사", "통신", "관리", "세금",
    "성곽", "도성", "수군", "선박", "시장", "문서", "왕조", "지방", "중앙"
  ],
  engineering: [
    "원리", "구조", "하중", "압력", "설계", "장치", "재료", "공학", "작용",
    "흐름", "힘", "진동", "열", "에너지", "structure", "load", "design",
    "engineering", "wind", "vibration", "concrete", "steel", "force", "damping",
    "foundation", "shell", "frame", "heat", "pressure"
  ],
  science: [
    "원리", "현상", "관측", "실험", "반응", "구조", "변화", "에너지",
    "입자", "세포", "궤도", "대기", "지구"
  ]
};

const genericSourceTitles = new Set([
  "조선",
  "조선의 역사",
  "조선 시대",
  "조선 시대 연표",
  "한국의 역사",
  "대한민국의 역사",
  "서울특별시",
  "경기도",
  "황령산",
  "장시성",
  "정약용",
  "봉수",
  "봉수대로",
  "공주 충청감영 측우기",
  "세종",
  "문종",
  "단종",
  "세조",
  "성종",
  "연산군",
  "중종",
  "광해군"
]);

const noisyTitleFragments = [
  "동음이의",
  "목록",
  "연표",
  "분류:",
  "위키백과",
  "틀:"
];

const mechanismKeywords = {
  history: [
    "법", "제", "도", "성", "선", "기", "활자", "시장", "장시", "봉수",
    "역참", "의궤", "세곡", "화성", "산성", "해자", "길드", "철도", "전신"
  ],
  engineering: [
    "구조", "설계", "댐퍼", "아치", "터널", "콘크리트", "기어", "터빈",
    "엔진", "베어링", "펌프", "양력", "항력", "날개", "와류", "층류", "난류"
  ],
  science: [
    "원리", "렌즈", "궤도", "중력", "블랙홀", "복사", "세포", "DNA",
    "반응", "촉매", "전기분해", "평형", "판", "지진", "화산", "해류"
  ]
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

function parseStoredJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function mapTopicRow(topic) {
  return {
    id: topic.id,
    mainTopic: topic.mainTopic,
    subtopic: topic.subtopic,
    title: topic.title,
    hook: topic.hook,
    reviewStatus: topic.reviewStatus,
    lifecycleStatus: topic.lifecycleStatus,
    scores: {
      verification: topic.verification,
      visual: topic.visual,
      novelty: topic.novelty,
      lengthFit: topic.lengthFit,
      distortionRisk: topic.distortionRisk
    },
    sourceTitle: topic.sourceTitle,
    sourceUrl: topic.sourceUrl,
    runLane: topic.runLane || "production",
    externalKey: topic.externalKey || "",
    candidate: parseStoredJson(topic.candidateJson, {}),
    visualPreflight: parseStoredJson(topic.visualPreflightJson, {}),
    canaryAiPassAt: topic.canaryAiPassAt || null,
    canaryAiPass: parseStoredJson(topic.canaryAiPassJson, {}),
    lastError: topic.lastError || ""
  };
}

function mapFactCheckRow(row) {
  if (!row) return null;
  const raw = parseStoredJson(row.rawJson, {});
  const visualEvidence = raw.visualEvidence || raw.secondAttempt?.visualEvidence || raw.firstAttempt?.visualEvidence || [];
  return {
    id: row.id,
    topicId: row.topicId,
    status: row.status,
    confidence: row.confidence,
    coreClaim: row.coreClaim,
    claims: parseStoredJson(row.claimsJson, []),
    verifiedFacts: parseStoredJson(row.verifiedFactsJson, []),
    visualEvidence: Array.isArray(visualEvidence) ? visualEvidence : [],
    unresolved: parseStoredJson(row.unresolvedJson, []),
    simplifications: parseStoredJson(row.simplificationsJson, []),
    sources: parseStoredJson(row.sourcesJson, []),
    verdictReason: row.verdictReason,
    nextAction: row.nextAction,
    attempt: row.attempt,
    enrichmentQueries: parseStoredJson(row.enrichmentQueriesJson, []),
    enrichmentSources: parseStoredJson(row.enrichmentSourcesJson, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapProductionBriefRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    topicId: Number(row.topicId),
    factCheckId: Number(row.factCheckId),
    status: row.status,
    domainKey: row.domainKey,
    narrativeType: row.narrativeType,
    scopeStatement: row.scopeStatement,
    coreQuestion: row.coreQuestion,
    causalChain: parseStoredJson(row.causalChainJson, []),
    visualStates: parseStoredJson(row.visualStatesJson, []),
    forbiddenInferences: parseStoredJson(row.forbiddenInferencesJson, []),
    lengthGuidance: parseStoredJson(row.lengthGuidanceJson, {}),
    quality: parseStoredJson(row.qualityJson, {}),
    raw: parseStoredJson(row.rawJson, {}),
    revision: Number(row.revision || 1),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapBenchmarkCaseRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    caseKey: row.caseKey,
    topicId: row.topicId == null ? null : Number(row.topicId),
    label: row.label,
    domainKey: row.domainKey,
    mechanismType: row.mechanismType,
    requiredStages: parseStoredJson(row.requiredStagesJson, []),
    expectations: parseStoredJson(row.expectationsJson, {}),
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapScriptRow(row) {
  if (!row) return null;
  const raw = parseStoredJson(row.rawJson, {});
  const scriptMeta = raw.finalScript || raw.generation || raw;
  return {
    id: row.id,
    topicId: row.topicId,
    status: row.status,
    coreQuestion: row.coreQuestion,
    coreConflict: row.coreConflict,
    coreMechanism: row.coreMechanism || row.turningPoint,
    visibleFlow: row.visibleFlow,
    turningPoint: row.turningPoint,
    uniqueDifferentiator: row.uniqueDifferentiator || "",
    designIntervention: row.designIntervention || row.turningPoint,
    tradeoffs: parseStoredJson(row.tradeoffsJson, []),
    limitations: parseStoredJson(row.limitationsJson, []),
    narrativeType: scriptMeta.narrativeType || "problem_solution",
    narrativeReason: scriptMeta.narrativeReason || "",
    causalContext: Array.isArray(scriptMeta.causalContext) ? scriptMeta.causalContext : [],
    lengthPlan: scriptMeta.lengthPlan || null,
    signaturePlan: scriptMeta.signaturePlan || null,
    qualityReviews: Array.isArray(raw.qualityReviews) ? raw.qualityReviews : [],
    productionScript: parseStoredJson(row.productionScriptJson, []),
    ttsText: row.ttsText,
    notes: parseStoredJson(row.notesJson, []),
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapVoicePresetRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    mode: row.mode,
    language: row.language,
    styleInstruction: row.styleInstruction,
    speakerKey: row.speakerKey,
    referenceAudioPath: row.referenceAudioPath,
    sampleText: row.sampleText || TTS_EXAMPLE_TEXT,
    sampleAudioPath: row.sampleAudioPath,
    sampleAudioUrl: pathToStaticUrl(row.sampleAudioPath),
    sampleDurationSec: row.sampleDurationSec,
    notes: row.notes,
    isDefault: Boolean(row.isDefault),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapTtsRunRow(row) {
  if (!row) return null;
  const segments = listTtsSegmentsByRunStatement.all(row.id).map((segment) => ({
    id: segment.id,
    runId: segment.runId,
    topicId: segment.topicId,
    scriptId: segment.scriptId,
    segmentIndex: segment.segmentIndex,
    label: segment.label,
    plannedTime: segment.plannedTime,
    text: segment.text,
    audioPath: segment.audioPath,
    audioUrl: pathToStaticUrl(segment.audioPath),
    durationSec: segment.durationSec,
    estimatedDurationSec: segment.estimatedDurationSec,
    status: segment.status,
    createdAt: segment.createdAt,
    updatedAt: segment.updatedAt
  }));

  return {
    id: row.id,
    topicId: row.topicId,
    scriptId: row.scriptId,
    voicePresetId: row.voicePresetId,
    status: row.status,
    engine: row.engine,
    language: row.language,
    totalDurationSec: row.totalDurationSec,
    estimatedTotalDurationSec: row.estimatedTotalDurationSec,
    outputPath: row.outputPath,
    outputUrl: pathToStaticUrl(row.outputPath),
    error: row.error,
    segments,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapShotlistRow(row) {
  if (!row) return null;
  const items = listShotlistItemsStatement.all(row.id).map((item) => ({
    id: item.id,
    shotlistId: item.shotlistId,
    topicId: item.topicId,
    sortIndex: item.sortIndex,
    sceneId: item.sceneId,
    keyframeId: item.keyframeId,
    clipId: item.clipId,
    sourceSegmentIndex: item.sourceSegmentIndex,
    sourceSegmentOrder: item.sourceSegmentOrder,
    visualStateId: item.visualStateId,
    evidenceBeatId: item.evidenceBeatId,
    startSec: item.startSec,
    endSec: item.endSec,
    durationSec: item.durationSec,
    scriptExcerpt: item.scriptExcerpt,
    scenePurpose: item.scenePurpose,
    cleanContent: item.cleanContent,
    infoFocus: item.infoFocus,
    cameraMotion: item.cameraMotion,
    shotRole: item.shotRole,
    visualFamily: item.visualFamily,
    referencePolicy: item.referencePolicy,
    motionPolicy: item.motionPolicy,
    requiredVisibleElements: parseStoredJson(item.requiredVisibleJson, []),
    forbiddenVisibleElements: parseStoredJson(item.forbiddenVisibleJson, []),
    transitionEndState: item.transitionEndState,
    physicalState: item.physicalState,
    stateChangeReason: item.stateChangeReason,
    forceFlow: item.forceFlow,
    claimRefs: parseStoredJson(item.claimRefsJson, []),
    cleanPrompt: item.cleanPrompt,
    infoPrompt: item.infoPrompt,
    infoSpec: parseStoredJson(item.infoSpecJson, {}),
    videoPrompt: item.videoPrompt,
    fileStub: item.fileStub,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }));

  return {
    id: row.id,
    topicId: row.topicId,
    scriptId: row.scriptId,
    ttsRunId: row.ttsRunId,
    status: row.status,
    totalDurationSec: row.totalDurationSec,
    clipCount: row.clipCount,
    manifestPath: row.manifestPath,
    manifestUrl: pathToStaticUrl(row.manifestPath),
    notes: parseStoredJson(row.notesJson, []),
    raw: parseStoredJson(row.rawJson, {}),
    approvedAt: row.approvedAt,
    items,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.round(number), max));
}

function isCommandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  return !result.error && result.status === 0;
}

function pathToStaticUrl(filePath) {
  if (!filePath) return "";
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
  const relative = path.relative(__dirname, absolute).replace(/\\/gu, "/");
  return `/${relative}`;
}

function toRelativeWorkspacePath(filePath) {
  return path.relative(__dirname, filePath).replace(/\\/gu, "/");
}

function resolveWorkspacePath(filePath) {
  if (!filePath) return "";
  return path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
}

function findLocalExecutable(rootDir, executableName) {
  if (!existsSync(rootDir)) return "";
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolute);
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase() === executableName.toLowerCase()) {
          return absolute;
        }
      }
    } catch {
      return "";
    }
  }
  return "";
}

function findExistingDirectory(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

function getMinimaxH3LocalStatus() {
  const required = [
    ["diffusion model", path.join("models", "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors")],
    ["text encoder", path.join("models", "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors")],
    ["video vae", path.join("models", "vae", "minimax_h3_video_vae_fp16.safetensors")]
  ];
  const files = required.map(([label, relativePath]) => {
    const absolute = COMFYUI_DIR ? path.join(COMFYUI_DIR, relativePath) : "";
    return {
      label,
      relativePath: relativePath.replace(/\\/gu, "/"),
      exists: Boolean(absolute && existsSync(absolute))
    };
  });
  const turboLoraPath = COMFYUI_DIR ? path.join(COMFYUI_DIR, "models", "loras", H3_TURBO_LORA) : "";
  const profiles = Object.values(H3_VIDEO_PROFILES).map((profile) => ({
    ...profile,
    ready: !profile.loraName || Boolean(turboLoraPath && existsSync(turboLoraPath))
  }));

  return {
    mode: "MiniMax H3 Local / ComfyUI",
    comfyuiDir: COMFYUI_DIR,
    comfyuiReady: Boolean(COMFYUI_DIR),
    modelReady: files.every((file) => file.exists),
    files,
    workflow: toRelativeWorkspacePath(H3_WORKFLOW_PATH),
    workflowReady: existsSync(H3_WORKFLOW_PATH),
    turboLoraReady: Boolean(turboLoraPath && existsSync(turboLoraPath)),
    profiles,
    defaultProfileId: "quality",
    serverUrl: COMFYUI_URL
  };
}

function mapVideoJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    topicId: row.topic_id,
    clipIndex: row.clip_index,
    status: row.status,
    promptId: row.prompt_id,
    inputPath: row.input_path,
    outputPath: row.output_path,
    requestedDurationSec: row.requested_duration_sec,
    actualDurationSec: row.actual_duration_sec,
    profileId: row.profile_id || "quality",
    settings: parseStoredJson(row.settings_json, {}),
    seed: Number(row.seed || 0),
    qcStatus: row.qc_status || "pending",
    qcNote: row.qc_note || "",
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    videoCodec: row.video_codec || "",
    hasAudio: Boolean(row.has_audio),
    fileSize: row.file_size == null ? null : Number(row.file_size),
    rawOutputPath: row.raw_output_path || "",
    autoQc: parseStoredJson(row.auto_qc_json, {}),
    sourceFingerprint: row.source_fingerprint || "",
    staleReason: row.stale_reason || "",
    staleAt: row.stale_at || null,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function getVoiceReferencePath(voicePreset) {
  const explicitReference = String(voicePreset.referenceAudioPath || "").trim();
  const lockedSample = String(voicePreset.sampleAudioPath || "").trim();
  const candidate = explicitReference || lockedSample;
  if (!candidate) return "";
  return resolveWorkspacePath(candidate);
}

function getVoicePromptText(voicePreset) {
  return String(voicePreset.sampleText || TTS_EXAMPLE_TEXT).trim();
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: __dirname,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function runJsonPython(scriptPath, payload, prefix) {
  const jobPath = path.join(MEDIA_JOB_DIR, `${prefix}-${Date.now()}-${randomUUID()}.json`);
  await writeFile(jobPath, JSON.stringify(payload, null, 2), "utf8");
  try {
    const { stdout } = await runProcess(PYTHON_BIN, [scriptPath, jobPath], {
      env: { PYTHONIOENCODING: "utf-8" }
    });
    const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
    const jsonLine = [...lines].reverse().find((line) => line.trim().startsWith("{"));
    return JSON.parse(jsonLine || stdout.trim());
  } finally {
    await unlink(jobPath).catch(() => {});
  }
}

async function inspectImageAsset(filePath, references = []) {
  const result = await runJsonPython(MEDIA_QC_RUNNER, {
    mode: "image",
    path: filePath,
    references
  }, "image-qc");
  await writeFile(`${filePath}.qc.json`, JSON.stringify(result, null, 2), "utf8");
  return result;
}

async function inspectInfoAsset({
  cleanPath,
  infoPath,
  overlayPath,
  guidesPath,
  labelsPath,
  spec,
  render,
  claimRefs,
  layoutTrusted
}) {
  const result = await runJsonPython(MEDIA_QC_RUNNER, {
    mode: "info",
    cleanPath,
    infoPath,
    overlayPath,
    guidesPath,
    labelsPath,
    spec,
    render,
    claimRefs,
    layoutTrusted
  }, "info-qc");
  await writeFile(`${infoPath}.qc.json`, JSON.stringify(result, null, 2), "utf8");
  return result;
}

async function fingerprintApprovedInputs(cleanPath, infoPath) {
  const hash = createHash("sha256");
  for (const filePath of [cleanPath, infoPath]) {
    hash.update(path.basename(filePath));
    hash.update(await readFile(filePath));
  }
  return hash.digest("hex");
}

function markVideoJobsStale(topicId, clipIndex, reason) {
  db.prepare(`
    UPDATE video_jobs
    SET status = 'stale', qc_status = 'pending', stale_reason = ?, stale_at = CURRENT_TIMESTAMP,
        error = CASE WHEN status = 'running' THEN '입력 자산 변경으로 결과를 폐기했습니다.' ELSE error END
    WHERE topic_id = ? AND clip_index = ?
      AND status IN ('queued', 'completed', 'blocked_qc', 'failed')
  `).run(String(reason || "입력 자산이 변경되었습니다.").slice(0, 1000), topicId, clipIndex);
}

async function runVoxcpmJob(job) {
  await mkdir(path.dirname(job.outputMasterPath || job.outputs?.[0]?.path || AUDIO_DIR), { recursive: true });
  const jobPath = path.join(TTS_JOB_DIR, `${job.kind || "tts"}-${Date.now()}-${randomUUID()}.json`);
  await writeFile(jobPath, JSON.stringify(job, null, 2), "utf8");
  const { stdout } = await runProcess(PYTHON_BIN, [VOXCPM_RUNNER, jobPath], {
    env: {
      PYTHONIOENCODING: "utf-8",
      HF_HUB_DISABLE_SYMLINKS_WARNING: "1"
    }
  });
  try {
    const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
    const jsonLine = [...lines].reverse().find((line) => line.trim().startsWith("{"));
    return JSON.parse(jsonLine || stdout.trim());
  } catch {
    throw new Error(`TTS 결과 JSON을 읽지 못했습니다: ${stdout.slice(0, 500)}`);
  }
}

function getGpuStatus() {
  const result = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return { available: false, detail: "" };
  }
  return { available: true, detail: result.stdout.trim() };
}

function estimateKoreanTtsDuration(text) {
  const normalized = String(text || "").replace(/\s+/gu, " ").trim();
  if (!normalized) return 0;
  const hangulCount = (normalized.match(/[가-힣]/gu) || []).length;
  const latinWordCount = (normalized.match(/[A-Za-z0-9]+/gu) || []).length;
  const punctuationPauses = (normalized.match(/[,.!?。？！,，.]/gu) || []).length * 0.16;
  const sentencePauses = (normalized.match(/[.!?。？！]/gu) || []).length * 0.26;
  const hangulSeconds = hangulCount / 5.6;
  const latinSeconds = latinWordCount / 2.45;
  const baseEstimate = hangulSeconds + latinSeconds + punctuationPauses + sentencePauses;
  return Math.max(1.2, Number((baseEstimate * 1.2).toFixed(2)));
}

function buildTtsSegmentsFromScript(script) {
  const productionScript = parseStoredJson(script.productionScriptJson, []);
  if (productionScript.length) {
    return productionScript.map((row, index) => {
      const text = String(row.narration || row.ttsText || "").trim();
      return {
        segmentIndex: index + 1,
        label: String(row.beat || `S${String(index + 1).padStart(2, "0")}`).trim(),
        plannedTime: String(row.time || "").trim(),
        text,
        estimatedDurationSec: estimateKoreanTtsDuration(text)
      };
    }).filter((segment) => segment.text);
  }

  return String(script.ttsText || "")
    .split(/(?<=[.!?。？！])\s+/u)
    .map((text, index) => ({
      segmentIndex: index + 1,
      label: `TTS-${String(index + 1).padStart(2, "0")}`,
      plannedTime: "",
      text: text.trim(),
      estimatedDurationSec: estimateKoreanTtsDuration(text)
    }))
    .filter((segment) => segment.text);
}

function formatTimecode(seconds) {
  const safeSeconds = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

function slugKorean(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 28) || "scene";
}

function getProjectDir(topicId) {
  return path.join(PROJECTS_DIR, `topic-${topicId}`);
}

async function ensureProjectFolders(topicId) {
  const projectDir = getProjectDir(topicId);
  await Promise.all(["script", "clean", "info", "video", "edit", "manifests", "prompts"].map((folder) => (
    mkdir(path.join(projectDir, folder), { recursive: true })
  )));
  return projectDir;
}

async function archiveFailedAssetForQualityRepair({ topicId, clipIndex, assetType, primaryPath, artifactPaths, note }) {
  const archiveDir = path.join(getProjectDir(topicId), assetType, "rejected");
  await mkdir(archiveDir, { recursive: true });
  const archiveKey = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const archived = [];
  for (const sourcePath of artifactPaths) {
    if (!sourcePath || !existsSync(sourcePath)) continue;
    const extension = path.extname(sourcePath);
    const archivePath = path.join(archiveDir, `${path.basename(sourcePath, extension)}-${archiveKey}${extension}`);
    await copyFile(sourcePath, archivePath);
    archived.push({ sourcePath, archivePath: toRelativeWorkspacePath(archivePath) });
  }
  const primary = archived.find((entry) => entry.sourcePath === primaryPath);
  if (primary) {
    reviewAsset({
      topicId,
      clipIndex,
      assetType,
      assetPath: primary.archivePath,
      status: "REPLACE_CANDIDATE",
      note: `${note} (품질 교체 전 보관본)`
    });
  }
  return { archiveDir: toRelativeWorkspacePath(archiveDir), primaryPath: primary?.archivePath || "", artifacts: archived };
}

function getProductionScriptRow(script, segmentIndex) {
  const rows = Array.isArray(script?.productionScript) ? script.productionScript : [];
  return rows[segmentIndex - 1] || {};
}

function determineShotCount(totalDurationSec) {
  const duration = Number(totalDurationSec || 0);
  if (duration <= 0) return 0;
  const minimumCoverage = Math.ceil(duration / 4);
  const maximumUsefulCount = Math.max(minimumCoverage, Math.floor(duration / 1.5));
  const contentPacedTarget = Math.ceil(duration / 3.4);
  return clampInteger(contentPacedTarget, minimumCoverage, maximumUsefulCount, minimumCoverage);
}

function getShotlistTimeline(ttsRun) {
  const segments = ttsRun?.segments || [];
  const measuredTotalDurationSec = Number(ttsRun?.totalDurationSec || 0);
  const segmentTotalDurationSec = segments.reduce((sum, segment) => (
    sum + Number(segment.durationSec || segment.estimatedDurationSec || 0)
  ), 0);
  const timelineDurations = segments.map((segment) => (
    Number(segment.durationSec || segment.estimatedDurationSec || 0)
  ));
  let remainingGapSec = Math.max(0, measuredTotalDurationSec - segmentTotalDurationSec);
  for (const [index, duration] of timelineDurations.entries()) {
    const availableSec = Math.max(0, NATIVE_CLIP_DURATION_SEC - duration);
    const assignedGapSec = Math.min(availableSec, remainingGapSec);
    timelineDurations[index] += assignedGapSec;
    remainingGapSec -= assignedGapSec;
  }
  return {
    measuredTotalDurationSec,
    timelineDurations,
    minimumCoverageCount: Math.max(1, Math.ceil(measuredTotalDurationSec / NATIVE_CLIP_DURATION_SEC))
  };
}

function getShotlistEvidenceCapacity(script, productionBrief) {
  const stateIds = [...new Set((script?.productionScript || [])
    .map((row) => String(row.visualStateId || "").trim())
    .filter(Boolean))];
  const states = new Map((productionBrief?.visualStates || []).map((state) => [String(state.stateId || "").trim(), state]));
  const verifiedEvidenceBeatCount = stateIds.reduce((count, stateId) => {
    const beatIds = new Set((states.get(stateId)?.evidenceBeats || [])
      .map((beat) => String(beat?.beatId || "").trim())
      .filter(Boolean));
    return count + Math.max(1, beatIds.size);
  }, 0);
  return {
    verifiedStateCount: stateIds.length,
    verifiedEvidenceBeatCount,
    verifiedEvidenceCapacity: stateIds.length
  };
}

function determineEvidenceBoundShotCount(_script, _productionBrief, _totalDurationSec, minimumCoverageCount) {
  return minimumCoverageCount;
}

function allocateShotCounts(segments, targetCount, timelineDurations = []) {
  const weighted = segments.map((segment, index) => ({
    segment,
    duration: Number(timelineDurations[index] || segment.durationSec || segment.estimatedDurationSec || 0),
    count: Math.max(1, Math.ceil(Number(timelineDurations[index] || segment.durationSec || segment.estimatedDurationSec || 0) / 4))
  }));
  const totalDuration = weighted.reduce((sum, item) => sum + item.duration, 0);
  if (!segments.length || !totalDuration) {
    return weighted.map((item) => item.count);
  }

  let assigned = weighted.reduce((sum, item) => sum + item.count, 0);
  while (assigned < targetCount) {
    const candidate = weighted
      .filter((item) => item.duration / (item.count + 1) >= 1.5)
      .sort((a, b) => (b.duration / (b.count + 1)) - (a.duration / (a.count + 1)))[0];
    if (!candidate) break;
    candidate.count += 1;
    assigned += 1;
  }

  while (assigned > targetCount) {
    const candidate = weighted
      .filter((item) => item.count > 1)
      .sort((a, b) => (a.duration / a.count) - (b.duration / b.count))[0];
    if (!candidate) break;
    candidate.count -= 1;
    assigned -= 1;
  }

  return weighted.map((item) => item.count);
}

function inferScreenDirectionContract(script, factCheck) {
  const corpus = [
    ...(factCheck?.simplifications || []),
    ...(script?.productionScript || []).flatMap((row) => [row.visualDirection, row.stateChangeReason, row.forceFlow])
  ].filter(Boolean).join("\n");
  const labels = "북쪽|남쪽|동쪽|서쪽|상류|하류|입구|출구|전면|후면";
  const direct = corpus.match(new RegExp(`(${labels})(?:은|는)?\\s*(?:화면\\s*)?왼쪽\\s*[,·/]\\s*(${labels})(?:은|는)?\\s*(?:화면\\s*)?오른쪽`, "u"));
  if (direct?.[1] && direct?.[2] && direct[1] !== direct[2]) {
    return { left: direct[1], right: direct[2] };
  }
  const left = corpus.match(new RegExp(`(${labels})[^.\\n]{0,24}(?:화면\\s*)?왼쪽`, "u"))?.[1]
    || corpus.match(new RegExp(`(?:화면\\s*)?왼쪽[^.\\n]{0,24}(${labels})`, "u"))?.[1];
  const right = corpus.match(new RegExp(`(${labels})[^.\\n]{0,24}(?:화면\\s*)?오른쪽`, "u"))?.[1]
    || corpus.match(new RegExp(`(?:화면\\s*)?오른쪽[^.\\n]{0,24}(${labels})`, "u"))?.[1];
  return left && right && left !== right ? { left, right } : null;
}

function getAiSceneContractIssues(scenes, directionContract) {
  const issues = [];
  for (const scene of scenes || []) {
    const label = `TTS ${scene.sourceSegmentIndex}-${scene.sourceSegmentOrder}`;
    const physicalText = [scene.cleanContent, scene.physicalState, ...(scene.requiredVisibleElements || [])].join(" ");
    if (directionContract) {
      const wrongLeft = new RegExp(`(?:화면\\s*)?왼쪽(?:은|이|의|에는|에서|으로)?\\s*(?:방향\\s*)?${directionContract.right}|${directionContract.right}(?:은|이|의|에는|에서)?\\s*(?:화면\\s*)?왼쪽`, "u");
      const wrongRight = new RegExp(`(?:화면\\s*)?오른쪽(?:은|이|의|에는|에서|으로)?\\s*(?:방향\\s*)?${directionContract.left}|${directionContract.left}(?:은|이|의|에는|에서)?\\s*(?:화면\\s*)?오른쪽`, "u");
      if (wrongLeft.test(physicalText) || wrongRight.test(physicalText)) {
        issues.push(`${label}: 화면 방향 위반. ${directionContract.left}=왼쪽, ${directionContract.right}=오른쪽이어야 합니다.`);
      }
    }
    const abstractRequired = (scene.requiredVisibleElements || []).filter((value) => (
      /화살표|라벨|텍스트|문자|숫자|수치|축선|중심축|이전\s*축|이후\s*축|두\s*축|탑의\s*축|기준선|그래픽|HUD/iu.test(String(value))
    ));
    if (abstractRequired.length) {
      issues.push(`${label}: CLEAN 필수 요소에 INFO 그래픽 개념이 섞였습니다 (${abstractRequired.join(" / ")}). 실제 물체·재료·변형으로 바꾸세요.`);
    }
  }
  issues.push(...getInfoNarrativePlanIssues(scenes));
  return issues;
}

function buildShotPurpose(segment, row, partIndex, partCount) {
  const beat = String(row.beat || segment.label || "장면").trim();
  if (partCount === 1) return `${beat}의 핵심 정보를 한 장면으로 전달`;
  if (partIndex === 0) return `${beat}의 배경과 공간 관계 제시`;
  if (partIndex === partCount - 1) return `${beat}의 결과와 다음 장면으로 이어지는 전환`;
  return `${beat}의 원인과 흐름을 단계적으로 확대`;
}

function buildCleanContent(topic, segment, row, partIndex, partCount) {
  const visual = String(row.visualDirection || "").trim();
  const base = visual || `${topic.subtopic} 맥락에서 ${segment.label}을 보여주는 세로형 역사 다큐 장면`;
  if (partCount === 1) return base;
  const prefixes = ["도입 구도", "중간 확대", "결과 구도", "세부 강조"];
  return `${prefixes[Math.min(partIndex, prefixes.length - 1)]}: ${base}`;
}

function buildInfoFocus(segment, row, partIndex, partCount) {
  const label = String(row.beat || segment.label || "핵심").trim();
  if (partCount === 1) return `${label}을 설명하는 작은 라벨 1~2개와 핵심 흐름선`;
  if (partIndex === 0) return `${label}의 출발점과 관계를 짧은 라벨로 표시`;
  if (partIndex === partCount - 1) return `${label}의 결과 방향과 다음 흐름을 화살표로 정리`;
  return `${label}의 이동 경로, 압력점 또는 이해 포인트를 한 가지로 제한`;
}

function buildCameraMotion(index) {
  const motions = [
    "느린 push in, 5~8도",
    "절제된 pan right, 5~10도",
    "얕은 dolly left, 5~8도",
    "느린 tilt down, 5~8도",
    "static shot에 가까운 미세 push"
  ];
  return motions[(index - 1) % motions.length];
}

function buildShotlistItems(topic, script, ttsRun) {
  const segments = ttsRun.segments || [];
  const measuredTotal = Number(ttsRun.totalDurationSec || 0);
  const segmentTotal = segments.reduce((sum, segment) => sum + Number(segment.durationSec || segment.estimatedDurationSec || 0), 0);
  const gapSec = segments.length > 1 ? Math.max(0, (measuredTotal - segmentTotal) / (segments.length - 1)) : 0;
  const timelineDurations = segments.map((segment, index) => (
    Number((Number(segment.durationSec || segment.estimatedDurationSec || 0) + (index < segments.length - 1 ? gapSec : 0)).toFixed(4))
  ));
  const items = [];
  let segmentStart = 0;

  segments.forEach((segment, segmentOffset) => {
    const timelineDuration = timelineDurations[segmentOffset] || Number(segment.durationSec || segment.estimatedDurationSec || 0);
    const row = getProductionScriptRow(script, segment.segmentIndex);
    const sortIndex = items.length + 1;
    const startSec = Number(segmentStart.toFixed(2));
    const endSec = Number((segmentStart + timelineDuration).toFixed(2));
    const sceneId = `S${String(sortIndex).padStart(2, "0")}A`;
    const keyframeId = `KF-${String(sortIndex).padStart(2, "0")}A`;
    const clipId = `CLIP${String(sortIndex).padStart(2, "0")}`;
    const fileStub = `${String(sortIndex).padStart(2, "0")}_${sceneId}_${keyframeId}_${slugKorean(row.beat || segment.label)}`;
    const physicalState = String(row.physicalState || row.visualDirection || "").trim();
    const stateChangeReason = String(row.stateChangeReason || "새로운 물리 상태 또는 인과 단계").trim();
    const forceFlow = String(row.forceFlow || script.visibleFlow || "").trim();
    const claimRefs = Array.isArray(row.claimRefs) ? row.claimRefs : [];
    const infoSpec = normalizeInfoGraphicSpec(row.infoGraphic, row);
    const scenePurpose = String(row.mechanismStep || row.beat || segment.label).trim();
    const cleanContent = String(row.visualDirection || physicalState).trim();
    const infoFocus = forceFlow;
    const cameraMotion = buildCameraMotion(sortIndex);
    const cleanPrompt = buildCleanPrompt({ topic, script, row, sceneId, keyframeId, cleanContent, physicalState, cameraMotion, infoSpec });
    const infoPrompt = buildInfoPrompt({ topic, row, sceneId, keyframeId, infoFocus, forceFlow, claimRefs, infoSpec });
    const videoPrompt = buildMdVideoPrompt({ topic, sceneId, keyframeId, clipId, cameraMotion, forceFlow, scenePurpose });

    items.push({
      sortIndex,
      sceneId,
      keyframeId,
      clipId,
      sourceSegmentIndex: segment.segmentIndex,
      startSec,
      endSec,
      durationSec: Number((endSec - startSec).toFixed(2)),
      scriptExcerpt: segment.text,
      scenePurpose,
      cleanContent,
      infoFocus,
      cameraMotion,
      physicalState,
      stateChangeReason,
      forceFlow,
      claimRefs,
      cleanPrompt,
      infoPrompt,
      infoSpec,
      videoPrompt,
      fileStub
    });
    segmentStart += timelineDuration;
  });

  return items;
}

function buildCleanPrompt({
  topic, script, row, sceneId, keyframeId, cleanContent, physicalState, cameraMotion,
  shotRole = "context", visualFamily = "environment", requiredVisibleElements = [],
  forbiddenVisibleElements = [], transitionEndState = "", infoSpec = null
}) {
  const cleanInfoType = String(infoSpec?.type || "none");
  return [
    `${sceneId} / ${keyframeId}. Independent 9:16 vertical keyframe, photoreal cinematic 3D engineering documentary.`,
    `Subject: ${topic.title}. Engineering mechanism: ${script.coreMechanism}.`,
    `Narrative role: ${shotRole}. Visual family: ${visualFamily}.`,
    `Scene: ${cleanContent}. Physical state visible at this exact moment: ${physicalState}.`,
    `Required visible evidence: ${requiredVisibleElements.join(" | ") || "the stated physical state and its cause"}.`,
    `Forbidden or misleading result: ${forbiddenVisibleElements.join(" | ") || "generic beauty shot | calm unchanged state | repeated establishing composition"}.`,
    transitionEndState ? `This is the start keyframe of a verified physical transition. The separately generated end state will be: ${transitionEndState}. Do not prematurely show the completed end state.` : "",
    `Freeze one crisp physical instant. Every rigid structural part must be sharp and geometrically coherent. Do not bake in motion blur, directional blur, ghosting, repeated parts, positional echoes, or speed lines. Movement direction belongs to the later H3 video, not the CLEAN image.`,
    cleanInfoType !== "none" ? `This CLEAN is only the single base state for a later ${cleanInfoType} INFO edit. Do not pre-render labels, guides, previous poses, second endpoints, comparison outlines, or overlay geometry.` : "",
    `Show real geometry, load-bearing parts, materials, joints, environment, scale, and physically plausible cause-and-effect.`,
    `Camera: ${cameraMotion}; compose a stable first frame with usable depth, but keep the saved bitmap completely sharp.`,
    `Lighting and materials must remain consistent with adjacent scenes. Reserve natural negative space near the actual mechanism for later spatial annotations without leaving an empty template.`,
    `Scene-specific error prevention: ${row.stateChangeReason || "do not merge this physical state with adjacent stages"}.`,
    `CLEAN FRAME ONLY: no text, letters, numbers, dimensions, symbols, arrows, labels, UI, HUD, diagram overlay, logo, watermark, collage, split screen, or storyboard.`
  ].join("\n");
}

function buildInfoPrompt({ topic, row, sceneId, keyframeId, infoFocus, forceFlow, claimRefs, infoSpec }) {
  const spec = normalizeInfoGraphicSpec(infoSpec, row);
  if (spec.type === "none") {
    return [
      `${sceneId} / ${keyframeId} INFO pass intentionally contains no overlay.`,
      `Use the matching approved CLEAN image unchanged; do not create a new composition.`,
      `Preserve every pixel, camera, crop, geometry, person, physical state, light, material, texture, and background.`,
      `Do not add text, labels, arrows, lines, symbols, numbers, panels, highlights, glow, UI, HUD, or captions.`,
      `Reason: ${infoFocus || "the CLEAN frame and physical motion already communicate this beat"}.`,
      `Narrative beat: ${row.mechanismStep || row.beat || topic.title}. The video should use only restrained physical or camera motion.`
    ].join("\n");
  }
  return [
    `${sceneId} / ${keyframeId} INFO second-pass edit. Edit the matching approved CLEAN image; do not create a new composition.`,
    `Preserve exactly the camera, crop, lens, geometry, parts, people, physical state, lighting, materials, textures, and background.`,
    `Overlay type: ${spec.type}. Labels (render exactly, no paraphrase): ${spec.labels.join(" | ") || "none"}.`,
    `Anchor targets: ${spec.anchors.join(" | ") || "no valid anchor - do not draw detached guides"}.`,
    `Direction contract: ${spec.directionRule}. Comparison contract: ${spec.comparisonRule}.`,
    `Add one spatial engineering explanation: ${infoFocus}. Force or flow: ${forceFlow}.`,
    `Anchor every guide to a real component or phenomenon. Use 3D perspective, parallax, depth, and correct occlusion; never use a flat HUD.`,
    `Build separable visual components in this order: anchor, line or wavefront, arrow body, arrowhead, verified value, small Korean label, moving pulse.`,
    `Typography contract: use only ${INFO_FONT_PRESET.labelFontFamily} for every Korean label and ${INFO_FONT_PRESET.valueFontFamily} ${INFO_FONT_PRESET.valueFontWeight} for numbers, units, and emphasized values. Do not substitute serif, handwriting, display, condensed, or decorative fonts.`,
    `Keep labels short, high contrast, and large enough for a 720x1280 frame. Use a restrained dark translucent backing or a 2-3px outline only when the background reduces readability.`,
    `Verified claim references only: ${(claimRefs || []).join(", ") || "none - do not invent values"}.`,
    `Scene-specific forbidden results: ${spec.forbidden.join(" | ") || "reverse arrows | unreadable text | decorative lines"}.`,
    `Narrative beat: ${row.mechanismStep || row.beat || topic.title}. One image explains one core concept. No giant title, new object, camera change, geometry change, or unverified number. Follow the approved Pretendard typography contract exactly; do not invent typography.`
  ].join("\n");
}

function getH3FrameCount(durationSec) {
  const base = Math.max(5, Math.round(Number(durationSec || 4) * 24));
  return base + ((5 - (base % 17)) % 17);
}

function getH3EffectiveDuration(durationSec) {
  return Number((getH3FrameCount(durationSec) / 24).toFixed(3));
}

function buildMdVideoPrompt({
  topic, sceneId, keyframeId, clipId, cameraMotion, forceFlow, scenePurpose,
  durationSec = 4, motionPolicy = "first_frame", transitionEndState = ""
}) {
  const effectiveDuration = getH3EffectiveDuration(durationSec);
  const endpointRule = motionPolicy === "start_end_transition"
    ? `[last_frame ${effectiveDuration.toFixed(2)}s] Arrive smoothly at the separately supplied end keyframe showing: ${transitionEndState}. Preserve identity and geometry except for this explicitly requested physical change.`
    : `[last_frame ${effectiveDuration.toFixed(2)}s] Continue naturally from the supplied first frame. Do not loop back to the opening pose or composition.`;
  return [
    `[first_frame 0.00s] Preserve the supplied CLEAN image exactly: same subject identity, geometry, people, materials, lighting, weather, and 9:16 composition.`,
    endpointRule,
    `integrated_multimodal_description: ${clipId} / ${sceneId} / ${keyframeId}. One continuous engineering documentary shot about ${topic.title}. Use restrained ${cameraMotion}. Add only subtle physically plausible environmental motion and parallax. The visible physical flow is ${forceFlow}. Scene purpose: ${scenePurpose}. Keep the main mechanism readable and the lower caption area clear. No cuts, morphing, structural deformation, new people, new objects, text, letters, numbers, arrows, labels, UI, logo, watermark, narration, or dialogue.`,
    `overall_soundscape: silent; no generated speech, effects, ambience, or dialogue.`,
    `non_diegetic_music: none.`
  ].join("\n");
}

function renderImageSequenceMarkdown({ topic, script, ttsRun, shotlistId, items, manifestPath }) {
  const lines = [
    `# IMAGE_SEQUENCE`,
    ``,
    `- Topic ID: ${topic.id}`,
    `- 제목: ${topic.title}`,
    `- 단계: 장면표와 키프레임 수`,
    `- TTS Run: ${ttsRun.id}`,
    `- 실제 TTS 길이: ${formatTimecode(ttsRun.totalDurationSec)} (${ttsRun.totalDurationSec}초)`,
    `- 원본 영상: 클립당 4초`,
    `- 최종 편집: 각 클립 약 1.5~4초 사용`,
    `- 장면 수: ${items.length}`,
    `- 저장 파일: ${manifestPath}`,
    ``,
    `> 이 파일은 CLEAN 이미지 프롬프트가 아니라 장면표입니다. 이미지 프롬프트는 사용자 승인 후 다음 단계에서 작성합니다.`,
    ``,
    `## 핵심 구조`,
    ``,
    `- 핵심 질문: ${script.coreQuestion}`,
    `- 핵심 메커니즘: ${script.coreMechanism}`,
    `- 보이는 흐름: ${script.visibleFlow}`,
    `- 고유한 차별점: ${script.uniqueDifferentiator}`,
    ``,
    `## 장면표`,
    ``,
    `| 순서 | S ID | KF ID | CLIP | TTS 구간 | 역할 | 화면 계열 | 대본 구절 | 물리 상태 | 새 장면 이유 | 힘/흐름 | 필수 시각 요소 | 근거 | CLEAN 내용 | INFO 핵심 | 카메라 |`,
    `|---:|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|---|`
  ];

  for (const item of items) {
    lines.push([
      item.sortIndex,
      item.sceneId,
      item.keyframeId,
      item.clipId,
      `${formatTimecode(item.startSec)}~${formatTimecode(item.endSec)}`,
      item.shotRole,
      item.visualFamily,
      item.scriptExcerpt.replace(/\|/gu, "/"),
      item.physicalState.replace(/\|/gu, "/"),
      item.stateChangeReason.replace(/\|/gu, "/"),
      item.forceFlow.replace(/\|/gu, "/"),
      item.requiredVisibleElements.join(" / ").replace(/\|/gu, "/"),
      item.claimRefs.join(", "),
      item.cleanContent.replace(/\|/gu, "/"),
      item.infoFocus.replace(/\|/gu, "/"),
      item.cameraMotion.replace(/\|/gu, "/")
    ].join(" | ").replace(/^/u, "| ").replace(/$/u, " |"));
  }

  lines.push(
    ``,
    `## 파일명 규칙`,
    ``,
    ...items.flatMap((item) => [
      `- ${item.sceneId} / ${item.keyframeId} / ${item.clipId}`,
      `  - CLEAN: ${item.fileStub}_CLEAN.png`,
      `  - INFO: ${item.fileStub}_INFO.png`,
      `  - MP4: ${String(item.sortIndex).padStart(2, "0")}_${item.clipId}_${item.sceneId}_${item.keyframeId}.mp4`
    ])
  );

  return lines.join("\n");
}

function cleanTitle(title) {
  return title
    .replace(/\s+-\s+위키백과.*$/u, "")
    .replace(/\s*\([^)]*\)\s*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeText(value) {
  return cleanTitle(value)
    .replace(/[\s·ㆍ,./:;!?'"()[\]{}<>-]/gu, "")
    .toLowerCase();
}

function hasAnyKeyword(value, keywords) {
  return keywords.some((keyword) => value.includes(keyword));
}

function isPersonLikeTitle(title) {
  return /^[가-힣]{2,4}$/u.test(title) && !hasAnyKeyword(title, mechanismKeywords.history);
}

function hasFinalConsonant(value) {
  const char = [...value.trim()].pop();
  if (!char) return false;
  const code = char.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

function withParticle(value, consonantParticle, vowelParticle) {
  return `${value}${hasFinalConsonant(value) ? consonantParticle : vowelParticle}`;
}

function stripHtml(value) {
  return value
    .replace(/<[^>]*>/gu, "")
    .replace(/&quot;/gu, "\"")
    .replace(/&#039;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractMarkdownSection(markdown, startMarker, endMarker) {
  const start = markdown.indexOf(startMarker);
  if (start === -1) return "";
  const end = endMarker ? markdown.indexOf(endMarker, start + startMarker.length) : -1;
  return markdown.slice(start, end === -1 ? undefined : end).trim();
}

async function loadRuleContext(mainTopic = "engineering") {
  const domainFile = mainTopic === "history" ? "history.yaml" : mainTopic === "science" ? "engineering.yaml" : "engineering.yaml";
  const [workflow, factGate, domainRules, pipelineSpec] = await Promise.all([
    readFile(path.join(__dirname, "CODEX_ENGINEERING_SHORTS_WORKFLOW_KR.md"), "utf8"),
    readFile(path.join(__dirname, "docs", "FACT_CHECK_GATE_KR.md"), "utf8"),
    readFile(path.join(__dirname, "domains", domainFile), "utf8"),
    readFile(path.join(__dirname, "docs", "MD_PIPELINE_SPEC_KR.md"), "utf8")
  ]);

  const workflowExcerpt = [
    extractMarkdownSection(workflow, "## 3. Codex가 반드시 따라야 하는 실행 규칙", "## 4. 공학 쇼츠의 이야기 구조"),
    extractMarkdownSection(workflow, "## 4. 공학 쇼츠의 이야기 구조", "## 5. 1단계"),
    extractMarkdownSection(workflow, "## 5. 1단계", "## 6. 2단계"),
    extractMarkdownSection(workflow, "## 15. 실패를 줄이는 핵심 체크리스트", "## 16. 가장 짧은 실행 순서")
  ].filter(Boolean).join("\n\n---\n\n");

  return {
    workflowExcerpt,
    factGate,
    pipelineSpec,
    domainRules,
    domainFile
  };
}

function parseJsonFromText(text) {
  const cleaned = text.trim()
    .replace(/^```(?:json)?/u, "")
    .replace(/```$/u, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("Codex 응답을 JSON으로 해석하지 못했습니다.");
  }
}

const FACT_CHECK_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "confidence", "revisedTitle", "revisedHook", "coreClaim", "claims", "verifiedFacts", "visualEvidence", "unresolved", "simplifications", "sources", "verdictReason", "nextAction"],
  properties: {
    status: { type: "string", enum: ["PASS", "HOLD", "REJECT"] },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    revisedTitle: { type: "string" },
    revisedHook: { type: "string" },
    coreClaim: { type: "string" },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "statement", "status", "evidence", "useInVideo", "units"],
        properties: {
          id: { type: "string" },
          statement: { type: "string" },
          status: { type: "string", enum: ["SUPPORTED", "REFUTED", "NOT_ENOUGH_INFO"] },
          evidence: { type: "array", items: { type: "string" } },
          useInVideo: { type: "boolean" },
          units: { type: "array", items: { type: "string" } }
        }
      }
    },
    verifiedFacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "source", "reliability"],
        properties: {
          item: { type: "string" },
          source: { type: "string" },
          reliability: { type: "string", enum: ["상", "중", "하"] }
        }
      }
    },
    visualEvidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "state", "visibleFacts", "supportContacts", "motionOrFlow", "claimRefs", "evidence", "referenceType", "referenceSourceUrl", "referenceMediaUrl", "referencePage", "referenceDescription", "panelCrop", "focusBounds", "metadata"],
        properties: {
          id: { type: "string" },
          state: { type: "string" },
          visibleFacts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
          supportContacts: { type: "array", items: { type: "string" }, maxItems: 6 },
          motionOrFlow: { type: "string" },
          claimRefs: { type: "array", items: { type: "string" }, minItems: 1 },
          evidence: { type: "array", items: { type: "string" }, minItems: 1 },
          referenceType: { type: "string", enum: ["none", "official_photo", "construction_photo", "official_diagram", "official_section"] },
          referenceSourceUrl: { type: "string" },
          referenceMediaUrl: { type: "string" },
          referencePage: { type: "integer", minimum: 0 },
          referenceDescription: { type: "string" },
          panelCrop: { type: ["array", "null"], items: { type: "number" }, minItems: 4, maxItems: 4 },
          focusBounds: { type: ["array", "null"], items: { type: "number" }, minItems: 4, maxItems: 4 },
          metadata: {
            type: "object",
            additionalProperties: false,
            required: ["state", "evidenceRole", "sourceKind", "optionalFinalSource"],
            properties: {
              state: { type: "string" },
              evidenceRole: { type: "string" },
              sourceKind: { type: "string" },
              optionalFinalSource: { type: "boolean" }
            }
          }
        }
      }
    },
    unresolved: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "issue", "needed"],
        properties: {
          item: { type: "string" },
          issue: { type: "string" },
          needed: { type: "string" }
        }
      }
    },
    simplifications: { type: "array", items: { type: "string" } },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url", "usedFor"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          usedFor: { type: "string" }
        }
      }
    },
    verdictReason: { type: "string" },
    nextAction: { type: "string" }
  }
};

const TOPIC_DISCOVERY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "sourceUrl", "sourceTitle", "title", "object", "phenomenon",
          "mechanism", "coreClaim", "hook", "visualSequence"
        ],
        properties: {
          sourceUrl: { type: "string" },
          sourceTitle: { type: "string" },
          title: { type: "string" },
          object: { type: "string" },
          phenomenon: { type: "string" },
          mechanism: { type: "string" },
          coreClaim: { type: "string" },
          hook: { type: "string" },
          visualSequence: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};

const PRODUCTION_BRIEF_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "domainKey", "narrativeType", "scopeStatement", "coreQuestion", "causalChain", "visualStates", "forbiddenInferences", "lengthGuidance", "notes"],
  properties: {
    status: { type: "string", enum: ["ready", "hold"] },
    domainKey: { type: "string", enum: ["engineering", "history", "science"] },
    narrativeType: { type: "string", enum: ["problem_solution", "design_constraint", "hidden_mechanism", "failure_analysis", "evolution_comparison", "process_breakdown", "chronology_causation", "experiment_explanation"] },
    scopeStatement: { type: "string" },
    coreQuestion: { type: "string" },
    causalChain: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stepId", "role", "statement", "claimRefs"],
        properties: {
          stepId: { type: "string" },
          role: { type: "string", enum: ["origin", "cause", "problem", "constraint", "intervention", "mechanism", "result", "tradeoff", "context", "event", "evidence", "observation"] },
          statement: { type: "string" },
          claimRefs: { type: "array", items: { type: "string" }, minItems: 1 }
        }
      }
    },
    visualStates: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stateId", "label", "purpose", "physicalState", "changeFromPrevious", "requiredVisibleElements", "forbiddenVisibleElements", "evidenceBeats", "claimRefs", "evidenceRefs"],
        properties: {
          stateId: { type: "string" },
          label: { type: "string" },
          purpose: { type: "string" },
          physicalState: { type: "string" },
          changeFromPrevious: { type: "string" },
          requiredVisibleElements: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8 },
          forbiddenVisibleElements: { type: "array", items: { type: "string" }, maxItems: 8 },
          evidenceBeats: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "beatId", "label", "shotRole", "visualFamily", "purpose", "physicalState",
                "cameraMotion", "motionPolicy", "transitionEndState", "requiredVisibleElements",
                "forbiddenVisibleElements", "infoGraphic"
              ],
              properties: {
                beatId: { type: "string" },
                label: { type: "string" },
                shotRole: { type: "string", enum: ["establishing", "context", "cause", "failure_simulation", "constraint", "intervention", "mechanism", "response", "comparison", "monitoring", "consequence", "conclusion"] },
                visualFamily: { type: "string", enum: ["exterior", "environment", "cutaway", "macro", "action", "simulation", "comparison", "monitoring", "archival_reconstruction"] },
                purpose: { type: "string" },
                physicalState: { type: "string" },
                cameraMotion: { type: "string" },
                motionPolicy: { type: "string", enum: ["first_frame", "start_end_transition", "overlay_only"] },
                transitionEndState: { type: "string" },
                requiredVisibleElements: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
                forbiddenVisibleElements: { type: "array", items: { type: "string" }, maxItems: 6 }
                ,infoGraphic: {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "labels", "anchors", "directionRule", "comparisonRule", "forbidden", "requiresOverlay"],
                  properties: {
                    type: { type: "string", enum: ["forbidden_action", "location", "scale_limit", "flow", "before_after", "load_path", "sequence", "comparison", "none"] },
                    labels: { type: "array", items: { type: "string" }, maxItems: 2 },
                    anchors: { type: "array", items: { type: "string" }, maxItems: 4 },
                    directionRule: { type: "string" },
                    comparisonRule: { type: "string" },
                    forbidden: { type: "array", items: { type: "string" } },
                    requiresOverlay: { type: "boolean" }
                  }
                }
              }
            }
          },
          claimRefs: { type: "array", items: { type: "string" }, minItems: 1 }
          ,evidenceRefs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 }
        }
      }
    },
    forbiddenInferences: { type: "array", items: { type: "string" } },
    lengthGuidance: {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "recommendedMinSec", "recommendedMaxSec", "reason"],
      properties: {
        strategy: { type: "string", enum: ["content_first"] },
        recommendedMinSec: { type: "integer", minimum: 1 },
        recommendedMaxSec: { type: "integer", minimum: 1 },
        reason: { type: "string" }
      }
    },
    notes: { type: "array", items: { type: "string" } }
  }
};

const PRODUCTION_BRIEF_SCAFFOLD_OUTPUT_SCHEMA = structuredClone(PRODUCTION_BRIEF_OUTPUT_SCHEMA);

const PRODUCTION_BRIEF_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "verdict", "issues", "summary"],
  properties: {
    passed: { type: "boolean" },
    verdict: { type: "string", enum: ["PASS", "FAIL", "NOT_OBSERVABLE"] },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["verdict", "code", "stateId", "evidenceId", "owner", "requiresEvidence", "message"],
        properties: {
          verdict: { type: "string", enum: ["PASS", "FAIL", "NOT_OBSERVABLE"] },
          code: { type: "string" }, stateId: { type: "string" }, evidenceId: { type: "string" },
          owner: { type: "string" }, requiresEvidence: { type: "boolean" }, message: { type: "string" }
        }
      }
    }
  }
};

const SCRIPT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["narrativeType", "narrativeReason", "causalContext", "lengthPlan", "signaturePlan", "coreQuestion", "coreConflict", "coreMechanism", "visibleFlow", "turningPoint", "uniqueDifferentiator", "designIntervention", "tradeoffs", "limitations", "productionScript", "ttsText", "notes"],
  properties: {
    narrativeType: { type: "string", enum: ["problem_solution", "design_constraint", "hidden_mechanism", "failure_analysis", "evolution_comparison", "process_breakdown"] },
    narrativeReason: { type: "string" },
    causalContext: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "statement", "claimRefs"],
        properties: {
          role: { type: "string", enum: ["origin", "cause", "problem", "constraint", "intervention", "mechanism", "result", "tradeoff"] },
          statement: { type: "string" },
          claimRefs: { type: "array", items: { type: "string" } }
        }
      }
    },
    lengthPlan: {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "recommendedMinSec", "recommendedMaxSec", "compressionNotes"],
      properties: {
        strategy: { type: "string", enum: ["content_first"] },
        recommendedMinSec: { type: "integer", minimum: 1 },
        recommendedMaxSec: { type: "integer", minimum: 1 },
        compressionNotes: { type: "array", items: { type: "string" } }
      }
    },
    signaturePlan: {
      type: "object",
      additionalProperties: false,
      required: ["problemLineUsed", "pivotLineUsed", "reason"],
      properties: {
        problemLineUsed: { type: "boolean" },
        pivotLineUsed: { type: "boolean" },
        reason: { type: "string" }
      }
    },
    coreQuestion: { type: "string" },
    coreConflict: { type: "string" },
    coreMechanism: { type: "string" },
    visibleFlow: { type: "string" },
    turningPoint: { type: "string" },
    uniqueDifferentiator: { type: "string" },
    designIntervention: { type: "string" },
    tradeoffs: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } },
    productionScript: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["time", "beat", "importance", "visualStateId", "narration", "visualDirection", "physicalState", "mechanismStep", "stateChangeReason", "forceFlow", "claimRefs", "infoGraphic"],
        properties: {
          time: { type: "string" },
          beat: { type: "string" },
          importance: { type: "string", enum: ["essential", "supporting", "extension"] },
          visualStateId: { type: "string" },
          narration: { type: "string" },
          visualDirection: { type: "string" },
          physicalState: { type: "string" },
          mechanismStep: { type: "string" },
          stateChangeReason: { type: "string" },
          forceFlow: { type: "string" },
          claimRefs: { type: "array", items: { type: "string" } },
          infoGraphic: {
            type: "object",
            additionalProperties: false,
            required: ["type", "labels", "anchors", "directionRule", "comparisonRule", "forbidden", "requiresOverlay"],
            properties: {
              type: { type: "string", enum: ["forbidden_action", "location", "scale_limit", "flow", "before_after", "load_path", "sequence", "comparison", "none"] },
              labels: { type: "array", items: { type: "string" }, maxItems: 2 },
              anchors: { type: "array", items: { type: "string" }, maxItems: 4 },
              directionRule: { type: "string" },
              comparisonRule: { type: "string" },
              forbidden: { type: "array", items: { type: "string" } },
                    requiresOverlay: { type: "boolean" }
            }
          }
        }
      }
    },
    ttsText: { type: "string" },
    notes: { type: "array", items: { type: "string" } }
  }
};

const SCRIPT_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "score", "summary", "issues", "strengths"],
  properties: {
    passed: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "severity", "segmentIndex", "message", "repairInstruction"],
        properties: {
          code: {
            type: "string",
            enum: [
              "unsupported_claim", "misleading_premise", "causal_gap", "mechanism_gap",
              "missing_limitation", "weak_hook", "repetition", "not_visualizable",
              "info_overuse", "signature_misuse"
            ]
          },
          severity: { type: "string", enum: ["error", "warning"] },
          segmentIndex: { type: "integer", minimum: 0 },
          message: { type: "string" },
          repairInstruction: { type: "string" }
        }
      }
    },
    strengths: { type: "array", items: { type: "string" } }
  }
};

const CLEAN_VISUAL_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "score", "observedState", "issues", "repairInstruction"],
  properties: {
    passed: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    observedState: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            enum: [
              "missing_required", "forbidden_present", "physical_error", "generic_shot",
              "continuity_error", "direction_error", "text_artifact", "video_unsuitable"
            ]
          },
          message: { type: "string" }
        }
      }
    },
    repairInstruction: { type: "string" }
  }
};

const INFO_VISUAL_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "score", "action", "summary", "issues", "repairInstruction"],
  properties: {
    passed: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    action: { type: "string", enum: ["pass", "revise", "drop"] },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            enum: [
              "redundant", "claim_mismatch", "direction_wrong", "comparison_wrong",
              "anchor_wrong", "unreadable", "clutter", "unsupported_visual"
            ]
          },
          message: { type: "string" }
        }
      }
    },
    repairInstruction: { type: "string" }
  }
};

const VIDEO_VISUAL_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "score", "observedState", "issues", "repairInstruction"],
  properties: {
    passed: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    observedState: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            enum: [
              "motion_mismatch", "physical_error", "direction_error", "identity_drift",
              "continuity_error", "info_mismatch", "static_or_repeated", "unreadable"
            ]
          },
          message: { type: "string" }
        }
      }
    },
    repairInstruction: { type: "string" }
  }
};

const SHOTLIST_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["designSummary", "continuityRules", "scenes", "notes"],
  properties: {
    designSummary: { type: "string" },
    continuityRules: { type: "array", items: { type: "string" } },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "sourceSegmentIndex", "sourceSegmentOrder", "visualStateId", "evidenceBeatId", "narrationAnchor", "shotRole",
          "visualFamily", "referencePolicy", "motionPolicy", "requiredVisibleElements",
          "forbiddenVisibleElements", "transitionEndState", "scenePurpose", "cleanContent", "infoFocus",
          "cameraMotion", "physicalState", "stateChangeReason", "forceFlow",
          "claimRefs", "infoGraphic"
        ],
        properties: {
          sourceSegmentIndex: { type: "integer", minimum: 1 },
          sourceSegmentOrder: { type: "integer", minimum: 1 },
          visualStateId: { type: "string" },
          evidenceBeatId: { type: "string" },
          narrationAnchor: { type: "string" },
          shotRole: {
            type: "string",
            enum: ["establishing", "context", "cause", "failure_simulation", "constraint", "intervention", "mechanism", "response", "comparison", "monitoring", "consequence", "conclusion"]
          },
          visualFamily: {
            type: "string",
            enum: ["exterior", "environment", "cutaway", "macro", "action", "simulation", "comparison", "monitoring", "archival_reconstruction"]
          },
          referencePolicy: { type: "string", enum: ["none", "subject_identity", "previous_in_family"] },
          motionPolicy: { type: "string", enum: ["first_frame", "start_end_transition", "overlay_only"] },
          requiredVisibleElements: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
          forbiddenVisibleElements: { type: "array", items: { type: "string" }, maxItems: 6 },
          transitionEndState: { type: "string" },
          scenePurpose: { type: "string" },
          cleanContent: { type: "string" },
          infoFocus: { type: "string" },
          cameraMotion: { type: "string" },
          physicalState: { type: "string" },
          stateChangeReason: { type: "string" },
          forceFlow: { type: "string" },
          claimRefs: { type: "array", items: { type: "string" }, minItems: 1 },
          infoGraphic: {
            type: "object",
            additionalProperties: false,
            required: ["type", "labels", "anchors", "directionRule", "comparisonRule", "forbidden", "requiresOverlay"],
            properties: {
              type: { type: "string", enum: ["forbidden_action", "location", "scale_limit", "flow", "before_after", "load_path", "sequence", "comparison", "none"] },
              labels: { type: "array", items: { type: "string" }, maxItems: 2 },
              anchors: { type: "array", items: { type: "string" }, maxItems: 4 },
              directionRule: { type: "string" },
              comparisonRule: { type: "string" },
              forbidden: { type: "array", items: { type: "string" } },
                    requiresOverlay: { type: "boolean" }
            }
          }
        }
      }
    },
    notes: { type: "array", items: { type: "string" } }
  }
};

const SHOTLIST_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "score", "summary", "issues", "strengths"],
  properties: {
    passed: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "severity", "sceneIndexes", "message", "repairInstruction"],
        properties: {
          code: {
            type: "string",
            enum: [
              "unsupported_visual", "repeated_visual_state", "missing_causal_state",
              "impossible_geometry", "family_mismatch", "info_overuse",
              "weak_video_motion", "insufficient_visual_depth"
            ]
          },
          severity: { type: "string", enum: ["error", "warning"] },
          sceneIndexes: { type: "array", items: { type: "integer", minimum: 1 } },
          message: { type: "string" },
          repairInstruction: { type: "string" }
        }
      }
    },
    strengths: { type: "array", items: { type: "string" } }
  }
};

const INFO_LAYOUT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scenes"],
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["clipIndex", "geometryMode", "guidePoints", "labelPositions", "confidence", "note"],
        properties: {
          clipIndex: { type: "integer", minimum: 1 },
          geometryMode: {
            type: "string",
            enum: ["none", "path", "axis_pair", "position_pair", "sequence", "settlement_rotation", "forbidden", "span", "fact_badge"]
          },
          guidePoints: {
            type: "array",
            maxItems: 6,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["x", "y"],
              properties: {
                x: { type: "number", minimum: 0, maximum: 1 },
                y: { type: "number", minimum: 0, maximum: 1 }
              }
            }
          },
          labelPositions: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["x", "y"],
              properties: {
                x: { type: "number", minimum: 0, maximum: 1 },
                y: { type: "number", minimum: 0, maximum: 0.72 }
              }
            }
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          note: { type: "string" }
        }
      }
    }
  }
};

const INFO_SPEC_REVISION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["spec", "note"],
  properties: {
    spec: {
      type: "object",
      additionalProperties: false,
      required: ["type", "labels", "anchors", "directionRule", "comparisonRule", "forbidden", "requiresOverlay"],
      properties: {
        type: { type: "string", enum: ["forbidden_action", "location", "scale_limit", "flow", "before_after", "load_path", "sequence", "comparison", "none"] },
        labels: { type: "array", items: { type: "string" }, maxItems: 2 },
        anchors: { type: "array", items: { type: "string" }, maxItems: 4 },
        directionRule: { type: "string" },
        comparisonRule: { type: "string" },
        forbidden: { type: "array", items: { type: "string" } },
                    requiresOverlay: { type: "boolean" }
      }
    },
    note: { type: "string" }
  }
};

const INFO_NARRATIVE_PLAN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scenes", "notes"],
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sortIndex", "infoFocus", "reason", "infoGraphic"],
        properties: {
          sortIndex: { type: "integer", minimum: 1 },
          infoFocus: { type: "string" },
          reason: { type: "string" },
          infoGraphic: {
            type: "object",
            additionalProperties: false,
            required: ["type", "labels", "anchors", "directionRule", "comparisonRule", "forbidden", "requiresOverlay"],
            properties: {
              type: { type: "string", enum: ["forbidden_action", "location", "scale_limit", "flow", "before_after", "load_path", "sequence", "comparison", "none"] },
              labels: { type: "array", items: { type: "string" }, maxItems: 2 },
              anchors: { type: "array", items: { type: "string" }, maxItems: 4 },
              directionRule: { type: "string" },
              comparisonRule: { type: "string" },
              forbidden: { type: "array", items: { type: "string" } },
                    requiresOverlay: { type: "boolean" }
            }
          }
        }
      }
    },
    notes: { type: "array", items: { type: "string" } }
  }
};

const codexEnvironment = Object.fromEntries(
  Object.entries({ ...process.env, CODEX_HOME, NO_COLOR: "1", TERM: "xterm-256color" })
    .filter(([, value]) => typeof value === "string")
);
const codexClient = new Codex({ codexPathOverride: CODEX_BIN, env: codexEnvironment });

function inferInvocationTopicId(taskName, control = {}) {
  if (Number(control.topicId)) return Number(control.topicId);
  return Number(String(taskName).match(/-(\d+)(?:-|$)/u)?.[1] || 0) || null;
}

function startAiInvocation(taskName, model, prompt, outputSchema, control, fallbackCount) {
  const result = db.prepare(`
    INSERT INTO ai_invocations (task, stage, topic_id, job_id, model, prompt_hash, schema_hash, input_hash, status, fallback_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
  `).run(
    taskName,
    String(control.stage || taskName.split("-")[0] || "ai"),
    inferInvocationTopicId(taskName, control),
    Number(control.jobId) || null,
    model || "default",
    buildQualityContractHash(prompt),
    buildQualityContractHash(outputSchema),
    buildQualityContractHash({ prompt, outputSchema }),
    fallbackCount
  );
  return Number(result.lastInsertRowid);
}

function finishAiInvocation(id, status, startedAt, error = "") {
  db.prepare(`
    UPDATE ai_invocations
    SET status = ?, completed_at = CURRENT_TIMESTAMP, duration_ms = ?, error = ?
    WHERE id = ?
  `).run(status, Date.now() - startedAt, String(error || "").slice(0, 2000), id);
}

async function runCodexJson(prompt, taskName, timeoutMs = 240000, control = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Codex 실행 시간이 너무 오래 걸려 중단했습니다.")), timeoutMs);
  const externalAbort = () => controller.abort(control.signal?.reason || new Error("작업이 취소되었습니다."));
  control.signal?.addEventListener("abort", externalAbort, { once: true });
  if (control.signal?.aborted) externalAbort();

  try {
    const outputSchema = control.outputSchema || (taskName.startsWith("fact-check-")
      ? FACT_CHECK_OUTPUT_SCHEMA
      : taskName.startsWith("topic-discovery-")
        ? TOPIC_DISCOVERY_OUTPUT_SCHEMA
        : taskName.startsWith("shotlist-")
          ? SHOTLIST_OUTPUT_SCHEMA
          : taskName.startsWith("info-layout-")
            ? INFO_LAYOUT_OUTPUT_SCHEMA
          : SCRIPT_OUTPUT_SCHEMA);
    const modelCandidates = (Array.isArray(control.models) && control.models.length ? control.models : [undefined])
      .slice(0, CODEX_MODEL_ATTEMPT_LIMIT);

    for (const [modelIndex, model] of modelCandidates.entries()) {
      const invocationStartedAt = Date.now();
      const invocationId = startAiInvocation(taskName, model, prompt, outputSchema, control, modelIndex);
      try {
        const thread = codexClient.startThread({
          model,
          workingDirectory: __dirname,
          skipGitRepoCheck: true,
          sandboxMode: "read-only",
          approvalPolicy: "never",
          networkAccessEnabled: false
        });
        const { events } = await thread.runStreamed(prompt, { outputSchema, signal: controller.signal });
        let finalResponse = "";

        for await (const event of events) {
          control.onEvent?.(event);
          if (event.type === "item.completed" && event.item.type === "agent_message") {
            finalResponse = event.item.text;
          }
          if (event.type === "turn.failed") {
            throw new Error(event.error?.message || "Codex 작업이 실패했습니다.");
          }
          if (event.type === "error") {
            throw new Error(event.message || "Codex 스트림 오류가 발생했습니다.");
          }
        }

        if (!finalResponse) {
          throw new Error("Codex가 최종 JSON 응답을 반환하지 않았습니다.");
        }
        const parsed = parseJsonFromText(finalResponse);
        finishAiInvocation(invocationId, "completed", invocationStartedAt);
        Object.defineProperties(parsed, {
          __aiInvocationId: { value: invocationId, enumerable: false },
          __aiModel: { value: model || "default", enumerable: false }
        });
        return parsed;
      } catch (error) {
        const message = String(error.message || error);
        finishAiInvocation(invocationId, "failed", invocationStartedAt, message);
        const retryable = /capacity|overloaded|temporarily unavailable|rate limit|stream disconnected before completion/iu.test(message);
        const hasFallback = modelIndex < modelCandidates.length - 1;
        if (!retryable || !hasFallback || controller.signal.aborted) throw error;
        control.onRetry?.({
          failedModel: model || "default",
          nextModel: modelCandidates[modelIndex + 1],
          attempt: modelIndex + 2,
          message
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    throw new Error("사용 가능한 Codex 모델이 없습니다.");
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(controller.signal.reason?.message || "Codex 작업이 취소되었습니다.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    control.signal?.removeEventListener("abort", externalAbort);
  }
}

const activeTopicOperations = new Map();
let activeAudioGpuOperation = "";
let activeAiWorkers = 0;
let aiWorkerScheduled = false;

function mapJobRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.type,
    topicId: row.topic_id == null ? null : Number(row.topic_id),
    status: row.status,
    progress: Number(row.progress || 0),
    message: row.message,
    payload: parseStoredJson(row.payload_json, {}),
    result: parseStoredJson(row.result_json, {}),
    error: row.error,
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.max_attempts || 1),
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

function appendJobEvent(jobId, topicId, eventType, progress, message, data = {}, level = "info") {
  db.prepare(`
    INSERT INTO job_events (job_id, topic_id, level, event_type, progress, message, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, topicId || null, level, eventType, progress, message, JSON.stringify(data));
}

function updateJobProgress(jobId, topicId, progress, message, eventType = "progress", data = {}) {
  const normalizedProgress = Math.max(0, Math.min(100, Math.round(progress)));
  db.prepare(`
    UPDATE jobs SET progress = ?, message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(normalizedProgress, message, jobId);
  appendJobEvent(jobId, topicId, eventType, normalizedProgress, message, data);
}

function isProductionContractRevisionJob(type, payload = {}) {
  return type === "production_brief_generate" && payload?.remediationRoute === "production_contract_revision";
}

function enqueueAiJob(type, topicId, payload = {}) {
  if (!new Set(["topic_discovery", "fact_check", "production_brief_generate", "script_generate", "tts_generate", "shotlist_generate", "clean_image_generate", "info_image_generate", "quality_replay"]).has(type)) {
    throw new Error("지원하지 않는 AI 작업입니다.");
  }
  if (type === "topic_discovery") {
    const activeRows = db.prepare(`
      SELECT * FROM jobs
      WHERE type = 'topic_discovery' AND status IN ('queued', 'running')
      ORDER BY id DESC
    `).all();
    const active = activeRows.find((row) => {
      const activePayload = parseStoredJson(row.payload_json, {});
      return activePayload.mainTopic === payload.mainTopic && activePayload.subtopic === payload.subtopic;
    });
    if (active) return { job: mapJobRow(active), reused: true };

    const result = db.prepare(`
      INSERT INTO jobs (type, topic_id, payload_json, max_attempts)
      VALUES ('topic_discovery', NULL, ?, 1)
    `).run(JSON.stringify(payload));
    const jobId = Number(result.lastInsertRowid);
    appendJobEvent(jobId, null, "queued", 0, "실제 사례 기반 주제 탐색이 대기열에 추가되었습니다.");
    scheduleAiWorkers();
    return { job: mapJobRow(db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId)), reused: false };
  }

  const topic = getTopicStatement.get(Number(topicId));
  if (!topic) throw new Error("작업할 주제를 찾을 수 없습니다.");

  if (USAGE_GUARD_ENABLED && PRODUCTION_AI_JOB_TYPES.has(type) && payload.source !== "quality_benchmark_batch") {
    const activeOtherTopic = db.prepare(`
      SELECT topic_id AS topicId, type FROM jobs
      WHERE status IN ('queued', 'running')
        AND type IN ('script_generate', 'tts_generate', 'shotlist_generate', 'clean_image_generate', 'info_image_generate', 'quality_replay')
        AND topic_id != ?
      ORDER BY id LIMIT 1
    `).get(Number(topicId));
    if (activeOtherTopic) {
      throw new Error(`사용량 보호 중에는 제작 주제를 한 번에 하나만 처리합니다. 주제 #${activeOtherTopic.topicId}의 ${activeOtherTopic.type} 작업을 완료하거나 취소한 뒤 실행하세요.`);
    }
  }

  const activeRows = db.prepare(`
    SELECT * FROM jobs
    WHERE type = ? AND topic_id = ? AND status IN ('queued', 'running')
    ORDER BY id DESC
  `).all(type, Number(topicId));
  const pipeline = payload.pipeline || null;
  const active = pipeline
    ? activeRows.find((row) => {
      const queued = parseStoredJson(row.payload_json, {}).pipeline || {};
      return queued.stage === pipeline.stage && queued.inputHash === pipeline.inputHash;
    })
    : ["clean_image_generate", "quality_replay"].includes(type)
      ? activeRows.find((row) => Number(parseStoredJson(row.payload_json, {}).clipIndex) === Number(payload.clipIndex))
      : activeRows[0];
  if (active) return { job: mapJobRow(active), reused: true };

  const maxAttempts = isProductionContractRevisionJob(type, payload)
    ? PRODUCTION_CONTRACT_REVISION_MAX_ATTEMPTS
    : 1;
  const result = db.prepare(`
    INSERT INTO jobs (type, topic_id, payload_json, max_attempts)
    VALUES (?, ?, ?, ?)
  `).run(type, Number(topicId), JSON.stringify(payload), maxAttempts);
  const jobId = Number(result.lastInsertRowid);
  appendJobEvent(jobId, Number(topicId), "queued", 0, "작업이 대기열에 추가되었습니다.");
  scheduleAiWorkers();
  return { job: mapJobRow(db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId)), reused: false };
}

async function enqueuePipelineSuccessor(job) {
  if (job.payload?.autoConverge !== true || !job.topicId) return null;
  let assets = await listProjectAssetsForTopic(job.topicId);
  let detail = getTopicDetailById(job.topicId);
  const isCanary = detail.topic?.runLane === "production_canary";
  if (isCanary && detail.script?.status === "draft" && !canaryHasAiPass(detail.topic)) {
    // A completed script_generate job has already passed its independent script
    // consensus. Record that canary checkpoint before TTS, never by treating a
    // draft as an approved script.
    if (job.type !== "script_generate") return { stage: "canary_ai_pass", blocked: "awaiting_canary_ai_pass" };
    recordCanaryAiPass({ topicId: job.topicId, reviewer: "pipeline_auto_converge" });
    detail = getTopicDetailById(job.topicId);
  }
  if (isCanary && job.type === "shotlist_generate" && detail.shotlist?.status !== "approved") {
    if (detail.shotlist?.raw?.qualityStatus !== "passed") {
      return { stage: "shotlist_review", blocked: "quality_not_passed" };
    }
    await approveCanaryShotlistWithAi({ topicId: job.topicId, reviewer: "pipeline_auto_converge" });
    detail = getTopicDetailById(job.topicId);
    assets = await listProjectAssetsForTopic(job.topicId);
  }
  const next = getNextPipelineJob({
    scriptReady: Boolean(detail.script && (detail.script.status === "approved"
      || (detail.script.status === "draft" && canaryHasAiPass(detail.topic)))),
    ttsMeasured: Boolean(assets.ttsRun?.status === "generated" && Number(assets.ttsRun?.totalDurationSec || 0) > 0),
    shotlistReady: Boolean(assets.shotlistApproved),
    cleanReady: Boolean(assets.cleanReady),
    infoReady: Boolean(assets.infoReady),
    inputHash: buildQualityContractHash({
      scriptId: detail.script?.id || 0,
      ttsRunId: assets.ttsRun?.id || 0,
      shotlistId: assets.shotlist?.id || 0,
      cleanCount: assets.clean?.length || 0,
      infoCount: assets.info?.length || 0
    })
  });
  if (!next.jobType || next.stage === "complete") return next;
  if (job.type === "tts_generate" && next.stage === "tts") {
    return { ...next, hold: "measured_tts_unresolved" };
  }
  if (job.type === "shotlist_generate" && next.stage === "shotlist") {
    return { ...next, hold: "awaiting_shotlist_review" };
  }
  if (job.type === "clean_image_generate" && next.stage === "clean") {
    const activeCleanCount = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE topic_id = ? AND type = 'clean_image_generate' AND status IN ('queued', 'running')").get(job.topicId).count;
    if (activeCleanCount > 0) return { ...next, waiting: "clean_batch" };
  }
  const pipeline = { stage: next.stage, inputHash: next.inputHash };
  if (next.stage === "clean") {
    const batch = await enqueueCleanImageGeneration({
      topicId: job.topicId,
      scope: "full",
      source: "pipeline_auto_converge",
      autoConverge: true,
      pipeline
    });
    return { ...next, queued: { job: batch.jobs[0] || null }, batch };
  }
  const queued = enqueueAiJob(next.jobType, job.topicId, {
    source: "pipeline_auto_converge",
    autoConverge: true,
    pipeline
  });
  return { ...next, queued };
}

function claimNextAiJob() {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = AI_WORKER_JOB_ID
      ? db.prepare(`
        SELECT * FROM jobs
        WHERE status = 'queued' AND cancel_requested = 0 AND id = ?
        LIMIT 1
      `).get(AI_WORKER_JOB_ID)
      : AI_WORKER_TOPIC_ID
        ? db.prepare(`
          SELECT * FROM jobs
          WHERE status = 'queued' AND cancel_requested = 0 AND topic_id = ?
          ORDER BY id LIMIT 1
        `).get(AI_WORKER_TOPIC_ID)
        : db.prepare(`
          SELECT * FROM jobs
          WHERE status = 'queued' AND cancel_requested = 0
          ORDER BY id LIMIT 1
        `).get();
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(`
      UPDATE jobs
      SET status = 'running', progress = MAX(progress, 1), message = '작업을 시작합니다.',
          attempt = attempt + 1, lease_owner = ?, lease_until = datetime('now', '+10 minutes'),
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued'
    `).run(`local-${process.pid}`, row.id);
    db.exec("COMMIT");
    return mapJobRow(db.prepare("SELECT * FROM jobs WHERE id = ?").get(row.id));
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createJobContext(job) {
  const controller = new AbortController();
  const timeoutMs = isProductionContractRevisionJob(job.type, job.payload)
    ? PRODUCTION_CONTRACT_REVISION_JOB_TIMEOUT_MS
    : Number(AI_JOB_TIMEOUT_MS[job.type] || 8 * 60 * 1000);
  const deadlineTimer = setTimeout(() => {
    controller.abort(new Error(`${Math.round(timeoutMs / 60000)}분 자동 중단 시간을 넘어 작업을 취소했습니다.`));
  }, timeoutMs);
  const timer = setInterval(() => {
    const row = db.prepare("SELECT cancel_requested FROM jobs WHERE id = ?").get(job.id);
    if (!row || row.cancel_requested) controller.abort(new Error("사용자가 작업을 취소했습니다."));
  }, 750);
  return {
    jobId: job.id,
    signal: controller.signal,
    progress(value, message, eventType = "progress", data = {}) {
      if (controller.signal.aborted) {
        throw new Error(controller.signal.reason?.message || "사용자가 작업을 취소했습니다.");
      }
      updateJobProgress(job.id, job.topicId, value, message, eventType, data);
    },
    close() {
      clearInterval(timer);
      clearTimeout(deadlineTimer);
    }
  };
}

function maintainDiscoveryVerificationQueue(job) {
  if (USAGE_GUARD_ENABLED) return;
  if (job.type !== "fact_check" || job.payload?.source !== "topic_discovery") return;
  const targetCount = Math.max(1, Math.min(Number(job.payload.targetCount || 0), 30));
  const mainTopic = String(job.payload.mainTopic || "").trim();
  const subtopic = String(job.payload.subtopic || "").trim();
  if (!targetCount || !mainTopic || !subtopic) return;

  const verifiedCount = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM topics
    JOIN fact_checks ON fact_checks.topic_id = topics.id
    WHERE topics.main_topic = ? AND topics.subtopic = ? AND topics.run_lane = 'production'
      AND topics.lifecycle_status != 'dropped' AND fact_checks.status = 'PASS'
  `).get(mainTopic, subtopic)?.count || 0);
  const activeCount = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM jobs
    JOIN topics ON topics.id = jobs.topic_id
    WHERE jobs.type = 'fact_check' AND jobs.status IN ('queued', 'running')
      AND topics.main_topic = ? AND topics.subtopic = ? AND topics.run_lane = 'production'
  `).get(mainTopic, subtopic)?.count || 0);
  const needed = Math.max(0, targetCount - verifiedCount - activeCount);
  if (!needed) return;

  const replacements = db.prepare(`
    SELECT topics.id, topics.source_title AS sourceTitle,
      (SELECT id FROM benchmark_replacement_candidates
       WHERE candidate_topic_id = topics.id AND status = 'discovered'
       ORDER BY id DESC LIMIT 1) AS replacementCandidateLinkId,
      (SELECT original_topic_id FROM benchmark_replacement_candidates
       WHERE candidate_topic_id = topics.id AND status = 'discovered'
       ORDER BY id DESC LIMIT 1) AS replacementOriginTopicId
    FROM topics
    WHERE main_topic = ? AND subtopic = ? AND run_lane = 'production'
      AND topic_format = 'focused_v2'
      AND lifecycle_status = 'candidate'
      AND review_status IN ('prechecked', 'unverified')
      AND NOT EXISTS (SELECT 1 FROM fact_checks WHERE fact_checks.topic_id = topics.id)
      AND NOT EXISTS (
        SELECT 1 FROM jobs
        WHERE jobs.topic_id = topics.id AND jobs.type = 'fact_check' AND jobs.status IN ('queued', 'running')
      )
    ORDER BY updated_at DESC, id DESC
    LIMIT 100
  `).all(mainTopic, subtopic)
    .filter((topic) => isTopicSourceAligned(mainTopic, subtopic, topic.sourceTitle))
    .slice(0, needed);

  for (const replacement of replacements) {
    const queued = enqueueAiJob("fact_check", Number(replacement.id), {
      force: false,
      source: "topic_discovery",
      targetCount,
      mainTopic,
      subtopic,
      discoveryRound: Number(job.payload.discoveryRound || 1),
      ...(replacement.replacementCandidateLinkId ? {
        replacementCandidateLinkId: Number(replacement.replacementCandidateLinkId),
        replacementOriginTopicIds: [Number(replacement.replacementOriginTopicId)],
        replacementForTopicIds: job.payload.replacementForTopicIds,
        replacementSlots: job.payload.replacementSlots,
        minimumQualifiedPerSlot: job.payload.minimumQualifiedPerSlot
      } : {})
    });
    if (replacement.replacementCandidateLinkId) {
      db.prepare("UPDATE benchmark_replacement_candidates SET fact_check_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(queued.job.id, Number(replacement.replacementCandidateLinkId));
    }
  }
  const remaining = needed - replacements.length;
  const discoveryRound = Number(job.payload.discoveryRound || 1);
  if (remaining > 0 && discoveryRound < 8) {
    enqueueAiJob("topic_discovery", null, {
      mainTopic,
      subtopic,
      count: targetCount,
      discoveryRound: discoveryRound + 1,
      ...(Array.isArray(job.payload.replacementForTopicIds) ? {
        replacementForTopicIds: job.payload.replacementForTopicIds,
        replacementSlots: job.payload.replacementSlots,
        minimumQualifiedPerSlot: job.payload.minimumQualifiedPerSlot
      } : {})
    });
  }
}

function isTimeoutError(error) {
  return /Codex 실행 시간이 너무 오래 걸려 중단했습니다\.|timeout|timed out|시간\s*(?:제한|초과)|자동 중단 시간을 넘어/iu.test(String(error?.message || error));
}

async function executeAiJob(job) {
  const context = createJobContext(job);
  let stageHeartbeatTimer = null;
  appendJobEvent(job.id, job.topicId, "started", 1, "백그라운드 작업을 시작했습니다.");
  try {
    let detail;
    if (job.type === "topic_discovery") {
      detail = await runTopicDiscovery(job.payload, context);
    } else if (job.type === "fact_check") {
      detail = await runFactCheck({ ...job.payload, id: job.topicId }, context);
    } else if (job.type === "production_brief_generate") {
      detail = await runProductionBriefStage({ ...job.payload, id: job.topicId }, context);
    } else if (job.type === "script_generate") {
      detail = await generateScript({ ...job.payload, id: job.topicId }, context);
    } else if (job.type === "tts_generate") {
      context.progress(5, "승인 대본을 기본 목소리로 합성하고 실제 길이를 측정합니다.");
      const startedAt = Date.now();
      stageHeartbeatTimer = setInterval(() => {
        const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        const progress = Math.min(85, 8 + Math.floor(elapsedSeconds / 15) * 4);
        updateJobProgress(
          job.id,
          job.topicId,
          progress,
          `같은 기준 목소리로 장면별 음성을 합성 중입니다. ${elapsedSeconds}초 경과`,
          "tts_heartbeat",
          { elapsedSeconds }
        );
      }, 15_000);
      detail = await generateTts({ ...job.payload, topicId: job.topicId });
    } else if (job.type === "shotlist_generate") {
      detail = await generateShotlist({ ...job.payload, topicId: job.topicId }, context);
    } else if (job.type === "clean_image_generate") {
      detail = await generateCleanImage({ ...job.payload, topicId: job.topicId }, context);
    } else if (job.type === "info_image_generate") {
      detail = await saveInfoPrompts({ ...job.payload, topicId: job.topicId }, context);
    } else if (job.type === "quality_replay") {
      detail = await runQualityReplay({ ...job.payload, topicId: job.topicId }, context);
    } else {
      throw new Error(`처리할 수 없는 작업 유형: ${job.type}`);
    }

    const resultPayload = job.type === "topic_discovery"
      ? detail
      : ["tts_generate", "clean_image_generate", "info_image_generate", "quality_replay"].includes(job.type)
        ? detail
      : { topicId: detail.topic.id };
    if (job.type === "clean_image_generate" && detail.followUpClipIndexes?.length) {
      for (const clipIndex of detail.followUpClipIndexes) {
        enqueueAiJob("clean_image_generate", job.topicId, {
          clipIndex,
          source: job.payload.source || "manual",
          ...(job.payload.autoConverge === true ? {
            autoConverge: true,
            pipeline: job.payload.pipeline || null
          } : {})
        });
      }
    }
    db.prepare(`
      UPDATE jobs SET status = 'completed', progress = 100, message = '작업이 완료되었습니다.',
        result_json = ?, error = '', lease_owner = '', lease_until = NULL,
        completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(JSON.stringify(resultPayload), job.id);
    const pipelineSuccessor = await enqueuePipelineSuccessor(job);
    if (pipelineSuccessor?.queued?.job) appendJobEvent(job.id, job.topicId, "pipeline_enqueued", 100, `다음 자동 수렴 단계 ${pipelineSuccessor.stage}를 대기열에 추가했습니다.`, { stage: pipelineSuccessor.stage, inputHash: pipelineSuccessor.inputHash, jobId: pipelineSuccessor.queued.job.id });
    if (job.type === "fact_check"
      && job.payload?.source === "quality_benchmark_remediation"
      && detail?.factCheck?.status === "PASS") {
      try {
        const currentScript = mapScriptRow(getScriptByTopicStatement.get(job.topicId));
        if (!currentScript || currentScript.status === "stale") {
          enqueueAiJob("script_generate", job.topicId, {
            source: "quality_benchmark_remediation",
            remediationRoute: "source_enrichment"
          });
        }
      } catch (error) {
        recordTopicAttempt(job.topicId, "benchmark_remediation_queue", "deferred", String(error.message || error), {
          sourceJobId: job.id,
          nextJobType: "script_generate"
        });
      }
    }
    appendJobEvent(job.id, job.topicId, "completed", 100, "작업이 완료되었습니다.");
    maintainDiscoveryVerificationQueue(job);
    if (!DISABLE_AUTOMATIC_REMEDIATION) maintainBenchmarkRemediationQueue();
  } catch (error) {
    const message = String(error.message || error).slice(0, 2000);
    const cancelRequested = Boolean(db.prepare("SELECT cancel_requested FROM jobs WHERE id = ?").get(job.id)?.cancel_requested);
    const timedOut = isTimeoutError(error) || isTimeoutError(context.signal.reason);
    const canRetry = isProductionContractRevisionJob(job.type, job.payload)
      && !cancelRequested
      && timedOut
      && job.attempt < job.maxAttempts;
    if (canRetry) {
      const retryMessage = `시간 제한으로 production contract 교정을 다시 시도합니다. (${job.attempt + 1}/${job.maxAttempts})`;
      const retry = db.prepare(`
        UPDATE jobs
        SET status = 'queued', progress = 1, message = ?, error = '', lease_owner = '', lease_until = NULL,
            completed_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running' AND cancel_requested = 0 AND attempt < max_attempts
      `).run(retryMessage, job.id);
      if (retry.changes) {
        appendJobEvent(job.id, job.topicId, "retry", 1, retryMessage, {
          reason: "timeout",
          attempt: job.attempt,
          nextAttempt: job.attempt + 1,
          maxAttempts: job.maxAttempts
        }, "warning");
        return;
      }
    }
    const canceled = context.signal.aborted || cancelRequested;
    const status = canceled ? "canceled" : "failed";
    const canceledMessage = /자동 중단 시간을 넘어/iu.test(message)
      ? "시간 제한으로 작업을 자동 중단했습니다."
      : "작업이 취소되었습니다.";
    db.prepare(`
      UPDATE jobs SET status = ?, message = ?, error = ?, lease_owner = '', lease_until = NULL,
        completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(status, canceled ? canceledMessage : "작업에 실패했습니다.", message, job.id);
    appendJobEvent(job.id, job.topicId, status, job.progress, message, {}, canceled ? "warning" : "error");
    if (!canceled) {
      maintainDiscoveryVerificationQueue(job);
      if (!DISABLE_AUTOMATIC_REMEDIATION) maintainBenchmarkRemediationQueue();
    }
  } finally {
    if (stageHeartbeatTimer) clearInterval(stageHeartbeatTimer);
    context.close();
  }
}

function maintainBenchmarkRemediationQueue() {
  const candidates = db.prepare(`
    SELECT attempts.topic_id AS topicId, MAX(attempts.id) AS resetId, MAX(attempts.created_at) AS resetAt
    FROM topic_attempts attempts
    WHERE attempts.stage = 'benchmark_contract_reset'
      AND attempts.details_json LIKE '%quality_benchmark_remediation%'
    GROUP BY attempts.topic_id
    ORDER BY resetId
  `).all();
  for (const candidate of candidates) {
    const factCheck = mapFactCheckRow(getFactCheckByTopicStatement.get(candidate.topicId));
    const productionBrief = mapProductionBriefRow(getProductionBriefByTopicStatement.get(candidate.topicId));
    if (factCheck?.status !== "PASS" || productionBrief?.status === "hold") continue;
    const script = mapScriptRow(getScriptByTopicStatement.get(candidate.topicId));
    if (script && script.status !== "stale") continue;
    const active = db.prepare(`
      SELECT id FROM jobs
      WHERE topic_id = ? AND type = 'script_generate' AND status IN ('queued', 'running')
      LIMIT 1
    `).get(candidate.topicId);
    if (active) continue;
    const latestAfterReset = db.prepare(`
      SELECT status FROM jobs
      WHERE topic_id = ? AND type = 'script_generate' AND created_at >= ?
      ORDER BY id DESC LIMIT 1
    `).get(candidate.topicId, candidate.resetAt);
    if (latestAfterReset?.status === "failed") continue;
    try {
      enqueueAiJob("script_generate", candidate.topicId, {
        source: "quality_benchmark_remediation",
        remediationRoute: "source_enrichment"
      });
      return;
    } catch {
      return;
    }
  }
}

function recoverCompletedBenchmarkFactChecks() {
  db.prepare(`
    UPDATE jobs
    SET status = 'completed', progress = 100, message = '사실 검증은 완료됐고 후속 대본은 순차 대기합니다.',
        error = '', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE type = 'fact_check' AND status = 'failed'
      AND payload_json LIKE '%quality_benchmark_remediation%'
      AND error LIKE '%사용량 보호 중에는 제작 주제를 한 번에 하나만 처리합니다%'
      AND result_json != '{}'
  `).run();
  db.prepare(`
    UPDATE topics
    SET review_status = 'hold', lifecycle_status = 'fact_checking', updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT topic_id FROM fact_checks
      WHERE status = 'HOLD'
        AND (verdict_reason LIKE '%시각%' OR verdict_reason LIKE '%CLEAN%' OR verdict_reason LIKE '%도면%' OR verdict_reason LIKE '%단면%' OR verdict_reason LIKE '%사진%')
    )
  `).run();
}

function scheduleAiWorkers() {
  if (DISABLE_BACKGROUND_WORKERS || aiWorkerScheduled) return;
  aiWorkerScheduled = true;
  queueMicrotask(async () => {
    aiWorkerScheduled = false;
    while (activeAiWorkers < AI_WORKER_CONCURRENCY) {
      const job = claimNextAiJob();
      if (!job) break;
      activeAiWorkers += 1;
      executeAiJob(job)
        .catch((error) => console.error("AI job failed:", error))
        .finally(() => {
          activeAiWorkers -= 1;
          scheduleAiWorkers();
        });
    }
  });
}

function listJobs(url) {
  const topicId = Number(url.searchParams.get("topicId") || 0);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 30)));
  const rows = topicId
    ? db.prepare("SELECT * FROM jobs WHERE topic_id = ? ORDER BY id DESC LIMIT ?").all(topicId, limit)
    : db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit);
  const eventCursor = Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM job_events").get().id || 0);
  return {
    jobs: rows.map(mapJobRow),
    concurrency: AI_WORKER_CONCURRENCY,
    activeWorkers: activeAiWorkers,
    eventCursor,
    usagePolicy: {
      enabled: USAGE_GUARD_ENABLED,
      concurrency: AI_WORKER_CONCURRENCY,
      modelAttempts: CODEX_MODEL_ATTEMPT_LIMIT,
      automaticDiscoveryRefill: !USAGE_GUARD_ENABLED,
      jobTimeoutMinutes: {
        ...Object.fromEntries(Object.entries(AI_JOB_TIMEOUT_MS).map(([type, timeoutMs]) => [type, Math.round(timeoutMs / 60000)])),
        video_generate: Math.round(VIDEO_JOB_TIMEOUT_MS / 60000)
      }
    }
  };
}

function getHealthSnapshot() {
  const integrity = db.prepare("PRAGMA integrity_check").get();
  const sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get();
  const schemaVersion = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get();
  const jobCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM jobs
  `).get();

  return {
    ok: integrity.integrity_check === "ok",
    database: {
      integrity: integrity.integrity_check,
      sqliteVersion: sqliteVersion.version,
      schemaVersion: Number(schemaVersion.version || 0),
      path: DB_PATH
    },
    workers: {
      aiConcurrency: AI_WORKER_CONCURRENCY,
      aiActive: activeAiWorkers,
      queued: Number(jobCounts.queued || 0),
      running: Number(jobCounts.running || 0),
      failed: Number(jobCounts.failed || 0)
    },
    localRuntime: {
      codexSdk: true,
      ttsPython: existsSync(PYTHON_BIN),
      ttsRunner: existsSync(VOXCPM_RUNNER),
      h3Workflow: existsSync(H3_WORKFLOW_PATH),
      comfyuiDirectory: Boolean(COMFYUI_DIR),
      h3TurboLora: Boolean(COMFYUI_DIR && existsSync(path.join(COMFYUI_DIR, "models", "loras", H3_TURBO_LORA)))
    },
    checkedAt: new Date().toISOString()
  };
}

const BENCHMARK_FEEDBACK_APPLICATION_LIMIT = 1;

function getBenchmarkFeedbackState(topicId, qualityStage) {
  const latestReset = db.prepare(`
    SELECT id FROM topic_attempts
    WHERE topic_id = ? AND stage = 'benchmark_contract_reset'
    ORDER BY id DESC LIMIT 1
  `).get(topicId);
  const applications = db.prepare(`
    SELECT id, details_json AS detailsJson, created_at AS createdAt
    FROM topic_attempts
    WHERE topic_id = ? AND stage = 'shared_quality_feedback'
    ORDER BY id
  `).all(topicId).filter((row) => Number(row.id) > Number(latestReset?.id || 0)).map((row) => {
    let details = {};
    try {
      details = JSON.parse(row.detailsJson || "{}");
    } catch {
      details = {};
    }
    return {
      ...row,
      details,
      qualityStage: details.stage || "shotlist_quality"
    };
  }).filter((row) => row.qualityStage === qualityStage);
  const latestApplication = applications.at(-1) || null;
  const latestRun = db.prepare(`
    SELECT id, status, created_at AS createdAt
    FROM quality_runs
    WHERE topic_id = ? AND stage = ?
    ORDER BY id DESC LIMIT 1
  `).get(topicId, qualityStage) || null;
  const sourceRunId = Number(latestApplication?.details?.sourceRunId || 0);
  const failedAfterFeedback = Boolean(
    latestApplication
    && latestRun?.status === "fail"
    && Number(latestRun.id) > sourceRunId
  );
  return {
    applicationCount: applications.length,
    applicationLimit: BENCHMARK_FEEDBACK_APPLICATION_LIMIT,
    failedAfterFeedback,
    exhausted: applications.length >= BENCHMARK_FEEDBACK_APPLICATION_LIMIT && failedAfterFeedback,
    latestApplicationAt: latestApplication?.createdAt || null,
    latestRunId: Number(latestRun?.id || 0)
  };
}

function listBenchmarkQualityMatrix() {
  const cases = db.prepare(`
    SELECT id, case_key AS caseKey, topic_id AS topicId, label, domain_key AS domainKey,
           mechanism_type AS mechanismType, required_stages_json AS requiredStagesJson,
           expectations_json AS expectationsJson, enabled, created_at AS createdAt, updated_at AS updatedAt
    FROM benchmark_cases WHERE enabled = 1 AND topic_id IS NOT NULL ORDER BY id
  `).all();
  const rows = cases.map((caseRow) => {
    const benchmark = mapBenchmarkCaseRow(caseRow);
    const topic = mapTopicRow(getTopicStatement.get(benchmark.topicId));
    const factCheck = mapFactCheckRow(getFactCheckByTopicStatement.get(benchmark.topicId));
    const productionBrief = mapProductionBriefRow(getProductionBriefByTopicStatement.get(benchmark.topicId));
    const script = mapScriptRow(getScriptByTopicStatement.get(benchmark.topicId));
    const ttsRun = mapTtsRunRow(getLatestTtsRunByTopicStatement.get(benchmark.topicId));
    const shotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(benchmark.topicId));
    const gate = getRepresentativeGateDefinition(benchmark.topicId, shotlist);
    const approvedAssets = db.prepare(`
      SELECT asset_type AS assetType, clip_index AS clipIndex
      FROM asset_reviews WHERE topic_id = ? AND status IN ('AI_PASS', 'OK')
    `).all(benchmark.topicId);
    const approvedByType = (type) => new Set(approvedAssets.filter((asset) => asset.assetType === type).map((asset) => Number(asset.clipIndex)));
    const cleanApproved = approvedByType("clean");
    const infoApproved = approvedByType("info");
    for (const clipIndex of getCurrentAiPassedAssetIndexes(benchmark.topicId, shotlist, "clean")) cleanApproved.add(clipIndex);
    for (const clipIndex of getCurrentAiPassedAssetIndexes(benchmark.topicId, shotlist, "info")) infoApproved.add(clipIndex);
    const videoApproved = new Set(db.prepare(`
      SELECT clip_index AS clipIndex FROM video_jobs
      WHERE topic_id = ? AND status = 'completed' AND qc_status IN ('ai_passed', 'approved')
    `).all(benchmark.topicId).map((row) => Number(row.clipIndex)));
    const covers = (required, approved) => required.length > 0 && required.every((index) => approved.has(index));
    const latestDecision = db.prepare(`
      SELECT quality_run_id AS qualityRunId, stage, action, reason, score_delta AS scoreDelta,
             repeated_signature_count AS repeatedSignatureCount, cross_topic_count AS crossTopicCount,
             details_json AS detailsJson, created_at AS createdAt
      FROM quality_decisions WHERE topic_id = ? ORDER BY id DESC LIMIT 1
    `).get(benchmark.topicId) || null;
    if (latestDecision) {
      latestDecision.details = parseStoredJson(latestDecision.detailsJson, {});
      delete latestDecision.detailsJson;
    }
    const latestQualityRun = latestDecision ? db.prepare(`
      SELECT id, metrics_json AS metricsJson FROM quality_runs WHERE id = ?
    `).get(latestDecision.qualityRunId) : null;
    const latestFindingCodes = latestQualityRun ? db.prepare(`
      SELECT DISTINCT code FROM quality_findings WHERE quality_run_id = ? ORDER BY code
    `).all(latestQualityRun.id).map((finding) => finding.code) : [];
    const latestFindings = latestQualityRun ? db.prepare(`
      SELECT code, severity, message, repair_instruction AS repairInstruction
      FROM quality_findings WHERE quality_run_id = ? ORDER BY id
    `).all(latestQualityRun.id) : [];
    const latestReview = parseStoredJson(latestQualityRun?.resultJson, {})?.details?.review || null;
    const latestShotlistDecision = db.prepare(`
      SELECT qd.quality_run_id AS qualityRunId, qd.action, qd.reason,
             qr.metrics_json AS metricsJson
      FROM quality_decisions qd
      JOIN quality_runs qr ON qr.id = qd.quality_run_id
      WHERE qd.topic_id = ? AND qd.stage = 'shotlist_quality'
      ORDER BY qd.id DESC LIMIT 1
    `).get(benchmark.topicId) || null;
    if (latestShotlistDecision) {
      latestShotlistDecision.metrics = parseStoredJson(latestShotlistDecision.metricsJson, {});
      delete latestShotlistDecision.metricsJson;
    }
    const latestShotlistFindings = latestShotlistDecision ? db.prepare(`
      SELECT code, severity, message, repair_instruction AS repairInstruction
      FROM quality_findings WHERE quality_run_id = ? ORDER BY id
    `).all(latestShotlistDecision.qualityRunId) : [];
    const shotlistRepair = latestShotlistDecision
      ? classifyQualityRepairOwner("shotlist_quality", latestShotlistFindings, [])
      : { owner: "", route: "" };
    const minimumCoverageCount = Math.max(0, Math.ceil(Number(
      latestShotlistDecision?.metrics?.details?.minimumCoverageCount || 0
    )));
    const latestSourceEnrichment = db.prepare(`
      SELECT outcome, details_json AS detailsJson
      FROM topic_attempts
      WHERE topic_id = ? AND stage = 'source_enrichment'
      ORDER BY id DESC LIMIT 1
    `).get(benchmark.topicId) || null;
    const sourceEnrichmentDetails = parseStoredJson(latestSourceEnrichment?.detailsJson, {});
    const sourceEnrichmentShortfall = latestSourceEnrichment?.outcome === "failed"
      && Number(sourceEnrichmentDetails.minimumCoverageCount || 0) === minimumCoverageCount
      && Number(sourceEnrichmentDetails.verifiedVisualEvidenceCount || 0) < minimumCoverageCount;
    const inferredRepair = latestDecision
      ? classifyQualityRepairOwner(latestDecision.stage, latestFindings, [])
      : { owner: "", route: "" };
    const assetRemediations = getLatestAssetQualityRemediations(benchmark.topicId);
    const verifiedVisualStateCount = new Set((productionBrief?.visualStates?.length
      ? productionBrief.visualStates.map((state) => String(state.stateId || "").trim())
      : (factCheck?.visualEvidence || []).map((evidence) => String(evidence.id || evidence.state || "").trim()))
      .filter(Boolean)).size;
    let cachedDraftDurationSec = 0;
    try {
      const cache = JSON.parse(readFileSync(path.join(PROJECTS_DIR, `topic-${benchmark.topicId}`, "manifests", "SCRIPT_AI_CACHE.json"), "utf8"));
      cachedDraftDurationSec = estimateKoreanTtsDuration(cache?.script?.ttsText || "");
    } catch {
      cachedDraftDurationSec = 0;
    }
    const measuredOrEstimatedDurationSec = Number(
      (script?.status !== "approved" && cachedDraftDurationSec > 0 ? cachedDraftDurationSec : 0)
      || ttsRun?.totalDurationSec
      || ttsRun?.estimatedTotalDurationSec
      || estimateKoreanTtsDuration(script?.ttsText || "")
      || 0
    );
    const evidenceDurationCapacitySec = verifiedVisualStateCount > 0
      ? verifiedVisualStateCount * SCRIPT_STATE_TTS_BUDGET_SEC
      : 0;
    const factNeedsVisualReference = factCheck?.status === "HOLD"
      && /(시각|CLEAN|도면|단면|사진|참조)/u.test(`${factCheck.verdictReason || ""} ${factCheck.nextAction || ""}`);
    const stages = {
      factCheck: factCheck?.status === "PASS" ? "complete" : factNeedsVisualReference ? "needs_reference" : factCheck ? "blocked" : "pending",
      script: script?.status === "approved" ? "complete" : script ? "in_progress" : "pending",
      tts: ttsRun?.status === "generated" ? "complete" : ttsRun ? "stale" : "pending",
      shotlist: shotlist?.status === "approved" ? "complete" : shotlist ? shotlist.status : "pending",
      cleanSample: covers(gate.cleanClipIndexes || [], cleanApproved) ? "complete" : "pending",
      infoSample: covers(gate.infoClipIndexes || [], infoApproved) ? "complete" : "pending",
      videoSample: covers(gate.videoClipIndexes || [], videoApproved) ? "complete" : "pending"
    };
    const comparisonStageByAsset = {
      cleanSample: "clean_visual_quality",
      infoSample: "info_visual_quality",
      videoSample: "video_visual_quality"
    };
    for (const [assetStage, qualityStage] of Object.entries(comparisonStageByAsset)) {
      const assetRemediation = assetRemediations.get(qualityStage);
      if (assetRemediation?.clipIndexes?.length) {
        // A representative gate can be complete while a later non-gate CLEAN still
        // failed. Keep that unresolved asset correction ahead of video production.
        stages[assetStage] = assetRemediation.status;
      }
    }
    const hasShotlistUpstreamDecision = ["revise_upstream_contract", "revise_shared_contract"].includes(latestShotlistDecision?.action);
    if (stages.shotlist !== "complete" && hasShotlistUpstreamDecision) {
      if (shotlistRepair.route === "source_enrichment") {
        stages.shotlist = sourceEnrichmentShortfall ? "needs_remediation" : "needs_evidence";
      } else if (shotlistRepair.route === "visual_reference_enrichment") {
        stages.shotlist = "needs_reference";
      }
    }
    const feedback = {
      script: getBenchmarkFeedbackState(benchmark.topicId, "script_quality"),
      shotlist: getBenchmarkFeedbackState(benchmark.topicId, "shotlist_quality")
    };
    if (stages.script !== "complete" && feedback.script.exhausted) stages.script = "needs_evidence";
    if (stages.shotlist !== "complete" && feedback.shotlist.exhausted) stages.shotlist = "needs_evidence";
    const productionBriefIssueCodes = (productionBrief?.quality?.issues || []).map((issue) => issue.code);
    const productionBriefHoldText = JSON.stringify({
      notes: productionBrief?.raw?.notes || productionBrief?.raw?.generation?.notes || [],
      scope: productionBrief?.scopeStatement || "",
      quality: productionBrief?.quality || {}
    });
    const requiresVisualReference = productionBrief?.status === "hold"
      && (productionBriefIssueCodes.some((code) => [
          "clean_cutaway_forbidden",
          "occluded_element_required",
          "unverified_visual_state",
          "unverified_state_split"
        ].includes(code))
        || /(공식|검증된).{0,40}(사진|도면|단면|시각 자료|외부 자료).{0,80}(필요|없|확보)|참조.{0,30}(필요|부족)/u.test(productionBriefHoldText));
    if (stages.script !== "complete" && requiresVisualReference) stages.script = "needs_reference";
    const hasLatestScriptRevisionDecision = stages.script !== "complete"
      && !requiresVisualReference
      && latestDecision?.stage === "script_quality"
      && ["awaiting_benchmark_comparison", "revise_upstream_contract", "revise_shared_contract"].includes(latestDecision?.action)
      && cachedDraftDurationSec > 0;
    if (stages.script !== "complete"
      && hasLatestScriptRevisionDecision) {
      stages.script = "needs_revision";
    }
    if (stages.script !== "complete"
      && stages.script !== "needs_revision"
      && script?.status !== "draft"
      && !requiresVisualReference
      && verifiedVisualStateCount >= 2
      && measuredOrEstimatedDurationSec > evidenceDurationCapacitySec * 1.1) {
      stages.script = "needs_remediation";
    }
    const nextStage = Object.entries(stages).find(([, status]) => status !== "complete")?.[0] || "complete";
    const assetRemediation = assetRemediations.get(comparisonStageByAsset[nextStage]) || {
      stage: "", status: "", route: "", clipIndexes: [], reviewAction: null,
      decisionReason: "", repairInstruction: "", findings: [], promptDetails: [], assetQualityFeedback: null
    };
    let remediation = {
      route: "continue",
      summary: "현재 단계의 정상 진행이 가능합니다.",
      targetDurationSec: null,
      findingCodes: assetRemediation.findingCodes?.length ? assetRemediation.findingCodes : latestFindingCodes,
      assetStage: assetRemediation.stage || null,
      clipIndexes: assetRemediation.clipIndexes || [],
      reviewAction: assetRemediation.reviewAction || null,
      assetDecisionReason: assetRemediation.decisionReason || "",
      assetRepairInstruction: assetRemediation.repairInstruction || "",
      assetQualityFeedback: assetRemediation.assetQualityFeedback || null
    };
    if (stages[nextStage] === "needs_comparison") {
      remediation = {
        ...remediation,
        route: "cross_topic_asset_comparison",
        summary: "같은 자산 단계의 다른 메커니즘 샘플 1건을 먼저 검수해 공통 실패인지 비교합니다. 현재 실패 결과는 재생성하지 않습니다."
      };
    } else if (assetRemediation.stage && ["needs_reference", "needs_evidence"].includes(stages[nextStage])) {
      remediation = {
        ...remediation,
        route: assetRemediation.route,
        summary: assetRemediation.route === "fact_contract_revision"
          ? "자산 검수의 주장·근거 불일치를 사실 계약으로 승격합니다. 기존 실패 자산은 보존합니다."
          : assetRemediation.route === "production_contract_revision"
            ? "자산 검수의 물리·제작 계약 문제를 제작 브리프에서 보강합니다. 기존 실패 자산은 보존합니다."
            : "자산 검수가 요구한 공식 시각 근거를 먼저 보강합니다. 기존 실패 자산은 보존합니다."
      };
    } else if (nextStage === "shotlist" && sourceEnrichmentShortfall) {
      remediation = {
        ...remediation,
        route: "script_scope_compression",
        targetDurationSec: Number(sourceEnrichmentDetails.targetDurationSec || 0),
        findingCodes: latestShotlistFindings.map((finding) => finding.code),
        summary: "보강 사실 검증이 요구된 시각 근거 수를 확보하지 못했습니다. 이미 수행한 source enrichment를 반복하지 않고, 확보된 검증 상태 용량으로 대본을 축소합니다."
      };
    } else if (nextStage === "shotlist" && hasShotlistUpstreamDecision && shotlistRepair.route === "source_enrichment") {
      remediation = {
        ...remediation,
        route: "source_enrichment",
        findingCodes: latestShotlistFindings.map((finding) => finding.code),
        summary: "실제 TTS 길이를 덮을 검증 시각 상태·증거 비트가 부족합니다. 장면을 반복 생성하지 말고 공식 시각 참조를 사실 검증에 보강하거나 대본 범위를 줄여야 합니다."
      };
    } else if (stages[nextStage] === "needs_reference") {
      remediation = {
        ...remediation,
        route: "visual_reference_enrichment",
        summary: factNeedsVisualReference
          ? "사실 근거는 확인됐지만 내부 메커니즘을 추측 없이 만들 공식 사진·도면·단면 참조가 부족합니다. 주제를 폐기하지 않고 참조 대기로 유지합니다."
          : productionBriefIssueCodes.length
            ? `텍스트 근거는 확보했지만 CLEAN을 추측 없이 만들 실제 사진·구조도·단면 참조가 부족합니다. (${productionBriefIssueCodes.join(", ")})`
            : "텍스트 사실은 확인됐지만 핵심 공간 관계나 메커니즘을 화면에서 식별할 공식 사진·도면이 부족합니다. 주제를 폐기하지 않고 참조 대기로 유지합니다.",
        findingCodes: productionBriefIssueCodes
      };
    } else if (stages[nextStage] === "needs_revision") {
      // Reclassify stored findings with the current routing rules. Older decisions may
      // contain a route produced by a superseded classifier.
      const repairRoute = assetRemediation.route || inferredRepair.route || latestDecision?.details?.remediationRoute || "local_targeted_revision";
      remediation = {
        ...remediation,
        route: repairRoute,
        summary: repairRoute === "clean_targeted_replacement"
          ? "CLEAN 실패의 확인된 장면만 한 번 교체합니다. 상위 근거 문제는 별도 보강 경로로 승격합니다."
          : repairRoute === "info_targeted_repair"
            ? "같은 CLEAN을 유지한 채 INFO 명세·레이아웃만 한 번 교정해 다시 렌더링합니다."
            : repairRoute === "fact_contract_revision"
              ? "제목 또는 핵심 조건의 사실 범위가 검수에 실패했습니다. 대본을 다시 쓰지 않고 사실 계약과 제목부터 교정합니다."
              : "실패 결과를 보존하고 확인된 범위만 교정합니다."
      };
    } else if (stages[nextStage] === "needs_evidence" && verifiedVisualStateCount < 2) {
      remediation = {
        ...remediation,
        route: "source_enrichment",
        summary: `검증 시각 근거가 ${verifiedVisualStateCount}개라 제작 범위를 지탱할 수 없습니다. 공식 사진·도면·작동 설명을 사실 검증에 보강해야 합니다.`
      };
    } else if (["needs_evidence", "needs_remediation"].includes(stages[nextStage])
      && evidenceDurationCapacitySec > 0
      && measuredOrEstimatedDurationSec > evidenceDurationCapacitySec) {
      remediation = {
        ...remediation,
        route: "script_scope_compression",
        summary: `검증 상태 ${verifiedVisualStateCount}개로는 약 ${evidenceDurationCapacitySec}초가 안전합니다. 현재 ${measuredOrEstimatedDurationSec.toFixed(1)}초 대본을 필수 인과만 남겨 축소합니다.`,
        targetDurationSec: evidenceDurationCapacitySec
      };
    } else if (stages[nextStage] === "needs_evidence") {
      remediation = {
        ...remediation,
        route: "production_contract_revision",
        summary: "검수 실패 코드에 맞춰 제작 설계서의 시각 상태·INFO 관계를 다시 설계해야 합니다."
      };
    }
    return {
      benchmark: { id: benchmark.id, caseKey: benchmark.caseKey, label: benchmark.label, mechanismType: benchmark.mechanismType },
      topic: { id: topic.id, title: topic.title },
      stages,
      nextStage,
      feedback,
      evidenceProfile: {
        verifiedVisualStateCount,
        minimumCoverageCount,
        measuredOrEstimatedDurationSec: Number(measuredOrEstimatedDurationSec.toFixed(2)),
        evidenceDurationCapacitySec
      },
      remediation,
      representativeGate: gate,
      latestDecision
    };
  });
  const findingRows = db.prepare(`
    SELECT qf.stage, qf.code, qf.severity,
           COUNT(*) AS occurrenceCount,
           COUNT(DISTINCT qf.topic_id) AS topicCount,
           GROUP_CONCAT(DISTINCT bc.label) AS benchmarkLabels,
           MAX(qf.message) AS exampleMessage,
           MAX(qf.repair_instruction) AS repairInstruction
    FROM quality_findings qf
    JOIN quality_runs qr ON qr.id = qf.quality_run_id
    JOIN benchmark_cases bc ON bc.topic_id = qf.topic_id AND bc.enabled = 1
    WHERE qr.id = (
      SELECT MAX(latest.id) FROM quality_runs latest
      WHERE latest.topic_id = qf.topic_id AND latest.stage = qf.stage
    )
    GROUP BY qf.stage, qf.code, qf.severity
    ORDER BY topicCount DESC, occurrenceCount DESC, qf.stage, qf.code
  `).all().map((row) => ({
    stage: row.stage,
    code: row.code,
    severity: row.severity,
    occurrenceCount: Number(row.occurrenceCount || 0),
    topicCount: Number(row.topicCount || 0),
    benchmarkLabels: String(row.benchmarkLabels || "").split(",").filter(Boolean),
    exampleMessage: row.exampleMessage || "",
    repairInstruction: row.repairInstruction || ""
  }));
  return {
    policy: {
      id: QUALITY_ENGINE_VERSION,
      rule: "각 주제를 한 번 생성·검수하고 실패 산출물을 보존합니다. 5개 주제의 공통 실패만 계약에 반영하며 자동 재생성은 기본적으로 하지 않습니다.",
      repairWallMinutes: Math.round(QUALITY_REPAIR_WALL_MS / 60000),
      automaticRepairLimit: QUALITY_AUTO_REPAIR_LIMIT,
      reviewPolicy: "one_decisive_review_then_borderline_adjudication"
    },
    rows,
    sharedFindings: findingRows.filter((finding) => finding.topicCount >= 2),
    isolatedFindings: findingRows.filter((finding) => finding.topicCount === 1),
    completedCount: rows.filter((row) => row.nextStage === "complete").length,
    totalCount: rows.length
  };
}

function applySharedBenchmarkFindings() {
  const matrix = listBenchmarkQualityMatrix();
  const upstreamCodes = new Set([
    "repeated_visual_state",
    "insufficient_visual_depth",
    "missing_causal_state",
    "unsupported_visual",
    "impossible_geometry"
  ]);
  const sharedByStage = new Map();
  for (const finding of matrix.sharedFindings) {
    if (finding.stage === "shotlist_quality" && !upstreamCodes.has(finding.code)) continue;
    if (!["shotlist_quality", "script_quality"].includes(finding.stage)) continue;
    const codes = sharedByStage.get(finding.stage) || new Set();
    codes.add(finding.code);
    sharedByStage.set(finding.stage, codes);
  }
  if (!sharedByStage.size) return { appliedCount: 0, topics: [], codes: [] };

  const promoted = [];
  for (const row of matrix.rows) {
    const stage = row.nextStage === "shotlist" && row.stages.shotlist === "needs_revision"
      ? "shotlist_quality"
      : row.nextStage === "script" && row.stages.script === "in_progress"
        ? "script_quality"
        : "";
    if (!stage || (stage === "shotlist_quality" && !sharedByStage.has(stage))) continue;
    const feedbackState = getBenchmarkFeedbackState(row.topic.id, stage);
    if (feedbackState.applicationCount >= BENCHMARK_FEEDBACK_APPLICATION_LIMIT) continue;
    const latestRun = db.prepare(`
      SELECT id FROM quality_runs
      WHERE topic_id = ? AND stage = ?
      ORDER BY id DESC LIMIT 1
    `).get(row.topic.id, stage);
    if (!latestRun) continue;
    const allCodes = db.prepare(`
      SELECT DISTINCT code FROM quality_findings WHERE quality_run_id = ?
    `).all(latestRun.id).map((finding) => finding.code);
    const matchingCodes = allCodes.filter((code) => sharedByStage.get(stage)?.has(code));
    const appliedCodes = matchingCodes.length ? matchingCodes : stage === "script_quality" ? allCodes : [];
    const decisionAction = matchingCodes.length ? "revise_shared_contract" : "revise_upstream_contract";
    if (!appliedCodes.length) continue;

    const reason = matchingCodes.length
      ? `여러 벤치마크의 ${stage}에서 반복된 ${matchingCodes.join(", ")} 실패를 공통 제작 계약에 반영합니다.`
      : `${stage}의 단독 실패 ${appliedCodes.join(", ")}를 해당 주제의 상위 계약에 한 번 반영합니다.`;
    runDbTransaction(() => {
      db.prepare(`
        UPDATE quality_decisions
        SET action = ?, reason = ?
        WHERE quality_run_id = ?
      `).run(decisionAction, reason, latestRun.id);
      if (stage === "shotlist_quality") {
        db.prepare(`
          UPDATE scripts SET status = 'stale', approved_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE topic_id = ?
        `).run(row.topic.id);
        db.prepare(`
          UPDATE tts_runs SET status = 'stale', updated_at = CURRENT_TIMESTAMP
          WHERE topic_id = ? AND status != 'stale'
        `).run(row.topic.id);
        db.prepare(`
          UPDATE shotlists SET status = 'stale', updated_at = CURRENT_TIMESTAMP
          WHERE topic_id = ? AND status != 'stale'
        `).run(row.topic.id);
        updateTopicReviewStatement.run("verified", "script", row.topic.id);
      }
    });
    recordTopicAttempt(row.topic.id, "shared_quality_feedback", "stale", reason, {
      engineVersion: QUALITY_ENGINE_VERSION,
      sourceRunId: latestRun.id,
      stage,
      codes: appliedCodes
    });
    promoted.push({ topicId: row.topic.id, title: row.topic.title, stage, codes: appliedCodes, reason });
  }
  return {
    appliedCount: promoted.length,
    topics: promoted,
    codes: [...sharedByStage.entries()].flatMap(([stage, codes]) => [...codes].map((code) => `${stage}:${code}`))
  };
}

async function advanceBenchmarkQuality(payload = {}) {
  const matrix = listBenchmarkQualityMatrix();
  const requestedTopicId = Number(payload.topicId || 0);
  const row = requestedTopicId
    ? matrix.rows.find((candidate) => candidate.topic.id === requestedTopicId)
    : matrix.rows.find((candidate) => (
      candidate.nextStage !== "complete"
      && candidate.stages[candidate.nextStage] !== "needs_revision"
    ));
  if (!row) {
    return {
      advanced: false,
      reason: requestedTopicId
        ? "지정한 벤치마크를 찾지 못했거나 현재 자동 진행할 단계가 없습니다."
        : "자동 진행 가능한 벤치마크가 없습니다. 보류 결과의 공통 실패를 먼저 반영해야 합니다.",
      matrix
    };
  }
  const topicId = row.topic.id;
  if (["needs_evidence", "needs_comparison", "needs_reference", "needs_remediation"].includes(row.stages[row.nextStage])) {
    return {
      advanced: false,
      action: ["needs_evidence", "needs_reference", "needs_remediation"].includes(row.stages[row.nextStage]) ? "manual_evidence_required" : "awaiting_benchmark_comparison",
      reason: ["needs_evidence", "needs_reference", "needs_remediation"].includes(row.stages[row.nextStage])
        ? "공통 계약 보강 후에도 같은 단계가 다시 실패했습니다. 추가 AI 재생성 대신 검증 시각 근거 또는 제작 범위를 보강해야 합니다."
        : "첫 실패 샘플을 보존했습니다. 같은 자산 단계의 다른 벤치마크 결과와 비교하기 전에는 재생성하지 않습니다.",
      topicId,
      row
    };
  }
  const active = db.prepare(`
    SELECT * FROM jobs
    WHERE topic_id = ? AND status IN ('queued', 'running')
    ORDER BY id LIMIT 1
  `).get(topicId);
  if (active) return { advanced: false, reason: "이 벤치마크 작업이 이미 진행 중입니다.", job: mapJobRow(active), row };

  const shotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
  const script = mapScriptRow(getScriptByTopicStatement.get(topicId));
  const latestProductionCorrection = db.prepare(`
    SELECT details_json AS detailsJson FROM topic_attempts
    WHERE topic_id = ? AND stage = 'benchmark_contract_reset'
    ORDER BY id DESC LIMIT 1
  `).get(topicId);
  const pendingAssetQualityFeedback = parseStoredJson(latestProductionCorrection?.detailsJson, {}).assetQualityFeedback || null;
  if (shotlist?.status === "needs_revision" && !payload.forceRevision) {
    return {
      advanced: false,
      reason: "이 장면표는 AI 검토 보류 상태입니다. 다른 주제 결과와 공통 실패를 비교하기 전 재생성하지 않습니다.",
      row
    };
  }
  const plannedAction = row.nextStage === "factCheck"
    ? "fact_check"
    : row.nextStage === "script" && script?.status === "draft"
      ? "script_approved"
      : row.nextStage === "script"
        ? "script_generate"
        : row.nextStage === "tts"
          ? "tts_generate"
          : row.nextStage === "shotlist" && shotlist?.status === "draft"
    ? "shotlist_approved"
    : row.nextStage === "shotlist"
      ? "shotlist_generate"
      : row.nextStage === "cleanSample"
        ? "clean_sample"
        : row.nextStage === "infoSample"
          ? "info_sample"
          : row.nextStage === "videoSample"
            ? "video_sample"
            : "unsupported";
  if (payload.dryRun) {
    return { advanced: false, dryRun: true, plannedAction, topicId, row };
  }
  if (row.nextStage === "factCheck") {
    const queued = enqueueAiJob("fact_check", topicId, { source: payload.source || "quality_benchmark" });
    return { advanced: true, action: "fact_check", topicId, ...queued };
  }
  if (row.nextStage === "script") {
    if (script?.status === "draft") {
      approveScript({ id: topicId });
      return { advanced: true, action: "script_approved", topicId, row: listBenchmarkQualityMatrix().rows.find((candidate) => candidate.topic.id === topicId) };
    }
    const queued = enqueueAiJob("script_generate", topicId, { source: payload.source || "quality_benchmark" });
    return { advanced: true, action: "script_generate", topicId, ...queued };
  }
  if (row.nextStage === "tts") {
    const queued = enqueueAiJob("tts_generate", topicId, { source: payload.source || "quality_benchmark" });
    return { advanced: true, action: "tts_generate", topicId, ...queued };
  }
  if (row.nextStage === "shotlist") {
    if (shotlist?.status === "draft") {
      await approveShotlist({ topicId });
      return { advanced: true, action: "shotlist_approved", topicId, row: listBenchmarkQualityMatrix().rows.find((candidate) => candidate.topic.id === topicId) };
    }
    const queued = enqueueAiJob("shotlist_generate", topicId, {
      source: payload.source || "quality_benchmark",
      automaticRepairLimit: 0,
      ...(pendingAssetQualityFeedback?.findings?.length ? {
        remediationRoute: "local_targeted_revision",
        assetQualityFeedback: pendingAssetQualityFeedback,
        targetClipIndexes: pendingAssetQualityFeedback.clipIndexes || []
      } : {})
    });
    return { advanced: true, action: "shotlist_generate", topicId, ...queued };
  }
  if (row.nextStage === "cleanSample") {
    const correction = shotlist?.raw?.assetQualityCorrection;
    if (correction) {
      const clipIndexes = correction.changedContractPromptClipIndexes || [];
      if (!clipIndexes.length) {
        return { advanced: false, action: "clean_sample", topicId, reason: "제작 계약이 바뀌지 않은 CLEAN 프롬프트는 다시 생성하지 않습니다." };
      }
      return {
        advanced: true,
        action: "clean_sample",
        topicId,
        ...(await enqueueCleanImageGeneration({
          topicId,
          clipIndexes,
          scope: "sample",
          source: "quality_benchmark_contract_correction"
        }))
      };
    }
    return { advanced: true, action: "clean_sample", topicId, ...(await enqueueCleanImageGeneration({ topicId, scope: "sample", source: payload.source || "quality_benchmark" })) };
  }
  if (row.nextStage === "infoSample") {
    const queued = enqueueAiJob("info_image_generate", topicId, { scope: "sample", source: payload.source || "quality_benchmark" });
    return { advanced: true, action: "info_sample", topicId, ...queued };
  }
  if (row.nextStage === "videoSample") {
    return { advanced: true, action: "video_sample", topicId, ...(await queueVideoJobs({ topicId, scope: "sample", profileId: "quality" })) };
  }
  return { advanced: false, reason: `${row.nextStage} 단계는 자동 진행 대상이 아닙니다.`, row };
}

async function advanceAllBenchmarkQuality(payload = {}) {
  const sharedApplication = payload.applySharedFindings ? applySharedBenchmarkFindings() : { appliedCount: 0, topics: [], codes: [] };
  const matrix = listBenchmarkQualityMatrix();
  const requestedTopicIds = Array.isArray(payload.topicIds)
    ? new Set(payload.topicIds.map(Number).filter(Boolean))
    : null;
  const results = [];
  for (const row of matrix.rows) {
    if (requestedTopicIds && !requestedTopicIds.has(row.topic.id)) continue;
    if (row.nextStage === "complete" || ["needs_revision", "needs_evidence", "needs_comparison", "needs_reference", "needs_remediation"].includes(row.stages[row.nextStage]) && !payload.forceRevision) {
      results.push({
        topicId: row.topic.id,
        title: row.topic.title,
        advanced: false,
        action: row.nextStage === "complete"
          ? "complete"
          : ["needs_evidence", "needs_reference", "needs_remediation"].includes(row.stages[row.nextStage])
            ? "manual_evidence_required"
            : "awaiting_benchmark_comparison"
      });
      continue;
    }
    try {
      results.push(await advanceBenchmarkQuality({
        topicId: row.topic.id,
        dryRun: Boolean(payload.dryRun),
        forceRevision: Boolean(payload.forceRevision),
        source: "quality_benchmark_batch"
      }));
    } catch (error) {
      results.push({
        topicId: row.topic.id,
        title: row.topic.title,
        advanced: false,
        action: "failed_to_queue",
        reason: String(error.message || error)
      });
    }
  }
  return {
    dryRun: Boolean(payload.dryRun),
    advancedCount: results.filter((result) => result.advanced).length,
    results,
    sharedApplication,
    policy: listBenchmarkQualityMatrix().policy
  };
}

function markBenchmarkDependentsStale(topicId) {
  runDbTransaction(() => {
    db.prepare("UPDATE scripts SET status = 'stale', approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE topic_id = ?").run(topicId);
    db.prepare("UPDATE tts_runs SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'").run(topicId);
    db.prepare("UPDATE shotlists SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'").run(topicId);
    updateTopicReviewStatement.run('verified', 'script', topicId);
  });
}

function hasQueuedBenchmarkAssetRepair(topicId, route, clipIndex) {
  return db.prepare(`
    SELECT details_json AS detailsJson FROM topic_attempts
    WHERE topic_id = ? AND stage = 'benchmark_asset_repair' AND outcome = 'queued'
    ORDER BY id DESC LIMIT 20
  `).all(topicId).some((row) => {
    const details = parseStoredJson(row.detailsJson, {});
    return details.route === route && (details.clipIndexes || []).includes(clipIndex);
  });
}

async function remediateAllBenchmarkQuality(payload = {}) {
  const rows = [...listBenchmarkQualityMatrix().rows].sort((left, right) => {
    const priority = { clean_targeted_replacement: 0, info_targeted_repair: 1, production_contract_revision: 2, fact_contract_revision: 3, visual_reference_enrichment: 4, local_targeted_revision: 5, script_scope_compression: 6, source_enrichment: 7 };
    return Number(priority[left.remediation?.route] ?? 9) - Number(priority[right.remediation?.route] ?? 9);
  });
  const results = [];
  for (const row of rows) {
    const topicId = row.topic.id;
    const route = row.remediation?.route;
    if (!['clean_targeted_replacement', 'info_targeted_repair', 'local_targeted_revision', 'production_contract_revision', 'fact_contract_revision', 'visual_reference_enrichment', 'script_scope_compression', 'source_enrichment'].includes(route)) continue;
    const active = db.prepare(`
      SELECT * FROM jobs WHERE topic_id = ? AND status IN ('queued', 'running') ORDER BY id LIMIT 1
    `).get(topicId);
    if (active) {
      results.push({ topicId, route, queued: false, reason: '이미 진행 중인 작업이 있습니다.', job: mapJobRow(active) });
      continue;
    }
    const assetStage = row.remediation?.assetStage;
    const fallbackClipIndexes = assetStage === 'clean_visual_quality'
      ? row.representativeGate?.cleanClipIndexes || []
      : assetStage === 'info_visual_quality'
        ? row.representativeGate?.infoClipIndexes || []
        : [];
    const clipIndexes = [...new Set((row.remediation?.clipIndexes?.length ? row.remediation.clipIndexes : fallbackClipIndexes).map(Number).filter(Boolean))];
    if (payload.dryRun) {
      results.push({ topicId, route, queued: false, dryRun: true, clipIndexes, targetDurationSec: row.remediation.targetDurationSec });
      continue;
    }
    if (route === 'clean_targeted_replacement' || route === 'info_targeted_repair') {
      if (!clipIndexes.length) {
        results.push({ topicId, route, queued: false, reason: '실패 장면을 특정할 수 없어 비교 대기로 유지합니다.' });
        continue;
      }
      if (route === 'info_targeted_repair' && row.stages.cleanSample !== 'complete') {
        results.push({ topicId, route, clipIndexes, queued: false, reason: '같은 CLEAN이 독립 검수를 통과하기 전에는 INFO만 교정할 수 없습니다.' });
        continue;
      }
      for (const clipIndex of clipIndexes) {
        if (hasQueuedBenchmarkAssetRepair(topicId, route, clipIndex)) {
          results.push({ topicId, route, clipIndex, queued: false, reason: '이 장면의 제한된 자산 교정은 이미 한 번 예약되었습니다.' });
          continue;
        }
        const queued = route === 'clean_targeted_replacement'
          ? await enqueueCleanImageGeneration({
            topicId, clipIndexes: [clipIndex], scope: 'sample', force: true,
            preserveFailedArtifact: true, replacementForQualityRepair: true,
            source: 'quality_benchmark_asset_repair'
          })
          : enqueueAiJob('info_image_generate', topicId, {
            clipIndexes: [clipIndex], scope: 'sample', force: true,
            preserveFailedArtifact: true, replacementForQualityRepair: true,
            revisionInstruction: row.remediation?.reviewAction === 'drop'
              ? '독립 검수가 INFO 제거를 요청했습니다. type=none으로 바꾸고 동일 CLEAN을 그대로 렌더링하세요.'
              : String(
                row.remediation?.assetRepairInstruction
                || row.remediation?.assetDecisionReason
                || '독립 검수의 확인된 INFO 문제만 교정하세요.'
              ),
            source: 'quality_benchmark_asset_repair'
          });
        recordTopicAttempt(topicId, 'benchmark_asset_repair', 'queued', '실패 자산을 한 번만 국소 교정하도록 예약했습니다.', {
          route,
          clipIndexes: [clipIndex],
          assetStage,
          assetDecisionReason: row.remediation?.assetDecisionReason || '',
          assetRepairInstruction: row.remediation?.assetRepairInstruction || '',
          findingCodes: row.remediation?.findingCodes || []
        });
        results.push({ topicId, route, clipIndex, queued: true, ...queued });
      }
      continue;
    }
    if (['fact_contract_revision', 'visual_reference_enrichment', 'source_enrichment'].includes(route)) {
      markBenchmarkDependentsStale(topicId);
      const reportedMinimumCoverageCount = Math.max(0, Math.ceil(Number(row.evidenceProfile?.minimumCoverageCount || 0)));
      const durationCoverageCount = Math.ceil(Math.max(0, Number(
        row.evidenceProfile?.measuredOrEstimatedDurationSec || 0
      )) / NATIVE_CLIP_DURATION_SEC);
      const targetVisualEvidenceCount = route === 'source_enrichment'
        ? Math.max(2, reportedMinimumCoverageCount, durationCoverageCount)
        : Math.min(5, Math.max(2, Number(row.evidenceProfile?.verifiedVisualStateCount || 2)));
      const queued = enqueueAiJob('fact_check', topicId, {
        source: 'quality_benchmark_remediation', remediationRoute: route, force: true, targetVisualEvidenceCount
      });
      recordTopicAttempt(topicId, 'benchmark_contract_reset', 'ready', '상위 사실·시각 근거 계약을 보강하고 하위 산출물을 stale로 전환했습니다.', { route, source: 'quality_benchmark_remediation' });
      results.push({ topicId, route, targetVisualEvidenceCount, queued: true, ...queued });
      continue;
    }
    if (route === 'production_contract_revision') {
      const assetQualityFeedback = row.remediation?.assetQualityFeedback || {
        stage: assetStage,
        clipIndexes,
        findings: [],
        promptDetails: []
      };
      markBenchmarkDependentsStale(topicId);
      const queued = enqueueAiJob('production_brief_generate', topicId, {
        source: 'quality_benchmark_remediation',
        remediationRoute: route,
        force: true,
        assetQualityFeedback,
        targetClipIndexes: assetQualityFeedback.clipIndexes || clipIndexes
      });
      recordTopicAttempt(topicId, 'benchmark_contract_reset', 'ready', 'CLEAN 실패의 장면·프롬프트 계약을 제작 브리프로 올리고 하위 산출물을 stale로 전환했습니다.', {
        route,
        source: 'quality_benchmark_remediation',
        assetQualityFeedback
      });
      results.push({ topicId, route, clipIndexes: assetQualityFeedback.clipIndexes || clipIndexes, queued: true, ...queued });
      continue;
    }
    markBenchmarkDependentsStale(topicId);
    const repairMessage = route === 'local_targeted_revision'
      ? '사실 계약은 유지하고 최신 AI 검수 지시가 가리킨 대본 범위만 교정합니다.'
      : `검증 시각 상태 용량에 맞춰 대본을 약 ${row.remediation.targetDurationSec}초로 다시 설계합니다.`;
    recordTopicAttempt(topicId, 'benchmark_contract_reset', 'ready', repairMessage, {
      route, targetDurationSec: row.remediation.targetDurationSec, source: 'quality_benchmark_remediation'
    });
    const queued = enqueueAiJob('script_generate', topicId, {
      source: 'quality_benchmark_remediation', remediationRoute: route, targetDurationSec: row.remediation.targetDurationSec
    });
    results.push({ topicId, route, queued: true, ...queued });
  }
  return { dryRun: Boolean(payload.dryRun), queuedCount: results.filter((result) => result.queued).length, results };
}

function cancelJob(payload) {
  const id = Number(payload.id);
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  if (!row) throw new Error("취소할 작업을 찾을 수 없습니다.");
  if (["completed", "failed", "canceled"].includes(row.status)) return { job: mapJobRow(row) };
  db.prepare(`
    UPDATE jobs SET cancel_requested = 1,
      status = CASE WHEN status = 'queued' THEN 'canceled' ELSE status END,
      message = '취소 요청을 처리 중입니다.', updated_at = CURRENT_TIMESTAMP,
      completed_at = CASE WHEN status = 'queued' THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ?
  `).run(id);
  appendJobEvent(id, row.topic_id, "cancel_requested", row.progress, "사용자가 작업 취소를 요청했습니다.", {}, "warning");
  return { job: mapJobRow(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id)) };
}

async function runTopicOperation(topicId, operation, callback) {
  const active = activeTopicOperations.get(topicId);
  if (active) {
    throw new Error(`이 주제는 현재 ${active} 작업 중입니다. 완료 후 다시 시도하세요.`);
  }
  activeTopicOperations.set(topicId, operation);
  try {
    return await callback();
  } finally {
    activeTopicOperations.delete(topicId);
  }
}

async function runAudioGpuOperation(operation, callback) {
  if (videoWorkerActive) {
    throw new Error("MiniMax H3 영상 생성 큐가 GPU를 사용 중입니다. 영상 큐가 끝난 뒤 음성을 생성하세요.");
  }
  if (activeAudioGpuOperation) {
    throw new Error(`현재 ${activeAudioGpuOperation} 작업이 GPU를 사용 중입니다.`);
  }
  activeAudioGpuOperation = operation;
  try {
    return await callback();
  } finally {
    activeAudioGpuOperation = "";
    queueMicrotask(() => runVideoWorker().catch((error) => console.error("Video worker failed:", error)));
  }
}

const preferredEvidenceDomains = [
  "sillok.history.go.kr",
  "encykorea.aks.ac.kr",
  "db.history.go.kr",
  "contents.history.go.kr",
  "history.go.kr",
  "heritage.go.kr",
  "cha.go.kr",
  "museum.go.kr",
  "archives.go.kr",
  "koreanhistory.or.kr",
  "nist.gov",
  "nasa.gov",
  "fhwa.dot.gov",
  "usace.army.mil",
  "asme.org",
  "asce.org",
  "ctbuh.org",
  "skyscrapercenter.com",
  "som.com",
  "arup.com",
  "fosterandpartners.com",
  "gensler.com",
  "oma.com",
  "pcparch.com",
  "sydneyoperahouse.com",
  "toureiffel.paris",
  "duomo.firenze.it",
  "motioneering.ca",
  "guggenheim.org",
  "louvre.fr",
  "kimbellart.org",
  "edenproject.com",
  "rshp.com",
  "related.com",
  "bochk.com",
  "pcf-prod.typeco.de",
  "nspe.org",
  "jmayerh.de",
  "dlubal.com",
  "pci.org",
  "habitat67.com",
  "herzogdemeuron.com",
  "scottishcanals.co.uk",
  "eiffagegeniecivil.com",
  "goldengate.org",
  "gov.uk",
  "ice.org.uk",
  "metmuseum.org",
  "getty.edu",
  "loc.gov",
  "unesco.org",
  "architectmagazine.com",
  "structurae.net",
  "iso.org",
  "ieee.org",
  "sciencedirect.com",
  "springer.com",
  "doi.org"
];

function isPreferredEvidenceUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname.endsWith(".gov") || hostname.endsWith(".edu")
      || preferredEvidenceDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&quot;/gu, "\"")
    .replace(/&#039;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

function extractLinks(html, baseUrl) {
  const links = [];
  const anchorRegex = /<a\s+[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/giu;
  let match;
  while ((match = anchorRegex.exec(html))) {
    const rawHref = decodeHtmlEntities(match[2]);
    const label = stripHtml(match[3] || "").slice(0, 120);
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;
    try {
      const url = new URL(rawHref, baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      links.push({
        title: label || url.hostname,
        url: url.toString()
      });
    } catch {
      // Ignore malformed links.
    }
  }
  return links;
}

function extractImages(html, baseUrl) {
  const images = [];
  const imageRegex = /<img\b([^>]*?)>/giu;
  let match;
  while ((match = imageRegex.exec(html))) {
    const attrs = match[1] || "";
    const srcMatch = attrs.match(/(?:src|data-src)=(['"])(.*?)\1/iu);
    const altMatch = attrs.match(/alt=(['"])(.*?)\1/iu);
    if (!srcMatch?.[2]) continue;
    try {
      const url = new URL(decodeHtmlEntities(srcMatch[2]), baseUrl);
      const label = stripHtml(decodeHtmlEntities(altMatch?.[2] || "")).slice(0, 180);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      if (/logo|icon|avatar|sprite|tracking|pixel|\.svg(?:$|[?#])/iu.test(`${label} ${url}`)) continue;
      images.push({ title: label || path.basename(url.pathname) || "source image", url: url.toString() });
    } catch {
      // Ignore malformed image URLs.
    }
  }
  return images.filter((image, index, all) => all.findIndex((item) => item.url === image.url) === index).slice(0, 24);
}

function sourcePreferenceScore(link, topic, unresolvedTerms = []) {
  let score = 0;
  const hostname = new URL(link.url).hostname.replace(/^www\./u, "");
  const domainIndex = preferredEvidenceDomains.findIndex((domain) => hostname.endsWith(domain));
  if (domainIndex !== -1) score += 80 - domainIndex * 3;
  if (hostname.endsWith(".gov") || hostname.endsWith(".edu") || hostname.endsWith(".ac.kr")) score += 60;
  if (hostname.includes("wikipedia.org")) score += 12;

  const haystack = `${link.title} ${decodeURIComponent(link.url)}`;
  if (/위키백과:|사용자:|토론:|대문|사랑방|관리 요청|사용자 모임|portal:|help:/iu.test(haystack)) {
    return -100;
  }
  for (const term of meaningfulTerms(topic.sourceTitle, topic.title, ...unresolvedTerms)) {
    if (haystack.includes(term)) score += 5;
  }
  if (/실록|사료|백과|문화재|기록|논문|자료|standard|technical|research|engineering|journal|paper/iu.test(haystack)) score += 12;
  if (/파일:|분류:|특수:|편집|oldid|action=/u.test(haystack)) score -= 40;
  return score;
}

async function extractPdfText(pdfBuffer, sourceUrl) {
  const parsedUrl = new URL(sourceUrl);
  const safeName = path.basename(parsedUrl.pathname).replace(/[^a-zA-Z0-9._-]/gu, "_") || "source.pdf";
  const pdfPath = path.join(SOURCE_CACHE_DIR, `${Date.now()}-${randomUUID()}-${safeName}`);
  await writeFile(pdfPath, pdfBuffer);
  try {
    const { stdout } = await runProcess(PDF_PYTHON_BIN, [PDF_TEXT_RUNNER, pdfPath], {
      env: { PYTHONIOENCODING: "utf-8" }
    });
    return stdout.replace(/\u0000/gu, " ").replace(/[ \t]+/gu, " ").trim();
  } finally {
    await unlink(pdfPath).catch(() => {});
  }
}

function selectRelevantSourceExcerpt(text, terms, maxLength = 12000) {
  const source = String(text || "").replace(/\r\n/gu, "\n").trim();
  if (source.length <= maxLength) return source;
  const lowered = source.toLowerCase();
  const windows = [];
  const seenStarts = new Set();
  for (const term of [...new Set((terms || []).map((value) => String(value || "").trim().toLowerCase()).filter((value) => value.length >= 3))]) {
    let fromIndex = 0;
    for (let matchCount = 0; matchCount < 3; matchCount += 1) {
      const index = lowered.indexOf(term, fromIndex);
      if (index < 0) break;
      const start = Math.max(0, index - 1800);
      if (![...seenStarts].some((value) => Math.abs(value - start) < 900)) {
        seenStarts.add(start);
        windows.push(source.slice(start, Math.min(source.length, index + 4200)));
      }
      fromIndex = index + term.length;
    }
  }
  if (!windows.length) return source.slice(0, maxLength);
  return windows.join("\n\n[...relevant source section...]\n\n").slice(0, maxLength);
}

async function fetchWikipediaExtract(sourceUrl) {
  const parsedUrl = new URL(sourceUrl);
  if (!parsedUrl.hostname.endsWith("wikipedia.org") || !parsedUrl.pathname.startsWith("/wiki/")) return null;
  const title = decodeURIComponent(parsedUrl.pathname.slice("/wiki/".length)).replaceAll("_", " ");
  const params = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    redirects: "1",
    titles: title,
    format: "json",
    formatversion: "2"
  });
  const response = await fetch(`${parsedUrl.origin}/w/api.php?${params.toString()}`, {
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "cinematic-shorts-dashboard/0.1 personal local research" }
  });
  if (!response.ok) return null;
  const page = (await response.json())?.query?.pages?.[0];
  const text = String(page?.extract || "").trim();
  if (!text) return null;
  return {
    url: sourceUrl,
    title: cleanTitle(page.title || title),
    text: text.slice(0, 20000),
    links: []
  };
}

async function fetchSourceDocument(sourceUrl, timeoutMs = 8000) {
  if (!sourceUrl) {
    return {
      url: "",
      title: "출처 URL 없음",
      text: "출처 URL 없음.",
      links: []
    };
  }
  try {
    const wikipediaExtract = await fetchWikipediaExtract(sourceUrl);
    if (wikipediaExtract) return wikipediaExtract;
    const response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "cinematic-shorts-dashboard/0.1 personal local fact check"
      }
    });
    if (!response.ok) {
      return {
        url: sourceUrl,
        title: sourceUrl,
        text: `출처 페이지 요청 실패: HTTP ${response.status}`,
        links: []
      };
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const contentDisposition = String(response.headers.get("content-disposition") || "").toLowerCase();
    const body = Buffer.from(await response.arrayBuffer());
    const isPdf = contentType.includes("application/pdf")
      || contentDisposition.includes(".pdf")
      || /\.pdf(?:$|[?#])/iu.test(sourceUrl)
      || body.subarray(0, 5).toString("ascii") === "%PDF-";
    if (isPdf) {
      const text = await extractPdfText(body, sourceUrl);
      return {
        url: sourceUrl,
        title: path.basename(new URL(sourceUrl).pathname) || sourceUrl,
        text: text ? text.slice(0, 250000) : "PDF에서 추출 가능한 텍스트를 찾지 못했습니다.",
        links: [],
        images: []
      };
    }

    const html = body.toString("utf8");
    const text = stripHtml(
      html
        .replace(/<script[\s\S]*?<\/script>/giu, " ")
        .replace(/<style[\s\S]*?<\/style>/giu, " ")
        .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/giu, " ")
        .replace(/<\/(p|h1|h2|h3|li|tr)>/giu, "\n")
    );
    return {
      url: sourceUrl,
      title: sourceUrl,
      text: text.slice(0, 9000),
      links: extractLinks(html, sourceUrl),
      images: extractImages(html, sourceUrl)
    };
  } catch (error) {
    return {
      url: sourceUrl,
      title: sourceUrl,
      text: `출처 페이지를 읽지 못했습니다: ${error.message}`,
      links: []
    };
  }
}

function isReadableSourceDocument(document) {
  const text = String(document?.text || "").trim();
  return text.length >= 180
    && !text.startsWith("출처 페이지를 읽지 못했습니다")
    && !text.startsWith("출처 페이지 요청 실패")
    && !text.startsWith("PDF에서 추출 가능한 텍스트를 찾지 못했습니다")
    && !text.startsWith("출처 URL 없음");
}

async function fetchSourceContext(sourceUrl) {
  const document = await fetchSourceDocument(sourceUrl);
  return document.text;
}

function getCanaryFactScope(topic) {
  const candidate = topic?.candidate || parseStoredJson(topic?.candidateJson, {});
  let manifest = candidate;
  if (topic?.runLane === "production_canary") {
    try {
      manifest = loadProductionCanaryManifest(topic.externalKey).manifest;
    } catch {
      // Retain the imported snapshot when a manifest is unavailable.
    }
  }
  return {
    scope: String(manifest?.scope || "").trim(),
    hiddenMechanismExclusions: Array.isArray(manifest?.hiddenMechanismExclusions)
      ? manifest.hiddenMechanismExclusions.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    factSources: Array.isArray(manifest?.factSources)
      ? manifest.factSources.filter((source) => String(source?.url || "").trim())
      : [],
    productionRequirements: normalizeProductionRequirements(manifest?.productionRequirements)
  };
}

function buildEnrichmentQueries(topic, factCheck) {
  const canaryScope = getCanaryFactScope(topic);
  if (topic.runLane === "production_canary") {
    return [...new Set([
      `${topic.sourceTitle} ${canaryScope.scope}`,
      ...canaryScope.factSources.map((source) => `${topic.sourceTitle} ${source.title || source.url}`)
    ].filter(Boolean))].slice(0, 8);
  }
  const unresolved = factCheck?.unresolved || [];
  const needed = unresolved
    .map((item) => [item.item, item.needed].filter(Boolean).join(" "))
    .filter(Boolean)
    .slice(0, 4);
  const base = topic.mainTopic === "history" ? [
    `${topic.sourceTitle} ${topic.subtopic} 공식 자료`,
    `${topic.sourceTitle} 한국민족문화대백과`,
    `${topic.sourceTitle} 조선왕조실록`,
    `${topic.sourceTitle} 국사편찬위원회`
  ] : [
    `${topic.sourceTitle} ${topic.title} ${topic.hook}`,
    `"${topic.sourceTitle}" why cause origin failure engineering`,
    `"${topic.sourceTitle}" problem intervention before after engineering`,
    `"${topic.sourceTitle}" structural system official engineering`,
    `"${topic.sourceTitle}" mechanism engineering case study`,
    `"${topic.sourceTitle}" official operation diagram open closed movement support`,
    `"${topic.sourceTitle}" section animation bearing hinge guide contact`,
    `${topic.sourceTitle} ${topic.subtopic} engineering mechanism official`,
    `${topic.sourceTitle} load path pressure flow technical paper`,
    `${topic.sourceTitle} visible states support contact motion geometry`
  ];
  const mechanismQuery = engineeringEvidenceQueries[topic.sourceTitle];
  return [...new Set([mechanismQuery, ...needed, ...base].filter(Boolean))].slice(0, 8);
}

async function collectEnrichmentSources(topic, baseDocument, factCheck) {
  const queries = buildEnrichmentQueries(topic, factCheck);
  const canaryScope = getCanaryFactScope(topic);
  const academicSources = [];
  if (topic.mainTopic !== "history" && topic.runLane !== "production_canary") {
    try {
      const mappedQuery = engineeringEvidenceQueries[topic.sourceTitle] || "";
      const englishTitle = await fetchEnglishWikipediaTitle(topic.sourceTitle);
      if (mappedQuery || englishTitle) {
        const academicHint = {
          "건축공학": "structural engineering mechanics design",
          "토목공학": "civil structural engineering mechanics",
          "도시공학": "urban infrastructure engineering",
          "기계공학": "mechanical engineering mechanism",
          "항공공학": "aerospace engineering aerodynamics",
          "유체역학": "fluid mechanics pressure flow",
          "밀리터리 엔지니어링": "protective structural engineering"
        }[topic.subtopic] || "engineering mechanism";
        const academicQuery = mappedQuery || `${englishTitle} ${academicHint}`;
        queries.unshift(academicQuery);
        academicSources.push(...await fetchCrossrefEvidence(academicQuery));
      }
    } catch {
      // Continue with ordinary web enrichment when academic lookup is unavailable.
    }
  }
  const unresolvedTerms = (factCheck?.unresolved || [])
    .flatMap((item) => [item.item, item.needed, item.issue])
    .filter(Boolean);
  const candidates = new Map();

  for (const link of evidenceSourcesForCase(topic.sourceTitle)) {
    candidates.set(link.url, { ...link, score: 120 });
  }
  for (const link of canaryScope.factSources) {
    candidates.set(link.url, { ...link, score: 120, pinned: true });
  }

  for (const link of baseDocument.links || []) {
    try {
      const normalized = new URL(link.url).toString();
      const scored = {
        ...link,
        score: sourcePreferenceScore(link, topic, unresolvedTerms)
      };
      if (scored.score >= 20 && !candidates.has(normalized)) {
        candidates.set(normalized, scored);
      }
    } catch {
      // Ignore malformed links.
    }
  }

  for (const query of queries.slice(0, 5)) {
    try {
      const results = await fetchWebSearch(query);
      for (const result of results.slice(0, 6)) {
        const normalized = new URL(result.url).toString();
        const scored = {
          ...result,
          score: sourcePreferenceScore(result, topic, unresolvedTerms)
        };
        if (scored.score >= 45 && !candidates.has(normalized)) {
          candidates.set(normalized, scored);
        }
      }
    } catch {
      // Search is best-effort; the verifier will stop if no stronger source is found.
    }
  }

  const rankedLinks = [...candidates.values()]
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.score - a.score)
    .filter((link) => link.score >= 45)
    .slice(0, 6);

  const documents = [];
  const excerptTerms = meaningfulTerms(topic.sourceTitle, topic.title, ...unresolvedTerms);
  for (const link of rankedLinks) {
    const doc = await fetchSourceDocument(link.url, link.score >= 120 ? 30000 : 8000);
    if (doc.text && !doc.text.startsWith("출처 페이지를 읽지 못했습니다") && !doc.text.startsWith("출처 페이지 요청 실패")) {
      documents.push({
        title: link.title,
        url: link.url,
        score: link.score,
        text: [
          selectRelevantSourceExcerpt(doc.text, excerptTerms, 12000),
          ...(doc.images?.length ? ["[AVAILABLE SOURCE IMAGES]", ...doc.images.map((image) => `${image.title}: ${image.url}`)] : [])
        ].join("\n")
      });
    }
  }

  return {
    queries,
    sources: [...academicSources, ...documents]
      .filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index)
      .slice(0, 8)
  };
}

async function fetchWikipediaSearch(query, limit = 12) {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srnamespace: "0",
    srlimit: String(Math.max(1, Math.min(limit, 50))),
    format: "json",
    formatversion: "2"
  });
  const url = `https://ko.wikipedia.org/w/api.php?${params.toString()}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: {
      "User-Agent": "cinematic-shorts-dashboard/0.1 personal local topic research"
    }
  });

  if (!response.ok) {
    throw new Error(`검색 실패: ${response.status}`);
  }

  const payload = await response.json();
  return (payload?.query?.search || [])
    .map((item) => cleanTitle(item.title))
    .filter((title) => title && !title.includes("위키백과:") && !title.includes("파일:"))
    .map((title) => ({
      title,
      url: `https://ko.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`
    }));
}

async function fetchWebSearch(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      "User-Agent": "cinematic-shorts-dashboard/0.1 personal local enrichment search"
    }
  });
  if (!response.ok) return [];

  const html = await response.text();
  const results = [];
  const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu;
  let match;
  while ((match = resultRegex.exec(html))) {
    try {
      const rawUrl = decodeHtmlEntities(match[1]);
      const urlObject = new URL(rawUrl, "https://duckduckgo.com");
      const target = urlObject.searchParams.get("uddg") || urlObject.toString();
      results.push({
        title: stripHtml(match[2]),
        url: target
      });
    } catch {
      // Ignore malformed results.
    }
  }
  return results;
}

async function fetchEnglishWikipediaTitle(title) {
  const params = new URLSearchParams({
    action: "query",
    prop: "langlinks",
    titles: title,
    lllang: "en",
    lllimit: "1",
    redirects: "1",
    format: "json",
    formatversion: "2"
  });
  const response = await fetch(`https://ko.wikipedia.org/w/api.php?${params.toString()}`, {
    signal: AbortSignal.timeout(6000),
    headers: { "User-Agent": "cinematic-shorts-dashboard/0.1 personal local fact check" }
  });
  if (!response.ok) return "";
  const payload = await response.json();
  return String(payload?.query?.pages?.[0]?.langlinks?.[0]?.title || "").trim();
}

async function fetchCrossrefEvidence(query) {
  const params = new URLSearchParams({
    "query.title": query,
    rows: "30",
    select: "DOI,title,abstract,URL,published"
  });
  const response = await fetch(`https://api.crossref.org/works?${params.toString()}`, {
    signal: AbortSignal.timeout(10000),
    headers: { "User-Agent": "cinematic-shorts-dashboard/0.1 personal local fact check" }
  });
  if (!response.ok) return [];
  const payload = await response.json();
  const requiresSteelReinforcement = /steel reinforced concrete/iu.test(query);
  return (payload?.message?.items || [])
    .map((item) => {
      const text = stripHtml(String(item.abstract || "")).replace(/\s+/gu, " ").trim();
      const title = cleanTitle(Array.isArray(item.title) ? item.title[0] : item.title);
      const doi = String(item.DOI || "").trim();
      return {
        title,
        url: doi ? `https://doi.org/${doi}` : String(item.URL || ""),
        score: 98,
        text
      };
    })
    .filter((item) => item.title && item.url && item.text.length >= 180)
    .filter((item) => !requiresSteelReinforcement || !/\b(FRP|bamboo|fibre|fiber)\b/iu.test(item.title))
    .slice(0, 2);
}

function scoreSourceQuality(mainTopic, subtopic, source) {
  const title = cleanTitle(source.title || "");
  const seed = cleanTitle(source.seed || "");
  const normalizedTitle = normalizeText(title);
  const normalizedSeed = normalizeText(seed);
  const normalizedSubtopic = normalizeText(subtopic);

  if (!title || title.length < 2) return -100;
  if (genericSourceTitles.has(title)) return -80;
  if (hasAnyKeyword(title, noisyTitleFragments)) return -70;

  let score = 0;
  if (normalizedSeed && normalizedTitle === normalizedSeed) {
    score += 32;
  } else if (normalizedSeed && (normalizedTitle.includes(normalizedSeed) || normalizedSeed.includes(normalizedTitle))) {
    score += 24;
  } else {
    score -= 18;
  }

  if (normalizedSubtopic && normalizedTitle.includes(normalizedSubtopic)) score += 6;
  if (title.length >= 3 && title.length <= 16) score += 6;
  if (title.length > 24) score -= 6;
  if (isPersonLikeTitle(title) && normalizedTitle !== normalizedSeed) score -= 16;

  const domainMechanisms = mechanismKeywords[mainTopic] || [];
  score += domainMechanisms.filter((keyword) => title.includes(keyword)).length * 3;
  score += visualKeywords.filter((keyword) => title.includes(keyword)).length * 2;
  score -= riskKeywords.filter((keyword) => title.includes(keyword)).length * 5;

  return score;
}

function isUsefulSource(mainTopic, subtopic, source) {
  return scoreSourceQuality(mainTopic, subtopic, source) >= 14;
}

function meaningfulTerms(...values) {
  const stopwords = new Set(["조선", "시대", "역사", "공학", "과학", "원리", "구조"]);
  return values.flatMap((value) => cleanTitle(String(value || ""))
    .split(/[\s·ㆍ,./:;!?'"()[\]{}<>-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !stopwords.has(term)));
}

function prevalidateSource(mainTopic, subtopic, source, sourceContext) {
  if (!sourceContext || sourceContext.startsWith("출처 페이지")) {
    return {
      passed: false,
      score: 0,
      reason: "출처 본문을 읽지 못해 사전검증에서 제외."
    };
  }

  const title = cleanTitle(source.title);
  const normalizedContext = normalizeText(sourceContext);
  const normalizedTitle = normalizeText(title);
  const normalizedSeed = normalizeText(source.seed || "");
  const terms = meaningfulTerms(title, source.seed, subtopic);
  const termHits = terms.filter((term) => normalizedContext.includes(normalizeText(term)));
  const evidenceHits = (sourceEvidenceKeywords[mainTopic] || [])
    .filter((keyword) => normalizedContext.includes(normalizeText(keyword)));

  let score = 0;
  if (normalizedTitle && normalizedContext.includes(normalizedTitle)) score += 30;
  if (normalizedSeed && normalizedContext.includes(normalizedSeed)) score += 18;
  score += Math.min(24, termHits.length * 6);
  score += Math.min(24, evidenceHits.length * 4);
  if (sourceContext.length >= 1200) score += 10;
  if (sourceContext.includes("출처 필요") || sourceContext.includes("동음이의")) score -= 18;
  if (genericSourceTitles.has(title)) score -= 40;

  const configuredCase = Boolean(caseStudySources[mainTopic]?.[subtopic]
    ?.some((item) => normalizeEvidenceUrl(item.url) === normalizeEvidenceUrl(source.url)));
  const knownCaseSeed = discoverySeedsFor(mainTopic, subtopic)
    .some((seed) => normalizeText(seed) === normalizeText(source.seed || source.title));
  const passed = configuredCase
    ? sourceContext.length >= 500 && evidenceHits.length >= 2
    : knownCaseSeed
      ? sourceContext.length >= 500 && termHits.length >= 1
    : score >= 44 && termHits.length >= 1 && evidenceHits.length >= 2;
  return {
    passed,
    score,
    reason: passed
      ? `출처 본문에서 핵심어 ${termHits.length}개와 도메인 근거 ${evidenceHits.length}개 확인.`
      : `출처 근거 부족: 점수 ${score}, 본문 ${sourceContext.length}자, 핵심어 ${termHits.length}개, 도메인 근거 ${evidenceHits.length}개.`
  };
}

async function collectSources(mainTopic, subtopic, neededCount) {
  const seeds = discoverySeedsFor(mainTopic, subtopic);
  const hints = queryHints[mainTopic] || [];
  const targetSourceCount = Math.min(80, Math.max(neededCount * 8, 32));

  // Known domain terms are exact article candidates. Validate their live pages
  // directly instead of issuing several search requests per term and hitting
  // MediaWiki's rate limit before candidate prevalidation begins.
  const configuredSources = (caseStudySources[mainTopic]?.[subtopic] || []).map((source) => ({
    ...source,
    query: source.title,
    qualityScore: 40
  }));
  const directSources = seeds.map((seed) => ({
    title: cleanTitle(seed),
    seed,
    query: seed,
    qualityScore: scoreSourceQuality(mainTopic, subtopic, { title: seed, seed }),
    url: `https://ko.wikipedia.org/wiki/${encodeURIComponent(seed.replaceAll(" ", "_"))}`
  })).filter((source) => isUsefulSource(mainTopic, subtopic, source));

  const byTitle = new Map([...directSources, ...configuredSources].map((source) => [source.title, source]));
  const broadQuery = seeds.map((seed) => `"${seed}"`).join(" OR ");

  try {
    const searchResults = await fetchWikipediaSearch(broadQuery, 50);
    for (const result of searchResults) {
      const title = cleanTitle(result.title);
      const normalizedTitle = normalizeText(title);
      const matchingSeed = seeds.find((seed) => {
        const normalizedSeed = normalizeText(seed);
        return normalizedSeed && (normalizedTitle.includes(normalizedSeed) || normalizedSeed.includes(normalizedTitle));
      });
      if (!matchingSeed) continue;
      const source = {
        ...result,
        title,
        seed: matchingSeed,
        query: `${subtopic} ${hints.join(" ")}`
      };
      source.qualityScore = scoreSourceQuality(mainTopic, subtopic, source);
      if (isUsefulSource(mainTopic, subtopic, source) && !byTitle.has(title)) {
        byTitle.set(title, source);
      }
    }
  } catch {
    // Exact live document candidates remain usable if the search API throttles.
  }

  return [...byTitle.values()]
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, targetSourceCount);
}

function isTopicSourceAligned(mainTopic, subtopic, sourceTitle) {
  const normalizedTitle = normalizeText(sourceTitle);
  return discoverySeedsFor(mainTopic, subtopic).some((seed) => {
    const normalizedSeed = normalizeText(seed);
    return normalizedSeed && (normalizedTitle.includes(normalizedSeed) || normalizedSeed.includes(normalizedTitle));
  });
}

function scoreCandidate(mainTopic, title, index) {
  const visualHits = visualKeywords.filter((keyword) => title.includes(keyword)).length;
  const riskHits = riskKeywords.filter((keyword) => title.includes(keyword)).length;
  const lengthPenalty = title.length > 24 ? 1 : 0;

  const verification = Math.max(5, 8 - Math.min(index, 2));
  const visual = Math.min(9, 5 + visualHits + (mainTopic === "engineering" ? 2 : 1));
  const novelty = Math.min(9, 6 + (title.length <= 12 ? 1 : 0) + (visualHits ? 1 : 0));
  const lengthFit = Math.max(5, 8 - lengthPenalty - (riskHits ? 1 : 0));
  const distortionRisk = Math.min(9, 2 + riskHits * 2 + lengthPenalty);

  return { verification, visual, novelty, lengthFit, distortionRisk };
}

function buildHook(mainTopic, title, subtopic) {
  if (mainTopic === "engineering") {
    return `${subtopic} 안에서 힘, 흐름, 구조가 어디서 바뀌는지 보여주는 후보.`;
  }
  if (mainTopic === "science") {
    return `${subtopic}의 보이지 않는 조건과 결과를 시각적으로 설명할 수 있는 후보.`;
  }
  return `${subtopic} 안에서 사람, 권력, 정보, 물자의 흐름을 보여줄 수 있는 후보.`;
}

function buildQuestion(mainTopic, title, index) {
  if (mainTopic === "history") {
    if (title.includes("봉수")) {
      return `${withParticle(title, "은", "는")} 어떻게 위기 정보를 한양까지 움직였나?`;
    }
    if (title.includes("측우기")) {
      return `${withParticle(title, "은", "는")} 어떻게 비를 행정 정보로 바꿨나?`;
    }
    if (title.includes("도성") || title.includes("화성") || title.includes("성곽")) {
      return `${withParticle(title, "은", "는")} 왜 권력과 방어를 공간으로 보여주나?`;
    }
    if (title.includes("대동법") || title.includes("세곡")) {
      return `${withParticle(title, "은", "는")} 어떻게 세금과 물자의 흐름을 바꿨나?`;
    }
    if (title.includes("판옥선")) {
      return `${withParticle(title, "은", "는")} 어떻게 바다 위 전투 방식을 바꿨나?`;
    }
    if (title.includes("의궤")) {
      return `${withParticle(title, "은", "는")} 어떻게 왕실 행사를 기록과 제작 절차로 남겼나?`;
    }
    if (title.includes("장시")) {
      return `${withParticle(title, "은", "는")} 어떻게 조선의 시장과 물자 흐름을 키웠나?`;
    }
    if (title.includes("활자")) {
      return `${withParticle(title, "은", "는")} 어떻게 지식의 복제와 배포를 바꿨나?`;
    }
    if (title.includes("과거제")) {
      return `${withParticle(title, "은", "는")} 어떻게 인재 선발과 권력 흐름을 바꿨나?`;
    }
    if (title.includes("암행어사")) {
      return `${withParticle(title, "은", "는")} 어떻게 지방 권력을 감시했나?`;
    }
  }

  const templates = questionTemplates[mainTopic] || questionTemplates.history;
  return templates[index % templates.length]
    .replace("{subject}", withParticle(title, "은", "는"))
    .replace("{object}", withParticle(title, "을", "를"));
}

function isFocusedEpisodeCandidate(candidate, sourceByUrl) {
  const sourceUrl = String(candidate.sourceUrl || "").trim();
  const source = sourceByUrl.get(sourceUrl);
  const title = cleanTitle(candidate.title);
  const object = cleanTitle(candidate.object);
  const phenomenon = cleanTitle(candidate.phenomenon);
  const mechanism = cleanTitle(candidate.mechanism);
  const visualSequence = Array.isArray(candidate.visualSequence) ? candidate.visualSequence.filter(Boolean) : [];
  const broadPattern = /공학은|과학은|역사는|어떤 설계 개입|단면으로 보면|무엇이 보이나/iu;

  return Boolean(
    source
    && title.length >= 8
    && title.length <= 70
    && object.length >= 2
    && phenomenon.length >= 5
    && mechanism.length >= 3
    && visualSequence.length >= 3
    && !broadPattern.test(title)
  );
}

function normalizeReplacementDiscoveryRequest(payload = {}) {
  const requestedIds = [...new Set((Array.isArray(payload.replacementForTopicIds) ? payload.replacementForTopicIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
  const requestedSlots = Number(payload.replacementSlots);
  const replacementSlots = Number.isFinite(requestedSlots)
    ? clampInteger(requestedSlots, 0, 12, requestedIds.length)
    : requestedIds.length;
  return {
    originalTopicIds: requestedIds.slice(0, replacementSlots),
    replacementSlots,
    minimumQualifiedPerSlot: clampInteger(Number(payload.minimumQualifiedPerSlot), 1, 12, 4)
  };
}

function getReplacementOrigins(mainTopic, subtopic, replacement) {
  if (!replacement.originalTopicIds.length) return [];
  const placeholders = replacement.originalTopicIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT topics.id FROM topics
    WHERE topics.id IN (${placeholders})
      AND topics.main_topic = ? AND topics.subtopic = ?
      AND EXISTS (SELECT 1 FROM benchmark_cases WHERE benchmark_cases.topic_id = topics.id AND benchmark_cases.enabled = 1)
    ORDER BY topics.id
  `).all(...replacement.originalTopicIds, mainTopic, subtopic).map((row) => Number(row.id));
}

function replacementCandidateMetadata(replacement) {
  return replacement.originalTopicIds.length ? {
    sourceRoute: "benchmark_replacement_discovery",
    replacementSlots: replacement.replacementSlots,
    minimumQualifiedPerSlot: replacement.minimumQualifiedPerSlot,
    requestedOriginalTopicIds: replacement.originalTopicIds
  } : null;
}

async function buildCandidates(mainTopic, subtopic, sources, count, jobContext = null, replacement = null) {
  const poolTarget = Math.min(30, Math.max(count * 3, 12));
  const sourceLimit = Math.min(80, Math.max(poolTarget * 2, count * 3));
  const rejected = [];
  jobContext?.progress(8, "실제 시설과 장치의 공개 자료를 읽고 있습니다.");

  const documents = await Promise.all(sources.slice(0, sourceLimit).map(async (source) => {
    const title = cleanTitle(source.title);
    if (knownSourceStatement.get(source.url, title)) return null;
    const sourceContext = await fetchSourceContext(source.url);
    const precheck = prevalidateSource(mainTopic, subtopic, source, sourceContext);
    if (!precheck.passed) {
      rejected.push({ title, reason: precheck.reason, score: precheck.score });
      return null;
    }
    return {
      title,
      url: source.url,
      seed: source.seed,
      precheck,
      text: sourceContext.slice(0, 2600)
    };
  }));

  const sourcePackets = documents.filter(Boolean);
  if (!sourcePackets.length) return { candidates: [], rejected };
  jobContext?.progress(28, `읽을 수 있는 실제 사례 자료 ${sourcePackets.length}개를 확보했습니다.`);

  const prompt = `
당신은 한국어 시네마틱 지식 쇼츠의 주제 편집자입니다.
메인 분야는 "${domainLabels[mainTopic] || mainTopic}", 세부 분야는 "${subtopic}"입니다.

목표:
- 교과목이나 분야 전체가 아니라 한 영상에서 설명할 수 있는 구체적인 대상 하나를 고릅니다.
- 각 후보는 "구체적 대상 + 눈에 보이는 이상한 현상/반전 + 그것을 만든 단일 메커니즘"이어야 합니다.
- 제목만 보고 시청자가 무엇이 이상한지 즉시 이해할 수 있어야 합니다.
- 약 80~95초 영상에서 원인 하나를 시작 상태 → 작동 과정 → 결과 순서로 시각화할 수 있어야 합니다.

금지:
- "철근 콘크리트 공학은 어떤 설계 개입으로 실패를 막는가" 같은 전공 전체 질문
- 여러 실패 원인, 여러 시대, 여러 시스템을 한 후보에 합치기
- 자료에 없는 숫자, 비밀, 최초, 유일, 절대 같은 과장
- 일반 원리만 말하고 실제 대상이 없는 후보
- 아래 자료 URL과 일치하지 않는 sourceUrl

제목 문법:
- 구체적 대상의 예상 밖 상태를 먼저 보여주고 "이유" 또는 "방법"으로 핵심 질문을 만듭니다.
- 참고 형식만 따르고 기존 영상 제목은 복제하지 않습니다.
- 예: "[구체적 대상]에 [이상한 장치]를 넣은 이유", "[문제 조건]에서도 [대상]이 버티는 방법"

각 후보는 핵심 주장 하나만 가져야 합니다. 출처 본문에 단일 메커니즘의 직접 근거가 없으면 만들지 마세요.
가능한 후보를 최대 ${poolTarget}개 반환하되, 한 출처에서는 후보 하나만 만드세요.
${replacement?.originalTopicIds?.length ? `
이번 탐색은 기존 benchmark 대체 후보를 위한 것입니다.
- 사실 검증 단계에서 공개 HTTPS 직접 이미지 URL 또는 HTTPS PDF의 특정 페이지를 최소 3개 찾을 수 있는 실제 대상만 고르세요.
- 해당 참조는 시작·작동·결과의 서로 다른 외부 가시 상태 3개를 각각 보여야 합니다.
- 내부 구조, 컷어웨이, 수중, 유체, 기어처럼 외부 공개 참조로 확인할 수 없는 상태가 핵심인 대상은 만들지 마세요.
- sourceUrl은 사실 근거용 원문이며, 이미지/PDF URL은 추측하지 말고 검증 단계에서 원문에 실제로 연결된 것만 반환합니다.` : ""}

자료:
${sourcePackets.map((source, index) => `
[SOURCE ${index + 1}]
title: ${source.title}
url: ${source.url}
text:
${source.text}
`).join("\n")}
`;

  const discovered = await runCodexJson(
    prompt,
    `topic-discovery-${mainTopic}-${subtopic}`,
    240000,
    {
      signal: jobContext?.signal,
      onEvent(event) {
        if (event.type === "item.completed") {
          jobContext?.progress(42, "AI가 대상·반전·단일 원리로 후보를 좁히고 있습니다.");
        }
      }
    }
  );

  const sourceByUrl = new Map(sourcePackets.map((source) => [source.url, source]));
  const candidates = [];
  const usedUrls = new Set();
  for (const candidate of discovered.candidates || []) {
    if (candidates.length >= poolTarget) break;
    if (!isFocusedEpisodeCandidate(candidate, sourceByUrl)) {
      rejected.push({ title: cleanTitle(candidate.title), reason: "한 대상·한 현상·한 메커니즘 조건 미충족.", score: 0 });
      continue;
    }
    const source = sourceByUrl.get(String(candidate.sourceUrl).trim());
    if (usedUrls.has(source.url) || knownSourceStatement.get(source.url, source.title)) continue;
    const index = candidates.length;
    const title = cleanTitle(candidate.title);
    const hook = `${cleanTitle(candidate.phenomenon)} · 핵심 원리: ${cleanTitle(candidate.mechanism)}`;
    const scores = scoreCandidate(mainTopic, `${title} ${candidate.object} ${candidate.mechanism}`, index);
    const result = insertTopicStatement.run(
      mainTopic,
      subtopic,
      title,
      hook,
      "prechecked",
      Math.max(7, scores.verification),
      Math.max(7, scores.visual),
      scores.novelty,
      Math.max(7, scores.lengthFit),
      scores.distortionRisk,
      source.title,
      source.url,
      JSON.stringify({
        episode: {
          object: cleanTitle(candidate.object),
          phenomenon: cleanTitle(candidate.phenomenon),
          mechanism: cleanTitle(candidate.mechanism),
          visualSequence: candidate.visualSequence
        },
        replacement: replacementCandidateMetadata(replacement || { originalTopicIds: [] })
      })
    );

    candidates.push({
      dbId: Number(result.lastInsertRowid),
      id: `TOPIC-${String(index + 1).padStart(2, "0")}`,
      title,
      hook,
      status: "prechecked",
      lifecycleStatus: "candidate",
      scores,
      sourceTitle: source.title,
      sourceUrl: source.url,
      episode: {
        object: cleanTitle(candidate.object),
        phenomenon: cleanTitle(candidate.phenomenon),
        mechanism: cleanTitle(candidate.mechanism),
        coreClaim: cleanTitle(candidate.coreClaim),
        visualSequence: candidate.visualSequence
      },
      precheck: source.precheck
    });
    usedUrls.add(source.url);
  }

  jobContext?.progress(55, `단일 메커니즘 후보 ${candidates.length}개를 구성했습니다.`);
  return { candidates, rejected };
}

function associateReplacementCandidates(candidates, originIds, replacement, discoveryJobId = null) {
  if (!originIds.length || !candidates.length) return [];
  const existingCounts = new Map(db.prepare(`
    SELECT original_topic_id AS originalTopicId, COUNT(*) AS count
    FROM benchmark_replacement_candidates
    WHERE original_topic_id IN (${originIds.map(() => "?").join(", ")})
      AND status IN ('discovered', 'qualified')
    GROUP BY original_topic_id
  `).all(...originIds).map((row) => [Number(row.originalTopicId), Number(row.count)]));
  const links = [];
  for (const candidate of candidates) {
    const originalTopicId = [...originIds]
      .sort((left, right) => (existingCounts.get(left) || 0) - (existingCounts.get(right) || 0) || left - right)
      .find((id) => (existingCounts.get(id) || 0) < replacement.minimumQualifiedPerSlot);
    if (!originalTopicId) break;
    const existing = db.prepare(`
      SELECT id FROM benchmark_replacement_candidates WHERE candidate_topic_id = ?
    `).get(candidate.dbId);
    if (existing) continue;
    const details = {
      replacementSlots: replacement.replacementSlots,
      minimumQualifiedPerSlot: replacement.minimumQualifiedPerSlot,
      candidateTitle: candidate.title
    };
    const result = db.prepare(`
      INSERT INTO benchmark_replacement_candidates (
        original_topic_id, candidate_topic_id, discovery_job_id, source_route, status, details_json
      ) VALUES (?, ?, ?, 'topic_discovery', 'discovered', ?)
    `).run(originalTopicId, candidate.dbId, discoveryJobId || null, JSON.stringify(details));
    const id = Number(result.lastInsertRowid);
    const current = parseStoredJson(db.prepare("SELECT candidate_json FROM topics WHERE id = ?").get(candidate.dbId)?.candidate_json, {});
    db.prepare("UPDATE topics SET candidate_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(JSON.stringify({
      ...current,
      replacement: { ...replacementCandidateMetadata(replacement), originalTopicId, linkId: id, status: "discovered" }
    }), candidate.dbId);
    existingCounts.set(originalTopicId, (existingCounts.get(originalTopicId) || 0) + 1);
    links.push({ id, originalTopicId, candidateTopicId: candidate.dbId, status: "discovered" });
  }
  return links;
}

function cleanupNoisyTopics() {
  db.exec(`
    UPDATE topics
    SET review_status = 'unverified',
        updated_at = CURRENT_TIMESTAMP
    WHERE review_status IN ('pass', 'hold')
      AND lifecycle_status = 'candidate'
  `);

  db.exec(`
    UPDATE topics
    SET title = REPLACE(title, '왜 60초 안에 설명하기 좋은 전환점인가?', '어떤 문제를 해결하려고 만들어졌나?'),
        updated_at = CURRENT_TIMESTAMP
    WHERE title LIKE '%왜 60초 안에 설명하기 좋은 전환점인가?%'
  `);

  const dropBySourceTitle = db.prepare(`
    UPDATE topics
    SET lifecycle_status = 'dropped',
        updated_at = CURRENT_TIMESTAMP
    WHERE source_title = ?
      AND lifecycle_status != 'dropped'
  `);
  for (const title of genericSourceTitles) {
    dropBySourceTitle.run(title);
  }
}

cleanupNoisyTopics();

async function runTopicDiscovery(payload, jobContext = null) {
  const mainTopic = String(payload.mainTopic || "").trim();
  const subtopic = String(payload.subtopic || "").trim();
  const count = Math.max(1, Math.min(Number(payload.count || 10), 30));

  if (!mainTopic || !subtopic) {
    throw new Error("메인 주제와 세부 주제가 필요합니다.");
  }

  jobContext?.progress(3, "세부 분야에서 설명 가능한 실제 대상 자료를 찾고 있습니다.");
  const sources = await collectSources(mainTopic, subtopic, count * 3);
  if (!sources.length) {
    throw new Error("공개 자료 검색 결과가 없습니다. 세부 주제를 바꾸거나 인터넷 연결을 확인하세요.");
  }

  const replacement = normalizeReplacementDiscoveryRequest(payload);
  const replacementOriginIds = getReplacementOrigins(mainTopic, subtopic, replacement);
  const { candidates, rejected } = await buildCandidates(mainTopic, subtopic, sources, count, jobContext, replacement);
  const replacementLinks = associateReplacementCandidates(candidates, replacementOriginIds, replacement, jobContext?.jobId);
  const replacementLinkByCandidate = new Map(replacementLinks.map((link) => [link.candidateTopicId, link]));
  insertSearchStatement.run(mainTopic, subtopic, count, candidates.length);

  const pendingTopics = db.prepare(`
    SELECT id, source_title AS sourceTitle FROM topics
    WHERE main_topic = ? AND subtopic = ?
      AND topic_format = 'focused_v2'
      AND lifecycle_status = 'candidate'
      AND review_status IN ('prechecked', 'unverified')
      AND NOT EXISTS (SELECT 1 FROM fact_checks WHERE fact_checks.topic_id = topics.id)
      AND NOT EXISTS (
        SELECT 1 FROM jobs
        WHERE jobs.topic_id = topics.id AND jobs.type = 'fact_check' AND jobs.status IN ('queued', 'running')
      )
    ORDER BY updated_at DESC, id DESC
    LIMIT 100
  `).all(mainTopic, subtopic)
    .filter((topic) => isTopicSourceAligned(mainTopic, subtopic, topic.sourceTitle))
    .slice(0, Math.max(0, count - Number(db.prepare(`
      SELECT COUNT(*) AS count FROM fact_checks
      JOIN topics ON topics.id = fact_checks.topic_id
      WHERE topics.main_topic = ? AND topics.subtopic = ?
        AND topics.lifecycle_status != 'dropped' AND fact_checks.status = 'PASS'
    `).get(mainTopic, subtopic)?.count || 0)));
  const verificationJobs = pendingTopics.map((topic) => {
    const replacementLink = replacementLinkByCandidate.get(Number(topic.id));
    const queued = enqueueAiJob("fact_check", Number(topic.id), {
      force: false,
      source: "topic_discovery",
      targetCount: count,
      mainTopic,
      subtopic,
      discoveryRound: Number(payload.discoveryRound || 1),
      ...(replacementLink ? {
        replacementCandidateLinkId: replacementLink.id,
        replacementOriginTopicIds: [replacementLink.originalTopicId],
        replacementForTopicIds: replacementOriginIds,
        replacementSlots: replacement.replacementSlots,
        minimumQualifiedPerSlot: replacement.minimumQualifiedPerSlot
      } : {})
    });
    if (replacementLink) {
      db.prepare("UPDATE benchmark_replacement_candidates SET fact_check_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(queued.job.id, replacementLink.id);
    }
    return queued.job;
  });

  const output = {
    generatedAt: new Date().toISOString(),
    mainTopic,
    subtopic,
    candidates,
    replacement: {
      ...replacement,
      originalTopicIds: replacementOriginIds,
      associationIds: replacementLinks.map((link) => link.id),
      associationCount: replacementLinks.length
    },
    rejectedCount: rejected.length,
    rejected: rejected.slice(0, 20),
    verificationQueued: verificationJobs.length,
    verificationJobIds: verificationJobs.map((job) => job.id),
    message: verificationJobs.length
      ? `단일 메커니즘 후보 ${verificationJobs.length}개의 정밀 사실 검증을 자동으로 시작했습니다.`
      : "이미 요청한 수만큼 검증된 후보가 있거나 새 후보를 구성하지 못했습니다."
  };

  jobContext?.progress(75, `정밀 사실 검증 ${verificationJobs.length}개를 자동으로 예약했습니다.`);
  return output;
}

function findTopics(payload) {
  const mainTopic = String(payload.mainTopic || "").trim();
  const subtopic = String(payload.subtopic || "").trim();
  const count = Math.max(1, Math.min(Number(payload.count || 10), 30));
  if (!mainTopic || !subtopic) {
    throw new Error("메인 주제와 세부 주제가 필요합니다.");
  }
  const replacement = normalizeReplacementDiscoveryRequest(payload);
  const queued = enqueueAiJob("topic_discovery", null, {
    mainTopic,
    subtopic,
    count,
    discoveryRound: 1,
    replacementForTopicIds: replacement.originalTopicIds,
    replacementSlots: replacement.replacementSlots,
    minimumQualifiedPerSlot: replacement.minimumQualifiedPerSlot
  });
  return {
    generatedAt: new Date().toISOString(),
    mainTopic,
    subtopic,
    replacement: { ...replacement, associationIds: [], associationCount: 0 },
    discoveryQueued: true,
    job: queued.job,
    reused: queued.reused,
    message: queued.reused
      ? "같은 범위의 주제 탐색이 이미 진행 중입니다."
      : "실제 대상 기반 주제 탐색과 자동 검증을 시작했습니다."
  };
}

function normalizeFactStatus(status) {
  const value = String(status || "").trim().toUpperCase();
  if (["PASS", "HOLD", "REJECT"].includes(value)) return value;
  return "HOLD";
}

function normalizeFactCheckResult(result) {
  let status = normalizeFactStatus(result.status);
  const rawConfidence = Number(result.confidence);
  const confidence = rawConfidence > 0 && rawConfidence <= 1
    ? Math.round(rawConfidence * 100)
    : clampInteger(rawConfidence, 0, 100, status === "PASS" ? 70 : 45);
  const verifiedFacts = Array.isArray(result.verifiedFacts) ? result.verifiedFacts : [];
  const sources = Array.isArray(result.sources) ? result.sources : [];
  const claims = Array.isArray(result.claims) ? result.claims : [];
  const visualEvidence = Array.isArray(result.visualEvidence) ? result.visualEvidence : [];
  const videoClaims = claims.filter((claim) => claim.useInVideo !== false);
  if (status === "PASS" && (
    confidence < 75
    || verifiedFacts.length < 2
    || sources.length < 1
    || videoClaims.length < 2
    || videoClaims.some((claim) => claim.status !== "SUPPORTED" || !claim.evidence?.length)
  )) {
    status = "HOLD";
  }
  return {
    status,
    confidence,
    revisedTitle: cleanTitle(result.revisedTitle || ""),
    revisedHook: cleanTitle(result.revisedHook || ""),
    coreClaim: String(result.coreClaim || "").trim() || "핵심 주장을 확정하지 못했습니다.",
    claims,
    verifiedFacts,
    visualEvidence,
    unresolved: Array.isArray(result.unresolved) ? result.unresolved : [],
    simplifications: Array.isArray(result.simplifications) ? result.simplifications : [],
    sources,
    verdictReason: String(result.verdictReason || "").trim() || "판정 이유가 충분히 생성되지 않았습니다.",
    nextAction: String(result.nextAction || "").trim() || (status === "PASS" ? "대본 생성 가능." : "추가 검증 필요.")
  };
}

function normalizeEvidenceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return "";
  }
}

function enforceEvidenceScope(factCheck, topic, enrichment, attempt) {
  const canaryVisualUrls = topic.runLane === "production_canary"
    ? getCanaryAssets(topic.id)
      .filter((asset) => asset.verified)
      .flatMap((asset) => [asset.sourceUrl, asset.mediaUrl, asset.finalUrl])
    : [];
  const allowedUrls = new Set([
    topic.sourceUrl,
    ...(enrichment?.sources || []).map((source) => source.url),
    ...canaryVisualUrls
  ].map(normalizeEvidenceUrl).filter(Boolean));
  const validSources = factCheck.sources.filter((source) => allowedUrls.has(normalizeEvidenceUrl(source.url)));
  const requiredSourceCount = attempt >= 2 ? 2 : 1;
  factCheck.sources = validSources;
  const supportedClaimIds = new Set((factCheck.claims || [])
    .filter((claim) => claim.status === "SUPPORTED" && claim.useInVideo !== false)
    .map((claim) => String(claim.id)));
  factCheck.visualEvidence = (factCheck.visualEvidence || []).filter((item) => (
    item.claimRefs?.length
    && item.claimRefs.every((claimRef) => supportedClaimIds.has(String(claimRef)))
    && item.evidence?.some((entry) => [...allowedUrls].some((url) => String(entry).includes(url)))
  ));
  const evidencePreflight = validateEvidencePacket(factCheck);
  factCheck.visualEvidence = evidencePreflight.usableEvidence;
  if (factCheck.status === "PASS" && evidencePreflight.issues.length) {
    factCheck.status = "HOLD";
    factCheck.unresolved = [...factCheck.unresolved, ...evidencePreflight.issues.map((issue) => ({
      item: "영상 제작용 실제 참조",
      issue: issue.message,
      needed: "공식 사진·시공 사진·도면·단면 또는 유효한 PDF 페이지"
    }))];
    factCheck.nextAction = "실제 제작 가능한 공식 시각 참조가 확보될 때까지 needs_reference로 보류합니다.";
  }
  if (factCheck.status === "PASS" && validSources.length < requiredSourceCount) {
    factCheck.status = "HOLD";
    factCheck.unresolved = [
      ...factCheck.unresolved,
      {
        item: "검증에 실제 사용된 출처",
        issue: `제공된 출처와 일치하는 인용이 ${validSources.length}개뿐입니다.`,
        needed: `실제로 제공된 서로 다른 출처 ${requiredSourceCount}개 이상의 교차 확인`
      }
    ];
    factCheck.nextAction = "제공된 근거 URL만 사용해 다시 검증해야 합니다.";
  }
  if (factCheck.status === "PASS" && factCheck.visualEvidence.length < 2) {
    factCheck.status = "HOLD";
    factCheck.unresolved = [
      ...factCheck.unresolved,
      {
        item: "영상 제작용 시각 근거",
        issue: `제공된 출처에 직접 연결된 시각 상태가 ${factCheck.visualEvidence.length}개뿐입니다.`,
        needed: "서로 다른 시작·작동·결과 상태와 지지·접촉·운동 경로를 확인할 공식 설명 또는 도면"
      }
    ];
    factCheck.nextAction = "실제 형상과 운동을 확인할 시각 근거를 보강한 뒤 다시 검증해야 합니다.";
  }
  return factCheck;
}

const REPLACEMENT_DIRECT_REFERENCE_TYPES = new Set(["official_photo", "construction_photo", "official_diagram", "official_section"]);
const REPLACEMENT_HIDDEN_VISUAL_TERMS = /\b(?:internal|cutaway|submerged|fluid|gear)\b|내부|컷어웨이|수중|유체|기어|매립|단면/iu;

function isHttpsUrl(value) {
  try {
    return new URL(String(value || "")).protocol === "https:";
  } catch {
    return false;
  }
}

function isDirectReplacementVisualReference(evidence = {}) {
  const sourceUrl = String(evidence.referenceSourceUrl || "").trim();
  const mediaUrl = String(evidence.referenceMediaUrl || "").trim();
  const page = Number(evidence.referencePage || 0);
  const directImage = isHttpsUrl(mediaUrl) && /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/iu.test(mediaUrl);
  const pdfPage = isHttpsUrl(sourceUrl) && /\.pdf(?:$|[?#])/iu.test(sourceUrl) && Number.isInteger(page) && page > 0;
  return REPLACEMENT_DIRECT_REFERENCE_TYPES.has(String(evidence.referenceType || ""))
    && isHttpsUrl(sourceUrl)
    && (directImage || pdfPage);
}

function qualifyReplacementCandidateVisuals(topic, factCheck) {
  const candidate = parseStoredJson(topic.candidateJson, {});
  const candidateText = JSON.stringify({ title: topic.title, hook: topic.hook, candidate });
  const evidence = Array.isArray(factCheck.visualEvidence) ? factCheck.visualEvidence : [];
  const hiddenRequirement = REPLACEMENT_HIDDEN_VISUAL_TERMS.test(candidateText)
    || evidence.some((item) => REPLACEMENT_HIDDEN_VISUAL_TERMS.test(JSON.stringify(item)));
  const directEvidence = evidence.filter((item) => isDirectReplacementVisualReference(item));
  const directReferences = new Set(directEvidence.map((item) => `${item.referenceSourceUrl}|${item.referenceMediaUrl}|${Number(item.referencePage || 0)}`));
  const visibleStates = new Set(directEvidence
    .map((item) => String(item.state || "").toLowerCase().replace(/[^0-9a-z가-힣]/gu, ""))
    .filter(Boolean));
  if (factCheck.status !== "PASS") {
    return { qualified: false, reason: `fact_check_${String(factCheck.status || "HOLD").toLowerCase()}`, directReferenceCount: directReferences.size, distinctVisibleStateCount: visibleStates.size, directEvidence };
  }
  if (hiddenRequirement) {
    return { qualified: false, reason: "hidden_or_non_external_visual_requirement", directReferenceCount: directReferences.size, distinctVisibleStateCount: visibleStates.size, directEvidence };
  }
  if (directReferences.size < 3 || visibleStates.size < 3) {
    return { qualified: false, reason: "no_direct_official_visual_states", directReferenceCount: directReferences.size, distinctVisibleStateCount: visibleStates.size, directEvidence };
  }
  return { qualified: true, reason: "", directReferenceCount: directReferences.size, distinctVisibleStateCount: visibleStates.size, directEvidence };
}

function replacementEvidenceKey(evidence = {}) {
  return `${evidence.referenceSourceUrl}|${evidence.referenceMediaUrl}|${Number(evidence.referencePage || 0)}`;
}

async function preflightReplacementVisualReference(evidence) {
  const targetUrl = String(evidence.referenceMediaUrl || evidence.referenceSourceUrl || "").trim();
  const maxBytes = 10 * 1024 * 1024;
  try {
    const response = await fetch(targetUrl, {
      signal: AbortSignal.timeout(30000),
      headers: { "User-Agent": "cinematic-shorts-dashboard/0.1 replacement visual preflight" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!isHttpsUrl(response.url || targetUrl)) throw new Error("redirect final URL이 HTTPS가 아닙니다.");
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > maxBytes) throw new Error("media가 10MB preflight 제한을 넘습니다.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error("media가 10MB preflight 제한을 넘습니다.");
    const media = detectOfficialMedia(buffer, response.headers.get("content-type"));
    if (!media || !["image", "pdf"].includes(media.kind)) throw new Error("image/PDF signature 또는 content type 검증에 실패했습니다.");
    if (media.kind === "pdf" && !Number(evidence.referencePage || 0)) throw new Error("PDF referencePage가 필요합니다.");
    if (media.kind === "image" && Number(evidence.referencePage || 0)) throw new Error("이미지에는 PDF page를 지정할 수 없습니다.");
    const hash = createHash("sha256").update(buffer).digest("hex");
    const cacheDir = path.join(SOURCE_CACHE_DIR, "replacement-preflight", hash.slice(0, 16));
    await mkdir(cacheDir, { recursive: true });
    const sourcePath = path.join(cacheDir, `reference.${media.extension}`);
    await writeFile(sourcePath, buffer);
    let cachedPath = sourcePath;
    if (media.kind === "image") {
      const decodedPath = `${sourcePath}.decoded.png`;
      await runProcess(PDF_PYTHON_BIN, [REFERENCE_IMAGE_RUNNER, sourcePath, decodedPath], { timeoutMs: 120000, env: { PYTHONIOENCODING: "utf-8" } });
      if (!existsSync(decodedPath) || (await stat(decodedPath)).size < 100) throw new Error("image decode 검증에 실패했습니다.");
      cachedPath = decodedPath;
    } else {
      const outputPrefix = `${sourcePath}-page-${Number(evidence.referencePage)}`;
      await runProcess(PDFTOPPM_BIN, ["-f", String(evidence.referencePage), "-l", String(evidence.referencePage), "-singlefile", "-png", "-r", "130", sourcePath, outputPrefix], { timeoutMs: 120000 });
      const renderedPath = `${outputPrefix}.png`;
      if (!existsSync(renderedPath) || (await stat(renderedPath)).size < 100) throw new Error("PDF page render 검증에 실패했습니다.");
      cachedPath = renderedPath;
    }
    return { verified: true, finalUrl: response.url || targetUrl, contentType: media.contentType, byteSize: buffer.length, sha256: hash, cachedPath: toRelativeWorkspacePath(cachedPath), verification: { mediaKind: media.kind, referencePage: Number(evidence.referencePage || 0), verifiedAt: new Date().toISOString() } };
  } catch (error) {
    return { verified: false, error: String(error?.message || error) };
  }
}

async function updateReplacementCandidateFromFactCheck(payload, topic, factCheck) {
  const linkId = Number(payload.replacementCandidateLinkId || 0);
  if (!linkId) return null;
  const link = db.prepare(`
    SELECT id, candidate_topic_id AS candidateTopicId FROM benchmark_replacement_candidates WHERE id = ?
  `).get(linkId);
  if (!link || Number(link.candidateTopicId) !== Number(topic.id)) return null;
  const initialQualification = qualifyReplacementCandidateVisuals(topic, factCheck);
  const seededEvidence = payload.replacementSeed?.references
    ? normalizeSeedReplacementReferences(payload.replacementSeed.references.map((reference) => ({
      ...reference,
      sourceUrl: reference?.sourceUrl || reference?.referenceSourceUrl || payload.replacementSeed.landingUrl
    })))
    : [];
  const preflightEvidence = [...new Map([...initialQualification.directEvidence, ...seededEvidence]
    .map((evidence) => [replacementEvidenceKey(evidence), evidence])).values()];
  const preflightResults = await Promise.all(preflightEvidence.map(async (evidence) => ({
    evidence,
    result: await preflightReplacementVisualReference(evidence)
  })));
  const landingDocument = payload.replacementSeed?.landingUrl
    ? await fetchSourceDocument(payload.replacementSeed.landingUrl, 30000)
    : null;
  const landingPreflight = landingDocument ? {
    url: payload.replacementSeed.landingUrl,
    readable: isReadableSourceDocument(landingDocument),
    error: isReadableSourceDocument(landingDocument) ? "" : String(landingDocument.text || "landing page를 읽지 못했습니다.")
  } : null;
  const preflightByKey = new Map(preflightResults.map(({ evidence, result }) => [replacementEvidenceKey(evidence), result]));
  const verifiedEvidence = initialQualification.directEvidence.filter((evidence) => preflightByKey.get(replacementEvidenceKey(evidence))?.verified);
  const qualification = qualifyReplacementCandidateVisuals(topic, {
    ...factCheck,
    visualEvidence: (factCheck.visualEvidence || []).filter((evidence) => !isDirectReplacementVisualReference(evidence)).concat(verifiedEvidence)
  });
  if (!qualification.qualified && initialQualification.qualified && qualification.reason === "no_direct_official_visual_states") {
    qualification.reason = "direct_media_preflight_failed";
  }
  const status = qualification.qualified ? "qualified" : "preflight_failed";
  const details = {
    visualEvidenceIds: qualification.directEvidence.map((item) => String(item.id || item.state || "")).filter(Boolean),
    factCheckId: Number(getFactCheckByTopicStatement.get(topic.id)?.id || 0) || null,
    factStatus: factCheck.status,
    landingPreflight,
    directMediaPreflight: preflightResults.map(({ evidence, result }) => ({ id: String(evidence.id || evidence.state || ""), sourceUrl: evidence.referenceSourceUrl, mediaUrl: evidence.referenceMediaUrl, referencePage: Number(evidence.referencePage || 0), ...result }))
  };
  db.prepare(`
    UPDATE benchmark_replacement_candidates
    SET status = ?, direct_reference_count = ?, distinct_visible_state_count = ?, rejection_reason = ?,
        details_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, qualification.directReferenceCount, qualification.distinctVisibleStateCount, qualification.reason, JSON.stringify(details), linkId);
  const current = parseStoredJson(db.prepare("SELECT candidate_json FROM topics WHERE id = ?").get(topic.id)?.candidate_json, {});
  db.prepare("UPDATE topics SET candidate_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(JSON.stringify({
    ...current,
    replacement: { ...(current.replacement || {}), linkId, status, rejectionReason: qualification.reason }
  }), topic.id);
  if (qualification.qualified) {
    const insertAsset = db.prepare(`
      INSERT INTO official_visual_assets (
        topic_id, reference_id, state_hint, reference_type, source_url, media_url, final_url, content_type, byte_size, sha256, cached_path, status, verification_json
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate_verified', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM official_visual_assets
        WHERE topic_id = ? AND reference_id = ? AND source_url = ? AND media_url = ?
      )
    `);
    for (const evidence of qualification.directEvidence) {
      const preflight = preflightByKey.get(replacementEvidenceKey(evidence));
      insertAsset.run(topic.id, String(evidence.id || evidence.state), String(evidence.state || ""), evidence.referenceType, evidence.referenceSourceUrl, evidence.referenceMediaUrl || "", preflight.finalUrl, preflight.contentType, preflight.byteSize, preflight.sha256, preflight.cachedPath, JSON.stringify({ ...preflight.verification, referenceDescription: evidence.referenceDescription || "", replacementCandidateLinkId: linkId }), topic.id, String(evidence.id || evidence.state), evidence.referenceSourceUrl, evidence.referenceMediaUrl || "");
    }
  }
  return { id: linkId, status, ...qualification, preflightResults };
}

async function persistSeedReplacementPreflight(payload, topic) {
  const linkId = Number(payload.replacementCandidateLinkId || 0);
  if (!linkId || !payload.replacementSeed?.landingUrl) return null;
  const link = db.prepare("SELECT candidate_topic_id AS candidateTopicId FROM benchmark_replacement_candidates WHERE id = ?").get(linkId);
  if (!link || Number(link.candidateTopicId) !== Number(topic.id)) return null;
  const evidence = normalizeSeedReplacementReferences((payload.replacementSeed.references || []).map((reference) => ({
    ...reference,
    sourceUrl: reference?.sourceUrl || reference?.referenceSourceUrl || payload.replacementSeed.landingUrl
  })));
  const preflightResults = await Promise.all(evidence.map(async (item) => ({
    evidence: item,
    result: await preflightReplacementVisualReference(item)
  })));
  const landingDocument = await fetchSourceDocument(payload.replacementSeed.landingUrl, 30000);
  const landingPreflight = {
    url: payload.replacementSeed.landingUrl,
    readable: isReadableSourceDocument(landingDocument),
    error: isReadableSourceDocument(landingDocument) ? "" : String(landingDocument.text || "landing page를 읽지 못했습니다.")
  };
  const verified = preflightResults.filter((entry) => entry.result.verified);
  const stateCount = new Set(verified.map((entry) => String(entry.evidence.state || "").toLowerCase()).filter(Boolean)).size;
  const reason = !landingPreflight.readable
    ? "landing_page_preflight_failed"
    : verified.length < 3 || stateCount < 3
      ? "seed_direct_media_preflight_failed"
      : "";
  db.prepare(`
    UPDATE benchmark_replacement_candidates
    SET status = CASE WHEN ? = '' THEN 'discovered' ELSE 'preflight_failed' END,
        direct_reference_count = ?, distinct_visible_state_count = ?, rejection_reason = ?, details_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason, verified.length, stateCount, reason, JSON.stringify({
    untrustedSeed: true,
    landingPreflight,
    directMediaPreflight: preflightResults.map(({ evidence: item, result }) => ({ id: item.id, state: item.state, sourceUrl: item.referenceSourceUrl, mediaUrl: item.referenceMediaUrl, referencePage: item.referencePage, ...result }))
  }), linkId);
  return { linkId, landingPreflight, directReferenceCount: verified.length, distinctVisibleStateCount: stateCount, reason, preflightResults };
}

function recordTopicAttempt(topicId, stage, outcome, reason, details = {}) {
  db.prepare(`
    INSERT INTO topic_attempts (topic_id, stage, outcome, reason, details_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(topicId || null, stage, outcome, String(reason || "").slice(0, 2000), JSON.stringify(details));
  const normalizedOutcome = String(outcome || "").toLowerCase();
  const status = ["pass", "ready", "completed"].includes(normalizedOutcome) ? "pass"
    : ["retry", "failed", "reject", "rejected", "hold"].includes(normalizedOutcome) ? "fail"
      : "info";
  const review = details.review || (Array.isArray(details.reviews) ? details.reviews.at(-1) : null);
  const issues = Array.isArray(details.issues) ? details.issues : Array.isArray(review?.issues) ? review.issues : [];
  const score = Number(details.score ?? review?.score ?? (status === "pass" ? 1 : 0));
  const benchmark = topicId ? mapBenchmarkCaseRow(getBenchmarkCaseByTopicStatement.get(topicId)) : null;
  const runResult = insertQualityRunStatement.run(
    benchmark?.id || null,
    topicId || null,
    stage,
    status,
    Number.isFinite(score) ? score : 0,
    JSON.stringify({ outcome, details }),
    String(details.artifactRef || "")
  );
  const runId = Number(runResult.lastInsertRowid);
  const normalizedIssues = issues.length ? issues : status === "fail" && reason ? [{
    code: "stage_failed",
    severity: "error",
    message: reason,
    repairInstruction: "실패 원인을 분류한 뒤 해당 단계만 수정하고 한 번 재실행합니다."
  }] : [];
  for (const issue of normalizedIssues) {
    insertQualityFindingStatement.run(
      runId,
      topicId || null,
      stage,
      String(issue.code || "unclassified"),
      String(issue.severity || (status === "fail" ? "error" : "warning")),
      String(issue.message || reason || "").slice(0, 2000),
      String(issue.repairInstruction || "").slice(0, 2000),
      review ? "ai_reviewer" : "deterministic"
    );
  }
  return runId;
}

const QUALITY_REVIEWER_ROLES = Object.freeze({
  lead: {
    label: "통합 품질 검수",
    directive: "Judge factual scope, causal and physical validity, visible evidence, continuity, immediate comprehension, visual distinction, and final production usability together. A high-confidence pass requires all of them; report concrete issues instead of vague taste."
  },
  evidence: {
    label: "근거·물리 검수",
    directive: "Prioritize factual scope, causal validity, physical geometry, required evidence, and unsupported inference. Do not fail merely for taste or style."
  },
  production: {
    label: "시청각 제작 검수",
    directive: "Prioritize immediate comprehension, visual distinction, continuity, readability, and whether the artifact works in the final short. Do not relax factual or physical constraints."
  },
  adjudicator: {
    label: "불일치 판정",
    directive: "Inspect the artifact independently, then resolve the two prior verdicts issue by issue. Accept only findings supported by the supplied evidence or visible artifact; do not decide by majority vote."
  }
});

function buildQualityReviewerContext(stage, reviewer = {}) {
  const role = QUALITY_REVIEWER_ROLES[reviewer.role] ? reviewer.role : "evidence";
  const config = QUALITY_REVIEWER_ROLES[role];
  const priorReviews = Array.isArray(reviewer.priorReviews) ? reviewer.priorReviews : [];
  return `
Review stage: ${stage}
Reviewer role: ${config.label}
Role-specific focus: ${config.directive}
${role === "adjudicator" ? `Prior independent reviews:\n${JSON.stringify(priorReviews, null, 2)}` : "Do not assume another reviewer will catch a problem outside your focus."}
`.trim();
}

function summarizeQualityConsensus(primaryReviews, adjudicator = null, deterministicIssues = []) {
  const primary = (primaryReviews || []).filter(Boolean).slice(0, 2);
  if (!primary.length) throw new Error("품질 검수 결과가 필요합니다.");
  const disagreed = primary.length === 2 && Boolean(primary[0].passed) !== Boolean(primary[1].passed);
  if (disagreed && !adjudicator) throw new Error("검수 결과가 엇갈려 판정 검수가 필요합니다.");
  const decisive = disagreed ? adjudicator : null;
  const passedByAi = disagreed ? Boolean(decisive.passed) : primary.every((review) => Boolean(review.passed));
  const selectedReviews = decisive ? [decisive] : primary;
  const issues = selectedReviews.flatMap((review) => Array.isArray(review.issues) ? review.issues : []);
  const scores = selectedReviews.map((review) => Number(review.score || 0)).filter(Number.isFinite);
  const score = scores.length ? Math.min(...scores) : 0;
  const summary = decisive
    ? String(decisive.summary || decisive.observedState || decisive.repairInstruction || "불일치 판정을 완료했습니다.")
    : primary.map((review) => String(review.summary || review.observedState || review.repairInstruction || "")).filter(Boolean).join(" / ");
  const repairInstruction = selectedReviews
    .map((review) => String(review.repairInstruction || "").trim())
    .filter(Boolean)
    .join(" / ");
  const observedState = selectedReviews
    .map((review) => String(review.observedState || "").trim())
    .filter(Boolean)
    .join(" / ");
  const requestedActions = selectedReviews.map((review) => review.action).filter(Boolean);
  const action = passedByAi ? "pass" : requestedActions.includes("drop") ? "drop" : "revise";
  return {
    passed: Boolean(passedByAi && !deterministicIssues.length),
    score,
    summary,
    repairInstruction,
    observedState,
    action,
    issues,
    deterministicIssues,
    agreement: disagreed
      ? "adjudicated"
      : primary.length === 1
        ? (passedByAi ? "decisive_single_pass" : "decisive_single_fail")
        : (passedByAi ? "unanimous_pass" : "unanimous_fail"),
    primaryReviews: primary,
    adjudicator: decisive
  };
}

function buildQualityContractHash(value) {
  return createHash("sha256").update(JSON.stringify(value || {})).digest("hex");
}

async function runQualityConsensus({ stage, topicId, contractHash = "", jobContext, deterministicIssues = [], requiredReviewerRoles = [], runReviewer }) {
  const reviewerRoles = requiredReviewerRoles.length ? requiredReviewerRoles : ["evidence", "production"];
  const primaryReviews = reviewerRoles.length > 1
    ? await Promise.all(reviewerRoles.slice(0, 2).map((role, index) => runReviewer({ role, ordinal: index + 1, priorReviews: [] })))
    : [await runReviewer({ role: reviewerRoles[0], ordinal: 1, priorReviews: [] })];
  const first = primaryReviews[0];
  const firstIssues = Array.isArray(first?.issues) ? first.issues : [];
  const firstScore = Number(first?.score || 0);
  const ambiguous = Boolean(
    (!first?.passed && !firstIssues.length)
    || (first?.passed && firstScore < 0.9)
    || (!first?.passed && firstScore >= 0.78)
  );
  if (primaryReviews.length === 1 && ambiguous) {
    const role = reviewerRoles[1] || "production";
    jobContext?.progress(88, reviewerRoles.length > 1
      ? `${stage} 최종 후보라 근거·제작 독립 검수를 모두 실행합니다.`
      : `${stage} 판정이 경계 구간이라 두 번째 독립 검수만 추가합니다.`);
    primaryReviews.push(await runReviewer({
      role,
      ordinal: 2,
      priorReviews: []
    }));
  }
  const disagreed = primaryReviews.length === 2
    && Boolean(primaryReviews[0]?.passed) !== Boolean(primaryReviews[1]?.passed);
  let adjudicator = null;
  if (disagreed) {
    jobContext?.progress(88, `${stage} 독립 검수 결과가 엇갈려 근거 기반 판정 검수를 실행합니다.`);
    adjudicator = await runReviewer({
      role: "adjudicator",
      ordinal: 3,
      priorReviews: primaryReviews
    });
  }
  const consensus = summarizeQualityConsensus(primaryReviews, adjudicator, deterministicIssues);
  const runId = recordTopicAttempt(topicId, stage, consensus.passed ? "pass" : "retry", consensus.summary, {
    engineVersion: QUALITY_ENGINE_VERSION,
    contractHash,
    score: consensus.score,
    issues: consensus.issues,
    review: consensus,
    reviewers: primaryReviews,
    adjudicator
  });
  consensus.convergence = evaluateQualityConvergence({
    runId,
    topicId,
    stage,
    passed: consensus.passed,
    score: consensus.score,
    issues: consensus.issues,
    deterministicIssues,
    contractHash
  });
  return consensus;
}

function buildQualityFindingSignature(issues = [], deterministicIssues = []) {
  const normalized = [
    ...issues.map((issue) => ({
      code: String(issue?.code || "unclassified").trim(),
      location: [
        issue?.segmentIndex ? `segment:${issue.segmentIndex}` : "",
        Array.isArray(issue?.sceneIndexes) && issue.sceneIndexes.length ? `scenes:${issue.sceneIndexes.join(",")}` : ""
      ].filter(Boolean).join("@")
    })),
    ...deterministicIssues.map((issue) => ({
      code: String(issue?.code || issue || "deterministic").trim().slice(0, 120),
      location: "deterministic"
    }))
  ].filter((issue) => issue.code);
  return [...new Set(normalized.map((issue) => `${issue.code}${issue.location ? `@${issue.location}` : ""}`))]
    .sort()
    .join("|") || "unclassified";
}

function classifyQualityRepairOwner(stage, issues = [], deterministicIssues = []) {
  const codes = new Set(issues.map((issue) => String(issue?.code || "")));
  if (stage === "shotlist_quality" && codes.has("insufficient_visual_depth")) {
    return { owner: "visual_evidence", route: "source_enrichment" };
  }
  const factContractScopeFailure = issues.some((issue) => {
    const issueText = `${issue?.message || ""} ${issue?.repairInstruction || ""}`;
    if (String(issue?.code || "") !== "misleading_premise" || Number(issue?.segmentIndex || 0) !== 0) return false;
    return /제목(?:의|이| 자체|에서).{0,80}(읽힌|오해|과장|너무 넓|잘못|틀린)|(?:core claim|사실 계약|주제 전제)(?:의|이| 자체|에서)?.{0,80}(오해|과장|너무 넓|잘못|틀린|범위)/iu.test(issueText);
  });
  if (factContractScopeFailure) {
    return { owner: "fact_contract", route: "fact_contract_revision" };
  }
  if (["clean_cutaway_forbidden", "occluded_element_required", "unverified_visual_state", "unverified_state_split"].some((code) => codes.has(code))) {
    return { owner: "visual_evidence", route: "visual_reference_enrichment" };
  }
  if (stage === "script_quality"
    && issues.some((issue) => {
      if (!["unsupported_claim", "missing_limitation"].includes(String(issue?.code || ""))) return false;
      const issueText = `${issue?.message || ""} ${issue?.repairInstruction || ""}`;
      return /(?:제목|핵심 질문|core claim|사실 계약|주제 전제)(?:의|이| 자체|에서)?.{0,80}(오해|과장|너무 넓|잘못|틀린|범위)/iu.test(issueText);
    })) {
    return { owner: "fact_contract", route: "fact_contract_revision" };
  }
  const assetFactContractFailure = ["clean_visual_quality", "info_visual_quality"].includes(stage)
    && issues.some((issue) => {
      if (!["unsupported_claim", "claim_mismatch", "missing_limitation"].includes(String(issue?.code || ""))) return false;
      const issueText = `${issue?.message || ""} ${issue?.repairInstruction || ""}`;
      return /(?:claim(?:\s*ref(?:erence)?)?|주장|사실 검증|출처|근거).{0,80}(불일치|지원하지 않|검증되지 않|없|누락|틀린)/iu.test(issueText);
    });
  if (assetFactContractFailure) return { owner: "fact_contract", route: "fact_contract_revision" };
  const assetVisualReferenceFailure = ["clean_visual_quality", "info_visual_quality"].includes(stage)
    && issues.some((issue) => {
      if (!["unsupported_visual", "unverified_visual_state", "missing_visual_reference"].includes(String(issue?.code || ""))) return false;
      const issueText = `${issue?.message || ""} ${issue?.repairInstruction || ""}`;
      return /(?:공식|검증된|시각|사진|도면|단면|참조).{0,80}(근거|자료|참조|필요|부족|없)/u.test(issueText);
    });
  if (assetVisualReferenceFailure) return { owner: "visual_evidence", route: "visual_reference_enrichment" };
  const productionContractRequired = issues.some((issue) => {
    if (!["not_visualizable", "impossible_geometry", "mechanism_gap"].includes(String(issue?.code || ""))) return false;
    const issueText = `${issue?.message || ""} ${issue?.repairInstruction || ""}`;
    const needsHiddenReference = /(수중|내부|단면|도면|가려진|공식 사진|참조 이미지)/u.test(issueText);
    const hasLocalFallback = /(자료가 없다면|근거가 없다면|없으면|제거|삭제|압축|범위를 제한|요구하지|연출하지|보인다고 지시하지|외부 상태로)/u.test(issueText);
    return needsHiddenReference && !hasLocalFallback;
  });
  if (productionContractRequired) {
    return { owner: "production_brief", route: "production_contract_revision" };
  }
  if (deterministicIssues.length) return { owner: stage, route: "local_contract_revision" };
  return { owner: stage, route: "local_targeted_revision" };
}

function buildAssetQualityPromptDetails(shotlist, clipIndexes = []) {
  const requested = new Set(clipIndexes.map(Number).filter(Number.isInteger).filter((index) => index > 0));
  return (shotlist?.items || []).filter((item) => requested.has(Number(item.sortIndex))).map((item) => ({
    clipIndex: Number(item.sortIndex),
    sceneId: item.sceneId,
    visualStateId: item.visualStateId,
    evidenceBeatId: item.evidenceBeatId,
    scenePurpose: item.scenePurpose,
    physicalState: item.physicalState,
    cleanContent: item.cleanContent,
    cleanPrompt: item.cleanPrompt,
    requiredVisibleElements: item.requiredVisibleElements,
    forbiddenVisibleElements: item.forbiddenVisibleElements
  }));
}

function getLatestAssetQualityRemediations(topicId) {
  const decisions = db.prepare(`
    SELECT quality_run_id AS qualityRunId, stage, action, reason, details_json AS detailsJson
    FROM quality_decisions
    WHERE topic_id = ? AND stage IN ('clean_visual_quality', 'info_visual_quality', 'video_visual_quality')
    ORDER BY id DESC
  `).all(topicId);
  const currentShotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
  const latestCleanReviews = new Map();
  for (const review of db.prepare(`
    SELECT clip_index AS clipIndex, status FROM asset_reviews
    WHERE topic_id = ? AND asset_type = 'clean' ORDER BY id DESC
  `).all(topicId)) {
    const clipIndex = Number(review.clipIndex);
    if (!latestCleanReviews.has(clipIndex)) latestCleanReviews.set(clipIndex, String(review.status || "").toUpperCase());
  }
  const aggregated = new Map();
  for (const decision of decisions) {
    decision.details = parseStoredJson(decision.detailsJson, {});
    const run = db.prepare("SELECT metrics_json AS metricsJson FROM quality_runs WHERE id = ?").get(decision.qualityRunId);
    const findings = db.prepare(`
      SELECT code, severity, message, repair_instruction AS repairInstruction
      FROM quality_findings WHERE quality_run_id = ? ORDER BY id
    `).all(decision.qualityRunId);
    const review = parseStoredJson(run?.metricsJson, {})?.details?.review || null;
    const itemIssues = Array.isArray(review?.issues) && review.issues.length ? review.issues : findings;
    const remediation = classifyAssetQualityRemediation({ decision, findings: itemIssues, review });
    if (!remediation) continue;
    const activeClipIndexes = remediation.clipIndexes.filter((clipIndex) => {
      const status = latestCleanReviews.get(clipIndex);
      return remediation.stage !== "clean_visual_quality" || !["AI_PASS", "OK"].includes(status);
    });
    const current = aggregated.get(remediation.stage) || {
      ...remediation,
      clipIndexes: [],
      findings: [],
      seenClipIndexes: new Set()
    };
    for (const clipIndex of activeClipIndexes) {
      if (current.seenClipIndexes.has(clipIndex)) continue;
      current.seenClipIndexes.add(clipIndex);
      current.clipIndexes.push(clipIndex);
      const clipFindings = remediation.findings.filter((finding) => !finding.sceneIndexes.length || finding.sceneIndexes.includes(clipIndex));
      current.findings.push(...clipFindings.map((finding) => ({ ...finding, clipIndex })));
    }
    if (!remediation.clipIndexes.length && !current.findings.length) current.findings.push(...remediation.findings);
    aggregated.set(remediation.stage, current);
  }
  const remediations = new Map();
  for (const [stage, remediation] of aggregated) {
    const promptDetails = buildAssetQualityPromptDetails(currentShotlist, remediation.clipIndexes);
    const findings = remediation.findings.map(({ clipIndex, ...finding }) => ({ ...finding, ...(clipIndex ? { clipIndex } : {}) }));
    const requiresSharedProductionCorrection = stage === "clean_visual_quality"
      && remediation.clipIndexes.length > 1
      && findings.length > 1;
    const normalizedRemediation = requiresSharedProductionCorrection
      ? {
          ...remediation,
          status: "needs_evidence",
          route: "production_contract_revision",
          decisionReason: "여러 CLEAN 장면의 독립 검수 실패를 하나의 제작 계약 교정으로 승격합니다."
        }
      : remediation;
    remediations.set(stage, {
      ...normalizedRemediation,
      findingCodes: [...new Set(findings.map((finding) => finding.code).filter(Boolean))],
      promptDetails,
      assetQualityFeedback: {
        stage,
        clipIndexes: remediation.clipIndexes,
        findings,
        promptDetails,
        decisionReason: normalizedRemediation.decisionReason,
        repairInstruction: remediation.repairInstruction
      }
    });
  }
  return remediations;
}

function classifyAssetQualityRemediation({ decision, findings = [], review = null }) {
  const stage = String(decision?.stage || "");
  const action = String(decision?.action || "");
  if (!['clean_visual_quality', 'info_visual_quality', 'video_visual_quality'].includes(stage)
    || !["retry_targeted", "awaiting_benchmark_comparison", "revise_upstream_contract", "revise_shared_contract"].includes(action)) {
    return null;
  }
  const normalizedFindings = findings.map((issue) => ({
    code: String(issue?.code || "").trim(),
    severity: String(issue?.severity || "").trim(),
    message: String(issue?.message || "").trim(),
    repairInstruction: String(issue?.repairInstruction || "").trim(),
    sceneIndexes: [...new Set((Array.isArray(issue?.sceneIndexes) ? issue.sceneIndexes : [])
      .map(Number).filter(Number.isInteger).filter((index) => index > 0))]
  })).filter((issue) => issue.code || issue.message || issue.repairInstruction);
  const clipIndexes = [...new Set(normalizedFindings.flatMap((issue) => issue.sceneIndexes))];
  const repair = classifyQualityRepairOwner(stage, normalizedFindings, []);
  const reviewAction = String(review?.action || "").trim() || null;
  const repairInstruction = String(
    review?.repairInstruction
    || normalizedFindings.map((issue) => issue.repairInstruction || issue.message).filter(Boolean).join(" / ")
  ).trim();
  const source = {
    decisionReason: String(decision?.reason || "").trim(),
    repairInstruction,
    reviewAction,
    findings: normalizedFindings
  };
  if (action === "awaiting_benchmark_comparison") {
    return { stage, status: "needs_comparison", route: "cross_topic_asset_comparison", clipIndexes, ...source };
  }
  if (repair.route === "visual_reference_enrichment") {
    return { stage, status: "needs_reference", route: repair.route, clipIndexes, ...source };
  }
  if (["fact_contract_revision", "production_contract_revision"].includes(repair.route)
    || ["revise_upstream_contract", "revise_shared_contract"].includes(action)) {
    return { stage, status: "needs_evidence", route: repair.route || "production_contract_revision", clipIndexes, ...source };
  }
  if (action === "retry_targeted" && stage !== "video_visual_quality") {
    return {
      stage,
      status: "needs_revision",
      route: stage === "clean_visual_quality" ? "clean_targeted_replacement" : "info_targeted_repair",
      clipIndexes,
      ...source
    };
  }
  return null;
}

function evaluateQualityConvergence({ runId, topicId, stage, passed, score, issues = [], deterministicIssues = [], contractHash = "" }) {
  const benchmark = topicId ? mapBenchmarkCaseRow(getBenchmarkCaseByTopicStatement.get(topicId)) : null;
  const signature = buildQualityFindingSignature(issues, deterministicIssues);
  const prior = db.prepare(`
    SELECT qd.finding_signature AS findingSignature, qr.score, qd.action
    FROM quality_decisions qd
    JOIN quality_runs qr ON qr.id = qd.quality_run_id
    WHERE qd.topic_id = ? AND qd.stage = ? AND qd.quality_run_id != ?
      AND qd.details_json LIKE ?
      AND (? = '' OR json_extract(qd.details_json, '$.contractHash') = ?)
    ORDER BY qd.id DESC LIMIT 8
  `).all(topicId || null, stage, runId, `%\"engineVersion\":\"${QUALITY_ENGINE_VERSION}\"%`, contractHash, contractHash);
  const previous = prior[0] || null;
  const previousSame = prior.find((entry) => entry.findingSignature === signature) || null;
  const scoreDelta = Number((Number(score || 0) - Number((previousSame || previous)?.score || 0)).toFixed(4));
  const repeatedSignatureCount = 1 + prior.filter((entry) => entry.findingSignature === signature).length;
  const crossTopicCount = signature === "unclassified" ? 0 : Number(db.prepare(`
    SELECT COUNT(DISTINCT topic_id) AS count
    FROM quality_decisions
    WHERE stage = ? AND finding_signature = ? AND topic_id IS NOT NULL AND topic_id != ?
      AND details_json LIKE ?
  `).get(stage, signature, topicId || 0, `%\"engineVersion\":\"${QUALITY_ENGINE_VERSION}\"%`)?.count || 0);
  const issueCodes = new Set(issues.map((issue) => String(issue?.code || "")));
  const upstreamOnlyCodes = new Set(["insufficient_visual_depth"]);
  const upstreamConditionalCodes = new Set([
    "unsupported_claim", "causal_gap", "mechanism_gap", "unsupported_visual",
    "missing_causal_state", "claim_mismatch", "impossible_geometry"
  ]);
  const requiresNewEvidence = (issue) => {
    const code = String(issue?.code || "");
    if (upstreamOnlyCodes.has(code)) return true;
    if (!upstreamConditionalCodes.has(code)) return false;
    const instruction = `${issue?.message || ""} ${issue?.repairInstruction || ""}`;
    return /(추가|새로운|공식|근거 있는|출처|자료|도면|촬영물).{0,30}(필요|보강|확인|추가)|먼저.{0,30}(근거|자료|도면)|upstream|source required/iu.test(instruction);
  };
  const needsUpstreamEvidence = issues.some(requiresNewEvidence);
  const locallyRepairableCodes = new Set([
    "repetition", "not_visualizable", "repeated_visual_state", "family_mismatch",
    "info_overuse", "weak_video_motion", "impossible_geometry"
  ]);
  const hasLocalRepair = issues.some((issue) => (
    !requiresNewEvidence(issue)
    && (locallyRepairableCodes.has(String(issue?.code || "")) || String(issue?.repairInstruction || "").trim())
  )) || deterministicIssues.length > 0;
  const repair = classifyQualityRepairOwner(stage, issues, deterministicIssues);

  let action;
  let reason;
  if (passed) {
    action = "accept";
    reason = "필수 기준과 독립 검수 합의를 통과해 다음 단계로 진행합니다.";
  } else if (repair.owner !== stage) {
    action = "revise_upstream_contract";
    reason = repair.owner === "fact_contract"
      ? "제목·핵심 조건의 사실 범위 문제라 대본을 다시 쓰지 않고 사실 계약부터 수정합니다."
      : repair.owner === "visual_evidence"
        ? "텍스트 설명이 아니라 실제 시각 참조가 필요한 문제라 생성물을 반복하지 않고 시각 근거를 보강합니다."
        : "하위 결과물 수정으로 해결할 수 없어 제작 브리프 계약부터 수정합니다.";
  } else if (previousSame && scoreDelta < 0.03) {
    action = crossTopicCount > 0 ? "revise_shared_contract" : "revise_upstream_contract";
    reason = crossTopicCount > 0
      ? `다른 벤치마크 주제에서도 같은 실패가 확인되어 결과물을 다시 만들지 않고 공통 계약을 수정합니다.`
      : `같은 실패가 반복됐고 점수 개선이 ${scoreDelta.toFixed(2)}에 그쳐 결과물 재생성 대신 상위 설계를 수정합니다.`;
  } else if (needsUpstreamEvidence && (previous || !hasLocalRepair)) {
    action = "revise_upstream_contract";
    reason = hasLocalRepair
      ? "국소 교정 뒤에도 근거·인과·시각 상태 문제가 남아 하위 결과물을 반복 생성하지 않고 상위 설계를 수정합니다."
      : "국소 장면 수정으로 해결할 수 없는 근거·인과·시각 깊이 문제라 첫 검수에서 상위 설계 수정으로 전환합니다.";
  } else {
    action = "retry_targeted";
    reason = previous
      ? `실패 지문이 바뀌었거나 점수가 ${scoreDelta.toFixed(2)} 개선되어 지적된 범위만 다시 수정합니다.`
      : "첫 실패이므로 지적된 범위만 수정한 뒤 동일 기준으로 다시 검수합니다.";
  }

  const details = {
    engineVersion: QUALITY_ENGINE_VERSION,
    contractHash,
    previous,
    previousSame,
    issueCodes: [...issueCodes],
    repairOwner: repair.owner,
    remediationRoute: repair.route,
    hasLocalRepair,
    deterministicIssueCount: deterministicIssues.length
  };
  insertQualityDecisionStatement.run(
    runId,
    benchmark?.id || null,
    topicId || null,
    stage,
    action,
    reason,
    signature,
    scoreDelta,
    repeatedSignatureCount,
    crossTopicCount,
    JSON.stringify(details)
  );
  return {
    runId,
    action,
    reason,
    findingSignature: signature,
    scoreDelta,
    repeatedSignatureCount,
    crossTopicCount
    ,repairOwner: repair.owner
    ,remediationRoute: repair.route
  };
}

function shouldContinueQualityRepair(review, cycle, startedAt, repairLimit = QUALITY_AUTO_REPAIR_LIMIT, policy = "benchmark") {
  if (review?.passed || review?.convergence?.action !== "retry_targeted") return false;
  const elapsedMs = Date.now() - startedAt;
  if (cycle <= repairLimit && elapsedMs < QUALITY_REPAIR_WALL_MS) return true;
  const isBenchmarkPolicy = policy === "benchmark";
  const action = isBenchmarkPolicy ? "awaiting_benchmark_comparison" : "auto_converge_hold";
  const reason = repairLimit === 0
    ? (isBenchmarkPolicy
      ? "첫 생성과 정확한 검수 결과를 저장했습니다. 자동 재생성은 하지 않고 5개 벤치마크의 공통 실패를 모은 뒤 해당 범위만 수정합니다."
      : "autoConverge 정책의 허용된 국소 교정을 사용해 현재 계약을 HOLD합니다.")
    : elapsedMs >= QUALITY_REPAIR_WALL_MS
      ? `품질 판단 루프가 ${Math.round(elapsedMs / 60000)}분을 넘어 추가 생성을 중단했습니다.`
      : `허용된 자동 교정 ${repairLimit}회를 사용해 추가 생성을 중단했습니다.`;
  review.convergence.action = action;
  review.convergence.reason = reason;
  if (review.convergence.runId) {
    db.prepare("UPDATE quality_decisions SET action = ?, reason = ? WHERE quality_run_id = ?")
      .run(action, reason, review.convergence.runId);
  }
  return false;
}

function normalizeProductionBrief(result, fallbackDomain = "engineering") {
  return {
    status: result?.status === "hold" ? "hold" : "ready",
    domainKey: ["engineering", "history", "science"].includes(result?.domainKey) ? result.domainKey : fallbackDomain,
    narrativeType: String(result?.narrativeType || "hidden_mechanism").trim(),
    scopeStatement: String(result?.scopeStatement || "").trim(),
    coreQuestion: String(result?.coreQuestion || "").trim(),
    causalChain: Array.isArray(result?.causalChain) ? result.causalChain : [],
    visualStates: Array.isArray(result?.visualStates) ? result.visualStates.map((state, index) => ({
      ...state,
      stateId: String(state?.stateId || `VS${String(index + 1).padStart(2, "0")}`).trim(),
      label: String(state?.label || "").trim(),
      purpose: String(state?.purpose || "").trim(),
      physicalState: normalizeObservablePhysicalState(
        String(state?.physicalState || "").trim(),
        String(state?.evidenceBeats?.[0]?.visualFamily || "exterior").trim()
      ),
      changeFromPrevious: String(state?.changeFromPrevious || "").trim(),
      requiredVisibleElements: [...new Set((state?.requiredVisibleElements || []).map((value) => String(value).trim()).filter(Boolean))],
      forbiddenVisibleElements: [...new Set((state?.forbiddenVisibleElements || []).map((value) => String(value).trim()).filter(Boolean))],
      evidenceBeats: Array.isArray(state?.evidenceBeats) ? state.evidenceBeats.map((beat, beatIndex) => {
        const visualFamily = String(beat?.visualFamily || "exterior").trim();
        const normalizedVisibility = normalizeObservableVisibilityRequirements(
          beat?.requiredVisibleElements,
          beat?.forbiddenVisibleElements,
          visualFamily
        );
        return {
          beatId: String(beat?.beatId || `${state?.stateId || `VS${String(index + 1).padStart(2, "0")}`}_B${beatIndex + 1}`).trim(),
          label: String(beat?.label || "").trim(),
          shotRole: String(beat?.shotRole || "context").trim(),
          visualFamily,
          purpose: String(beat?.purpose || "").trim(),
          physicalState: normalizeObservablePhysicalState(String(beat?.physicalState || "").trim(), visualFamily),
          cameraMotion: String(beat?.cameraMotion || "").trim(),
          motionPolicy: String(beat?.motionPolicy || "").trim(),
          transitionEndState: String(beat?.transitionEndState || "").trim(),
          requiredVisibleElements: normalizedVisibility.required,
          forbiddenVisibleElements: normalizedVisibility.forbidden,
          infoGraphic: beat?.infoGraphic ? normalizeInfoGraphicSpec(beat.infoGraphic, beat) : null
        };
      }) : [],
      claimRefs: [...new Set((state?.claimRefs || []).map((value) => String(value).trim()).filter(Boolean))]
      ,evidenceRefs: [...new Set((state?.evidenceRefs || []).map((value) => String(value).trim()).filter(Boolean))]
    })) : [],
    forbiddenInferences: Array.isArray(result?.forbiddenInferences) ? result.forbiddenInferences.map((value) => String(value).trim()).filter(Boolean) : [],
    lengthGuidance: result?.lengthGuidance && typeof result.lengthGuidance === "object" ? result.lengthGuidance : {
      strategy: "content_first",
      recommendedMinSec: 30,
      recommendedMaxSec: 90,
      reason: "검증된 인과관계를 반복 없이 설명하는 참고 범위"
    },
    notes: Array.isArray(result?.notes) ? result.notes : []
  };
}

function normalizeVisibilityRequirements(requiredValues = [], forbiddenValues = []) {
  const required = [];
  const forbidden = (forbiddenValues || []).map((value) => String(value).trim()).filter(Boolean);
  for (const rawValue of requiredValues || []) {
    const value = String(rawValue || "").trim();
    if (!value) continue;
    const isNegativeRequirement = /(보이지\s*않|보여주지\s*않|드러내지\s*않|노출하지\s*않|가려야|숨겨야|없어야|금지|표시하지\s*않|not\s+visible|must\s+not|do\s+not\s+show)/iu.test(value);
    if (isNegativeRequirement) forbidden.push(value);
    else required.push(value);
  }
  return {
    required: [...new Set(required)],
    forbidden: [...new Set(forbidden)]
  };
}

function normalizeObservableVisibilityRequirements(requiredValues = [], forbiddenValues = [], visualFamily = "exterior") {
  const normalized = normalizeVisibilityRequirements(requiredValues, forbiddenValues);
  if (!["exterior", "environment", "action", "comparison", "monitoring"].includes(visualFamily)) return normalized;
  const required = [];
  const forbidden = [...normalized.forbidden];
  for (const value of normalized.required) {
    const namesOccludedElement = /(수중|강바닥|내부|지하|매립|가려진)/u.test(value);
    const explicitlyObservable = /(노출|드러난|개방된|매립\s*전|타설\s*전|시공\s*중|거푸집\s*(안|내부)|외부에서\s*보이는)/u.test(value);
    if (namesOccludedElement && !explicitlyObservable) forbidden.push(`외부 CLEAN에서 보이지 않는 요소를 요구하지 않는다: ${value}`);
    else required.push(value);
  }
  return { required: [...new Set(required)], forbidden: [...new Set(forbidden)] };
}

function normalizeObservablePhysicalState(value, visualFamily = "exterior") {
  const text = String(value || "").trim();
  if (!text || !["exterior", "environment", "action", "comparison", "monitoring"].includes(visualFamily)) return text;
  const clauses = text.split(/(?<=[.!?。])\s*|,\s*/u).map((clause) => clause.trim()).filter(Boolean);
  const visibleClauses = clauses.filter((clause) => {
    const namesOccludedElement = /(수중|강바닥|내부|지하|매립|가려진)/u.test(clause);
    const explicitlyObservable = /(노출|드러난|개방된|매립\s*전|타설\s*전|시공\s*중|거푸집\s*(안|내부)|외부에서\s*보이는)/u.test(clause);
    return !namesOccludedElement || explicitlyObservable;
  });
  return visibleClauses.join(" ") || text;
}

function getProductionBriefIssues(brief, factCheck, { allowCanonicalPhotoSequence = false, productionRequirements = null } = {}) {
  const issues = [];
  const requirements = normalizeProductionRequirements(productionRequirements || {});
  const supportedClaims = new Set((factCheck?.claims || [])
    .filter((claim) => claim.status === "SUPPORTED" && claim.useInVideo !== false)
    .map((claim) => String(claim.id)));
  if (!brief.scopeStatement) issues.push({ code: "missing_scope", severity: "error", message: "제작 범위가 비어 있습니다." });
  if (!brief.coreQuestion) issues.push({ code: "missing_question", severity: "error", message: "핵심 질문이 비어 있습니다." });
  const minimumVisualStates = requirements.minimumVisualStates || requirements.targetVisualStateRange?.[0];
  const maximumVisualStates = requirements.targetVisualStateRange?.[1];
  if (minimumVisualStates && brief.visualStates.length < minimumVisualStates) issues.push({ code: "insufficient_visual_states", severity: "error", message: `구성된 제작 요구사항의 시각 상태가 ${brief.visualStates.length}/${minimumVisualStates}개입니다.` });
  if (maximumVisualStates && brief.visualStates.length > maximumVisualStates) issues.push({ code: "excess_visual_states", severity: "error", message: `구성된 제작 요구사항의 시각 상태가 최대 ${maximumVisualStates}개를 초과합니다.` });
  const stateIds = new Set();
  const stateFingerprints = new Set();
  const verifiedEvidenceIds = new Set((factCheck?.visualEvidence || [])
    .map((evidence) => String(evidence?.id || evidence?.state || "").trim())
    .filter(Boolean));
  const usedEvidenceIds = new Set();
  const requiredInfoOverlayBeatKeys = new Set();
  for (const [index, state] of brief.visualStates.entries()) {
    const referencedEvidence = (factCheck?.visualEvidence || []).filter((evidence) => (
      (state.evidenceRefs || []).includes(String(evidence?.id || evidence?.state || "").trim())
    ));
    const hasVisualReference = referencedEvidence.some((evidence) => (
      ["official_photo", "construction_photo", "official_diagram", "official_section"].includes(String(evidence?.referenceType || ""))
      && /^https?:\/\//iu.test(String(evidence?.referenceSourceUrl || ""))
      && (
        /^https?:\/\//iu.test(String(evidence?.referenceMediaUrl || ""))
        || (/\.pdf(?:$|[?#])/iu.test(String(evidence?.referenceSourceUrl || "")) && Number(evidence?.referencePage || 0) > 0)
      )
      && String(evidence?.referenceDescription || "").trim()
    ));
    if (!state.stateId || stateIds.has(state.stateId)) {
      issues.push({ code: "duplicate_state_id", severity: "error", message: `${index + 1}번 시각 상태 ID가 비어 있거나 중복됩니다.` });
    }
    stateIds.add(state.stateId);
    const fingerprint = state.physicalState.toLowerCase().replace(/[^0-9a-z가-힣]/gu, "");
    if (fingerprint && stateFingerprints.has(fingerprint) && !allowCanonicalPhotoSequence) {
      issues.push({ code: "duplicate_physical_state", severity: "error", message: `${state.stateId}가 앞선 상태와 같은 물리 상태를 반복합니다.` });
    }
    stateFingerprints.add(fingerprint);
    const invalidClaims = state.claimRefs.filter((claimRef) => !supportedClaims.has(claimRef));
    if (!state.claimRefs.length || invalidClaims.length) {
      issues.push({ code: "unsupported_visual_state", severity: "error", message: `${state.stateId}가 지원되지 않는 주장 ${invalidClaims.join(", ") || "없음"}에 연결됩니다.` });
    }
    const invalidEvidenceRefs = (state.evidenceRefs || []).filter((evidenceRef) => !verifiedEvidenceIds.has(evidenceRef));
    if (!(state.evidenceRefs || []).length || invalidEvidenceRefs.length) {
      issues.push({
        code: "unverified_visual_state",
        severity: "error",
        message: `${state.stateId}가 사실 검증의 시각 근거에 직접 연결되지 않습니다${invalidEvidenceRefs.length ? `: ${invalidEvidenceRefs.join(", ")}` : "."}`
      });
    }
    const reusedEvidenceRefs = (state.evidenceRefs || []).filter((evidenceRef) => {
      if (!usedEvidenceIds.has(evidenceRef)) return false;
      const evidence = (factCheck?.visualEvidence || []).find((entry) => String(entry?.id || entry?.state || "").trim() === evidenceRef);
      return String(evidence?.referenceType || "") !== "official_diagram" || (evidence?.visibleFacts || []).length < 3;
    });
    if (reusedEvidenceRefs.length) {
      issues.push({
        code: "unverified_state_split",
        severity: "error",
        message: `${state.stateId}가 이미 사용한 시각 근거 ${reusedEvidenceRefs.join(", ")}를 새 물리 상태처럼 다시 분리했습니다. 카메라·시간 설명만 다른 상태는 만들 수 없습니다.`
      });
    }
    for (const evidenceRef of state.evidenceRefs || []) usedEvidenceIds.add(evidenceRef);
    if (state.requiredVisibleElements.length < 2) {
      issues.push({ code: "weak_visual_contract", severity: "error", message: `${state.stateId}의 필수 시각 요소가 부족합니다.` });
    }
    if (!state.evidenceBeats.length) {
      issues.push({ code: "missing_evidence_beats", severity: "error", message: `${state.stateId}를 실제 클립으로 분해할 증거 비트가 없습니다.` });
    }
    const beatIds = new Set();
    const beatFingerprints = new Set();
    for (const beat of state.evidenceBeats) {
      const beatFingerprint = String(beat.physicalState || "").toLowerCase().replace(/[^0-9a-z가-힣]/gu, "");
      if (!beat.beatId || beatIds.has(beat.beatId)) {
        issues.push({ code: "duplicate_evidence_beat", severity: "error", message: `${state.stateId}의 증거 비트 ID가 비어 있거나 중복됩니다.` });
      }
      if (beatFingerprint && beatFingerprints.has(beatFingerprint)) {
        issues.push({ code: "duplicate_evidence_beat", severity: "error", message: `${state.stateId} 안에 같은 물리 상태를 반복하는 증거 비트가 있습니다.` });
      }
      if (!beat.purpose || !beat.physicalState || beat.requiredVisibleElements.length < 2) {
        issues.push({ code: "weak_evidence_beat", severity: "error", message: `${state.stateId}/${beat.beatId || "미지정"}의 화면 계약이 부족합니다.` });
      }
      if (beat.visualFamily === "cutaway" && !hasVisualReference) {
        issues.push({ code: "clean_cutaway_forbidden", severity: "error", message: `${state.stateId}/${beat.beatId || "미지정"}가 CLEAN에서 금지된 단면·컷어웨이를 요구합니다.` });
      }
      const hiddenRequired = beat.requiredVisibleElements.filter((element) => {
        const value = String(element);
        const namesHiddenElement = /(수중|강바닥|내부|지하|매립|가려진)/u.test(value);
        const explicitlyExposed = /(노출|드러난|개방된|매립\s*전|타설\s*전|시공\s*중|거푸집\s*(안|내부)|외부에서\s*보이는)/u.test(value);
        return namesHiddenElement && !explicitlyExposed;
      });
      const supportsHiddenRequired = referencedEvidence.some((evidence) => (
        ["official_section", "construction_photo"].includes(String(evidence?.referenceType || ""))
      ));
      if (hiddenRequired.length
        && ["exterior", "environment", "action", "comparison", "monitoring"].includes(beat.visualFamily)
        && !supportsHiddenRequired) {
        issues.push({
          code: "occluded_element_required",
          severity: "error",
          message: `${state.stateId}/${beat.beatId || "미지정"}가 외부 CLEAN에서 가려진 요소를 필수로 요구합니다: ${hiddenRequired.join(", ")}`
        });
      }
      const infoGraphic = normalizeInfoGraphicSpec(beat.infoGraphic, beat);
      if (state.stateId && beat.beatId
        && infoGraphic.requiresOverlay === true
        && infoGraphic.type !== "none"
        && !getInfoGraphicSpecIssues(infoGraphic).length) {
        requiredInfoOverlayBeatKeys.add(`${state.stateId}\u0000${beat.beatId}`);
      }
      beatIds.add(beat.beatId);
      beatFingerprints.add(beatFingerprint);
    }
  }
  if (requirements.minimumRequiredInfoOverlays > 0
    && requiredInfoOverlayBeatKeys.size < requirements.minimumRequiredInfoOverlays) {
    issues.push({
      code: "insufficient_required_info_overlays",
      severity: "error",
      message: `구성된 제작 요구사항의 근거 기반 INFO 오버레이가 ${requiredInfoOverlayBeatKeys.size}/${requirements.minimumRequiredInfoOverlays}개입니다. requiresOverlay=true인 완전한 non-none infoGraphic을 서로 다른 state/evidenceBeat에 연결해야 합니다.`
    });
  }
  for (const step of brief.causalChain) {
    const invalidClaims = (step.claimRefs || []).filter((claimRef) => !supportedClaims.has(String(claimRef)));
    if (invalidClaims.length) {
      issues.push({ code: "unsupported_causal_step", severity: "error", message: `${step.stepId || "인과 단계"}가 지원되지 않는 주장 ${invalidClaims.join(", ")}을 사용합니다.` });
    }
  }
  if (!brief.forbiddenInferences.length) {
    issues.push({ code: "missing_forbidden_inferences", severity: "warning", message: "근거 밖으로 확장하지 않기 위한 금지 추론이 없습니다." });
  }
  return [...issues, ...validateProductionBriefEvidence(brief, factCheck)];
}

function createEvidencePacket(topic, factCheck) {
  const snapshot = {
    claims: factCheck.claims || [],
    visualEvidence: factCheck.visualEvidence || [],
    sources: factCheck.sources || [],
    factCheckId: factCheck.id,
    factCheckAttempt: factCheck.attempt
  };
  const contractHash = buildQualityContractHash(snapshot);
  db.prepare(`
    INSERT OR IGNORE INTO evidence_packets (
      topic_id, fact_check_id, fact_check_revision, claims_json, visual_evidence_json, source_snapshot_json, contract_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    topic.id, factCheck.id, Number(factCheck.attempt || 1), JSON.stringify(snapshot.claims),
    JSON.stringify(snapshot.visualEvidence), JSON.stringify(snapshot.sources), contractHash
  );
  const packet = db.prepare("SELECT id, contract_hash AS contractHash FROM evidence_packets WHERE topic_id = ? AND fact_check_id = ? AND contract_hash = ?").get(topic.id, factCheck.id, contractHash);
  return { id: Number(packet.id), contractHash: packet.contractHash, snapshot };
}

function productionBriefIssueKey(issue = {}) {
  return [String(issue.code || "unclassified"), String(issue.stateId || ""), String(issue.evidenceId || "")].join("\u0000");
}

function mergeProductionBriefIssues(deterministicIssues = [], review = null) {
  const merged = new Map();
  for (const issue of deterministicIssues) merged.set(productionBriefIssueKey(issue), issue);
  const reviewerIssues = Array.isArray(review?.issues) ? review.issues : [];
  for (const issue of reviewerIssues) {
    const verdict = String(issue?.verdict || review?.verdict || "FAIL");
    if (verdict === "PASS") continue;
    merged.set(productionBriefIssueKey(issue), {
      ...issue,
      verdict,
      severity: issue?.severity || "error",
      owner: issue?.owner || "production_brief_reviewer",
      requiresEvidence: Boolean(issue?.requiresEvidence)
    });
  }
  if (review && (!review.passed || review.verdict !== "PASS") && !reviewerIssues.length) {
    const verdict = String(review.verdict || "FAIL");
    const fallback = {
      verdict,
      code: `production_brief_reviewer_${verdict.toLowerCase()}`,
      stateId: "",
      evidenceId: "",
      owner: "production_brief_reviewer",
      requiresEvidence: verdict === "NOT_OBSERVABLE",
      severity: "error",
      message: String(review.summary || "독립 production brief 검수가 보류 판정을 반환했습니다.")
    };
    merged.set(productionBriefIssueKey(fallback), fallback);
  }
  return [...merged.values()];
}

function saveProductionBrief(topic, factCheck, brief, raw, source, evidencePacket = null) {
  evidencePacket ||= createEvidencePacket(topic, factCheck);
  const deterministicIssues = getProductionBriefIssues(brief, factCheck, {
    allowCanonicalPhotoSequence: topic.runLane === "production_canary",
    productionRequirements: getConfiguredProductionRequirements(topic)
  });
  const issues = mergeProductionBriefIssues(deterministicIssues, raw?.briefReview);
  const blockingIssues = issues.filter((issue) => issue.severity === "error");
  const status = brief.status === "ready" && !blockingIssues.length ? "ready" : "hold";
  const quality = {
    passed: status === "ready",
    score: Math.max(0, Number((1 - Math.min(1, blockingIssues.length * 0.2 + (issues.length - blockingIssues.length) * 0.05)).toFixed(2))),
    issues,
    source,
    evidencePacketHash: evidencePacket?.contractHash || "",
    reviewer: raw?.briefReview ? {
      verdict: raw.briefReview.verdict,
      passed: raw.briefReview.passed,
      summary: raw.briefReview.summary || "",
      issues: Array.isArray(raw.briefReview.issues) ? raw.briefReview.issues : [],
      invocationId: raw.briefReview.__aiInvocationId || null,
      model: raw.briefReview.__aiModel || "deterministic"
    } : null
  };
  const previous = mapProductionBriefRow(getProductionBriefByTopicStatement.get(topic.id));
  upsertProductionBriefStatement.run(
    topic.id,
    factCheck.id,
    status,
    brief.domainKey,
    brief.narrativeType,
    brief.scopeStatement,
    brief.coreQuestion,
    JSON.stringify(brief.causalChain),
    JSON.stringify(brief.visualStates),
    JSON.stringify(brief.forbiddenInferences),
    JSON.stringify(brief.lengthGuidance),
    JSON.stringify(quality),
    JSON.stringify({
      contractVersion: PRODUCTION_BRIEF_CONTRACT_VERSION,
      source,
      generation: raw,
      notes: brief.notes,
      evidencePacketId: evidencePacket?.id || null,
      evidencePacketHash: evidencePacket?.contractHash || "",
      evaluatorVersion: "production-brief-preflight-v1",
      model: raw?.__aiModel || "deterministic",
      invocationId: raw?.__aiInvocationId || null
    })
  );
  const saved = mapProductionBriefRow(getProductionBriefByTopicStatement.get(topic.id));
  const previousStateIds = (previous?.visualStates || []).map((state) => state.stateId);
  const savedStateIds = (saved.visualStates || []).map((state) => state.stateId);
  const visualContractChanged = previous && JSON.stringify(previous.visualStates) !== JSON.stringify(saved.visualStates);
  if (previous && JSON.stringify(previousStateIds) !== JSON.stringify(savedStateIds)) {
    db.prepare("UPDATE scripts SET status = 'stale', approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE topic_id = ?").run(topic.id);
  }
  if (visualContractChanged) {
    db.prepare("UPDATE shotlists SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'").run(topic.id);
  }
  const reviewerReason = raw?.briefReview && (!raw.briefReview.passed || raw.briefReview.verdict !== "PASS")
    ? String(raw.briefReview.summary || "독립 production brief 검수가 보류 판정을 반환했습니다.")
    : "";
  recordTopicAttempt(topic.id, "production_brief", status, [reviewerReason, ...issues.map((issue) => issue.message)]
    .filter(Boolean).join(" / ") || "제작 설계서가 검증된 주장과 시각 상태 계약을 통과했습니다.", {
    score: quality.score,
    issues,
    briefId: saved.id,
    source,
    evidencePacketHash: evidencePacket?.contractHash || "",
    review: raw?.briefReview || null,
    reviewer: quality.reviewer
  });
  return saved;
}

async function saveReviewedProductionBrief(topic, factCheck, brief, raw, source, jobContext = null) {
  const evidencePacket = createEvidencePacket(topic, factCheck);
  const deterministicIssues = getProductionBriefIssues(brief, factCheck, {
    allowCanonicalPhotoSequence: topic.runLane === "production_canary",
    productionRequirements: getConfiguredProductionRequirements(topic)
  }).filter((entry) => entry.severity === "error");
  let review = {
    passed: false,
    verdict: "NOT_OBSERVABLE",
    summary: "결정론 preflight가 실제 제작 가능한 근거를 확인하지 못했습니다.",
    issues: deterministicIssues
  };
  if (!deterministicIssues.length) {
    const prompt = `You are an independent evidence reviewer. You did not generate this production brief. Review only the immutable evidence packet and completed brief below; do not trust author notes. For every failure return PASS, FAIL, or NOT_OBSERVABLE and an issue code, stateId, evidenceId, owner, requiresEvidence, and message.\n\nEvidence packet:\n${JSON.stringify(evidencePacket.snapshot, null, 2)}\n\nCompleted production brief:\n${JSON.stringify(brief, null, 2)}`;
    review = await runCodexJson(prompt, `production-brief-review-${topic.id}`, 180000, {
      signal: jobContext?.signal,
      topicId: topic.id,
      stage: "production_brief_review",
      outputSchema: PRODUCTION_BRIEF_REVIEW_OUTPUT_SCHEMA,
      models: ["gpt-5.6-sol"]
    });
  }
  if (!review.passed || review.verdict !== "PASS") brief.status = "hold";
  const persistedRaw = Object.assign(raw && typeof raw === "object" ? raw : {}, { briefReview: review });
  return saveProductionBrief(topic, factCheck, brief, persistedRaw, source, evidencePacket);
}

async function repairProductionBriefFromReviewer(topic, factCheck, existing, jobContext = null) {
  const reviewer = existing?.quality?.reviewer;
  if (!existing || !reviewer?.issues?.length) throw new Error("수선할 production brief reviewer 지적이 없습니다.");
  const productionRequirements = getConfiguredProductionRequirements(topic);
  const prompt = `
You are repairing a production brief after one independent evidence review. Return the complete corrected production brief JSON only.

Rules:
- Fix every reviewer issue in the production contract itself. Do not merely copy the issue into notes.
- Use only the immutable SUPPORTED claims and visualEvidence below.
- You may merge or remove an unsupported intermediate state. Preserve causal order, but do not preserve a state count that the evidence cannot support.
- A multi-panel official_diagram may support multiple distinct states only when its visibleFacts directly identify each state. Do not invent a boundary state between listed facts.
${topic.runLane === "production_canary" ? "- This canary's scope mandates a fixed ordered official-photo sequence. Preserve one visual state per ordered official reference with a distinct stateId and evidenceRefs item, even when two photos document the same operating condition from different viewpoints. State explicitly that the viewpoints do not prove an intervening transition." : ""}
- For a single static photo, cameraMotion must be a static hold or crop/scale within the same frame; no parallax, arc, or synthesized new angle.
- Keep CLEAN frames free of text, labels, arrows, UI, cutaways, and inferred hidden mechanisms.
- When configured minimumRequiredInfoOverlays is greater than zero, select at least that many distinct supported state/evidence beats with complete, valid non-none infoGraphic and requiresOverlay=true. Set requiresOverlay=true only when CLEAN and the transition alone cannot convey one evidence-supported relationship; never invent facts.
- status may be ready only when every issue is actually resolved.

Configured production requirements:
${JSON.stringify(productionRequirements, null, 2)}

Reviewer findings:
${JSON.stringify(reviewer, null, 2)}

Immutable fact contract:
${JSON.stringify({ claims: factCheck.claims, visualEvidence: factCheck.visualEvidence, unresolved: factCheck.unresolved }, null, 2)}

Current production brief:
${JSON.stringify(existing, null, 2)}
  `.trim();
  jobContext?.progress(18, "독립 reviewer 지적을 production brief에 한 번 반영합니다.");
  const raw = await runCodexJson(prompt, `production-brief-review-repair-${topic.id}`, 240000, {
    signal: jobContext?.signal,
    topicId: topic.id,
    stage: "production_brief_repair",
    outputSchema: PRODUCTION_BRIEF_SCAFFOLD_OUTPUT_SCHEMA,
    models: ["gpt-5.6-sol", "gpt-5.6-terra"]
  });
  return saveReviewedProductionBrief(topic, factCheck, normalizeProductionBrief(raw, topic.mainTopic), raw, "production_canary_reviewer_repair", jobContext);
}

function bindExistingScriptToProductionBrief(topicId, productionBrief) {
  const row = getScriptByTopicStatement.get(topicId);
  if (!row) return;
  const productionScript = parseStoredJson(row.productionScriptJson, []);
  if (!productionScript.length || productionScript.some((item) => item.visualStateId)) return;
  if (productionScript.length !== productionBrief.visualStates.length) return;
  const boundScript = productionScript.map((item, index) => ({
    ...item,
    visualStateId: productionBrief.visualStates[index].stateId
  }));
  const raw = parseStoredJson(row.rawJson, {});
  db.prepare(`
    UPDATE scripts
    SET production_script_json = ?, raw_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE topic_id = ?
  `).run(
    JSON.stringify(boundScript),
    JSON.stringify({ ...raw, productionBriefId: productionBrief.id, visualStateBinding: "benchmark-order" }),
    topicId
  );
}

function inferRepresentativeShotRole(row, index, total) {
  const text = `${row.beat || ""} ${row.mechanismStep || ""} ${row.stateChangeReason || ""}`;
  if (index === 0) return "establishing";
  if (index === total - 1) return "conclusion";
  if (/위험|문제|원인|실패|균열|붕괴/iu.test(text)) return "cause";
  if (/개입|시공|설치|폐쇄|개방|전환|해결/iu.test(text)) return "intervention";
  if (/비교|평형|관측|측정|검사/iu.test(text)) return "comparison";
  return "mechanism";
}

function inferRepresentativeVisualFamily(row, shotRole) {
  const text = `${row.visualDirection || ""} ${row.physicalState || ""}`;
  if (/단면|내부|지반 아래|기초 아래/iu.test(text)) return "cutaway";
  if (/근접|접촉부|연결부|균열|표면/iu.test(text)) return "macro";
  if (/클린룸|지상 시험|시험 설비/iu.test(text)) return "environment";
  if (/비교|같은 기준|수위|축/iu.test(text) || shotRole === "comparison") return "comparison";
  if (/이동|회전|흐르|닫|열|시공|작업/iu.test(text)) return "action";
  return "exterior";
}

function buildProductionBriefFromApprovedScript(topic, script) {
  const rows = script.productionScript || [];
  const visualStates = rows.map((row, index) => {
    const stateId = String(row.visualStateId || `VS${String(index + 1).padStart(2, "0")}`);
    const shotRole = inferRepresentativeShotRole(row, index, rows.length);
    const visualFamily = inferRepresentativeVisualFamily(row, shotRole);
    const requiredVisibleElements = [row.visualDirection, row.physicalState]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .slice(0, 2);
    while (requiredVisibleElements.length < 2) {
      requiredVisibleElements.push(index === 0 ? "주요 대상과 주변 환경의 실제 공간 관계" : "직전 상태와 달라진 실제 물리 관계");
    }
    const forbiddenVisibleElements = [...new Set([
      ...(row.infoGraphic?.forbidden || []),
      ...(script.limitations || [])
    ].map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 8);
    const claimRefs = [...new Set((row.claimRefs || []).map((value) => String(value).trim()).filter(Boolean))];
    return {
      stateId,
      label: String(row.beat || row.mechanismStep || `시각 상태 ${index + 1}`).trim(),
      purpose: String(row.mechanismStep || row.stateChangeReason || row.beat || "검증된 물리 상태 제시").trim(),
      physicalState: String(row.physicalState || row.visualDirection || "검증된 물리 상태").trim(),
      changeFromPrevious: String(row.stateChangeReason || (index ? "직전 상태에서 다음 인과 단계로 전환된다." : "도입 상태다.")).trim(),
      requiredVisibleElements,
      forbiddenVisibleElements,
      evidenceBeats: [{
        beatId: `${stateId}_B1`,
        label: String(row.beat || `대표 장면 ${index + 1}`).trim(),
        shotRole,
        visualFamily,
        purpose: String(row.mechanismStep || row.stateChangeReason || row.beat || "대표 증거 장면").trim(),
        physicalState: String(row.physicalState || row.visualDirection || "검증된 물리 상태").trim(),
        cameraMotion: "restrained slow push-in with stable geometry",
        motionPolicy: "first_frame",
        transitionEndState: "",
        requiredVisibleElements,
        forbiddenVisibleElements: forbiddenVisibleElements.slice(0, 6),
        infoGraphic: normalizeInfoGraphicSpec(row.infoGraphic || { type: "none" }, row)
      }],
      claimRefs
    };
  });
  return normalizeProductionBrief({
    status: "ready",
    domainKey: topic.mainTopic,
    narrativeType: script.narrativeType,
    scopeStatement: script.coreMechanism,
    coreQuestion: script.coreQuestion,
    causalChain: (script.causalContext || []).map((step, index) => ({
      stepId: `CS${String(index + 1).padStart(2, "0")}`,
      role: step.role,
      statement: step.statement,
      claimRefs: step.claimRefs
    })),
    visualStates,
    forbiddenInferences: [...new Set([...(script.limitations || []), ...(script.notes || [])])],
    lengthGuidance: {
      strategy: "content_first",
      recommendedMinSec: Number(script.lengthPlan?.recommendedMinSec || 30),
      recommendedMaxSec: Number(script.lengthPlan?.recommendedMaxSec || 90),
      reason: "승인된 대본의 검증된 인과를 반복 없이 설명하는 범위"
    },
    notes: ["승인된 기존 대본을 제작 설계서의 대표 상태로 이관했다. 실제 장면 수는 TTS 실측 후 확장한다."]
  }, topic.mainTopic);
}

function materializeCanaryManifestVisualEvidence(topic, factCheck, script) {
  if (topic.runLane !== "production_canary" || !script?.productionScript?.length) {
    throw new Error("production canary의 기존 productionScript가 필요합니다.");
  }
  const { references } = loadProductionCanaryManifest(topic.externalKey);
  const scriptRows = script.productionScript || [];
  const scriptStateIds = scriptRows.map((row) => String(row.visualStateId || "").trim());
  if (!scriptStateIds.length || scriptStateIds.some((stateId) => !stateId) || new Set(scriptStateIds).size !== scriptStateIds.length) {
    throw new Error("기존 draft 대본의 visualStateId가 비어 있거나 중복됩니다.");
  }
  const manifestBindingsByStateId = new Map(references
    .filter((reference) => reference.mediaKind !== "video_reference_only" && String(reference.metadata?.productionVisualStateId || "").trim())
    .map((reference) => [String(reference.metadata.productionVisualStateId).trim(), reference]));
  if (manifestBindingsByStateId.size !== scriptStateIds.length) {
    throw new Error("Canary manifest의 productionVisualStateId 개수가 기존 draft 대본과 일치하지 않습니다.");
  }
  const bindings = scriptRows.map((row) => ({
    stateId: String(row.visualStateId).trim(),
    claimRefs: [...new Set((row.claimRefs || []).map((claimRef) => String(claimRef).trim()).filter(Boolean))],
    reference: manifestBindingsByStateId.get(String(row.visualStateId).trim())
  }));
  if (bindings.some((binding) => !binding.reference)) {
    throw new Error("Canary manifest의 productionVisualStateId가 기존 draft 대본의 순서 또는 개수와 일치하지 않습니다.");
  }
  const activeStillReferenceIds = new Set(references
    .filter((reference) => reference.mediaKind !== "video_reference_only")
    .map((reference) => reference.id));
  const assetsByReferenceId = new Map(getCanaryAssets(topic.id)
    .filter((asset) => activeStillReferenceIds.has(asset.referenceId)
      && asset.verified
      && asset.verification?.mediaKind !== "video_reference_only"
      && !String(asset.contentType || "").startsWith("video/"))
    .map((asset) => [asset.referenceId, asset]));
  const supportedClaimIds = new Set((factCheck.claims || [])
    .filter((claim) => claim.status === "SUPPORTED" && claim.useInVideo !== false)
    .map((claim) => String(claim.id)));
  const evidenceById = new Map((factCheck.visualEvidence || [])
    .filter((evidence) => activeStillReferenceIds.has(String(evidence?.id || evidence?.state || "").trim()))
    .map((evidence) => [String(evidence?.id || evidence?.state || "").trim(), evidence]));
  const visualEvidence = [...evidenceById.values()];
  for (const binding of bindings) {
    const { reference } = binding;
    const asset = assetsByReferenceId.get(reference.id);
    if (!asset || asset.sourceUrl !== reference.sourceUrl || asset.mediaUrl !== reference.mediaUrl || asset.referenceType !== reference.referenceType) {
      throw new Error(`Canary manifest binding ${reference.id}의 검증된 정지 reference가 없습니다.`);
    }
    if (evidenceById.has(reference.id)) continue;
    const claimRefs = binding.claimRefs.filter((claimRef) => supportedClaimIds.has(claimRef));
    if (!claimRefs.length) {
      throw new Error(`Canary manifest binding ${reference.id}가 대본 행의 지원된 claimRefs에 연결되지 않습니다.`);
    }
    const manifestEvidence = {
      id: reference.id,
      state: reference.stateHint,
      visibleFacts: [reference.description],
      supportContacts: ["NASA 공식 정지 reference에서 식별 가능한 외부 상태만 사용한다."],
      motionOrFlow: "정지 reference의 확인 가능한 결과 상태이며 새 운동이나 내부 기구를 추론하지 않는다.",
      claimRefs,
      evidence: [`${reference.sourceUrl} — ${reference.description}`],
      referenceType: reference.referenceType,
      referenceSourceUrl: reference.sourceUrl,
      referenceMediaUrl: reference.mediaUrl,
      referencePage: reference.referencePage,
      referenceDescription: reference.description,
      panelCrop: reference.panelCrop,
      focusBounds: reference.focusBounds,
      metadata: reference.metadata
    };
    evidenceById.set(reference.id, manifestEvidence);
    visualEvidence.push(manifestEvidence);
  }
  return { factCheck: { ...factCheck, visualEvidence }, bindings };
}

function buildCanaryDraftScriptFactContractRefresh(topic, factCheck, script) {
  if (topic.runLane !== "production_canary" || !["approved", "draft", "stale"].includes(script?.status)) {
    throw new Error("승인·draft 또는 보존 가능한 stale production canary 대본만 fact contract refresh로 이관할 수 있습니다.");
  }
  const refreshedFactCheck = materializeCanaryManifestVisualEvidence(topic, factCheck, script);
  const brief = buildProductionBriefFromApprovedScript(topic, script);
  brief.visualStates = brief.visualStates.map((state, index) => {
    const reference = refreshedFactCheck.bindings[index].reference;
    const narration = String(script.productionScript[index]?.narration || "");
    const isTwoPanelSequence = reference.metadata?.sequencePresentation === "official_two_panel_explanatory_sequence";
    const assertsPanelOrder = /포트|스타보드|순차|순서/iu.test(narration);
    const bothBoomState = isTwoPanelSequence && !assertsPanelOrder;
    const requiredVisibleElements = bothBoomState
      ? ["NASA 공식 정지 패널에서 확인되는 확장된 양쪽 미드붐", "전개되어 넓어진 차양막"]
      : Array.isArray(reference.metadata?.productionVisibleElements) && reference.metadata.productionVisibleElements.length >= 2
        ? reference.metadata.productionVisibleElements.map((element) => String(element).trim()).filter(Boolean)
        : state.requiredVisibleElements;
    const productionInfoSpec = bothBoomState
      ? normalizeInfoGraphicSpec({ type: "none" }, state.evidenceBeats[0])
      : reference.metadata?.productionInfoSpec
        ? normalizeInfoGraphicSpec(reference.metadata.productionInfoSpec)
        : null;
    const bothBoomContract = bothBoomState ? {
      purpose: "NASA 공식 정지 패널에서 양쪽 미드붐 전개 상태를 확인한다.",
      physicalState: "양쪽 미드붐이 전개된 공식 정지 상태이며, 두 패널 사이의 연속 운동이나 합성 중간 상태는 주장하지 않는다.",
      changeFromPrevious: "커버 해제 뒤 양쪽 미드붐 전개가 확인된 공식 정지 상태로 직접 전환한다."
    } : {};
    return {
      ...state,
      ...bothBoomContract,
      requiredVisibleElements,
      evidenceRefs: [reference.id],
      evidenceBeats: state.evidenceBeats.map((beat) => ({
        ...beat,
        ...bothBoomContract,
        visualFamily: bothBoomState ? "exterior" : beat.visualFamily,
        requiredVisibleElements,
        infoGraphic: productionInfoSpec || beat.infoGraphic,
        cameraMotion: "static hold or crop/scale within the same official reference frame",
        motionPolicy: "first_frame"
      }))
    };
  });
  brief.notes = ["Canary fact_contract_refresh가 기존 대본의 7개 visualStateId와 TTS 범위를 그대로 유지하고 manifest reference만 바인딩했다."];
  return { brief, factCheck: refreshedFactCheck.factCheck, bindings: refreshedFactCheck.bindings };
}

function saveCanaryDraftScriptFactContractRefresh(topic, factCheck, script) {
  const refreshed = buildCanaryDraftScriptFactContractRefresh(topic, factCheck, script);
  const saved = saveProductionBrief(topic, refreshed.factCheck, refreshed.brief, {
    canaryManifestBindings: refreshed.bindings.map(({ stateId, reference }) => ({ stateId, referenceId: reference.id, requiredForClaim: reference.metadata?.requiredForClaim || "" })),
    briefReview: { passed: true, verdict: "PASS", summary: "기존 대본의 상태 ID·개수와 manifest 정지 reference 바인딩을 결정론적으로 검증했습니다.", issues: [] }
  }, "production_canary_fact_contract_refresh");
  const savedStateIds = (saved.visualStates || []).map((state) => state.stateId);
  const scriptStateIds = (script.productionScript || []).map((row) => String(row.visualStateId || "").trim());
  if (saved.status !== "ready" || JSON.stringify(savedStateIds) !== JSON.stringify(scriptStateIds)) {
    throw new Error("Canary fact contract refresh가 기존 대본의 visualStateId 또는 검증 상태를 보존하지 못했습니다.");
  }
  if (script.status !== "approved") {
    db.prepare("UPDATE scripts SET status = 'draft', approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(script.id);
  }
  db.prepare("UPDATE tts_runs SET status = 'generated', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status = 'stale'").run(topic.id);
  return saved;
}

async function ensureProductionBrief(topic, factCheck, rules, jobContext = null) {
  const existing = mapProductionBriefRow(getProductionBriefByTopicStatement.get(topic.id));
  const benchmark = mapBenchmarkCaseRow(getBenchmarkCaseByTopicStatement.get(topic.id));
  const productionRequirements = getConfiguredProductionRequirements(topic);
  if (benchmark?.expectations?.productionBrief) {
    if (existing?.factCheckId === factCheck.id
      && Number(existing.raw?.contractVersion || 0) === PRODUCTION_BRIEF_CONTRACT_VERSION
      && existing.raw?.source === "quality-remediation") return existing;
    const fixtureBrief = normalizeProductionBrief(benchmark.expectations.productionBrief, topic.mainTopic);
    if (existing?.factCheckId === factCheck.id && existing.status === "ready"
      && Number(existing.raw?.contractVersion || 0) === PRODUCTION_BRIEF_CONTRACT_VERSION
      && JSON.stringify(existing.visualStates) === JSON.stringify(fixtureBrief.visualStates)) return existing;
    const saved = await saveReviewedProductionBrief(topic, factCheck, fixtureBrief, benchmark.expectations.productionBrief, `benchmark:${benchmark.caseKey}`, jobContext);
    bindExistingScriptToProductionBrief(topic.id, saved);
    return saved;
  }
  const existingScript = mapScriptRow(getScriptByTopicStatement.get(topic.id));
  if (topic.runLane === "production_canary"
    && existing?.factCheckId === factCheck.id
    && existing.status !== "ready"
    && ["approved", "draft", "stale"].includes(existingScript?.status)
    && (existingScript?.productionScript || []).length >= 2) {
    return saveCanaryDraftScriptFactContractRefresh(topic, factCheck, existingScript);
  }
  if (existing?.factCheckId === factCheck.id
    && existing.status === "ready"
    && Number(existing.raw?.contractVersion || 0) === PRODUCTION_BRIEF_CONTRACT_VERSION) return existing;

  const approvedScript = mapScriptRow(getScriptByTopicStatement.get(topic.id));
  if (approvedScript?.status === "approved" && (approvedScript.productionScript || []).length >= 2) {
    const imported = buildProductionBriefFromApprovedScript(topic, approvedScript);
    const saved = await saveReviewedProductionBrief(topic, factCheck, imported, imported, "approved-script-migration", jobContext);
    bindExistingScriptToProductionBrief(topic.id, saved);
    if (saved.status === "ready") return saved;

    jobContext?.progress(10, "기존 대본의 단면·내부 묘사를 CLEAN과 INFO 역할로 다시 분리합니다.");
    const repairPrompt = `
You are repairing a production brief migrated from an approved Korean engineering short script.
Return the complete repaired production brief JSON only.

Goal:
- Preserve the approved narration scope, causal order, visualState count, stateId values, and claimRefs.
- Make every evidenceBeat usable as a CLEAN first frame: one real camera view, one physical instant, no cutaway, diagram, split screen, transparent shell, arrows, labels, heat colors, force paths, or impossible hidden interior.
- When the narration explains an interior, section, load path, heat, airflow, or hidden mechanism, keep CLEAN grounded in a visible exterior, surface, construction stage, exposed real component, or observable result supported by the claims. Put only the explanatory relationship in infoGraphic.
- Never require an internal, buried, submerged, occluded, or hypothetical element to be visible in an exterior CLEAN.
- A historical construction state may show an exposed component only when the verified evidence supports that construction state. Otherwise use the present exterior and a minimal INFO overlay.
- Do not weaken the topic into a generic beauty shot. Each state must still show a distinct evidence-bearing condition.
- When configured minimumRequiredInfoOverlays is greater than zero, select at least that many distinct supported state/evidence beats with complete, valid non-none infoGraphic and requiresOverlay=true. Set requiresOverlay=true only when CLEAN and the transition alone cannot convey one evidence-supported relationship; never invent facts.
- status must be ready only when every deterministic issue below is resolved.

Configured production requirements:
${JSON.stringify(productionRequirements, null, 2)}

Deterministic issues:
${JSON.stringify(saved.quality?.issues || [], null, 2)}

Migrated brief:
${JSON.stringify(imported, null, 2)}

Approved script rows:
${JSON.stringify(approvedScript.productionScript, null, 2)}

Verified claims and visual evidence:
${JSON.stringify({ claims: factCheck.claims, visualEvidence: factCheck.visualEvidence, unresolved: factCheck.unresolved }, null, 2)}
    `.trim();
    const repairedRaw = await runCodexJson(repairPrompt, `production-brief-repair-${topic.id}`, 360000, {
      signal: jobContext?.signal,
      outputSchema: PRODUCTION_BRIEF_SCAFFOLD_OUTPUT_SCHEMA,
      models: ["gpt-5.6-sol"]
    });
    const repaired = normalizeProductionBrief(repairedRaw, topic.mainTopic);
    const repairedIds = repaired.visualStates.map((state) => state.stateId);
    const importedIds = imported.visualStates.map((state) => state.stateId);
    if (JSON.stringify(repairedIds) !== JSON.stringify(importedIds)) {
      repaired.status = "hold";
      repaired.notes = [...(repaired.notes || []), "승인 대본의 visualState ID 또는 개수를 변경해 자동 이관을 중단했다."];
    }
    const repairedSaved = await saveReviewedProductionBrief(topic, factCheck, repaired, repairedRaw, "approved-script-ai-repair", jobContext);
    bindExistingScriptToProductionBrief(topic.id, repairedSaved);
    return repairedSaved;
  }

  jobContext?.progress(12, "검증된 주장으로 제작 설계서와 시각 상태 계약을 만듭니다.");
  const prompt = `
You are the production architect for a reusable cinematic short-form pipeline.
Create a production brief before any script is written. Return JSON only.

Rules:
- Use only SUPPORTED claims with useInVideo not false.
- Choose the narrative type that the evidence actually supports. Do not force problem/solution.
- A visual state is a distinct evidence-bearing state, event, relationship, or observation, not a new crop, angle, weather, or restatement.
- For an operation, process, failure, or intervention sequence, create a separate atomic visual state whenever object position, boundary condition, support/contact, flow direction, fluid level relationship, or causal role changes. Never place closed and open, before and after, blocked and flowing, or condition and result inside one visual state.
- Keep the states in strict causal order: observable input or approach, decision condition if genuinely visible, intervention or operating state, waiting/constraint state, then result. Do not show a result before the condition or action that produces it.
- A verified visualEvidence item is evidence input, not a limit of one production state per item. You may derive multiple atomic states from its supported claimRefs only when each state is directly supported and introduces no new geometry.
- Every visual state must name exactly one visualEvidence id in evidenceRefs. Normally one evidence item may not be reused. Exception: an official_diagram with at least three explicit visibleFacts may be reused for separately identifiable panels or steps, but every reused state must describe a genuinely different supported physical configuration rather than a crop or camera change. If prose alone mentions several moments without identifiable diagram panels, keep them in one state or return status=hold.
- When the scope explicitly mandates a fixed ordered sequence of distinct official photographs, produce one visual state per listed reference in that exact order, each with a distinct stateId and its own evidenceRefs item. The photos may document the same operating condition from different official viewpoints; identify that fact and do not imply a transition between them.
- Every visual state needs a stable stateId, supported claimRefs, tangible required elements, explicit forbidden mistakes, and exactly one representative evidenceBeat.
- The representative evidenceBeat fixes the minimum visual contract. Additional evidence-bearing shots are expanded only after measured TTS duration is known.
- When a state relies on one static official photo, cameraMotion must be a static hold or crop/scale within that same frame. Do not request parallax, arc movement, a new angle, or synthesized depth without multi-view evidence.
- Do not invent hidden interiors, exact directions, failure consequences, operator screens, dimensions, or mechanisms absent from the evidence.
- Do not require a submerged, occluded, internal, or otherwise invisible component in requiredVisibleElements unless the supplied evidence provides a legitimate external observation, underwater view, or official section that can support its appearance. Use an observable consequence such as an open span or changed flow instead; keep hidden geometry only as a forbidden inference.
- Each future script row must be able to use exactly one visualStateId without changing to another physical state during that row. Create enough states for the verified narration to remain synchronized with the picture.
- When configured minimumRequiredInfoOverlays is greater than zero, select at least that many distinct supported state/evidence beats with complete, valid non-none infoGraphic and requiresOverlay=true. Set requiresOverlay=true only when CLEAN and the transition alone cannot convey one evidence-supported relationship; never invent facts.
- status=hold when the claims cannot support at least two distinct, accurately visualizable states.
- Length is guidance only. Never set hold merely because the explanation is long.
- Keep domain-specific reasoning from the supplied domain rules.

Configured production requirements:
${JSON.stringify(productionRequirements, null, 2)}

Topic:
${JSON.stringify({ id: topic.id, mainTopic: topic.mainTopic, subtopic: topic.subtopic, title: topic.title, hook: topic.hook }, null, 2)}

Verified evidence:
${JSON.stringify({ coreClaim: factCheck.coreClaim, claims: factCheck.claims, visualEvidence: factCheck.visualEvidence, unresolved: factCheck.unresolved, simplifications: factCheck.simplifications }, null, 2)}

Domain rules:
${rules.domainRules}
  `.trim();
  const raw = await runCodexJson(prompt, `production-brief-${topic.id}`, 240000, {
    signal: jobContext?.signal,
    outputSchema: PRODUCTION_BRIEF_SCAFFOLD_OUTPUT_SCHEMA,
    models: ["gpt-5.6-terra", "gpt-5.6-sol"]
  });
  return saveReviewedProductionBrief(topic, factCheck, normalizeProductionBrief(raw, topic.mainTopic), raw, "ai", jobContext);
}

async function reviseProductionBriefFromQualityFeedback(topic, factCheck, brief, jobContext = null, assetQualityFeedback = null) {
  const feedback = assetQualityFeedback?.findings?.length
    ? {
        source: "asset_quality",
        stage: assetQualityFeedback.stage,
        clipIndexes: assetQualityFeedback.clipIndexes || [],
        issues: assetQualityFeedback.findings,
        promptDetails: assetQualityFeedback.promptDetails || [],
        decisionReason: assetQualityFeedback.decisionReason || "",
        repairInstruction: assetQualityFeedback.repairInstruction || ""
      }
    : getLatestStageQualityFeedback(topic.id, "script_quality");
  if (!feedback?.issues?.length) throw new Error("제작 설계서를 수정할 최신 품질 지적이 없습니다.");
  const codexTimeoutMs = assetQualityFeedback?.findings?.length
    ? PRODUCTION_CONTRACT_REVISION_CODEX_TIMEOUT_MS
    : 240000;
  const productionRequirements = getConfiguredProductionRequirements(topic);
  const prompt = `
You are revising the upstream production brief for a Korean cinematic engineering short.
The downstream reviewer proved that the current brief itself is impossible, unsupported, or internally contradictory.
Return the complete corrected production brief JSON only.

Rules:
- Fix every supplied quality issue at the production-contract level. Do not merely repeat an issue in notes.
- Preserve the existing visualState stateId values, count, and causal order.
- Use only SUPPORTED useInVideo claims and supplied visualEvidence. Never invent hidden geometry, contact gaps, exact airflow, pressure distribution, or official references.
- requiredVisibleElements must be directly identifiable in the cited official photo or diagram. Remove occluded or uncertain elements and narrow the evidenceBeat to what the reference can prove.
- A single exterior reference must not prove all sides, all columns, buried members, or unseen contact relationships.
- For wind or fluid states, specify only the approach, contact, direction, and affected surfaces directly supported by claims. Remove post-contact splitting and detailed streamlines unless evidence explicitly supports them.
- CLEAN is one real camera view at one physical instant: no labels, arrows, diagrams, cutaways, transparent shells, split screens, or inferred interiors.
- When configured minimumRequiredInfoOverlays is greater than zero, select at least that many distinct supported state/evidence beats with complete, valid non-none infoGraphic and requiresOverlay=true. Set requiresOverlay=true only when CLEAN and the transition alone cannot convey one evidence-supported relationship; never invent facts.
- status may be ready only when no required element or motion depends on unsupported visual inference.
- The supplied CLEAN correction scope is deterministic: revise only the affected contract states, and make each listed CLEAN prompt materially different in the required physical state or forbidden inference. Do not regenerate an identical prompt.

Configured production requirements:
${JSON.stringify(productionRequirements, null, 2)}

Topic:
${JSON.stringify({ id: topic.id, title: topic.title, hook: topic.hook }, null, 2)}

Verified fact contract:
${JSON.stringify({ coreClaim: factCheck.coreClaim, claims: factCheck.claims, visualEvidence: factCheck.visualEvidence, unresolved: factCheck.unresolved }, null, 2)}

Latest downstream quality feedback:
${JSON.stringify(feedback, null, 2)}

Deterministic CLEAN quality correction scope:
${JSON.stringify(assetQualityFeedback || null, null, 2)}

Current production brief:
${JSON.stringify(brief, null, 2)}
  `.trim();
  jobContext?.progress(14, "최신 검수 지적으로 제작 설계서의 시각 계약을 교정합니다.");
  const raw = await runCodexJson(prompt, `production-brief-quality-revision-${topic.id}`, codexTimeoutMs, {
    signal: jobContext?.signal,
    outputSchema: PRODUCTION_BRIEF_SCAFFOLD_OUTPUT_SCHEMA,
    models: ["gpt-5.6-sol", "gpt-5.6-terra"]
  });
  const revised = normalizeProductionBrief(raw, topic.mainTopic);
  const beforeIds = (brief.visualStates || []).map((state) => state.stateId);
  const revisedIds = (revised.visualStates || []).map((state) => state.stateId);
  if (JSON.stringify(beforeIds) !== JSON.stringify(revisedIds)) {
    throw new Error("제작 설계서 교정이 기존 visualState ID 또는 개수를 바꿔 중단했습니다.");
  }
  const beforeContractHash = buildQualityContractHash({ visualStates: brief.visualStates, scopeStatement: brief.scopeStatement, qualityFeedback: assetQualityFeedback });
  const revisedContractHash = buildQualityContractHash({ visualStates: revised.visualStates, scopeStatement: revised.scopeStatement, qualityFeedback: assetQualityFeedback });
  if (beforeContractHash === revisedContractHash) {
    throw new Error("CLEAN 품질 교정이 제작 계약을 바꾸지 않아 동일 프롬프트 재생성을 중단했습니다.");
  }
  const saved = await saveReviewedProductionBrief(topic, factCheck, revised, raw, "quality-remediation", jobContext);
  return saved;
}

function compactEvidenceText(text, topic, limit = 4600) {
  const cleaned = String(text || "").replace(/\s+/gu, " ").trim();
  if (cleaned.length <= limit) return cleaned;
  const terms = [...new Set(meaningfulTerms(topic.sourceTitle, topic.title, topic.hook))];
  const sentences = cleaned.split(/(?<=[.!?。]|다\.)\s+/u).filter((sentence) => sentence.length >= 30);
  const ranked = sentences.map((sentence, index) => ({
    sentence,
    index,
    score: terms.reduce((score, term) => score + (sentence.toLowerCase().includes(term.toLowerCase()) ? 3 : 0), 0)
      + (/structure|load|wind|force|damp|shell|core|frame|truss|concrete|steel|설계|구조|하중|진동|바람|힘/iu.test(sentence) ? 2 : 0)
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [cleaned.slice(0, 900)];
  let length = selected[0].length;
  for (const item of ranked) {
    if (item.score <= 0 || length + item.sentence.length + 1 > limit) continue;
    selected.push(item.sentence);
    length += item.sentence.length + 1;
  }
  return selected.join(" ").slice(0, limit);
}

function buildCompactProductionCheckPrompt(topic, evidenceSources, replacementSeed = null) {
  const untrustedSeedReferences = Array.isArray(replacementSeed?.references) ? replacementSeed.references : [];
  return `
당신은 한국어 공학 쇼츠의 최종 제작 검증자입니다. 후보를 무조건 살리거나 버리지 말고, 제공된 근거 안에서 가장 흥미롭고 정확한 한 가지 각도를 확정하세요.

판정 절차:
1. 후보의 복합 주장을 영상에 꼭 필요한 원자 주장 2~3개로만 나눕니다.
2. 일반적인 비논쟁 공학 사실은 공식 설계사·기술기관·학술 자료 하나가 핵심 메커니즘을 직접 지지하고, 독립 출처 하나가 대상·장치·적용 조건을 교차 확인하면 충분합니다. 두 출처가 같은 전문 문장을 반복할 필요는 없습니다.
3. 원래 제목의 숫자·비유·인과가 근거와 다르면 그 부분만 제거하고, 같은 대상에서 근거가 확인되는 인접 각도로 revisedTitle과 revisedHook을 고칩니다.
4. 교정된 각도가 구체적 대상, 눈에 보이는 이상한 상태, 단일 메커니즘을 모두 갖고 위의 전문 출처와 독립 출처 조합으로 확인되면 PASS입니다.
5. 수치가 충돌하면 수치를 제목과 핵심 주장에서는 빼고 정성적 메커니즘만 검증합니다. 수치가 메커니즘 자체에 필수일 때만 HOLD입니다.
6. 흥미를 잃은 일반론으로 바꾸지 마세요. revisedTitle은 70자 이하의 구체적인 '이유/방법' 질문이어야 합니다.
7. 근거에 없는 최초·유일·완벽·비밀·의도·효과를 만들지 마세요.
8. sources에는 아래 URL을 글자 그대로 쓰고, 실제 사용한 출처만 넣으세요.
9. PASS는 confidence 75 이상, useInVideo=true인 주장 2개 이상이 모두 SUPPORTED이고 각 주장에 근거가 있을 때만 가능합니다. C01은 독립 출처의 대상·현상 확인, C02는 전문 출처의 메커니즘 확인으로 나눌 수 있습니다.
10. 공식 설계사·운영기관이 자기 프로젝트의 구조나 작동 원리를 직접 설명한 자료는 해당 메커니즘의 1차 전문 근거로 취급합니다. 다만 홍보성 성능 수치나 우월성 주장은 별도 교차 확인 없이는 제외합니다.
11. 공학 PASS에는 이미지와 영상이 추측 없이 묘사할 수 있는 visualEvidence가 최소 2개 필요합니다. 시작/중간/끝 상태, 지지·접촉, 실제 운동 또는 유동을 제공된 근거에서만 추출합니다.
12. visualEvidence의 claimRefs는 SUPPORTED useInVideo 주장만 사용하고 evidence에는 아래 SOURCE URL과 확인 내용을 적습니다.
13. 대상의 원리는 확인됐지만 실제 형상·열림/닫힘·운동 경로가 확인되지 않았다면 PASS하지 말고, 공식 작동 설명이나 도면이 필요하다고 HOLD합니다.
14. replacement 후보의 visualEvidence는 referenceType=official_photo|construction_photo|official_diagram|official_section과 HTTPS 직접 이미지 URL 또는 HTTPS PDF source의 양수 page를 함께 반환하세요. 시작·중간·끝의 외부에서 보이는 상태 3개를 직접 확인하지 못했거나 내부·컷어웨이·수중·유체·기어가 핵심이면 PASS로 만들지 마세요.

[후보]
대상: ${topic.sourceTitle}
원래 제목: ${topic.title}
원래 설명: ${topic.hook}

[근거]
${evidenceSources.map((source, index) => `
SOURCE ${index + 1}
title: ${source.title}
url: ${source.url}
text: ${compactEvidenceText(source.text, topic)}
`).join("\n")}

${untrustedSeedReferences.length ? `[검증 전 replacement media 후보]
아래 URL과 state 라벨은 사용자가 제공한 미검증 입력입니다. URL을 추측하거나 그대로 신뢰하지 말고, 위 근거와 landing page가 실제 대상·상태를 확인할 때만 visualEvidence에 정확히 같은 source/media URL로 반환하세요. 확인하지 못하면 PASS가 아니라 HOLD로 판정하세요.
landing: ${replacementSeed.landingUrl}
${untrustedSeedReferences.map((reference, index) => `REFERENCE ${index + 1}: state=${reference.state}; source=${reference.referenceSourceUrl}; media=${reference.referenceMediaUrl}`).join("\n")}` : ""}

응답 원칙:
- revisedTitle/revisedHook에는 최종적으로 제작 가능한 교정 결과를 적으세요. 교정할 필요가 없으면 원래 문구를 그대로 적으세요.
- coreClaim은 revisedTitle이 약속한 메커니즘만 한 문장으로 적으세요.
- verifiedFacts는 영상에서 직접 쓸 수 있는 사실만 적으세요.
- 설명 없이 JSON 객체 하나만 출력하세요.
`.trim();
}

async function runDiscoveryProductionCheck(topic, jobContext = null, replacementSeed = null) {
  jobContext?.progress(8, "핵심 주장과 맞는 근거를 먼저 수집합니다.");
  const baseDocument = await fetchSourceDocument(topic.sourceUrl);
  const enrichment = await collectEnrichmentSources(topic, baseDocument, null);
  const evidenceSources = [
    ...(isReadableSourceDocument(baseDocument)
      ? [{ title: baseDocument.title || topic.sourceTitle, url: topic.sourceUrl, text: baseDocument.text, score: 35 }]
      : []),
    ...enrichment.sources
  ].filter((source, index, all) => source.text?.length >= 180
    && all.findIndex((item) => normalizeEvidenceUrl(item.url) === normalizeEvidenceUrl(source.url)) === index)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 5);

  const hasProfessionalSource = evidenceSources.some((source) => isPreferredEvidenceUrl(source.url));
  if (evidenceSources.length < 2 || !hasProfessionalSource) {
    const reason = evidenceSources.length < 2
      ? `읽을 수 있는 독립 근거가 ${evidenceSources.length}개뿐입니다.`
      : "공식 설계사·기술기관·학술 출처를 확보하지 못했습니다.";
    recordTopicAttempt(topic.id, "evidence", "SKIP", reason, {
      sourceCount: evidenceSources.length,
      urls: evidenceSources.map((source) => source.url),
      queries: enrichment.queries
    });
    return {
      factCheck: normalizeFactCheckResult({
        status: "HOLD",
        confidence: 0,
        revisedTitle: topic.title,
        revisedHook: topic.hook,
        coreClaim: "검증 가능한 핵심 주장을 확정하지 못했습니다.",
        claims: [], verifiedFacts: [], simplifications: [], sources: [],
        unresolved: [{ item: "독립 근거", issue: reason, needed: "같은 메커니즘을 직접 설명하는 전문 출처와 독립 보조 출처" }],
        verdictReason: reason,
        nextAction: "다른 대상 또는 다른 각도로 교체합니다."
      }),
      rawResult: { skipped: true, reason },
      enrichment
    };
  }

  jobContext?.progress(38, `관련 근거 ${evidenceSources.length}개를 확보해 한 번에 검증합니다.`);
  const rawResult = await runCodexJson(
    buildCompactProductionCheckPrompt(topic, evidenceSources, replacementSeed),
    `fact-check-${topic.id}-production`,
    90000,
    {
      signal: jobContext?.signal,
      onEvent(event) {
        if (event.type === "item.completed") {
          jobContext?.progress(72, "근거가 있는 가장 흥미로운 제작 각도를 확정하고 있습니다.");
        }
      }
    }
  );
  const factCheck = enforceEvidenceScope(normalizeFactCheckResult(rawResult), topic, enrichment, 2);
  if (factCheck.status === "PASS" && !factCheck.sources.some((source) => isPreferredEvidenceUrl(source.url))) {
    factCheck.status = "HOLD";
    factCheck.verdictReason = "사용된 근거에 공식 설계사·기술기관·학술 출처가 포함되지 않았습니다.";
  }
  recordTopicAttempt(topic.id, "production_check", factCheck.status, factCheck.verdictReason, {
    originalTitle: topic.title,
    revisedTitle: factCheck.revisedTitle,
    evidenceCount: evidenceSources.length,
    usedSourceCount: factCheck.sources.length
  });
  return { factCheck, rawResult, enrichment };
}

function normalizeScriptInfoPlan(rows) {
  const candidates = rows.map((row, index) => {
    let infoGraphic = normalizeInfoGraphicSpec(row?.infoGraphic, row);
    const text = `${row?.narration || ""} ${row?.physicalState || ""} ${row?.forceFlow || ""}`;
    if (index === 0) infoGraphic = preserveRequiredInfoGraphic({ type: "none" }, row);
    if (["before_after", "comparison"].includes(infoGraphic.type)) {
      const hasExplicitBaseline = /(이전.{0,30}이후|전후|변화\s*전|변화\s*후|before.{0,30}after|baseline)/iu.test(text);
      if (!hasExplicitBaseline) {
        const supportsFlow = /(열|공기|물|유동|하중|힘|압력|에너지|heat|air|water|flow|load|force|pressure|energy)/iu.test(text);
        infoGraphic = supportsFlow
          ? normalizeInfoGraphicSpec({ ...infoGraphic, type: "flow", comparisonRule: "" }, row)
          : preserveRequiredInfoGraphic({ type: "none" }, row);
      }
    }
    const typeScore = ({ load_path: 6, flow: 5, forbidden_action: 4, sequence: 3, scale_limit: 2, location: 1 }[infoGraphic.type] || 0);
    const importanceScore = row?.importance === "essential" ? 2 : row?.importance === "supporting" ? 1 : 0;
    return { index, infoGraphic, score: typeScore + importanceScore };
  });
  const maximumInfo = Math.max(1, Math.ceil(rows.length * 0.45));
  const requiredInfoCount = candidates.filter((candidate) => candidate.infoGraphic.requiresOverlay && candidate.infoGraphic.type !== "none").length;
  const keep = new Set(candidates
    .filter((candidate) => candidate.infoGraphic.type !== "none")
    .sort((left, right) => Number(right.infoGraphic.requiresOverlay) - Number(left.infoGraphic.requiresOverlay)
      || right.score - left.score || left.index - right.index)
    .slice(0, Math.max(maximumInfo, requiredInfoCount))
    .map((candidate) => candidate.index));
  return rows.map((row, index) => ({
    ...row,
    infoGraphic: keep.has(index)
      ? candidates[index].infoGraphic
      : preserveRequiredInfoGraphic({ type: "none" }, row)
  }));
}

function normalizeScriptResult(result) {
  const rawProductionScript = Array.isArray(result.productionScript) ? result.productionScript.map((row) => ({
    ...row,
    importance: ["essential", "supporting", "extension"].includes(row?.importance) ? row.importance : "essential",
    infoGraphic: normalizeInfoGraphicSpec(row?.infoGraphic, row)
  })) : [];
  const productionScript = normalizeScriptInfoPlan(rawProductionScript);
  return {
    narrativeType: String(result.narrativeType || "problem_solution").trim(),
    narrativeReason: String(result.narrativeReason || "").trim(),
    causalContext: Array.isArray(result.causalContext) ? result.causalContext : [],
    lengthPlan: result.lengthPlan && typeof result.lengthPlan === "object" ? result.lengthPlan : {
      strategy: "content_first",
      recommendedMinSec: 60,
      recommendedMaxSec: 120,
      compressionNotes: []
    },
    signaturePlan: result.signaturePlan && typeof result.signaturePlan === "object" ? result.signaturePlan : {
      problemLineUsed: false,
      pivotLineUsed: false,
      reason: ""
    },
    coreQuestion: String(result.coreQuestion || "").trim() || "핵심 질문 미생성",
    coreConflict: String(result.coreConflict || "").trim() || "핵심 갈등 미생성",
    coreMechanism: String(result.coreMechanism || "").trim() || "핵심 메커니즘 미생성",
    visibleFlow: String(result.visibleFlow || "").trim() || "보이는 흐름 미생성",
    turningPoint: String(result.turningPoint || "").trim() || "전환점 미생성",
    uniqueDifferentiator: String(result.uniqueDifferentiator || "").trim() || "고유 차별점 미생성",
    designIntervention: String(result.designIntervention || "").trim() || "설계 개입 미생성",
    tradeoffs: Array.isArray(result.tradeoffs) ? result.tradeoffs : [],
    limitations: Array.isArray(result.limitations) ? result.limitations : [],
    productionScript,
    ttsText: String(result.ttsText || "").trim(),
    notes: Array.isArray(result.notes) ? result.notes : []
  };
}

function inferInfoGraphicType(row = {}) {
  const text = `${row.beat || ""} ${row.narration || ""} ${row.forceFlow || ""}`;
  if (/직접|금지|밀지|당기지|아니/iu.test(text)) return "forbidden_action";
  if (/전후|이전보다|감소|증가|기울기|변화량/iu.test(text)) return "before_after";
  if (/흐르|이동|빠져|나가|들어가|방향/iu.test(text)) return "flow";
  if (/작은|소량|크게|규모|범위/iu.test(text)) return "scale_limit";
  if (/아래|위치|지점|선택한 곳/iu.test(text)) return "location";
  return "none";
}

function normalizeInfoText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function compactInfoLabel(value, maxLength = 18) {
  let label = normalizeInfoText(value)
    .replace(/\((?:[^()]|\([^()]*\))*\)/gu, "")
    .replace(/같은\s*시간(?:\s*동안)?/gu, "동시간")
    .replace(/같은\s*크기(?:로|의)?/gu, "동일 크기")
    .replace(/반대\s*방향(?:으로|의)?/gu, "반대 방향")
    .replace(/\s*[,;:]\s*/gu, "·")
    .replace(/\s+/gu, " ")
    .trim();
  if ([...label].length <= maxLength) return label;
  const clauses = label.split(/[.!?]|(?:이고|이며|해서|하여|하면서)/u).map((part) => part.trim()).filter(Boolean);
  const concise = clauses.find((part) => [...part].length >= 4 && [...part].length <= maxLength);
  if (concise) return concise;
  return `${[...label].slice(0, maxLength - 1).join("")}…`;
}

function normalizeInfoGraphicSpec(spec, row = {}) {
  const source = spec && typeof spec === "object" ? spec : {};
  const type = normalizeInfoText(source.type || inferInfoGraphicType(row));
  const labels = (Array.isArray(source.labels) ? source.labels : [])
    .map(normalizeInfoText)
    .map((label) => compactInfoLabel(label))
    .filter(Boolean)
    .slice(0, 2);
  const geometryPolicy = source.geometryPolicy === "factual_badge" ? "factual_badge" : "anchored_geometry";
  return {
    type,
    labels: type === "none" ? [] : labels,
    anchors: type === "none" ? [] : (Array.isArray(source.anchors) ? source.anchors : [])
      .map(normalizeInfoText)
      .filter(Boolean)
      .slice(0, 4),
    directionRule: type === "none"
      ? "화살표를 사용하지 않는다."
      : normalizeInfoText(source.directionRule || row.forceFlow || "방향이 없으면 화살표를 사용하지 않는다."),
    comparisonRule: type === "none"
      ? "비교선을 사용하지 않는다."
      : normalizeInfoText(source.comparisonRule || "비교 장면이 아니면 기준선을 만들지 않는다."),
    forbidden: (Array.isArray(source.forbidden) ? source.forbidden : [])
      .map(normalizeInfoText)
      .filter(Boolean),
    requiresOverlay: source.requiresOverlay === true || row.requiresOverlay === true || row.requiresInfo === true,
    geometryPolicy,
    evidenceSourceUrl: geometryPolicy === "factual_badge" ? normalizeInfoText(source.evidenceSourceUrl) : "",
    evidenceStatement: geometryPolicy === "factual_badge" ? normalizeInfoText(source.evidenceStatement) : ""
  };
}

function preserveRequiredInfoGraphic(spec, row = {}) {
  const normalized = normalizeInfoGraphicSpec(spec, row);
  const fallback = normalizeInfoGraphicSpec(row?.infoGraphic, row);
  if (normalized.requiresOverlay && normalized.type === "none" && fallback.type !== "none") {
    return { ...fallback, requiresOverlay: true };
  }
  return normalized;
}

function getInfoGraphicSpecIssues(spec) {
  const issues = [];
  const validTypes = new Set(["forbidden_action", "location", "scale_limit", "flow", "before_after", "load_path", "sequence", "comparison", "none"]);
  if (!validTypes.has(spec?.type)) issues.push("지원하지 않는 오버레이 유형");
  if (spec?.type === "none" && ((spec?.labels || []).length || (spec?.anchors || []).length)) {
    issues.push("INFO 없음 장면에 라벨 또는 앵커가 남아 있음");
  }
  if (spec?.requiresOverlay === true && spec?.type === "none") issues.push("필수 INFO 오버레이를 none으로 바꿀 수 없음");
  if (spec?.type !== "none" && !(spec?.labels || []).length) issues.push("화면에 표시할 짧은 라벨 누락");
  if ((spec?.labels || []).length > 2) issues.push("라벨 2개 초과");
  if ((spec?.labels || []).some((label) => [...String(label)].length > 18)) issues.push("18자를 넘는 문장형 라벨");
  if ((spec?.labels || []).some((label) => /(?:북쪽|남쪽|동쪽|서쪽)/u.test(String(label)))) {
    issues.push("제작용 방위가 시청자 라벨에 노출됨");
  }
  if (spec?.type !== "none" && !(spec?.anchors || []).length) issues.push("실제 구조물 앵커 누락");
  if (spec?.geometryPolicy === "factual_badge") {
    if (!["location", "scale_limit"].includes(spec?.type)) issues.push("사실 배지는 위치 또는 규모 사실에만 사용할 수 있음");
    if ((spec?.labels || []).length !== 1) issues.push("사실 배지는 단일 사실 라벨이 필요함");
    if (!/^https:\/\//iu.test(String(spec?.evidenceSourceUrl || "")) || !String(spec?.evidenceStatement || "").trim()) issues.push("사실 배지의 공식 출처 URL 또는 근거 문장 누락");
  }
  if (["forbidden_action", "flow", "load_path"].includes(spec?.type)) {
    const direction = String(spec?.directionRule || "");
    const hasStart = /에서|시작|출발|from/iu.test(direction);
    const hasEnd = /(?:으로|로|까지|향|도착|끝|to)/iu.test(direction);
    if (!hasStart || !hasEnd) issues.push("화살표 시작점·도착점 방향 규칙 누락");
    if (spec?.type === "forbidden_action" && !/접촉|닿|직전|중단|금지|stop|contact/iu.test(direction)) {
      issues.push("금지 동작의 접촉 전 중단 규칙 누락");
    }
  }
  if (["before_after", "comparison"].includes(spec?.type)) {
    const comparison = String(spec?.comparisonRule || "");
    if (!/기준|baseline/iu.test(comparison) || !/이전|before/iu.test(comparison) || !/이후|after/iu.test(comparison) || !/간격|차이|difference|gap/iu.test(comparison)) {
      issues.push("전후 기준선·이전·이후·간격 규칙 누락");
    }
  }
  return issues;
}

function getInfoNarrativePlanIssues(scenes, { minimumRequiredInfoOverlays = null } = {}) {
  const issues = [];
  const bySegment = new Map();
  const genericLabels = new Set([
    "본체", "탑 본체", "기초", "기초 아래", "지반", "개입 전", "개입 후",
    "작업 위치", "위치", "구조물", "외벽", "탑 외벽", "현재", "이전", "이후",
    "현재 상태", "이전 상태", "결과", "원인", "장치", "시설", "부품", "물", "공기"
  ]);
  let overlayCount = 0;

  for (const scene of scenes || []) {
    const spec = normalizeInfoGraphicSpec(scene.infoGraphic || scene.infoSpec, scene);
    const label = `${scene.sortIndex || `${scene.sourceSegmentIndex}-${scene.sourceSegmentOrder}`}`;
    const specIssues = getInfoGraphicSpecIssues(spec);
    if (specIssues.length) issues.push(`${label}번: ${specIssues.join(", ")}`);
    if (spec.requiresOverlay && spec.type === "none") issues.push(`${label}번: 근거 기반 INFO 필요성 계약이 있는데 none으로 선택됨`);
    if (Number(scene.sourceSegmentIndex) === 1 && spec.type !== "none" && spec.geometryPolicy !== "factual_badge") {
      issues.push(`${label}번: 첫 TTS 구간은 문제와 대상을 영상으로 먼저 보여주고 INFO를 사용하지 않음`);
    }
    if ((spec.labels || []).some((value) => genericLabels.has(String(value).trim()))) {
      issues.push(`${label}번: 화면에 이미 보이는 물체나 상태를 이름표로 반복함`);
    }
    const normalizedAnchors = new Set((spec.anchors || []).map((value) => String(value).replace(/\s/gu, "")));
    if ((spec.labels || []).some((value) => normalizedAnchors.has(String(value).replace(/\s/gu, "")))) {
      issues.push(`${label}번: 라벨이 관계를 설명하지 않고 앵커 물체 이름만 반복함`);
    }
    if (spec.type !== "none") {
      overlayCount += 1;
      const segmentIndex = Number(scene.sourceSegmentIndex || 0);
      bySegment.set(segmentIndex, (bySegment.get(segmentIndex) || 0) + 1);
    }
  }

  for (const [segmentIndex, count] of bySegment) {
    if (count > 1) issues.push(`TTS ${segmentIndex}: INFO 장면이 ${count}개라 핵심 하나로 제한해야 함`);
  }
  const maximumOverlays = Math.max(1, Math.ceil((scenes || []).length * 0.45));
  if (overlayCount > maximumOverlays) {
    issues.push(`전체 INFO 장면이 ${overlayCount}/${scenes.length}개로 과도함. 최대 ${maximumOverlays}개`);
  }
  if (Number.isInteger(minimumRequiredInfoOverlays) && minimumRequiredInfoOverlays > 0 && overlayCount < minimumRequiredInfoOverlays) {
    issues.push(`구성된 제작 요구사항의 INFO 오버레이가 ${overlayCount}/${minimumRequiredInfoOverlays}개입니다.`);
  }
  return issues;
}

function repairAiInfoGraphicSpec(spec, row, forceFlow) {
  let repaired = normalizeInfoGraphicSpec(spec, row);
  const fallback = normalizeInfoGraphicSpec(row?.infoGraphic, row);
  if (repaired.requiresOverlay && repaired.type === "none" && fallback.type !== "none") {
    repaired = { ...fallback, requiresOverlay: true };
  }
  if (repaired.type !== "none") {
    if (!repaired.labels.length) repaired.labels = fallback.labels;
    if (!repaired.anchors.length) repaired.anchors = fallback.anchors;
  }
  if (!repaired.forbidden.length) repaired.forbidden = fallback.forbidden;

  if (["forbidden_action", "flow", "load_path"].includes(repaired.type)) {
    const start = repaired.anchors[0] || "실제 작용 시작점";
    const end = repaired.anchors.at(-1) || "실제 작용 도착점";
    const direction = String(repaired.directionRule || "");
    const hasStart = /에서|시작|출발|from/iu.test(direction);
    const hasEnd = /(?:으로|로|까지|향|도착|끝|to)/iu.test(direction);
    if (!hasStart || !hasEnd) {
      repaired.directionRule = `${start}에서 ${end}까지 이어지는 방향으로 표시한다. ${direction || forceFlow}`.trim();
    }
    if (repaired.type === "forbidden_action" && !/접촉|닿|직전|중단|금지|stop|contact/iu.test(repaired.directionRule)) {
      repaired.directionRule += " 금지 동작은 목표에 닿기 직전에 중단한다.";
    }
  }
  if (["before_after", "comparison"].includes(repaired.type)) {
    const comparison = String(repaired.comparisonRule || "");
    if (!/기준|baseline/iu.test(comparison) || !/이전|before/iu.test(comparison)
      || !/이후|after/iu.test(comparison) || !/간격|차이|difference|gap/iu.test(comparison)) {
      repaired.comparisonRule = `같은 기준선 위에 이전 상태와 이후 상태를 겹쳐 놓고 두 상태의 간격 또는 차이를 표시한다. ${comparison}`.trim();
    }
  }
  return repaired;
}

function normalizeAiShotlistInfoPlan(aiResult) {
  const usedSegments = new Set();
  const scenes = (aiResult?.scenes || []).map((scene) => {
    let infoGraphic = repairAiInfoGraphicSpec(scene.infoGraphic, scene, scene.forceFlow);
    const segmentIndex = Number(scene.sourceSegmentIndex || 0);
    if (infoGraphic.type !== "none" && (segmentIndex === 1 || usedSegments.has(segmentIndex))) {
      infoGraphic = preserveRequiredInfoGraphic({ type: "none" }, scene);
    } else if (infoGraphic.type !== "none") {
      usedSegments.add(segmentIndex);
    }
    return { ...scene, infoGraphic };
  });
  return { ...aiResult, scenes };
}

function validateScriptContract(script, productionBrief = null, requireExactStateSequence = false) {
  const allowedNarratives = new Set(["problem_solution", "design_constraint", "hidden_mechanism", "failure_analysis", "evolution_comparison", "process_breakdown", "chronology_causation", "experiment_explanation"]);
  if (!allowedNarratives.has(script.narrativeType)) {
    throw new Error(`지원하지 않는 서사 유형입니다: ${script.narrativeType}`);
  }
  const minSec = Number(script.lengthPlan?.recommendedMinSec || 0);
  const maxSec = Number(script.lengthPlan?.recommendedMaxSec || 0);
  if (!minSec || !maxSec || minSec > maxSec) {
    throw new Error("대본 권장 길이 범위가 올바르지 않습니다.");
  }

  const narration = script.productionScript.map((row) => String(row.narration || "").trim()).filter(Boolean).join(" ");
  const problemLine = "아~ 어질어질합니다.";
  const pivotLine = "그래서 생각의 판을 완전히 엎었습니다.";
  const problemCount = narration.split(problemLine).length - 1;
  const pivotCount = narration.split(pivotLine).length - 1;
  if (problemCount > 1 || pivotCount > 1) {
    throw new Error("시그니처 전환 문구는 한 영상에서 각각 한 번만 사용할 수 있습니다.");
  }
  if (Boolean(script.signaturePlan?.problemLineUsed) !== (problemCount === 1)) {
    throw new Error("문제 시그니처 사용 계획과 실제 대본이 일치하지 않습니다.");
  }
  if (Boolean(script.signaturePlan?.pivotLineUsed) !== (pivotCount === 1)) {
    throw new Error("반전 시그니처 사용 계획과 실제 대본이 일치하지 않습니다.");
  }
  if (problemCount && !["problem_solution", "design_constraint", "failure_analysis"].includes(script.narrativeType)) {
    throw new Error("실제 문제와 제약이 없는 서사에는 문제 시그니처를 사용할 수 없습니다.");
  }
  if (pivotCount && !["problem_solution", "design_constraint", "hidden_mechanism", "evolution_comparison"].includes(script.narrativeType)) {
    throw new Error("접근을 뒤집는 반전이 없는 서사에는 반전 시그니처를 사용할 수 없습니다.");
  }
  if (script.productionScript.some((row) => !row.infoGraphic?.type || !row.importance)) {
    throw new Error("모든 대본 행에는 중요도와 INFO 그래픽 명세가 필요합니다.");
  }
  if (productionBrief) {
    const visualStates = new Map(productionBrief.visualStates.map((state) => [state.stateId, state]));
    const allowedStateIds = new Set(visualStates.keys());
    const invalidRows = script.productionScript
      .map((row, index) => ({ index: index + 1, stateId: String(row.visualStateId || "").trim() }))
      .filter((row) => !row.stateId || !allowedStateIds.has(row.stateId));
    if (invalidRows.length) {
      throw new Error(`대본이 제작 설계서에 없는 시각 상태를 사용합니다: ${invalidRows.map((row) => `${row.index}번=${row.stateId || "없음"}`).join(", ")}`);
    }
    if (requireExactStateSequence) {
      const expectedStateIds = productionBrief.visualStates.map((state) => String(state.stateId || "").trim());
      const actualStateIds = script.productionScript.map((row) => String(row.visualStateId || "").trim());
      if (JSON.stringify(actualStateIds) !== JSON.stringify(expectedStateIds)) {
        throw new Error(`구성된 시각 상태 계약은 ${expectedStateIds.length}개 stateId를 제작 설계서 순서대로 각각 한 번씩 요구합니다.`);
      }
    }
    for (const row of script.productionScript) {
      const state = visualStates.get(String(row.visualStateId || ""));
      const beat = state?.evidenceBeats?.[0];
      row.infoGraphic = normalizeInfoGraphicSpec({
        ...(row.infoGraphic || { type: "none" }),
        forbidden: [...new Set([
          ...(row.infoGraphic?.forbidden || []),
          ...(state?.forbiddenVisibleElements || []),
          ...(beat?.forbiddenVisibleElements || [])
        ])]
      }, row);
    }
  }
  script.ttsText = narration;
  return script;
}

function getScriptQualityIssues(script, factCheck, productionBrief = null) {
  const issues = [];
  const supportedClaims = new Set((factCheck?.claims || [])
    .filter((claim) => claim.status === "SUPPORTED" && claim.useInVideo !== false)
    .map((claim) => String(claim.id || "").trim())
    .filter(Boolean));
  const rows = script?.productionScript || [];
  const estimatedDurationSec = estimateKoreanTtsDuration(
    rows.map((row) => String(row.narration || "").trim()).filter(Boolean).join(" ")
  );
  const verifiedVisualStateCount = productionBrief?.visualStates?.length
    ? new Set(productionBrief.visualStates.map((state) => String(state.stateId || "").trim()).filter(Boolean)).size
    : new Set((factCheck?.visualEvidence || [])
      .map((evidence) => String(evidence.id || evidence.state || "").trim())
      .filter(Boolean)).size;
  const requiredVisualStateCount = Math.max(2, Math.ceil(estimatedDurationSec / NATIVE_CLIP_DURATION_SEC));
  if (verifiedVisualStateCount < requiredVisualStateCount) {
    issues.push(
      `검증 시각 상태 용량 부족: 예상 ${estimatedDurationSec.toFixed(1)}초 대본을 ${NATIVE_CLIP_DURATION_SEC}초 원본 클립으로 덮으려면 최소 ${requiredVisualStateCount}개의 서로 다른 근거 상태가 필요하지만 ${verifiedVisualStateCount}개만 확인됨. 대본을 줄이거나 사실 검증에서 공식 사진·도면·관찰 상태를 보강할 것`
    );
  }
  if (productionBrief) {
    const allowedStateIds = new Set(productionBrief.visualStates.map((state) => state.stateId));
    for (const [index, row] of rows.entries()) {
      if (!allowedStateIds.has(String(row.visualStateId || ""))) {
        issues.push(`${index + 1}번 대본 행이 제작 설계서에 없는 시각 상태 ${row.visualStateId || "없음"}을 사용함`);
      }
    }
  }
  const firstNarration = String(rows[0]?.narration || "").trim();
  if (!/[?？]|(?:왜|어떻게|무엇|뭘|어디|정말)/u.test(firstNarration)) {
    issues.push("첫 대본 행이 시청자가 바로 이해할 수 있는 질문으로 시작하지 않음");
  }
  for (const [index, row] of rows.entries()) {
    const rowDurationSec = estimateKoreanTtsDuration(String(row.narration || ""));
    if (rowDurationSec > NATIVE_CLIP_DURATION_SEC) {
      issues.push(`${index + 1}번 대본 행이 하나의 검증 시각 상태에 예상 ${rowDurationSec.toFixed(1)}초를 배정함. ${NATIVE_CLIP_DURATION_SEC}초 원본 클립 안에 들도록 압축할 것`);
    }
    const refs = [...new Set((row.claimRefs || []).map((value) => String(value).trim()).filter(Boolean))];
    if (!refs.length) issues.push(`${index + 1}번 대본 행에 검증 주장 연결이 없음`);
    const invalidRefs = refs.filter((value) => !supportedClaims.has(value));
    if (invalidRefs.length) issues.push(`${index + 1}번 대본 행이 미지원 주장 ${invalidRefs.join(", ")}을 사용함`);
    for (const ref of refs) {
      const claim = (factCheck?.claims || []).find((item) => String(item.id || "") === ref);
      const claimText = String(claim?.claim || claim?.statement || claim?.text || "");
      if (/또는|혹은|either|\bor\b/iu.test(claimText) && !/또는|혹은|either|\bor\b/iu.test(String(row.narration || ""))) {
        issues.push(`${index + 1}번 대본 행이 ${ref}의 대안 조건(또는/혹은)을 단일 조건으로 축약함`);
      }
    }
  }
  for (const [index, context] of (script?.causalContext || []).entries()) {
    const invalidRefs = (context.claimRefs || []).filter((value) => !supportedClaims.has(String(value)));
    if (invalidRefs.length) issues.push(`인과 맥락 ${index + 1}이 미지원 주장 ${invalidRefs.join(", ")}을 사용함`);
  }
  const normalizedNarration = rows.map((row) => String(row.narration || "").toLowerCase().replace(/[^0-9a-z가-힣]/gu, ""));
  const duplicateNarration = normalizedNarration.find((value, index) => value && normalizedNarration.indexOf(value) !== index);
  if (duplicateNarration) issues.push("같은 내레이션이 둘 이상의 대본 행에 반복됨");
  const infoCount = rows.filter((row) => row.infoGraphic?.type && row.infoGraphic.type !== "none").length;
  const maximumInfo = Math.max(1, Math.ceil(rows.length * 0.45));
  if (infoCount > maximumInfo) issues.push(`대본 단계 INFO 제안이 ${infoCount}/${rows.length}개로 과도함`);
  const spokenReviewLanguage = rows
    .map((row, index) => ({ index, narration: String(row.narration || "").trim() }))
    .filter(({ narration }) => /단정할 근거|확인(?:되지|되지는|된 바) 않|세부 제원|출처|검증 범위|근거는 아닙니다/u.test(narration));
  for (const { index } of spokenReviewLanguage) {
    issues.push(`${index + 1}번 대본 행에 출처 검수용 메타 언어가 내레이션으로 노출됨. 한계는 시청자가 보게 될 실제 조건만 자연스럽게 말하고 출처 주의는 notes로 옮길 것`);
  }
  const causalRoles = new Set((script?.causalContext || []).map((item) => item.role));
  if (["problem_solution", "failure_analysis"].includes(script?.narrativeType)) {
    if (!["cause", "problem"].some((role) => causalRoles.has(role))) issues.push("문제형 서사에 원인 또는 문제 인과가 없음");
    if (!["intervention", "mechanism"].some((role) => causalRoles.has(role))) issues.push("문제형 서사에 개입 또는 작동 원리가 없음");
    if (!causalRoles.has("result")) issues.push("문제형 서사에 검증된 결과 인과가 없음");
  }
  return issues;
}

async function reviewScriptWithAi(topic, factCheck, script, jobContext, attempt, productionBrief = null, reviewer = {}) {
  const deterministicIssues = getScriptQualityIssues(script, factCheck, productionBrief);
  const prompt = `
  You are the independent quality reviewer for a cinematic engineering short. Review the Korean script below; do not rewrite it.

${buildQualityReviewerContext("script_quality", reviewer)}

Judge meaning, not only JSON formatting:
- Every factual statement must stay inside SUPPORTED claims whose IDs are attached to that segment.
- Detect a misleading title premise, especially words such as always, every, only, or a simplified operating condition.
- The causal chain must be complete enough for the selected narrative type, without inventing missing background.
- The mechanism must be physically visualizable as distinct states. Reject vague beauty-shot directions.
- Judge the opening narration together with the first approved visual state. A hook must be understandable from that state; do not demand that it name a later component or result which the first state cannot show. The opening may ask about the visible starting condition, while later rows establish a supported contrast when those states appear.
- Estimate how many distinct evidence-bearing physical states the supported claims can actually sustain. A new paragraph, camera angle, closer crop, weather change, surface study, or restatement is not a new state.
${topic.runLane === "production_canary" ? "- This canary has an approved fixed sequence of three distinct official photographs. Each approved photo reference is an evidence-bearing scene with one native-clip capacity, including two views that document the same four-tube operating condition. Require their exact order and direct cuts, but do not reject the third photo merely because it is the same operating condition from another official viewpoint or infer a transition between the two views." : ""}
- Duration is a production-contract failure when the narration exceeds one ${NATIVE_CLIP_DURATION_SEC}-second native clip per verified visual state. Reject attempts to cover the excess with repeated crops, camera changes, or unsupported micro-states; require concise narration or more official evidence.
- In construction, launching, lifting, spanning, or moving-heavy-object scenes, every visual direction must preserve the verified supports, bearings, guides, contact points, or temporary support structure. Reject any frame that could read as unsupported floating mass.
- A repair written only in notes does not count. The title premise, narration, physicalState, visualDirection, and forbidden list must themselves implement every relevant correction.
- INFO must default to none and be proposed only when CLEAN/video cannot communicate one essential relationship.
- INFO explains one causal relationship, not a dashboard. If a beat mentions three or more independent inputs, do not squeeze all of them into one overlay with missing labels; select one indispensable relation or set INFO to none.
- Do not invent operator actions, monitoring screens, control-room interfaces, or human observation procedures unless a SUPPORTED claim explicitly describes them. A source saying that factors are considered does not prove how a person views them.
- Signature lines are optional and must follow a real accumulated problem or genuine reversal.
- The narration must sound like a finished documentary, not an internal fact-check report. Source caveats such as "there is no evidence to assert" belong in notes; only audience-relevant operating limits belong in spoken narration.
- A limitations beat is optional. Reject one that merely recites missing evidence, unspecified dimensions, or research scope without changing the viewer's understanding of the mechanism.
- A warning alone may still pass, except repetition, weak_hook, or not_visualizable warnings because those make the finished short unusable. Any error, score below 0.82, unsupported claim, or misleading premise must fail.
- segmentIndex is 1-based for a productionScript row and 0 for a script-wide issue.

Topic:
${JSON.stringify({ title: topic.title, hook: topic.hook, mainTopic: topic.mainTopic, subtopic: topic.subtopic }, null, 2)}

Verified fact scope:
${JSON.stringify({ coreClaim: factCheck.coreClaim, claims: factCheck.claims, visualEvidence: factCheck.visualEvidence, unresolved: factCheck.unresolved, simplifications: factCheck.simplifications }, null, 2)}

Approved production brief and visual-state contract:
${JSON.stringify(productionBrief, null, 2)}

Deterministic issues already found:
${JSON.stringify(deterministicIssues, null, 2)}

Script:
${JSON.stringify(script, null, 2)}
`.trim();
  const review = await runCodexJson(prompt, `script-review-${topic.id}-${attempt}-${reviewer.role || "evidence"}`, 180000, {
    signal: jobContext?.signal,
    outputSchema: SCRIPT_REVIEW_OUTPUT_SCHEMA,
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]
  });
  const errorIssues = (review.issues || []).filter((issue) => issue.severity === "error");
  const blockingWarnings = (review.issues || []).filter((issue) => (
    issue.severity === "warning" && ["repetition", "weak_hook", "not_visualizable"].includes(issue.code)
  ));
  review.passed = Boolean(review.passed
    && Number(review.score || 0) >= 0.82
    && !deterministicIssues.length
    && !errorIssues.length
    && !blockingWarnings.length);
  review.deterministicIssues = deterministicIssues;
  return review;
}

function normalizeScriptCandidateForQuality(script) {
  const text = (value) => String(value || "").trim();
  const textList = (value) => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const normalizeInfoGraphic = (infoGraphic) => ({
    type: text(infoGraphic?.type),
    labels: textList(infoGraphic?.labels),
    anchors: textList(infoGraphic?.anchors),
    directionRule: text(infoGraphic?.directionRule),
    comparisonRule: text(infoGraphic?.comparisonRule),
    forbidden: textList(infoGraphic?.forbidden)
  });
  return {
    narrativeType: text(script?.narrativeType),
    narrativeReason: text(script?.narrativeReason),
    causalContext: (script?.causalContext || []).map((item) => ({
      role: text(item?.role),
      statement: text(item?.statement),
      claimRefs: textList(item?.claimRefs)
    })),
    lengthPlan: {
      strategy: text(script?.lengthPlan?.strategy),
      recommendedMinSec: number(script?.lengthPlan?.recommendedMinSec),
      recommendedMaxSec: number(script?.lengthPlan?.recommendedMaxSec),
      compressionNotes: textList(script?.lengthPlan?.compressionNotes)
    },
    signaturePlan: {
      problemLineUsed: script?.signaturePlan?.problemLineUsed === true,
      pivotLineUsed: script?.signaturePlan?.pivotLineUsed === true,
      reason: text(script?.signaturePlan?.reason)
    },
    coreQuestion: text(script?.coreQuestion),
    coreConflict: text(script?.coreConflict),
    coreMechanism: text(script?.coreMechanism),
    visibleFlow: text(script?.visibleFlow),
    turningPoint: text(script?.turningPoint),
    uniqueDifferentiator: text(script?.uniqueDifferentiator),
    designIntervention: text(script?.designIntervention),
    tradeoffs: textList(script?.tradeoffs),
    limitations: textList(script?.limitations),
    productionScript: (script?.productionScript || []).map((row) => ({
      time: text(row?.time),
      beat: text(row?.beat),
      importance: text(row?.importance),
      visualStateId: text(row?.visualStateId),
      narration: text(row?.narration),
      visualDirection: text(row?.visualDirection),
      physicalState: text(row?.physicalState),
      mechanismStep: text(row?.mechanismStep),
      stateChangeReason: text(row?.stateChangeReason),
      forceFlow: text(row?.forceFlow),
      claimRefs: textList(row?.claimRefs),
      infoGraphic: normalizeInfoGraphic(row?.infoGraphic)
    })),
    ttsText: text(script?.ttsText),
    notes: textList(script?.notes)
  };
}

function buildScriptCandidateHash(script) {
  return buildQualityContractHash(normalizeScriptCandidateForQuality(script));
}

function scriptReviewBinding({ contractHash, factCheckId, productionBriefId, candidateHash }) {
  return {
    contractVersion: SCRIPT_CONTRACT_VERSION,
    contractHash,
    factCheckId: Number(factCheckId),
    productionBriefId: Number(productionBriefId),
    candidateHash
  };
}

function hashScriptReview(review) {
  const { reviewHash, ...content } = review || {};
  return buildQualityContractHash(content);
}

function isCurrentScriptReview(review, binding) {
  return Boolean(review
    && review.reviewHash === hashScriptReview(review)
    && Object.entries(binding).every(([key, value]) => review[key] === value));
}

function filterScriptReviewsForCandidate(reviews, candidateHash, binding = null) {
  return (Array.isArray(reviews) ? reviews : []).filter((review) => review?.candidateHash === candidateHash
    && (!binding || isCurrentScriptReview(review, binding)));
}

function buildScriptUpstreamContractHash(factCheck, productionBrief) {
  const downstreamFeedback = getLatestUpstreamQualityFeedback(factCheck?.topicId, "shotlist_quality");
  const scriptFeedback = getLatestUpstreamQualityFeedback(factCheck?.topicId, "script_quality");
  const benchmarkReset = factCheck?.topicId ? db.prepare(`
    SELECT id, details_json AS detailsJson
    FROM topic_attempts
    WHERE topic_id = ? AND stage = 'benchmark_contract_reset'
    ORDER BY id DESC LIMIT 1
  `).get(factCheck.topicId) : null;
  return buildQualityContractHash({
    scriptContractVersion: SCRIPT_CONTRACT_VERSION,
    factCheckId: factCheck?.id,
    visualEvidence: factCheck?.visualEvidence,
    productionBriefId: productionBrief?.id,
    productionBriefRevision: productionBrief?.revision,
    visualStates: productionBrief?.visualStates,
    downstreamFeedbackSignature: downstreamFeedback?.findingSignature || "",
    scriptFeedbackSignature: scriptFeedback?.findingSignature || "",
    scriptFeedbackAction: scriptFeedback?.action || "",
    benchmarkContractResetId: Number(benchmarkReset?.id || 0),
    benchmarkContractReset: parseStoredJson(benchmarkReset?.detailsJson, {})
  });
}

function getLatestUpstreamQualityFeedback(topicId, stage) {
  if (!topicId) return null;
  const row = db.prepare(`
    SELECT qd.action, qd.reason, qd.finding_signature AS findingSignature,
           qr.score, qr.metrics_json AS metricsJson
    FROM quality_decisions qd
    JOIN quality_runs qr ON qr.id = qd.quality_run_id
    WHERE qd.topic_id = ? AND qd.stage = ?
    ORDER BY qd.id DESC LIMIT 1
  `).get(topicId, stage);
  if (!row || !["revise_upstream_contract", "revise_shared_contract"].includes(row.action)) return null;
  const metrics = parseStoredJson(row.metricsJson, {});
  const issues = Array.isArray(metrics?.details?.issues) ? metrics.details.issues : [];
  return {
    action: row.action,
    reason: row.reason,
    findingSignature: row.findingSignature,
    score: Number(row.score || 0),
    issues: issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      sceneIndexes: issue.sceneIndexes || [],
      message: issue.message,
      repairInstruction: issue.repairInstruction
    }))
  };
}

async function reviewScriptConsensus(topic, factCheck, script, jobContext, attempt, productionBrief = null) {
  const deterministicIssues = getScriptQualityIssues(script, factCheck, productionBrief);
  return runQualityConsensus({
    stage: "script_quality",
    topicId: topic.id,
    contractHash: buildScriptUpstreamContractHash(factCheck, productionBrief),
    jobContext,
    deterministicIssues,
    runReviewer: (reviewer) => reviewScriptWithAi(
      topic,
      factCheck,
      script,
      jobContext,
      attempt,
      productionBrief,
      reviewer
    )
  });
}

async function reviseScriptWithAi(topic, factCheck, script, reviews, jobContext, revisionAttempt, productionBrief = null, revisionOptions = {}) {
  const candidateHash = buildScriptCandidateHash(script);
  const candidateReviews = filterScriptReviewsForCandidate(reviews, candidateHash);
  const stateBoundedTargetedNarrationConstraint = revisionOptions.reviewerTargeted
    && requiresStateBoundedScript(topic, productionBrief)
    ? `- For this reviewer-targeted, state-bounded revision only, when the affected approved rows and claims support it, keep the opening concept as concise as "왜 접었을까요? 페어링 때문입니다." and the final concept as concise as "지상 시험도 5층을 확인했습니다.". Change no other rows or contracts unless the current candidate reviews require it.`
    : "";
  const measuredTtsCompressionConstraint = Array.isArray(revisionOptions.measuredTtsOverruns)
    && revisionOptions.measuredTtsOverruns.length
    ? `- Required measured-TTS repairs: ${revisionOptions.measuredTtsOverruns.map((overrun) => `${Number(overrun.segmentIndex || 0)}번 행 (${Number(overrun.durationSec || 0).toFixed(2)}초)`).join(", ")}. Rewrite every listed row's narration to a different, materially shorter sentence; do not change an unlisted row instead. Keep its approved visualStateId, claims, and physical meaning. A listed row may not retain its current narration.`
    : "";
  const prompt = `
You are revising a Korean cinematic engineering short after an independent evidence and narrative review.
Return the complete corrected script JSON using the required schema.

Rules:
- Correct only what the review identifies, but make every dependent field consistent.
- Use only SUPPORTED useInVideo claims. Never repair a causal gap by inventing a fact.
- If the title premise is broader than the evidence, explicitly narrow the first question and narration to the verified condition.
- Preserve an engaging question, cause/mechanism/result chain, visualizable physical states, and concise spoken Korean.
- Bind the opening narration to the first approved visual state. Do not name or compare a later component or result in the opening unless that same first visualStateId directly shows it. When a requested contrast cannot fit the first evidence state, ask a concise question about the visible starting condition and establish the contrast in the later rows that actually show both sides.
${stateBoundedTargetedNarrationConstraint}
${measuredTtsCompressionConstraint}
- Preserve the essential supported causal chain, but compress each row to ${SCRIPT_STATE_TTS_BUDGET_SEC} estimated TTS seconds or less so measured speech remains inside one ${NATIVE_CLIP_DURATION_SEC}-second native clip. One approved visualStateId maps to one native clip; never lengthen coverage by inventing micro-states, alternate crops, or camera-only variants.
${topic.runLane === "production_canary" ? `- Preserve the approved evidence-backed visualStateIds in their documented order. The configured production requirements are ${JSON.stringify(getConfiguredProductionRequirements(topic))}; do not turn crop-only variants into unsupported physical transitions.` : ""}
- If a deterministic review or measured TTS reports that a row exceeded the native clip duration, do not trust the script's own time estimate. Rewrite that row to a conservative target at least 0.7 seconds below the ${SCRIPT_STATE_TTS_BUDGET_SEC}-second authoring budget, then update time, lengthPlan, ttsText, and notes consistently.
- Duration becomes a production-contract failure when the verified visual states cannot cover it with ${NATIVE_CLIP_DURATION_SEC}-second native clips. Remove nonessential wording before removing a supported causal step.
- Implement every review issue in the actual affected fields. Never merely describe a correction in notes.
- Treat the review list as cumulative only for this exact candidate. A later repair must preserve fixes for every earlier issue and also fix the newest issue.
- When the title or question uses an everyday term but the explanation introduces a technical term, connect them explicitly on first use (for example, "wind creates lateral load"). Do not make the viewer infer that the two terms refer to the same cause.
- For construction, launching, lifting, spanning, or moving-heavy-object scenes, explicitly keep the verified supports, bearings, guides, contact points, or temporary structures visible so the object cannot look unsupported.
- Remove spatial precision such as exact center, side, direction, angle, vector, or distance unless a SUPPORTED claim states it. A verified path from A to B does not prove the local direction through each member.
- If a reviewer flags unsupported directional precision, remove it consistently from narration, physicalState, visualDirection, forceFlow, INFO arrows, required elements, and forbidden elements. Keep only the verified qualitative endpoints or relationship.
- INFO defaults to none. Use at most one essential INFO idea per causal step and never label an object already obvious in CLEAN.
- Do not combine three or more independent inputs into a two-label INFO. Keep one indispensable relationship or set the overlay to none.
- Remove invented dashboards, screens, operator checks, and human procedures unless a SUPPORTED claim explicitly describes them.
- Do not force the two signature lines.
- ttsText must be the productionScript narration joined in order.
- Never put production meta-language such as 화면, 장면, 편집, 검수, 출처, or 자료 in narration.
- Every factual clause in a row must be covered by that row's claimRefs. Do not rely on a claim attached to another row.
- Do not call a pier, foundation, frame, or nearby structure a support unless the verified evidence explicitly establishes that support relationship. Describe only the verified spatial arrangement.
- Do not require submerged or occluded components to be visible in CLEAN without supplied underwater observation or official section evidence. Use observable openings, barriers, water levels, and flow consequences instead.
- Do not introduce 평소, 항상, 보통, 절대 or another frequency/universality term unless a SUPPORTED claim establishes that scope.

Topic:
${JSON.stringify({ title: topic.title, hook: topic.hook }, null, 2)}

Verified scope:
${JSON.stringify({ coreClaim: factCheck.coreClaim, claims: factCheck.claims, visualEvidence: factCheck.visualEvidence, unresolved: factCheck.unresolved, simplifications: factCheck.simplifications }, null, 2)}

Approved production brief. Every productionScript row must use one existing visualStateId exactly:
${JSON.stringify(productionBrief, null, 2)}

Cumulative reviews for this exact candidate, oldest to newest:
${JSON.stringify(candidateReviews, null, 2)}

Current script:
${JSON.stringify(script, null, 2)}
`.trim();
  const revised = await runCodexJson(prompt, `script-revision-${topic.id}-${revisionAttempt}`, 300000, {
    signal: jobContext?.signal,
    outputSchema: SCRIPT_OUTPUT_SCHEMA,
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]
  });
  return validateScriptContract(
    normalizeScriptResult(revised),
    productionBrief,
    requiresStateBoundedScript(topic, productionBrief)
  );
}

async function runScriptQualityLoop(topic, factCheck, initialScript, jobContext, productionBrief = null, onCandidate = null, initialReviews = [], initialBest = null, repairLimit = QUALITY_AUTO_REPAIR_LIMIT, contractHash = buildScriptUpstreamContractHash(factCheck, productionBrief)) {
  let script = initialScript;
  const initialCandidateHash = buildScriptCandidateHash(script);
  const initialBinding = scriptReviewBinding({ contractHash, factCheckId: factCheck.id, productionBriefId: productionBrief?.id, candidateHash: initialCandidateHash });
  let reviews = filterScriptReviewsForCandidate(initialReviews, initialCandidateHash, initialBinding);
  let bestCandidate = initialBest?.candidateHash === initialCandidateHash
    && buildScriptCandidateHash(initialBest.script) === initialCandidateHash
    ? { ...initialBest, reviews: filterScriptReviewsForCandidate(initialBest.reviews, initialCandidateHash, initialBinding) }
    : null;
  const cachedPass = reviews.find((entry) => entry.passed === true);
  if (cachedPass) return { script, reviews, titleOverride: "", reusedReview: true };
  let reviewedTopic = { ...topic };
  let titleOverride = "";
  let review = null;
  let attempt = reviews.length;
  let repairCycle = 0;
  const startedAt = Date.now();
  while (true) {
    const candidateHash = buildScriptCandidateHash(script);
    const binding = scriptReviewBinding({ contractHash, factCheckId: factCheck.id, productionBriefId: productionBrief?.id, candidateHash });
    reviews = filterScriptReviewsForCandidate(reviews, candidateHash, binding);
    const currentPass = reviews.find((entry) => entry.passed === true);
    if (currentPass) {
      review = currentPass;
      break;
    }
    attempt += 1;
    jobContext?.progress(Math.min(94, 68 + (attempt - 1) * 8), `독립 대본 검수 ${attempt}: 근거, 인과관계와 시각화 가능성을 확인합니다.`);
    review = await reviewScriptConsensus(reviewedTopic, factCheck, script, jobContext, attempt, productionBrief);
    Object.assign(review, binding);
    review.reviewHash = hashScriptReview(review);
    reviews.push(review);
    const candidateReviews = filterScriptReviewsForCandidate(reviews, candidateHash, binding);
    if (!bestCandidate || Number(review.score || 0) > Number(bestCandidate.score || 0)) {
      bestCandidate = {
        candidateHash,
        score: Number(review.score || 0),
        script: structuredClone(script),
        reviews: structuredClone(candidateReviews)
      };
    }
    await onCandidate?.(script, candidateReviews, bestCandidate?.candidateHash === candidateHash ? bestCandidate : null);
    if (review.passed) break;
    if (!shouldContinueQualityRepair(review, repairCycle + 1, startedAt, repairLimit, topic.runLane === "production_canary" ? "autoConverge" : "benchmark")) break;
    if (bestCandidate?.script
      && bestCandidate.reviews.length
      && Number(bestCandidate.score || 0) - Number(review.score || 0) >= 0.03
      && bestCandidate.reviews.length < candidateReviews.length) {
      script = structuredClone(bestCandidate.script);
      reviews = filterScriptReviewsForCandidate(bestCandidate.reviews, bestCandidate.candidateHash);
      review = reviews.at(-1);
      jobContext?.progress(Math.min(95, 75 + (attempt - 1) * 8), `검수 점수가 하락해 최고점 후보 ${bestCandidate.score.toFixed(2)}로 되돌립니다.`);
    }
    const revisionCandidateHash = buildScriptCandidateHash(script);
    const revisionReviews = filterScriptReviewsForCandidate(reviews, revisionCandidateHash);
    jobContext?.progress(Math.min(95, 75 + (attempt - 1) * 8), `품질 수렴 판단: ${review.convergence.reason}`);
    script = await reviseScriptWithAi(reviewedTopic, factCheck, script, revisionReviews, jobContext, attempt, productionBrief);
    reviews = [];
    repairCycle += 1;
    const titlePremiseFailed = (review.issues || []).some((issue) => issue.code === "misleading_premise" && issue.severity === "error");
    if (titlePremiseFailed && script.coreQuestion) {
      titleOverride = cleanTitle(String(script.coreQuestion).trim()).slice(0, 100);
      reviewedTopic = { ...reviewedTopic, title: titleOverride };
    }
  }
  if (!review.passed) {
    const reason = [...(review.deterministicIssues || []), ...(review.issues || []).map((issue) => issue.message)].join(" / ");
    throw new Error(`대본 품질 수렴을 중단했습니다 (${review.convergence?.action || "review_failed"}): ${review.convergence?.reason || reason || review.summary}`);
  }
  return { script, reviews: filterScriptReviewsForCandidate(reviews, buildScriptCandidateHash(script)), titleOverride };
}

function reviewStatusFromFactStatus(status) {
  if (status === "PASS") return "verified";
  if (status === "REJECT") return "rejected";
  return "hold";
}

function getLatestStageQualityFeedback(topicId, stage) {
  const run = db.prepare(`
    SELECT id, score, metrics_json AS metricsJson FROM quality_runs
    WHERE topic_id = ? AND stage = ? AND status = 'fail'
    ORDER BY id DESC LIMIT 1
  `).get(topicId, stage);
  if (!run) return null;
  const metrics = parseStoredJson(run.metricsJson, {});
  return {
    runId: Number(run.id),
    score: Number(run.score || 0),
    summary: metrics?.details?.review?.summary || metrics?.details?.summary || "",
    issues: db.prepare(`
      SELECT code, severity, message, repair_instruction AS repairInstruction
      FROM quality_findings WHERE quality_run_id = ? ORDER BY id
    `).all(run.id)
  };
}

function buildFactCheckPrompt({ topic, rules, baseDocument, attempt, previousFactCheck, enrichment, targetVisualEvidenceCount = 2, qualityFeedback = null }) {
  const enrichmentBlock = enrichment?.sources?.length
    ? enrichment.sources.map((source, index) => `
[보강 출처 ${index + 1}]
제목: ${source.title}
URL: ${source.url}
본문 발췌:
${source.text}
`.trim()).join("\n\n")
    : "보강 출처 없음.";
  const canaryAssetBlock = topic.runLane === "production_canary"
    ? JSON.stringify(getCanaryAssets(topic.id).filter((asset) => asset.verified).map((asset) => ({
      id: asset.referenceId, stateHint: asset.stateHint, referenceType: asset.referenceType,
      mediaKind: asset.verification?.mediaKind || "still",
      referenceSourceUrl: asset.sourceUrl, referenceMediaUrl: asset.mediaUrl, referencePage: Number(asset.verification?.referencePage || 0),
      panelCrop: asset.verification?.panelCrop || null, focusBounds: asset.verification?.focusBounds || null, metadata: asset.verification?.metadata || {}, finalUrl: asset.finalUrl
    })), null, 2)
    : "";
  const canaryRequiredCausalIds = topic.runLane === "production_canary"
    ? getCanaryAssets(topic.id)
      .filter((asset) => asset.verified && String(asset.verification?.metadata?.requiredForClaim || "").trim())
      .map((asset) => `${asset.referenceId}:${asset.verification.metadata.requiredForClaim}`)
    : [];
  const canaryScope = getCanaryFactScope(topic);
  const canaryScopeBlock = topic.runLane === "production_canary"
    ? `[Canary 사실 주장 범위]\n허용 범위: ${canaryScope.scope}\n제외할 숨은 메커니즘: ${canaryScope.hiddenMechanismExclusions.join(", ") || "없음"}\n제외 항목은 claim으로 남기더라도 useInVideo=false로 두고, 해당 항목의 미확인을 unresolved 필수 항목으로 요구하지 마세요.\nCanary 사실 교차검증 source: ${canaryScope.factSources.map((source) => source.url).join(", ") || "없음"}\n위 source는 사실 교차검증용이며 Canary 공식 시각 reference allowlist가 아닙니다.`
    : "";

  return `
당신은 시네마틱 쇼츠 제작 파이프라인의 사실 검증 담당자입니다.
아래 주제는 다음 단계인 대본으로 넘어가기 전에 검증해야 합니다.

반드시 지킬 규칙:
- 사실 검증 결과는 PASS, HOLD, REJECT 중 하나입니다.
- 제공된 출처 본문과 보강 출처만으로 핵심 주장을 확인하기 어렵다면 PASS를 주지 말고 HOLD를 주세요.
- sources 배열의 URL은 아래 기본 출처 또는 보강 출처에 적힌 URL을 글자 그대로 사용하세요. 제공되지 않은 URL이나 기억으로 추정한 출처는 절대 추가하지 마세요.
- 2차 PASS는 실제로 제공된 서로 다른 출처 2개 이상이 같은 핵심 주장을 교차 확인할 때만 가능합니다.
- 그중 하나는 정부·대학·학술 논문·공식 설계사·공식 기술기관 같은 권위 있는 1차/전문 출처여야 합니다. 다른 하나는 독립된 보조 출처여도 되지만 같은 메커니즘을 직접 지지해야 합니다.
- 핵심 주장이 틀렸거나, 쇼츠로 만들 때 사실 왜곡이 커지면 REJECT를 주세요.
  - 핵심 주장을 C01, C02처럼 원자 주장으로 분해하고 각각 SUPPORTED, REFUTED, NOT_ENOUGH_INFO로 판정하세요.
  - 이전 검증 결과가 있으면 의미가 같은 주장은 기존 claim id를 그대로 유지하세요. 새 근거가 추가되거나 문장만 다듬어져도 id를 바꾸지 마세요.
  - 기존 claim id를 전혀 다른 주장에 재사용하지 마세요. 정말 새로운 주장에만 기존 최대 번호 다음의 새 id를 부여하세요.
- 문제 해결형으로 풀 수 있는 주제라면 해결책만 검증하지 말고, 왜 문제가 생겼는지 설명하는 원인/발생 배경과 해결 후 결과도 별도 원자 주장으로 검증하세요.
- 원인, 문제, 제약, 개입, 작동 원리, 결과 중 출처가 직접 지지하는 역할을 최대한 연결하되, 근거가 없는 배경을 억지로 채우지 마세요.
- 문제 해결형 근거가 충분하지 않으면 PASS 범위를 숨은 원리형, 설계 제약형, 공정 해부형 등 실제 근거에 맞는 서사로 좁힐 수 있습니다.
- 후보 제목이 넓다면 건축공학 전체를 증명하려 하지 말고, 권위 있는 전문 출처 1개와 독립된 보조 출처가 직접 지지하는 메커니즘 하나로 영상 범위를 좁히세요.
- 영상에서 실제로 사용할 좁은 핵심 주장만 useInVideo=true로 두고, 부수적이거나 근거가 부족한 주장은 useInVideo=false로 제외하세요.
- useInVideo=false인 부수 주장 때문에 PASS를 막지 마세요. useInVideo=true인 핵심 주장 2개 이상이 모두 SUPPORTED이면 해당 좁은 범위로 PASS할 수 있습니다.
- 예를 들어 철근콘크리트라면 휨·전단·균열·부착을 모두 증명할 필요가 없습니다. 한 영상에서 설명할 메커니즘 하나만 선택하세요.
- 영상에 사용할 수치, 단위, 하중 방향, 유동 방향과 인과관계를 해당 주장에 연결하세요.
- 공학 주제는 이야기 원리만 맞아도 PASS하지 마세요. CLEAN 이미지와 I2V가 추측 없이 그릴 수 있도록 최소 두 개의 서로 다른 visualEvidence 상태를 근거로 확인하세요.
- 이번 제작 목표는 서로 다른 visualEvidence ${targetVisualEvidenceCount}개입니다. 제공된 출처가 그만큼을 직접 지지하지 않으면 같은 상태를 쪼개지 말고, 확보한 실제 개수만 반환한 뒤 대본 범위를 줄일 수 있도록 unresolved에 부족한 자료를 적으세요.
- visualEvidence의 개수는 카메라 거리·각도·날씨가 아니라 물리 조건, 작용, 접촉, 변형 또는 결과가 달라질 때만 늘립니다. 같은 열린 상태나 같은 외관을 여러 항목으로 쪼개지 마세요.
- visualEvidence에는 실제로 보이는 형상·재료·열림/닫힘·전후 상태, 물체를 지지하거나 접촉하는 부분, 회전·이동·하중·유동의 시작점과 방향을 적으세요. 출처가 직접 지지하지 않는 내부 구조, 힌지, 축, 베어링, 수중 단면은 만들지 마세요.
- 각 visualEvidence에는 실제 제작 참조를 별도로 판정하세요. 제공된 공식·전문 출처에 사진, 시공 사진, 구조도 또는 단면도가 실제로 있을 때만 referenceType을 official_photo, construction_photo, official_diagram, official_section 중 하나로 정하고, 출처 URL·직접 이미지 URL(제공된 경우)·PDF 페이지 번호·보이는 내용을 적으세요. 본문 설명만 있고 그림이 확인되지 않으면 referenceType=none, referenceSourceUrl="", referenceMediaUrl="", referencePage=0으로 두세요. 제공되지 않은 이미지 URL을 추측하지 마세요.
- 내부·매립·단면 메커니즘을 핵심 CLEAN으로 써야 한다면 해당 상태를 직접 보여주는 공식 도면·단면·시공 사진 참조가 필수입니다. 참조가 없으면 외부 결과 상태로 범위를 좁히거나 HOLD하고 unresolved에 필요한 참조를 적으세요.
- 움직이는 구조물은 시작 상태, 이동 경로, 끝 상태와 지지 관계가 확인되지 않으면 해당 운동을 visualEvidence로 확정하지 말고 unresolved에 필요한 공식 도면·작동 설명을 적으세요.
- visualEvidence의 claimRefs는 반드시 SUPPORTED useInVideo 주장에 연결하고 evidence에는 제공된 출처 URL과 확인 내용을 함께 적으세요.
- 숫자나 단위가 없다는 이유만으로 HOLD 또는 REJECT하지 마세요. 영상에서 수치를 주장할 때만 해당 수치의 근거가 필수입니다.
- 하중 경로, 작동 원리, 구조적 역할처럼 정성적 메커니즘이 서로 다른 신뢰 가능한 출처로 확인되면 수치 없이도 PASS할 수 있습니다.
- 성능이 특정 크기, 속도, 압력, 하중 또는 효율값에 의존하는 주장에 한해서만 검증된 수치와 적용 조건을 요구하세요.
- 핵심 메커니즘에 쓰이는 주장이 모두 SUPPORTED가 아니면 PASS를 주지 마세요.
- 모르는 연도, 수치, 인과관계를 만들지 마세요.
- 2차 검증에서는 1차 HOLD 사유가 보강 출처로 해소됐는지 명확히 판단하세요.
- 2차에서도 부족하면 더 이상 재시도를 유도하지 말고 HOLD 또는 REJECT로 멈추세요.
- 이전 대본 검수에서 제목이나 핵심 조건의 범위 오류가 지적됐다면 아래 품질 피드백을 출처와 대조해 revisedTitle, revisedHook, coreClaim과 해당 원자 주장을 함께 교정하세요. 대본 표현만 고치고 사실 계약의 넓은 전제를 남기지 마세요.
- 응답은 JSON 객체 하나만 출력하세요. 설명 문장, 마크다운, 코드펜스 금지.

[검증 시도]
${attempt}차 검증

[하위 단계 품질 피드백]
${qualityFeedback ? JSON.stringify(qualityFeedback, null, 2) : "없음"}

[검증 게이트 문서]
${rules.factGate}

[도메인 규칙 ${rules.domainFile}]
${rules.domainRules}

[제품 승인 게이트]
${rules.pipelineSpec}

[초기 제작 MD 핵심 규칙]
${rules.workflowExcerpt}

[Canary 공식 시각 reference allowlist]
${canaryAssetBlock || "해당 없음"}
Canary인 경우 visualEvidence의 id, referenceType, referenceSourceUrl, referenceMediaUrl, panelCrop/focusBounds와 metadata는 위 allowlist의 해당 항목을 그대로 사용해야 합니다. mediaKind=video_reference_only인 항목은 전개 순서의 사실·동작 교차검증에만 사용하고 CLEAN 정지 상태 visualEvidence로 반환하지 마세요. allowlist 밖 URL·page·type·crop은 반환하지 말고 HOLD 하세요.
필수 causal reference: ${canaryRequiredCausalIds.join(", ") || "없음"}. 이 목록의 각 still reference는 지정 claimRefs로 visualEvidence에 반드시 포함하세요. 서로 다른 static 상태를 생략하거나 video frame으로 대체하지 마세요.

[후보 주제]
id: ${topic.id}
메인 주제: ${topic.mainTopic}
세부 주제: ${topic.subtopic}
후보 제목: ${topic.title}
후보 설명: ${topic.hook}
출처 제목: ${topic.sourceTitle}
출처 URL: ${topic.sourceUrl}

${canaryScopeBlock}

[기본 출처 본문 발췌]
${baseDocument.text}

  [이전 검증 결과]
  ${previousFactCheck ? JSON.stringify(previousFactCheck, null, 2) : "없음"}

[보강 검색어]
${enrichment?.queries?.length ? enrichment.queries.map((query) => `- ${query}`).join("\n") : "없음"}

${enrichmentBlock}

JSON 스키마:
{
  "status": "PASS | HOLD | REJECT",
  "confidence": 0,
  "revisedTitle": "근거에 맞게 교정한 최종 제목",
  "revisedHook": "근거에 맞게 교정한 최종 설명",
  "coreClaim": "한 문장의 핵심 주장",
  "claims": [
    {
      "id": "C01",
      "statement": "검증할 원자 주장",
      "status": "SUPPORTED | REFUTED | NOT_ENOUGH_INFO",
      "evidence": ["근거 URL과 확인 문장"],
      "useInVideo": true,
      "units": ["검증된 수치와 단위"]
    }
  ],
  "verifiedFacts": [
    { "item": "확인된 사실", "source": "출처명 또는 URL", "reliability": "상/중/하" }
  ],
  "visualEvidence": [
    {
      "id": "V01",
      "state": "화면에 보여줄 검증된 물리 상태",
      "visibleFacts": ["실제로 식별 가능한 형상·재료·상태"],
      "supportContacts": ["지지·접촉·연결 관계"],
      "motionOrFlow": "검증된 운동 또는 유동의 시작점·방향·끝 상태",
      "claimRefs": ["C01"],
      "evidence": ["제공된 출처 URL과 확인 내용"]
    }
  ],
  "unresolved": [
    { "item": "미확인/충돌 항목", "issue": "문제", "needed": "필요한 추가 자료" }
  ],
  "simplifications": [
    "영상에서 단순화해도 되는 점 또는 조심할 점"
  ],
  "sources": [
    { "title": "출처 제목", "url": "출처 URL", "usedFor": "무엇을 확인했는지" }
  ],
  "verdictReason": "판정 이유",
  "nextAction": "다음 액션"
}
`.trim();
}

function saveFactCheck(id, factCheck, rawResult, attempt, enrichment) {
  upsertFactCheckStatement.run(
    id,
    factCheck.status,
    factCheck.confidence,
    factCheck.coreClaim,
    JSON.stringify(factCheck.claims),
    JSON.stringify(factCheck.verifiedFacts),
    JSON.stringify(factCheck.unresolved),
    JSON.stringify(factCheck.simplifications),
    JSON.stringify(factCheck.sources),
    factCheck.verdictReason,
    factCheck.nextAction,
    attempt,
    JSON.stringify(enrichment?.queries || []),
    JSON.stringify((enrichment?.sources || []).map((source) => ({
      title: source.title,
      url: source.url,
      score: source.score
    }))),
    JSON.stringify({ ...rawResult, visualEvidence: factCheck.visualEvidence || [] })
  );
}

async function runSingleFactCheck({ topic, rules, baseDocument, attempt, previousFactCheck = null, enrichment = null, targetVisualEvidenceCount = 2, qualityFeedback = null, jobContext = null }) {
  const prompt = buildFactCheckPrompt({
    topic,
    rules,
    baseDocument,
    attempt,
    previousFactCheck,
    enrichment,
    targetVisualEvidenceCount,
    qualityFeedback
  });

  let completedItems = 0;
  const stageStart = attempt === 1 ? 20 : 68;
  const stageEnd = attempt === 1 ? 48 : 88;
  const rawResult = await runCodexJson(prompt, `fact-check-${topic.id}-attempt-${attempt}`, FACT_CHECK_CODEX_TIMEOUT_MS, {
    signal: jobContext?.signal,
    onEvent(event) {
      if (event.type !== "item.completed") return;
      completedItems += 1;
      const progress = Math.min(stageEnd, stageStart + completedItems * 4);
      jobContext?.progress(progress, `${attempt}차 검증 AI가 근거를 분석하고 있습니다.`);
    }
  });
  const factCheck = enforceEvidenceScope(
    normalizeFactCheckResult(rawResult),
    topic,
    enrichment,
    attempt
  );
  return { factCheck, rawResult };
}

async function runFactCheck(payload, jobContext = null) {
  const id = Number(payload.id);
  const force = Boolean(payload.force);
  const requestedVisualEvidenceCount = Number(payload.targetVisualEvidenceCount || 2);
  const targetVisualEvidenceCount = Number.isFinite(requestedVisualEvidenceCount)
    ? Math.max(2, Math.ceil(requestedVisualEvidenceCount))
    : 2;
  const topic = getTopicStatement.get(id);
  if (!topic) {
    throw new Error("검증할 주제를 찾을 수 없습니다.");
  }

  const existing = mapFactCheckRow(getFactCheckByTopicStatement.get(id));
  const qualityFeedback = payload.remediationRoute === "fact_contract_revision"
    ? getLatestStageQualityFeedback(id, "script_quality")
    : payload.remediationRoute === "visual_reference_enrichment"
      ? getLatestStageQualityFeedback(id, "production_brief")
      : null;
  if (existing?.attempt >= 2 && !force) {
    return getTopicDetailById(id);
  }

  return runTopicOperation(id, "사실 검증", async () => {
    updateTopicReviewStatement.run("checking", "fact_checking", id);
    jobContext?.progress(5, "검증 규칙과 기본 출처를 준비합니다.");
    try {
      if (payload.source === "topic_discovery") {
        if (payload.replacementSeed) {
          jobContext?.progress(10, "제공된 landing page와 직접 media를 실제 preflight합니다.");
          await persistSeedReplacementPreflight(payload, topic);
        }
        const { factCheck, rawResult, enrichment } = await runDiscoveryProductionCheck(topic, jobContext, payload.replacementSeed || null);
        jobContext?.progress(90, "제작 검증 결과와 근거 이력을 저장합니다.");
        saveFactCheck(id, factCheck, rawResult, 2, enrichment);
        if (payload.replacementCandidateLinkId) {
          await updateReplacementCandidateFromFactCheck(payload, topic, factCheck);
        }
        if (factCheck.status === "PASS") {
          const revisedTitle = factCheck.revisedTitle || topic.title;
          const revisedHook = factCheck.revisedHook || topic.hook;
          db.prepare(`
            UPDATE topics
            SET title = ?, hook = ?, review_status = 'verified', lifecycle_status = 'script',
                angle_attempt = angle_attempt + CASE WHEN title != ? OR hook != ? THEN 1 ELSE 0 END,
                evidence_score = ?, last_error = '', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            revisedTitle,
            revisedHook,
            revisedTitle,
            revisedHook,
            Math.min(100, factCheck.confidence),
            id
          );
        } else {
          updateTopicFailureStatement.run(
            "rejected",
            "dropped",
            factCheck.verdictReason,
            id
          );
        }
        jobContext?.progress(98, factCheck.status === "PASS"
          ? "검증과 각도 교정을 통과해 제작 후보에 추가했습니다."
          : "근거가 성립하지 않아 다음 후보로 자동 교체합니다.");
        return getTopicDetailById(id);
      }

      const canaryFactSources = topic.run_lane === "production_canary"
        ? getCanaryFactScope(mapTopicRow(topic)).factSources || []
        : [];
      const [rules, baseDocument, canarySourceDocuments] = await Promise.all([
        loadRuleContext(topic.mainTopic),
        fetchSourceDocument(topic.sourceUrl),
        Promise.all(canaryFactSources
          .filter((source) => source?.url && source.url !== topic.source_url)
          .map(async (source) => {
            const document = await fetchSourceDocument(source.url);
            return isReadableSourceDocument(document)
              ? { title: source.title || document.title || source.url, url: source.url, text: document.text, score: 1000 }
              : null;
          }))
      ]);
      const manifestEnrichment = {
        queries: canaryFactSources.map((source) => source.url).filter(Boolean),
        sources: canarySourceDocuments.filter(Boolean)
      };
      const baseReadable = isReadableSourceDocument(baseDocument);
      jobContext?.progress(15, baseReadable
        ? "기본 출처와 등록된 canary 교차검증 출처를 읽었습니다."
        : "기본 출처가 차단되어 공식·전문 출처 보강 경로로 전환합니다.");
      const first = baseReadable
        ? await runSingleFactCheck({
          topic,
          rules,
          baseDocument,
          attempt: 1,
          previousFactCheck: force ? existing : null,
          enrichment: manifestEnrichment.sources.length ? manifestEnrichment : null,
          targetVisualEvidenceCount,
          qualityFeedback,
          jobContext
          })
        : {
            factCheck: normalizeFactCheckResult({
              status: "HOLD",
              confidence: 0,
              revisedTitle: topic.title,
              revisedHook: topic.hook,
              coreClaim: "기본 출처를 읽지 못해 공식 보강 출처가 필요합니다.",
              claims: [],
              verifiedFacts: [],
              unresolved: [{
                item: "기본 출처 본문",
                issue: String(baseDocument.text || "본문 없음"),
                needed: "같은 메커니즘을 직접 설명하는 공식·전문 출처"
              }],
              simplifications: [],
              sources: [],
              verdictReason: "기본 출처 수집 실패로 1차 판정을 보류합니다.",
              nextAction: "공식·전문 출처를 검색해 2차 검증합니다."
            }),
            rawResult: { skipped: true, reason: "base_source_unreadable" }
          };
      if (first.factCheck.status === "PASS" && !isPreferredEvidenceUrl(topic.sourceUrl)) {
        first.factCheck.status = "HOLD";
        first.factCheck.unresolved = [
          ...first.factCheck.unresolved,
          {
            item: "독립된 공신력 출처",
            issue: "기본 출처만으로 PASS를 확정할 수 없습니다.",
            needed: "공공기관, 공식 기록 또는 전문 백과의 교차 확인"
          }
        ];
        first.factCheck.nextAction = "공신력 있는 독립 출처를 보강해 2차 검증합니다.";
      }

      let finalFactCheck = first.factCheck;
      let finalRawResult = first.rawResult;
      let finalAttempt = 1;
      let enrichment = null;

      if (first.factCheck.status === "HOLD") {
        jobContext?.progress(52, "1차 검증이 보류되어 독립 출처를 보강 검색합니다.");
        enrichment = await collectEnrichmentSources(topic, baseDocument, first.factCheck);
        if (enrichment.sources.length) {
          jobContext?.progress(64, `보강 출처 ${enrichment.sources.length}개를 확보했습니다.`);
          const second = await runSingleFactCheck({
            topic,
            rules,
            baseDocument,
            attempt: 2,
            previousFactCheck: first.factCheck,
            enrichment,
            targetVisualEvidenceCount,
            qualityFeedback,
            jobContext
          });
          finalFactCheck = second.factCheck;
          finalRawResult = {
            firstAttempt: first.rawResult,
            secondAttempt: second.rawResult
          };
          finalAttempt = 2;
        } else {
          finalFactCheck.nextAction = "1차 HOLD 이후 보강 출처를 찾지 못해 자동 검증을 중단합니다.";
          finalAttempt = 2;
        }
      }

      jobContext?.progress(92, "검증 결과와 출처를 저장합니다.");
      const visualReferenceHold = payload.remediationRoute === "visual_reference_enrichment"
        && finalFactCheck.status === "HOLD"
        && /(시각|CLEAN|도면|단면|사진|참조)/u.test(`${finalFactCheck.verdictReason} ${finalFactCheck.nextAction}`);
      const exhaustedHold = finalAttempt >= 2 && finalFactCheck.status === "HOLD" && !visualReferenceHold;
      if (exhaustedHold) {
        finalFactCheck.nextAction = "보강 검색과 2차 검증까지 근거가 부족해 제작 후보에서 자동 폐기했습니다.";
      } else if (visualReferenceHold) {
        finalFactCheck.nextAction = "사실 주장은 유지하되 공식 사진·도면·단면 참조가 확보될 때까지 제작을 잠급니다.";
      }
      const currentScript = payload.remediationRoute === "fact_contract_revision"
        ? mapScriptRow(getScriptByTopicStatement.get(id))
        : null;
      if (currentScript) {
        const scriptedClaimRefs = new Set([
          ...(currentScript.productionScript || []).flatMap((row) => row.claimRefs || []),
          ...(currentScript.causalContext || []).flatMap((step) => step.claimRefs || [])
        ].map(String));
        finalFactCheck.claims = (finalFactCheck.claims || []).map((claim) => (
          scriptedClaimRefs.has(String(claim.id)) && claim.status === "SUPPORTED"
            ? { ...claim, useInVideo: true }
            : claim
        ));
        if (topic.runLane === "production_canary" && currentScript.productionScript?.length) {
          finalFactCheck = materializeCanaryManifestVisualEvidence(topic, finalFactCheck, currentScript).factCheck;
        }
      }
      if (topic.runLane === "production_canary") {
        const allowlist = canaryFactAllowlistResult(topic, finalFactCheck);
        if (!allowlist.passed) {
          finalFactCheck.status = "HOLD";
          const outOfScopeClaims = allowlist.outOfScopeClaims || [];
          finalFactCheck.unresolved = [...(finalFactCheck.unresolved || []), {
            item: outOfScopeClaims.length ? "Canary manifest scope" : "official visual evidence allowlist",
            issue: outOfScopeClaims.length
              ? `제외된 숨은 메커니즘을 useInVideo=true로 반환했습니다: ${outOfScopeClaims.map((claim) => claim.id || claim.statement).join(", ")}`
              : `허용되지 않은 reference 또는 상태 수 부족: ${allowlist.invalid.map((entry) => entry.id || entry.state).join(", ") || "claim/state minimum"}`,
            needed: outOfScopeClaims.length
              ? "manifest scope 밖 주장은 useInVideo=false로 제외"
              : `preflight가 검증한 reference만 사용: ${allowlist.allowedReferenceIds.join(", ")}`
          }];
          finalFactCheck.verdictReason = outOfScopeClaims.length
            ? "Canary fact 결과에 manifest scope 밖 useInVideo claim이 있어 HOLD입니다."
            : "Canary fact 결과가 preflight official visual allowlist를 벗어나 HOLD입니다.";
          finalFactCheck.nextAction = outOfScopeClaims.length
            ? "제외된 숨은 메커니즘 주장을 영상 범위에서 제거한 뒤 사실 검증을 다시 실행하세요."
            : "검증된 NASA reference ID와 URL만 사용해 사실 검증을 다시 실행하세요.";
          finalRawResult = { ...finalRawResult, canaryAllowlist: allowlist };
        }
      }
      saveFactCheck(id, finalFactCheck, finalRawResult, finalAttempt, enrichment);
      if (payload.remediationRoute === "source_enrichment") {
        const verifiedVisualEvidenceCount = finalFactCheck.visualEvidence.length;
        const evidenceShortfall = verifiedVisualEvidenceCount < targetVisualEvidenceCount;
        recordTopicAttempt(
          id,
          "source_enrichment",
          evidenceShortfall ? "failed" : "completed",
          evidenceShortfall
            ? `보강 사실 검증이 목표 ${targetVisualEvidenceCount}개 중 ${verifiedVisualEvidenceCount}개의 검증 시각 근거만 확보했습니다.`
            : `보강 사실 검증이 목표 ${targetVisualEvidenceCount}개의 검증 시각 근거를 확보했습니다.`,
          {
            minimumCoverageCount: targetVisualEvidenceCount,
            verifiedVisualEvidenceCount,
            targetDurationSec: verifiedVisualEvidenceCount * SCRIPT_STATE_TTS_BUDGET_SEC
          }
        );
      }
      const visualContractChanged = existing && finalFactCheck.status === "PASS"
        && JSON.stringify(existing.visualEvidence || []) !== JSON.stringify(finalFactCheck.visualEvidence || []);
      if (visualContractChanged) {
        recordTopicAttempt(id, "benchmark_contract_reset", "ready", "사실 검증의 시각 근거 계약이 변경되어 이전 품질 실패 상한을 새 계약 기준으로 초기화합니다.", {
          source: payload.source || "fact_check",
          previousVisualEvidenceCount: existing.visualEvidence?.length || 0,
          visualEvidenceCount: finalFactCheck.visualEvidence?.length || 0
        });
      }
      if (finalFactCheck.status === "PASS") {
        const revisedTitle = finalFactCheck.revisedTitle || topic.title;
        const revisedHook = finalFactCheck.revisedHook || topic.hook;
        db.prepare(`
          UPDATE topics
          SET title = ?, hook = ?, evidence_score = ?,
              angle_attempt = angle_attempt + CASE WHEN title != ? OR hook != ? THEN 1 ELSE 0 END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          revisedTitle,
          revisedHook,
          Math.min(100, finalFactCheck.confidence),
          revisedTitle,
          revisedHook,
          id
        );
      }
      if (existing) {
        const approvedScript = mapScriptRow(getScriptByTopicStatement.get(id));
        const usedClaimRefs = new Set([
          ...(approvedScript?.productionScript || []).flatMap((row) => row.claimRefs || []),
          ...(approvedScript?.causalContext || []).flatMap((step) => step.claimRefs || [])
        ].map((value) => String(value)));
        const narrativeFingerprint = (factCheck) => JSON.stringify({
          status: factCheck?.status,
          claims: (factCheck?.claims || [])
            .filter((claim) => !usedClaimRefs.size || usedClaimRefs.has(String(claim.id)))
            .map((claim) => ({
              id: claim.id,
              status: claim.status,
              useInVideo: claim.useInVideo
            }))
        });
        const narrativeChanged = narrativeFingerprint(existing) !== narrativeFingerprint(finalFactCheck);
        const preservesScriptContract = payload.remediationRoute === "fact_contract_revision"
          && [...usedClaimRefs].every((claimRef) => (finalFactCheck.claims || []).some((claim) => (
            String(claim.id) === claimRef && claim.status === "SUPPORTED" && claim.useInVideo !== false
          )));
        const scriptContractChanged = narrativeChanged && !preservesScriptContract;
        db.prepare("UPDATE production_briefs SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'").run(id);
        if (scriptContractChanged) {
          db.prepare("UPDATE scripts SET status = 'stale', approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE topic_id = ?").run(id);
          db.prepare("UPDATE tts_runs SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'").run(id);
        } else if (preservesScriptContract) {
          db.prepare("UPDATE scripts SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status = 'stale'").run(id);
          db.prepare("UPDATE tts_runs SET status = 'generated', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status = 'stale'").run(id);
        }
        db.prepare("UPDATE shotlists SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'").run(id);
        recordTopicAttempt(id, "fact_check_impact", scriptContractChanged ? "stale" : "visual_only", scriptContractChanged
          ? "대본이 사용하는 주장 범위가 바뀌어 대본과 TTS를 다시 승인해야 합니다."
          : "대본 주장 범위는 유지되고 시각 근거만 보강되어 제작 설계서와 장면표만 갱신합니다.", {
          narrativeChanged: scriptContractChanged,
          visualEvidenceCount: finalFactCheck.visualEvidence?.length || 0
        });
      }
      const reviewStatus = exhaustedHold ? "rejected" : reviewStatusFromFactStatus(finalFactCheck.status);
      const lifecycleStatus = finalFactCheck.status === "PASS"
        ? "script"
        : finalFactCheck.status === "REJECT" || exhaustedHold ? "dropped" : "fact_checking";
      updateTopicReviewStatement.run(reviewStatus, lifecycleStatus, id);
      jobContext?.progress(98, `${finalFactCheck.status} 판정과 후속 단계 상태를 반영했습니다.`);
      return getTopicDetailById(id);
    } catch (error) {
      updateTopicFailureStatement.run(
        existing ? reviewStatusFromFactStatus(existing.status) : "prechecked",
        existing?.status === "PASS" ? "script" : existing?.status === "REJECT" ? "dropped" : "candidate",
        String(error.message || error).slice(0, 1000),
        id
      );
      throw error;
    }
  });
}

function isOfficialCanaryUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && OFFICIAL_CANARY_HOST_SUFFIXES.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function normalizeNormalizedBounds(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bounds = value.map(Number);
  const [x, y, width, height] = bounds;
  if (!bounds.every((part) => Number.isFinite(part) && part >= 0 && part <= 1) || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return null;
  return bounds;
}

function normalizeCanaryReference(reference = {}) {
  const metadata = reference.metadata && typeof reference.metadata === "object" ? reference.metadata : {};
  return {
    id: String(reference.id || "").trim(),
    stateHint: String(reference.stateHint || "").trim(),
    referenceType: String(reference.referenceType || "").trim(),
    sourceUrl: String(reference.sourceUrl || "").trim(),
    mediaUrl: String(reference.mediaUrl || "").trim(),
    referencePage: Number(reference.referencePage || 0),
    description: String(reference.description || "").trim(),
    licenseUrl: String(reference.licenseUrl || "").trim(),
    licenseNote: String(reference.licenseNote || "").trim(),
    mediaKind: String(reference.mediaKind || "still").trim(),
    requiresSection: Boolean(reference.requiresSection),
    panelCropProvided: reference.panelCrop != null || metadata.panelCrop != null,
    focusBoundsProvided: reference.focusBounds != null || metadata.focusBounds != null,
    panelCrop: normalizeNormalizedBounds(reference.panelCrop || metadata.panelCrop),
    focusBounds: normalizeNormalizedBounds(reference.focusBounds || metadata.focusBounds),
    metadata
  };
}

function normalizeProductionRequirements(value = {}) {
  const requirements = value && typeof value === "object" ? value : {};
  const min = Number(requirements.minimumVisualStates);
  const range = Array.isArray(requirements.targetVisualStateRange) ? requirements.targetVisualStateRange.map(Number) : [];
  const overlays = Number(requirements.minimumRequiredInfoOverlays);
  return {
    minimumVisualStates: Number.isInteger(min) && min > 0 ? min : null,
    targetVisualStateRange: range.length === 2 && range.every((part) => Number.isInteger(part) && part > 0) && range[0] <= range[1] ? range : null,
    minimumRequiredInfoOverlays: Number.isInteger(overlays) && overlays >= 0 ? overlays : null
  };
}

function getConfiguredProductionRequirements(topic = {}) {
  const candidate = topic.candidate || parseStoredJson(topic.candidateJson, {});
  const source = candidate.productionRequirements || candidate.manifest?.productionRequirements || getCanaryFactScope(topic).productionRequirements || {};
  return normalizeProductionRequirements(source);
}

function loadProductionCanaryManifest(externalKey = "") {
  if (!existsSync(PRODUCTION_CANARY_DIR)) throw new Error("production canary manifest 디렉터리가 없습니다.");
  const manifests = readdirSync(PRODUCTION_CANARY_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, manifest: JSON.parse(readFileSync(path.join(PRODUCTION_CANARY_DIR, name), "utf8")) }));
  const requested = String(externalKey || "production-canary:nasa-jwst-sunshield:v1").trim();
  const selected = manifests.find((entry) => entry.manifest.externalKey === requested);
  if (!selected) throw new Error("요청한 production canary manifest를 찾을 수 없습니다.");
  const manifest = selected.manifest;
  const references = (manifest.officialVisualReferences || []).map(normalizeCanaryReference);
  const productionRequirements = normalizeProductionRequirements(manifest.productionRequirements);
  const errors = [];
  if (manifest.runLane !== "production_canary" || !String(manifest.externalKey || "").startsWith("production-canary:")) errors.push("production_canary lane의 stable externalKey가 필요합니다.");
  if (references.length < 3) errors.push("공식 시각 자료는 최소 3개가 필요합니다.");
  if (new Set(references.map((reference) => reference.id)).size !== references.length || references.some((reference) => !reference.id)) errors.push("공식 reference ID가 비어 있거나 중복됩니다.");
  if (references.some((reference) => !["official_photo", "construction_photo", "official_diagram", "official_section", "official_motion_reference"].includes(reference.referenceType))) errors.push("허용되지 않은 official reference type이 있습니다.");
  if (references.some((reference) => !isOfficialCanaryUrl(reference.sourceUrl) || (!isOfficialCanaryUrl(reference.mediaUrl) && !(reference.referencePage > 0 && /\.pdf(?:$|[?#])/iu.test(reference.sourceUrl))))) errors.push("NASA 공식 HTTPS source/media 또는 PDF page만 사용할 수 있습니다.");
  if (references.some((reference) => !isOfficialCanaryUrl(reference.licenseUrl) || !reference.licenseNote || !reference.description)) errors.push("각 official reference에 NASA license 근거와 설명이 필요합니다.");
  if (references.some((reference) => (reference.panelCropProvided && !reference.panelCrop) || (reference.focusBoundsProvided && !reference.focusBounds))) errors.push("official reference panel crop은 정규화된 [x,y,width,height]여야 합니다.");
  const stillStateCount = new Set(references.filter((reference) => reference.mediaKind !== "video_reference_only").map((reference) => reference.stateHint)).size;
  const requiredStateCount = productionRequirements.minimumVisualStates || 2;
  if (stillStateCount < requiredStateCount) errors.push(`CLEAN에 사용할 서로 다른 시각 상태가 ${requiredStateCount}개 필요합니다.`);
  if (manifest.productionRequirements && (!productionRequirements.minimumVisualStates || !productionRequirements.targetVisualStateRange || productionRequirements.minimumRequiredInfoOverlays === null)) errors.push("productionRequirements 형식이 유효하지 않습니다.");
  if (errors.length) throw new Error(`Canary manifest 오류: ${errors.join(" / ")}`);
  return { name: selected.name, manifest, references, productionRequirements };
}

function detectOfficialMedia(buffer, declaredContentType = "") {
  const declared = String(declaredContentType || "").split(";")[0].trim().toLowerCase();
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { contentType: "image/png", extension: "png", kind: "image" };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { contentType: "image/jpeg", extension: "jpg", kind: "image" };
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return { contentType: "application/pdf", extension: "pdf", kind: "pdf" };
  if (/^video\//u.test(declared)) return { contentType: declared, extension: "mp4", kind: "video" };
  return null;
}

async function verifyOfficialCanaryReference(reference) {
  const targetUrl = reference.mediaUrl || reference.sourceUrl;
  const response = await fetch(targetUrl, {
    signal: AbortSignal.timeout(30000),
    headers: { "User-Agent": "cinematic-shorts-dashboard/0.1 production canary preflight", ...(reference.mediaKind === "video_reference_only" ? { Range: "bytes=0-65535" } : {}) }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!isOfficialCanaryUrl(response.url || targetUrl)) throw new Error("redirect final URL이 NASA allowlist 밖입니다.");
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > 25 * 1024 * 1024 && reference.mediaKind !== "video_reference_only") throw new Error("media가 25MB 제한을 넘습니다.");
  if (reference.mediaKind === "video_reference_only" && declaredLength > 25 * 1024 * 1024) {
    const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^video\//u.test(contentType)) throw new Error("video reference content type 검증에 실패했습니다.");
    const hash = createHash("sha256").update(`${response.url || targetUrl}:${declaredLength}:${contentType}`).digest("hex");
    const cacheDir = path.join(CANARY_ASSET_CACHE_DIR, hash.slice(0, 16));
    await mkdir(cacheDir, { recursive: true });
    const cachedPath = path.join(cacheDir, `${reference.id.replace(/[^0-9a-z_-]/giu, "_")}.metadata.json`);
    await writeFile(cachedPath, JSON.stringify({ finalUrl: response.url || targetUrl, contentType, declaredLength, rangeRequest: true }, null, 2), "utf8");
    return { referenceId: reference.id, verified: true, finalUrl: response.url || targetUrl, contentType, byteSize: declaredLength, sha256: hash, cachedPath: toRelativeWorkspacePath(cachedPath), status: "verified", verification: { mediaKind: "video_reference_only", referencePage: reference.referencePage, metadataOnly: true, verifiedAt: new Date().toISOString() } };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 25 * 1024 * 1024) throw new Error("media가 25MB 제한을 넘습니다.");
  const media = detectOfficialMedia(buffer, response.headers.get("content-type"));
  if (!media || (reference.mediaKind !== "video_reference_only" && media.kind === "video")) throw new Error("image/PDF signature 또는 content type 검증에 실패했습니다.");
  const hash = createHash("sha256").update(buffer).digest("hex");
  const cacheDir = path.join(CANARY_ASSET_CACHE_DIR, hash.slice(0, 16));
  await mkdir(cacheDir, { recursive: true });
  const sourcePath = path.join(cacheDir, `${reference.id.replace(/[^0-9a-z_-]/giu, "_")}.${media.extension}`);
  await writeFile(sourcePath, buffer);
  let cachedPath = sourcePath;
  if (media.kind === "image") {
    const decodedPath = `${sourcePath}.decoded.png`;
    await runProcess(PDF_PYTHON_BIN, [REFERENCE_IMAGE_RUNNER, sourcePath, decodedPath], { timeoutMs: 120000, env: { PYTHONIOENCODING: "utf-8" } });
    if (!existsSync(decodedPath) || (await stat(decodedPath)).size < 100) throw new Error("image decode 검증에 실패했습니다.");
    cachedPath = decodedPath;
  } else if (media.kind === "pdf") {
    if (!reference.referencePage) throw new Error("PDF referencePage가 필요합니다.");
    const outputPrefix = `${sourcePath}-page-${reference.referencePage}`;
    await runProcess(PDFTOPPM_BIN, ["-f", String(reference.referencePage), "-l", String(reference.referencePage), "-singlefile", "-png", "-r", "130", sourcePath, outputPrefix], { timeoutMs: 120000 });
    const renderedPath = `${outputPrefix}.png`;
    if (!existsSync(renderedPath) || (await stat(renderedPath)).size < 100) throw new Error("PDF page render 검증에 실패했습니다.");
    cachedPath = renderedPath;
  }
  return { referenceId: reference.id, verified: true, finalUrl: response.url || targetUrl, contentType: media.contentType, byteSize: buffer.length, sha256: hash, cachedPath: toRelativeWorkspacePath(cachedPath), status: "verified", verification: { mediaKind: media.kind, referencePage: reference.referencePage, verifiedAt: new Date().toISOString() } };
}

function getCanaryAssets(topicId) {
  const rows = db.prepare(`
    SELECT reference_id AS referenceId, state_hint AS stateHint, reference_type AS referenceType,
      source_url AS sourceUrl, media_url AS mediaUrl, final_url AS finalUrl, content_type AS contentType,
      byte_size AS byteSize, sha256, cached_path AS cachedPath, license_url AS licenseUrl,
      license_note AS licenseNote, status, verification_json AS verificationJson, id
    FROM official_visual_assets WHERE topic_id = ? ORDER BY id DESC
  `).all(topicId);
  const latest = new Map();
  for (const row of rows) if (!latest.has(row.referenceId)) latest.set(row.referenceId, { ...row, verified: row.status === "verified", verification: parseStoredJson(row.verificationJson, {}) });
  return [...latest.values()];
}

function canaryFactAllowlistResult(topic, factCheck) {
  const { references } = loadProductionCanaryManifest(topic.externalKey);
  const activeStillReferenceIds = new Set(references
    .filter((reference) => reference.mediaKind !== "video_reference_only")
    .map((reference) => reference.id));
  const assets = getCanaryAssets(topic.id);
  const allowed = new Map(assets
    .filter((asset) => activeStillReferenceIds.has(asset.referenceId)
      && asset.verified
      && asset.verification?.mediaKind !== "video_reference_only"
      && !String(asset.contentType || "").startsWith("video/"))
    .map((asset) => [asset.referenceId, asset]));
  const scope = getCanaryFactScope(topic);
  const outOfScopeClaims = (factCheck.claims || []).filter((claim) => claim.useInVideo === true
    && scope.hiddenMechanismExclusions.some((exclusion) => normalizeText(`${claim.statement || ""} ${claim.item || ""}`).includes(normalizeText(exclusion))));
  const supported = (factCheck.claims || []).filter((claim) => claim.status === "SUPPORTED" && claim.useInVideo !== false);
  const evidence = factCheck.visualEvidence || [];
  const invalid = evidence.filter((entry) => {
    const asset = allowed.get(String(entry.id || entry.state || ""));
    const expectedCrop = normalizeNormalizedBounds(asset?.verification?.panelCrop || asset?.verification?.focusBounds);
    const suppliedCrop = normalizeNormalizedBounds(entry?.panelCrop || entry?.focusBounds || entry?.metadata?.panelCrop || entry?.metadata?.focusBounds);
    return !asset || String(entry.referenceSourceUrl || "") !== asset.sourceUrl || String(entry.referenceMediaUrl || "") !== asset.mediaUrl || Number(entry.referencePage || 0) !== Number(asset.verification?.referencePage || 0) || String(entry.referenceType || "") !== asset.referenceType || JSON.stringify(suppliedCrop) !== JSON.stringify(expectedCrop);
  });
  const stateAssets = new Set(evidence.map((entry) => allowed.get(String(entry.id || entry.state || ""))?.stateHint).filter(Boolean));
  return { passed: invalid.length === 0 && outOfScopeClaims.length === 0 && supported.length >= 2 && evidence.length >= 2 && stateAssets.size >= 2, invalid, outOfScopeClaims, supportedCount: supported.length, evidenceCount: evidence.length, stateCount: stateAssets.size, allowedReferenceIds: [...allowed.keys()] };
}

function enforceCanaryFactAllowlist(topic, factCheck) {
  const result = canaryFactAllowlistResult(topic, factCheck);
  if (!result.passed) throw new Error(`Canary fact evidence가 official allowlist를 통과하지 못했습니다. refs=${result.allowedReferenceIds.join(", ")}`);
  return result;
}

async function importProductionCanary(payload = {}) {
  const { name, manifest, references, productionRequirements } = loadProductionCanaryManifest(payload.externalKey);
  if (Boolean(payload.dryRun)) {
    return { dryRun: true, manifest: name, externalKey: manifest.externalKey, runLane: manifest.runLane, references: references.map((reference) => ({ id: reference.id, stateHint: reference.stateHint, referenceType: reference.referenceType, mediaKind: reference.mediaKind })), nextStage: "official_visual_preflight" };
  }
  const assetResults = await Promise.all(references.map(async (reference) => {
    try { return await verifyOfficialCanaryReference(reference); } catch (error) {
      return { referenceId: reference.id, verified: false, finalUrl: "", contentType: "", byteSize: 0, sha256: "", cachedPath: "", status: "failed", verification: { error: String(error.message || error) } };
    }
  }));
  const preflight = validateOfficialVisualPreflight({ references, assets: assetResults, requireDistinctStillStates: productionRequirements.minimumVisualStates || 2, allowedHostSuffixes: OFFICIAL_CANARY_HOST_SUFFIXES });
  const snapshot = {
    manifest: name,
    importedAt: new Date().toISOString(),
    scope: manifest.scope,
    hiddenMechanismExclusions: Array.isArray(manifest.hiddenMechanismExclusions) ? manifest.hiddenMechanismExclusions : [],
    factSources: Array.isArray(manifest.factSources) ? manifest.factSources : [],
    productionRequirements,
    references
  };
  const existing = db.prepare("SELECT id, run_lane AS runLane FROM topics WHERE external_key = ? LIMIT 1").get(manifest.externalKey);
  if (existing && existing.runLane !== "production_canary") throw new Error("production canary externalKey가 다른 lane에 연결되어 있습니다.");
  const sourceOwner = db.prepare("SELECT id, run_lane AS runLane, external_key AS externalKey FROM topics WHERE source_url = ? LIMIT 1").get(manifest.sourceUrl);
  if (!existing && sourceOwner) throw new Error(`canary source URL이 이미 ${sourceOwner.runLane} lane topic #${sourceOwner.id}에 연결되어 있습니다.`);
  const topicId = runDbTransaction(() => {
    const id = existing?.id ? Number(existing.id) : Number(db.prepare(`
      INSERT INTO topics (main_topic, subtopic, title, hook, review_status, lifecycle_status, verification_score, visual_score, novelty_score, length_fit_score, distortion_risk_score, source_title, source_url, topic_format, run_lane, external_key, candidate_json, visual_preflight_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'production_canary', 'production_canary', ?, ?, ?)
    `).run(manifest.mainTopic, manifest.subtopic, manifest.title, manifest.hook, preflight.passed ? "prechecked" : "hold", preflight.passed ? "fact_checking" : "candidate", 100, 100, 100, 100, 0, manifest.sourceTitle, manifest.sourceUrl, manifest.externalKey, JSON.stringify(snapshot), JSON.stringify(preflight)).lastInsertRowid);
    if (existing) db.prepare(`UPDATE topics SET title = ?, hook = ?, review_status = ?, lifecycle_status = ?, candidate_json = ?, visual_preflight_json = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND run_lane = 'production_canary'`).run(manifest.title, manifest.hook, preflight.passed ? "prechecked" : "hold", preflight.passed ? "fact_checking" : "candidate", JSON.stringify(snapshot), JSON.stringify(preflight), preflight.passed ? "" : preflight.issues.map((item) => item.code).join(", "), id);
    const insertAsset = db.prepare(`INSERT INTO official_visual_assets (topic_id, reference_id, state_hint, reference_type, source_url, media_url, final_url, content_type, byte_size, sha256, cached_path, license_url, license_note, status, verification_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const reference of references) {
      const asset = assetResults.find((entry) => entry.referenceId === reference.id) || {};
      insertAsset.run(id, reference.id, reference.stateHint, reference.referenceType, reference.sourceUrl, reference.mediaUrl, asset.finalUrl || "", asset.contentType || "", asset.byteSize || 0, asset.sha256 || "", asset.cachedPath || "", reference.licenseUrl, reference.licenseNote, asset.status || "failed", JSON.stringify({ ...(asset.verification || {}), panelCrop: reference.panelCrop, focusBounds: reference.focusBounds, metadata: reference.metadata }));
    }
    return id;
  });
  return { dryRun: false, topic: getTopicDetailById(topicId).topic, preflight, assets: getCanaryAssets(topicId), factJobQueued: false };
}

function canaryHasAiPass(topic) {
  return topic?.runLane === "production_canary" && Boolean(topic?.canaryAiPassAt);
}

function recordCanaryAiPass(payload = {}) {
  const topic = mapTopicRow(getTopicStatement.get(Number(payload.topicId)));
  if (!topic || topic.runLane !== "production_canary") throw new Error("production canary topicId가 필요합니다.");
  const script = mapScriptRow(getScriptByTopicStatement.get(topic.id));
  if (!script || script.status !== "draft") throw new Error("AI 검수를 통과한 draft 대본만 canary AI_PASS로 표시할 수 있습니다.");
  db.prepare("UPDATE topics SET canary_ai_pass_at = CURRENT_TIMESTAMP, canary_ai_pass_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(JSON.stringify({ reviewer: String(payload.reviewer || "canary"), scriptId: script.id, recordedAt: new Date().toISOString() }), topic.id);
  return getTopicDetailById(topic.id);
}

async function advanceProductionCanary(payload = {}) {
  const loaded = loadProductionCanaryManifest(payload.externalKey);
  const targetVisualEvidenceCount = loaded.productionRequirements.minimumVisualStates || 2;
  let topic = db.prepare("SELECT id FROM topics WHERE external_key = ? LIMIT 1").get(loaded.manifest.externalKey);
  if (!topic) {
    if (Boolean(payload.dryRun)) return { dryRun: true, nextStage: "official_visual_preflight", action: "import" };
    return { ...(await importProductionCanary({ externalKey: loaded.manifest.externalKey })), advanced: "official_visual_preflight" };
  }
  const detail = getTopicDetailById(Number(topic.id));
  const canary = detail.topic;
  const preflight = canary.visualPreflight || {};
  const latestTtsRun = mapTtsRunRow(getLatestTtsRunByTopicStatement.get(canary.id));
  const ttsRun = latestTtsRun?.status === "stale" ? null : latestTtsRun;
  const measuredTtsTimeline = getShotlistTimeline(latestTtsRun);
  const measuredTtsOverruns = (latestTtsRun?.segments || [])
    .map((segment, index) => ({
      segmentIndex: Number(segment.segmentIndex || 0),
      text: String(segment.text || ""),
      durationSec: Number(measuredTtsTimeline.timelineDurations[index] || segment.durationSec || 0)
    }))
    .filter((segment) => segment.durationSec > NATIVE_CLIP_DURATION_SEC + 0.01);
  if (preflight.passed !== true) return { dryRun: Boolean(payload.dryRun), topicId: canary.id, blocked: "needs_reference", nextStage: "official_visual_preflight", action: payload.dryRun ? "none" : "reimport_required" };
  const stages = [
    payload.retryStage === "fact_contract" ? { stage: "fact_check", jobType: "fact_check", jobPayload: { source: "production_canary_script_feedback", remediationRoute: "fact_contract_revision", force: true, targetVisualEvidenceCount } } : null,
    !detail.factCheck ? { stage: "fact_check", jobType: "fact_check", jobPayload: { source: "production_canary", targetVisualEvidenceCount } } : null,
    detail.factCheck && detail.factCheck.status !== "PASS" ? { stage: "fact_check", blocked: "fact_check_not_passed" } : null,
    detail.factCheck?.status === "PASS" && !detail.productionBrief ? { stage: "production_brief", jobType: "production_brief_generate" } : null,
    detail.productionBrief?.status === "stale" ? { stage: "production_brief", jobType: "production_brief_generate", jobPayload: { source: "production_canary_fact_contract_refresh" } } : null,
    detail.productionBrief && detail.productionBrief.status !== "ready"
      ? payload.retryStage === "production_brief_repair" && Number(detail.productionBrief.revision || 0) <= 5
        ? { stage: "production_brief", jobType: "production_brief_generate", jobPayload: { source: "production_canary_reviewer_repair", repairReviewer: true } }
        : payload.retryStage === "production_brief_review" && Number(detail.productionBrief.revision || 0) <= 3
          ? { stage: "production_brief", jobType: "production_brief_generate", jobPayload: { source: "production_canary_review_replay", reviewOnly: true } }
          : payload.retryStage === "production_brief" && Number(detail.productionBrief.revision || 0) <= 2
            ? { stage: "production_brief", jobType: "production_brief_generate", jobPayload: { source: "production_canary_review_retry" } }
            : { stage: "production_brief", blocked: "production_brief_not_ready" }
      : null,
    detail.productionBrief?.status === "ready" && payload.retryStage === "script_rebuild"
      ? { stage: "script", jobType: "script_generate", jobPayload: {
        source: "production_canary_native_clip_capacity_rebuild",
        remediationRoute: "script_scope_compression",
        targetDurationSec: detail.productionBrief.visualStates.length * SCRIPT_STATE_TTS_BUDGET_SEC,
        measuredTtsOverruns
      } }
      : null,
    detail.productionBrief?.status === "ready" && !detail.script
      ? { stage: "script", jobType: "script_generate", jobPayload: payload.retryStage === "script"
        ? { source: "production_canary_script_review_retry", remediationRoute: "local_targeted_revision" }
        : { source: "production_canary" } }
      : null,
    detail.script && detail.script.status !== "draft" ? { stage: "script", blocked: "script_not_ready" } : null,
    detail.script?.status === "draft" && !canaryHasAiPass(canary) ? { stage: "canary_ai_pass", blocked: "awaiting_canary_ai_pass" } : null,
    canaryHasAiPass(canary) && !ttsRun ? { stage: "tts", jobType: "tts_generate" } : null,
    ttsRun && ttsRun.status !== "generated" ? { stage: "tts", blocked: "tts_not_ready" } : null,
    ttsRun?.status === "generated"
      && (Number(ttsRun.totalDurationSec || 0) > Number(detail.productionBrief?.visualStates?.length || 0) * NATIVE_CLIP_DURATION_SEC + 0.01
        || measuredTtsOverruns.length > 0)
      ? { stage: "script", jobType: "script_generate", jobPayload: {
        source: "production_canary_measured_tts_capacity_rebuild",
        remediationRoute: "script_scope_compression",
        targetDurationSec: Number(detail.productionBrief?.visualStates?.length || 0) * SCRIPT_STATE_TTS_BUDGET_SEC,
        measuredTtsOverruns
      } }
      : null,
    ttsRun?.status === "generated" && !detail.shotlist ? { stage: "shotlist", jobType: "shotlist_generate" } : null,
    detail.shotlist?.status !== "approved"
      ? payload.retryStage === "shotlist_rebuild"
        ? { stage: "shotlist", jobType: "shotlist_generate", jobPayload: { source: "production_canary_evidence_bound_rebuild" } }
        : payload.retryStage === "shotlist"
          ? { stage: "shotlist", jobType: "shotlist_generate", jobPayload: { source: "production_canary_shotlist_review_retry", remediationRoute: "local_targeted_revision" } }
          : { stage: "shotlist_review", blocked: "awaiting_shotlist_review" }
      : null,
    { stage: "clean_info", blocked: "manual_asset_review_required" }
  ].find(Boolean);
  if (stages.blocked) return { dryRun: Boolean(payload.dryRun), topicId: canary.id, nextStage: stages.stage, blocked: stages.blocked, videoBlocked: true };
  if (Boolean(payload.dryRun)) return { dryRun: true, topicId: canary.id, nextStage: stages.stage, jobType: stages.jobType, videoBlocked: true };
  const queued = enqueueAiJob(stages.jobType, canary.id, stages.jobPayload || { source: "production_canary" });
  return { topicId: canary.id, advanced: stages.stage, job: queued.job, reused: queued.reused, videoBlocked: true };
}

async function runProductionBriefStage(payload, jobContext = null) {
  const id = Number(payload.id);
  const topic = mapTopicRow(getTopicStatement.get(id));
  const factCheck = mapFactCheckRow(getFactCheckByTopicStatement.get(id));
  if (!topic || !factCheck || factCheck.status !== "PASS") throw new Error("사실 검증 PASS 후 제작 설계서를 만들 수 있습니다.");
  if (topic.runLane === "production_canary") enforceCanaryFactAllowlist(topic, factCheck);
  return runTopicOperation(id, "제작 설계서", async () => {
    jobContext?.progress(10, "공식 시각 근거만으로 제작 설계서를 검토합니다.");
    const rules = await loadRuleContext(topic.mainTopic);
    const existing = mapProductionBriefRow(getProductionBriefByTopicStatement.get(id));
    const existingDraftScript = mapScriptRow(getScriptByTopicStatement.get(id));
    const brief = payload.source === "production_canary_fact_contract_refresh"
      && topic.runLane === "production_canary"
      && ["draft", "stale"].includes(existingDraftScript?.status)
      ? saveCanaryDraftScriptFactContractRefresh(topic, factCheck, existingDraftScript)
      : payload.repairReviewer === true && existing
        ? await repairProductionBriefFromReviewer(topic, factCheck, existing, jobContext)
      : payload.reviewOnly === true && existing
        ? await saveReviewedProductionBrief(
          topic,
          factCheck,
          normalizeProductionBrief(existing, topic.mainTopic),
          { ...(existing.raw?.generation || existing.raw || {}), reviewReplayOf: existing.id },
          "production_canary_review_replay",
          jobContext
        )
        : payload.remediationRoute === "production_contract_revision" && existing
          ? await reviseProductionBriefFromQualityFeedback(topic, factCheck, existing, jobContext, payload.assetQualityFeedback)
          : await ensureProductionBrief(topic, factCheck, rules, jobContext);
    if (payload.remediationRoute === "production_contract_revision") markBenchmarkDependentsStale(id);
    if (brief.status !== "ready") {
      updateTopicFailureStatement.run("hold", "fact_checking", "제작 설계서가 공식 시각 근거 범위에서 HOLD입니다.", id);
    } else {
      updateTopicReviewStatement.run("verified", "script", id);
    }
    jobContext?.progress(96, brief.status === "ready" ? "제작 설계서 검토를 통과했습니다." : "제작 설계서를 HOLD로 저장했습니다.");
    return getTopicDetailById(id);
  });
}

function requiresStateBoundedScript(topic, productionBrief) {
  const minimumVisualStates = Number(getConfiguredProductionRequirements(topic).minimumVisualStates || 0);
  return minimumVisualStates >= 6 && (productionBrief?.visualStates || []).length >= minimumVisualStates;
}

function buildStateBoundedScriptPrompt(topic, factCheck, productionBrief, requirements, downstreamFeedback, scriptFeedback) {
  const supportedClaims = (factCheck.claims || [])
    .filter((claim) => claim.status === "SUPPORTED" && claim.useInVideo !== false)
    .map((claim) => ({
      id: String(claim.id || "").trim(),
      statement: String(claim.claim || claim.statement || claim.text || "").trim()
    }))
    .filter((claim) => claim.id && claim.statement);
  const stateCards = (productionBrief.visualStates || []).map((state) => ({
    visualStateId: state.stateId,
    label: state.label,
    purpose: state.purpose,
    physicalState: state.physicalState,
    changeFromPrevious: state.changeFromPrevious,
    requiredVisibleElements: state.requiredVisibleElements,
    forbiddenVisibleElements: state.forbiddenVisibleElements,
    claimRefs: state.claimRefs,
    requiredInfoGraphics: (state.evidenceBeats || [])
      .filter((beat) => beat.infoGraphic?.requiresOverlay === true && beat.infoGraphic?.type !== "none")
      .map((beat) => ({ beatId: beat.beatId, infoGraphic: beat.infoGraphic }))
  }));
  const compactFeedback = (feedback) => feedback ? {
    action: feedback.action,
    reason: String(feedback.reason || "").slice(0, 360),
    issues: (feedback.issues || []).slice(0, 6).map((issue) => ({
      code: issue.code,
      segmentIndex: issue.segmentIndex,
      repairInstruction: String(issue.repairInstruction || "").slice(0, 240)
    }))
  } : null;
  const capacitySec = stateCards.length * SCRIPT_STATE_TTS_BUDGET_SEC;

  return `
당신은 근거 기반 시네마틱 공학 쇼츠의 한국어 대본 작가입니다. 이 작업은 manifest가 고정한 시각 상태를 순서대로 짧게 설명하는 상태-경계 생성입니다. JSON 스키마에 맞는 객체 하나만 반환하세요.

완료 계약:
- productionScript는 정확히 ${stateCards.length}행이며, 아래 상태 카드의 visualStateId를 같은 순서로 각각 한 번만 사용합니다. 상태를 생략·반복·재배열하거나 카메라 변화로 새 상태를 만들지 마세요.
- 각 행 내레이션은 한 개의 짧은 한국어 문장으로 ${SCRIPT_STATE_TTS_BUDGET_SEC}초 이하가 되게 쓰고, 행 안에서 두 물리 상태 사이를 전환하지 마세요. 전체 TTS는 ${capacitySec}초 이하입니다.
- 첫 행은 첫 상태에서 이해되는 짧은 질문입니다. 이후 행은 카드가 제공한 상태 변화와 검증된 인과를 순서대로 연결합니다.
- 각 행에는 그 카드의 claimRefs만 사용하고, physicalState·visualDirection·forceFlow·forbidden에도 카드 밖의 사실, 숨은 부품, 운영 절차, 정밀 수치·방향을 추가하지 마세요.
- requiredInfoGraphics가 있는 서로 다른 상태 중 최소 ${requirements.minimumRequiredInfoOverlays || 0}개에서는 해당 infoGraphic을 그대로 사용하세요. 그 외 INFO는 none입니다. INFO로 새로운 사실을 만들지 마세요.
- narrativeType은 지원 근거에 맞게 고르고, causalContext도 아래 주장만 참조하세요. 시그니처 문구는 사용하지 않는 편이 안전하면 signaturePlan을 false로 두세요.
- 모든 스키마 필수 필드를 채우되, 설명을 늘리기보다 핵심 질문·메커니즘·상태별 한 문장에 집중하세요.

주제와 검증 범위:
${JSON.stringify({ title: topic.title, hook: topic.hook, coreClaim: factCheck.coreClaim, scopeStatement: productionBrief.scopeStatement, supportedClaims, forbiddenInferences: productionBrief.forbiddenInferences }, null, 2)}

Manifest 요구사항:
${JSON.stringify(requirements, null, 2)}

고정 시각 상태 카드:
${JSON.stringify(stateCards, null, 2)}

최근 범위 한정 피드백:
${JSON.stringify({ downstreamFeedback: compactFeedback(downstreamFeedback), scriptFeedback: compactFeedback(scriptFeedback) }, null, 2)}
`.trim();
}

async function generateScript(payload, jobContext = null) {
  const id = Number(payload.id);
  const topic = getTopicStatement.get(id);
  if (!topic) {
    throw new Error("대본을 만들 주제를 찾을 수 없습니다.");
  }

  const factCheckRow = getFactCheckByTopicStatement.get(id);
  const factCheck = mapFactCheckRow(factCheckRow);
  if (!factCheck) {
    throw new Error("먼저 사실 검증을 실행해야 합니다.");
  }
  if (factCheck.status !== "PASS") {
    throw new Error(`검증 상태가 ${factCheck.status}라서 대본을 만들 수 없습니다. PASS일 때만 대본 생성이 가능합니다.`);
  }
  if (topic.runLane === "production_canary") enforceCanaryFactAllowlist(mapTopicRow(topic), factCheck);
  const scriptCodexTimeoutMs = getConfiguredProductionRequirements(mapTopicRow(topic)).minimumVisualStates >= 6 ? 420000 : 240000;

  return runTopicOperation(id, "대본 생성", async () => {
  jobContext?.progress(8, "검증 결과와 제작 규칙을 불러옵니다.");
  const rules = await loadRuleContext(topic.mainTopic);
  let productionBrief = await ensureProductionBrief(topic, factCheck, rules, jobContext);
  if (payload.remediationRoute === "production_contract_revision") {
    productionBrief = await reviseProductionBriefFromQualityFeedback(topic, factCheck, productionBrief, jobContext);
  }
  if (productionBrief.status !== "ready") {
    if (payload.remediationRoute === "production_contract_revision") {
      const holdNotes = productionBrief.raw?.notes || productionBrief.raw?.generation?.notes || [];
      recordTopicAttempt(id, "production_contract_revision", "needs_reference", "제작 설계서 교정 결과 실제 공식 시각 참조가 더 필요합니다.", {
        source: "quality_benchmark_remediation",
        notes: holdNotes,
        productionBriefRevision: productionBrief.revision
      });
      jobContext?.progress(100, "제작 설계서를 교정했고, 추측 없는 제작에 필요한 공식 시각 참조 대기로 전환했습니다.");
      return {
        ...getTopicDetailById(id),
        remediation: {
          route: "visual_reference_enrichment",
          status: "needs_reference",
          notes: holdNotes
        }
      };
    }
    throw new Error("제작 설계서가 HOLD라서 대본을 만들지 않습니다. 시각 상태와 근거 범위를 먼저 보강해야 합니다.");
  }
  const scriptContractHash = buildScriptUpstreamContractHash(factCheck, productionBrief);
  const downstreamFeedback = getLatestUpstreamQualityFeedback(id, "shotlist_quality");
  const scriptFeedback = getLatestUpstreamQualityFeedback(id, "script_quality");
  const productionRequirements = getConfiguredProductionRequirements(topic);
  const stateBoundedScript = requiresStateBoundedScript(topic, productionBrief);
  const projectDir = await ensureProjectFolders(id);
  const scriptCachePath = path.join(projectDir, "manifests", "SCRIPT_AI_CACHE.json");
  const existingMeasuredCompressionScript = payload.remediationRoute === "script_scope_compression"
    ? mapScriptRow(getScriptByTopicStatement.get(id))
    : null;
  const verifiedVisualStateCount = new Set((productionBrief.visualStates || [])
    .map((state) => String(state.stateId || "").trim())
    .filter(Boolean)).size;
  const evidenceDurationCapacitySec = verifiedVisualStateCount * SCRIPT_STATE_TTS_BUDGET_SEC;
  const requestedTargetDurationSec = Math.max(0, Math.min(evidenceDurationCapacitySec, Number(payload.targetDurationSec || evidenceDurationCapacitySec)));
  const persistScriptCandidate = async (script, reviews = [], best = null) => {
    const candidateHash = buildScriptCandidateHash(script);
    const binding = scriptReviewBinding({ contractHash: scriptContractHash, factCheckId: factCheck.id, productionBriefId: productionBrief.id, candidateHash });
    const candidateReviews = filterScriptReviewsForCandidate(reviews, candidateHash, binding);
    const candidateBest = best?.candidateHash === candidateHash
      && buildScriptCandidateHash(best.script) === candidateHash
      ? { ...best, reviews: filterScriptReviewsForCandidate(best.reviews, candidateHash, binding) }
      : null;
    await writeFile(scriptCachePath, JSON.stringify({
      contractVersion: SCRIPT_CONTRACT_VERSION,
      contractHash: scriptContractHash,
      candidateHash,
      factCheckId: factCheck.id,
      productionBriefId: productionBrief.id,
      script,
      reviews: candidateReviews,
      best: candidateBest,
      updatedAt: new Date().toISOString()
    }, null, 2), "utf8");
  };
  const prompt = `
당신은 시네마틱 설명 쇼츠 대본 작가입니다.
아래 후보는 사실 검증 PASS를 받은 주제입니다. 처음 제공된 MD 규칙과 선택된 도메인 규칙을 반드시 반영해 대본을 작성하세요.

반드시 지킬 규칙:
- 대본 길이는 검증된 시각 상태가 실제 원본 클립으로 덮을 수 있는 범위 안에서 정합니다. 고정된 45초나 60초 분량을 먼저 채우지 마세요.
- 현재 서로 다른 검증 시각 상태는 ${verifiedVisualStateCount}개입니다. 상태 하나당 ${NATIVE_CLIP_DURATION_SEC}초 원본 클립 하나만 허용하며 실제 합성 오차를 고려한 대본 예산은 상태당 ${SCRIPT_STATE_TTS_BUDGET_SEC}초입니다. 전체 TTS 예상 길이는 ${evidenceDurationCapacitySec}초 이하로 설계하세요.
- 필수 인과가 이 용량을 넘으면 같은 상태를 확대·각도·미세 동작으로 쪼개지 말고, 비필수 수식과 메타 설명을 줄이세요. 그래도 완결할 수 없으면 새 상태를 지어내지 말고 제작 불가 사유를 notes에 남기세요.
${requestedTargetDurationSec ? `- 이번 작업의 TTS 예상 길이는 반드시 ${requestedTargetDurationSec}초 이하입니다. 같은 visualStateId를 다른 카메라 설명으로 반복하지 마세요.` : ""}
- productionScript의 필수 문장을 먼저 완성하고, 줄여도 인과가 끊기지 않는 보강/확장 문장을 별도로 표시합니다.
- 길이를 맞추기 위해 같은 상태의 확대·각도·날씨·표면 묘사를 추가하지 않습니다. 반대로 설명에 필요한 검증된 인과관계를 시간 제한 때문에 삭제하지도 않습니다.
- 문제 해결형, 설계 제약형, 숨은 원리형, 실패 분석형, 진화·비교형, 공정 해부형 중 근거에 맞는 서사 유형 하나를 선택합니다. 모든 주제를 억지로 문제 해결형으로 만들지 않습니다.
- 시작 3초 안에 질문이 있어야 합니다.
- 초반 약 1/3은 문제와 불확실성을 키우고, 이후 인과관계로 해소합니다.
- 공학 주제는 구조 암기가 아니라 힘, 하중, 압력, 유동, 열, 진동 또는 에너지의 변화를 시각화합니다.
- 상판 전진, 인양, 회전, 가설, 장경간 시공처럼 큰 물체가 움직이는 모든 장면은 실제 지지점, 받침, 가이드, 접촉부 또는 임시 구조를 화면에 남겨야 합니다. 근거 없이 허공에 떠 있거나 무지지 캔틸레버처럼 보이게 만들지 않습니다.
- 먼저 핵심 질문, 핵심 메커니즘, 보이는 흐름, 고유한 차별점을 명확히 고정합니다.
- 제약, 실패 성장, 설계 개입, 물리 변화, 반응, 성능과 트레이드오프, 현실적 한계 순으로 인과가 전진해야 합니다.
- productionScript의 각 행은 앞 행과 시각적으로 구분되는 하나의 의미 있는 물리 상태를 담당하고 C01 형식의 검증 주장 ID를 연결합니다. 새 카메라 거리나 표현만으로 새 행을 만들지 않습니다.
- 하나의 visualStateId가 담당하는 내레이션은 TTS 예상 ${SCRIPT_STATE_TTS_BUDGET_SEC}초 이하여야 합니다. 실제 합성 후 ${NATIVE_CLIP_DURATION_SEC}초를 넘지 않도록 짧은 문장 하나만 배정하세요.
- 한 행 안에서 닫힘에서 열림, 차단에서 유출, 조건에서 결과처럼 서로 다른 물리 상태로 전환하지 않습니다. 상태가 바뀌면 승인된 별도 visualStateId의 다음 행으로 분리합니다.
- 각 행의 claimRefs는 그 행의 내레이션과 물리 상태에 포함된 모든 사실 절을 직접 지원해야 합니다. 영상 전체 어딘가에 근거가 있다는 이유로 가까운 다른 claim id를 생략하지 않습니다.
- 검증 주장에 또는, 혹은, 범위, 예외, 조건부 표현이 있으면 내레이션에서도 논리 관계를 보존하세요. 대안 조건을 하나의 보통·항상 조건으로 줄이지 마세요.
- 출처가 지지·접촉 관계를 직접 확인하지 않으면 교각·기초·프레임을 대상의 지지 구조라고 부르지 말고, 함께 보이는 공간 배치만 적습니다.
- 수면 아래에 가려진 부품은 공식 수중 관찰 또는 단면 근거가 없으면 CLEAN 필수 가시 요소로 요구하지 않습니다. 화면에서 확인 가능한 열린 개구부, 막힌 개구부, 수면 관계와 유동 결과를 사용합니다.
- 내레이션에는 화면, 장면, 편집, 검수, 출처, 자료 같은 제작 메타 표현을 넣지 않습니다.
- 평소, 항상, 보통, 절대 같은 빈도·보편 표현은 SUPPORTED 주장에 그 범위가 명시됐을 때만 사용합니다.
- 아래 하위 장면표의 상위 계약 피드백이 있으면 같은 장면을 카메라만 바꿔 늘리지 않습니다. 추가 공식 시각 근거가 없을 때는 지적된 대본 구간의 내레이션을 압축하고 중복 주장을 합쳐, 검증된 시각 상태가 감당할 수 있는 분량으로 되돌립니다.
- insufficient_visual_depth 피드백은 전체 영상을 임의의 고정 초수로 자르라는 뜻이 아닙니다. 문제가 된 구간만 줄이고, 원인·작동·결과의 필수 인과는 유지합니다.
- 각 productionScript 행의 visualStateId는 아래 승인된 제작 설계서의 stateId 중 하나를 글자 그대로 사용합니다. 설계서 밖의 상태를 새로 만들지 않습니다.
- 사실 검증에서 확인된 사실만 단정합니다.
- 문제 해결형이라면 가능한 범위에서 원인/발생 배경 → 문제와 위험 → 제약 → 개입 → 작동 원리 → 결과와 한계가 이어져야 합니다. 원인 근거가 없으면 누락을 notes에 명시하고 다른 서사 유형을 검토합니다.
- 실제 문제와 제약이 충분히 누적된 경우에만 정확히 “아~ 어질어질합니다.”를 한 번 사용할 수 있습니다.
- 해결책이 개입 대상이나 기존 통념을 실제로 뒤집는 경우에만 정확히 “그래서 생각의 판을 완전히 엎었습니다.”를 한 번 사용합니다. 이 문구는 앞에서 누적한 문제의 결론처럼 이어져야 하며, 직후에 핵심 해결책을 공개합니다.
- 조건에 맞지 않으면 시그니처 문구를 사용하지 않습니다. 평범한 개선을 과장해 반전으로 만들지 않습니다.
- 미확인 수치, 연도, 인과관계를 만들지 않습니다.
- productionScript의 infoGraphic은 아이디어 메모일 뿐이며 기본값은 none입니다. 화면에 보이는 물체 이름, 방위, 내레이션 반복 문구를 라벨로 만들지 않습니다.
- INFO는 CLEAN과 영상만으로 읽기 어려운 하중 경로, 인과관계 또는 검증된 전후 차이가 있을 때만 제안하고 라벨은 최대 2개로 제한합니다.
- 세 개 이상의 독립 입력을 라벨 두 개짜리 INFO 한 장에 합치지 않습니다. 핵심 관계 하나만 남기거나 infoGraphic을 none으로 둡니다.
- 검증 주장에 명시되지 않은 운영자 행동, 관제 화면, 모니터링 인터페이스, 사람이 자료를 확인하는 절차를 만들지 않습니다.
- 대본 승인 전에는 장면표/CLEAN/INFO/영상 단계로 넘어가지 않습니다.
- 응답은 JSON 객체 하나만 출력하세요. 설명 문장, 마크다운, 코드펜스 금지.

[초기 제작 MD 핵심 규칙]
${rules.workflowExcerpt}

[도메인 규칙 ${rules.domainFile}]
${rules.domainRules}

[제품 승인 게이트]
${rules.pipelineSpec}

[후보 주제]
id: ${topic.id}
메인 주제: ${topic.mainTopic}
세부 주제: ${topic.subtopic}
후보 제목: ${topic.title}
후보 설명: ${topic.hook}
출처 제목: ${topic.sourceTitle}
출처 URL: ${topic.sourceUrl}

[사실 검증 결과]
${JSON.stringify(factCheck, null, 2)}

[승인된 제작 설계서]
${JSON.stringify(productionBrief, null, 2)}

[최근 장면표에서 반환된 상위 계약 피드백]
${downstreamFeedback ? JSON.stringify(downstreamFeedback, null, 2) : "없음"}

[최근 대본 검수에서 반환된 누적 피드백]
${scriptFeedback ? JSON.stringify(scriptFeedback, null, 2) : "없음"}

JSON 스키마:
{
  "narrativeType": "problem_solution | design_constraint | hidden_mechanism | failure_analysis | evolution_comparison | process_breakdown",
  "narrativeReason": "이 서사 유형을 선택한 근거",
  "causalContext": [
    { "role": "origin | cause | problem | constraint | intervention | mechanism | result | tradeoff", "statement": "검증된 인과 문장", "claimRefs": ["C01"] }
  ],
  "lengthPlan": {
    "strategy": "evidence_bound_native_clips",
    "recommendedMinSec": ${Math.max(NATIVE_CLIP_DURATION_SEC, evidenceDurationCapacitySec - NATIVE_CLIP_DURATION_SEC)},
    "recommendedMaxSec": ${evidenceDurationCapacitySec},
    "compressionNotes": ["각 visualStateId를 ${NATIVE_CLIP_DURATION_SEC}초 원본 클립 하나로 덮고 비필수 문장을 제거"]
  },
  "signaturePlan": {
    "problemLineUsed": true,
    "pivotLineUsed": true,
    "reason": "실제 문제 누적과 접근 대상의 반전이 모두 존재함"
  },
  "coreQuestion": "시청자가 끝까지 알고 싶어 할 질문",
  "coreConflict": "충돌하는 조건, 이해관계, 제약",
  "coreMechanism": "문제를 해결하는 구조, 장치 또는 물리 작용",
  "visibleFlow": "화면에서 보이게 만들 흐름",
  "turningPoint": "결과를 바꾸는 결정/장소/장치/사건",
  "uniqueDifferentiator": "다른 구조나 기계와 구별되는 특징",
  "designIntervention": "실패를 막는 결정적인 설계 개입",
  "tradeoffs": ["성능을 얻기 위해 지불하는 비용"],
  "limitations": ["현실적인 한계와 적용 조건"],
  "productionScript": [
    {
      "time": "0~5초",
      "beat": "질문",
      "importance": "essential | supporting | extension",
      "visualStateId": "승인된 제작 설계서의 stateId",
      "narration": "내레이션 문장",
      "visualDirection": "시각 연출",
      "physicalState": "이 장면에서 보이는 물리 상태",
      "mechanismStep": "메커니즘의 현재 단계",
      "stateChangeReason": "이전 장면과 분리해야 하는 물리적 이유",
      "forceFlow": "힘, 압력, 유동, 열, 진동 또는 에너지의 방향",
      "claimRefs": ["C01"],
      "infoGraphic": {
        "type": "forbidden_action | location | scale_limit | flow | before_after | load_path | sequence | comparison | none",
        "labels": ["그래픽 없이는 읽히지 않는 핵심 정보"],
        "anchors": ["선과 화살표가 실제로 붙을 구조물"],
        "directionRule": "화살표 시작점과 도착점, 금지 동작이면 목표를 향하다 접촉 전에 중단",
        "comparisonRule": "전후 비교면 기준선, 이전 축, 이후 축, 두 축의 간격을 명시",
        "forbidden": ["반대 방향 화살표", "문장형 제목", "근거 없는 수치"]
      }
    }
  ],
  "ttsText": "타임라인 없이 바로 읽는 TTS용 전체 텍스트",
  "notes": [
    "검증된 사실과 영상적 단순화 주의점"
  ]
}
`.trim();

  const generationPrompt = stateBoundedScript
    ? buildStateBoundedScriptPrompt(topic, factCheck, productionBrief, productionRequirements, downstreamFeedback, scriptFeedback)
    : prompt;
  let rawResult = null;
  let cachedReviews = [];
  let cachedBest = null;
  try {
    const cached = JSON.parse(await readFile(scriptCachePath, "utf8"));
    const cacheMatchesCurrentContract = cached.contractHash === scriptContractHash;
    const cacheHasSameUpstreamRecords = Number(cached.factCheckId || 0) === Number(factCheck.id)
      && Number(cached.productionBriefId || 0) === Number(productionBrief.id);
    if (Number(cached.contractVersion || 0) === SCRIPT_CONTRACT_VERSION
      && cacheMatchesCurrentContract
      && cacheHasSameUpstreamRecords
      && cached.script) {
      rawResult = cached.script;
      const loadedCandidateHash = buildScriptCandidateHash(cached.script);
      const cacheHasMatchingCandidateHash = cached.candidateHash === loadedCandidateHash;
      const loadedBinding = scriptReviewBinding({ contractHash: scriptContractHash, factCheckId: factCheck.id, productionBriefId: productionBrief.id, candidateHash: loadedCandidateHash });
      cachedReviews = cacheHasMatchingCandidateHash
        ? filterScriptReviewsForCandidate(cached.reviews, loadedCandidateHash, loadedBinding)
        : [];
      cachedBest = cacheHasMatchingCandidateHash
        && cached.best?.candidateHash === loadedCandidateHash
        && buildScriptCandidateHash(cached.best.script) === loadedCandidateHash
        ? { ...cached.best, reviews: filterScriptReviewsForCandidate(cached.best.reviews, loadedCandidateHash, loadedBinding) }
        : null;
    }
  } catch {
    // Missing or stale script candidates are regenerated once for this upstream contract.
  }
  if (existingMeasuredCompressionScript?.status === "draft") {
    rawResult = existingMeasuredCompressionScript;
    cachedReviews = [];
    cachedBest = null;
    jobContext?.progress(20, "측정된 TTS 초과 행을 최신 draft 후보에서만 압축합니다.");
  }
  if (rawResult) {
    jobContext?.progress(20, "같은 근거 계약에서 저장된 대본 후보를 이어서 검수합니다.");
  } else {
    jobContext?.progress(20, "검증된 사실을 바탕으로 대본을 구성합니다.");
    let completedItems = 0;
    rawResult = await runCodexJson(generationPrompt, `script-${id}`, scriptCodexTimeoutMs, {
      signal: jobContext?.signal,
      onEvent(event) {
        if (event.type !== "item.completed") return;
        completedItems += 1;
        jobContext?.progress(Math.min(64, 20 + completedItems * 6), "대본 AI가 질문, 전환점, 내레이션을 작성하고 있습니다.");
      }
    });
  }
  let initialScript = validateScriptContract(normalizeScriptResult(rawResult), productionBrief, stateBoundedScript);
  let initialCandidateHash = buildScriptCandidateHash(initialScript);
  cachedReviews = filterScriptReviewsForCandidate(cachedReviews, initialCandidateHash);
  cachedBest = cachedBest?.candidateHash === initialCandidateHash
    && buildScriptCandidateHash(cachedBest.script) === initialCandidateHash
    ? { ...cachedBest, reviews: filterScriptReviewsForCandidate(cachedBest.reviews, initialCandidateHash) }
    : null;
  let effectiveRepairLimit = payload.reviewOnly === true ? 0 : payload.remediationRoute ? 1 : QUALITY_AUTO_REPAIR_LIMIT;
  if (payload.remediationRoute === "local_targeted_revision" && cachedReviews.length) {
    jobContext?.progress(42, "저장된 최신 검수 지시로 지적된 대본 범위만 교정합니다.");
    initialScript = await reviseScriptWithAi(
      topic,
      factCheck,
      initialScript,
      cachedReviews,
      jobContext,
      cachedReviews.length + 1,
      productionBrief,
      { reviewerTargeted: true }
    );
    initialCandidateHash = buildScriptCandidateHash(initialScript);
    cachedReviews = [];
    cachedBest = null;
    // The requested repair has already been consumed. Review the corrected
    // candidate once and route any remaining issue without another generation.
    effectiveRepairLimit = 0;
  } else if (payload.remediationRoute === "script_scope_compression"
    && Array.isArray(payload.measuredTtsOverruns)
    && payload.measuredTtsOverruns.length) {
    const measuredReview = {
      candidateHash: initialCandidateHash,
      passed: false,
      score: 0,
      summary: "실제 TTS에서 4초 원본 클립을 넘긴 행만 다시 압축해야 합니다.",
      action: "revise",
      issues: payload.measuredTtsOverruns.map((overrun) => ({
        code: "not_visualizable",
        severity: "error",
        segmentIndex: Number(overrun.segmentIndex || 0),
        message: `${Number(overrun.segmentIndex || 0)}번 행의 실제 TTS가 ${Number(overrun.durationSec || 0).toFixed(2)}초로 ${NATIVE_CLIP_DURATION_SEC}초 원본 클립을 초과했습니다.`,
        repairInstruction: "해당 행의 의미와 근거 상태는 유지하고 실제 발화가 4초 안에 확실히 들도록 짧게 압축하십시오. 새 상태나 반복 크롭을 추가하지 마십시오."
      })),
      deterministicIssues: payload.measuredTtsOverruns.map((overrun) => (
        `${Number(overrun.segmentIndex || 0)}번 행 실제 TTS ${Number(overrun.durationSec || 0).toFixed(2)}초가 ${NATIVE_CLIP_DURATION_SEC}초 원본 클립을 초과함`
      ))
    };
    cachedReviews = [...cachedReviews, measuredReview];
    jobContext?.progress(42, "실제 TTS가 원본 클립을 넘긴 대본 행만 다시 압축합니다.");
    initialScript = await reviseScriptWithAi(
      topic,
      factCheck,
      initialScript,
      cachedReviews,
      jobContext,
      cachedReviews.length + 1,
      productionBrief,
      { measuredTtsOverruns: payload.measuredTtsOverruns }
    );
    initialCandidateHash = buildScriptCandidateHash(initialScript);
    cachedReviews = [];
    cachedBest = null;
    effectiveRepairLimit = 0;
  }
  await persistScriptCandidate(initialScript, cachedReviews, cachedBest);
  const qualityResult = await runScriptQualityLoop(
    topic,
    factCheck,
    initialScript,
    jobContext,
    productionBrief,
    persistScriptCandidate,
    cachedReviews,
    cachedBest,
    effectiveRepairLimit,
    scriptContractHash
  );
  const script = qualityResult.script;
  if (!script.ttsText || !script.productionScript.length) {
    throw new Error("Codex가 대본 필수 항목을 충분히 만들지 못했습니다. 다시 생성해 주세요.");
  }

  jobContext?.progress(95, "대본 구조와 TTS 텍스트를 검사합니다.");
  db.exec("BEGIN");
  try {
    upsertScriptStatement.run(
      id,
      script.coreQuestion,
      script.coreConflict,
      script.coreMechanism,
      script.visibleFlow,
      script.turningPoint,
      script.uniqueDifferentiator,
      script.designIntervention,
      JSON.stringify(script.tradeoffs),
      JSON.stringify(script.limitations),
      JSON.stringify(script.productionScript),
      script.ttsText,
      JSON.stringify(script.notes),
      JSON.stringify({
        productionBriefId: productionBrief.id,
        generation: rawResult,
        qualityReviews: qualityResult.reviews,
        finalScript: script
      })
    );
    db.prepare("UPDATE tts_runs SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'").run(id);
    db.prepare("UPDATE shotlists SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'").run(id);
    if (topic.runLane === "production_canary") {
      db.prepare("UPDATE topics SET canary_ai_pass_at = NULL, canary_ai_pass_json = '{}', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    }
    updateTopicReviewStatement.run("verified", "script", id);
    if (qualityResult.titleOverride) {
      db.prepare("UPDATE topics SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(qualityResult.titleOverride, id);
    }
    db.exec("COMMIT");
    jobContext?.progress(98, "새 대본을 저장하고 이전 미디어 산출물을 만료 처리했습니다.");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getTopicDetailById(id);
  });
}

function updateTopicStatus(payload) {
  const id = Number(payload.id);
  const lifecycleStatus = String(payload.lifecycleStatus || "").trim();
  const allowed = new Set(["candidate", "fact_checking", "script", "shotlist", "prompts", "assets", "produced", "dropped"]);

  if (!id || !allowed.has(lifecycleStatus)) {
    throw new Error("유효한 topic id와 상태가 필요합니다.");
  }

  updateLifecycleStatement.run(lifecycleStatus, id);
  const topic = getTopicStatement.get(id);
  if (!topic) {
    throw new Error("주제를 찾을 수 없습니다.");
  }

  return { topic };
}

function getTopicDetailById(id) {
  const topic = getTopicStatement.get(id);
  if (!topic) {
    throw new Error("주제를 찾을 수 없습니다.");
  }

  const latestShotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(id));
  return {
    topic: mapTopicRow(topic),
    factCheck: mapFactCheckRow(getFactCheckByTopicStatement.get(id)),
    productionBrief: mapProductionBriefRow(getProductionBriefByTopicStatement.get(id)),
    benchmarkCase: mapBenchmarkCaseRow(getBenchmarkCaseByTopicStatement.get(id)),
    script: mapScriptRow(getScriptByTopicStatement.get(id)),
    shotlist: latestShotlist?.status === "stale" ? null : latestShotlist
  };
}

function parseAssetQcManifest(markdown) {
  const notes = [];
  const statuses = new Map();
  const rows = String(markdown || "").split(/\r?\n/u);
  let inNotes = false;

  for (const row of rows) {
    if (row.startsWith("## QC")) {
      inNotes = true;
      continue;
    }
    if (inNotes && row.startsWith("## ")) {
      inNotes = false;
    }
    if (inNotes && row.startsWith("- ")) {
      notes.push(row.slice(2).trim());
    }
    if (!row.startsWith("|")) continue;
    const cells = row.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 4 || !/^\d+$/u.test(cells[0])) continue;
    statuses.set(cells[1], {
      status: cells[2],
      note: cells[3]
    });
  }

  return { notes, statuses };
}

async function listProjectFiles(folder, suffix, statusMap = new Map(), defaultStatus = "REVIEW") {
  try {
    const names = await readdir(folder);
    return Promise.all(names
      .filter((name) => name.endsWith(suffix))
      .sort((a, b) => a.localeCompare(b, "ko"))
      .map(async (name) => {
        const absolute = path.join(folder, name);
        const fileStat = await stat(absolute);
        const manifestStatus = statusMap.get(name);
        let autoQc = {};
        try {
          autoQc = JSON.parse(await readFile(`${absolute}.qc.json`, "utf8"));
        } catch {
          autoQc = {};
        }
        return {
          name,
          url: pathToStaticUrl(absolute),
          path: toRelativeWorkspacePath(absolute),
          size: fileStat.size,
          updatedAt: fileStat.mtime.toISOString(),
          status: manifestStatus?.status || defaultStatus,
          note: manifestStatus?.note || "",
          autoQc
        };
      }));
  } catch {
    return [];
  }
}

function applyStoredAssetReviews(topicId, assetType, assets) {
  const rows = db.prepare(`
    SELECT asset_path AS assetPath, status, note, auto_qc_json AS autoQcJson
    FROM asset_reviews WHERE topic_id = ? AND asset_type = ?
  `).all(topicId, assetType);
  const byPath = new Map(rows.map((row) => [String(row.assetPath).replace(/\\/gu, "/"), row]));
  return assets.map((asset) => {
    const review = byPath.get(String(asset.path).replace(/\\/gu, "/"));
    const provenance = parseStoredJson(review?.autoQcJson, {});
    const merged = review ? { ...asset, status: review.status, note: review.note, autoQc: { ...asset.autoQc, ...provenance } } : asset;
    return merged.autoQc?.passed === true && merged.status === "REVIEW"
      ? { ...merged, status: "AI_PASS", note: merged.note || "저장된 자동 QC와 AI 검수를 통과했습니다." }
      : merged;
  });
}

function readAssetQc(filePath) {
  try {
    return JSON.parse(readFileSync(`${filePath}.qc.json`, "utf8"));
  } catch {
    return {};
  }
}

function getCurrentAiPassedAssetIndexes(topicId, shotlist, assetType) {
  if (!shotlist?.id || !Array.isArray(shotlist.items) || !["clean", "info"].includes(assetType)) return [];
  const projectDir = getProjectDir(topicId);
  const folder = assetType === "clean" ? "clean" : "info";
  const suffix = assetType === "clean" ? "_CLEAN.png" : "_INFO.png";
  return shotlist.items.filter((item) => {
    const assetPath = path.join(projectDir, folder, `${item.fileStub}${suffix}`);
    if (!existsSync(assetPath)) return false;
    const autoQc = readAssetQc(assetPath);
    const independentPassed = autoQc.independentSemantic?.passed === true
      || autoQc.semantic?.passed === true;
    return autoQc.passed === true
      && independentPassed
      && isAssetCurrentForShotlist(autoQc, shotlist.id);
  }).map((item) => Number(item.sortIndex));
}

function isAssetCurrentForShotlist(assetOrQc, shotlistId) {
  const autoQc = assetOrQc?.autoQc || assetOrQc || {};
  return Number(shotlistId) > 0 && Number(autoQc.shotlistId || 0) === Number(shotlistId);
}

function isAiVerifiedAssetStatus(status) {
  return ["AI_PASS", "OK"].includes(String(status || "").toUpperCase());
}

function markStaleShotlistAssets(assets, shotlistId, assetLabel) {
  return assets.map((asset) => {
    if (isAssetCurrentForShotlist(asset, shotlistId)) return asset;
    return {
      ...asset,
      status: "REPLACE_CANDIDATE",
      note: `${assetLabel}가 현재 장면표가 아닌 이전 장면표에서 생성되었습니다.`,
      autoQc: {
        ...(asset.autoQc || {}),
        passed: false,
        stale: true,
        currentShotlistId: Number(shotlistId || 0)
      }
    };
  });
}

function reviewAsset(payload) {
  const topicId = Number(payload.topicId);
  const clipIndex = Number(payload.clipIndex);
  const assetType = String(payload.assetType || "").trim().toLowerCase();
  const assetPath = String(payload.assetPath || "").trim().replace(/\\/gu, "/");
  const status = String(payload.status || "").trim().toUpperCase();
  const note = String(payload.note || "").trim().slice(0, 1000);
  if (!topicId || !clipIndex || !["clean", "info"].includes(assetType) || !["AI_PASS", "OK", "REVIEW", "REPLACE_CANDIDATE"].includes(status)) {
    throw new Error("유효한 주제, 장면, 자산 종류와 검수 상태가 필요합니다.");
  }
  const absolute = resolveWorkspacePath(assetPath);
  const expectedRoot = path.resolve(getProjectDir(topicId));
  if (!path.resolve(absolute).startsWith(`${expectedRoot}${path.sep}`) || !existsSync(absolute)) {
    throw new Error("프로젝트 안에 존재하는 자산만 검수할 수 있습니다.");
  }
  if (["AI_PASS", "OK"].includes(status)) {
    const autoQc = readAssetQc(absolute);
    const shotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
    if (autoQc.passed !== true) throw new Error(`자동 ${assetType.toUpperCase()} QC를 통과한 이미지에만 승인할 수 있습니다.`);
    if (!shotlist || !isAssetCurrentForShotlist(autoQc, shotlist.id)) {
      throw new Error("현재 장면표에서 생성한 이미지만 승인할 수 있습니다.");
    }
  }
  const provenance = {
    assetHashBefore: String(payload.previousAssetHash || ""),
    assetHashAfter: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    manualInstruction: note,
    infoSpec: payload.infoSpec || null,
    layout: payload.layout || null,
    resolvedFindingCodes: Array.isArray(payload.resolvedFindingCodes) ? payload.resolvedFindingCodes : [],
    reviewedAt: new Date().toISOString()
  };
  db.prepare(`
    INSERT INTO asset_reviews (topic_id, clip_index, asset_type, asset_path, status, note, auto_qc_json, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(topic_id, clip_index, asset_type, asset_path) DO UPDATE SET
      status = excluded.status, note = excluded.note, auto_qc_json = excluded.auto_qc_json,
      reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run(topicId, clipIndex, assetType, assetPath, status, note, JSON.stringify({ manualProvenance: provenance }));
  return { topicId, clipIndex, assetType, assetPath, status, note, provenance };
}

async function finalizeCleanAssetsAndGenerateInfo(payload) {
  const topicId = Number(payload.topicId);
  if (!topicId) throw new Error("topicId가 필요합니다.");
  const assets = await listProjectAssetsForTopic(topicId);
  if (!assets.shotlistApproved) throw new Error("장면표 승인이 먼저 필요합니다.");
  const activeCleanJobs = (assets.cleanJobs || []).filter((job) => ["queued", "running"].includes(job.status));
  if (activeCleanJobs.length) throw new Error("진행 중인 CLEAN 이미지 생성이 끝난 뒤 최종 확정하세요.");
  if (!assets.expectedCount || assets.clean.length !== assets.expectedCount) {
    throw new Error(`CLEAN 이미지가 ${assets.clean.length}/${assets.expectedCount || "-"}장이라 최종 확정할 수 없습니다.`);
  }
  const failedQc = assets.clean.filter((asset) => asset.autoQc?.passed !== true);
  if (failedQc.length) {
    throw new Error(`자동 QC를 통과하지 못한 CLEAN ${failedQc.length}장을 먼저 교체하세요.`);
  }

  runDbTransaction(() => {
    for (const asset of assets.clean) {
      const clipIndex = Number(String(asset.name || "").match(/^(\d+)/u)?.[1] || 0);
      if (!clipIndex) throw new Error(`장면 번호를 확인할 수 없는 CLEAN 파일입니다: ${asset.name}`);
      reviewAsset({
        topicId,
        clipIndex,
        assetType: "clean",
        assetPath: asset.path,
        status: "OK",
        note: "CLEAN 전체 최종 확정"
      });
    }
  });
  return {
    topicId,
    approvedCount: assets.clean.length
  };
}

async function finalizeInfoAssets(payload) {
  const topicId = Number(payload.topicId);
  if (!topicId) throw new Error("topicId가 필요합니다.");
  const assets = await listProjectAssetsForTopic(topicId);
  if (!assets.shotlistApproved) throw new Error("장면표 승인이 먼저 필요합니다.");
  if (assets.infoPlanStale) throw new Error("INFO 의미 설계가 구버전입니다. 먼저 INFO 다시 설계·생성을 실행하세요.");
  const activeInfoJob = db.prepare(`
    SELECT id FROM jobs
    WHERE topic_id = ? AND type = 'info_image_generate' AND status IN ('queued', 'running')
    ORDER BY id DESC LIMIT 1
  `).get(topicId);
  if (activeInfoJob) throw new Error("진행 중인 INFO 이미지 생성이 끝난 뒤 최종 승인하세요.");
  if (!assets.expectedCount || assets.info.length !== assets.expectedCount) {
    throw new Error(`INFO 이미지가 ${assets.info.length}/${assets.expectedCount || "-"}장이라 최종 승인할 수 없습니다.`);
  }
  const failedQc = assets.info.filter((asset) => asset.autoQc?.passed !== true);
  if (failedQc.length) {
    throw new Error(`자동 QC를 통과하지 못한 INFO ${failedQc.length}장을 먼저 교체하세요.`);
  }
  const replaceCandidates = assets.info.filter((asset) => asset.status === "REPLACE_CANDIDATE");
  if (replaceCandidates.length) {
    throw new Error(`교체가 필요한 INFO ${replaceCandidates.length}장을 먼저 수정하세요.`);
  }

  runDbTransaction(() => {
    for (const asset of assets.info) {
      const clipIndex = Number(String(asset.name || "").match(/^(\d+)/u)?.[1] || 0);
      if (!clipIndex) throw new Error(`장면 번호를 확인할 수 없는 INFO 파일입니다: ${asset.name}`);
      reviewAsset({
        topicId,
        clipIndex,
        assetType: "info",
        assetPath: asset.path,
        status: "OK",
        note: "INFO 전체 최종 승인"
      });
    }
  });
  return { topicId, approvedCount: assets.info.length };
}

function updateScenePrompt(payload) {
  const topicId = Number(payload.topicId);
  const clipIndex = Number(payload.clipIndex);
  const type = String(payload.type || "").trim().toLowerCase();
  const prompt = String(payload.prompt || "").trim();
  if (!topicId || !clipIndex || !["clean", "info", "video"].includes(type)) {
    throw new Error("유효한 주제, 장면 번호와 프롬프트 종류가 필요합니다.");
  }
  if (!prompt || prompt.length > 12000) throw new Error("수정할 프롬프트를 입력하세요.");
  const shotlist = getLatestShotlistByTopicStatement.get(topicId);
  if (!shotlist || shotlist.status === "stale") throw new Error("수정할 최신 장면표가 없습니다.");
  const item = db.prepare("SELECT id FROM shotlist_items WHERE shotlist_id = ? AND sort_index = ?").get(shotlist.id, clipIndex);
  if (!item) throw new Error("수정할 장면을 찾지 못했습니다.");
  if (type === "info" && payload.infoSpec) {
    const infoSpec = normalizeInfoGraphicSpec(payload.infoSpec);
    const issues = getInfoGraphicSpecIssues(infoSpec);
    if (issues.length) throw new Error(`INFO 명세가 불완전합니다: ${issues.join(", ")}`);
    db.prepare("UPDATE shotlist_items SET info_spec_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(JSON.stringify(infoSpec), item.id);
    markVideoJobsStale(topicId, clipIndex, "INFO 설계 명세가 변경되었습니다.");
    return { ok: true, topicId, clipIndex, type, prompt, infoSpec };
  }
  const statements = {
    clean: db.prepare("UPDATE shotlist_items SET clean_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"),
    info: db.prepare("UPDATE shotlist_items SET info_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"),
    video: db.prepare("UPDATE shotlist_items SET video_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  };
  statements[type].run(prompt, item.id);
  if (type === "clean" || type === "info" || type === "video") {
    markVideoJobsStale(topicId, clipIndex, `${type.toUpperCase()} 제작 지시가 변경되었습니다.`);
  }
  return { ok: true, topicId, clipIndex, type, prompt };
}

function refreshShotlistContracts(payload) {
  const topicId = Number(payload.topicId);
  if (!topicId) throw new Error("topicId가 필요합니다.");
  const topic = mapTopicRow(getTopicStatement.get(topicId));
  const script = mapScriptRow(getScriptByTopicStatement.get(topicId));
  const shotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
  if (!topic || !script || !shotlist || shotlist.status === "stale") throw new Error("갱신할 최신 장면표가 없습니다.");
  const benchmark = mapBenchmarkCaseRow(getBenchmarkCaseByTopicStatement.get(topicId));
  const fixture = benchmark?.expectations?.productionBrief;
  const productionBrief = fixture
    ? normalizeProductionBrief(fixture, topic.mainTopic)
    : mapProductionBriefRow(getProductionBriefByTopicStatement.get(topicId));
  if (!productionBrief?.visualStates?.length) throw new Error("갱신할 제작 설계서가 없습니다.");
  const requested = Array.isArray(payload.clipIndexes)
    ? new Set(payload.clipIndexes.map(Number).filter(Boolean))
    : null;
  const visualStates = new Map(productionBrief.visualStates.map((state) => [state.stateId, state]));
  const update = db.prepare(`
    UPDATE shotlist_items SET
      shot_role = ?, visual_family = ?, scene_purpose = ?, clean_content = ?, camera_motion = ?,
      motion_policy = ?, required_visible_json = ?, forbidden_visible_json = ?, transition_end_state = ?,
      physical_state = ?, state_change_reason = ?, info_spec_json = ?, clean_prompt = ?, info_prompt = ?,
      video_prompt = ?, evidence_beat_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const refreshed = [];
  for (const item of shotlist.items) {
    if (requested && !requested.has(item.sortIndex)) continue;
    const row = getProductionScriptRow(script, item.sourceSegmentIndex);
    const visualState = visualStates.get(row.visualStateId || item.visualStateId);
    const evidenceBeat = visualState?.evidenceBeats?.[item.sourceSegmentOrder - 1];
    if (!visualState || !evidenceBeat) throw new Error(`${item.sortIndex}번 장면의 승인 증거 비트를 찾을 수 없습니다.`);
    const scenePurpose = evidenceBeat.purpose;
    const physicalState = evidenceBeat.physicalState;
    const stateChangeReason = `${evidenceBeat.label}: ${evidenceBeat.purpose}`;
    const cleanContent = `${physicalState} ${scenePurpose}`;
    const cameraMotion = evidenceBeat.cameraMotion || item.cameraMotion;
    const motionPolicy = evidenceBeat.motionPolicy || item.motionPolicy;
    const transitionEndState = evidenceBeat.transitionEndState || item.transitionEndState;
    const requiredVisibleElements = [...new Set(evidenceBeat.requiredVisibleElements || [])];
    const forbiddenVisibleElements = [...new Set([
      ...(visualState.forbiddenVisibleElements || []),
      ...(evidenceBeat.forbiddenVisibleElements || [])
    ])];
    const infoSpec = evidenceBeat.infoGraphic || normalizeInfoGraphicSpec({ type: "none" }, evidenceBeat);
    const promptRow = { ...row, stateChangeReason, shotRole: evidenceBeat.shotRole };
    const cleanPrompt = buildCleanPrompt({
      topic, script, row: promptRow, sceneId: item.sceneId, keyframeId: item.keyframeId,
      cleanContent, physicalState, cameraMotion, shotRole: evidenceBeat.shotRole,
      visualFamily: evidenceBeat.visualFamily, requiredVisibleElements, forbiddenVisibleElements,
      transitionEndState, infoSpec
    });
    const infoPrompt = buildInfoPrompt({
      topic, row: { ...promptRow, mechanismStep: scenePurpose, forceFlow: item.forceFlow },
      sceneId: item.sceneId, keyframeId: item.keyframeId, infoFocus: item.infoFocus,
      forceFlow: item.forceFlow, claimRefs: item.claimRefs, infoSpec
    });
    const videoPrompt = buildMdVideoPrompt({
      topic, sceneId: item.sceneId, keyframeId: item.keyframeId, clipId: item.clipId,
      cameraMotion, forceFlow: item.forceFlow, scenePurpose, motionPolicy, transitionEndState
    });
    update.run(
      evidenceBeat.shotRole, evidenceBeat.visualFamily, scenePurpose, cleanContent, cameraMotion,
      motionPolicy, JSON.stringify(requiredVisibleElements), JSON.stringify(forbiddenVisibleElements),
      transitionEndState, physicalState, stateChangeReason, JSON.stringify(infoSpec), cleanPrompt,
      infoPrompt, videoPrompt, evidenceBeat.beatId, item.id
    );
    markVideoJobsStale(topicId, item.sortIndex, "증거 비트 계약이 갱신되었습니다.");
    refreshed.push(item.sortIndex);
  }
  recordTopicAttempt(topicId, "shotlist_contract", "ready", `증거 비트 계약 ${refreshed.length}개를 승인 장면표에 반영했습니다.`, {
    clipIndexes: refreshed,
    source: fixture ? `benchmark:${benchmark.caseKey}` : `production-brief:${productionBrief.id}`
  });
  return { topicId, shotlistId: shotlist.id, refreshed, shotlist: mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId)) };
}

async function runCodexImageTask(prompt, jobContext) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("이미지 생성 시간이 8분을 넘어 중단했습니다.")), 480000);
  const externalAbort = () => controller.abort(jobContext?.signal?.reason || new Error("작업이 취소되었습니다."));
  jobContext?.signal?.addEventListener("abort", externalAbort, { once: true });
  if (jobContext?.signal?.aborted) externalAbort();
  const models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]
    .slice(0, CODEX_MODEL_ATTEMPT_LIMIT);

  try {
    for (const [modelIndex, model] of models.entries()) {
      try {
        const thread = codexClient.startThread({
          model,
          workingDirectory: __dirname,
          skipGitRepoCheck: true,
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          networkAccessEnabled: true
        });
        const { events } = await thread.runStreamed(prompt, { signal: controller.signal });
        let finalResponse = "";
        let completedItems = 0;
        for await (const event of events) {
          if (event.type === "item.completed") {
            completedItems += 1;
            jobContext?.progress(Math.min(88, 18 + completedItems * 12), "내장 ImageGen이 CLEAN 이미지를 생성하고 저장하고 있습니다.");
            if (event.item.type === "agent_message") finalResponse = event.item.text;
          }
          if (event.type === "turn.failed") throw new Error(event.error?.message || "이미지 생성 작업이 실패했습니다.");
          if (event.type === "error") throw new Error(event.message || "이미지 생성 스트림 오류가 발생했습니다.");
        }
        return finalResponse;
      } catch (error) {
        const message = String(error.message || error);
        const retryable = /capacity|overloaded|temporarily unavailable|rate limit|stream disconnected before completion/iu.test(message);
        if (!retryable || modelIndex === models.length - 1 || controller.signal.aborted) throw error;
        jobContext?.progress(16, `이미지 작업 모델이 혼잡해 ${models[modelIndex + 1]}로 자동 전환합니다.`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    throw new Error("사용 가능한 이미지 생성 작업 모델이 없습니다.");
  } finally {
    clearTimeout(timeout);
    jobContext?.signal?.removeEventListener("abort", externalAbort);
  }
}

async function reviewCleanImageWithAi({ topic, item, outputPath, referencePath, factCheck, attempt, jobContext, reviewer = {} }) {
  const prompt = `
  You are an independent visual quality reviewer. Inspect the generated CLEAN image with view_image. Do not edit it.

${buildQualityReviewerContext("clean_visual_quality", reviewer)}

Generated image: ${outputPath}
${referencePath && existsSync(referencePath) ? `Continuity reference: ${referencePath}\nInspect it only when continuity is required.` : "No continuity reference is required for this scene."}

Review rules:
- Judge only visible pixels, not the prompt's intention.
- Every required visible element must be clearly recognizable without text or INFO graphics.
- Judge the requested CLEAN physical state as one sharp instant. Do not require movement direction to be encoded with blur, arrows, ghosting, or repeated poses; direction belongs to the later video transition.
- When the scene has a non-none INFO type, do not require labels, guides, previous poses, second endpoints, comparison outlines, or overlay-only relationships in CLEAN. Require only the base geometry and valid anchors.
- Reject baked motion blur or contradictory sharp/blurred treatment across rigidly connected parts.
- Reject blur padding, letterboxing, or a small sharp original/inset surrounded by blurred pixels; CLEAN must be a single sharp cover composition.
- Reject a generic exterior or beauty shot that does not explain the scene purpose.
- Reject text, labels, arrows, watermarks, split screens, impossible geometry, contradictory states, or an image unsuitable as a restrained image-to-video first frame.
- When a continuity reference is supplied, preserve subject identity and stable materials, but allow the requested camera scale and physical state to differ.
- Score must be at least 0.82 to pass. Any physical, direction, missing-required, padding, or forbidden-element issue must fail.

Topic and verified scope:
${JSON.stringify({ title: topic.title, coreClaim: factCheck?.coreClaim || "", simplifications: factCheck?.simplifications || [] }, null, 2)}

Scene contract:
${JSON.stringify({
    clipIndex: item.sortIndex,
    shotRole: item.shotRole,
    scenePurpose: item.scenePurpose,
    cleanContent: item.cleanContent,
    physicalState: item.physicalState,
    stateChangeReason: item.stateChangeReason,
    forceFlow: item.forceFlow,
    laterInfoType: item.infoSpec?.type || "none",
    requiredVisibleElements: item.requiredVisibleElements,
    forbiddenVisibleElements: item.forbiddenVisibleElements
  }, null, 2)}
`.trim();
  const review = await runCodexJson(prompt, `clean-visual-review-${topic.id}-${item.sortIndex}-${attempt}-${reviewer.role || "evidence"}`, 180000, {
    signal: jobContext?.signal,
    outputSchema: CLEAN_VISUAL_REVIEW_OUTPUT_SCHEMA,
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]
  });
  review.issues = (review.issues || []).map((issue) => ({
    ...issue,
    sceneIndexes: Array.isArray(issue?.sceneIndexes) && issue.sceneIndexes.length ? issue.sceneIndexes : [item.sortIndex]
  }));
  review.passed = Boolean(review.passed && Number(review.score || 0) >= 0.82 && !review.issues.length);
  return review;
}

async function reviewCleanImageConsensus(args) {
  return runQualityConsensus({
    stage: "clean_visual_quality",
    topicId: args.topic.id,
    jobContext: args.jobContext,
    runReviewer: (reviewer) => reviewCleanImageWithAi({ ...args, reviewer })
  });
}

function extractOfficialCropContract(...sources) {
  const findBounds = (value, keys, depth = 0) => {
    if (!value || depth > 4 || typeof value !== "object") return null;
    for (const key of keys) {
      const bounds = normalizeNormalizedBounds(value[key]);
      if (bounds) return bounds;
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        const bounds = findBounds(nested, keys, depth + 1);
        if (bounds) return bounds;
      }
    }
    return null;
  };
  const findPanelSequence = (value, depth = 0) => {
    if (!value || depth > 4 || typeof value !== "object") return null;
    if (Array.isArray(value.panelSequence)) {
      const panels = value.panelSequence.map((panel) => ({
        ...panel,
        panelCrop: normalizeNormalizedBounds(panel?.panelCrop)
      }));
      if (panels.length === 2 && panels.every((panel) => panel.panelCrop)) return panels;
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") {
        const sequence = findPanelSequence(nested, depth + 1);
        if (sequence) return sequence;
      }
    }
    return null;
  };
  return {
    panelCrop: findBounds(sources, ["panelCrop"]),
    focusBounds: findBounds(sources, ["focusBounds"]),
    panelSequence: findPanelSequence(sources)
  };
}

function getOfficialVisualReference(item, factCheck, productionBrief) {
  const state = (productionBrief?.visualStates || []).find((candidate) => candidate.stateId === item.visualStateId);
  const evidence = (factCheck?.visualEvidence || []).find((candidate) => (
    (state?.evidenceRefs || []).includes(String(candidate?.id || candidate?.state || "").trim())
    && ["official_photo", "construction_photo", "official_diagram", "official_section"].includes(String(candidate?.referenceType || ""))
  ));
  return { state, evidence, crop: extractOfficialCropContract(state, evidence) };
}

async function resolveOfficialPanelSequenceInputs(topic, panelSequence) {
  if (!panelSequence) return [];
  const declaresSource = panelSequence.some((panel) => ["referenceId", "sourceUrl", "mediaUrl"].some((key) => String(panel?.[key] || "").trim()));
  if (!declaresSource) return [];
  if (topic.runLane !== "production_canary" || panelSequence.length !== 2 || panelSequence.some((panel) => !String(panel?.referenceId || "").trim() || !String(panel?.sourceUrl || "").trim() || !String(panel?.mediaUrl || "").trim())) {
    throw new Error("출처를 선언한 두 패널 CLEAN은 production canary manifest의 완전한 두 reference를 요구합니다.");
  }
  const { references } = loadProductionCanaryManifest(topic.externalKey);
  const referencesById = new Map(references.map((reference) => [reference.id, reference]));
  const assetsByReferenceId = new Map(getCanaryAssets(topic.id).map((asset) => [asset.referenceId, asset]));
  const paths = [];
  for (const panel of panelSequence) {
    const referenceId = String(panel.referenceId).trim();
    const reference = referencesById.get(referenceId);
    const asset = assetsByReferenceId.get(referenceId);
    if (!reference
      || reference.sourceUrl !== String(panel.sourceUrl).trim()
      || reference.mediaUrl !== String(panel.mediaUrl).trim()
      || !asset?.verified
      || asset.sourceUrl !== reference.sourceUrl
      || asset.mediaUrl !== reference.mediaUrl
      || asset.referenceType !== reference.referenceType
      || asset.verification?.mediaKind !== "image") {
      throw new Error(`두 패널 CLEAN의 ${referenceId} 검증 cached official source가 manifest와 일치하지 않습니다.`);
    }
    const cachedPath = resolveWorkspacePath(asset.cachedPath);
    try {
      if (!(await stat(cachedPath)).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`두 패널 CLEAN의 ${referenceId} cached official source 파일이 없습니다.`);
    }
    paths.push(cachedPath);
  }
  return paths;
}

async function ensureVisualReferenceBitmap(topicId, item, factCheck, productionBrief) {
  const { evidence, crop } = getOfficialVisualReference(item, factCheck, productionBrief);
  if (!evidence) return "";
  const sourceUrl = String(evidence.referenceSourceUrl || "").trim();
  const mediaUrl = String(evidence.referenceMediaUrl || "").trim();
  const pageNumber = Number(evidence.referencePage || 0);
  if (!mediaUrl && (!/\.pdf(?:$|[?#])/iu.test(sourceUrl) || pageNumber < 1)) return "";

  const referenceDir = path.join(PROJECTS_DIR, `topic-${topicId}`, "references");
  await mkdir(referenceDir, { recursive: true });
  const key = createHash("sha256").update(`${mediaUrl || sourceUrl}#${pageNumber}`).digest("hex").slice(0, 16);
  const outputPath = path.join(referenceDir, `${String(evidence.id || "visual").replace(/[^0-9a-z_-]/giu, "_")}-${key}.png`);
  if (existsSync(outputPath) && (await stat(outputPath)).size > 50000) return outputPath;

  const targetUrl = mediaUrl || sourceUrl;
  const response = await fetch(targetUrl, {
    signal: AbortSignal.timeout(30000),
    headers: { "User-Agent": "cinematic-shorts-dashboard/0.1 personal local visual reference" }
  });
  if (!response.ok) throw new Error(`공식 시각 참조를 내려받지 못했습니다: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > 25 * 1024 * 1024) throw new Error("공식 시각 참조가 25MB를 넘어 자동 다운로드를 중단했습니다.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 25 * 1024 * 1024) throw new Error("공식 시각 참조가 25MB를 넘어 자동 다운로드를 중단했습니다.");
  const isPdf = !mediaUrl && (String(response.headers.get("content-type") || "").includes("application/pdf") || buffer.subarray(0, 5).toString("ascii") === "%PDF-");
  const tempPath = path.join(referenceDir, `${key}.${isPdf ? "pdf" : "source"}`);
  await writeFile(tempPath, buffer);
  try {
    if (isPdf) {
      const outputPrefix = outputPath.replace(/\.png$/iu, "");
      await runProcess(PDFTOPPM_BIN, ["-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", "-png", "-r", "130", tempPath, outputPrefix], {
        timeoutMs: 120000
      });
    } else {
      await runProcess(PDF_PYTHON_BIN, [REFERENCE_IMAGE_RUNNER, tempPath, outputPath], {
        timeoutMs: 120000,
        env: { PYTHONIOENCODING: "utf-8" }
      });
    }
  } finally {
    await unlink(tempPath).catch(() => {});
  }
  if (!existsSync(outputPath) || (await stat(outputPath)).size < 50000) {
    throw new Error("공식 시각 참조를 PNG로 준비하지 못했습니다.");
  }
  await writeFile(`${outputPath}.json`, JSON.stringify({
    evidenceId: evidence.id,
    referenceType: evidence.referenceType,
    sourceUrl,
    mediaUrl,
    pageNumber,
    description: evidence.referenceDescription,
    crop
  }, null, 2), "utf8");
  return outputPath;
}

async function generateCleanImage(payload, jobContext = null) {
  const topicId = Number(payload.topicId);
  const clipIndex = Number(payload.clipIndex);
  if (!topicId || !clipIndex) throw new Error("주제와 CLEAN 장면 번호가 필요합니다.");
  const topic = mapTopicRow(getTopicStatement.get(topicId));
  const shotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
  const factCheck = mapFactCheckRow(getFactCheckByTopicStatement.get(topicId));
  const productionBrief = mapProductionBriefRow(getProductionBriefByTopicStatement.get(topicId));
  if (!topic || !shotlist || shotlist.status !== "approved") throw new Error("승인된 장면표가 필요합니다.");
  const item = shotlist.items.find((candidate) => candidate.sortIndex === clipIndex);
  if (!item) throw new Error(`${clipIndex}번 CLEAN 장면을 찾지 못했습니다.`);

  const projectDir = await ensureProjectFolders(topicId);
  const cleanDir = path.join(projectDir, "clean");
  await mkdir(cleanDir, { recursive: true });
  const outputPath = path.join(cleanDir, `${item.fileStub}_CLEAN.png`);
  if (existsSync(outputPath)) {
    const existingQc = readAssetQc(outputPath);
    if (existingQc.passed === true && isAssetCurrentForShotlist(existingQc, shotlist.id)) {
      return { topicId, clipIndex, outputPath: toRelativeWorkspacePath(outputPath), autoQc: existingQc, reused: true };
    }
    if (!(payload.preserveFailedArtifact && payload.replacementForQualityRepair)) {
      await unlink(outputPath).catch(() => {});
      await unlink(`${outputPath}.qc.json`).catch(() => {});
    }
  }

  const priorInFamily = shotlist.items
    .filter((candidate) => candidate.sortIndex < item.sortIndex && candidate.visualFamily === item.visualFamily)
    .at(-1);
  const canonicalItem = shotlist.items.find((candidate) => candidate.visualFamily === "exterior") || shotlist.items[0];
  const referenceItem = item.referencePolicy === "previous_in_family"
    ? priorInFamily
    : item.referencePolicy === "subject_identity"
      ? canonicalItem
      : null;
  const referencePath = referenceItem
    ? path.join(cleanDir, `${referenceItem.fileStub}_CLEAN.png`)
    : "";
  const canUseReference = referenceItem && referenceItem.sortIndex !== item.sortIndex && existsSync(referencePath);
  const { state: visualState, evidence: officialEvidence, crop: officialCrop } = getOfficialVisualReference(item, factCheck, productionBrief);
  const officialPanelSequencePaths = await resolveOfficialPanelSequenceInputs(topic, officialCrop.panelSequence);
  const officialReferencePath = await ensureVisualReferenceBitmap(topicId, item, factCheck, productionBrief);
  const officialReferenceContract = {
    visualStateId: item.visualStateId,
    label: visualState?.label || "",
    purpose: visualState?.purpose || item.scenePurpose,
    physicalState: visualState?.physicalState || item.physicalState,
    changeFromPrevious: visualState?.changeFromPrevious || item.stateChangeReason,
    requiredVisibleElements: visualState?.requiredVisibleElements || item.requiredVisibleElements,
    forbiddenVisibleElements: visualState?.forbiddenVisibleElements || item.forbiddenVisibleElements,
    referenceType: officialEvidence?.referenceType || "",
    referenceDescription: officialEvidence?.referenceDescription || "",
    panelCrop: officialCrop.panelCrop,
    focusBounds: officialCrop.focusBounds,
    panelSequence: officialCrop.panelSequence
  };
  const referenceInstruction = officialReferencePath
    ? `[Verified official visual reference]\nInspect this local official reference with the view_image tool: ${officialReferencePath}\nTarget state contract:\n${JSON.stringify(officialReferenceContract, null, 2)}\nIf the reference contains multiple panels or stages, first locate the single panel that visibly matches this target state. Use only that panel as the geometry source; do not average, blend, or borrow components from other stages. Preserve its topology, attachment points, and visible contact relationships exactly. Any elements described as connected must visibly touch at their anchors with no floating gap. Pass the focused matching panel to ImageGen when possible. Do not copy labels, typography, page layout, arrows, or the source composition into CLEAN.`
    : canUseReference
    ? `[Scoped visual reference]\nInspect this local CLEAN image with the view_image tool: ${referencePath}\nPass it to ImageGen only to preserve the required subject identity within the ${item.visualFamily} visual family. Keep the requested camera scale and physical state from this shot; do not copy the reference composition.`
    : `[Independent generation]\nGenerate from the production prompt without an input image. This shot intentionally uses the ${item.visualFamily} visual family, so do not imitate the first establishing shot. Maintain continuity through verified geometry, material, era, weather, and direction descriptions only.`;

  jobContext?.progress(8, `${item.sceneId} CLEAN 생성 프롬프트를 준비합니다.`);
  const prompt = `
Use the $imagegen skill and its built-in image generation tool to generate exactly one project-bound image.
Do not use the fallback CLI, OPENAI_API_KEY, SVG, HTML, placeholder art, or a contact sheet.

Required output:
- One portrait cinematic CLEAN image for a 9:16 engineering documentary short.
- Save the final generated bitmap at exactly: ${outputPath}
- The saved filename must remain exactly ${path.basename(outputPath)}.
- No text, letters, numbers, arrows, labels, UI, watermark, logo, split screen, collage, blur padding, letterbox, or small centered source inset.
- Fill the 9:16 frame with one sharp cover composition; do not add blurred surround or contained source borders.
- Generate the image from the production prompt below. Do not rewrite the physical direction or swap left and right.

[Continuity rules]
${(shotlist.raw?.continuityRules || []).map((rule) => `- ${rule}`).join("\n") || "- Preserve the same real structure and documentary visual identity across the sequence."}

${referenceInstruction}

[Semantic acceptance contract]
- Shot role: ${item.shotRole}
- Required visible elements: ${item.requiredVisibleElements.join(" | ")}
- Forbidden visible elements: ${item.forbiddenVisibleElements.join(" | ") || "none"}
- Reject a generic exterior beauty shot if it does not visibly explain this scene's physical state.

[Production prompt]
${item.cleanPrompt}

After generation, copy the selected final image into the exact required output path and verify that the file exists and is non-empty.
Then inspect the saved bitmap with view_image and report what is actually visible. Do not silently generate a second image inside this task; the quality controller decides whether another generation is justified.
Your final reply must be one JSON object only with this exact shape:
{"passed":true,"score":0.0,"foundRequiredElements":["..."],"missingRequiredElements":[],"foundForbiddenElements":[],"note":"short visual assessment"}
Set passed=true only when every required visible element is clearly recognizable, no forbidden element is present, and score is at least 0.72.
`.trim();
  const directOfficialReference = Boolean(officialReferencePath && officialEvidence && (officialCrop.panelCrop || officialCrop.focusBounds || officialCrop.panelSequence));
  let imageTaskResponse;
  if (directOfficialReference) {
    jobContext?.progress(30, `${item.sceneId} 검증된 공식 시각 근거를 CLEAN 세로 프레임으로 렌더합니다.`);
    const officialRendererArgs = [OFFICIAL_PHOTO_CLEAN_RUNNER, officialReferencePath, outputPath, "--crop-json", JSON.stringify(officialCrop)];
    if (officialPanelSequencePaths.length) officialRendererArgs.push("--panel-sequence-inputs", ...officialPanelSequencePaths);
    await runProcess(PDF_PYTHON_BIN, officialRendererArgs, {
      timeoutMs: 120000,
      env: { PYTHONIOENCODING: "utf-8" }
    });
    imageTaskResponse = JSON.stringify({
      passed: true,
      score: 1,
      foundRequiredElements: item.requiredVisibleElements,
      missingRequiredElements: [],
      foundForbiddenElements: [],
      note: "검증된 공식 시각 근거의 지정 panel crop을 새 형상 생성 없이 9:16 cover CLEAN으로 렌더했습니다."
    });
  } else {
    imageTaskResponse = await runCodexImageTask(prompt, jobContext);
  }
  if (!existsSync(outputPath)) throw new Error("CLEAN 출력 파일이 저장되지 않았습니다.");
  let outputStat = await stat(outputPath);
  if (!outputStat.isFile() || outputStat.size < 100000) throw new Error("생성된 CLEAN 파일이 비어 있거나 비정상적으로 작습니다.");
  jobContext?.progress(86, `${item.sceneId} 독립 시각 검수 AI가 물리 상태와 장면 목적을 확인합니다.`);
  const cleanReviews = [];
  const qualityStartedAt = Date.now();
  let qualityCycle = 1;
  let independentReview = await reviewCleanImageConsensus({
    topic,
    item,
    outputPath,
    referencePath: officialReferencePath || (canUseReference ? referencePath : ""),
    factCheck,
    attempt: 1,
    jobContext
  });
  cleanReviews.push(independentReview);
  while (!directOfficialReference && !independentReview.passed && shouldContinueQualityRepair(independentReview, qualityCycle, qualityStartedAt, 1)) {
    jobContext?.progress(88, `${item.sceneId} 품질 수렴 판단에 따라 실패 원인만 교정합니다: ${independentReview.convergence.reason}`);
    await unlink(outputPath).catch(() => {});
    const correctionFindings = cleanReviews.map((review) => ({
      score: review.score,
      observedState: review.observedState || "",
      issues: review.issues || [],
      repairInstruction: review.repairInstruction || "",
      summary: review.summary || ""
    }));
    const correctionPrompt = `${prompt}

[Independent reviewer correction]
The generated image was rejected. Generate one replacement, not a cosmetic edit, and correct only the confirmed issues below while preserving prior fixes.

[Geometry correction contract]
${JSON.stringify({ targetState: officialReferenceContract, rejectedOutputFindings: correctionFindings }, null, 2)}

Re-inspect the official reference before generating. For a multi-panel reference, identify the one panel whose visible physical state matches targetState and copy only that panel's topology and component relationships. Resolve every reviewer issue literally. In particular, when a reviewer reports a disconnected, detached, or floating component, its endpoint must visibly meet or overlap the named attachment anchor in the replacement pixels; proximity is not connection. Do not invent hidden mechanisms or import a later stage to make the repair.`;
    imageTaskResponse = await runCodexImageTask(correctionPrompt, jobContext);
    if (!existsSync(outputPath)) throw new Error("CLEAN 자동 교정 후 지정 파일이 저장되지 않았습니다.");
    outputStat = await stat(outputPath);
    if (!outputStat.isFile() || outputStat.size < 100000) throw new Error("자동 교정된 CLEAN 파일이 비정상적입니다.");
    qualityCycle += 1;
    independentReview = await reviewCleanImageConsensus({
      topic,
      item,
      outputPath,
      referencePath: officialReferencePath || (canUseReference ? referencePath : ""),
      factCheck,
      attempt: qualityCycle,
      jobContext
    });
    cleanReviews.push(independentReview);
  }
  jobContext?.progress(92, `${item.sceneId} 해상도, 세로 비율과 중복 여부를 자동 검사합니다.`);
  const references = (await readdir(cleanDir))
    .filter((name) => name.endsWith("_CLEAN.png") && path.join(cleanDir, name) !== outputPath)
    .map((name) => path.join(cleanDir, name));
  const autoQc = await inspectImageAsset(outputPath, references);
  let semanticQc;
  try {
    semanticQc = parseJsonFromText(imageTaskResponse);
  } catch {
    semanticQc = {
      passed: false,
      score: 0,
      foundRequiredElements: [],
      missingRequiredElements: item.requiredVisibleElements,
      foundForbiddenElements: [],
      note: "이미지 생성기가 구조화된 의미 검수 결과를 반환하지 않았습니다."
    };
  }
  autoQc.semantic = semanticQc;
  autoQc.independentSemantic = independentReview;
  autoQc.shotlistId = shotlist.id;
  autoQc.sceneId = item.sceneId;
  autoQc.fileStub = item.fileStub;
  autoQc.officialReference = officialReferencePath ? {
    renderer: directOfficialReference ? "deterministic_cover_crop" : "imagegen_reference",
    evidenceId: officialEvidence?.id || officialEvidence?.state || "",
    referenceType: officialEvidence?.referenceType || "",
    panelCrop: officialCrop.panelCrop,
    focusBounds: officialCrop.focusBounds
  } : null;
  autoQc.passed = Boolean(
    autoQc.passed
    && semanticQc.passed
    && Number(semanticQc.score || 0) >= 0.72
    && independentReview.passed
    && Number(independentReview.score || 0) >= 0.82
  );
  if (!semanticQc.passed || Number(semanticQc.score || 0) < 0.72) {
    autoQc.errors = [
      ...(autoQc.errors || []),
      `장면 의미 불일치: ${semanticQc.note || (semanticQc.missingRequiredElements || []).join(" / ") || "필수 물리 상태가 보이지 않음"}`
    ];
  }
  if (!independentReview.passed) {
    autoQc.errors = [
      ...(autoQc.errors || []),
      `독립 시각 검수 실패: ${independentReview.repairInstruction || independentReview.issues?.map((issue) => issue.message).join(" / ") || "물리 상태 불일치"}`
    ];
    recordTopicAttempt(topic.id, "clean_visual_quality", "failed", independentReview.repairInstruction || independentReview.observedState, {
      clipIndex: item.sortIndex,
      review: independentReview
    });
  }
  await writeFile(`${outputPath}.qc.json`, JSON.stringify(autoQc, null, 2), "utf8");
  const relativeOutputPath = toRelativeWorkspacePath(outputPath);
  if (!autoQc.passed) {
    reviewAsset({
      topicId,
      clipIndex,
      assetType: "clean",
      assetPath: relativeOutputPath,
      status: "REPLACE_CANDIDATE",
      note: `자동 QC 실패: ${autoQc.errors.join(" / ")}`
    });
    throw new Error(`CLEAN 자동 QC 실패: ${autoQc.errors.join(" / ")}`);
  }
  if (autoQc.warnings?.length) {
    autoQc.warnings = [...new Set(autoQc.warnings)];
  }
  reviewAsset({
    topicId,
    clipIndex,
    assetType: "clean",
    assetPath: relativeOutputPath,
    status: "AI_PASS",
    note: autoQc.warnings?.length
      ? `AI 검수 통과, 사용자 확인 권장: ${autoQc.warnings.join(" / ")}`
      : "기계적 QC와 통합 AI 시각 검수를 통과했습니다."
  });
  jobContext?.progress(96, `${item.sceneId} CLEAN 자동 검사를 완료했습니다.`);
  return {
    topicId,
    clipIndex,
    sceneId: item.sceneId,
    outputPath: relativeOutputPath,
    size: outputStat.size,
    autoQc,
    followUpClipIndexes: Array.isArray(payload.followUpClipIndexes) ? payload.followUpClipIndexes : [],
    reused: false
  };
}

async function enqueueCleanImageGeneration(payload) {
  const topicId = Number(payload.topicId);
  if (!topicId) throw new Error("topicId가 필요합니다.");
  const shotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
  if (!shotlist || shotlist.status !== "approved") throw new Error("장면표 승인이 먼저 필요합니다.");
  const projectDir = await ensureProjectFolders(topicId);
  const cleanDir = path.join(projectDir, "clean");
  await mkdir(cleanDir, { recursive: true });
  const existingAssets = await listProjectAssetsForTopic(topicId);
  const representativeGate = existingAssets.representativeGate || summarizeRepresentativeGate(topicId, shotlist);
  const scope = String(payload.scope || (representativeGate.enabled ? "sample" : "full"));
  if (scope === "full" && representativeGate.enabled && !representativeGate.imageProductionUnlocked) {
    throw new Error("대표 CLEAN·INFO 검수를 먼저 통과해야 전체 이미지를 생성할 수 있습니다.");
  }
  const requestedIndexes = Array.isArray(payload.clipIndexes)
    ? new Set(payload.clipIndexes.map(Number).filter(Boolean))
    : representativeGate.enabled && scope === "sample"
      ? new Set(representativeGate.cleanClipIndexes)
      : null;
  const targets = shotlist.items.filter((item) => {
    if (requestedIndexes && !requestedIndexes.has(item.sortIndex)) return false;
    const cleanPath = path.join(cleanDir, `${item.fileStub}_CLEAN.png`);
    const existingQc = readAssetQc(cleanPath);
    const current = existsSync(cleanPath)
      && existingQc.passed === true
      && isAssetCurrentForShotlist(existingQc, shotlist.id);
    return Boolean(payload.force || !current);
  });
  const preserveFailedArtifact = Boolean(payload.preserveFailedArtifact && payload.replacementForQualityRepair);
  const archivedFailedArtifacts = [];
  if (payload.force) {
    for (const item of targets) {
      const cleanPath = path.join(cleanDir, `${item.fileStub}_CLEAN.png`);
      if (preserveFailedArtifact) {
        archivedFailedArtifacts.push(await archiveFailedAssetForQualityRepair({
          topicId,
          clipIndex: item.sortIndex,
          assetType: "clean",
          primaryPath: cleanPath,
          artifactPaths: [cleanPath, `${cleanPath}.qc.json`],
          note: "독립 CLEAN 검수 실패 산출물"
        }));
      } else {
        db.prepare(`
          DELETE FROM asset_reviews
          WHERE topic_id = ? AND clip_index = ? AND asset_type = 'clean'
        `).run(topicId, item.sortIndex);
        await unlink(cleanPath).catch(() => {});
        await unlink(`${cleanPath}.qc.json`).catch(() => {});
      }
      const infoPath = path.join(projectDir, "info", `${item.fileStub}_INFO.png`);
      if (existsSync(infoPath)) {
        reviewAsset({
          topicId,
          clipIndex: item.sortIndex,
          assetType: "info",
          assetPath: toRelativeWorkspacePath(infoPath),
          status: "REPLACE_CANDIDATE",
          note: "CLEAN이 변경되어 INFO를 다시 생성해야 합니다."
        });
      }
      markVideoJobsStale(topicId, item.sortIndex, "CLEAN 이미지가 교체되었습니다.");
    }
  }
  const masterItem = targets.find((item) => item.visualFamily === "exterior") || targets[0];
  if (!masterItem) return { topicId, requested: 0, jobs: [], scope, representativeGate };
  const masterPath = path.join(cleanDir, `${masterItem.fileStub}_CLEAN.png`);
  const masterQc = readAssetQc(masterPath);
  const masterIsCurrent = existsSync(masterPath)
    && masterQc.passed === true
    && isAssetCurrentForShotlist(masterQc, shotlist.id);
  const convergencePayload = payload.autoConverge === true ? {
    autoConverge: true,
    pipeline: payload.pipeline || null
  } : {};
  let jobs;
  if (!masterIsCurrent) {
    const followUpClipIndexes = [...new Set(targets.map((item) => item.sortIndex).filter((index) => index !== masterItem.sortIndex))];
    jobs = [enqueueAiJob("clean_image_generate", topicId, {
      clipIndex: masterItem.sortIndex,
      followUpClipIndexes,
      preserveFailedArtifact,
      replacementForQualityRepair: preserveFailedArtifact,
      source: payload.source || "manual",
      ...convergencePayload
    }).job];
  } else {
    jobs = targets.map((item) => enqueueAiJob("clean_image_generate", topicId, {
      clipIndex: item.sortIndex,
      preserveFailedArtifact,
      replacementForQualityRepair: preserveFailedArtifact,
      source: payload.source || "manual",
      ...convergencePayload
    }).job);
  }
  return { topicId, requested: targets.length, jobs, scope, representativeGate, archivedFailedArtifacts };
}

function listCleanImageJobs(topicId) {
  const latestByClip = new Map();
  for (const row of db.prepare(`
    SELECT * FROM jobs WHERE topic_id = ? AND type = 'clean_image_generate' ORDER BY id DESC
  `).all(topicId)) {
    const job = mapJobRow(row);
    const clipIndex = Number(job.payload.clipIndex || 0);
    if (clipIndex && !latestByClip.has(clipIndex)) latestByClip.set(clipIndex, { ...job, clipIndex });
  }
  return [...latestByClip.values()].sort((a, b) => a.clipIndex - b.clipIndex);
}

function getRepresentativeGateDefinition(topicId, shotlist) {
  const benchmark = mapBenchmarkCaseRow(getBenchmarkCaseByTopicStatement.get(topicId));
  const configured = benchmark?.enabled ? benchmark.expectations?.representativeGate : null;
  if (!benchmark?.enabled || !shotlist?.items?.length) {
    return {
      enabled: false,
      benchmarkCaseId: benchmark?.id || null,
      cleanStateIds: [],
      infoStateIds: [],
      videoStateIds: [],
      cleanBeatIds: [],
      infoBeatIds: [],
      videoBeatIds: [],
      cleanClipIndexes: [],
      infoClipIndexes: [],
      videoClipIndexes: [],
      qualityPolicy: "convergence_v2"
    };
  }
  if (!configured) {
    const pickFirst = (roles, excluded = new Set()) => shotlist.items.find((item) => (
      roles.includes(item.shotRole) && !excluded.has(item.sortIndex)
    ));
    const selected = [];
    const used = new Set();
    for (const roles of [
      ["establishing", "context", "cause"],
      ["mechanism", "intervention", "constraint", "failure_simulation"],
      ["conclusion", "consequence", "response", "comparison"]
    ]) {
      const item = pickFirst(roles, used);
      if (!item) continue;
      selected.push(item);
      used.add(item.sortIndex);
    }
    if (selected.length < 3) {
      for (const item of shotlist.items) {
        if (used.has(item.sortIndex)) continue;
        selected.push(item);
        used.add(item.sortIndex);
        if (selected.length >= 3) break;
      }
    }
    const infoItem = selected.find((item) => item.infoSpec?.type && item.infoSpec.type !== "none")
      || shotlist.items.find((item) => item.infoSpec?.type && item.infoSpec.type !== "none")
      || selected[1]
      || selected[0];
    const videoItems = selected.filter((item) => ["mechanism", "intervention", "response", "conclusion", "comparison"].includes(item.shotRole));
    const effectiveVideoItems = videoItems.length ? videoItems.slice(0, 2) : selected.slice(-2);
    return {
      enabled: true,
      benchmarkCaseId: benchmark.id,
      caseKey: benchmark.caseKey,
      label: benchmark.label,
      cleanStateIds: [],
      infoStateIds: [],
      videoStateIds: [],
      cleanBeatIds: [],
      infoBeatIds: [],
      videoBeatIds: [],
      cleanClipIndexes: selected.map((item) => item.sortIndex),
      infoClipIndexes: [...new Set([infoItem?.sortIndex, ...effectiveVideoItems.map((item) => item.sortIndex)].filter(Boolean))],
      videoClipIndexes: effectiveVideoItems.map((item) => item.sortIndex),
      qualityPolicy: "convergence_v2"
    };
  }
  const firstClipByState = new Map();
  const clipByBeat = new Map();
  for (const item of shotlist.items) {
    const stateId = String(item.visualStateId || "").trim();
    if (stateId && !firstClipByState.has(stateId)) firstClipByState.set(stateId, item.sortIndex);
    const beatId = String(item.evidenceBeatId || "").trim();
    if (beatId) clipByBeat.set(beatId, item.sortIndex);
  }
  const indexesFor = (stateIds) => [...new Set((stateIds || []).map((stateId) => firstClipByState.get(stateId)).filter(Boolean))];
  const indexesForBeats = (beatIds) => [...new Set((beatIds || []).map((beatId) => clipByBeat.get(beatId)).filter(Boolean))];
  const cleanStateIds = configured.cleanStateIds || [];
  const infoStateIds = configured.infoStateIds || [];
  const videoStateIds = configured.videoStateIds || [];
  const cleanBeatIds = configured.cleanBeatIds || [];
  const infoBeatIds = configured.infoBeatIds || [];
  const videoBeatIds = configured.videoBeatIds || [];
  const videoClipIndexes = videoBeatIds.length ? indexesForBeats(videoBeatIds) : indexesFor(videoStateIds);
  return {
    enabled: true,
    benchmarkCaseId: benchmark.id,
    caseKey: benchmark.caseKey,
    label: benchmark.label,
    cleanStateIds,
    infoStateIds,
    videoStateIds,
    cleanBeatIds,
    infoBeatIds,
    videoBeatIds,
    cleanClipIndexes: cleanBeatIds.length ? indexesForBeats(cleanBeatIds) : indexesFor(cleanStateIds),
    infoClipIndexes: [...new Set([...(infoBeatIds.length ? indexesForBeats(infoBeatIds) : indexesFor(infoStateIds)), ...videoClipIndexes])],
    videoClipIndexes,
    qualityPolicy: "convergence_v2"
  };
}

function summarizeRepresentativeGate(topicId, shotlist, clean = [], info = []) {
  const gate = getRepresentativeGateDefinition(topicId, shotlist);
  if (!gate.enabled) return gate;
  const assetByIndex = (assets) => new Map(assets.map((asset) => [
    Number(String(asset.name || "").match(/^(\d+)/u)?.[1] || 0),
    asset
  ]));
  const cleanByIndex = assetByIndex(clean);
  const infoByIndex = assetByIndex(info);
  const latestVideos = new Map();
  for (const row of db.prepare("SELECT * FROM video_jobs WHERE topic_id = ? ORDER BY id DESC").all(topicId)) {
    if (!latestVideos.has(Number(row.clip_index))) latestVideos.set(Number(row.clip_index), mapVideoJob(row));
  }
  const approved = (indexes, values, predicate) => indexes.filter((index) => predicate(values.get(index)));
  const cleanAiPassedClipIndexes = approved(gate.cleanClipIndexes, cleanByIndex, (asset) => isAiVerifiedAssetStatus(asset?.status));
  const infoAiPassedClipIndexes = approved(gate.infoClipIndexes, infoByIndex, (asset) => isAiVerifiedAssetStatus(asset?.status));
  const cleanApprovedClipIndexes = approved(gate.cleanClipIndexes, cleanByIndex, (asset) => asset?.status === "OK");
  const infoApprovedClipIndexes = approved(gate.infoClipIndexes, infoByIndex, (asset) => asset?.status === "OK");
  const videoAiPassedClipIndexes = approved(gate.videoClipIndexes, latestVideos, (job) => (
    job?.status === "completed" && ["ai_passed", "approved"].includes(job?.qcStatus)
  ));
  const videoApprovedClipIndexes = approved(gate.videoClipIndexes, latestVideos, (job) => job?.status === "completed" && job?.qcStatus === "approved");
  const cleanAiPassed = gate.cleanClipIndexes.length > 0 && cleanAiPassedClipIndexes.length === gate.cleanClipIndexes.length;
  const infoAiPassed = gate.infoClipIndexes.length > 0 && infoAiPassedClipIndexes.length === gate.infoClipIndexes.length;
  const cleanPassed = gate.cleanClipIndexes.length > 0 && cleanApprovedClipIndexes.length === gate.cleanClipIndexes.length;
  const infoPassed = gate.infoClipIndexes.length > 0 && infoApprovedClipIndexes.length === gate.infoClipIndexes.length;
  const videoPassed = gate.videoClipIndexes.length > 0 && videoApprovedClipIndexes.length === gate.videoClipIndexes.length;
  const videoAiPassed = gate.videoClipIndexes.length > 0 && videoAiPassedClipIndexes.length === gate.videoClipIndexes.length;
  return {
    ...gate,
    cleanAiPassedClipIndexes,
    infoAiPassedClipIndexes,
    cleanApprovedClipIndexes,
    infoApprovedClipIndexes,
    videoAiPassedClipIndexes,
    videoApprovedClipIndexes,
    cleanAiPassed,
    infoAiPassed,
    cleanPassed,
    infoPassed,
    videoAiPassed,
    videoPassed,
    imageProductionUnlocked: cleanPassed && infoPassed,
    fullProductionUnlocked: cleanPassed && infoPassed && videoPassed
  };
}

async function listProjectAssetsForTopic(topicId) {
  if (!topicId) {
    throw new Error("topicId가 필요합니다.");
  }

  const topic = getTopicStatement.get(topicId);
  if (!topic) {
    throw new Error("주제를 찾을 수 없습니다.");
  }

  const projectDir = path.join(PROJECTS_DIR, `topic-${topicId}`);
  const cleanDir = path.join(projectDir, "clean");
  const infoDir = path.join(projectDir, "info");
  const videoDir = path.join(projectDir, "video");
  const manifestPath = path.join(projectDir, "manifests", "CLEAN_ASSETS.md");
  const contactSheetPath = path.join(projectDir, "manifests", "CLEAN_CONTACT_SHEET.jpg");

  let qc = { notes: [], statuses: new Map() };
  try {
    qc = parseAssetQcManifest(await readFile(manifestPath, "utf8"));
  } catch {
    qc = { notes: [], statuses: new Map() };
  }

  let [clean, info, video] = await Promise.all([
    listProjectFiles(cleanDir, "_CLEAN.png", qc.statuses),
    listProjectFiles(infoDir, "_INFO.png"),
    listProjectFiles(videoDir, ".mp4", new Map(), "REVIEW")
  ]);
  const shotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
  const ttsRun = mapTtsRunRow(getLatestTtsRunByTopicStatement.get(topicId));
  const expectedCleanNames = new Set((shotlist?.items || []).map((item) => `${item.fileStub}_CLEAN.png`));
  const expectedInfoNames = new Set((shotlist?.items || []).map((item) => `${item.fileStub}_INFO.png`));
  const orphanedClean = shotlist ? clean.filter((asset) => !expectedCleanNames.has(asset.name)) : [];
  const orphanedInfo = shotlist ? info.filter((asset) => !expectedInfoNames.has(asset.name)) : [];
  if (shotlist) {
    clean = clean.filter((asset) => expectedCleanNames.has(asset.name));
    info = info.filter((asset) => expectedInfoNames.has(asset.name));
  }
  clean = applyStoredAssetReviews(topicId, "clean", clean);
  info = applyStoredAssetReviews(topicId, "info", info);
  clean = markStaleShotlistAssets(clean, shotlist?.id, "CLEAN 이미지");
  info = markStaleShotlistAssets(info, shotlist?.id, "INFO 이미지");
  const expectedCount = shotlist?.clipCount || clean.length;
  const infoPlanStale = isInfoPlanStale(shotlist);
  const cleanReady = expectedCount > 0 && clean.length === expectedCount && clean.every((asset) => asset.status === "OK");
  const infoReady = !infoPlanStale && expectedCount > 0 && info.length === expectedCount && info.every((asset) => asset.status === "OK");
  const representativeGate = summarizeRepresentativeGate(topicId, shotlist, clean, info);
  const cleanPromptPath = path.join(projectDir, "prompts", "CLEAN_KEYFRAME_PROMPTS.md");
  const infoPromptPath = path.join(projectDir, "prompts", "INFOGRAPHIC_KEYFRAME_PROMPTS.md");

  return {
    topic: mapTopicRow(topic),
    ttsRun,
    shotlistId: shotlist?.id || null,
    expectedCount,
    clean,
    info,
    staleCleanCount: orphanedClean.length + clean.filter((asset) => asset.autoQc?.stale).length,
    staleInfoCount: orphanedInfo.length + info.filter((asset) => asset.autoQc?.stale).length,
    video,
    cleanReady,
    infoReady,
    representativeGate,
    infoPlanVersion: Number(shotlist?.raw?.infoPlanVersion || 0),
    infoPlanStale,
    cleanJobs: listCleanImageJobs(topicId),
    shotlistApproved: shotlist?.status === "approved",
    qcNotes: qc.notes,
    manifestUrl: existsSync(manifestPath) ? pathToStaticUrl(manifestPath) : "",
    contactSheetUrl: existsSync(contactSheetPath) ? pathToStaticUrl(contactSheetPath) : "",
    cleanPromptUrl: existsSync(cleanPromptPath) ? pathToStaticUrl(cleanPromptPath) : "",
    infoPromptUrl: existsSync(infoPromptPath) ? pathToStaticUrl(infoPromptPath) : ""
  };
}

async function listProjectAssets(url) {
  return listProjectAssetsForTopic(Number(url.searchParams.get("topicId")));
}

async function getVideoPlan(url) {
  const topicId = Number(url.searchParams.get("topicId"));
  if (!topicId) {
    throw new Error("topicId가 필요합니다.");
  }

  const topicRow = getTopicStatement.get(topicId);
  if (!topicRow) {
    throw new Error("주제를 찾을 수 없습니다.");
  }
  const topic = mapTopicRow(topicRow);
  const shotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
  if (!shotlist || shotlist.status !== "approved") {
    throw new Error("승인된 장면표가 먼저 필요합니다.");
  }

  const projectDir = path.join(PROJECTS_DIR, `topic-${topicId}`);
  const videoDir = path.join(projectDir, "video");
  const promptsDir = path.join(projectDir, "prompts");
  const manifestPath = path.join(promptsDir, "VIDEO_GENERATION_PROMPTS.md");
  await Promise.all([mkdir(videoDir, { recursive: true }), mkdir(promptsDir, { recursive: true })]);
  const assets = await listProjectAssetsForTopic(topicId);
  const { clean, info, video } = assets;

  const cleanByIndex = new Map(clean.map((asset) => [Number(String(asset.name).match(/^(\d+)/u)?.[1] || 0), asset]));
  const infoByIndex = new Map(info.map((asset) => [Number(String(asset.name).match(/^(\d+)/u)?.[1] || 0), asset]));
  const videoByIndex = new Map(video.map((asset) => [Number(String(asset.name).match(/^(\d+)/u)?.[1] || 0), asset]));
  const videoByPath = new Map(video.map((asset) => [asset.path.replace(/\\/gu, "/"), asset]));
  const latestJobs = new Map();
  for (const row of db.prepare("SELECT * FROM video_jobs WHERE topic_id = ? ORDER BY id DESC").all(topicId)) {
    if (!latestJobs.has(row.clip_index)) latestJobs.set(row.clip_index, mapVideoJob(row));
  }
  const clips = shotlist.items.map((item) => {
    const cleanAsset = cleanByIndex.get(item.sortIndex) || null;
    const infoAsset = infoByIndex.get(item.sortIndex) || null;
    const videoJob = latestJobs.get(item.sortIndex) || null;
    const jobOutputPath = String(videoJob?.outputPath || "").replace(/\\/gu, "/");
    const videoAsset = videoJob
      ? (videoJob.status === "completed" ? videoByPath.get(jobOutputPath) || null : null)
      : videoByIndex.get(item.sortIndex) || null;
    const videoName = `${String(item.sortIndex).padStart(2, "0")}_${item.clipId}_${item.sceneId}_${item.keyframeId}.mp4`;
    const officialPrompt = buildMdVideoPrompt({
      topic,
      sceneId: item.sceneId,
      keyframeId: item.keyframeId,
      clipId: item.clipId,
      cameraMotion: item.cameraMotion,
      forceFlow: item.forceFlow,
      scenePurpose: item.scenePurpose,
      motionPolicy: item.motionPolicy,
      transitionEndState: item.transitionEndState,
      durationSec: 4
    });
    const videoPrompt = String(item.videoPrompt || "").includes("integrated_multimodal_description:")
      ? item.videoPrompt
      : officialPrompt;
    return {
      sortIndex: item.sortIndex,
      visualStateId: item.visualStateId,
      sceneId: item.sceneId,
      keyframeId: item.keyframeId,
      clipId: item.clipId,
      scriptExcerpt: item.scriptExcerpt,
      scenePurpose: item.scenePurpose,
      cleanContent: item.cleanContent,
      cameraMotion: item.cameraMotion,
      forceFlow: item.forceFlow,
      shotRole: item.shotRole,
      visualFamily: item.visualFamily,
      motionPolicy: item.motionPolicy,
      transitionEndState: item.transitionEndState,
      cleanAsset,
      infoAsset,
      videoAsset,
      videoJob,
      expectedVideoName: videoName,
      prompt: cleanAsset && infoAsset ? videoPrompt : ""
    };
  });
  const missingCleanIndexes = clips.filter((clip) => !clip.cleanAsset).map((clip) => clip.sortIndex);
  const qcBlockedIndexes = clips
    .filter((clip) => clip.cleanAsset && clip.cleanAsset.status !== "OK")
    .map((clip) => clip.sortIndex);
  const missingInfoIndexes = clips.filter((clip) => !clip.infoAsset).map((clip) => clip.sortIndex);
  const infoQcBlockedIndexes = clips
    .filter((clip) => clip.infoAsset && clip.infoAsset.status !== "OK")
    .map((clip) => clip.sortIndex);
  const representativeGate = assets.representativeGate || summarizeRepresentativeGate(topicId, shotlist, clean, info);
  const representativeVideoClips = representativeGate.enabled
    ? clips.filter((clip) => representativeGate.videoClipIndexes.includes(clip.sortIndex))
    : [];
  const sampleGenerationReady = representativeGate.enabled
    && representativeVideoClips.length === representativeGate.videoClipIndexes.length
    && representativeVideoClips.every((clip) => (
      isAiVerifiedAssetStatus(clip.cleanAsset?.status)
      && isAiVerifiedAssetStatus(clip.infoAsset?.status)
    ));

  return {
    topic,
    shotlist: {
      id: shotlist.id,
      status: shotlist.status,
      clipCount: shotlist.clipCount,
      totalDurationSec: shotlist.totalDurationSec
    },
    cleanCount: clean.length,
    cleanApprovedCount: clips.filter((clip) => clip.cleanAsset?.status === "OK").length,
    cleanReady: missingCleanIndexes.length === 0 && qcBlockedIndexes.length === 0,
    infoCount: info.length,
    infoApprovedCount: clips.filter((clip) => clip.infoAsset?.status === "OK").length,
    infoReady: missingInfoIndexes.length === 0 && infoQcBlockedIndexes.length === 0,
    generationReady: missingCleanIndexes.length === 0 && qcBlockedIndexes.length === 0
      && missingInfoIndexes.length === 0 && infoQcBlockedIndexes.length === 0,
    sampleGenerationReady,
    representativeGate,
    missingCleanIndexes,
    qcBlockedIndexes,
    missingInfoIndexes,
    infoQcBlockedIndexes,
    videoCount: clips.filter((clip) => clip.videoAsset).length,
    videoVersionCount: video.length,
    videoApprovedCount: clips.filter((clip) => clip.videoJob?.status === "completed" && clip.videoJob?.qcStatus === "approved").length,
    videoRejectedCount: clips.filter((clip) => clip.videoJob?.qcStatus === "rejected").length,
    localH3: {
      ...getMinimaxH3LocalStatus(),
      serverOnline: await isComfyUiOnline()
    },
    clips,
    manifestPath: toRelativeWorkspacePath(manifestPath),
    manifestUrl: existsSync(manifestPath) ? pathToStaticUrl(manifestPath) : ""
  };
}

function splitLongCaptionToken(token, maxChars) {
  const chunks = [];
  let remaining = String(token || "");
  while (remaining.length > maxChars) {
    chunks.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function splitCaptionText(text, preset = DEFAULT_CAPTION_PRESET) {
  const maxChars = Number(preset.maxCharsPerLine || 17);
  const maxLines = Number(preset.maxLines || 2);
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .flatMap((word) => splitLongCaptionToken(word, maxChars));
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  const cues = [];
  for (let index = 0; index < lines.length; index += maxLines) {
    cues.push(lines.slice(index, index + maxLines).join("\n"));
  }
  return cues;
}

function buildCaptionCues(shotlist, ttsRun, preset = DEFAULT_CAPTION_PRESET) {
  const segmentByIndex = new Map((ttsRun.segments || []).map((segment) => [Number(segment.segmentIndex), segment]));
  const cues = [];
  const itemsBySegment = new Map();
  for (const item of shotlist.items) {
    const index = Number(item.sourceSegmentIndex);
    if (!itemsBySegment.has(index)) itemsBySegment.set(index, []);
    itemsBySegment.get(index).push(item);
  }
  for (const [sourceSegmentIndex, items] of itemsBySegment) {
    const segment = segmentByIndex.get(sourceSegmentIndex);
    const segmentStart = Math.min(...items.map((item) => Number(item.startSec)));
    const segmentEnd = Math.max(...items.map((item) => Number(item.endSec)));
    const speechDuration = Math.min(
      segmentEnd - segmentStart,
      Number(segment?.durationSec || segment?.estimatedDurationSec || segmentEnd - segmentStart)
    );
    const chunks = splitCaptionText(segment?.text || items[0]?.scriptExcerpt, preset);
    if (!chunks.length || speechDuration <= 0) continue;
    const weights = chunks.map((chunk) => Math.max(1, chunk.replace(/\s/g, "").length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let elapsed = 0;
    chunks.forEach((chunk, chunkIndex) => {
      const startSec = Number((segmentStart + elapsed).toFixed(3));
      const allocated = chunkIndex === chunks.length - 1
        ? speechDuration - elapsed
        : speechDuration * (weights[chunkIndex] / totalWeight);
      elapsed += allocated;
      cues.push({
        index: cues.length + 1,
        sourceSegmentIndex,
        startSec,
        endSec: Number((segmentStart + Math.min(speechDuration, elapsed)).toFixed(3)),
        text: chunk
      });
    });
  }
  return cues.filter((cue) => cue.endSec > cue.startSec);
}

function formatCaptionTimestamp(seconds, separator = ",") {
  const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

function renderSrt(cues) {
  return cues.map((cue, index) => [
    String(index + 1),
    `${formatCaptionTimestamp(cue.startSec)} --> ${formatCaptionTimestamp(cue.endSec)}`,
    cue.text,
    ""
  ].join("\n")).join("\n");
}

function renderVtt(cues) {
  const body = cues.map((cue) => [
    `${formatCaptionTimestamp(cue.startSec, ".")} --> ${formatCaptionTimestamp(cue.endSec, ".")}`,
    cue.text,
    ""
  ].join("\n")).join("\n");
  return `WEBVTT\n\n${body}`;
}

function localCaptionTextForClip(cues, clip) {
  const clipStart = Number(clip.position);
  const clipEnd = clipStart + Number(clip.duration);
  const localCues = cues
    .filter((cue) => cue.endSec > clipStart && cue.startSec < clipEnd)
    .map((cue) => ({
      startSec: Math.max(0, cue.startSec - clipStart),
      endSec: Math.min(Number(clip.duration), cue.endSec - clipStart),
      text: cue.text
    }));
  return renderSrt(localCues);
}

function isCaptionFontInstalled() {
  if (existsSync(DEFAULT_CAPTION_PRESET.fontPath)) return true;
  const fontDirectories = [
    path.join(__dirname, "assets", "fonts"),
    process.platform === "win32" ? "C:\\Windows\\Fonts" : ""
  ].filter(Boolean);
  const fontNamePattern = /(문화재돌봄|chdolbom|heritage.?care)/i;
  return fontDirectories.some((directory) => {
    try {
      return readdirSync(directory).some((name) => fontNamePattern.test(name));
    } catch {
      return false;
    }
  });
}

async function buildEditPlan(topicId, { writeManifest = false } = {}) {
  if (!topicId) {
    throw new Error("topicId가 필요합니다.");
  }
  if (!OPENSHOT_BIN || !existsSync(OPENSHOT_BIN) || !existsSync(OPENSHOT_CLI_BIN)) {
    throw new Error("OpenShot이 설치되어 있지 않습니다.");
  }
  if (!existsSync(OPENSHOT_VERTICAL_PROFILE)) {
    throw new Error("OpenShot 세로 720p/24fps 프로필을 찾지 못했습니다.");
  }

  const detail = getTopicDetailById(topicId);
  const shotlist = detail.shotlist;
  if (!shotlist) {
    throw new Error("장면표가 먼저 필요합니다.");
  }
  const ttsRun = mapTtsRunRow(getLatestTtsRunByTopicStatement.get(topicId));
  const narrationPath = resolveWorkspacePath(ttsRun?.outputPath || "");
  if (!ttsRun || ttsRun.status !== "generated" || !existsSync(narrationPath)) {
    throw new Error("생성 완료된 전체 TTS 파일이 필요합니다.");
  }

  const videoPlan = await getVideoPlan(new URL(`http://localhost:${PORT}/api/video-plan?topicId=${topicId}`));
  if (videoPlan.videoApprovedCount !== shotlist.clipCount) {
    throw new Error(`모든 MP4의 실제 화면 검수와 승인이 필요합니다. 현재 ${videoPlan.videoApprovedCount}/${shotlist.clipCount}개 승인.`);
  }
  const projectDir = path.join(PROJECTS_DIR, `topic-${topicId}`);
  const editDir = path.join(projectDir, "edit");
  const manifestPath = path.join(editDir, `topic-${topicId}.dinobox.json`);
  const clipsByIndex = new Map(videoPlan.clips.map((clip) => [clip.sortIndex, clip]));
  const videoClips = shotlist.items.map((item) => {
    const clip = clipsByIndex.get(item.sortIndex);
    const selectedAsset = clip?.videoJob?.qcStatus === "approved" ? clip.videoAsset : null;
    if (!selectedAsset) {
      throw new Error(`${item.sortIndex}번 장면의 승인된 MP4가 없습니다.`);
    }
    const sourcePath = resolveWorkspacePath(selectedAsset.path);
    const sourceDurationSec = Number(clip.videoJob?.actualDurationSec || probeVideoMetadata(sourcePath).duration || 0);
    const requiredDurationSec = Number(item.durationSec);
    if (!sourceDurationSec || sourceDurationSec + (1 / 24) < requiredDurationSec) {
      throw new Error(`${item.sortIndex}번 MP4가 ${requiredDurationSec.toFixed(2)}초 장면보다 짧습니다. 현재 ${sourceDurationSec.toFixed(2)}초이므로 영상을 다시 생성하세요.`);
    }
    return {
      sortIndex: item.sortIndex,
      path: sourcePath,
      title: `${String(item.sortIndex).padStart(2, "0")} ${item.scenePurpose}`,
      position: Number(item.startSec),
      sourceStart: 0,
      duration: requiredDurationSec,
      sourceDurationSec,
      playbackRate: 1,
      placeholder: false,
      scriptExcerpt: item.scriptExcerpt
    };
  });

  const captionCues = buildCaptionCues(shotlist, ttsRun);
  const captionStyle = { ...DEFAULT_CAPTION_PRESET, fontInstalled: isCaptionFontInstalled() };
  for (const clip of videoClips) {
    clip.captionText = localCaptionTextForClip(captionCues, clip);
    clip.captionStyle = captionStyle;
  }
  const captionsSrtPath = path.join(editDir, `topic-${topicId}.srt`);
  const captionsVttPath = path.join(editDir, `topic-${topicId}.vtt`);
  const editRevision = createHash("sha256").update(JSON.stringify({
    shotlistId: shotlist.id,
    ttsRunId: ttsRun.id,
    video: videoClips.map((clip) => clip.path),
    captions: captionCues,
    captionStyle
  })).digest("hex").slice(0, 10);
  const outputPath = path.join(editDir, `topic-${topicId}-edit-${editRevision}.osp`);

  const manifest = {
    schemaVersion: 4,
    topicId,
    title: detail.topic.title,
    generatedAt: new Date().toISOString(),
    editRevision,
    profile: "HD Vertical 720p 24 fps",
    profilePath: OPENSHOT_VERTICAL_PROFILE,
    outputPath,
    buildOnly: true,
    totalDurationSec: Number(shotlist.totalDurationSec),
    videoClips,
    playbackPolicy: "native_1x_trim_only",
    captions: {
      preset: captionStyle,
      cueCount: captionCues.length,
      srtPath: captionsSrtPath,
      vttPath: captionsVttPath
    },
    narration: {
      path: narrationPath,
      title: `TTS 전체 음성 · run-${ttsRun.id}`,
      position: 0,
      sourceStart: 0,
      duration: Number(ttsRun.totalDurationSec)
    }
  };

  if (writeManifest) {
    await mkdir(editDir, { recursive: true });
    await writeFile(captionsSrtPath, renderSrt(captionCues), "utf8");
    await writeFile(captionsVttPath, renderVtt(captionCues), "utf8");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  return {
    topicId,
    title: detail.topic.title,
    ready: true,
    editorInstalled: true,
    editorPath: OPENSHOT_BIN,
    profile: manifest.profile,
    totalDurationSec: manifest.totalDurationSec,
    clipCount: videoClips.length,
    videoCount: videoClips.filter((clip) => !clip.placeholder).length,
    infoCount: videoPlan.infoApprovedCount,
    placeholderCount: videoClips.filter((clip) => clip.placeholder).length,
    placeholderIndexes: videoClips.filter((clip) => clip.placeholder).map((clip) => clip.sortIndex),
    narrationPath: toRelativeWorkspacePath(narrationPath),
    captions: {
      preset: captionStyle,
      cueCount: captionCues.length,
      srtPath: toRelativeWorkspacePath(captionsSrtPath),
      vttPath: toRelativeWorkspacePath(captionsVttPath)
    },
    manifestPath: toRelativeWorkspacePath(manifestPath),
    projectPath: toRelativeWorkspacePath(outputPath),
    projectExists: existsSync(outputPath),
    editDir: toRelativeWorkspacePath(editDir),
    manifest
  };
}

async function getEditPlan(url) {
  return buildEditPlan(Number(url.searchParams.get("topicId")));
}

async function openEditProject(payload) {
  const plan = await buildEditPlan(Number(payload.topicId), { writeManifest: true });
  const manifestPath = resolveWorkspacePath(plan.manifestPath);
  const projectPath = resolveWorkspacePath(plan.projectPath);
  const editorEnv = { HOME: OPENSHOT_HOME, USERPROFILE: OPENSHOT_HOME };
  let created = false;
  if (!existsSync(projectPath)) {
    let buildError = null;
    try {
      await runProcess(OPENSHOT_CLI_BIN, [manifestPath], { env: editorEnv });
    } catch (error) {
      buildError = error;
    }
    if (!existsSync(projectPath)) {
      throw buildError || new Error("OpenShot 편집 프로젝트가 생성되지 않았습니다.");
    }
    created = true;
  }
  const child = spawn(OPENSHOT_BIN, [projectPath], {
    cwd: OPENSHOT_DIR,
    env: { ...process.env, ...editorEnv },
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  return { ...plan, launched: true, created };
}

async function openEditFolder(payload) {
  const plan = await buildEditPlan(Number(payload.topicId), { writeManifest: true });
  const folder = resolveWorkspacePath(plan.editDir);
  const child = spawn("explorer.exe", [folder], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  return { ...plan, folderOpened: true };
}

function renderVideoPromptsMarkdown(plan) {
  return [
    `# VIDEO_GENERATION_PROMPTS`,
    ``,
    `- Topic ID: ${plan.topic.id}`,
    `- 제목: ${plan.topic.title}`,
    `- 방식: MiniMax H3 로컬 ComfyUI FL2VA로 CLEAN 기반 무자막 움직임을 생성하고 INFO는 편집 트랙에서 합성`,
    `- 저장 폴더: data/projects/topic-${plan.topic.id}/video`,
    `- 목표 파일 수: ${plan.shotlist.clipCount}`,
    `- ComfyUI 경로: ${plan.localH3?.comfyuiDir || "미설정"}`,
    `- ComfyUI workflow: ${plan.localH3?.workflow || "video_minimax_h3_i2v.json"}`,
    ``,
    `## 공통 규칙`,
    ``,
    `- 첫 프레임은 같은 번호의 승인 CLEAN PNG를 사용한다.`,
    `- 마지막 목표 프레임도 CLEAN을 사용해 생성형 글자 왜곡을 차단한다.`,
    `- 출력 파일명은 각 장면의 expected MP4 이름을 사용한다.`,
    `- INFO는 생성 영상에 맡기지 않고 OpenShot의 검증 자산 트랙에서 정확히 표시한다.`,
    `- 새 자막, 새 값, 로고와 워터마크를 만들지 않는다.`,
    ``,
    ...plan.clips.flatMap((clip) => [
      `## ${String(clip.sortIndex).padStart(2, "0")} ${clip.sceneId} / ${clip.keyframeId}`,
      ``,
      `- CLEAN: ${clip.cleanAsset?.path || "MISSING"}`,
      `- INFO: ${clip.infoAsset?.path || "MISSING"}`,
      `- MP4: data/projects/${plan.topic.id ? `topic-${plan.topic.id}` : "topic"}/video/${clip.expectedVideoName}`,
      `- 대사: ${clip.scriptExcerpt}`,
      ``,
      `\`\`\`text`,
      clip.prompt || "승인된 CLEAN–INFO 쌍이 없어 프롬프트를 만들 수 없습니다.",
      `\`\`\``,
      ``
    ])
  ].join("\n");
}

async function saveVideoPrompts(payload) {
  const topicId = Number(payload.topicId);
  if (!topicId) {
    throw new Error("topicId가 필요합니다.");
  }

  const url = new URL(`http://localhost:${PORT}/api/video-plan?topicId=${topicId}`);
  const plan = await getVideoPlan(url);
  const manifestPath = resolveWorkspacePath(plan.manifestPath);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, renderVideoPromptsMarkdown(plan), "utf8");

  return {
    ...plan,
    manifestUrl: pathToStaticUrl(manifestPath)
  };
}

let comfyProcess = null;
let videoWorkerActive = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isComfyUiOnline() {
  try {
    const response = await fetch(`${COMFYUI_URL}/system_stats`, {
      signal: AbortSignal.timeout(2500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureComfyUiOnline() {
  if (await isComfyUiOnline()) return;
  const python = COMFYUI_DIR ? path.join(COMFYUI_DIR, ".venv", "Scripts", "python.exe") : "";
  const main = COMFYUI_DIR ? path.join(COMFYUI_DIR, "main.py") : "";
  if (!python || !existsSync(python) || !existsSync(main)) {
    throw new Error("ComfyUI H3 설치 경로를 찾을 수 없습니다.");
  }

  if (!comfyProcess || comfyProcess.exitCode !== null) {
    comfyProcess = spawn(python, [
      main,
      "--listen", "127.0.0.1",
      "--port", "8188",
      "--preview-method", "none",
      "--disable-dynamic-vram",
      "--lowvram",
      "--reserve-vram", "2",
      "--disable-async-offload",
      "--cache-none"
    ], {
      cwd: COMFYUI_DIR,
      windowsHide: true,
      stdio: "ignore"
    });
    comfyProcess.on("error", (error) => {
      console.error("ComfyUI start failed:", error.message);
    });
  }

  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (await isComfyUiOnline()) return;
    await sleep(2000);
  }
  throw new Error("ComfyUI가 3분 안에 준비되지 않았습니다.");
}

async function submitComfyPrompt(prompt) {
  const response = await fetch(`${COMFYUI_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: `dinobox-${randomUUID()}` })
  });
  const payload = await response.json();
  if (!response.ok || !payload.prompt_id) {
    const details = payload.error?.message || payload.error || JSON.stringify(payload.node_errors || payload);
    throw new Error(`ComfyUI 작업 제출 실패: ${details}`);
  }
  return payload.prompt_id;
}

async function waitForComfyOutput(promptId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < VIDEO_JOB_TIMEOUT_MS) {
    const response = await fetch(`${COMFYUI_URL}/history/${encodeURIComponent(promptId)}`);
    if (response.ok) {
      const history = await response.json();
      const entry = history[promptId];
      if (entry?.status?.status_str === "error") {
        const executionError = entry.status.messages
          ?.find?.(([type]) => type === "execution_error")?.[1];
        const message = executionError?.exception_message
          || executionError?.exception_type
          || entry.status.messages?.flat?.(3)?.filter((value) => typeof value === "string").join(" ");
        throw new Error(message || "ComfyUI 영상 생성 중 오류가 발생했습니다.");
      }
      if (entry?.status?.completed) {
        for (const output of Object.values(entry.outputs || {})) {
          const file = output?.images?.find((item) => String(item.filename || "").toLowerCase().endsWith(".mp4"));
          if (file) return file;
        }
        throw new Error("ComfyUI 작업은 끝났지만 MP4 출력 파일을 찾지 못했습니다.");
      }
    }
    await sleep(2000);
  }
  await fetch(`${COMFYUI_URL}/interrupt`, { method: "POST" }).catch(() => {});
  throw new Error(`ComfyUI 영상 생성 제한 시간(${Math.round(VIDEO_JOB_TIMEOUT_MS / 60000)}분)을 초과해 실행을 중단했습니다.`);
}

function probeVideoMetadata(filePath) {
  const result = spawnSync(FFPROBE_BIN, [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    filePath
  ], { encoding: "utf8", windowsHide: true });
  try {
    const payload = JSON.parse(String(result.stdout || "{}"));
    const videoStream = payload.streams?.find((stream) => stream.codec_type === "video");
    const audioStream = payload.streams?.find((stream) => stream.codec_type === "audio");
    const duration = Number(payload.format?.duration || videoStream?.duration || 0);
    const fileSize = Number(payload.format?.size || 0);
    return {
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: Number(videoStream?.width || 0) || null,
      height: Number(videoStream?.height || 0) || null,
      videoCodec: String(videoStream?.codec_name || ""),
      hasAudio: Boolean(audioStream),
      fileSize: Number.isFinite(fileSize) && fileSize > 0 ? fileSize : null
    };
  } catch {
    return { duration: null, width: null, height: null, videoCodec: "", hasAudio: false, fileSize: null };
  }
}

async function composeInfoOverlayVideo(rawPath, infoPath, destinationPath) {
  const rawMedia = probeVideoMetadata(rawPath);
  if (!rawMedia.width || !rawMedia.height || !rawMedia.duration) {
    throw new Error("H3 원본 영상의 해상도 또는 길이를 읽지 못했습니다.");
  }
  const guidesPath = infoPath.replace(/_INFO\.png$/u, "_INFO_GUIDES.png");
  const labelsPath = infoPath.replace(/_INFO\.png$/u, "_INFO_LABELS.png");
  if (!existsSync(guidesPath) || !existsSync(labelsPath)) {
    throw new Error("INFO 투명 레이어가 없습니다. INFO 이미지를 다시 생성하세요.");
  }
  const filter = [
    `[1:v]scale=${rawMedia.width}:${rawMedia.height}:flags=lanczos,format=rgba,fade=t=in:st=0.40:d=0.35:alpha=1[guides]`,
    `[2:v]scale=${rawMedia.width}:${rawMedia.height}:flags=lanczos,format=rgba,fade=t=in:st=0.90:d=0.45:alpha=1[labels]`,
    `[0:v][guides]overlay=shortest=1[with_guides]`,
    `[with_guides][labels]overlay=shortest=1[out]`
  ].join(";");
  await runProcess(FFMPEG_BIN, [
    "-y",
    "-i", rawPath,
    "-loop", "1", "-i", guidesPath,
    "-loop", "1", "-i", labelsPath,
    "-filter_complex", filter,
    "-map", "[out]",
    "-an",
    "-t", String(rawMedia.duration),
    "-r", "24",
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "17",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    destinationPath
  ]);
  return rawMedia;
}

async function runVideoAutoQc(videoPath, cleanPath, infoPath) {
  const media = probeVideoMetadata(videoPath);
  const errors = [];
  const warnings = [];
  if (!media.duration || media.duration < 1) errors.push("영상 길이가 1초보다 짧거나 읽히지 않습니다.");
  if (!media.width || !media.height || media.width >= media.height) errors.push("세로 영상 해상도가 아닙니다.");
  if ((media.width || 0) < 640 || (media.height || 0) < 960) warnings.push("출력 해상도가 640x960보다 작습니다.");
  if (media.hasAudio) warnings.push("H3 영상 원음이 남아 있습니다.");

  const framePath = path.join(MEDIA_JOB_DIR, `video-first-${Date.now()}-${randomUUID()}.png`);
  const lastFramePath = path.join(MEDIA_JOB_DIR, `video-last-${Date.now()}-${randomUUID()}.png`);
  let firstFrame = {};
  let lastFrame = {};
  try {
    await runProcess(FFMPEG_BIN, ["-y", "-ss", "0", "-i", videoPath, "-frames:v", "1", framePath]);
    firstFrame = await runJsonPython(MEDIA_QC_RUNNER, {
      mode: "compare",
      left: framePath,
      right: cleanPath
    }, "video-compare");
    if (Number(firstFrame.similarity || 0) < 0.45) {
      warnings.push("첫 프레임이 승인 CLEAN과 크게 다를 수 있습니다.");
    }
    await runProcess(FFMPEG_BIN, ["-y", "-sseof", "-0.05", "-i", videoPath, "-frames:v", "1", lastFramePath]);
    lastFrame = await runJsonPython(MEDIA_QC_RUNNER, {
      mode: "compare",
      left: lastFramePath,
      right: infoPath
    }, "video-compare");
    if (Number(lastFrame.similarity || 0) < 0.45) {
      warnings.push("마지막 프레임이 승인 INFO와 크게 다를 수 있습니다.");
    }
  } finally {
    await unlink(framePath).catch(() => {});
    await unlink(lastFramePath).catch(() => {});
  }
  return {
    passed: errors.length === 0,
    errors,
    warnings,
    firstFrame,
    lastFrame,
    infoOverlayApplied: true,
    ...media
  };
}

async function reviewVideoWithAi({ topic, clip, videoPath, cleanPath, infoPath, contactSheetPath, reviewer = {} }) {
  const prompt = `
You are the independent final-motion reviewer for a Korean cinematic engineering short.
Use view_image to inspect the chronological video contact sheet and the CLEAN/INFO references. Do not edit files.

${buildQualityReviewerContext("video_visual_quality", reviewer)}

Chronological video contact sheet: ${contactSheetPath}
CLEAN first-frame contract: ${cleanPath}
INFO final overlay reference: ${infoPath}

Reject when any of these is visible:
- motion contradicts the narration, physicalState, force/flow, cameraMotion, or transitionEndState;
- supports, contacts, geometry, water direction, load direction, rotation, opening/closing, before/after, or cause/result reverses;
- subject identity or structure drifts between sampled frames;
- the clip is effectively static, repeats a cosmetic camera move, or invents a large unsupported transformation;
- INFO changes the underlying CLEAN scene or communicates the wrong relationship;
- the sequence is difficult to understand at normal short-form viewing speed.
Any issue or score below 0.82 must fail. Describe only visible evidence from the supplied frames.

Topic and scene contract:
${JSON.stringify({
    title: topic.title,
    clipIndex: clip.sortIndex,
    narration: clip.scriptExcerpt,
    scenePurpose: clip.scenePurpose,
    cameraMotion: clip.cameraMotion,
    forceFlow: clip.forceFlow,
    motionPolicy: clip.motionPolicy,
    transitionEndState: clip.transitionEndState
  }, null, 2)}
`.trim();
  const review = await runCodexJson(
    prompt,
    `video-visual-review-${topic.id}-${clip.sortIndex}-${reviewer.role || "lead"}`,
    180000,
    {
      outputSchema: VIDEO_VISUAL_REVIEW_OUTPUT_SCHEMA,
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]
    }
  );
  review.passed = Boolean(review.passed && Number(review.score || 0) >= 0.82 && !(review.issues || []).length);
  return review;
}

async function reviewVideoConsensus({ topic, clip, videoPath, cleanPath, infoPath }) {
  const contactSheetPath = path.join(MEDIA_JOB_DIR, `video-review-${topic.id}-${clip.sortIndex}-${randomUUID()}.jpg`);
  try {
    await runProcess(FFMPEG_BIN, [
      "-y", "-i", videoPath,
      "-vf", "fps=1,scale=360:-1,tile=2x2:padding=8:margin=8",
      "-frames:v", "1",
      contactSheetPath
    ]);
    return await runQualityConsensus({
      stage: "video_visual_quality",
      topicId: topic.id,
      runReviewer: (reviewer) => reviewVideoWithAi({
        topic,
        clip,
        videoPath,
        cleanPath,
        infoPath,
        contactSheetPath,
        reviewer
      })
    });
  } finally {
    await unlink(contactSheetPath).catch(() => {});
  }
}

async function processVideoJob(jobRow) {
  const job = mapVideoJob(jobRow);
  const plan = await getVideoPlan(new URL(`http://localhost:${PORT}/api/video-plan?topicId=${job.topicId}`));
  const clip = plan.clips.find((item) => item.sortIndex === job.clipIndex);
  if (!clip?.cleanAsset?.path) throw new Error("이 장면의 CLEAN 이미지가 없습니다.");
  if (!clip?.infoAsset?.path) throw new Error("이 장면의 INFO 이미지가 없습니다.");
  const representativeSample = Boolean(
    plan.representativeGate?.enabled
    && plan.representativeGate.videoClipIndexes.includes(job.clipIndex)
  );
  const inputStatusAllowed = (status) => status === "OK" || (representativeSample && isAiVerifiedAssetStatus(status));
  if (!inputStatusAllowed(clip.cleanAsset.status)) {
    const error = new Error(`CLEAN 검수 상태가 ${clip.cleanAsset.status || "미확인"}라서 영상을 생성하지 않았습니다.`);
    error.code = "QC_BLOCKED";
    throw error;
  }
  if (!inputStatusAllowed(clip.infoAsset.status)) {
    const error = new Error(`INFO 검수 상태가 ${clip.infoAsset.status || "미확인"}라서 영상을 생성하지 않았습니다.`);
    error.code = "QC_BLOCKED";
    throw error;
  }
  const cleanPath = resolveWorkspacePath(clip.cleanAsset.path);
  const infoPath = resolveWorkspacePath(clip.infoAsset.path);
  const sourceFingerprint = await fingerprintApprovedInputs(cleanPath, infoPath);
  if (job.sourceFingerprint && sourceFingerprint !== job.sourceFingerprint) {
    const error = new Error("승인 CLEAN 또는 INFO가 바뀌어 대기 중이던 영상 작업을 폐기했습니다.");
    error.code = "STALE_INPUT";
    throw error;
  }

  await ensureComfyUiOnline();
  const inputDir = path.join(COMFYUI_DIR, "input");
  const inputName = `dinobox_topic-${job.topicId}_clip-${String(job.clipIndex).padStart(2, "0")}_job-${job.id}.png`;
  await mkdir(inputDir, { recursive: true });
  await copyFile(cleanPath, path.join(inputDir, inputName));

  const profile = H3_VIDEO_PROFILES[job.profileId];
  if (!profile) throw new Error(`알 수 없는 H3 영상 프로필입니다: ${job.profileId}`);
  if (profile.loraName) {
    const loraPath = path.join(COMFYUI_DIR, "models", "loras", profile.loraName);
    if (!existsSync(loraPath)) throw new Error(`H3 Turbo LoRA가 없습니다: ${profile.loraName}`);
  }

  const graph = JSON.parse(await readFile(H3_WORKFLOW_PATH, "utf8"));
  let modelRef = ["105:6", 0];
  if (profile.loraName) {
    graph["105:126"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: modelRef,
        lora_name: profile.loraName,
        strength_model: profile.loraStrength
      }
    };
    modelRef = ["105:126", 0];
  }
  if (profile.sageAttention) {
    graph["105:125"].inputs.model = modelRef;
    modelRef = ["105:125", 0];
  } else {
    delete graph["105:125"];
  }
  if (profile.memoryEfficientAttention) {
    graph["105:127"] = {
      class_type: "MiniMaxH3MemoryEfficientSageAttentionPatch",
      inputs: { model: modelRef }
    };
    modelRef = ["105:127", 0];
  }
  graph["105:9"].inputs.steps = profile.steps;
  graph["105:9"].inputs.model = modelRef;
  graph["105:16"].inputs.model = modelRef;
  graph["123:121"].inputs.megapixels = profile.megapixels;
  graph["114"].inputs.image = inputName;
  delete graph["115"];
  delete graph["105:104"].inputs.last_frame;
  graph["105:104"].inputs.prompt = job.requestedDurationSec === 4 && clip.prompt
    ? clip.prompt
    : buildMdVideoPrompt({
        topic: plan.topic,
        sceneId: clip.sceneId,
        keyframeId: clip.keyframeId,
        clipId: clip.clipId,
        cameraMotion: clip.cameraMotion,
        forceFlow: clip.forceFlow,
        scenePurpose: clip.scenePurpose,
        motionPolicy: clip.motionPolicy,
        transitionEndState: clip.transitionEndState,
        durationSec: job.requestedDurationSec
      });
  graph["105:111"].inputs.value = job.requestedDurationSec;
  graph["105:15"].inputs.noise_seed = job.seed;
  // Narration is mixed as a separate OpenShot track. Skipping H3 audio avoids
  // unnecessary audio VAE work and prevents generated audio leaking into edits.
  delete graph["105:23"];
  delete graph["105:24"];
  delete graph["105:91"].inputs.audio;
  graph["92"].inputs.filename_prefix = `video/dinobox_topic-${job.topicId}_clip-${String(job.clipIndex).padStart(2, "0")}_job-${job.id}`;

  const promptId = await submitComfyPrompt(graph);
  db.prepare("UPDATE video_jobs SET prompt_id = ? WHERE id = ?").run(promptId, job.id);
  const output = await waitForComfyOutput(promptId);
  const sourcePath = path.join(COMFYUI_DIR, "output", output.subfolder || "", output.filename);
  const destinationPath = resolveWorkspacePath(job.outputPath);
  const rawDir = path.join(path.dirname(destinationPath), "raw");
  const rawPath = path.join(rawDir, `${path.basename(destinationPath, path.extname(destinationPath))}_RAW.mp4`);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await copyFile(sourcePath, rawPath);
  await composeInfoOverlayVideo(rawPath, infoPath, destinationPath);
  if (await fingerprintApprovedInputs(cleanPath, infoPath) !== sourceFingerprint) {
    const error = new Error("영상 생성 중 CLEAN 또는 INFO가 변경되어 결과를 폐기했습니다.");
    error.code = "STALE_INPUT";
    throw error;
  }
  const autoQc = await runVideoAutoQc(
    destinationPath,
    cleanPath,
    infoPath
  );
  const topic = mapTopicRow(getTopicStatement.get(job.topicId));
  const semanticReview = await reviewVideoConsensus({
    topic,
    clip,
    videoPath: destinationPath,
    cleanPath,
    infoPath
  });
  autoQc.independentSemantic = semanticReview;
  autoQc.passed = Boolean(autoQc.passed && semanticReview.passed);
  if (!semanticReview.passed) {
    autoQc.errors = [
      ...(autoQc.errors || []),
      `영상 의미 검수 실패: ${semanticReview.summary || semanticReview.observedState || semanticReview.repairInstruction}`
    ];
  }
  return {
    ...probeVideoMetadata(destinationPath),
    rawOutputPath: toRelativeWorkspacePath(rawPath),
    autoQc
  };
}

async function runVideoWorker() {
  if (videoWorkerActive || activeAudioGpuOperation) return;
  videoWorkerActive = true;
  try {
    while (true) {
      const row = db.prepare("SELECT * FROM video_jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get();
      if (!row) break;
      db.prepare("UPDATE video_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP, error = '' WHERE id = ?").run(row.id);
      try {
        const media = await processVideoJob({ ...row, status: "running" });
        db.prepare(`
          UPDATE video_jobs
          SET status = 'completed', actual_duration_sec = ?, width = ?, height = ?,
              video_codec = ?, has_audio = ?, file_size = ?, raw_output_path = ?, auto_qc_json = ?,
              qc_status = ?, qc_note = ?,
              completed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          media.duration,
          media.width,
          media.height,
          media.videoCodec,
          media.hasAudio ? 1 : 0,
          media.fileSize,
          media.rawOutputPath,
          JSON.stringify(media.autoQc || {}),
          media.autoQc?.passed ? "ai_passed" : "rejected",
          media.autoQc?.passed
            ? "기계 QC와 통합 AI 영상 의미 검수를 통과했습니다."
            : (media.autoQc?.errors || []).join(" / ").slice(0, 1000),
          row.id
        );
      } catch (error) {
        const status = error.code === "QC_BLOCKED" ? "blocked_qc" : error.code === "STALE_INPUT" ? "stale" : "failed";
        db.prepare(`
          UPDATE video_jobs
          SET status = ?, error = ?, stale_reason = CASE WHEN ? = 'stale' THEN ? ELSE stale_reason END,
              stale_at = CASE WHEN ? = 'stale' THEN CURRENT_TIMESTAMP ELSE stale_at END,
              completed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          status,
          String(error.message || error).slice(0, 2000),
          status,
          String(error.message || error).slice(0, 1000),
          status,
          row.id
        );
      }
    }
  } finally {
    videoWorkerActive = false;
  }
}

function listVideoJobs(url) {
  const topicId = Number(url.searchParams.get("topicId"));
  if (!topicId) throw new Error("topicId가 필요합니다.");
  return {
    jobs: db.prepare("SELECT * FROM video_jobs WHERE topic_id = ? ORDER BY id DESC").all(topicId).map(mapVideoJob),
    workerActive: videoWorkerActive
  };
}

function reviewVideoJob(payload) {
  const topicId = Number(payload.topicId);
  const clipIndex = Number(payload.clipIndex);
  const qcStatus = String(payload.status || "").trim();
  const qcNote = String(payload.note || "").trim().slice(0, 1000);
  if (!topicId || !clipIndex || !["pending", "approved", "rejected"].includes(qcStatus)) {
    throw new Error("유효한 topicId, clipIndex와 영상 검수 상태가 필요합니다.");
  }
  const row = db.prepare(`
    SELECT * FROM video_jobs
    WHERE topic_id = ? AND clip_index = ? AND status = 'completed'
    ORDER BY id DESC LIMIT 1
  `).get(topicId, clipIndex);
  if (!row) throw new Error("검수할 완료 영상이 없습니다.");
  db.prepare("UPDATE video_jobs SET qc_status = ?, qc_note = ? WHERE id = ?").run(qcStatus, qcNote, row.id);
  return { job: mapVideoJob(db.prepare("SELECT * FROM video_jobs WHERE id = ?").get(row.id)) };
}

async function queueVideoJobs(payload) {
  const topicId = Number(payload.topicId);
  if (!topicId) throw new Error("topicId가 필요합니다.");
  const topic = getTopicStatement.get(topicId);
  if (topic?.runLane === "production_canary") throw new Error("production canary는 INFO 검토까지만 허용하며 H3/video를 큐에 넣지 않습니다.");
  const plan = await getVideoPlan(new URL(`http://localhost:${PORT}/api/video-plan?topicId=${topicId}`));
  const scope = String(payload.scope || (plan.representativeGate?.enabled ? "sample" : "full"));
  if (scope === "full" && plan.representativeGate?.enabled && !plan.representativeGate.fullProductionUnlocked) {
    throw new Error("대표 CLEAN·INFO·영상 검수를 먼저 통과해야 전체 영상을 생성할 수 있습니다.");
  }
  if (scope === "full" && !plan.generationReady) {
    throw new Error("모든 CLEAN–INFO 쌍의 실제 화면 검수와 승인이 끝나야 전체 영상을 생성할 수 있습니다.");
  }
  if (scope === "sample" && plan.representativeGate?.enabled && !plan.sampleGenerationReady) {
    throw new Error("대표 영상에 사용할 CLEAN–INFO 쌍의 실제 화면 검수와 승인이 먼저 필요합니다.");
  }
  const requested = Array.isArray(payload.clipIndexes)
    ? new Set(payload.clipIndexes.map(Number).filter(Number.isFinite))
    : plan.representativeGate?.enabled && scope === "sample"
      ? new Set(plan.representativeGate.videoClipIndexes)
      : null;
  const force = Boolean(payload.force);
  const profileId = String(payload.profileId || "quality").trim();
  const requestedDurationSec = Math.max(1, Math.min(4, Number(payload.durationSec || 4)));
  const profile = H3_VIDEO_PROFILES[profileId];
  if (!profile) throw new Error(`알 수 없는 H3 영상 프로필입니다: ${profileId}`);
  if (profile.loraName && (!COMFYUI_DIR || !existsSync(path.join(COMFYUI_DIR, "models", "loras", profile.loraName)))) {
    throw new Error(`선택한 프로필에 필요한 Turbo LoRA가 없습니다: ${profile.loraName}`);
  }
  const insert = db.prepare(`
    INSERT INTO video_jobs (
      topic_id, clip_index, input_path, output_path, requested_duration_sec,
      profile_id, settings_json, seed, qc_status, source_fingerprint
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const queued = [];

  for (const clip of plan.clips) {
    if (requested && !requested.has(clip.sortIndex)) continue;
    if (!clip.cleanAsset?.path) continue;
    if (!clip.infoAsset?.path) continue;
    const representativeSample = scope === "sample"
      && plan.representativeGate?.enabled
      && plan.representativeGate.videoClipIndexes.includes(clip.sortIndex);
    if (clip.cleanAsset.status !== "OK" && !(representativeSample && isAiVerifiedAssetStatus(clip.cleanAsset.status))) continue;
    if (clip.infoAsset.status !== "OK" && !(representativeSample && isAiVerifiedAssetStatus(clip.infoAsset.status))) continue;
    if (!force && clip.videoAsset) continue;
    const active = db.prepare("SELECT id FROM video_jobs WHERE topic_id = ? AND clip_index = ? AND status IN ('queued', 'running') LIMIT 1")
      .get(topicId, clip.sortIndex);
    if (active) continue;
    const extension = path.extname(clip.expectedVideoName);
    const stem = path.basename(clip.expectedVideoName, extension);
    const versionedName = `${stem}_run-${Date.now()}.mp4`;
    const outputPath = toRelativeWorkspacePath(path.join(PROJECTS_DIR, `topic-${topicId}`, "video", versionedName));
    const seed = Math.floor(Math.random() * 2147483647);
    const sourceFingerprint = await fingerprintApprovedInputs(
      resolveWorkspacePath(clip.cleanAsset.path),
      resolveWorkspacePath(clip.infoAsset.path)
    );
    const result = insert.run(
      topicId,
      clip.sortIndex,
      clip.cleanAsset.path,
      outputPath,
      requestedDurationSec,
      profileId,
      JSON.stringify(profile),
      seed,
      sourceFingerprint
    );
    queued.push(Number(result.lastInsertRowid));
  }

  queueMicrotask(() => runVideoWorker().catch((error) => console.error("Video worker failed:", error)));
  return { queuedCount: queued.length, jobIds: queued, scope, ...(listVideoJobs(new URL(`http://localhost:${PORT}/api/video/jobs?topicId=${topicId}`))) };
}

function getVoicePresets() {
  return {
    presets: listVoicePresetsStatement.all().map(mapVoicePresetRow)
  };
}

function createVoicePreset(payload) {
  const name = String(payload.name || "").trim();
  const engine = String(payload.engine || "VoxCPM2").trim();
  const mode = String(payload.mode || "preset").trim();
  const language = String(payload.language || "ko").trim();
  const styleInstruction = String(payload.styleInstruction || "").trim();
  const speakerKey = String(payload.speakerKey || "").trim();
  const referenceAudioPath = String(payload.referenceAudioPath || "").trim();
  const sampleText = String(payload.sampleText || TTS_EXAMPLE_TEXT).trim();
  const notes = String(payload.notes || "").trim();
  const isDefault = payload.isDefault ? 1 : 0;

  if (!name || !styleInstruction) {
    throw new Error("목소리 이름과 스타일 지시문이 필요합니다.");
  }

  if (isDefault) {
    clearDefaultVoicePresetsStatement.run();
  }

  const result = insertVoicePresetStatement.run(
    name,
    engine,
    mode,
    language,
    styleInstruction,
    speakerKey,
    referenceAudioPath,
    sampleText,
    notes,
    isDefault
  );

  return {
    preset: mapVoicePresetRow(getVoicePresetStatement.get(result.lastInsertRowid))
  };
}

function getTtsEnvironmentStatus() {
  const gpu = getGpuStatus();
  return {
    gpu,
    python: isCommandAvailable(PYTHON_BIN, ["--version"]),
    pythonPath: PYTHON_BIN,
    ffmpeg: isCommandAvailable(FFMPEG_BIN, ["-version"]),
    ffmpegPath: FFMPEG_BIN,
    ffprobe: isCommandAvailable(FFPROBE_BIN, ["-version"]),
    ffprobePath: FFPROBE_BIN,
    docker: isCommandAvailable("docker", ["--version"]),
    engines: [
      {
        key: "VoxCPM2",
        label: "VoxCPM2",
        status: "candidate",
        demoUrl: "https://huggingface.co/spaces/openbmb/VoxCPM-Demo",
        sampleUrl: "https://voxcpm.com/en/"
      },
      {
        key: "CosyVoice3",
        label: "CosyVoice3",
        status: "candidate",
        demoUrl: "https://github.com/QwenAudio/CosyVoice",
        sampleUrl: "https://github.com/QwenAudio/CosyVoice"
      },
      {
        key: "ZONOS2",
        label: "ZONOS2",
        status: "hold",
        demoUrl: "https://huggingface.co/Zyphra/ZONOS2",
        sampleUrl: "https://huggingface.co/Zyphra/ZONOS2"
      }
    ]
  };
}

function getTtsPlan(url) {
  const topicId = Number(url.searchParams.get("topicId"));
  if (!topicId) {
    throw new Error("topic id가 필요합니다.");
  }
  const run = mapTtsRunRow(getLatestTtsRunByTopicStatement.get(topicId));
  return {
    run,
    presets: listVoicePresetsStatement.all().map(mapVoicePresetRow),
    environment: getTtsEnvironmentStatus()
  };
}

function prepareTts(payload) {
  const topicId = Number(payload.topicId);
  if (!topicId) {
    throw new Error("topic id가 필요합니다.");
  }

  const topic = getTopicStatement.get(topicId);
  if (!topic) {
    throw new Error("주제를 찾을 수 없습니다.");
  }

  const script = getScriptByTopicStatement.get(topicId);
  if (!script) {
    throw new Error("먼저 대본을 생성해야 TTS 세그먼트를 준비할 수 있습니다.");
  }
  const canaryAiApproved = topic.runLane === "production_canary" && Boolean(topic.canaryAiPassAt) && script.status === "draft";
  if (script.status !== "approved" && !canaryAiApproved) {
    throw new Error("대본 승인 또는 canary AI_PASS 후 TTS를 생성할 수 있습니다.");
  }

  const voicePreset = payload.voicePresetId
    ? getVoicePresetStatement.get(Number(payload.voicePresetId))
    : getDefaultVoicePresetStatement.get();

  if (!voicePreset) {
    throw new Error("사용할 목소리 프리셋이 없습니다.");
  }

  const segments = buildTtsSegmentsFromScript(script);
  if (!segments.length) {
    throw new Error("TTS로 나눌 대본 문장이 없습니다.");
  }

  const estimatedTotal = Number(segments.reduce((sum, segment) => sum + segment.estimatedDurationSec, 0).toFixed(2));
  const result = insertTtsRunStatement.run(
    topicId,
    script.id,
    voicePreset.id,
    voicePreset.engine,
    voicePreset.language,
    estimatedTotal
  );

  for (const segment of segments) {
    insertTtsSegmentStatement.run(
      result.lastInsertRowid,
      topicId,
      script.id,
      segment.segmentIndex,
      segment.label,
      segment.plannedTime,
      segment.text,
      segment.estimatedDurationSec
    );
  }

  return {
    topic: mapTopicRow(topic),
    script: mapScriptRow(script),
    voicePreset: mapVoicePresetRow(voicePreset),
    run: mapTtsRunRow(getLatestTtsRunByTopicStatement.get(topicId)),
    environment: getTtsEnvironmentStatus()
  };
}

function approveScript(payload) {
  const id = Number(payload.id);
  if (!id) {
    throw new Error("topic id가 필요합니다.");
  }
  const topic = getTopicStatement.get(id);
  if (!topic) {
    throw new Error("주제를 찾을 수 없습니다.");
  }
  const factCheck = mapFactCheckRow(getFactCheckByTopicStatement.get(id));
  if (!factCheck || factCheck.status !== "PASS") {
    throw new Error("사실 검증 PASS 후 대본을 승인할 수 있습니다.");
  }
  const script = getScriptByTopicStatement.get(id);
  if (!script) {
    throw new Error("승인할 대본이 없습니다.");
  }
  if (script.status !== "draft") {
    throw new Error(script.status === "stale" ? "재검증 이후 대본이 오래된 상태입니다. 대본을 다시 생성하세요." : "초안 상태의 대본만 승인할 수 있습니다.");
  }
  approveScriptStatement.run(id);
  updateTopicReviewStatement.run("verified", "script", id);
  return getTopicDetailById(id);
}

function updateApprovedScript(payload) {
  const id = Number(payload.id);
  if (!id) throw new Error("topic id가 필요합니다.");
  const factCheck = mapFactCheckRow(getFactCheckByTopicStatement.get(id));
  if (!factCheck || factCheck.status !== "PASS") {
    throw new Error("사실 검증 PASS 후 대본을 수정할 수 있습니다.");
  }
  const row = getScriptByTopicStatement.get(id);
  if (!row || row.status === "stale") throw new Error("수정할 최신 대본이 없습니다.");

  const current = mapScriptRow(row);
  const narrations = Array.isArray(payload.narrations) ? payload.narrations : [];
  if (narrations.length !== current.productionScript.length) {
    throw new Error("장면 수가 기존 대본과 일치하지 않습니다.");
  }
  const productionScript = current.productionScript.map((scene, index) => {
    const narration = String(narrations[index] || "").trim();
    if (!narration) throw new Error(`${index + 1}번 장면의 대사가 비어 있습니다.`);
    if (narration.length > 1000) throw new Error(`${index + 1}번 장면의 대사가 너무 깁니다.`);
    return { ...scene, narration };
  });
  const changedNarrationIndexes = productionScript.flatMap((scene, index) => scene.narration === current.productionScript[index].narration ? [] : [index + 1]);
  const latestTtsRun = mapTtsRunRow(getLatestTtsRunByTopicStatement.get(id));
  const measuredOverrun = latestTtsRun?.status === "generated"
    ? null
    : db.prepare("SELECT details_json AS detailsJson FROM topic_attempts WHERE topic_id = ? AND stage = 'measured_tts_overrun' ORDER BY id DESC LIMIT 1").get(id);
  const permittedOverrun = parseStoredJson(measuredOverrun?.detailsJson, {}).measuredOverruns || [];
  if (permittedOverrun.length && (changedNarrationIndexes.length !== 1 || !permittedOverrun.some((entry) => Number(entry.segmentIndex) === changedNarrationIndexes[0]))) {
    throw new Error("실제 TTS 초과 복구는 초과한 행 하나만 편집할 수 있습니다.");
  }
  const ttsText = productionScript.map((scene) => scene.narration).join(" ");
  const raw = parseStoredJson(row.rawJson, {});
  raw.productionScript = productionScript;
  raw.ttsText = ttsText;
  raw.notes = Array.isArray(raw.notes) ? raw.notes : current.notes;
  raw.notes = [...raw.notes.filter((note) => note !== "사용자가 대본 문장을 직접 수정하고 승인했습니다."), "사용자가 대본 문장을 직접 수정하고 승인했습니다."];

  db.exec("BEGIN IMMEDIATE");
  try {
    updateApprovedScriptStatement.run(JSON.stringify(productionScript), ttsText, JSON.stringify(raw), id);
    db.prepare("UPDATE production_briefs SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'").run(id);
    db.prepare("UPDATE tts_runs SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'").run(id);
    db.prepare("UPDATE shotlists SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'").run(id);
    updateTopicReviewStatement.run("verified", "script", id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getTopicDetailById(id);
}

async function generateVoiceSample(payload) {
  const voicePresetId = Number(payload.voicePresetId);
  const voicePreset = getVoicePresetStatement.get(voicePresetId);
  if (!voicePreset) {
    throw new Error("목소리 프리셋을 찾을 수 없습니다.");
  }

  const sampleText = String(payload.text || voicePreset.sampleText || TTS_EXAMPLE_TEXT).trim();
  const outputDir = path.join(AUDIO_DIR, "voice-samples", `voice-${voicePreset.id}`);
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `sample-${Date.now()}.wav`);

  const result = await runAudioGpuOperation("목소리 예시 생성", () => runVoxcpmJob({
    kind: "sample",
    engine: voicePreset.engine,
    styleInstruction: voicePreset.styleInstruction,
    referenceAudioPath: voicePreset.referenceAudioPath ? resolveWorkspacePath(voicePreset.referenceAudioPath) : "",
    seed: 42,
    outputs: [
      {
        index: 1,
        text: sampleText,
        path: outputPath
      }
    ]
  }));

  const output = result.outputs?.[0];
  if (!output?.path) {
    throw new Error("예시 음성 생성 결과가 없습니다.");
  }

  const relative = toRelativeWorkspacePath(output.path);
  updateVoicePresetSampleStatement.run(sampleText, relative, output.durationSec || null, voicePreset.id);

  return {
    preset: mapVoicePresetRow(getVoicePresetStatement.get(voicePreset.id)),
    audioUrl: pathToStaticUrl(output.path),
    durationSec: output.durationSec || null,
    environment: getTtsEnvironmentStatus()
  };
}

async function generateTts(payload) {
  const topicId = Number(payload.topicId);
  const requestedPreset = payload.voicePresetId
    ? getVoicePresetStatement.get(Number(payload.voicePresetId))
    : getDefaultVoicePresetStatement.get();
  if (!topicId) throw new Error("topic id가 필요합니다.");
  if (!requestedPreset) throw new Error("사용할 목소리 프리셋이 없습니다.");
  if (!getVoiceReferencePath(mapVoicePresetRow(requestedPreset))) {
    throw new Error("목소리 예시를 먼저 생성해야 같은 목소리로 TTS를 만들 수 있습니다.");
  }

  return runTopicOperation(topicId, "TTS 생성", () => runAudioGpuOperation("TTS 생성", async () => {
  const prepared = prepareTts(payload);
  const run = prepared.run;
  const voicePreset = prepared.voicePreset;
  const referenceAudioPath = getVoiceReferencePath(voicePreset);
  const promptText = getVoicePromptText(voicePreset);
  if (!referenceAudioPath) {
    throw new Error("목소리 예시를 먼저 생성해야 같은 목소리로 TTS를 만들 수 있습니다.");
  }
  const outputDir = path.join(AUDIO_DIR, `topic-${run.topicId}`, `run-${run.id}`);
  await mkdir(outputDir, { recursive: true });

  updateTtsRunStatement.run("generating", null, "", "", run.id);

  const outputs = run.segments.map((segment) => ({
    index: segment.segmentIndex,
    text: segment.text,
    path: path.join(outputDir, `segment-${String(segment.segmentIndex).padStart(2, "0")}.wav`)
  }));
  const outputMasterPath = path.join(outputDir, "full.wav");

  try {
    const result = await runVoxcpmJob({
      kind: "script",
      engine: voicePreset.engine,
      styleInstruction: referenceAudioPath ? "" : voicePreset.styleInstruction,
      referenceAudioPath,
      promptWavPath: referenceAudioPath,
      promptText,
      seed: 42,
      gapSec: 0.25,
      outputMasterPath,
      outputs
    });

    let totalDuration = 0;
    for (const output of result.outputs || []) {
      totalDuration += Number(output.durationSec || 0);
      updateTtsSegmentOutputStatement.run(
        toRelativeWorkspacePath(output.path),
        output.durationSec || null,
        "generated",
        run.id,
        output.index
      );
    }

    const masterRelative = result.master?.path ? toRelativeWorkspacePath(result.master.path) : "";
    const measuredTotal = result.master?.durationSec || Number(totalDuration.toFixed(2));
    const measuredOverruns = (result.outputs || [])
      .filter((output) => Number(output.durationSec || 0) > NATIVE_CLIP_DURATION_SEC + 0.01)
      .map((output) => ({ segmentIndex: Number(output.index), durationSec: Number(output.durationSec), text: String(output.text || run.segments.find((segment) => Number(segment.segmentIndex) === Number(output.index))?.text || "") }));
    const narrationHash = buildQualityContractHash(run.segments.map((segment) => ({ index: segment.segmentIndex, text: segment.text })));
    const priorOverrun = db.prepare("SELECT id FROM topic_attempts WHERE topic_id = ? AND stage = 'measured_tts_overrun' AND json_extract(details_json, '$.narrationHash') = ? LIMIT 1").get(run.topicId, narrationHash);
    const repeatedNarration = Boolean(measuredOverruns.length && priorOverrun);
    const ttsStatus = measuredOverruns.length ? "hold" : "generated";
    const ttsError = repeatedNarration
      ? "measured_tts_unresolved: 같은 내레이션 hash가 다시 4초를 넘었습니다."
      : measuredOverruns.length
        ? "실제 TTS 초과 행은 한 번의 행 편집 후 다시 측정해야 합니다."
        : "";
    updateTtsRunStatement.run(ttsStatus, measuredTotal, masterRelative, ttsError, run.id);
    if (measuredOverruns.length) recordTopicAttempt(run.topicId, "measured_tts_overrun", repeatedNarration ? "hold" : "row_edit_allowed", ttsError, { narrationHash, measuredOverruns, ttsRunId: run.id });
    db.prepare("UPDATE shotlists SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'")
      .run(run.topicId);

    return {
      ...getTtsPlan(new URL(`http://localhost:${PORT}/api/tts/plan?topicId=${run.topicId}`)),
      topic: prepared.topic,
      script: prepared.script,
      voicePreset: mapVoicePresetRow(getVoicePresetStatement.get(voicePreset.id))
    };
  } catch (error) {
    updateTtsRunStatement.run("failed", null, "", error.message || "TTS 생성 실패", run.id);
    throw error;
  }
  }));
}

function buildAiShotlistItems(topic, script, factCheck, ttsRun, aiResult, productionBrief = null) {
  const segments = ttsRun.segments || [];
  const scenes = Array.isArray(aiResult?.scenes) ? [...aiResult.scenes] : [];

  const allowedClaimRefs = new Set(
    (script.productionScript || []).flatMap((row) => Array.isArray(row.claimRefs) ? row.claimRefs : [])
  );
  const allowedVisualStates = new Map((productionBrief?.visualStates || []).map((state) => [state.stateId, state]));
  const measuredTtsTimeline = getShotlistTimeline(ttsRun);
  const { measuredTotalDurationSec: measuredTotal, timelineDurations, minimumCoverageCount } = measuredTtsTimeline;
  const targetClipCount = determineEvidenceBoundShotCount(script, productionBrief, measuredTotal, minimumCoverageCount);
  const shotCounts = allocateShotCounts(segments, targetClipCount, timelineDurations);
  const expectedSceneCount = shotCounts.reduce((sum, count) => sum + count, 0);
  if (scenes.length !== expectedSceneCount) {
    throw new Error(`AI 장면표가 필요한 ${expectedSceneCount}개 장면 대신 ${scenes.length}개를 반환했습니다.`);
  }
  const sceneContractIssues = getAiSceneContractIssues(scenes, inferScreenDirectionContract(script, factCheck));
  if (sceneContractIssues.length) {
    throw new Error(`AI 장면표의 화면 계약을 통과하지 못했습니다: ${sceneContractIssues.join(" / ")}`);
  }
  scenes.sort((a, b) => (
    Number(a.sourceSegmentIndex) - Number(b.sourceSegmentIndex)
    || Number(a.sourceSegmentOrder) - Number(b.sourceSegmentOrder)
  ));

  for (const [segmentOffset, segment] of segments.entries()) {
    const segmentScenes = scenes.filter((scene) => Number(scene.sourceSegmentIndex) === Number(segment.segmentIndex));
    const expectedCount = shotCounts[segmentOffset];
    if (segmentScenes.length !== expectedCount
      || segmentScenes.some((scene, index) => Number(scene.sourceSegmentOrder) !== index + 1)) {
      throw new Error(`AI 장면표가 TTS ${segment.segmentIndex}번을 ${expectedCount}개 물리 장면으로 정확히 분해하지 않았습니다.`);
    }
  }

  const failureCorpus = [
    script.coreConflict,
    script.designIntervention,
    ...(script.productionScript || []).map((row) => `${row.beat || ""} ${row.narration || ""}`)
  ].join(" ");
  const needsFailureVisualization = topic.mainTopic === "engineering"
    && (script.narrativeType === "failure_analysis" || /실패|위험|붕괴|파손|침하|균열/u.test(failureCorpus));
  if (needsFailureVisualization && !scenes.some((scene) => scene.shotRole === "failure_simulation" || scene.shotRole === "consequence")) {
    throw new Error("문제·위험을 설명하는 대본인데 물리적 결과를 보여주는 실패 시뮬레이션 장면이 없습니다.");
  }

  const items = [];
  let segmentStart = 0;
  let previousCleanFingerprint = "";

  for (const [offset, segment] of segments.entries()) {
    const row = getProductionScriptRow(script, segment.segmentIndex);
    const segmentScenes = scenes.filter((scene) => Number(scene.sourceSegmentIndex) === Number(segment.segmentIndex));
    const timelineDuration = timelineDurations[offset];
    const clipDuration = timelineDuration / segmentScenes.length;

    for (const [partOffset, scene] of segmentScenes.entries()) {
      const requiredTextFields = ["narrationAnchor", "scenePurpose", "cleanContent", "infoFocus", "cameraMotion", "physicalState", "stateChangeReason", "forceFlow"];
      const emptyField = requiredTextFields.find((field) => !String(scene?.[field] || "").trim());
      if (emptyField) throw new Error(`AI 장면표 TTS ${segment.segmentIndex}-${partOffset + 1}의 ${emptyField}가 비어 있습니다.`);

      let claimRefs = [...new Set((scene.claimRefs || []).map((value) => String(value).trim()).filter(Boolean))];
      const invalidClaim = claimRefs.find((claimRef) => !allowedClaimRefs.has(claimRef));
      if (!claimRefs.length || invalidClaim) {
        throw new Error(`AI 장면표 TTS ${segment.segmentIndex}-${partOffset + 1}이 검증되지 않은 주장 ID를 사용했습니다: ${invalidClaim || "없음"}`);
      }
      const requestedVisualStateId = String(scene.visualStateId || "").trim();
      const visualStateId = String(row.visualStateId || requestedVisualStateId).trim();
      const visualState = allowedVisualStates.get(visualStateId);
      if (productionBrief && !visualState) {
        throw new Error(`AI 장면표 TTS ${segment.segmentIndex}-${partOffset + 1}이 제작 설계서에 없는 시각 상태 ${visualStateId || "없음"}을 사용했습니다.`);
      }
      if (row.visualStateId && requestedVisualStateId && requestedVisualStateId !== row.visualStateId) {
        recordTopicAttempt(topic.id, "shotlist_contract", "normalized", `AI가 바꾼 상태 ID ${requestedVisualStateId}를 승인 값 ${row.visualStateId}로 복원했습니다.`, {
          sourceSegmentIndex: segment.segmentIndex,
          sourceSegmentOrder: partOffset + 1
        });
      }
      const evidenceBeat = visualState?.evidenceBeats?.[partOffset] || null;
      const evidenceBeatId = String(evidenceBeat?.beatId || scene.evidenceBeatId || `${visualStateId}_B${partOffset + 1}`).trim();
      const unsupportedForState = visualState
        ? claimRefs.filter((claimRef) => !visualState.claimRefs.includes(claimRef))
        : [];
      if (unsupportedForState.length) {
        const visualClaimRefs = claimRefs.filter((claimRef) => visualState.claimRefs.includes(claimRef));
        const rowClaimRefs = new Set((row.claimRefs || []).map(String));
        claimRefs = visualClaimRefs.length
          ? visualClaimRefs
          : visualState.claimRefs.filter((claimRef) => rowClaimRefs.has(String(claimRef)));
        if (!claimRefs.length) {
          throw new Error(`AI 장면표 ${visualStateId}가 현재 화면을 직접 지지하는 주장 ID를 찾지 못했습니다.`);
        }
        recordTopicAttempt(topic.id, "shotlist_claim_scope", "normalized", `내레이션의 미래·과거 주장 ${unsupportedForState.join(", ")}을 현재 화면 근거에서 분리했습니다.`, {
          sourceSegmentIndex: segment.segmentIndex,
          sourceSegmentOrder: partOffset + 1,
          visualStateId,
          narrationClaimRefs: scene.claimRefs || [],
          visualClaimRefs: claimRefs
        });
      }
      const infoSpec = {
        ...repairAiInfoGraphicSpec(scene.infoGraphic, row, scene.forceFlow),
        requiresOverlay: evidenceBeat?.infoGraphic?.requiresOverlay === true || visualState?.infoGraphic?.requiresOverlay === true
      };
      if (scene.shotRole === "failure_simulation") {
        infoSpec.labels = [...new Set(["가상 위험 시뮬레이션", ...infoSpec.labels])].slice(0, 3);
      }
      const infoIssues = getInfoGraphicSpecIssues(infoSpec);
      if (infoSpec.requiresOverlay && infoSpec.type === "none") infoIssues.push("근거 기반 INFO 필요성 계약을 none으로 바꿀 수 없습니다.");
      if (infoIssues.length) {
        throw new Error(`AI 장면표 TTS ${segment.segmentIndex}-${partOffset + 1} INFO 명세가 불완전합니다: ${infoIssues.join(", ")}`);
      }

      const cleanContent = String(scene.cleanContent).trim();
      const cleanFingerprint = cleanContent.toLowerCase().replace(/[^0-9a-z가-힣]/gu, "");
      if (cleanFingerprint && cleanFingerprint === previousCleanFingerprint) {
        throw new Error(`AI 장면표 TTS ${segment.segmentIndex}-${partOffset + 1} CLEAN 장면이 직전 장면과 동일합니다.`);
      }
      previousCleanFingerprint = cleanFingerprint;

      const sortIndex = items.length + 1;
      const startSec = Number((segmentStart + clipDuration * partOffset).toFixed(2));
      const endSec = Number((partOffset === segmentScenes.length - 1
        ? segmentStart + timelineDuration
        : segmentStart + clipDuration * (partOffset + 1)).toFixed(2));
      if (endSec - startSec > 4.01) throw new Error(`${sortIndex}번 장면이 4초 원본 클립의 커버 범위를 넘습니다.`);
      const sceneId = `S${String(sortIndex).padStart(2, "0")}A`;
      const keyframeId = `KF-${String(sortIndex).padStart(2, "0")}A`;
      const clipId = `CLIP${String(sortIndex).padStart(2, "0")}`;
      const physicalState = String(scene.physicalState).trim();
      const stateChangeReason = String(scene.stateChangeReason).trim();
      const forceFlow = String(scene.forceFlow).trim();
      const scenePurpose = String(scene.scenePurpose).trim();
      const infoFocus = String(scene.infoFocus).trim();
      const cameraMotion = String(scene.cameraMotion).trim();
      const shotRole = String(scene.shotRole).trim();
      const visualFamily = String(scene.visualFamily).trim();
      const requiredVisibleElements = [...new Set((evidenceBeat?.requiredVisibleElements || scene.requiredVisibleElements || [])
        .map((value) => String(value).trim()).filter(Boolean))];
      const forbiddenVisibleElements = [...new Set([
        ...(visualState?.forbiddenVisibleElements || []),
        ...(evidenceBeat?.forbiddenVisibleElements || (scene.forbiddenVisibleElements || []))
      ].map((value) => String(value).trim()).filter(Boolean))];
      if (requiredVisibleElements.length < 2) throw new Error(`${sortIndex}번 장면의 필수 시각 요소가 부족합니다.`);
      const priorInFamily = items.findLast((item) => item.visualFamily === visualFamily);
      let referencePolicy = String(scene.referencePolicy).trim();
      if (["cutaway", "macro", "simulation", "action"].includes(visualFamily) && referencePolicy === "subject_identity") referencePolicy = "none";
      if (referencePolicy === "previous_in_family" && !priorInFamily) referencePolicy = "none";
      let motionPolicy = String(scene.motionPolicy).trim();
      const transitionEndState = String(scene.transitionEndState || "").trim();
      // Large state changes are represented as separate CLEAN shots. H3 receives
      // one approved state and adds restrained motion instead of inventing physics.
      if (motionPolicy === "start_end_transition") motionPolicy = "first_frame";
      const fileStub = `${String(sortIndex).padStart(2, "0")}_${sceneId}_${keyframeId}_${slugKorean(row.beat || segment.label)}`;
      const promptRow = { ...row, stateChangeReason, shotRole };
      const cleanPrompt = buildCleanPrompt({
        topic, script, row: promptRow, sceneId, keyframeId, cleanContent, physicalState, cameraMotion,
        shotRole, visualFamily, requiredVisibleElements, forbiddenVisibleElements, transitionEndState, infoSpec
      });
      const infoPrompt = buildInfoPrompt({ topic, row: { ...promptRow, mechanismStep: scenePurpose, forceFlow }, sceneId, keyframeId, infoFocus, forceFlow, claimRefs, infoSpec });
      const videoPrompt = buildMdVideoPrompt({ topic, sceneId, keyframeId, clipId, cameraMotion, forceFlow, scenePurpose, motionPolicy, transitionEndState });

      items.push({
        sortIndex, sceneId, keyframeId, clipId,
        sourceSegmentIndex: Number(segment.segmentIndex), sourceSegmentOrder: partOffset + 1,
        visualStateId, evidenceBeatId,
        startSec, endSec, durationSec: Number((endSec - startSec).toFixed(2)),
        scriptExcerpt: String(scene.narrationAnchor).trim(),
        shotRole, visualFamily, referencePolicy, motionPolicy, requiredVisibleElements, forbiddenVisibleElements, transitionEndState,
        scenePurpose, cleanContent, infoFocus, cameraMotion, physicalState,
        stateChangeReason, forceFlow, claimRefs, cleanPrompt, infoPrompt, infoSpec, videoPrompt, fileStub
      });
    }
    segmentStart += timelineDuration;
  }

  return items;
}

function buildOrderedNarrationAnchors(narration, count) {
  const text = String(narration || "").replace(/\s+/gu, " ").trim();
  const words = text.split(" ").filter(Boolean);
  if (!text || count <= 1 || words.length < count) return Array.from({ length: Math.max(1, count) }, () => text);
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * words.length) / count);
    const end = Math.floor(((index + 1) * words.length) / count);
    return words.slice(start, Math.max(start + 1, end)).join(" ");
  });
}

function enforceShotlistBriefContracts(aiResult, script, productionBrief) {
  if (!productionBrief) return aiResult;
  const visualStates = new Map((productionBrief.visualStates || []).map((state) => [state.stateId, state]));
  const sceneCountByState = new Map();
  const sceneCountBySegment = new Map();
  for (const scene of aiResult?.scenes || []) {
    const row = getProductionScriptRow(script, Number(scene.sourceSegmentIndex));
    const stateId = String(row.visualStateId || scene.visualStateId || "").trim();
    sceneCountByState.set(stateId, Number(sceneCountByState.get(stateId) || 0) + 1);
    const segmentIndex = Number(scene.sourceSegmentIndex);
    sceneCountBySegment.set(segmentIndex, Number(sceneCountBySegment.get(segmentIndex) || 0) + 1);
  }
  const scenes = (aiResult?.scenes || []).map((scene) => {
    const row = getProductionScriptRow(script, Number(scene.sourceSegmentIndex));
    const approvedNarration = String(row.narration || "").trim();
    const segmentAnchors = buildOrderedNarrationAnchors(
      approvedNarration,
      Number(sceneCountBySegment.get(Number(scene.sourceSegmentIndex)) || 1)
    );
    const narrationAnchor = segmentAnchors[Math.max(0, Number(scene.sourceSegmentOrder || 1) - 1)] || approvedNarration;
    const visualStateId = String(row.visualStateId || scene.visualStateId || "").trim();
    const visualState = visualStates.get(visualStateId);
    if (!visualState) throw new Error(`TTS ${scene.sourceSegmentIndex}의 승인 시각 상태 ${visualStateId || "없음"}를 찾을 수 없습니다.`);
    const hasExpandedContract = Number(visualState.evidenceBeats?.length || 0) >= Number(sceneCountByState.get(visualStateId) || 0);
    const evidenceBeat = hasExpandedContract
      ? visualState.evidenceBeats?.[Number(scene.sourceSegmentOrder) - 1]
      : null;
    const evidenceBeatId = String(evidenceBeat?.beatId || `${visualStateId}_B${Number(scene.sourceSegmentOrder)}`).trim();
    if (!evidenceBeat) {
      return {
        ...scene,
        narrationAnchor,
        visualStateId,
        evidenceBeatId,
        forbiddenVisibleElements: [...new Set([
          ...(visualState.forbiddenVisibleElements || []),
          ...(scene.forbiddenVisibleElements || [])
        ])]
      };
    }
    const sceneText = `${approvedNarration} ${evidenceBeat.purpose || ""} ${evidenceBeat.physicalState || ""}`;
    let infoGraphic = evidenceBeat.infoGraphic || normalizeInfoGraphicSpec({ type: "none" }, evidenceBeat);
    if (["before_after", "comparison"].includes(infoGraphic.type)) {
      const hasExplicitBaseline = /(이전.{0,30}이후|전후|변화\s*전|변화\s*후|before.{0,30}after|baseline)/iu.test(sceneText);
      if (!hasExplicitBaseline) {
        const supportsDirectionalFlow = /(열|공기|물|유동|하중|힘|압력|에너지|heat|air|water|flow|load|force|pressure|energy)/iu.test(sceneText);
        infoGraphic = supportsDirectionalFlow
          ? normalizeInfoGraphicSpec({
            ...infoGraphic,
            type: "flow",
            labels: (infoGraphic.labels || []).filter((label) => !/^(이전|이후|전|후|before|after)$/iu.test(String(label))).slice(0, 2),
            comparisonRule: ""
          }, evidenceBeat)
          : normalizeInfoGraphicSpec({ type: "none" }, evidenceBeat);
      }
    }
    let visualFamily = evidenceBeat.visualFamily;
    const visualText = `${evidenceBeat.purpose || ""} ${evidenceBeat.physicalState || ""} ${(evidenceBeat.requiredVisibleElements || []).join(" ")}`;
    if (visualFamily === "macro"
      && /(외관|외부|전체|창\s*표면|파사드|facade|exterior)/iu.test(visualText)
      && !/(접합부|고정구|재료\s*질감|균열|섬유|볼트|용접|connection|fastener|texture|crack|fiber|bolt|weld)/iu.test(visualText)) {
      visualFamily = "exterior";
    }
    if (visualFamily === "environment"
      && /(한\s*개|단일).{0,20}(창|패널|수문|기둥|블록)/u.test(visualText)) {
      visualFamily = "exterior";
    }
    return {
      ...scene,
      narrationAnchor,
      visualStateId,
      evidenceBeatId,
      shotRole: evidenceBeat.shotRole,
      visualFamily,
      scenePurpose: evidenceBeat.purpose,
      cleanContent: `${evidenceBeat.physicalState} ${evidenceBeat.purpose}`,
      physicalState: evidenceBeat.physicalState,
      stateChangeReason: `${evidenceBeat.label}: ${evidenceBeat.purpose}`,
      cameraMotion: evidenceBeat.cameraMotion || scene.cameraMotion,
      motionPolicy: evidenceBeat.motionPolicy || scene.motionPolicy,
      transitionEndState: evidenceBeat.transitionEndState || scene.transitionEndState,
      infoGraphic,
      requiredVisibleElements: [...new Set(evidenceBeat.requiredVisibleElements || [])],
      forbiddenVisibleElements: [...new Set([
        ...(visualState.forbiddenVisibleElements || []),
        ...(evidenceBeat.forbiddenVisibleElements || [])
      ])]
    };
  }).sort((a, b) => Number(a.sourceSegmentIndex) - Number(b.sourceSegmentIndex)
    || Number(a.sourceSegmentOrder) - Number(b.sourceSegmentOrder));
  return { ...aiResult, scenes };
}

function promoteApprovedShotlistBeats(topic, factCheck, productionBrief, aiResult) {
  const scenesByState = new Map();
  for (const scene of aiResult?.scenes || []) {
    const stateId = String(scene.visualStateId || "").trim();
    if (!stateId) continue;
    const scenes = scenesByState.get(stateId) || [];
    scenes.push(scene);
    scenesByState.set(stateId, scenes);
  }
  const visualStates = (productionBrief.visualStates || []).map((state) => {
    const scenes = (scenesByState.get(state.stateId) || [])
      .sort((left, right) => Number(left.sourceSegmentOrder) - Number(right.sourceSegmentOrder));
    if (!scenes.length) return state;
    return {
      ...state,
      evidenceBeats: scenes.map((scene, index) => ({
        beatId: String(scene.evidenceBeatId || `${state.stateId}_B${index + 1}`).trim(),
        label: String(scene.stateChangeReason || scene.scenePurpose || `증거 비트 ${index + 1}`).trim(),
        shotRole: String(scene.shotRole || "context").trim(),
        visualFamily: String(scene.visualFamily || "exterior").trim(),
        purpose: String(scene.scenePurpose || "검증된 상태의 시각 증거").trim(),
        physicalState: String(scene.physicalState || "").trim(),
        cameraMotion: String(scene.cameraMotion || "restrained slow push-in").trim(),
        motionPolicy: String(scene.motionPolicy || "first_frame").trim(),
        transitionEndState: String(scene.transitionEndState || "").trim(),
        requiredVisibleElements: [...new Set((scene.requiredVisibleElements || []).map((value) => String(value).trim()).filter(Boolean))],
        forbiddenVisibleElements: [...new Set((scene.forbiddenVisibleElements || []).map((value) => String(value).trim()).filter(Boolean))].slice(0, 6),
        infoGraphic: normalizeInfoGraphicSpec(scene.infoGraphic || { type: "none" }, scene)
      }))
    };
  });
  const promoted = normalizeProductionBrief({ ...productionBrief, visualStates }, topic.mainTopic);
  const saved = saveProductionBrief(topic, factCheck, promoted, {
    source: "approved-shotlist",
    designSummary: aiResult.designSummary,
    continuityRules: aiResult.continuityRules,
    notes: aiResult.notes
  }, "approved-shotlist");
  if (saved.status !== "ready") {
    const issues = saved.quality?.issues?.map((issue) => issue.message).join(" / ") || "증거 비트 계약 검증 실패";
    throw new Error(`검수된 장면표를 제작 계약으로 승격하지 못했습니다: ${issues}`);
  }
  return saved;
}

async function reviewShotlistWithAi(topic, script, factCheck, ttsRun, productionBrief, aiResult, jobContext, attempt, reviewer = {}) {
  const deterministicIssues = getAiSceneContractIssues(
    aiResult?.scenes || [],
    inferScreenDirectionContract(script, factCheck)
  );
  const approvedVisualStateContract = (productionBrief?.visualStates || []).map((state) => ({
    stateId: state.stateId,
    purpose: state.purpose,
    physicalState: state.physicalState,
    changeFromPrevious: state.changeFromPrevious,
    evidenceRefs: state.evidenceRefs,
    evidenceBeats: (state.evidenceBeats || []).map((beat) => ({
      beatId: beat.beatId,
      physicalState: beat.physicalState,
      requiredVisibleElements: beat.requiredVisibleElements,
      infoGraphic: beat.infoGraphic
    }))
  }));
  const prompt = `
  You are the independent sequence editor for a Korean cinematic engineering short. Review the complete shot list as one edited film; do not rewrite it.

${buildQualityReviewerContext("shotlist_quality", reviewer)}

Blocking quality rules:
- A change of lens, distance, angle, weather, or depth of field alone is not a new visual state. Reject sequences that repeatedly show the same object and same physical relationship with cosmetic reframing.
- The scene count is the minimum required to cover measured narration with native-speed H3 clips no longer than four seconds. Do not reject the count by itself. Judge whether each clip adds a supported action phase, observable relationship, contact/material focus, condition change, or result instead of cosmetic reframing.
- The sequence must advance through distinct evidence-bearing states such as context, cause, constraint, intervention, mechanism, material/contact detail, response, and result when those states are supported. Do not demand unsupported states merely to create variety.
- visualFamily must match what is actually described. macro means any frame dominated by a verified close material, surface, fastener, joint, contact, deformation, or fluid interaction; it does not require an interior mechanism. A broad exterior crop is not macro, and another exterior angle is not an environment or causal state.
- Every support, contact, flow, pressure, heat, load, motion, or failure state must stay inside SUPPORTED claims and preserve physically necessary supports and connections.
- The approved visual-state contract below is the authoritative scope for this edit. Do not promote ordering metadata in a broad claim or source reference into a required causal beat unless the narration and that approved contract both assert the order.
- INFO defaults to none. Reject repeated labels or overlays that CLEAN/video can already communicate.
- Camera motion must be restrained and usable for a four-second image-to-video clip, but it cannot substitute for missing physical state changes.
- If the verified evidence is truly too shallow to sustain the measured narration without repetition, use insufficient_visual_depth as an upstream script/production-contract failure. Do not ask the shotlist revision to reduce the fixed clip count or invent interiors, cutaways, construction details, or hidden load paths.
- Any error, score below 0.84, repeated_visual_state warning, family_mismatch warning, or insufficient_visual_depth warning must fail.

Topic and approved script:
${JSON.stringify({
    title: topic.title,
    coreQuestion: script.coreQuestion,
    coreConflict: script.coreConflict,
    coreMechanism: script.coreMechanism,
    ttsText: script.ttsText,
    durationSec: ttsRun.totalDurationSec
  }, null, 2)}

Approved visual-state contract:
${JSON.stringify(approvedVisualStateContract, null, 2)}

Supported video claims:
${JSON.stringify((factCheck.claims || []).filter((claim) => claim.status === "SUPPORTED" && claim.useInVideo !== false), null, 2)}

Verified visual evidence for geometry, support, motion, and flow:
${JSON.stringify(factCheck.visualEvidence || [], null, 2)}

Deterministic issues:
${JSON.stringify(deterministicIssues, null, 2)}

Complete shot sequence:
${JSON.stringify((aiResult.scenes || []).map((scene, index) => ({ index: index + 1, ...scene })), null, 2)}
  `.trim();
  const review = await runCodexJson(prompt, `shotlist-review-${topic.id}-${attempt}-${reviewer.role || "evidence"}`, 300000, {
    signal: jobContext?.signal,
    outputSchema: SHOTLIST_REVIEW_OUTPUT_SCHEMA,
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]
  });
  const blockingIssues = (review.issues || []).filter((issue) => (
    issue.severity === "error"
    || ["repeated_visual_state", "family_mismatch", "insufficient_visual_depth"].includes(issue.code)
  ));
  review.passed = Boolean(
    review.passed
    && Number(review.score || 0) >= 0.84
    && !deterministicIssues.length
    && !blockingIssues.length
  );
  review.deterministicIssues = deterministicIssues;
  return review;
}

async function reviewShotlistConsensus(topic, script, factCheck, ttsRun, productionBrief, aiResult, jobContext, attempt) {
  const deterministicIssues = getAiSceneContractIssues(
    aiResult?.scenes || [],
    inferScreenDirectionContract(script, factCheck)
  );
  return runQualityConsensus({
    stage: "shotlist_quality",
    topicId: topic.id,
    contractHash: buildShotlistUpstreamContractHash(factCheck, script, ttsRun, productionBrief),
    jobContext,
    deterministicIssues,
    runReviewer: (reviewer) => reviewShotlistWithAi(
      topic,
      script,
      factCheck,
      ttsRun,
      productionBrief,
      aiResult,
      jobContext,
      attempt,
      reviewer
    )
  });
}

async function reviseShotlistWithAi(topic, script, factCheck, ttsRun, productionBrief, aiResult, review, jobContext, assetQualityFeedback = null) {
  const indexedScenes = (aiResult.scenes || []).map((scene, index) => ({
    index: index + 1,
    key: `${scene.sourceSegmentIndex}:${scene.sourceSegmentOrder}`,
    scene
  }));
  const requestedIndexes = new Set([
    ...(review.issues || []).flatMap((issue) => issue.sceneIndexes || []),
    ...(assetQualityFeedback?.clipIndexes || [])
  ].map(Number).filter((index) => index >= 1 && index <= indexedScenes.length));
  const targetScenes = requestedIndexes.size
    ? indexedScenes.filter(({ index }) => requestedIndexes.has(index))
    : indexedScenes;
  const affectedSegmentIndexes = new Set(targetScenes.map(({ scene }) => Number(scene.sourceSegmentIndex)));
  const chunks = requestedIndexes.size
    ? targetScenes.map((scene) => [scene])
    : [...affectedSegmentIndexes]
      .sort((left, right) => left - right)
      .map((segmentIndex) => indexedScenes.filter(({ scene }) => Number(scene.sourceSegmentIndex) === segmentIndex));
  const sequenceContext = indexedScenes.map(({ index, key, scene }) => ({
    index,
    key,
    shotRole: scene.shotRole,
    visualFamily: scene.visualFamily,
    scenePurpose: scene.scenePurpose,
    physicalState: scene.physicalState,
    cleanContent: scene.cleanContent,
    claimRefs: scene.claimRefs
  }));
  const supportedClaims = (factCheck.claims || []).filter((claim) => claim.status === "SUPPORTED" && claim.useInVideo !== false);
  const revisedChunks = new Array(chunks.length);
  const projectDir = await ensureProjectFolders(topic.id);
  const progressPath = path.join(projectDir, "manifests", "SHOTLIST_REVISION_PROGRESS.json");
  const reviewSignature = buildQualityContractHash({
    review: buildQualityFindingSignature(review.issues || [], review.deterministicIssues || []),
    assetQualityFeedback: assetQualityFeedback || null
  });
  const baseHash = createHash("sha256").update(JSON.stringify(aiResult.scenes || [])).digest("hex");
  const evidenceHash = buildShotlistEvidenceHash(factCheck);
  const productionContractHash = buildShotlistUpstreamContractHash(factCheck, script, ttsRun, productionBrief);
  let cachedProgress = null;
  let revisionCacheWrite = Promise.resolve();
  try {
    const candidate = JSON.parse(await readFile(progressPath, "utf8"));
    if (Number(candidate.ttsRunId) === Number(ttsRun.id)
      && Number(candidate.scriptId) === Number(script.id)
      && Number(candidate.contractVersion || 0) === SHOTLIST_CONTRACT_VERSION
      && candidate.evidenceHash === evidenceHash
      && candidate.productionContractHash === productionContractHash
      && candidate.reviewSignature === reviewSignature
      && candidate.baseHash === baseHash) cachedProgress = candidate;
  } catch {
    // A missing or stale partial correction is ignored.
  }
  const cachedChunks = cachedProgress?.chunks && typeof cachedProgress.chunks === "object"
    ? cachedProgress.chunks
    : {};
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const chunkKey = String(chunk[0]?.scene?.sourceSegmentIndex || chunkIndex + 1);
    const cachedChunk = cachedChunks[chunkKey];
    const expectedKeys = chunk.map(({ key }) => key);
    const returnedKeys = (cachedChunk?.scenes || []).map((scene) => `${scene.sourceSegmentIndex}:${scene.sourceSegmentOrder}`);
    if (returnedKeys.length === expectedKeys.length && returnedKeys.every((key, index) => key === expectedKeys[index])) {
      revisedChunks[chunkIndex] = cachedChunk;
    }
  }
  const persistRevisionProgress = async () => {
    const chunkSnapshot = {};
    for (const [chunkIndex, chunk] of chunks.entries()) {
      if (!revisedChunks[chunkIndex]) continue;
      chunkSnapshot[String(chunk[0]?.scene?.sourceSegmentIndex || chunkIndex + 1)] = revisedChunks[chunkIndex];
    }
    const snapshot = JSON.stringify({
      ttsRunId: ttsRun.id,
      scriptId: script.id,
      contractVersion: SHOTLIST_CONTRACT_VERSION,
      evidenceHash,
      productionContractHash,
      reviewSignature,
      baseHash,
      chunks: chunkSnapshot,
      updatedAt: new Date().toISOString()
    }, null, 2);
    revisionCacheWrite = revisionCacheWrite.then(() => writeFile(progressPath, snapshot, "utf8"));
    await revisionCacheWrite;
  };
  let nextChunkIndex = 0;
  let completedChunks = revisedChunks.filter(Boolean).length;
  const runRevisionWorker = async () => {
    while (nextChunkIndex < chunks.length) {
      const chunkIndex = nextChunkIndex;
      nextChunkIndex += 1;
      const chunk = chunks[chunkIndex];
      if (revisedChunks[chunkIndex]) continue;
      const exactKeys = chunk.map(({ key }) => key);
      const prompt = `
You are revising one contiguous chunk of a Korean cinematic engineering short after an independent whole-sequence review.
Return a SHOTLIST JSON object containing only the target scenes in this chunk, in the same order.

Rules:
- Return exactly ${chunk.length} scenes and preserve these sourceSegmentIndex:sourceSegmentOrder keys exactly: ${exactKeys.join(", ")}.
- These scenes belong to one TTS segment. Keep sourceSegmentOrder as a forward physical progression that follows the approved narration; never show a completed result and then return to its earlier state.
- Use the complete sequence context to avoid creating a state that merely duplicates a scene outside this chunk.
- Apply every relevant review issue in scenePurpose, cleanContent, physicalState, stateChangeReason, visualFamily, required/forbidden elements, and INFO. Do not merely describe the fix in notes.
- Replace cosmetic reframing with a genuinely different supported physical state, observation scale, material/contact detail, action, or consequence.
- Do not invent unsupported interiors, hidden components, cutaways, dimensions, failure, movement, or load paths. If evidence cannot support a different state, simplify the observation honestly instead of fabricating detail.
- Preserve each target scene's approved narrationAnchor wording and supported claimRefs.
- Keep every CLEAN frame text-free and every motionPolicy usable as a first frame for a restrained four-second I2V clip.
- Every CLEAN frame must be one continuous camera view of one physical state. Never put split-screen, collage, panels, inset views, before/after, ghosted duplicate states, multiple moments, floor plans, elevations, technical drawings, or schematic diagrams in requiredVisibleElements, cleanContent, or physicalState.
- requiredVisibleElements must name tangible objects, materials, contacts, deformation, fluid levels, or environmental evidence visible in that single view. Graphic comparison concepts belong only in INFO.
- INFO defaults to none and must be removed when video or CLEAN can show the relationship.

Supported claims:
${JSON.stringify(supportedClaims, null, 2)}

Verified visual evidence:
${JSON.stringify(factCheck.visualEvidence || [], null, 2)}

Whole-sequence review:
${JSON.stringify(review, null, 2)}

CLEAN quality correction scope (only these clip indexes may change because the upstream contract changed):
${JSON.stringify(assetQualityFeedback || null, null, 2)}

Complete sequence context, compact form:
${JSON.stringify(sequenceContext, null, 2)}

Target scenes to revise:
${JSON.stringify(chunk.map(({ index, key, scene }) => ({ index, key, ...scene })), null, 2)}
      `.trim();
      const chunkResult = await runCodexJson(
        prompt,
        `shotlist-revision-${topic.id}-${chunkIndex + 1}`,
        240000,
        {
          signal: jobContext?.signal,
          outputSchema: SHOTLIST_OUTPUT_SCHEMA,
          models: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5"]
        }
      );
      const returnedKeys = (chunkResult?.scenes || []).map((scene) => `${scene.sourceSegmentIndex}:${scene.sourceSegmentOrder}`);
      if (returnedKeys.length !== exactKeys.length || returnedKeys.some((key, index) => key !== exactKeys[index])) {
        throw new Error(`장면표 교정 ${chunkIndex + 1} 묶음이 장면 키 또는 수량을 바꿨습니다.`);
      }
      revisedChunks[chunkIndex] = chunkResult;
      await persistRevisionProgress();
      completedChunks += 1;
      jobContext?.progress(
        Math.min(94, 92 + Math.round((completedChunks / chunks.length) * 2)),
        `전체 맥락을 유지하며 장면표 교정 ${completedChunks}/${chunks.length} 묶음을 완료했습니다.`
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, () => runRevisionWorker()));
  const revisedByKey = new Map(revisedChunks.flatMap((chunk) => chunk.scenes || []).map((scene) => (
    [`${scene.sourceSegmentIndex}:${scene.sourceSegmentOrder}`, scene]
  )));
  const revisedResult = {
    designSummary: revisedChunks.map((chunk) => chunk.designSummary).filter(Boolean).join(" / ") || aiResult.designSummary,
    continuityRules: [...new Set([...(aiResult.continuityRules || []), ...revisedChunks.flatMap((chunk) => chunk.continuityRules || [])])],
    scenes: indexedScenes.map(({ key, scene }) => revisedByKey.get(key) || scene),
    notes: [...new Set([...(aiResult.notes || []), ...revisedChunks.flatMap((chunk) => chunk.notes || [])])]
  };
  await unlink(progressPath).catch(() => {});
  return revisedResult;
}

function buildShotlistEvidenceHash(factCheck) {
  const evidenceContract = {
    claims: (factCheck?.claims || [])
      .filter((claim) => claim.status === "SUPPORTED" && claim.useInVideo !== false)
      .map((claim) => ({
        id: claim.id,
        statement: claim.statement,
        status: claim.status,
        useInVideo: claim.useInVideo
      })),
    visualEvidence: factCheck?.visualEvidence || [],
    simplifications: factCheck?.simplifications || []
  };
  return createHash("sha256").update(JSON.stringify(evidenceContract)).digest("hex");
}

function buildShotlistUpstreamContractHash(factCheck, script, ttsRun, productionBrief) {
  return buildQualityContractHash({
    shotlistContractVersion: SHOTLIST_CONTRACT_VERSION,
    evidenceHash: buildShotlistEvidenceHash(factCheck),
    scriptId: script?.id,
    productionScript: script?.productionScript,
    ttsRunId: ttsRun?.id,
    ttsSegments: (ttsRun?.segments || []).map((segment) => ({
      segmentIndex: segment.segmentIndex,
      text: segment.text,
      durationSec: segment.durationSec
    })),
    productionBriefId: productionBrief?.id,
    productionBriefRevision: productionBrief?.revision,
    visualStates: productionBrief?.visualStates
  });
}

async function runShotlistQualityLoop(topic, script, factCheck, ttsRun, productionBrief, initialAiResult, jobContext) {
  let aiResult = enforceShotlistBriefContracts(normalizeAiShotlistInfoPlan(initialAiResult), script, productionBrief);
  const reviews = [];
  let review = null;
  let attempt = 0;
  const startedAt = Date.now();
  while (true) {
    attempt += 1;
    jobContext?.progress(Math.min(96, 89 + (attempt - 1) * 2), `독립 장면표 검수 ${attempt}: 전체 영상의 물리 상태 전개와 반복 구도를 확인합니다.`);
    review = await reviewShotlistConsensus(topic, script, factCheck, ttsRun, productionBrief, aiResult, jobContext, attempt);
    reviews.push(review);
    if (review.passed) break;
    if (!shouldContinueQualityRepair(review, attempt, startedAt, QUALITY_AUTO_REPAIR_LIMIT, topic.runLane === "production_canary" ? "autoConverge" : "benchmark")) break;
    jobContext?.progress(Math.min(97, 91 + (attempt - 1) * 2), `품질 수렴 판단: ${review.convergence.reason}`);
    aiResult = enforceShotlistBriefContracts(normalizeAiShotlistInfoPlan(
      await reviseShotlistWithAi(topic, script, factCheck, ttsRun, productionBrief, aiResult, review, jobContext)
    ), script, productionBrief);
    const revisedCacheDir = await ensureProjectFolders(topic.id);
    await writeFile(path.join(revisedCacheDir, "manifests", "SHOTLIST_AI_REVISED_CACHE.json"), JSON.stringify({
      ...aiResult,
      ttsRunId: ttsRun.id,
      scriptId: script.id,
      targetClipCount: aiResult.scenes.length,
      contractVersion: SHOTLIST_CONTRACT_VERSION,
      evidenceHash: buildShotlistEvidenceHash(factCheck),
      productionContractHash: buildShotlistUpstreamContractHash(factCheck, script, ttsRun, productionBrief),
      updatedAt: new Date().toISOString()
    }, null, 2), "utf8");
    buildAiShotlistItems(topic, script, factCheck, ttsRun, aiResult, productionBrief);
  }
  if (!review.passed) {
    return { aiResult, reviews, passed: false, review };
  }
  return { aiResult, reviews, passed: true, review };
}

async function designShotlistWithAi(topic, script, factCheck, ttsRun, productionBrief, jobContext, previousAiResult = null) {
  const rules = await loadRuleContext(topic.mainTopic);
  const measuredTtsTimeline = getShotlistTimeline(ttsRun);
  const { measuredTotalDurationSec: measuredTotal, timelineDurations, minimumCoverageCount } = measuredTtsTimeline;
  const targetClipCount = determineEvidenceBoundShotCount(script, productionBrief, measuredTotal, minimumCoverageCount);
  const shotCounts = allocateShotCounts(ttsRun.segments || [], targetClipCount, timelineDurations);
  const directionContract = inferScreenDirectionContract(script, factCheck);
  const evidenceHash = buildShotlistEvidenceHash(factCheck);
  const productionContractHash = buildShotlistUpstreamContractHash(factCheck, script, ttsRun, productionBrief);
  const projectDir = await ensureProjectFolders(topic.id);
  const chunkCachePath = path.join(projectDir, "manifests", "SHOTLIST_AI_CACHE.json");
  const revisedCachePath = path.join(projectDir, "manifests", "SHOTLIST_AI_REVISED_CACHE.json");
  let diskCache = null;
  let diskCacheSource = "";
  for (const candidatePath of [revisedCachePath, chunkCachePath]) {
    try {
      const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
      if (Number(candidate.ttsRunId) === Number(ttsRun.id)
        && Number(candidate.scriptId) === Number(script.id)
        && Number(candidate.targetClipCount) === Number(targetClipCount)
        && Number(candidate.contractVersion || 0) === SHOTLIST_CONTRACT_VERSION
        && candidate.evidenceHash === evidenceHash
        && candidate.productionContractHash === productionContractHash) {
        diskCache = candidate;
        diskCacheSource = candidatePath === revisedCachePath
          ? "revised_current"
          : "chunk";
        break;
      }
    } catch {
      // Missing or malformed caches are ignored; the assigned chunk is regenerated.
    }
  }
  const cacheCompatible = diskCache
    && Number(diskCache.ttsRunId) === Number(ttsRun.id)
    && Number(diskCache.scriptId) === Number(script.id)
    && Number(diskCache.targetClipCount) === Number(targetClipCount)
    && diskCache.evidenceHash === evidenceHash
    && diskCache.productionContractHash === productionContractHash;
  const seedAiResult = cacheCompatible && Array.isArray(diskCache.scenes)
    ? diskCache
    : previousAiResult;
  const cachedScenesByKey = new Map((seedAiResult?.scenes || []).map((scene) => (
    [`${scene.sourceSegmentIndex}:${scene.sourceSegmentOrder}`, scene]
  )));
  let cacheWrite = Promise.resolve();
  const persistChunkCache = (chunkResult) => {
    for (const scene of chunkResult.scenes || []) {
      cachedScenesByKey.set(`${scene.sourceSegmentIndex}:${scene.sourceSegmentOrder}`, scene);
    }
    const snapshot = {
      ttsRunId: ttsRun.id,
      scriptId: script.id,
      targetClipCount,
      contractVersion: SHOTLIST_CONTRACT_VERSION,
      evidenceHash,
      productionContractHash,
      designSummary: chunkResult.designSummary || seedAiResult?.designSummary || "",
      continuityRules: [...new Set([...(seedAiResult?.continuityRules || []), ...(chunkResult.continuityRules || [])])],
      scenes: [...cachedScenesByKey.values()],
      notes: [...new Set([...(seedAiResult?.notes || []), ...(chunkResult.notes || [])])],
      updatedAt: new Date().toISOString()
    };
    cacheWrite = cacheWrite.then(() => writeFile(chunkCachePath, JSON.stringify(snapshot, null, 2), "utf8"));
    return cacheWrite;
  };
  const ttsSegments = (ttsRun.segments || []).map((segment) => ({
    sourceSegmentIndex: segment.segmentIndex,
    label: segment.label,
    narration: segment.text,
    measuredDurationSec: segment.durationSec || segment.estimatedDurationSec,
    timelineDurationSec: Number(timelineDurations[Number(segment.segmentIndex) - 1].toFixed(2)),
    requiredShotCount: shotCounts[Number(segment.segmentIndex) - 1]
  }));
  const sharedInstructions = `
당신은 시네마틱 공학 다큐멘터리 쇼츠의 장면 감독입니다.
승인된 대본과 사실 검증, 실제 TTS 길이를 읽고 이미지와 영상 제작에 바로 사용할 장면표를 설계하세요.

반드시 지킬 규칙:
- 이번 요청에 배정된 각 TTS 구간을 requiredShotCount만큼 분해하고 sourceSegmentOrder를 1부터 연속으로 부여하세요. 배정되지 않은 TTS 구간의 장면은 출력하지 마세요.
- 같은 TTS 구간 안에서도 sourceSegmentOrder는 내레이션의 실제 시간 순서를 따라야 합니다. 완료 상태를 먼저 보여준 뒤 시작·중간 상태로 되돌아가지 마세요.
- 모든 장면은 최종 편집에서 4초 이하가 되도록 이미 계산되었습니다. 긴 문장을 탑 전경 한 장으로 버티지 말고 원인, 작용, 내부 메커니즘, 결과처럼 물리 상태가 달라지는 숏으로 나누세요.
- narrationAnchor는 해당 TTS narration에서 이 화면이 담당하는 짧은 원문 구절을 그대로 가져오세요.
- 내레이션 문장을 고치거나 새로운 사실, 수치, 인과관계를 만들지 마세요.
- claimRefs는 승인 대본에 존재하는 검증 주장 ID만 사용하고 각 장면에 하나 이상 연결하세요.
- 각 CLEAN 장면은 한 장의 독립된 9:16 시네마틱 이미지여야 하며 텍스트, 화살표, 숫자, INFO 그래픽이 없어야 합니다.
- 인접 장면은 구도만 살짝 바꾸는 반복이 아니라 물리 상태, 관찰 스케일, 피사체 행동 또는 인과 단계가 명확히 달라야 합니다.
- requiredShotCount는 실제 TTS를 네이티브 속도의 4초 이하 H3 클립으로 덮기 위한 최소 수량이므로 임의로 줄이지 마세요. 하나의 큰 상태 안에서는 접근, 접촉, 작동 시작, 중간 반응, 조건 성립, 결과처럼 검증 가능한 미세 단계를 전진 순서로 나눕니다.
- 원경, 지반 단면, 부품 근접, 실제 작업, 전후 축 비교, 관측 장면처럼 내용에 맞춰 visualFamily를 바꾸세요. 같은 대상의 외관 전경을 연속으로 반복하지 마세요.
- shotRole은 장면이 서사에서 하는 일을 뜻합니다. 문제를 제기하는 대목에는 원인과 눈에 보이는 물리 결과를 분리하고, 근거가 허용하면 failure_simulation 장면으로 추가 침하, 균열, 변형, 압력 집중 등의 위험 상태를 실제 화면에 보여주세요.
- 반사실적 failure_simulation은 실제 붕괴를 단정하지 말고 검증 근거가 지지하는 위험만 표현하며 INFO 라벨로 가상 위험 시뮬레이션임을 밝히세요.
- requiredVisibleElements에는 이미지에서 식별되어야 할 구체적인 요소를 2~6개, forbiddenVisibleElements에는 이 장면을 망치는 오해·반대 방향·평온한 상태 등을 적으세요.
- referencePolicy는 외관의 동일 대상 정체성이 꼭 필요할 때만 subject_identity를 사용합니다. cutaway, macro, simulation, action은 첫 전경을 억지로 참조하지 말고 none 또는 같은 visualFamily의 previous_in_family를 사용하세요.
- motionPolicy는 first_frame을 사용하세요. 큰 물리 상태 전환은 H3가 지어내게 하지 말고 전환 전과 결과 상태를 서로 다른 CLEAN 장면으로 분리하세요.
- cleanContent에는 화면에 실제로 보여야 할 피사체, 위치, 상태, 구도, 깊이 관계를 구체적으로 씁니다.
- physicalState는 정지 명사가 아니라 그 순간의 물리 상태를 씁니다. stateChangeReason에는 이전 장면과 분리해야 하는 이유를 씁니다.
- forceFlow는 하중, 침하, 압력, 유동, 열, 진동 또는 에너지의 시작점과 방향을 정확히 씁니다.
- INFO의 기본값은 none입니다. CLEAN과 영상의 실제 변화만으로 의미가 읽히면 그래픽을 추가하지 마세요.
- INFO는 하중 경로, 보이지 않는 인과, 동일 기준의 전후 차이처럼 그래픽 없이는 정확히 읽기 어려운 정보에만 사용합니다. 화면에 이미 보이는 물체나 상태의 이름표는 INFO가 아닙니다.
- 같은 TTS 구간에는 INFO 장면을 최대 1개만 허용하며 0개여도 됩니다. 전체 장면의 절반 이상에 INFO를 넣지 마세요.
- 첫 전경, 명백한 문제 상태, 작업 행동, 관측, 결론처럼 영상 자체가 설명하는 장면은 우선 none을 선택하세요. 금지 표시는 실제 오해를 막는 데 꼭 필요할 때만 사용합니다.
- 라벨은 최대 2개입니다. 북쪽·남쪽·동쪽·서쪽은 제작 연속성을 위한 내부 정보이며 화면 라벨로 노출하지 마세요. 보이는 물체를 '탑 본체', '기초 아래', '개입 전'처럼 그대로 이름 붙이지 마세요.
- INFO가 none이면 labels와 anchors를 비우고 infoFocus에 '추가 INFO 없음. CLEAN과 영상의 실제 변화만 사용한다.'라고 씁니다.
- 전후 비교는 같은 기준점에서 실제 차이가 보일 때만 쓰고, 검증되지 않은 각도·거리·수치를 만들지 마세요.
- 방향이 중요한 주제는 화면 좌우 기준을 continuityRules에 고정하되, 이 제작용 방향을 INFO 라벨과 혼동하지 마세요.
- 카메라 움직임은 4초 I2V에서 형상이 무너지지 않는 작고 구체적인 움직임만 씁니다.
- 결과는 JSON 객체 하나만 출력하세요.

[초기 제작 MD 핵심 규칙]
${rules.workflowExcerpt}

[도메인 규칙]
${rules.domainRules}

[전체 연속성 기준]
- 전체 TTS 길이 ${measuredTotal.toFixed(2)}초, 전체 목표 ${targetClipCount}개 장면입니다.
- 주제의 동일 대상, 재료, 시대, 날씨, 화면 방향은 유지하되 관찰 스케일과 물리 상태는 장면 목적에 따라 적극적으로 바꾸세요.
- 피사체 외관을 반복하는 것으로 내부 원인, 작업 과정, 실패 위험 또는 구조 반응을 대신하지 마세요.
${directionContract ? `- 절대 화면 방향: ${directionContract.left}=화면 왼쪽, ${directionContract.right}=화면 오른쪽. 어떤 묶음에서도 뒤집지 마세요.` : ""}
- requiredVisibleElements에는 CLEAN 이미지에 실제로 보이는 물체, 재료, 접촉, 변형, 위치만 적으세요. 축선, 중심축, 기준선, 화살표, 라벨, 숫자 같은 INFO 그래픽은 넣지 마세요.

[주제]
${JSON.stringify({ id: topic.id, title: topic.title, hook: topic.hook }, null, 2)}

[검증된 주장]
${JSON.stringify((factCheck.claims || []).filter((claim) => claim.useInVideo !== false).map((claim) => ({
  id: claim.id,
  statement: claim.statement,
  status: claim.status
})), null, 2)}

[검증된 시각 근거]
${JSON.stringify(factCheck.visualEvidence || [], null, 2)}

[승인된 제작 설계서와 시각 상태 계약]
${JSON.stringify(productionBrief, null, 2)}

- Every scene must copy visualStateId from its matching approved script row.
- The first approved evidenceBeat in each visual state is the minimum visual contract. Copy it for sourceSegmentOrder 1.
- When measured TTS needs additional clips, create a new evidenceBeatId using the same visualStateId and a one-based B suffix. Each added beat must show a different evidence-bearing focus, action, relationship, or physical moment supported by that state's claimRefs.
- Never invent a visual state outside this production brief.
- Multiple clips inside one visual state must not differ only by crop, lens, weather, or camera motion. The full sequence review decides whether added beats are strong enough to join the approved production contract.

[영상 단순화 제한]
${JSON.stringify(factCheck.simplifications || [], null, 2)}

[대본 전체 구조]
${JSON.stringify({
  coreQuestion: script.coreQuestion,
  coreConflict: script.coreConflict,
  coreMechanism: script.coreMechanism,
  visibleFlow: script.visibleFlow,
  turningPoint: script.turningPoint,
  designIntervention: script.designIntervention,
  limitations: script.limitations
}, null, 2)}
`.trim();

  const chunks = [];
  for (let index = 0; index < ttsSegments.length; index += 1) {
    chunks.push(ttsSegments.slice(index, index + 1));
  }
  const chunkResults = new Array(chunks.length);
  let nextChunkIndex = 0;
  let completedChunks = 0;
  jobContext?.progress(12, `TTS ${ttsSegments.length}개 구간을 ${chunks.length}개 AI 설계 묶음으로 나눴습니다.`);

  const runChunkWorker = async () => {
    while (nextChunkIndex < chunks.length) {
      const chunkIndex = nextChunkIndex;
      nextChunkIndex += 1;
      const assignedSegments = chunks[chunkIndex];
      const assignedIndexes = new Set(assignedSegments.map((segment) => Number(segment.sourceSegmentIndex)));
      const assignedScriptRows = (script.productionScript || [])
        .map((row, index) => ({ sourceSegmentIndex: index + 1, ...row }))
        .filter((row) => assignedIndexes.has(row.sourceSegmentIndex));
      const assignedCount = assignedSegments.reduce((sum, segment) => sum + Number(segment.requiredShotCount || 0), 0);
      const prompt = `${sharedInstructions}

[이번 묶음의 승인 대본 행]
${JSON.stringify(assignedScriptRows, null, 2)}

[이번 묶음의 실제 TTS 구간]
${JSON.stringify(assignedSegments, null, 2)}

이 묶음에서는 정확히 ${assignedCount}개 scenes를 출력하세요.
`.trim();
      const runChunk = async (chunkPrompt, suffix) => {
        return runCodexJson(
          chunkPrompt,
          `shotlist-part-${topic.id}-${chunkIndex + 1}-${suffix}`,
          240000,
          {
            signal: jobContext?.signal,
            models: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.5"],
            onRetry({ nextModel, attempt }) {
              jobContext?.progress(16 + Math.round((completedChunks / chunks.length) * 68), `${chunkIndex + 1}번 묶음이 혼잡해 ${nextModel}로 전환합니다. (${attempt}/4)`);
            }
          }
        );
      };
      const previousScenes = Array.isArray(seedAiResult?.scenes)
        ? seedAiResult.scenes.filter((scene) => assignedIndexes.has(Number(scene.sourceSegmentIndex)))
        : [];
      let chunkResult = previousScenes.length === assignedCount
        ? {
            designSummary: seedAiResult.designSummary || "이전 장면 설계 재사용",
            continuityRules: seedAiResult.continuityRules || [],
            scenes: previousScenes,
            notes: seedAiResult.notes || []
          }
        : await runChunk(prompt, "initial");
      if (chunkResult.scenes.length > assignedCount) {
        chunkResult = {
          ...chunkResult,
          scenes: chunkResult.scenes
            .filter((scene) => assignedIndexes.has(Number(scene.sourceSegmentIndex)))
            .sort((a, b) => Number(a.sourceSegmentOrder) - Number(b.sourceSegmentOrder))
            .slice(0, assignedCount)
        };
      }
      if (chunkResult.scenes.length !== assignedCount) {
        throw new Error(`${chunkIndex + 1}번 AI 장면 묶음이 필요한 ${assignedCount}개 장면을 반환하지 않았습니다.`);
      }
      let contractIssues = getAiSceneContractIssues(chunkResult.scenes, directionContract);
      if (contractIssues.length) {
        jobContext?.progress(
          16 + Math.round((completedChunks / chunks.length) * 68),
          `${chunkIndex + 1}번 묶음의 화면 방향과 CLEAN 요소를 자동 교정합니다.`
        );
        const repairPrompt = `${prompt}

[첫 결과의 자동 검수 오류]
${contractIssues.map((issue) => `- ${issue}`).join("\n")}

[첫 결과]
${JSON.stringify(chunkResult, null, 2)}

첫 결과의 장면 수, sourceSegmentIndex, sourceSegmentOrder와 검증 주장 연결은 유지하고 위 오류만 모두 고쳐 전체 JSON 객체를 다시 출력하세요.`;
        chunkResult = await runChunk(repairPrompt, "repair");
        contractIssues = getAiSceneContractIssues(chunkResult.scenes, directionContract);
        if (contractIssues.length) {
          throw new Error(`${chunkIndex + 1}번 AI 장면 묶음이 자동 교정 후에도 계약을 위반했습니다: ${contractIssues.join(" / ")}`);
        }
      }
      chunkResults[chunkIndex] = chunkResult;
      await persistChunkCache(chunkResult);
      completedChunks += 1;
      jobContext?.progress(
        Math.min(84, 16 + Math.round((completedChunks / chunks.length) * 68)),
        `AI 장면 설계 ${completedChunks}/${chunks.length} 묶음을 완료했습니다.`
      );
    }
  };

  const workerResults = await Promise.allSettled(
    Array.from({ length: Math.min(2, chunks.length) }, () => runChunkWorker())
  );
  const failedWorker = workerResults.find((worker) => worker.status === "rejected");
  if (failedWorker) throw failedWorker.reason;
  const result = {
    designSummary: chunkResults.map((chunk) => chunk.designSummary).filter(Boolean).join(" / "),
    continuityRules: [...new Set(chunkResults.flatMap((chunk) => chunk.continuityRules || []))],
    scenes: chunkResults.flatMap((chunk) => chunk.scenes || []),
    notes: [...new Set(chunkResults.flatMap((chunk) => chunk.notes || []))],
    sourceCache: diskCacheSource
  };
  jobContext?.progress(88, "AI 장면표의 TTS 연결, 주장 근거와 중복 구도를 검사합니다.");
  return result;
}

function recordShotlistEvidenceCapacityFailure(topic, script, factCheck, ttsRun, productionBrief) {
  const timeline = getShotlistTimeline(ttsRun);
  const capacity = getShotlistEvidenceCapacity(script, productionBrief);
  if (timeline.minimumCoverageCount <= capacity.verifiedEvidenceCapacity) return null;

  const message = `실제 TTS ${timeline.measuredTotalDurationSec.toFixed(2)}초에는 4초 이하 장면 ${timeline.minimumCoverageCount}개가 필요하지만, 검증된 시각 상태·증거 비트 용량은 ${capacity.verifiedEvidenceCapacity}개뿐입니다.`;
  const issue = {
    code: "insufficient_visual_depth",
    severity: "error",
    message,
    repairInstruction: "공식 사진·도면·단면으로 서로 다른 시각 상태 또는 증거 비트를 보강하세요. 그 근거를 확보할 수 없으면 반복 장면을 만들지 말고 대본 범위를 줄이세요."
  };
  const contractHash = buildShotlistUpstreamContractHash(factCheck, script, ttsRun, productionBrief);
  const runId = recordTopicAttempt(topic.id, "shotlist_quality", "failed", message, {
    engineVersion: QUALITY_ENGINE_VERSION,
    contractHash,
    score: 0,
    issues: [issue],
    actualTtsDurationSec: timeline.measuredTotalDurationSec,
    minimumCoverageCount: timeline.minimumCoverageCount,
    ...capacity
  });
  const convergence = evaluateQualityConvergence({
    runId,
    topicId: topic.id,
    stage: "shotlist_quality",
    passed: false,
    score: 0,
    issues: [issue],
    deterministicIssues: [issue],
    contractHash
  });
  db.prepare("UPDATE shotlists SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND status != 'stale'")
    .run(topic.id);
  updateTopicReviewStatement.run("verified", "shotlist", topic.id);
  return { message, issue, timeline, capacity, convergence };
}

async function generateShotlist(payload, jobContext = null) {
  const topicId = Number(payload.topicId);
  if (!topicId) {
    throw new Error("topic id가 필요합니다.");
  }

  const topicRow = getTopicStatement.get(topicId);
  if (!topicRow) {
    throw new Error("주제를 찾을 수 없습니다.");
  }
  const topic = mapTopicRow(topicRow);
  let script = mapScriptRow(getScriptByTopicStatement.get(topicId));
  const canaryAiApproved = topic.runLane === "production_canary" && Boolean(topic.canaryAiPassAt) && script?.status === "draft";
  if (!script || (script.status !== "approved" && !canaryAiApproved)) {
    throw new Error("승인된 대본 또는 canary AI_PASS 대본이 있어야 장면표를 만들 수 있습니다.");
  }

  const ttsRun = mapTtsRunRow(getLatestTtsRunByTopicStatement.get(topicId));
  if (!ttsRun || ttsRun.status !== "generated" || !ttsRun.totalDurationSec) {
    throw new Error("실제 길이가 기록된 TTS 생성본이 필요합니다.");
  }
  const factCheck = mapFactCheckRow(getFactCheckByTopicStatement.get(topicId));
  if (!factCheck || factCheck.status !== "PASS") {
    throw new Error("PASS 사실 검증 결과가 있어야 AI 장면표를 설계할 수 있습니다.");
  }

  return runTopicOperation(topicId, "장면표 생성", async () => {
  const rules = await loadRuleContext(topic.mainTopic);
  let productionBrief = await ensureProductionBrief(topic, factCheck, rules, jobContext);
  if (productionBrief.status !== "ready") throw new Error("제작 설계서가 HOLD라서 장면표를 만들 수 없습니다.");
  script = mapScriptRow(getScriptByTopicStatement.get(topicId));
  validateScriptContract(script, productionBrief);
  const capacityFailure = recordShotlistEvidenceCapacityFailure(topic, script, factCheck, ttsRun, productionBrief);
  if (capacityFailure) {
    jobContext?.progress(90, "실제 TTS 길이를 덮을 검증 시각 근거가 부족해 AI 장면 설계를 시작하지 않습니다.");
    throw new Error(`${capacityFailure.message} ${capacityFailure.issue.repairInstruction}`);
  }
  const previousShotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
  const previousReview = previousShotlist?.raw?.qualityReviews?.at(-1);
  const assetQualityFeedback = payload.assetQualityFeedback?.findings?.length
    ? payload.assetQualityFeedback
    : null;
  const targetedReview = assetQualityFeedback
    ? {
        summary: assetQualityFeedback.decisionReason || "CLEAN 품질 교정 범위",
        issues: assetQualityFeedback.findings.map((finding) => ({
          ...finding,
          sceneIndexes: finding.clipIndex ? [Number(finding.clipIndex)] : assetQualityFeedback.clipIndexes || []
        })),
        deterministicIssues: []
      }
    : previousReview;
  const initialAiResult = payload.remediationRoute === "local_targeted_revision" && previousShotlist?.raw?.aiResult && targetedReview
    ? enforceShotlistBriefContracts(normalizeAiShotlistInfoPlan(
      await reviseShotlistWithAi(topic, script, factCheck, ttsRun, productionBrief, previousShotlist.raw.aiResult, targetedReview, jobContext, assetQualityFeedback)
    ), script, productionBrief)
    : await designShotlistWithAi(topic, script, factCheck, ttsRun, productionBrief, jobContext, previousShotlist?.raw?.aiResult);
  const qualityResult = await runShotlistQualityLoop(topic, script, factCheck, ttsRun, productionBrief, initialAiResult, jobContext);
  const aiResult = qualityResult.aiResult;
  if (qualityResult.passed) {
    productionBrief = promoteApprovedShotlistBeats(topic, factCheck, productionBrief, aiResult);
  }
  const items = buildAiShotlistItems(topic, script, factCheck, ttsRun, aiResult, productionBrief);
  if (!items.length) {
    throw new Error("AI가 유효한 장면표를 만들지 못했습니다.");
  }

  const projectDir = await ensureProjectFolders(topicId);
  const manifestPath = path.join(projectDir, "manifests", "IMAGE_SEQUENCE.md");
  const relativeManifestPath = toRelativeWorkspacePath(manifestPath);
  const notes = [
    "AI 장면 감독이 승인 대본, 사실 검증과 TTS 실측 길이를 바탕으로 장면별 물리 상태와 구도를 설계했다.",
    "CLEAN 이미지 프롬프트, INFO 프롬프트, 영상 프롬프트는 사용자 승인 후 다음 게이트에서 생성한다.",
    "각 원본 영상 클립은 4초 기준이며 최종 편집에서 약 1.5~4초를 사용한다.",
    `TTS ${ttsRun.segments.length}개 구간을 ${items.length}개 물리 장면으로 분해하고 실제 길이 ${ttsRun.totalDurationSec}초를 편집 구간에 반영했다.`,
    ...(Array.isArray(aiResult.notes) ? aiResult.notes : [])
  ];
  const previousPromptsByClip = new Map((previousShotlist?.items || []).map((item) => [Number(item.sortIndex), String(item.cleanPrompt || "")]));
  const changedContractPromptClipIndexes = assetQualityFeedback
    ? items.filter((item) => (assetQualityFeedback.clipIndexes || []).includes(Number(item.sortIndex))
      && previousPromptsByClip.get(Number(item.sortIndex)) !== String(item.cleanPrompt || ""))
      .map((item) => Number(item.sortIndex))
    : [];
  const raw = {
    source: "codex-ai-shot-design-v3-sparse-info",
    infoPlanVersion: INFO_PLAN_VERSION,
    productionBriefId: productionBrief.id,
    ttsRunId: ttsRun.id,
    targetClipCount: items.length,
    designSummary: aiResult.designSummary,
    continuityRules: aiResult.continuityRules,
    aiResult,
    qualityReviews: qualityResult.reviews,
    qualityStatus: qualityResult.passed ? "passed" : "needs_revision",
    qualityDecision: qualityResult.review?.convergence || null,
    assetQualityCorrection: assetQualityFeedback ? {
      requestedClipIndexes: assetQualityFeedback.clipIndexes || [],
      changedContractPromptClipIndexes,
      feedback: assetQualityFeedback
    } : null,
    generatedAt: new Date().toISOString()
  };

  const shotlistResult = insertShotlistStatement.run(
    topicId,
    script.id,
    ttsRun.id,
    ttsRun.totalDurationSec,
    items.length,
    relativeManifestPath,
    JSON.stringify(notes),
    JSON.stringify(raw)
  );
  const shotlistId = Number(shotlistResult.lastInsertRowid);

  for (const item of items) {
    insertShotlistItemStatement.run(
      shotlistId,
      topicId,
      item.sortIndex,
      item.sceneId,
      item.keyframeId,
      item.clipId,
      item.sourceSegmentIndex,
      item.sourceSegmentOrder,
      item.visualStateId,
      item.evidenceBeatId,
      item.startSec,
      item.endSec,
      item.durationSec,
      item.scriptExcerpt,
      item.scenePurpose,
      item.cleanContent,
      item.infoFocus,
      item.cameraMotion,
      item.shotRole,
      item.visualFamily,
      item.referencePolicy,
      item.motionPolicy,
      JSON.stringify(item.requiredVisibleElements),
      JSON.stringify(item.forbiddenVisibleElements),
      item.transitionEndState,
      item.physicalState,
      item.stateChangeReason,
      item.forceFlow,
      JSON.stringify(item.claimRefs),
      item.cleanPrompt,
      item.infoPrompt,
      JSON.stringify(item.infoSpec),
      item.videoPrompt,
      item.fileStub
    );
  }

  const markdown = renderImageSequenceMarkdown({
    topic,
    script,
    ttsRun,
    shotlistId,
    items,
    manifestPath: relativeManifestPath
  });
  await writeFile(manifestPath, markdown, "utf8");
  db.prepare("UPDATE shotlists SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND id != ? AND status != 'stale'")
    .run(topicId, shotlistId);
  if (!qualityResult.passed) {
    db.prepare("UPDATE shotlists SET status = 'needs_revision', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(shotlistId);
  }
  updateLifecycleStatement.run("shotlist", topicId);
  jobContext?.progress(
    98,
    qualityResult.passed
      ? "AI 장면표와 IMAGE_SEQUENCE를 저장했습니다."
      : "검수에서 보류된 장면표와 실패 근거를 저장했습니다. 다른 벤치마크와 비교하기 전 자동 재생성하지 않습니다."
  );

  return {
    ...getTopicDetailById(topicId),
    ttsRun,
    shotlist: mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId))
  };
  });
}

function renderCleanPromptsMarkdown(topic, shotlist) {
  return [
    "# CLEAN_KEYFRAME_PROMPTS",
    "",
    `- Topic ID: ${topic.id}`,
    `- 제목: ${topic.title}`,
    `- 승인 장면표: ${shotlist.id}`,
    `- 출력 수량: ${shotlist.clipCount}`,
    "",
    "> 각 프롬프트는 독립된 9:16 CLEAN 이미지 한 장을 생성합니다. 콜라주, 분할 화면, 텍스트와 그래픽을 만들지 않습니다.",
    "",
    ...shotlist.items.flatMap((item) => [
      `## ${String(item.sortIndex).padStart(2, "0")} ${item.sceneId} / ${item.keyframeId}`,
      "",
      `- 출력: ${item.fileStub}_CLEAN.png`,
      `- 대본: ${item.scriptExcerpt}`,
      `- 근거 주장: ${item.claimRefs.join(", ") || "없음"}`,
      "",
      "```text",
      item.cleanPrompt,
      "```",
      ""
    ])
  ].join("\n");
}

function renderInfoPromptsMarkdown(topic, shotlist) {
  return [
    "# INFOGRAPHIC_KEYFRAME_PROMPTS",
    "",
    `- Topic ID: ${topic.id}`,
    `- 제목: ${topic.title}`,
    `- 승인 장면표: ${shotlist.id}`,
    `- 입력: 같은 번호의 승인된 CLEAN PNG`,
    "",
    "> INFO는 새 장면이 아니라 동일 CLEAN을 편집하는 두 번째 패스입니다. 구도와 형상을 바꾸지 않습니다.",
    "",
    ...shotlist.items.flatMap((item) => [
      `## ${String(item.sortIndex).padStart(2, "0")} ${item.sceneId} / ${item.keyframeId}`,
      "",
      `- 입력: ${item.fileStub}_CLEAN.png`,
      `- 출력: ${item.fileStub}_INFO.png`,
      `- 근거 주장: ${item.claimRefs.join(", ") || "없음"}`,
      `- 오버레이 유형: ${item.infoSpec?.type || "미정"}`,
      `- 라벨: ${(item.infoSpec?.labels || []).join(" / ") || "없음"}`,
      `- 앵커: ${(item.infoSpec?.anchors || []).join(" / ") || "없음"}`,
      `- 방향 규칙: ${item.infoSpec?.directionRule || "없음"}`,
      `- 전후 비교 규칙: ${item.infoSpec?.comparisonRule || "없음"}`,
      "",
      "```text",
      item.infoPrompt,
      "```",
      ""
    ])
  ].join("\n");
}

function getApprovableShotlist(topicId) {
  if (!topicId) throw new Error("topicId가 필요합니다.");
  const topic = mapTopicRow(getTopicStatement.get(topicId));
  const shotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
  if (!topic || !shotlist || shotlist.status === "stale") throw new Error("승인할 장면표가 없습니다.");
  if (shotlist.status !== "draft") throw new Error("독립 검수를 통과한 최신 초안 장면표만 승인할 수 있습니다.");
  if (shotlist.items.some((item) => !item.physicalState || !item.stateChangeReason || !item.forceFlow || !item.claimRefs.length)) {
    throw new Error("물리 상태, 새 장면 이유, 힘/흐름 또는 검증 주장 연결이 비어 있어 승인할 수 없습니다.");
  }
  if (shotlist.items.some((item) => item.durationSec > 4.01 || !item.shotRole || !item.visualFamily || item.requiredVisibleElements.length < 2)) {
    throw new Error("4초 커버리지, 장면 역할, 화면 계열 또는 필수 시각 요소가 불완전해 승인할 수 없습니다.");
  }
  const coveredDuration = shotlist.items.reduce((sum, item) => sum + Number(item.durationSec || 0), 0);
  if (coveredDuration + 0.05 < Number(shotlist.totalDurationSec || 0)) {
    throw new Error(`장면 원본이 TTS 전체 길이를 덮지 못합니다. ${coveredDuration.toFixed(2)}/${shotlist.totalDurationSec}초`);
  }
  const invalidInfoSpec = shotlist.items.find((item) => getInfoGraphicSpecIssues(item.infoSpec).length);
  if (invalidInfoSpec) {
    throw new Error(`${invalidInfoSpec.sortIndex}번 INFO 설계 명세가 불완전합니다: ${getInfoGraphicSpecIssues(invalidInfoSpec.infoSpec).join(", ")}`);
  }
  const requiredInfoCount = shotlist.items.filter((item) => item.infoSpec?.requiresOverlay === true && item.infoSpec?.type !== "none").length;
  const minimumRequiredInfoOverlays = getConfiguredProductionRequirements(topic).minimumRequiredInfoOverlays || 0;
  if (requiredInfoCount < minimumRequiredInfoOverlays) throw new Error(`필수 INFO 오버레이가 ${requiredInfoCount}/${minimumRequiredInfoOverlays}개입니다.`);
  return { topic, shotlist };
}

async function finalizeShotlistApproval(topic, shotlist, canaryAiApproval = null) {
  if (canaryAiApproval) {
    db.prepare("UPDATE shotlists SET status = 'approved', raw_json = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(JSON.stringify({ ...shotlist.raw, canaryAiApproval }), shotlist.id);
  } else {
    db.prepare("UPDATE shotlists SET status = 'approved', approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(shotlist.id);
  }
  const projectDir = await ensureProjectFolders(topic.id);
  const promptPath = path.join(projectDir, "prompts", "CLEAN_KEYFRAME_PROMPTS.md");
  const approved = mapShotlistRow(getLatestShotlistByTopicStatement.get(topic.id));
  await writeFile(promptPath, renderCleanPromptsMarkdown(topic, approved), "utf8");
  updateLifecycleStatement.run("prompts", topic.id);
  return getTopicDetailById(topic.id);
}

async function approveShotlist(payload) {
  const { topic, shotlist } = getApprovableShotlist(Number(payload.topicId));
  return finalizeShotlistApproval(topic, shotlist);
}

async function approveCanaryShotlistWithAi(payload) {
  const { topic, shotlist } = getApprovableShotlist(Number(payload.topicId));
  if (topic.runLane !== "production_canary") throw new Error("production canary 장면표만 AI 승인할 수 있습니다.");
  const qualityReviews = Array.isArray(shotlist.raw?.qualityReviews) ? shotlist.raw.qualityReviews : [];
  const passedReviews = qualityReviews.filter((review) => review?.passed === true || review?.action === "pass");
  if (shotlist.raw?.qualityStatus !== "passed" || !passedReviews.length) {
    throw new Error("독립 장면표 검수 PASS 이력이 없어 canary AI 승인을 기록할 수 없습니다.");
  }
  const finalReview = passedReviews.at(-1);
  return finalizeShotlistApproval(topic, shotlist, {
    approvalType: "canary_ai_consensus",
    reviewer: String(payload.reviewer || "shotlist_quality_consensus"),
    qualityScore: Number(finalReview?.score || 0),
    qualityReviewCount: qualityReviews.length,
    recordedAt: new Date().toISOString()
  });
}

function isFiniteNormalizedPoint(point, maxY = 1) {
  return Number.isFinite(Number(point?.x))
    && Number.isFinite(Number(point?.y))
    && Number(point.x) >= 0
    && Number(point.x) <= 1
    && Number(point.y) >= 0
    && Number(point.y) <= maxY;
}

function getDeterministicInfoLayout(item, layout = null) {
  if (item.infoSpec?.type !== "none") return layout;
  return {
    geometryMode: "none",
    guidePoints: [],
    labelPositions: [],
    confidence: 1,
    note: "INFO 없음: CLEAN 원본을 변경 없이 INFO로 렌더링합니다."
  };
}

function validateInfoLayout(layout, item) {
  const issues = [];
  const type = String(item.infoSpec?.type || "none");
  const guidePoints = Array.isArray(layout?.guidePoints) ? layout.guidePoints : [];
  const labelPositions = Array.isArray(layout?.labelPositions) ? layout.labelPositions : [];
  if (type === "none") {
    if (item.infoSpec?.requiresOverlay === true || item.requiresInfo === true) issues.push("필수 INFO 오버레이는 geometryMode none으로 대체할 수 없음");
    if (layout && (guidePoints.length || labelPositions.length)) issues.push("none 장면에 불필요한 레이아웃 존재");
    return [...issues, ...validateInfoLayoutContract(layout, item).map((issue) => issue.message)];
  }
  if (!layout || typeof layout !== "object") return ["AI가 실제 화면 앵커를 반환하지 않음", ...validateInfoLayoutContract(layout, item).map((issue) => issue.message)];
  const geometryMode = String(layout.geometryMode || "");
  const factualBadge = item.infoSpec?.geometryPolicy === "factual_badge";
  const allowedModes = {
    load_path: ["path"],
    flow: ["path", "settlement_rotation"],
    sequence: ["sequence"],
    before_after: ["axis_pair", "position_pair"],
    comparison: ["axis_pair", "position_pair"],
    forbidden_action: ["forbidden"],
    location: ["span", "fact_badge"],
    scale_limit: ["span", "fact_badge"]
  };
  if (!(allowedModes[type] || []).includes(geometryMode)) issues.push(`${type}에 맞지 않는 도형 모드: ${geometryMode || "없음"}`);
  if (geometryMode === "fact_badge" && !factualBadge) issues.push("사실 배지는 명시적 출처 계약이 있어야 함");
  if (factualBadge && geometryMode !== "fact_badge") issues.push("사실 배지는 label-only fact_badge 도형 모드여야 함");
  if (factualBadge && guidePoints.length) issues.push("사실 배지에는 물리 끝점·치수선·거리선을 둘 수 없음");
  if (Number(layout.confidence || 0) < 0.78) issues.push("실제 화면 앵커 신뢰도 0.78 미만");
  const minimumGuides = geometryMode === "fact_badge" ? 0
    : geometryMode === "axis_pair" || geometryMode === "settlement_rotation" ? 3
      : geometryMode === "path" ? 3
        : ["position_pair", "sequence", "span"].includes(geometryMode) ? 2
          : 1;
  if (guidePoints.length < minimumGuides) issues.push(`앵커 ${minimumGuides}개 미만`);
  if (labelPositions.length < (item.infoSpec?.labels || []).length) issues.push("라벨 위치 누락");
  if (guidePoints.some((point) => !isFiniteNormalizedPoint(point))) issues.push("앵커 좌표 범위 오류");
  if (labelPositions.some((point) => !isFiniteNormalizedPoint(point, 0.72))) issues.push("라벨 좌표 또는 자막 안전영역 오류");
  const distance = (left, right) => Math.hypot(Number(left?.x) - Number(right?.x), Number(left?.y) - Number(right?.y));
  if (geometryMode === "path" && type === "load_path" && guidePoints.length >= 3) {
    const downward = Math.max(...guidePoints.slice(1).map((point) => Number(point.y))) - Number(guidePoints[0].y);
    if (downward < 0.08) issues.push("하중 경로가 탑에서 지반 아래로 내려가지 않음");
  }
  if (geometryMode === "axis_pair" && guidePoints.length >= 3) {
    const [base, firstTop, secondTop] = guidePoints;
    if (Number(base.y) - Math.max(Number(firstTop.y), Number(secondTop.y)) < 0.12) issues.push("두 축이 같은 기초에서 위로 뻗지 않음");
    if (distance(firstTop, secondTop) < 0.02) issues.push("비교할 두 축의 차이가 보이지 않음");
  }
  if (geometryMode === "position_pair" && guidePoints.length >= 2 && distance(guidePoints[0], guidePoints[1]) < 0.015) {
    issues.push("이전·현재 위치 간격이 보이지 않음");
  }
  if (geometryMode === "sequence" && guidePoints.length >= 2) {
    const gap = distance(guidePoints[0], guidePoints[1]);
    if (gap < 0.04) issues.push("이전·현재 작업 지점이 구분되지 않음");
    if (gap > 0.55) issues.push("작업 순서선이 장면을 과도하게 가로지름");
  }
  if (geometryMode === "settlement_rotation" && guidePoints.length >= 3) {
    const [, base, towerTop] = guidePoints;
    if (Number(base.y) - Number(towerTop.y) < 0.12) issues.push("회전 기준축이 탑 기초와 상부를 잇지 않음");
  }
  return [...issues, ...validateInfoLayoutContract(layout, item).map((issue) => issue.message)];
}

function isInfoPlanStale(shotlist) {
  return Number(shotlist?.raw?.infoPlanVersion || 0) !== INFO_PLAN_VERSION;
}

async function replanInfoNarrative(topic, shotlist, factCheck, jobContext) {
  const segmentGroups = [...new Set(shotlist.items.map((item) => Number(item.sourceSegmentIndex)))]
    .map((segmentIndex) => shotlist.items.filter((item) => Number(item.sourceSegmentIndex) === segmentIndex));
  const chunks = [];
  for (let index = 0; index < segmentGroups.length; index += 2) {
    chunks.push(segmentGroups.slice(index, index + 2).flat());
  }
  let completed = 0;
  let nextChunkIndex = 0;
  const plannedChunks = new Array(chunks.length);
  const runPlanWorker = async () => {
    while (nextChunkIndex < chunks.length) {
      const chunkIndex = nextChunkIndex;
      nextChunkIndex += 1;
      const items = chunks[chunkIndex];
    const prompt = `
당신은 공학 쇼츠의 INFO 그래픽 편집자입니다. 이미 승인된 CLEAN 장면은 바꾸지 않고, 시청자가 이해하는 데 꼭 필요한 그래픽만 남기는 전체 의미 설계를 수행하세요.

판단 원칙:
- 기본값은 none입니다. CLEAN 화면과 영상의 실제 물리 변화만으로 대사 의미가 읽히면 INFO를 넣지 않습니다.
- 같은 sourceSegmentIndex에는 non-none INFO를 최대 1개만 허용합니다. 0개여도 됩니다.
- sourceSegmentIndex 1의 도입 장면은 전부 none입니다. 첫 문제와 대상은 라벨 없이 CLEAN과 영상으로 먼저 보여줍니다.
- INFO는 보이지 않는 하중·유체·열·압력·에너지 경로, 기어와 부품의 상대운동, 작업 순서, 같은 기준의 전후 차이처럼 그래픽이 없으면 오해하기 쉬운 관계에만 사용합니다.
- 화면에 이미 보이는 물체나 상태를 이름표로 반복하지 않습니다. '본체', '장치', '현재 상태', '작업 위치', '물', '공기'처럼 대상만 부르는 명찰은 금지합니다.
- 라벨은 물체 이름 대신 시청자가 알아야 할 관계나 변화만 표현합니다. 예: '상류 유입 차단', '수조는 역회전', '열을 외부로 배출'.
- 북쪽, 남쪽, 동쪽, 서쪽은 제작 연속성용 정보입니다. 화면 라벨로 쓰지 말고 필요하면 '더 내려앉은 쪽', '반대편 지반'처럼 시청자가 이해해야 할 관계만 표현합니다.
- 첫 전경, 눈으로 바로 읽히는 파손·회전·개폐·작업 행동, 관측, 감정 전환, 결론은 우선 none입니다.
- 라벨은 최대 2개이고 짧은 한국어로 씁니다. 내레이션 문장을 그대로 자막처럼 반복하지 않습니다.
- 검증되지 않은 각도, 거리, 연도, 수량을 만들지 않습니다. 전후 비교는 동일 기준선에서 실제 차이가 보일 때만 사용합니다.
- 현재 지원되는 화살표·경로·전후 비교·순서·위치 범위로 정확하게 설명할 수 없으면 억지로 끼워 맞추지 말고 none을 선택합니다.
- reason에는 'CLEAN만으로 알 수 없는 정보가 무엇인지'를 한 문장으로 명시합니다. 그 답이 없으면 none입니다.
- none이면 labels와 anchors는 빈 배열, directionRule은 '화살표를 사용하지 않는다.', comparisonRule은 '비교선을 사용하지 않는다.'로 씁니다.
- infoFocus는 그래픽에 실제로 추가되는 한 가지 정보만 쓰고, none이면 정확히 '추가 INFO 없음. CLEAN과 영상의 실제 변화만 사용한다.'라고 씁니다.
- 출력 장면 수와 sortIndex는 입력과 정확히 일치해야 합니다.

[주제]
${topic.title}

[검증 주장]
${JSON.stringify((factCheck?.claims || []).filter((claim) => claim.useInVideo !== false).map((claim) => ({
  id: claim.id,
  statement: claim.statement
})), null, 2)}

[영상 단순화 제한]
${JSON.stringify(factCheck?.simplifications || [], null, 2)}

[이번 장면]
${JSON.stringify(items.map((item) => ({
  sortIndex: item.sortIndex,
  sourceSegmentIndex: item.sourceSegmentIndex,
  sourceSegmentOrder: item.sourceSegmentOrder,
  narration: item.scriptExcerpt,
  shotRole: item.shotRole,
  scenePurpose: item.scenePurpose,
  cleanContent: item.cleanContent,
  physicalState: item.physicalState,
  forceFlow: item.forceFlow,
  claimRefs: item.claimRefs,
  currentInfo: item.infoSpec
})), null, 2)}

정확히 ${items.length}개 scenes를 출력하세요.
`.trim();
    const result = await runCodexJson(prompt, `info-narrative-plan-${topic.id}-${chunkIndex + 1}`, 180000, {
      signal: jobContext?.signal,
      outputSchema: INFO_NARRATIVE_PLAN_OUTPUT_SCHEMA,
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]
    });
    completed += 1;
    jobContext?.progress(10 + Math.round((completed / chunks.length) * 25), `INFO 의미 설계 ${completed}/${chunks.length} 묶음을 완료했습니다.`);
      plannedChunks[chunkIndex] = result;
    }
  };
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(2, chunks.length) }, () => runPlanWorker())
  );
  const failedWorker = workers.find((worker) => worker.status === "rejected");
  if (failedWorker) throw failedWorker.reason;

  const resultScenes = plannedChunks.flatMap((chunk) => chunk.scenes || []);
  const byIndex = new Map(resultScenes.map((scene) => [Number(scene.sortIndex), scene]));
  if (byIndex.size !== shotlist.items.length || shotlist.items.some((item) => !byIndex.has(Number(item.sortIndex)))) {
    throw new Error("INFO 의미 설계가 일부 장면을 누락하거나 중복했습니다.");
  }

  const plannedItems = shotlist.items.map((item) => {
    const planned = byIndex.get(Number(item.sortIndex));
    const infoSpec = { ...repairAiInfoGraphicSpec(planned.infoGraphic, item, item.forceFlow), requiresOverlay: item.infoSpec?.requiresOverlay === true };
    return {
      ...item,
      infoFocus: infoSpec.type === "none"
        ? "추가 INFO 없음. CLEAN과 영상의 실제 변화만 사용한다."
        : String(planned.infoFocus || "").trim(),
      infoSpec,
      infoPlanReason: String(planned.reason || "").trim()
    };
  });
  const issues = getInfoNarrativePlanIssues(plannedItems, {
    minimumRequiredInfoOverlays: getConfiguredProductionRequirements(topic).minimumRequiredInfoOverlays
  });
  if (issues.length) throw new Error(`INFO 의미 설계가 과잉 표기 기준을 위반했습니다: ${issues.join(" / ")}`);

  const nextRaw = {
    ...shotlist.raw,
    infoPlanVersion: INFO_PLAN_VERSION,
    infoPlanGeneratedAt: new Date().toISOString(),
    infoPlan: plannedItems.map((item) => ({
      sortIndex: item.sortIndex,
      infoFocus: item.infoFocus,
      reason: item.infoPlanReason,
      infoGraphic: item.infoSpec
    })),
    infoPlanNotes: plannedChunks.flatMap((chunk) => chunk.notes || [])
  };
  const updateItem = db.prepare(`
    UPDATE shotlist_items
    SET info_focus = ?, info_spec_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  runDbTransaction(() => {
    for (const item of plannedItems) {
      updateItem.run(item.infoFocus, JSON.stringify(item.infoSpec), item.id);
    }
    db.prepare("UPDATE shotlists SET raw_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(JSON.stringify(nextRaw), shotlist.id);
    db.prepare(`
      UPDATE asset_reviews
      SET status = 'REPLACE_CANDIDATE', note = 'INFO 의미 설계가 변경되어 다시 생성해야 합니다.', updated_at = CURRENT_TIMESTAMP
      WHERE topic_id = ? AND asset_type = 'info'
    `).run(topic.id);
  });
  for (const item of plannedItems) {
    markVideoJobsStale(topic.id, item.sortIndex, "INFO 의미 설계가 변경되었습니다.");
  }
  const refreshedShotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topic.id));
  const script = mapScriptRow(getScriptByTopicStatement.get(topic.id));
  const ttsRun = mapTtsRunRow(getLatestTtsRunByTopicStatement.get(topic.id));
  if (refreshedShotlist?.manifestPath && script && ttsRun) {
    await writeFile(
      resolveWorkspacePath(refreshedShotlist.manifestPath),
      renderImageSequenceMarkdown({
        topic,
        script,
        ttsRun,
        shotlistId: refreshedShotlist.id,
        items: refreshedShotlist.items,
        manifestPath: refreshedShotlist.manifestPath
      }),
      "utf8"
    );
  }
  return {
    shotlist: refreshedShotlist,
    plannedCount: plannedItems.length,
    overlayCount: plannedItems.filter((item) => item.infoSpec.type !== "none").length
  };
}

async function reviseInfoSpecWithAi(topic, item, cleanDir, instruction, jobContext) {
  const cleanPath = path.join(cleanDir, `${item.fileStub}_CLEAN.png`);
  const prompt = `
You are correcting one deterministic engineering INFO overlay specification.
Inspect the CLEAN image at ${cleanPath} with view_image. Do not edit or create images.
Preserve verified meaning and claim references. Apply only the user's correction.
The correct result may be type none when the CLEAN image and motion already explain the narration.
Keep labels short, factual, and limited to two. Do not expose production-only compass directions or label an object merely to name what is already visible.
A numeric label is allowed only when supported by the listed claim references.
Arrows must begin and end on the real visible mechanism. For before/after, use the same baseline and make the changed gap visible.

Topic: ${topic.title}
Scene: ${item.sceneId} / ${item.scenePurpose}
Script: ${item.scriptExcerpt}
Claim references: ${(item.claimRefs || []).join(", ")}
Current specification: ${JSON.stringify(item.infoSpec, null, 2)}
User correction: ${instruction}
`.trim();
  jobContext?.progress(12, `${item.sceneId} INFO 교체 요청을 명세에 반영합니다.`);
  const result = await runCodexJson(prompt, `info-revision-${topic.id}-${item.sortIndex}`, 180000, {
    signal: jobContext?.signal,
    outputSchema: INFO_SPEC_REVISION_OUTPUT_SCHEMA,
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]
  });
  const spec = repairAiInfoGraphicSpec(result.spec, item, item.forceFlow);
  const issues = getInfoGraphicSpecIssues(spec);
  if (issues.length) throw new Error(`INFO 교체 명세가 불완전합니다: ${issues.join(", ")}`);
  db.prepare("UPDATE shotlist_items SET info_spec_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(JSON.stringify(spec), item.id);
  item.infoSpec = spec;
  return { spec, note: String(result.note || "").trim() };
}

async function planInfoLayouts(topic, items, cleanDir, jobContext, revisionInstruction = "") {
  const overlayItems = items.filter((item) => item.infoSpec?.type !== "none");
  if (!overlayItems.length) return new Map();
  const sceneInputs = overlayItems.map((item) => ({
    clipIndex: item.sortIndex,
    imagePath: path.join(cleanDir, `${item.fileStub}_CLEAN.png`),
    type: item.infoSpec?.type || "none",
    labels: item.infoSpec?.labels || [],
    anchors: item.infoSpec?.anchors || [],
    directionRule: item.infoSpec?.directionRule || "",
    comparisonRule: item.infoSpec?.comparisonRule || "",
    geometryPolicy: item.infoSpec?.geometryPolicy || "anchored_geometry",
    forbidden: item.infoSpec?.forbidden || []
  }));
  const chunks = [];
  for (let index = 0; index < sceneInputs.length; index += 2) chunks.push(sceneInputs.slice(index, index + 2));
  const plannedChunks = new Array(chunks.length);
  let nextChunkIndex = 0;
  let completed = 0;
  const runLayoutWorker = async () => {
    while (nextChunkIndex < chunks.length) {
      const chunkIndex = nextChunkIndex;
      nextChunkIndex += 1;
      const chunk = chunks[chunkIndex];
      const prompt = `
You are planning spatial engineering annotations for vertical documentary frames.
Use the view_image tool to inspect every local CLEAN image listed below. Do not edit or create images.

Return geometry grounded in the visible pixels, not generic screen coordinates:
- confidence measures the visible physical anchors: tower base, current tower axis, current foundation edge, soil contact, work mark, or tool contact.
- A before/after comparison may include one designed previous/alternative point that is not physically present, but it must be constructed from the same visible base or reference. Do not lower confidence merely because that comparison point is an overlay.
- Never guess a physical anchor. If the visible base/current/reference cannot be identified, return confidence below 0.78.
- guidePoints must follow the exact point order for the selected geometryMode below.
- labelPositions: readable empty-space positions for each supplied label, in label order.
- x and y are normalized from 0 to 1 from the top-left corner.
- Keep every label above y=0.72 because the lower area is reserved for captions.
- Avoid faces, the main mechanism, and frame edges. Do not reverse left/right or force direction.

Geometry modes and exact guidePoints order:
- load_path -> path: [visible load source on the tower, foundation transfer point, soil/support receiver]. Add a fourth point only for a visible second support branch. The path must move downward overall.
- flow -> settlement_rotation when the rule mentions settlement and rotation: [foundation point that settles, shared base rotation center, visible tower-axis top].
- other flow -> path: 3 or more points ordered from cause to result.
- sequence -> sequence: [visible previous work mark, visible current work point]. Keep the connection local.
- before_after/comparison about a tower or center axis -> axis_pair: [one shared visible base center, axis top for the first label, axis top for the second label]. The visible current axis must match whichever label describes the current/after state; the other axis may be designed. Both axes must start at the exact same base.
- other before_after/comparison -> position_pair: [designed previous overlay position, visible current position, visible unchanged reference].
- forbidden_action -> forbidden: [exact prohibited contact/action point].
- location/scale_limit with geometryPolicy=factual_badge -> fact_badge: guidePoints must be []; place only the single sourced fact label with no endpoint, dimension line, or distance proportionality.
- other location/scale_limit -> span: [first visible endpoint, second visible endpoint].

Do not return none scenes. Return exactly ${chunk.length} scenes with clipIndex values ${chunk.map((scene) => scene.clipIndex).join(", ")}.

Topic: ${topic.title}
${revisionInstruction ? `Additional correction for the selected scene(s): ${revisionInstruction}` : ""}
Scenes:
${JSON.stringify(chunk, null, 2)}
`.trim();
      const result = await runCodexJson(prompt, `info-layout-${topic.id}-${chunkIndex + 1}`, 180000, {
        signal: jobContext?.signal,
        outputSchema: INFO_LAYOUT_OUTPUT_SCHEMA,
        models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"],
        onEvent: (event) => {
          if (event.type === "item.completed") jobContext?.progress(22, "실제 화면의 구조·기초·지반 앵커를 찾고 있습니다.");
        },
        onRetry: ({ nextModel }) => jobContext?.progress(20, `앵커 분석 모델을 ${nextModel}로 전환합니다.`)
      });
      const scenes = Array.isArray(result.scenes) ? result.scenes : [];
      const expectedIndexes = chunk.map((scene) => Number(scene.clipIndex)).sort((left, right) => left - right);
      const actualIndexes = scenes.map((scene) => Number(scene.clipIndex)).sort((left, right) => left - right);
      if (JSON.stringify(expectedIndexes) !== JSON.stringify(actualIndexes)) {
        throw new Error(`INFO 앵커 분석이 장면을 누락하거나 중복했습니다: ${expectedIndexes.join(", ")}`);
      }
      plannedChunks[chunkIndex] = scenes;
      completed += 1;
      jobContext?.progress(22 + Math.round((completed / chunks.length) * 14), `INFO 앵커 ${completed}/${chunks.length}묶음을 확인했습니다.`);
    }
  };
  jobContext?.progress(18, `INFO가 필요한 CLEAN ${overlayItems.length}장만 실제 화면 앵커를 분석합니다.`);
  const workers = await Promise.allSettled(
    Array.from({ length: 1 }, () => runLayoutWorker())
  );
  const failedWorker = workers.find((worker) => worker.status === "rejected");
  if (failedWorker) throw failedWorker.reason;
  const layouts = plannedChunks.flat();
  const layoutMap = new Map(layouts.map((scene) => [Number(scene.clipIndex), scene]));
  const invalidEntries = overlayItems
    .map((item) => ({ item, issues: validateInfoLayout(layoutMap.get(item.sortIndex) || null, item) }))
    .filter((entry) => entry.issues.length);
  for (const [repairIndex, entry] of invalidEntries.entries()) {
    const sceneInput = sceneInputs.find((scene) => scene.clipIndex === entry.item.sortIndex);
    const previousLayout = layoutMap.get(entry.item.sortIndex) || null;
    const repairPrompt = `
You are performing a second visual verification for one engineering INFO layout.
Inspect the local CLEAN image with view_image and correct only the spatial layout. Do not edit or create images.

Image and specification:
${JSON.stringify(sceneInput, null, 2)}

Previous layout:
${JSON.stringify(previousLayout, null, 2)}

Validation issues:
${entry.issues.join(" / ")}

Rules:
- Return exactly one scene for clipIndex ${entry.item.sortIndex}.
- Real anchors must land on visible structure, foundation, soil, work mark, or tool contact pixels.
- axis_pair order is [shared visible base, axis top for the first label, axis top for the second label]. Match each point to its label; the visible current axis belongs to the current/after label. Both axes share the exact base.
- position_pair order is [designed previous position, visible current position, visible unchanged reference].
- load_path order is [visible load source, foundation transfer, soil/support receiver] and must move downward.
- settlement_rotation order is [visible settling foundation point, shared base center, visible current tower-axis top].
- sequence order is [visible previous work mark, visible current work point] and stays local.
- confidence may be at least 0.78 when all required real anchors are clearly visible; a designed comparison point does not count as a missing real anchor.
`.trim();
    jobContext?.progress(36, `INFO ${entry.item.sortIndex}번 앵커를 단독으로 다시 확인합니다 (${repairIndex + 1}/${invalidEntries.length}).`);
    const repaired = await runCodexJson(repairPrompt, `info-layout-${topic.id}-repair-${entry.item.sortIndex}`, 180000, {
      signal: jobContext?.signal,
      outputSchema: INFO_LAYOUT_OUTPUT_SCHEMA,
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]
    });
    const replacement = (repaired.scenes || []).find((scene) => Number(scene.clipIndex) === entry.item.sortIndex);
    if (!replacement || (repaired.scenes || []).length !== 1) {
      throw new Error(`${entry.item.sortIndex}번 INFO 2차 앵커 분석 결과를 확인할 수 없습니다.`);
    }
    layoutMap.set(entry.item.sortIndex, replacement);
  }
  return layoutMap;
}

async function reviewInfoImageWithAi({ topic, factCheck, item, cleanPath, infoPath, attempt, jobContext, reviewer = {} }) {
  if (item.infoSpec?.type === "none") {
    const deterministicIssues = validateInfoLayoutContract(null, item);
    return {
      passed: deterministicIssues.length === 0,
      score: deterministicIssues.length ? 0 : 1,
      action: deterministicIssues.length ? "revise" : "pass",
      summary: deterministicIssues.length
        ? "INFO 없음 필요성·중복 계약을 통과하지 못했습니다."
        : "INFO 없음 필요성·중복 계약을 통과해 CLEAN 원본을 유지했습니다.",
      issues: deterministicIssues,
      repairInstruction: deterministicIssues.map((issue) => issue.message).join(" / ")
    };
  }
  const claimIds = new Set((item.claimRefs || []).map(String));
  const claims = (factCheck?.claims || []).filter((claim) => claimIds.has(String(claim.id)));
  const prompt = `
  You are the final independent visual editor for a Korean cinematic engineering short. Inspect both local images with view_image. Do not edit them.

${buildQualityReviewerContext("info_visual_quality", reviewer)}

CLEAN image: ${cleanPath}
INFO image: ${infoPath}

Pass only when the INFO image adds one essential, immediately readable relationship that CLEAN alone cannot communicate.
- Compare the actual pixels. Do not trust the specification merely because it is present.
- Labels, arrows, axes, paths, and before/after geometry must match the verified claim and narration.
- Reject reversed cause/result, flow, left/right, before/after, tilt, rotation, load, heat, pressure, or water direction.
- Reject labels that merely name an obvious object or state already visible in CLEAN.
- Reject an anchor that floats in empty space or points to the wrong component.
- Reject clutter, caption-zone intrusion, weak contrast, or a relationship that takes more than about one second to understand.
- Choose action=drop when CLEAN/video can communicate the claim without an overlay or the requested relationship is not supported visually.
- Choose action=revise only when a specific overlay correction can make the claim clear.
- Any issue or score below 0.82 must fail.

Topic and verified claims:
${JSON.stringify({ title: topic.title, claims, simplifications: factCheck?.simplifications || [] }, null, 2)}

Scene and INFO contract:
${JSON.stringify({
    clipIndex: item.sortIndex,
    narration: item.scriptExcerpt,
    scenePurpose: item.scenePurpose,
    physicalState: item.physicalState,
    forceFlow: item.forceFlow,
    infoFocus: item.infoFocus,
    infoSpec: item.infoSpec
  }, null, 2)}
`.trim();
  const review = await runCodexJson(prompt, `info-visual-review-${topic.id}-${item.sortIndex}-${attempt}-${reviewer.role || "evidence"}`, 180000, {
    signal: jobContext?.signal,
    stage: "info_visual_quality",
    outputSchema: INFO_VISUAL_REVIEW_OUTPUT_SCHEMA,
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]
  });
  review.issues = (review.issues || []).map((issue) => ({
    ...issue,
    sceneIndexes: Array.isArray(issue?.sceneIndexes) && issue.sceneIndexes.length ? issue.sceneIndexes : [item.sortIndex]
  }));
  review.passed = Boolean(
    review.passed
    && review.action === "pass"
    && Number(review.score || 0) >= 0.82
    && !review.issues.length
  );
  return review;
}

async function reviewInfoImageConsensus(args) {
  if (args.item.infoSpec?.type === "none") {
    return runQualityConsensus({
      stage: "info_visual_quality",
      topicId: args.topic.id,
      jobContext: args.jobContext,
      requiredReviewerRoles: [],
      runReviewer: (reviewer) => reviewInfoImageWithAi({ ...args, reviewer })
    });
  }
  return runQualityConsensus({
    stage: "info_visual_quality",
    topicId: args.topic.id,
    jobContext: args.jobContext,
    requiredReviewerRoles: ["evidence", "production"],
    runReviewer: (reviewer) => reviewInfoImageWithAi({ ...args, reviewer })
  });
}

async function hashQualityReplayArtifacts(cleanPath, infoPath) {
  const [clean, info] = await Promise.all([readFile(cleanPath), readFile(infoPath)]);
  const cleanHash = createHash("sha256").update(clean).digest("hex");
  const infoHash = createHash("sha256").update(info).digest("hex");
  return {
    cleanHash,
    infoHash,
    combinedHash: createHash("sha256").update(cleanHash).update(infoHash).digest("hex")
  };
}

async function buildQualityReplayPlan(payload = {}) {
  const topicId = Number(payload.topicId);
  const clipIndex = Number(payload.clipIndex);
  const stage = String(payload.stage || "");
  if (!Number.isInteger(topicId) || topicId <= 0 || !Number.isInteger(clipIndex) || clipIndex <= 0) {
    throw new Error("quality replay에는 유효한 topicId와 clipIndex가 필요합니다.");
  }
  if (stage !== "info_visual_quality") throw new Error("quality replay는 현재 info_visual_quality 단계만 지원합니다.");
  const topic = mapTopicRow(getTopicStatement.get(topicId));
  const factCheck = mapFactCheckRow(getFactCheckByTopicStatement.get(topicId));
  const shotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
  if (!topic || !factCheck || factCheck.status !== "PASS" || !shotlist || shotlist.status !== "approved") {
    throw new Error("현재 주제의 PASS 사실 검증과 승인된 최신 장면표가 필요합니다.");
  }
  const item = (shotlist.items || []).find((candidate) => Number(candidate.sortIndex) === clipIndex);
  if (!item) throw new Error(`현재 장면표에 ${clipIndex}번 클립이 없습니다.`);
  if (item.infoSpec?.type === "none") throw new Error("type=none INFO는 blind replay 대상이 아닙니다.");
  const projectDir = getProjectDir(topicId);
  const cleanPath = path.join(projectDir, "clean", `${item.fileStub}_CLEAN.png`);
  const infoPath = path.join(projectDir, "info", `${item.fileStub}_INFO.png`);
  if (!existsSync(cleanPath) || !existsSync(infoPath)) {
    throw new Error("현재 장면표에 연결된 CLEAN/INFO 파일이 모두 있어야 replay할 수 있습니다.");
  }
  const hashes = await hashQualityReplayArtifacts(cleanPath, infoPath);
  return {
    topic,
    factCheck,
    shotlist,
    item,
    stage,
    clipIndex,
    source: String(payload.source || "quality_replay").trim().slice(0, 120) || "quality_replay",
    artifacts: {
      cleanPath: toRelativeWorkspacePath(cleanPath),
      infoPath: toRelativeWorkspacePath(infoPath),
      ...hashes
    },
    cleanPath,
    infoPath
  };
}

async function runQualityReplay(payload, jobContext) {
  const plan = await buildQualityReplayPlan(payload);
  const before = await hashQualityReplayArtifacts(plan.cleanPath, plan.infoPath);
  jobContext?.progress(8, `${plan.clipIndex}번 기존 CLEAN/INFO를 변경 없이 독립 재검토합니다.`);
  const consensus = await reviewInfoImageConsensus({
    topic: plan.topic,
    factCheck: plan.factCheck,
    item: plan.item,
    cleanPath: plan.cleanPath,
    infoPath: plan.infoPath,
    attempt: `replay-${Date.now()}`,
    jobContext
  });
  const after = await hashQualityReplayArtifacts(plan.cleanPath, plan.infoPath);
  if (before.cleanHash !== after.cleanHash || before.infoHash !== after.infoHash) {
    throw new Error("quality replay 중 기존 CLEAN 또는 INFO 파일 hash가 변경되어 결과를 폐기했습니다.");
  }
  const reviews = [...(consensus.primaryReviews || []), ...(consensus.adjudicator ? [consensus.adjudicator] : [])];
  const reviewerInvocations = reviews.map((review, index) => ({
    role: index === 0 ? "evidence" : index === 1 ? "production" : "adjudicator",
    model: review.__aiModel || "default",
    invocationId: review.__aiInvocationId || null
  }));
  return {
    topic: plan.topic,
    stage: plan.stage,
    clipIndex: plan.clipIndex,
    source: plan.source,
    passed: consensus.passed,
    score: consensus.score,
    action: consensus.action,
    issues: consensus.issues || [],
    agreement: consensus.agreement,
    qualityRunId: consensus.convergence?.runId || null,
    artifactPaths: { cleanPath: plan.artifacts.cleanPath, infoPath: plan.artifacts.infoPath },
    artifactHashes: after,
    reviewerCount: reviewerInvocations.length,
    reviewerInvocations
  };
}

async function saveInfoPrompts(payload, jobContext = null) {
  const topicId = Number(payload.topicId);
  if (!topicId) throw new Error("topicId가 필요합니다.");
  const assets = await listProjectAssetsForTopic(topicId);
  if (!assets.shotlistApproved) throw new Error("장면표 승인이 먼저 필요합니다.");
  const topic = assets.topic;
  let shotlist = mapShotlistRow(getLatestShotlistByTopicStatement.get(topicId));
  const representativeGate = assets.representativeGate || summarizeRepresentativeGate(topicId, shotlist, assets.clean, assets.info);
  const scope = String(payload.scope || (representativeGate.enabled ? "sample" : "full"));
  if (scope === "full" && !assets.cleanReady) {
    throw new Error("전체 INFO 생성 전 모든 CLEAN 이미지의 실제 화면 검수와 승인이 필요합니다.");
  }
  const projectDir = await ensureProjectFolders(topicId);
  const infoDir = path.join(projectDir, "info");
  const cleanDir = path.join(projectDir, "clean");
  await mkdir(infoDir, { recursive: true });
  const requestedIndexes = Array.isArray(payload.clipIndexes)
    ? new Set(payload.clipIndexes.map(Number).filter(Boolean))
    : representativeGate.enabled && scope === "sample"
      ? new Set(representativeGate.infoClipIndexes)
      : null;
  const revisionInstruction = String(payload.revisionInstruction || "").trim().slice(0, 2000);
  let replanned = false;
  if (isInfoPlanStale(shotlist)) {
    if (revisionInstruction) {
      throw new Error("기존 INFO 의미 설계가 구버전입니다. 먼저 오른쪽 위의 INFO 다시 설계·생성을 실행하세요.");
    }
    const factCheck = mapFactCheckRow(getFactCheckByTopicStatement.get(topicId));
    if (!factCheck || factCheck.status !== "PASS") throw new Error("PASS 사실 검증 결과가 있어야 INFO 의미를 다시 설계할 수 있습니다.");
    jobContext?.progress(6, "불필요한 라벨을 제거하고 INFO가 필요한 장면만 다시 고릅니다.");
    const plan = await replanInfoNarrative(topic, shotlist, factCheck, jobContext);
    shotlist = plan.shotlist;
    replanned = true;
    jobContext?.progress(38, `INFO ${plan.overlayCount}/${plan.plannedCount}개 장면만 그래픽을 사용하도록 정리했습니다.`);
  }
  const targetItems = shotlist.items.filter((item) => !requestedIndexes || requestedIndexes.has(item.sortIndex));
  if (!targetItems.length) throw new Error("생성할 INFO 장면을 찾지 못했습니다.");
  const cleanStatusByIndex = new Map((assets.clean || []).map((asset) => [
    Number(String(asset.name || "").match(/^(\d+)/u)?.[1] || 0),
    asset.status
  ]));
  const blockedCleanIndexes = targetItems
    .filter((item) => scope === "sample"
      ? !isAiVerifiedAssetStatus(cleanStatusByIndex.get(item.sortIndex))
      : cleanStatusByIndex.get(item.sortIndex) !== "OK")
    .map((item) => item.sortIndex);
  if (blockedCleanIndexes.length) {
    throw new Error(`대표 INFO 생성 전 CLEAN 실제 화면 승인 필요: ${blockedCleanIndexes.join(", ")}번`);
  }
  if (revisionInstruction) {
    if (targetItems.length !== 1) throw new Error("INFO 교체 요청은 한 장면씩 처리해야 합니다.");
    await reviseInfoSpecWithAi(topic, targetItems[0], cleanDir, revisionInstruction, jobContext);
  }
  const promptPath = path.join(projectDir, "prompts", "INFOGRAPHIC_KEYFRAME_PROMPTS.md");
  const specPath = path.join(projectDir, "manifests", "INFO_OVERLAY_SPECS.json");
  const updateInfoPromptStatement = db.prepare("UPDATE shotlist_items SET info_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  for (const item of shotlist.items) {
    item.infoPrompt = buildInfoPrompt({
      topic,
      row: {
        beat: item.scenePurpose,
        mechanismStep: item.scenePurpose,
        forceFlow: item.forceFlow,
        stateChangeReason: item.stateChangeReason
      },
      sceneId: item.sceneId,
      keyframeId: item.keyframeId,
      infoFocus: item.infoFocus,
      forceFlow: item.forceFlow,
      claimRefs: item.claimRefs,
      infoSpec: item.infoSpec
    });
    updateInfoPromptStatement.run(item.infoPrompt, item.id);
  }
  await writeFile(promptPath, renderInfoPromptsMarkdown(topic, shotlist), "utf8");
  await writeFile(specPath, JSON.stringify({
    schemaVersion: 1,
    topicId,
    title: topic.title,
    fontPreset: INFO_FONT_PRESET,
    generatedAt: new Date().toISOString(),
    items: shotlist.items.map((item) => ({
      sortIndex: item.sortIndex,
      sceneId: item.sceneId,
      keyframeId: item.keyframeId,
      claimRefs: item.claimRefs,
      spec: item.infoSpec,
      checks: getInfoGraphicSpecIssues(item.infoSpec)
    }))
  }, null, 2), "utf8");
  if (payload.planOnly) {
    jobContext?.progress(96, "INFO 의미 설계와 프롬프트만 저장했습니다. 이미지는 생성하지 않았습니다.");
    return {
      path: toRelativeWorkspacePath(promptPath),
      url: pathToStaticUrl(promptPath),
      specPath: toRelativeWorkspacePath(specPath),
      specUrl: pathToStaticUrl(specPath),
      plannedCount: shotlist.items.length,
      overlayCount: shotlist.items.filter((item) => item.infoSpec?.type !== "none").length,
      renderedCount: 0,
      rendered: []
    };
  }
  const layoutByIndex = await planInfoLayouts(topic, targetItems, cleanDir, jobContext, revisionInstruction);
  let invalidLayouts = targetItems
    .filter((item) => item.infoSpec?.type !== "none")
    .map((item) => ({ item, issues: validateInfoLayout(layoutByIndex.get(item.sortIndex) || null, item) }))
    .filter((entry) => entry.issues.length);
  const invalidComparisonLayouts = invalidLayouts.filter(({ item }) => item.infoSpec?.type === "comparison" && item.infoSpec?.requiresOverlay !== true);
  if (invalidComparisonLayouts.length) {
    const updateInfoSpec = db.prepare("UPDATE shotlist_items SET info_spec_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    for (const { item } of invalidComparisonLayouts) {
      item.infoSpec = normalizeInfoGraphicSpec({ type: "none", forbidden: item.infoSpec?.forbidden || [] }, item);
      item.infoPrompt = buildInfoPrompt({
        topic,
        row: {
          beat: item.scenePurpose,
          mechanismStep: item.scenePurpose,
          forceFlow: item.forceFlow,
          stateChangeReason: item.stateChangeReason
        },
        sceneId: item.sceneId,
        keyframeId: item.keyframeId,
        infoFocus: item.infoFocus,
        forceFlow: item.forceFlow,
        claimRefs: item.claimRefs,
        infoSpec: item.infoSpec
      });
      updateInfoSpec.run(JSON.stringify(item.infoSpec), item.id);
      updateInfoPromptStatement.run(item.infoPrompt, item.id);
      layoutByIndex.set(item.sortIndex, { geometryMode: "none", guidePoints: [], labelPositions: [], confidence: 1 });
    }
    await writeFile(promptPath, renderInfoPromptsMarkdown(topic, shotlist), "utf8");
    await writeFile(specPath, JSON.stringify({
      schemaVersion: 1,
      topicId,
      title: topic.title,
      fontPreset: INFO_FONT_PRESET,
      generatedAt: new Date().toISOString(),
      items: shotlist.items.map((item) => ({
        sortIndex: item.sortIndex,
        sceneId: item.sceneId,
        keyframeId: item.keyframeId,
        claimRefs: item.claimRefs,
        spec: item.infoSpec,
        checks: getInfoGraphicSpecIssues(item.infoSpec)
      }))
    }, null, 2), "utf8");
    invalidLayouts = targetItems
      .filter((item) => item.infoSpec?.type !== "none")
      .map((item) => ({ item, issues: validateInfoLayout(layoutByIndex.get(item.sortIndex) || null, item) }))
      .filter((entry) => entry.issues.length);
  }
  if (invalidLayouts.length) {
    throw new Error(`실제 화면에 고정할 수 없는 INFO 장면이 있습니다: ${invalidLayouts.map(({ item, issues }) => `${item.sortIndex}번(${issues.join(" / ")})`).join(", ")}`);
  }
  const factCheck = mapFactCheckRow(getFactCheckByTopicStatement.get(topicId));
  const rendered = [];
  const archivedFailedInfoArtifacts = [];
  const archivedQualityRepairIndexes = new Set();
  const renderInfoItem = async (item, layout, targetOffset, attempt) => {
    const cleanPath = path.join(cleanDir, `${item.fileStub}_CLEAN.png`);
    if (!existsSync(cleanPath)) throw new Error(`${item.sortIndex}번 CLEAN 이미지가 없습니다.`);
    const outputPath = path.join(infoDir, `${item.fileStub}_INFO.png`);
    const overlayPath = path.join(infoDir, `${item.fileStub}_INFO_OVERLAY.png`);
    const guidesPath = path.join(infoDir, `${item.fileStub}_INFO_GUIDES.png`);
    const labelsPath = path.join(infoDir, `${item.fileStub}_INFO_LABELS.png`);
    const metadataPath = path.join(infoDir, `${item.fileStub}_INFO_RENDER.json`);
    if (payload.preserveFailedArtifact && payload.replacementForQualityRepair && !archivedQualityRepairIndexes.has(item.sortIndex)) {
      archivedFailedInfoArtifacts.push(await archiveFailedAssetForQualityRepair({
        topicId,
        clipIndex: item.sortIndex,
        assetType: "info",
        primaryPath: outputPath,
        artifactPaths: [outputPath, `${outputPath}.qc.json`, overlayPath, guidesPath, labelsPath, metadataPath],
        note: "독립 INFO 검수 실패 산출물"
      }));
      archivedQualityRepairIndexes.add(item.sortIndex);
    }
    markVideoJobsStale(topicId, item.sortIndex, "INFO 이미지가 다시 생성되었습니다.");
    const renderLayout = getDeterministicInfoLayout(item, layout);
    const layoutIssues = validateInfoLayout(renderLayout, item);
    const layoutTrusted = layoutIssues.length === 0;
    if (!layoutTrusted) {
      throw new Error(`${item.sortIndex}번 INFO 실제 화면 앵커가 유효하지 않습니다: ${layoutIssues.join(" / ")}`);
    }
    const result = await runJsonPython(INFO_RENDERER, {
      cleanPath,
      outputPath,
      overlayPath,
      guidesPath,
      labelsPath,
      metadataPath,
      spec: item.infoSpec,
      layout: renderLayout,
      labelFontPath: INFO_FONT_PRESET.labelFontPath,
      valueFontPath: INFO_FONT_PRESET.valueFontPath
    }, "info-render");
    jobContext?.progress(45 + ((targetOffset + 1) / Math.max(1, targetItems.length)) * 38, `${item.sceneId} INFO 이미지와 분리 레이어를 렌더링했습니다.`);
    const autoQc = await inspectInfoAsset({
      cleanPath,
      infoPath: outputPath,
      overlayPath,
      guidesPath,
      labelsPath,
      spec: item.infoSpec,
      render: result,
      claimRefs: item.claimRefs,
      layoutTrusted
    });
    jobContext?.progress(84 + ((targetOffset + 1) / Math.max(1, targetItems.length)) * 8, `${item.sceneId} 최종 INFO 의미를 독립 시각 검수합니다.`);
    const semanticReview = await reviewInfoImageConsensus({
      topic,
      factCheck,
      item,
      cleanPath,
      infoPath: outputPath,
      attempt,
      jobContext
    });
    autoQc.independentSemantic = semanticReview;
    autoQc.shotlistId = shotlist.id;
    autoQc.sceneId = item.sceneId;
    autoQc.fileStub = item.fileStub;
    autoQc.passed = Boolean(autoQc.passed && semanticReview.passed);
    if (!semanticReview.passed) {
      autoQc.errors = [
        ...(autoQc.errors || []),
        `독립 INFO 의미 검수 실패: ${semanticReview.summary || semanticReview.repairInstruction}`
      ];
    }
    await writeFile(`${outputPath}.qc.json`, JSON.stringify(autoQc, null, 2), "utf8");
    return {
      clipIndex: item.sortIndex,
      outputPath: toRelativeWorkspacePath(outputPath),
      overlayPath: toRelativeWorkspacePath(overlayPath),
      autoQc,
      semanticReview,
      layout: renderLayout,
      layoutTrusted,
      layoutIssues,
      reused: false,
      ...result
    };
  };

  for (const [targetOffset, item] of targetItems.entries()) {
    const outputPath = path.join(infoDir, `${item.fileStub}_INFO.png`);
    const overlayPath = path.join(infoDir, `${item.fileStub}_INFO_OVERLAY.png`);
    const guidesPath = path.join(infoDir, `${item.fileStub}_INFO_GUIDES.png`);
    const labelsPath = path.join(infoDir, `${item.fileStub}_INFO_LABELS.png`);
    const existingInfoQc = readAssetQc(outputPath);
    if (!payload.force && !replanned && existsSync(outputPath) && existsSync(overlayPath) && existsSync(guidesPath) && existsSync(labelsPath)
      && existingInfoQc.passed === true && isAssetCurrentForShotlist(existingInfoQc, shotlist.id)) {
      rendered.push({ clipIndex: item.sortIndex, outputPath: toRelativeWorkspacePath(outputPath), autoQc: existingInfoQc, reused: true });
      continue;
    }
    let layout = layoutByIndex.get(item.sortIndex) || null;
    const infoReviews = [];
    const qualityStartedAt = Date.now();
    let qualityCycle = 1;
    let renderResult = await renderInfoItem(item, layout, targetOffset, qualityCycle);
    infoReviews.push(renderResult.semanticReview);
    while (!renderResult.autoQc.passed
      && !renderResult.semanticReview?.passed
      && shouldContinueQualityRepair(renderResult.semanticReview, qualityCycle, qualityStartedAt, 1, topic.runLane === "production_canary" ? "autoConverge" : "benchmark")) {
      const review = renderResult.semanticReview;
      const correction = review?.action === "drop" && item.infoSpec?.requiresOverlay !== true
        ? `Remove this INFO overlay by setting type=none. CLEAN and video are sufficient. Reviewer: ${review.summary}`
        : item.infoSpec?.requiresOverlay === true
          ? `Keep this required INFO overlay non-none and correct only its supported geometry. Reviewer: ${review.summary}`
        : review?.repairInstruction
          || `Correct the INFO specification and geometry. QC errors: ${(renderResult.autoQc.errors || []).join(" / ")}`;
      jobContext?.progress(90, `${item.sceneId} 품질 수렴 판단에 따라 INFO 실패 원인만 교정합니다: ${review.convergence.reason}`);
      await reviseInfoSpecWithAi(topic, item, cleanDir, correction, jobContext);
      const correctedLayouts = await planInfoLayouts(topic, [item], cleanDir, jobContext, correction);
      layout = correctedLayouts.get(item.sortIndex) || null;
      if (layout) layoutByIndex.set(item.sortIndex, layout);
      else layoutByIndex.delete(item.sortIndex);
      qualityCycle += 1;
      renderResult = await renderInfoItem(item, layout, targetOffset, qualityCycle);
      infoReviews.push(renderResult.semanticReview);
    }
    const relativeOutputPath = toRelativeWorkspacePath(outputPath);
    reviewAsset({
      topicId,
      clipIndex: item.sortIndex,
      assetType: "info",
      assetPath: relativeOutputPath,
      status: renderResult.autoQc.passed ? "AI_PASS" : "REPLACE_CANDIDATE",
      note: renderResult.autoQc.passed
        ? "기계적 QC와 독립 AI 의미 검수를 통과했습니다. 화면 내용은 사용자 승인이 필요합니다."
        : `자동 QC 실패: ${(renderResult.autoQc.errors || []).join(" / ")}`
    });
    if (!renderResult.autoQc.passed) {
      recordTopicAttempt(topic.id, "info_visual_quality", "failed", renderResult.semanticReview?.summary || "INFO 자동 교정 실패", {
        clipIndex: item.sortIndex,
        review: renderResult.semanticReview,
        errors: renderResult.autoQc.errors || []
      });
    }
    rendered.push(renderResult);
  }
  for (const item of shotlist.items) {
    item.infoPrompt = buildInfoPrompt({
      topic,
      row: {
        beat: item.scenePurpose,
        mechanismStep: item.scenePurpose,
        forceFlow: item.forceFlow,
        stateChangeReason: item.stateChangeReason
      },
      sceneId: item.sceneId,
      keyframeId: item.keyframeId,
      infoFocus: item.infoFocus,
      forceFlow: item.forceFlow,
      claimRefs: item.claimRefs,
      infoSpec: item.infoSpec
    });
    updateInfoPromptStatement.run(item.infoPrompt, item.id);
  }
  await writeFile(promptPath, renderInfoPromptsMarkdown(topic, shotlist), "utf8");
  await writeFile(specPath, JSON.stringify({
    schemaVersion: 2,
    topicId,
    title: topic.title,
    fontPreset: INFO_FONT_PRESET,
    generatedAt: new Date().toISOString(),
    items: shotlist.items.map((item) => ({
      sortIndex: item.sortIndex,
      sceneId: item.sceneId,
      keyframeId: item.keyframeId,
      claimRefs: item.claimRefs,
      spec: item.infoSpec,
      layout: layoutByIndex.get(item.sortIndex) || null,
      layoutTrusted: validateInfoLayout(layoutByIndex.get(item.sortIndex) || null, item).length === 0,
      visualReview: rendered.find((entry) => entry.clipIndex === item.sortIndex)?.semanticReview || null,
      checks: getInfoGraphicSpecIssues(item.infoSpec)
    }))
  }, null, 2), "utf8");
  return {
    path: toRelativeWorkspacePath(promptPath),
    url: pathToStaticUrl(promptPath),
    specPath: toRelativeWorkspacePath(specPath),
    specUrl: pathToStaticUrl(specPath),
    renderedCount: rendered.length,
    archivedFailedInfoArtifacts,
    rendered
  };
}

function getTopicDetail(url) {
  const id = Number(url.searchParams.get("id"));
  if (!id) {
    throw new Error("topic id가 필요합니다.");
  }
  return getTopicDetailById(id);
}

function getLatestScriptDetail() {
  const row = getLatestScriptTopicStatement.get();
  if (!row) {
    return { topic: null, factCheck: null, script: null };
  }
  return getTopicDetailById(row.topicId);
}

function normalizeSeedReplacementReferences(references) {
  if (!Array.isArray(references) || references.length < 1 || references.length > 6) {
    throw new Error("seed references는 1~6개가 필요합니다.");
  }
  return references.map((reference, index) => {
    const state = cleanTitle(reference?.state || "");
    const mediaUrl = String(reference?.mediaUrl || reference?.referenceMediaUrl || "").trim();
    if (!state || !isHttpsUrl(mediaUrl)) throw new Error(`seed reference #${index + 1}의 state와 HTTPS mediaUrl이 필요합니다.`);
    return {
      id: `seed-reference-${index + 1}`,
      state,
      visibleFacts: [String(reference?.description || state).trim()],
      supportContacts: [],
      motionOrFlow: "",
      claimRefs: [],
      evidence: [],
      referenceType: REPLACEMENT_DIRECT_REFERENCE_TYPES.has(String(reference?.referenceType || "")) ? String(reference.referenceType) : "official_photo",
      referenceSourceUrl: String(reference?.sourceUrl || reference?.referenceSourceUrl || "").trim(),
      referenceMediaUrl: mediaUrl,
      referencePage: Number(reference?.referencePage || 0),
      referenceDescription: String(reference?.description || state).trim()
    };
  });
}

function seedReplacementCandidates(payload = {}) {
  const records = Array.isArray(payload.seeds) ? payload.seeds : [];
  if (!records.length || records.length > 12) throw new Error("seeds는 1~12개의 후보여야 합니다.");
  const created = [];
  for (const [index, raw] of records.entries()) {
    const originalTopicId = Number(raw?.originalTopicId || 0);
    const landingUrl = String(raw?.landingUrl || "").trim();
    const title = cleanTitle(raw?.title || "");
    const hook = cleanTitle(raw?.hook || "");
    const references = normalizeSeedReplacementReferences((raw?.references || []).map((reference) => ({
      ...reference,
      sourceUrl: reference?.sourceUrl || landingUrl
    })));
    if (!Number.isInteger(originalTopicId) || originalTopicId < 1 || !isHttpsUrl(landingUrl) || !title || !hook) {
      throw new Error(`seed #${index + 1}에 originalTopicId, HTTPS landingUrl, title, hook이 필요합니다.`);
    }
    const original = db.prepare(`
      SELECT topics.id, topics.main_topic AS mainTopic, topics.subtopic
      FROM topics JOIN benchmark_cases ON benchmark_cases.topic_id = topics.id
      WHERE topics.id = ? AND benchmark_cases.enabled = 1
    `).get(originalTopicId);
    if (!original) throw new Error(`seed #${index + 1}의 originalTopicId #${originalTopicId}는 활성 benchmark topic이 아닙니다.`);
    const prior = db.prepare(`
      SELECT brc.id FROM benchmark_replacement_candidates brc
      WHERE brc.original_topic_id = ? AND brc.source_route = 'seed_replacement'
      LIMIT 1
    `).get(originalTopicId);
    if (prior) throw new Error(`원본 benchmark #${originalTopicId}에는 이미 seed replacement link #${prior.id}가 있습니다.`);
    const candidateJson = {
      sourceRoute: "seed_replacement",
      untrustedSeed: true,
      replacementSeed: { landingUrl, references },
      replacement: { originalTopicId, status: "discovered" }
    };
    const topicResult = insertTopicStatement.run(
      original.mainTopic, original.subtopic, title, hook, "prechecked", 80, 80, 80, 80, 15,
      `Seed replacement for benchmark #${originalTopicId}`, landingUrl, JSON.stringify(candidateJson)
    );
    const candidateTopicId = Number(topicResult.lastInsertRowid);
    const linkResult = db.prepare(`
      INSERT INTO benchmark_replacement_candidates (
        original_topic_id, candidate_topic_id, source_route, status, details_json
      ) VALUES (?, ?, 'seed_replacement', 'discovered', ?)
    `).run(originalTopicId, candidateTopicId, JSON.stringify({ landingUrl, seedReferenceCount: references.length, untrustedSeed: true }));
    const linkId = Number(linkResult.lastInsertRowid);
    const queued = enqueueAiJob("fact_check", candidateTopicId, {
      source: "topic_discovery",
      replacementCandidateLinkId: linkId,
      replacementOriginTopicIds: [originalTopicId],
      replacementSeed: { landingUrl, references }
    });
    db.prepare("UPDATE benchmark_replacement_candidates SET fact_check_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(queued.job.id, linkId);
    created.push({ originalTopicId, candidateTopicId, replacementCandidateLinkId: linkId, factCheckJobId: queued.job.id, referenceCount: references.length });
  }
  return { created, untrusted: true };
}

function retrySeedReplacementFactCheck(payload = {}) {
  const linkId = Number(payload.replacementCandidateLinkId || 0);
  const row = db.prepare(`
    SELECT brc.id, brc.candidate_topic_id AS candidateTopicId, brc.source_route AS sourceRoute, topics.candidate_json AS candidateJson
    FROM benchmark_replacement_candidates brc JOIN topics ON topics.id = brc.candidate_topic_id
    WHERE brc.id = ?
  `).get(linkId);
  if (!row || row.sourceRoute !== "seed_replacement") throw new Error("seed replacement link를 찾을 수 없습니다.");
  const seed = parseStoredJson(row.candidateJson, {}).replacementSeed;
  if (!seed?.landingUrl || !Array.isArray(seed.references)) throw new Error("재시도할 seed reference가 없습니다.");
  const failedCount = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM jobs
    WHERE type = 'fact_check' AND status = 'failed' AND payload_json LIKE ?
  `).get(`%"replacementCandidateLinkId":${linkId}%`)?.count || 0);
  if (failedCount >= 2) throw new Error("seed fact-check의 bounded fallback 한도를 소진했습니다.");
  const queued = enqueueAiJob("fact_check", Number(row.candidateTopicId), {
    source: "topic_discovery", replacementCandidateLinkId: linkId, replacementSeed: seed
  });
  db.prepare("UPDATE benchmark_replacement_candidates SET fact_check_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(queued.job.id, linkId);
  return { replacementCandidateLinkId: linkId, job: queued.job, reused: queued.reused, fallback: failedCount > 0 };
}

function listBenchmarkReplacementCandidates(originalTopicId) {
  const id = Number(originalTopicId);
  if (!Number.isInteger(id) || id < 1) throw new Error("originalTopicId가 필요합니다.");
  const rows = db.prepare(`
    SELECT brc.id, brc.original_topic_id AS originalTopicId, brc.candidate_topic_id AS candidateTopicId,
      brc.discovery_job_id AS discoveryJobId, brc.fact_check_job_id AS factCheckJobId,
      brc.source_route AS sourceRoute, brc.status, brc.direct_reference_count AS directReferenceCount,
      brc.distinct_visible_state_count AS distinctVisibleStateCount, brc.rejection_reason AS rejectionReason,
      brc.details_json AS detailsJson, brc.created_at AS createdAt, brc.updated_at AS updatedAt,
      topics.title AS candidateTitle, topics.source_url AS candidateSourceUrl
    FROM benchmark_replacement_candidates brc
    JOIN topics ON topics.id = brc.candidate_topic_id
    WHERE brc.original_topic_id = ?
    ORDER BY brc.id DESC
  `).all(id);
  return {
    originalTopicId: id,
    count: rows.length,
    replacements: rows.map((row) => ({ ...row, details: parseStoredJson(row.detailsJson, {}) }))
  };
}

function listTopics(url) {
  const mainTopic = String(url.searchParams.get("mainTopic") || "").trim();
  const rawSubtopic = String(url.searchParams.get("subtopic") || "").trim();
  const subtopic = rawSubtopic || null;
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 100), 300));

  if (!mainTopic) {
    throw new Error("메인 주제가 필요합니다.");
  }

  const rows = listTopicsStatement.all(mainTopic, subtopic, subtopic, limit);
  const activeFactChecks = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM jobs
    JOIN topics ON topics.id = jobs.topic_id
    WHERE jobs.type = 'fact_check' AND jobs.status IN ('queued', 'running')
      AND topics.run_lane = 'production' AND topics.main_topic = ? AND (? IS NULL OR topics.subtopic = ?)
  `).get(mainTopic, subtopic, subtopic)?.count || 0);
  const activeDiscoveries = db.prepare(`
    SELECT payload_json FROM jobs
    WHERE type = 'topic_discovery' AND status IN ('queued', 'running')
  `).all().filter((row) => {
    const payload = parseStoredJson(row.payload_json, {});
    return payload.mainTopic === mainTopic && (!subtopic || payload.subtopic === subtopic);
  }).length;
  return {
    mainTopic,
    subtopic,
    activeResearchCount: activeFactChecks + activeDiscoveries,
    candidates: rows.map((row, index) => ({
      dbId: row.dbId,
      id: `TOPIC-${String(index + 1).padStart(2, "0")}`,
      title: row.title,
      hook: row.hook,
      status: row.status,
      lifecycleStatus: row.lifecycleStatus,
      scores: {
        verification: row.verification,
        visual: row.visual,
        novelty: row.novelty,
        lengthFit: row.lengthFit,
        distortionRisk: row.distortionRisk
      },
      sourceTitle: row.sourceTitle,
      sourceUrl: row.sourceUrl,
      runLane: row.runLane || "production",
      hasFactCheck: Boolean(row.hasFactCheck),
      factAttempt: row.factAttempt,
      factConfidence: row.factConfidence,
      hasActiveFactJob: Boolean(row.hasActiveFactJob),
      hasScript: Boolean(row.hasScript),
      scriptStatus: row.scriptStatus,
      ttsStatus: row.ttsStatus,
      shotlistStatus: row.shotlistStatus
    }))
  };
}

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://localhost:${PORT}`).pathname;
  const decodedPath = decodeURIComponent(requestPath);
  const filePath = decodedPath === "/" ? "dashboard/index.html" : decodedPath.slice(1);
  const absolute = path.normalize(path.join(__dirname, filePath));

  if (!absolute.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(absolute);
    const ext = path.extname(absolute);
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".mp4": "video/mp4"
    };
    const contentType = contentTypes[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function openJobEventStream(req, res, url) {
  const topicId = Number(url.searchParams.get("topicId") || 0);
  const queryCursor = Number(url.searchParams.get("after") || 0);
  const reconnectCursor = Number(req.headers["last-event-id"] || 0);
  let cursor = Math.max(0, queryCursor, reconnectCursor);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 1500\n\n");

  const flush = () => {
    const rows = topicId
      ? db.prepare("SELECT * FROM job_events WHERE id > ? AND topic_id = ? ORDER BY id LIMIT 100").all(cursor, topicId)
      : db.prepare("SELECT * FROM job_events WHERE id > ? ORDER BY id LIMIT 100").all(cursor);
    for (const row of rows) {
      cursor = Number(row.id);
      const data = {
        id: cursor,
        jobId: Number(row.job_id),
        topicId: row.topic_id == null ? null : Number(row.topic_id),
        level: row.level,
        type: row.event_type,
        progress: Number(row.progress),
        message: row.message,
        data: parseStoredJson(row.data_json, {}),
        createdAt: row.created_at
      };
      res.write(`id: ${cursor}\nevent: job\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  flush();
  const poll = setInterval(flush, 750);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  req.on("close", () => {
    clearInterval(poll);
    clearInterval(keepAlive);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      const health = getHealthSnapshot();
      sendJson(res, health.ok ? 200 : 503, health);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/production-canaries/import") {
      const payload = await readBody(req);
      sendJson(res, payload.dryRun === true ? 200 : 201, await importProductionCanary(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/production-canaries/advance") {
      const payload = await readBody(req);
      sendJson(res, 200, await advanceProductionCanary(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/production-canaries/ai-pass") {
      const payload = await readBody(req);
      sendJson(res, 200, recordCanaryAiPass(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/production-canaries/shotlist-ai-pass") {
      const payload = await readBody(req);
      sendJson(res, 200, await approveCanaryShotlistWithAi(payload));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/quality/replacements") {
      sendJson(res, 200, listBenchmarkReplacementCandidates(url.searchParams.get("originalTopicId")));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/quality/replacements/seeds") {
      const payload = await readBody(req);
      sendJson(res, 202, seedReplacementCandidates(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/quality/replacements/retry-seed") {
      const payload = await readBody(req);
      sendJson(res, 202, retrySeedReplacementFactCheck(payload));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/quality/benchmarks") {
      sendJson(res, 200, listBenchmarkQualityMatrix());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/quality/benchmarks/advance") {
      const payload = await readBody(req);
      sendJson(res, 200, await advanceBenchmarkQuality(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/quality/benchmarks/advance-all") {
      const payload = await readBody(req);
      sendJson(res, 200, await advanceAllBenchmarkQuality(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/quality/benchmarks/remediate-all") {
      const payload = await readBody(req);
      sendJson(res, 200, await remediateAllBenchmarkQuality(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/quality/replay") {
      const payload = await readBody(req);
      const plan = await buildQualityReplayPlan(payload);
      const responsePlan = {
        topicId: plan.topic.id,
        stage: plan.stage,
        clipIndex: plan.clipIndex,
        source: plan.source,
        shotlist: { id: plan.shotlist.id, status: plan.shotlist.status },
        item: { sceneId: plan.item.sceneId, fileStub: plan.item.fileStub, infoType: plan.item.infoSpec?.type },
        nonNone: true,
        reviewerCount: 2,
        artifactPaths: { cleanPath: plan.artifacts.cleanPath, infoPath: plan.artifacts.infoPath },
        artifactHashes: { cleanHash: plan.artifacts.cleanHash, infoHash: plan.artifacts.infoHash, combinedHash: plan.artifacts.combinedHash }
      };
      if (payload.dryRun === true) {
        sendJson(res, 200, { dryRun: true, ...responsePlan });
        return;
      }
      const queued = enqueueAiJob("quality_replay", plan.topic.id, {
        stage: plan.stage,
        clipIndex: plan.clipIndex,
        source: plan.source
      });
      sendJson(res, 202, { ...queued, replay: responsePlan });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/topics") {
      const result = listTopics(url);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/topics/detail") {
      const result = getTopicDetail(url);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/topics/latest-script") {
      const result = getLatestScriptDetail();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      sendJson(res, 200, listJobs(url));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/jobs/events") {
      openJobEventStream(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/jobs/cancel") {
      const payload = await readBody(req);
      sendJson(res, 200, cancelJob(payload));
      return;
    }

    if (req.method === "POST" && req.url === "/api/topics/find") {
      const payload = await readBody(req);
      const result = await findTopics(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/topics/status") {
      const payload = await readBody(req);
      const result = updateTopicStatus(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/topics/fact-check") {
      const payload = await readBody(req);
      const result = enqueueAiJob("fact_check", Number(payload.id), {
        force: Boolean(payload.force),
        ...(payload.remediationRoute ? {
          source: "quality_benchmark_remediation",
          remediationRoute: String(payload.remediationRoute),
          targetVisualEvidenceCount: Number(payload.targetVisualEvidenceCount || 2)
        } : {}),
        ...(payload.source === "topic_discovery" ? {
          source: "topic_discovery",
          mainTopic: String(payload.mainTopic || ""),
          subtopic: String(payload.subtopic || ""),
          targetCount: Number(payload.targetCount || 0)
        } : {})
      });
      sendJson(res, 202, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/topics/script") {
      const payload = await readBody(req);
      const remediationRoute = ["local_targeted_revision", "production_contract_revision", "script_scope_compression"].includes(String(payload.remediationRoute || ""))
        ? String(payload.remediationRoute)
        : "";
      const reviewOnly = payload.reviewOnly === true;
      const autoConverge = payload.autoConverge === true;
      const result = enqueueAiJob("script_generate", Number(payload.id), remediationRoute || reviewOnly || autoConverge ? {
        source: autoConverge ? "pipeline_auto_converge" : reviewOnly ? "script_review_replay" : "quality_benchmark_remediation",
        ...(remediationRoute ? { remediationRoute } : {}),
        targetDurationSec: Number(payload.targetDurationSec || 0),
        reviewOnly,
        ...(autoConverge ? { autoConverge: true } : {})
      } : {});
      sendJson(res, 202, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/topics/script/approve") {
      const payload = await readBody(req);
      const result = approveScript(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/topics/script/update") {
      const payload = await readBody(req);
      sendJson(res, 200, updateApprovedScript(payload));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/voice-presets") {
      const result = getVoicePresets();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/voice-presets") {
      const payload = await readBody(req);
      const result = createVoicePreset(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tts/status") {
      const result = getTtsEnvironmentStatus();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tts/plan") {
      const result = getTtsPlan(url);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/tts/prepare") {
      const payload = await readBody(req);
      const result = prepareTts(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/tts/sample") {
      const payload = await readBody(req);
      const result = await generateVoiceSample(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/tts/generate") {
      const payload = await readBody(req);
      const result = await generateTts(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/shotlists/generate") {
      const payload = await readBody(req);
      const remediationRoute = payload.remediationRoute === "local_targeted_revision" ? payload.remediationRoute : "";
      const autoConverge = payload.autoConverge === true;
      const assetQualityFeedback = payload.assetQualityFeedback?.findings?.length ? payload.assetQualityFeedback : null;
      const result = enqueueAiJob("shotlist_generate", Number(payload.topicId), autoConverge || remediationRoute || assetQualityFeedback ? {
        source: autoConverge ? "pipeline_auto_converge" : "quality_benchmark_remediation",
        ...(remediationRoute ? { remediationRoute } : {}),
        ...(autoConverge ? { autoConverge: true, pipeline: payload.pipeline || null } : {}),
        ...(assetQualityFeedback ? {
          assetQualityFeedback,
          targetClipIndexes: assetQualityFeedback.clipIndexes || []
        } : {})
      } : {});
      sendJson(res, 202, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/shotlists/approve") {
      const payload = await readBody(req);
      sendJson(res, 200, await approveShotlist(payload));
      return;
    }

    if (req.method === "POST" && req.url === "/api/shotlists/refresh-contracts") {
      const payload = await readBody(req);
      sendJson(res, 200, refreshShotlistContracts(payload));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/assets") {
      const result = await listProjectAssets(url);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/images/clean/generate") {
      const payload = await readBody(req);
      sendJson(res, 202, await enqueueCleanImageGeneration(payload));
      return;
    }

    if (req.method === "POST" && req.url === "/api/assets/review") {
      const payload = await readBody(req);
      sendJson(res, 200, reviewAsset(payload));
      return;
    }

    if (req.method === "POST" && req.url === "/api/assets/clean/finalize") {
      const payload = await readBody(req);
      sendJson(res, 200, await finalizeCleanAssetsAndGenerateInfo(payload));
      return;
    }

    if (req.method === "POST" && req.url === "/api/assets/info/finalize") {
      const payload = await readBody(req);
      sendJson(res, 200, await finalizeInfoAssets(payload));
      return;
    }

    if (req.method === "POST" && req.url === "/api/scenes/prompt") {
      const payload = await readBody(req);
      sendJson(res, 200, updateScenePrompt(payload));
      return;
    }

    if (req.method === "POST" && req.url === "/api/prompts/info/save") {
      const payload = await readBody(req);
      sendJson(res, 200, await saveInfoPrompts(payload));
      return;
    }

    if (req.method === "POST" && req.url === "/api/images/info/generate") {
      const payload = await readBody(req);
      sendJson(res, 202, enqueueAiJob("info_image_generate", Number(payload.topicId), payload));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/video-plan") {
      const result = await getVideoPlan(url);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/video-prompts/save") {
      const payload = await readBody(req);
      const result = await saveVideoPrompts(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/video/jobs") {
      sendJson(res, 200, listVideoJobs(url));
      return;
    }

    if (req.method === "POST" && req.url === "/api/video/generate") {
      const payload = await readBody(req);
      sendJson(res, 202, await queueVideoJobs(payload));
      return;
    }

    if (req.method === "POST" && req.url === "/api/video/review") {
      const payload = await readBody(req);
      sendJson(res, 200, reviewVideoJob(payload));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/edit/plan") {
      sendJson(res, 200, await getEditPlan(url));
      return;
    }

    if (req.method === "POST" && req.url === "/api/edit/open") {
      const payload = await readBody(req);
      sendJson(res, 200, await openEditProject(payload));
      return;
    }

    if (req.method === "POST" && req.url === "/api/edit/folder") {
      const payload = await readBody(req);
      sendJson(res, 200, await openEditFolder(payload));
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "서버 오류" });
  }
});

server.listen(PORT, () => {
  console.log(`Cinematic Shorts dashboard: http://localhost:${PORT}`);
  if (!DISABLE_BACKGROUND_WORKERS) {
    recoverCompletedBenchmarkFactChecks();
    queueMicrotask(scheduleAiWorkers);
    if (!DISABLE_AUTOMATIC_REMEDIATION) queueMicrotask(maintainBenchmarkRemediationQueue);
    queueMicrotask(() => runVideoWorker().catch((error) => console.error("Video worker failed:", error)));
  }
});
