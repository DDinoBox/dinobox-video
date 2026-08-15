import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, unlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5174);
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "shorts.db");
const CODEX_HOME = process.env.CODEX_HOME || "C:\\Users\\com\\.codex";
const CODEX_BIN = process.platform === "win32"
  ? path.join(__dirname, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe")
  : path.join(__dirname, "node_modules", ".bin", "codex");

await mkdir(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
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

  CREATE INDEX IF NOT EXISTS idx_topics_scope ON topics(main_topic, subtopic);
  CREATE INDEX IF NOT EXISTS idx_topics_lifecycle ON topics(lifecycle_status);
  CREATE INDEX IF NOT EXISTS idx_fact_checks_topic ON fact_checks(topic_id);
  CREATE INDEX IF NOT EXISTS idx_scripts_topic ON scripts(topic_id);
  CREATE INDEX IF NOT EXISTS idx_tts_runs_topic ON tts_runs(topic_id);
  CREATE INDEX IF NOT EXISTS idx_tts_segments_run ON tts_segments(run_id);
`);

function ensureColumn(table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("fact_checks", "attempt", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("fact_checks", "enrichment_queries_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("fact_checks", "enrichment_sources_json", "TEXT NOT NULL DEFAULT '[]'");

const defaultVoicePreset = {
  name: "역사 다큐 기본 남성",
  engine: "VoxCPM2",
  mode: "preset",
  language: "ko",
  styleInstruction: "A calm male documentary narrator, deep voice, cinematic tension",
  speakerKey: "default-documentary-male",
  referenceAudioPath: "",
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
    notes,
    is_default
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
`);

insertDefaultVoicePresetStatement.run(
  defaultVoicePreset.name,
  defaultVoicePreset.engine,
  defaultVoicePreset.mode,
  defaultVoicePreset.language,
  defaultVoicePreset.styleInstruction,
  defaultVoicePreset.speakerKey,
  defaultVoicePreset.referenceAudioPath,
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
    source_url
  )
  VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)
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
    source_url AS sourceUrl
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
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(topic_id) DO UPDATE SET
    status = excluded.status,
    confidence = excluded.confidence,
    core_claim = excluded.core_claim,
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

const getScriptByTopicStatement = db.prepare(`
  SELECT
    id,
    topic_id AS topicId,
    status,
    core_question AS coreQuestion,
    core_conflict AS coreConflict,
    visible_flow AS visibleFlow,
    turning_point AS turningPoint,
    production_script_json AS productionScriptJson,
    tts_text AS ttsText,
    notes_json AS notesJson,
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
    visible_flow,
    turning_point,
    production_script_json,
    tts_text,
    notes_json,
    raw_json
  )
  VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(topic_id) DO UPDATE SET
    status = 'draft',
    core_question = excluded.core_question,
    core_conflict = excluded.core_conflict,
    visible_flow = excluded.visible_flow,
    turning_point = excluded.turning_point,
    production_script_json = excluded.production_script_json,
    tts_text = excluded.tts_text,
    notes_json = excluded.notes_json,
    raw_json = excluded.raw_json,
    updated_at = CURRENT_TIMESTAMP
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
    notes,
    is_default
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    EXISTS(SELECT 1 FROM fact_checks WHERE fact_checks.topic_id = topics.id) AS hasFactCheck,
    COALESCE((SELECT attempt FROM fact_checks WHERE fact_checks.topic_id = topics.id), 0) AS factAttempt,
    EXISTS(SELECT 1 FROM scripts WHERE scripts.topic_id = topics.id) AS hasScript
  FROM topics
  WHERE main_topic = ?
    AND (? IS NULL OR subtopic = ?)
    AND lifecycle_status != 'dropped'
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
    "건축공학": ["튜닝 질량 댐퍼", "아치 구조", "내진 설계", "터널 지보", "철근 콘크리트", "돔 구조", "중력식 댐", "지반 침하", "케이블 구조", "초고층 빌딩"],
    "기계공학": ["기어", "터빈", "내연기관", "베어링", "열교환기", "압축기", "펌프", "캠샤프트", "클러치", "브레이크"],
    "항공공학": ["양력", "항력", "제트 엔진", "실속", "플랩", "날개", "터보팬", "충격파", "복합재", "비행 제어"],
    "유체역학": ["와류", "베르누이 원리", "캐비테이션", "층류", "난류", "항력 계수", "경계층", "수격 작용", "파랑", "압력 손실"]
  },
  science: {
    "우주": ["궤도", "중력 렌즈", "라그랑주점", "블랙홀", "초신성", "혜성", "조석력", "우주 배경 복사", "외계 행성", "로켓 방정식"],
    "생물": ["광합성", "미토콘드리아", "DNA 복제", "면역 반응", "진화", "공생", "감각 기관", "신경 전달", "세포막", "생태계"],
    "화학": ["촉매", "산화 환원", "고분자", "전기분해", "용해도", "pH", "화학 평형", "배터리", "반응 속도", "결정 구조"],
    "지구과학": ["판 구조론", "지진파", "화산", "해류", "대기 순환", "태풍", "빙하", "침식", "단층", "엘니뇨"]
  }
};

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
    "흐름", "힘", "진동", "열", "에너지"
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
    sourceUrl: topic.sourceUrl
  };
}

function mapFactCheckRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    topicId: row.topicId,
    status: row.status,
    confidence: row.confidence,
    coreClaim: row.coreClaim,
    verifiedFacts: parseStoredJson(row.verifiedFactsJson, []),
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

function mapScriptRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    topicId: row.topicId,
    status: row.status,
    coreQuestion: row.coreQuestion,
    coreConflict: row.coreConflict,
    visibleFlow: row.visibleFlow,
    turningPoint: row.turningPoint,
    productionScript: parseStoredJson(row.productionScriptJson, []),
    ttsText: row.ttsText,
    notes: parseStoredJson(row.notesJson, []),
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
    error: row.error,
    segments,
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
  return Math.max(1.2, Number((hangulSeconds + latinSeconds + punctuationPauses + sentencePauses).toFixed(2)));
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

async function loadRuleContext() {
  const [workflow, factGate, historyDomain] = await Promise.all([
    readFile(path.join(__dirname, "CODEX_ENGINEERING_SHORTS_WORKFLOW_KR.md"), "utf8"),
    readFile(path.join(__dirname, "docs", "FACT_CHECK_GATE_KR.md"), "utf8"),
    readFile(path.join(__dirname, "domains", "history.yaml"), "utf8")
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
    historyDomain
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

async function runCodexJson(prompt, taskName, timeoutMs = 240000) {
  const outputPath = path.join(DATA_DIR, `codex-${taskName}-${randomUUID()}.txt`);
  const args = [
    "exec",
    "-C",
    __dirname,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--output-last-message",
    outputPath,
    "-"
  ];

  const output = await new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        CODEX_HOME,
        NO_COLOR: "1",
        TERM: "xterm-256color"
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Codex 실행 시간이 너무 오래 걸려 중단했습니다."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Codex 실행 실패: ${code}`));
        return;
      }
      try {
        const finalText = await readFile(outputPath, "utf8");
        resolve(finalText);
      } catch {
        resolve(stdout);
      }
    });

    child.stdin.end(prompt);
  });

  try {
    await unlink(outputPath);
  } catch {
    // Temporary output cleanup is best-effort.
  }

  return parseJsonFromText(output);
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
  "koreanhistory.or.kr"
];

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

function sourcePreferenceScore(link, topic, unresolvedTerms = []) {
  let score = 0;
  const hostname = new URL(link.url).hostname.replace(/^www\./u, "");
  const domainIndex = preferredEvidenceDomains.findIndex((domain) => hostname.endsWith(domain));
  if (domainIndex !== -1) score += 80 - domainIndex * 3;
  if (hostname.includes("wikipedia.org")) score += 12;

  const haystack = `${link.title} ${decodeURIComponent(link.url)}`;
  if (/위키백과:|사용자:|토론:|대문|사랑방|관리 요청|사용자 모임|portal:|help:/iu.test(haystack)) {
    return -100;
  }
  for (const term of meaningfulTerms(topic.sourceTitle, topic.title, ...unresolvedTerms)) {
    if (haystack.includes(term)) score += 5;
  }
  if (/실록|사료|백과|문화재|기록|논문|자료/u.test(haystack)) score += 12;
  if (/파일:|분류:|특수:|편집|oldid|action=/u.test(haystack)) score -= 40;
  return score;
}

async function fetchSourceDocument(sourceUrl) {
  if (!sourceUrl) {
    return {
      url: "",
      title: "출처 URL 없음",
      text: "출처 URL 없음.",
      links: []
    };
  }
  try {
    const response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(8000),
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
    const html = await response.text();
    const text = stripHtml(
      html
        .replace(/<script[\s\S]*?<\/script>/giu, " ")
        .replace(/<style[\s\S]*?<\/style>/giu, " ")
        .replace(/<\/(p|h1|h2|h3|li|tr)>/giu, "\n")
    );
    return {
      url: sourceUrl,
      title: sourceUrl,
      text: text.slice(0, 9000),
      links: extractLinks(html, sourceUrl)
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

async function fetchSourceContext(sourceUrl) {
  const document = await fetchSourceDocument(sourceUrl);
  return document.text;
}

function buildEnrichmentQueries(topic, factCheck) {
  const unresolved = factCheck?.unresolved || [];
  const needed = unresolved
    .map((item) => [item.item, item.needed].filter(Boolean).join(" "))
    .filter(Boolean)
    .slice(0, 4);
  const base = [
    `${topic.sourceTitle} ${topic.subtopic} 공식 자료`,
    `${topic.sourceTitle} 한국민족문화대백과`,
    `${topic.sourceTitle} 조선왕조실록`,
    `${topic.sourceTitle} 국사편찬위원회`
  ];
  return [...new Set([...needed, ...base])].slice(0, 8);
}

async function collectEnrichmentSources(topic, baseDocument, factCheck) {
  const queries = buildEnrichmentQueries(topic, factCheck);
  const unresolvedTerms = (factCheck?.unresolved || [])
    .flatMap((item) => [item.item, item.needed, item.issue])
    .filter(Boolean);
  const candidates = new Map();

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
    .sort((a, b) => b.score - a.score)
    .filter((link) => link.score >= 45)
    .slice(0, 4);

  const documents = [];
  for (const link of rankedLinks) {
    const doc = await fetchSourceDocument(link.url);
    if (doc.text && !doc.text.startsWith("출처 페이지를 읽지 못했습니다") && !doc.text.startsWith("출처 페이지 요청 실패")) {
      documents.push({
        title: link.title,
        url: link.url,
        score: link.score,
        text: doc.text.slice(0, 5000)
      });
    }
  }

  return {
    queries,
    sources: documents
  };
}

async function fetchWikipediaSearch(query) {
  const url = `https://ko.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}&title=특수:검색&fulltext=1&ns0=1`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: {
      "User-Agent": "cinematic-shorts-dashboard/0.1 personal local topic research"
    }
  });

  if (!response.ok) {
    throw new Error(`검색 실패: ${response.status}`);
  }

  const html = await response.text();
  const results = [];
  const headingRegex = /<div class="mw-search-result-heading"[^>]*>\s*<a href="([^"]+)"[^>]*title="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu;
  let match;
  while ((match = headingRegex.exec(html))) {
    const href = match[1];
    const title = stripHtml(match[2] || match[3]);
    if (!title || title.includes("위키백과:") || title.includes("파일:")) continue;
    results.push({
      title: cleanTitle(title),
      url: new URL(href, "https://ko.wikipedia.org").toString()
    });
  }

  return results;
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
    .filter((keyword) => sourceContext.includes(keyword));

  let score = 0;
  if (normalizedTitle && normalizedContext.includes(normalizedTitle)) score += 30;
  if (normalizedSeed && normalizedContext.includes(normalizedSeed)) score += 18;
  score += Math.min(24, termHits.length * 6);
  score += Math.min(24, evidenceHits.length * 4);
  if (sourceContext.length >= 1200) score += 10;
  if (sourceContext.includes("출처 필요") || sourceContext.includes("동음이의")) score -= 18;
  if (genericSourceTitles.has(title)) score -= 40;

  const passed = score >= 52 && termHits.length >= 1 && evidenceHits.length >= 2;
  return {
    passed,
    score,
    reason: passed
      ? `출처 본문에서 핵심어 ${termHits.length}개와 도메인 근거 ${evidenceHits.length}개 확인.`
      : `출처 근거 부족: 핵심어 ${termHits.length}개, 도메인 근거 ${evidenceHits.length}개.`
  };
}

async function collectSources(mainTopic, subtopic, neededCount) {
  const seeds = searchSeeds[mainTopic]?.[subtopic] || [subtopic];
  const hints = queryHints[mainTopic] || [];
  const targetSourceCount = Math.min(80, Math.max(neededCount * 8, 32));

  const primaryBySeed = [];
  const byTitle = new Map();
  for (const seed of seeds) {
    const queries = [
      `${seed}`,
      `${seed} ${domainLabels[mainTopic] || ""}`,
      `${seed} ${hints[0] || ""}`.trim()
    ];
    let bestForSeed = null;

    for (const query of queries) {
      try {
        const results = await fetchWikipediaSearch(query);
        for (const result of results.slice(0, 8)) {
          const source = {
            ...result,
            title: cleanTitle(result.title),
            seed,
            query
          };
          source.qualityScore = scoreSourceQuality(mainTopic, subtopic, source);
          if (!isUsefulSource(mainTopic, subtopic, source)) continue;

          if (!byTitle.has(source.title) || byTitle.get(source.title).qualityScore < source.qualityScore) {
            byTitle.set(source.title, source);
          }
          if (!bestForSeed || bestForSeed.qualityScore < source.qualityScore) {
            bestForSeed = source;
          }
        }
        if (bestForSeed?.qualityScore >= 34) break;
      } catch {
        // Keep trying the remaining searches; the final empty result is handled later.
      }
    }

    if (bestForSeed && !primaryBySeed.some((source) => source.title === bestForSeed.title)) {
      primaryBySeed.push(bestForSeed);
    }
    if (primaryBySeed.length >= neededCount && byTitle.size >= targetSourceCount) break;
  }

  const primaryTitles = new Set(primaryBySeed.map((source) => source.title));
  const rankedFallback = [...byTitle.values()]
    .filter((source) => !primaryTitles.has(source.title))
    .sort((a, b) => b.qualityScore - a.qualityScore);

  return [...primaryBySeed, ...rankedFallback].slice(0, targetSourceCount);
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

async function buildCandidates(mainTopic, subtopic, sources, count) {
  const candidates = [];
  const usedSeeds = new Set();
  const rejected = [];

  for (const source of sources) {
    if (candidates.length >= count) break;

    const title = cleanTitle(source.title);
    if (source.seed && usedSeeds.has(source.seed)) continue;
    const known = knownSourceStatement.get(source.url, title);
    if (known) {
      if (source.seed) usedSeeds.add(source.seed);
      continue;
    }

    const sourceContext = await fetchSourceContext(source.url);
    const precheck = prevalidateSource(mainTopic, subtopic, source, sourceContext);
    if (!precheck.passed) {
      rejected.push({ title, reason: precheck.reason, score: precheck.score });
      continue;
    }

    const index = candidates.length;
    const question = buildQuestion(mainTopic, title, index);
    const scores = scoreCandidate(mainTopic, title, index);
    const status = "prechecked";

    const result = insertTopicStatement.run(
      mainTopic,
      subtopic,
      question,
      buildHook(mainTopic, title, subtopic),
      status,
      scores.verification,
      scores.visual,
      scores.novelty,
      scores.lengthFit,
      scores.distortionRisk,
      title,
      source.url
    );

    candidates.push({
      dbId: Number(result.lastInsertRowid),
      id: `TOPIC-${String(index + 1).padStart(2, "0")}`,
      title: question,
      hook: buildHook(mainTopic, title, subtopic),
      status,
      lifecycleStatus: "candidate",
      scores,
      sourceTitle: title,
      sourceUrl: source.url,
      precheck
    });
    if (source.seed) usedSeeds.add(source.seed);
  }

  return { candidates, rejected };
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

async function findTopics(payload) {
  const mainTopic = String(payload.mainTopic || "").trim();
  const subtopic = String(payload.subtopic || "").trim();
  const count = Math.max(1, Math.min(Number(payload.count || 10), 20));

  if (!mainTopic || !subtopic) {
    throw new Error("메인 주제와 세부 주제가 필요합니다.");
  }

  const sources = await collectSources(mainTopic, subtopic, count);
  if (!sources.length) {
    throw new Error("공개 자료 검색 결과가 없습니다. 세부 주제를 바꾸거나 인터넷 연결을 확인하세요.");
  }

  const { candidates, rejected } = await buildCandidates(mainTopic, subtopic, sources, count);
  insertSearchStatement.run(mainTopic, subtopic, count, candidates.length);

  if (!candidates.length) {
    throw new Error("사전검증을 통과한 새 후보가 없습니다. 이미 있거나, 출처 근거가 약하거나, 제작/드랍 처리된 주제일 수 있습니다.");
  }

  const output = {
    generatedAt: new Date().toISOString(),
    mainTopic,
    subtopic,
    candidates,
    rejectedCount: rejected.length
  };

  return output;
}

function normalizeFactStatus(status) {
  const value = String(status || "").trim().toUpperCase();
  if (["PASS", "HOLD", "REJECT"].includes(value)) return value;
  return "HOLD";
}

function normalizeFactCheckResult(result) {
  const status = normalizeFactStatus(result.status);
  const rawConfidence = Number(result.confidence);
  const confidence = rawConfidence > 0 && rawConfidence <= 1
    ? Math.round(rawConfidence * 100)
    : clampInteger(rawConfidence, 0, 100, status === "PASS" ? 70 : 45);
  return {
    status,
    confidence,
    coreClaim: String(result.coreClaim || "").trim() || "핵심 주장을 확정하지 못했습니다.",
    verifiedFacts: Array.isArray(result.verifiedFacts) ? result.verifiedFacts : [],
    unresolved: Array.isArray(result.unresolved) ? result.unresolved : [],
    simplifications: Array.isArray(result.simplifications) ? result.simplifications : [],
    sources: Array.isArray(result.sources) ? result.sources : [],
    verdictReason: String(result.verdictReason || "").trim() || "판정 이유가 충분히 생성되지 않았습니다.",
    nextAction: String(result.nextAction || "").trim() || (status === "PASS" ? "대본 생성 가능." : "추가 검증 필요.")
  };
}

function normalizeScriptResult(result) {
  const productionScript = Array.isArray(result.productionScript) ? result.productionScript : [];
  return {
    coreQuestion: String(result.coreQuestion || "").trim() || "핵심 질문 미생성",
    coreConflict: String(result.coreConflict || "").trim() || "핵심 갈등 미생성",
    visibleFlow: String(result.visibleFlow || "").trim() || "보이는 흐름 미생성",
    turningPoint: String(result.turningPoint || "").trim() || "전환점 미생성",
    productionScript,
    ttsText: String(result.ttsText || "").trim(),
    notes: Array.isArray(result.notes) ? result.notes : []
  };
}

function reviewStatusFromFactStatus(status) {
  if (status === "PASS") return "verified";
  if (status === "REJECT") return "rejected";
  return "hold";
}

function buildFactCheckPrompt({ topic, rules, baseDocument, attempt, previousFactCheck, enrichment }) {
  const enrichmentBlock = enrichment?.sources?.length
    ? enrichment.sources.map((source, index) => `
[보강 출처 ${index + 1}]
제목: ${source.title}
URL: ${source.url}
본문 발췌:
${source.text}
`.trim()).join("\n\n")
    : "보강 출처 없음.";

  return `
당신은 시네마틱 쇼츠 제작 파이프라인의 사실 검증 담당자입니다.
아래 주제는 다음 단계인 대본으로 넘어가기 전에 검증해야 합니다.

반드시 지킬 규칙:
- 사실 검증 결과는 PASS, HOLD, REJECT 중 하나입니다.
- 제공된 출처 본문과 보강 출처만으로 핵심 주장을 확인하기 어렵다면 PASS를 주지 말고 HOLD를 주세요.
- 핵심 주장이 틀렸거나, 쇼츠로 만들 때 사실 왜곡이 커지면 REJECT를 주세요.
- 모르는 연도, 수치, 인과관계를 만들지 마세요.
- 2차 검증에서는 1차 HOLD 사유가 보강 출처로 해소됐는지 명확히 판단하세요.
- 2차에서도 부족하면 더 이상 재시도를 유도하지 말고 HOLD 또는 REJECT로 멈추세요.
- 응답은 JSON 객체 하나만 출력하세요. 설명 문장, 마크다운, 코드펜스 금지.

[검증 시도]
${attempt}차 검증

[검증 게이트 문서]
${rules.factGate}

[도메인 규칙 history.yaml]
${rules.historyDomain}

[초기 제작 MD 핵심 규칙]
${rules.workflowExcerpt}

[후보 주제]
id: ${topic.id}
메인 주제: ${topic.mainTopic}
세부 주제: ${topic.subtopic}
후보 제목: ${topic.title}
후보 설명: ${topic.hook}
출처 제목: ${topic.sourceTitle}
출처 URL: ${topic.sourceUrl}

[기본 출처 본문 발췌]
${baseDocument.text}

[1차 검증 결과]
${previousFactCheck ? JSON.stringify(previousFactCheck, null, 2) : "없음"}

[보강 검색어]
${enrichment?.queries?.length ? enrichment.queries.map((query) => `- ${query}`).join("\n") : "없음"}

${enrichmentBlock}

JSON 스키마:
{
  "status": "PASS | HOLD | REJECT",
  "confidence": 0,
  "coreClaim": "한 문장의 핵심 주장",
  "verifiedFacts": [
    { "item": "확인된 사실", "source": "출처명 또는 URL", "reliability": "상/중/하" }
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
    JSON.stringify(rawResult)
  );
}

async function runSingleFactCheck({ topic, rules, baseDocument, attempt, previousFactCheck = null, enrichment = null }) {
  const prompt = buildFactCheckPrompt({
    topic,
    rules,
    baseDocument,
    attempt,
    previousFactCheck,
    enrichment
  });

  const rawResult = await runCodexJson(prompt, `fact-check-${topic.id}-attempt-${attempt}`);
  const factCheck = normalizeFactCheckResult(rawResult);
  return { factCheck, rawResult };
}

async function runFactCheck(payload) {
  const id = Number(payload.id);
  const force = Boolean(payload.force);
  const topic = getTopicStatement.get(id);
  if (!topic) {
    throw new Error("검증할 주제를 찾을 수 없습니다.");
  }

  const existing = mapFactCheckRow(getFactCheckByTopicStatement.get(id));
  if (existing?.attempt >= 2 && !force) {
    return getTopicDetailById(id);
  }

  updateTopicReviewStatement.run("checking", "fact_checking", id);

  const [rules, baseDocument] = await Promise.all([
    loadRuleContext(),
    fetchSourceDocument(topic.sourceUrl)
  ]);

  const first = await runSingleFactCheck({
    topic,
    rules,
    baseDocument,
    attempt: 1
  });

  let finalFactCheck = first.factCheck;
  let finalRawResult = first.rawResult;
  let finalAttempt = 1;
  let enrichment = null;

  if (first.factCheck.status === "HOLD") {
    enrichment = await collectEnrichmentSources(topic, baseDocument, first.factCheck);
    if (enrichment.sources.length) {
      const second = await runSingleFactCheck({
        topic,
        rules,
        baseDocument,
        attempt: 2,
        previousFactCheck: first.factCheck,
        enrichment
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

  saveFactCheck(id, finalFactCheck, finalRawResult, finalAttempt, enrichment);

  const reviewStatus = reviewStatusFromFactStatus(finalFactCheck.status);
  const lifecycleStatus = finalFactCheck.status === "REJECT" ? "dropped" : "fact_checking";
  updateTopicReviewStatement.run(reviewStatus, lifecycleStatus, id);

  return getTopicDetailById(id);
}

async function generateScript(payload) {
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

  updateTopicReviewStatement.run("verified", "script", id);

  const rules = await loadRuleContext();
  const prompt = `
당신은 시네마틱 설명 쇼츠 대본 작가입니다.
아래 후보는 사실 검증 PASS를 받은 주제입니다. 처음 제공된 MD 규칙과 history.yaml을 반드시 반영해 대본을 작성하세요.

반드시 지킬 규칙:
- 대본은 45~60초 쇼츠를 목표로 합니다.
- 시작 3초 안에 질문이 있어야 합니다.
- 초반 약 1/3은 문제와 불확실성을 키우고, 이후 인과관계로 해소합니다.
- 역사 주제는 인물 암기가 아니라 사람, 군대, 물자, 돈, 정보, 권력, 영토의 흐름을 시각화합니다.
- 사실 검증에서 확인된 사실만 단정합니다.
- 미확인 수치, 연도, 인과관계를 만들지 않습니다.
- 대본 승인 전에는 장면표/CLEAN/INFO/영상 단계로 넘어가지 않습니다.
- 응답은 JSON 객체 하나만 출력하세요. 설명 문장, 마크다운, 코드펜스 금지.

[초기 제작 MD 핵심 규칙]
${rules.workflowExcerpt}

[도메인 규칙 history.yaml]
${rules.historyDomain}

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

JSON 스키마:
{
  "coreQuestion": "시청자가 끝까지 알고 싶어 할 질문",
  "coreConflict": "충돌하는 조건, 이해관계, 제약",
  "visibleFlow": "화면에서 보이게 만들 흐름",
  "turningPoint": "결과를 바꾸는 결정/장소/장치/사건",
  "productionScript": [
    {
      "time": "0~5초",
      "beat": "질문",
      "narration": "내레이션 문장",
      "visualDirection": "시각 연출"
    }
  ],
  "ttsText": "타임라인 없이 바로 읽는 TTS용 전체 텍스트",
  "notes": [
    "검증된 사실과 영상적 단순화 주의점"
  ]
}
`.trim();

  const rawResult = await runCodexJson(prompt, `script-${id}`);
  const script = normalizeScriptResult(rawResult);
  if (!script.ttsText || !script.productionScript.length) {
    throw new Error("Codex가 대본 필수 항목을 충분히 만들지 못했습니다. 다시 생성해 주세요.");
  }

  upsertScriptStatement.run(
    id,
    script.coreQuestion,
    script.coreConflict,
    script.visibleFlow,
    script.turningPoint,
    JSON.stringify(script.productionScript),
    script.ttsText,
    JSON.stringify(script.notes),
    JSON.stringify(rawResult)
  );

  updateTopicReviewStatement.run("verified", "script", id);
  return getTopicDetailById(id);
}

function updateTopicStatus(payload) {
  const id = Number(payload.id);
  const lifecycleStatus = String(payload.lifecycleStatus || "").trim();
  const allowed = new Set(["candidate", "fact_checking", "script", "produced", "dropped"]);

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

  return {
    topic: mapTopicRow(topic),
    factCheck: mapFactCheckRow(getFactCheckByTopicStatement.get(id)),
    script: mapScriptRow(getScriptByTopicStatement.get(id))
  };
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
    ffmpeg: isCommandAvailable("ffmpeg", ["-version"]),
    ffprobe: isCommandAvailable("ffprobe", ["-version"]),
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

function listTopics(url) {
  const mainTopic = String(url.searchParams.get("mainTopic") || "").trim();
  const rawSubtopic = String(url.searchParams.get("subtopic") || "").trim();
  const subtopic = rawSubtopic || null;
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 100), 300));

  if (!mainTopic) {
    throw new Error("메인 주제가 필요합니다.");
  }

  const rows = listTopicsStatement.all(mainTopic, subtopic, subtopic, limit);
  return {
    mainTopic,
    subtopic,
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
      hasFactCheck: Boolean(row.hasFactCheck),
      factAttempt: row.factAttempt,
      hasScript: Boolean(row.hasScript)
    }))
  };
}

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://localhost:${PORT}`).pathname;
  const filePath = requestPath === "/" ? "dashboard/index.html" : requestPath.slice(1);
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
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4"
    };
    const contentType = contentTypes[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

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
      const result = await runFactCheck(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/topics/script") {
      const payload = await readBody(req);
      const result = await generateScript(payload);
      sendJson(res, 200, result);
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

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "서버 오류" });
  }
});

server.listen(PORT, () => {
  console.log(`Cinematic Shorts dashboard: http://localhost:${PORT}`);
});
