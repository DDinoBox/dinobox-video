# 최종 재구축 계획 — 공학 쇼츠 자동 제작

작성·공식 자료 조회: 2026-09-05
상태: **계획 제안. 백업과 현 상태 Git 업로드만 실행했으며 재구축은 시작하지 않았다.**
기준 소스: `5c42f01d1099e838d12108e8dc31ee2a2dba1a38`
관련 인계: `docs/GPT6_AUTOMATION_HANDOFF_KR.md`

## 1. 결정 요약

**전체 앱을 버리지 않는다. 자동화 실행·수정·승인·복구 핵심부를 교체한다.**

현재 병목은 AI 모델이 오래됐거나 프롬프트가 짧아서가 아니다. 검수 결과가 실제 국소 수정으로 연결되지 않고, 작업 완료·품질 통과·사용자 승인·최신성이 섞여 있으며, 다음 작업의 등록과 전체 재시도 예산이 영속적으로 묶이지 않는다.

- 유지: Node/SQLite, 현재 대시보드, 근거·검토 hash 결속, VoxCPM2, PIL INFO 합성, FFmpeg, H3/OpenShot 연동.
- 교체: payload 기반 자동 진행, 단계별 흩어진 repair 제어, 불완전한 dedupe, 완료 판정, 캐시/산출물 freshness 연결.
- 보강: 실제 실패 이미지 기반 QC, 사용량·취소·재시작 계측, 공식 참조 제작 가능성 판정.
- 도입하지 않음: React 전면 전환, DB 교체, Temporal/Redis 등 신규 운영 인프라, 무조건 최신 모델 업그레이드.
- 이번 첫 출시 범위: **주제 선택부터 CLEAN/INFO까지 무개입 진행 및 최종 사용자 검수 대기**.
- 후속 출시 범위: 사용자 승인 뒤 H3 영상, INFO 레이어 합성, MP4 검수와 OpenShot 편집 인계. 자동 외부 게시는 범위 밖이다.

## 2. 백업과 확인된 기준 상태

### 완료한 보존 작업

로컬 백업 디렉터리: `data/backups/pre-rebuild-20260905-151721/`

- `workspace-and-production.zip`: 1,144개 파일, 664,733,963 bytes.
- 포함: 프로젝트 소스·런타임 폰트, SQLite 일관된 snapshot, 제작 이미지·오디오·출처 캐시·TTS 작업 데이터, 격리 실험 데이터, 임시 진단 자료.
- `shorts.db`: SQLite online backup, 15,949,824 bytes.
- `backup-manifest.json`: 포함 파일 목록, 크기, SHA-256, 제외 범위.
- `git-history.bundle`: 기존 Git refs/history 백업 및 bundle 검증.
- ZIP 전체 CRC 검사 통과. DB를 ZIP에서 실제로 추출한 뒤 hash와 `integrity_check=ok` 확인.
- 복원 DB: topics 116건, jobs 564건, Topic 159 AI invocation 127건.
- 백업 중 실행·대기 job 0건, 백업 전후 job 상태 변경 없음.

백업은 의존성·모델·설치 도구 전체 복제나 디스크 이미지가 아니다. 인증 홈/환경변수 파일, 설치된 node_modules/.venv/모델 배포물, 기존 백업, 용도 미확인 `data/app.db`와 `data/dashboard.db`는 제외했다. ZIP은 데이터 보존용이며 외부 전송하지 않았다. 다른 디스크/기기에도 보존하려면 별도 전송 승인이 필요하다.

GitHub `DDinoBox/dinobox-video`의 `main`에 기준 소스를 push하고 원격 hash 일치를 확인했다. DB·미디어·비밀정보·tmp·도구 배포물은 Git에서 제외한다. 업로드 준비 과정의 변경은 제외 규칙과 기존 두 줄의 후행 공백 제거뿐이며 기능 수정은 없다.

### 현재 사실

- 로컬 Node `v24.19.0`, 내장 SQLite `3.53.3`, DB schema 11.
- 설치·lock: Codex CLI/SDK `0.147.0`.
- 기존 테스트 47/47, JS/Python 문법 검사, health 통과.
- gold known-bad fixture 5개: 누락 0. 실측 제작 성공을 뜻하지 않는다.
- `quality:report`의 historical recorded known-bad misses 7, legacy reference gaps 2는 서로 다른 지표다.
- Topic 159: 승인 대본, 최신 TTS 24.06초/7구간, brief·shotlist stale, CLEAN/INFO 0장.
- Topic 159: fact/brief/script/shotlist job 14/9/16/24회, TTS job 6회와 TTS run row 15건을 구별해야 한다.
- job 599는 completed지만 quality run 272는 fail(0.76).
- active job 0인데 running invocation 6건이 남아 있으며 삭제하지 않았다.
- Topic 158의 현재 INFO 3장은 CLEAN과 SHA-256이 동일하고 overlay coverage=0. 세 장의 큰 블러 상하 여백을 현재 QC로 재검사해도 PASS한다.

## 3. 고칠 결함과 보존할 동작

기준 commit에서의 위치이며 구현 후 줄 번호는 달라질 수 있다.

| 우선순위 | 현재 결함 | 조치 |
| --- | --- | --- |
| P0 | CLEAN은 AI_PASS 저장, 다음 단계는 OK만 인정 (`server.js:11504`, `11830`) | AI 품질·사용자 승인·lane 정책을 분리하고 canary 진행 조건 정의 |
| P0 | INFO 미승인/실패 후 새 job 반복 가능 (`4123`, `15479`) | 단계 결과에 따른 명시적 전이와 전체 run 예산 적용 |
| P0 | pipeline dedupe에 clip identity 없음 (`4062`, `4354`) | run/stage/artifact scope/input revision/operation identity로 유일성 보장 |
| P0 | 완료 DB 기록 후 successor 등록이 별도 (`4366`) | 결과 확정과 후속 job intent를 같은 transaction에서 저장 |
| P1 | 기본 자동 repair=0, 상위 수정은 분류 후 중단 (`99`, `7366`) | 검증 가능한 patch 계약과 제한된 repair dispatcher |
| P1 | TTS 초과 행은 허용 기록 후 hold (`13289`, `4123`) | 초과 행만 1회 수정·재측정하고 전체 예산 유지 |
| P1 | hash에 존재하지 않는 `assets.shotlist.id` 사용 (`4117`, `11839`) | 실제 shotlist revision·content hash와 의존성으로 결속 |
| P1 | asset freshness가 shotlist ID에만 의존 (`10762`) | 같은 ID의 수정과 상위 brief/script/TTS 변경도 추적 |
| P1 | 실제 블러 이미지가 detector를 통과 (`scripts/media_qc.py:26`) | 실물 실패 fixture와 정상 사진 대조, 오탐/누락 함께 평가 |
| P2 | 테스트가 소스 문구 존재에 치우침 (`test/dashboard-contract.test.js:595`) | 실행 경로·DB·파일·재시작 테스트를 출시 조건으로 승격 |

해시 결속, 공식 참조 검증, 필요한 INFO의 none 우회 차단, 결정론 합성 픽셀 검사, canary H3 금지는 유지한다. 실패를 PASS로 바꾸거나 AI 판정을 사용자 승인으로 위장하지 않는다.

## 4. 최신 공식 자료가 바꾸는 판단

조회일은 모두 2026-09-05다. upstream main 문서, npm 배포 버전, 로컬 설치 버전은 동일하다고 가정하지 않는다.

### 4.1 Codex와 이미지

- 공식 SDK는 CLI subprocess/JSONL wrapper이며 outputSchema, streaming event, thread resume을 지원한다.[R1]
- thread resume은 AI 대화 재개다. 업무의 정확한 단계 복구, DB transaction, 외부 부작용 rollback을 대신하지 않는다.
- upstream exec의 AbortSignal/child 종료 구현이 Windows 전체 자식 process tree나 이미 제출된 원격 생성의 취소까지 보장하지는 않는다.[R2]
- npm 공식 registry에서 CLI와 SDK latest는 모두 **0.153.4**로 확인했다.[R3] 설치된 **0.147.0**과 차이가 있으나 이번 재구축 중 자동 업그레이드하지 않는다. adapter 계약 테스트 후 별도 변경으로 비교한다.
- 현재 CLEAN 생성은 `server.js`의 Codex workspace-write + `$imagegen` 경로다. 공식 Image API 직접 호출과 같은 provider라고 단정할 수 없다.
- 공식 이미지 가이드에 GPT Image 2와 생성/편집 기능이 있지만, mask의 정확한 형태와 비편집 픽셀 완전 보존은 보장되지 않는다.[R4]
- 따라서 CLEAN provider의 backend/권한/출력 계약을 먼저 확인하고, INFO는 계속 PIL 결정론 합성으로 구현한다. reviewer agent 모델과 이미지 생성 backend 모델을 따로 기록한다.

### 4.2 SQLite와 durable execution

- 조회한 Node 24 문서는 node:sqlite가 v24.15.0부터 release candidate라고 명시한다. 완전 stable이라고 표현하지 않는다.[R5]
- SQLite WAL-reset 수정 버전은 3.51.3 이상이며 3.44.6/3.50.7 backport가 있다.[R6] 현재 3.53.3은 해당 수정 범위다.
- `docs/ARCHITECTURE_KR.md`의 현재 SQLite=3.50.4 설명은 낡았다. 그렇다고 즉시 WAL로 전환하지 않는다. 현재 journal mode를 유지하고 실제 경쟁·복구 테스트가 필요할 때 별도 선택한다.
- WAL은 단일 host/local disk용이고 writer는 여전히 하나다. WAL 사용 중 main DB 파일만 복사하는 백업은 금지한다. online backup과 artifact 시점 일치 검증을 사용한다.[R5][R6]
- Temporal도 외부 Activity 부작용을 무조건 exactly-once로 만들지 않는다. 멱등성은 애플리케이션이 책임져야 한다.[R7]
- 상태 변경과 다음 작업 의도를 같은 transaction에 저장하는 outbox 원칙을 적용한다.[R8] 현재 DB에서 jobs를 직접 poll하므로 **jobs 테이블이 outbox를 겸할 수 있다**. 별도 broker/outbox table부터 추가하지 않는다.

### 4.3 TTS/H3

- 공식 VoxCPM2는 한국어, 48kHz, voice clone/design을 지원한다. 로컬 `cfg_value=2.0`, `inference_timesteps=10`은 공식 예제와 부합한다.[R9]
- 현재 model snapshot/package/참조 음성 hash 고정은 보강 대상이다. 참조 음성이 있을 때 style을 끄는 동작은 로컬 정책이며 공식 모델의 본질적 제한으로 설명하지 않는다.
- 공식 H3와 Comfy-Org 재패키징이 존재하고, 로컬 workflow의 양자화 weight 이름이 재패키징 목록과 맞는다.[R10][R11]
- 원본 H3, Comfy 양자화, 외부 Turbo LoRA를 같은 버전으로 기록하지 않는다. 모델 카드의 한국 포함 별도 application 안내와 Community License는 상업 운영 전에 조항별 확인이 필요하다.
- H3-Context-IR/Regenerate-2K의 hosted 기능을 로컬 H3-Base가 모두 제공한다고 가정하지 않는다. H3 조사는 이번 이미지 canary를 영상까지 확대하는 근거가 아니다.

## 5. 승인·완료 계약부터 통일

`completed` 하나로 성공을 표현하지 않는다.

- execution: queued / running / succeeded / failed / canceled / reconcile_required
- quality: pending / pass / revise / needs_reference / reject
- freshness: current / stale
- userApproval: pending / approved / rejected
- run: queued / running / awaiting_user_review / blocked / failed / canceled / complete

기존 DB status는 호환 mapping으로 읽고 신규 run의 상태와 구분한다. 과거 AI_PASS를 OK로 일괄 UPDATE하지 않는다.

lane은 실행 시작 때 고정한다.

- `manual`: 기존 사용자 승인 게이트 보존.
- `production_canary`: AI/결정론 QC 통과와 최신 입력 결속으로 script→TTS→shotlist→CLEAN→INFO 진행 가능. H3/video capability는 항상 false.
- `production`: 후속 릴리스에서 검증된 정책 사용. 영상 시작·최종 게시 등 사용자의 승인 범위를 명시.

이미지 canary가 모두 QC PASS이면 `awaiting_user_review`로 종료성 대기한다. 전체 최종 시각 검수까지 통과해야 출시 수용 기준을 만족한다. 이후에도 같은 canary run을 H3로 확장하지 않고 별도 승인된 production run을 만든다.

## 6. 최소 구조

새 파일명은 구현 대상 제안이며 현재 존재하는 파일로 오해하지 않는다.

```text
server.js                         기존 HTTP/부트스트랩 호환 facade
lib/pipeline-convergence.js        순수 전이 결정, 기존 export 호환
lib/pipeline-store.js              run/job/attempt/예산 transaction
lib/pipeline-runner.js             lease, provider 실행, 복구, successor
lib/repair-contract.js             patch schema/domain 검증과 적용
lib/artifact-state.js              revision/hash, publish, stale/reconcile
lib/provider-adapters.js           Codex/TTS/media 호출 경계와 test double
scripts/audit-pipeline.mjs         읽기 전용 상태 불일치 보고
scripts/verify-pipeline-run.mjs    DB+실제 파일 수용 검사, 실패 exit code
```

처음부터 `server.js` 전체를 수십 파일로 분해하지 않는다. 위 경계를 실행 테스트로 잠근 뒤 필요한 함수만 이동한다. 대시보드 구조/스타일의 전면 개편은 하지 않는다.

### 영속 데이터

현재 schema 11에 additive migration을 적용한다. 초기 테이블 이름과 필드의 세부 DDL은 M1에서 fixture로 고정한다.

- `pipeline_runs`: run ID, topic ID, lane/capabilities, current stage, status, terminal reason, 입력 계약 hash, 예산 한도/사용량, timestamps, revision.
- `pipeline_batches`: 자동 주제 교체 시 전체 후보 수/누적 비용/시간 상한을 공유하는 부모 실행. 후보별 run을 새로 만들어도 예산이 리셋되지 않는다.
- 기존 `jobs` 확장: run ID, stage, scope/clip identity, input revision hash, operation kind, logical task key, lease token.
- attempt/invocation: 실제 호출마다 상태·provider request/thread ID·입출력 hash·usage·시작/종료·오류를 연결. job ID 없는 신규 호출을 허용하지 않는다.
- artifact version: run/clip/type, 상위 의존성 hash, 경로·content hash, QC, 품질과 사용자 승인. 기존 파일/리뷰는 보존한다.
- `repair_patches`: target, before hash, 변경 필드, replacement, claim refs, 판정, 적용 결과와 무효화 범위.

핵심 불변식:

1. 논리 작업 identity = run + stage + clip/scope + input revision + operation kind. 시도 횟수는 identity를 바꾸지 않는다.
2. 결과 확정/예산 갱신/후속 작업 등록은 같은 DB transaction에서 수행한다. 외부 AI/GPU 실행은 transaction 밖이다.
3. 파일은 attempt별 임시 경로에 생성하고 hash/QC 후 버전 경로로 publish한다. 파일 rename과 DB commit은 원자적이라고 가정하지 않는다.
4. 파일 publish 후 DB commit 전 crash, provider 성공 후 응답 유실은 reconciliation 대상으로 남긴다. 결과가 불명확하면 무조건 재생성하지 않는다.
5. lease token/version이 틀린 이전 worker는 결과를 확정할 수 없다. 재시작 복구는 오래된 invocation도 함께 정리하고 이력을 남긴다.
6. cancel된 run과 budget 소진 run은 새 successor를 만들지 않는다.
7. 중복 HTTP 요청은 같은 run/task를 반환한다. 기존 생성 API도 이 경계를 통과시켜 autoConverge payload 누락으로 분리된 실행이 생기지 않게 한다.

## 7. 검토 AI를 실제 교정자로 만드는 방법

### 사실·참조·표현을 분리

- `factEvidence`: 내레이션 주장이 사실임을 지지하는 근거.
- `visualReference`: 실제 형상/상태 제작에 사용할 참조.
- `presentationContract`: CLEAN/INFO/내레이션/시간 순서 중 어느 채널이 무엇을 설명하는가.

최종 정지 이미지에 모든 시간 순서나 이동량의 증명 책임을 넘기지 않는다. 공식 출처가 있어도 내부 가시성, 좌우 연속성, 전후 기준선이 없는 표현은 승인하지 않는다. 반대로 원문이 지지하는 순서를 내레이션으로 설명할 수 있는 경우 무조건 정지 사진 부재로 주제 전체를 탈락시키지 않는다.

### feasibility

대본 생성 전 상태별 참조 coverage, 숨은 요소, 시간 순서 표현, INFO anchor/baseline, 실제 구도 crop 가능성을 검사한다. 단순 URL 수나 사진 수로 상태 수를 부풀리지 않는다.

물리 상태로 장면을 설계하고 TTS는 편집 가능 시간을 제약한다. 상태가 부족하다고 카메라 각도로 장면을 채우지 않으며, 음성이 길다고 무조건 상태 수를 늘리지 않는다. 한 행의 음성이 4초를 넘으면 먼저 해당 행의 표현을 국소 축약한다. 핵심 의미를 유지할 수 없으면 계약 수정/주제 교체로 종료한다.

JWST의 고정 7장/INFO 최소 2개는 해당 canary의 시험 조건이지 모든 주제의 제작 규칙이 아니다. 다른 canary로 교체하면 실제 서로 다른 상태와 필요한 INFO가 있는지를 먼저 검증한다. INFO 숫자를 채우기 위한 명찰·내레이션 반복 라벨은 금지한다.

### patch 계약

검토 결과는 최소한 다음을 제공한다.

```text
verdict, ownerStage, failureFingerprint
patch: targetId, targetField, beforeHash, replacement,
       preservedClaimRefs, forbiddenFields, reason
invalidateFrom, nextAction
```

적용 전 allowlist field, before hash, schema, claim refs, 단위/수치/조건 보존을 검사한다. claim ID가 같다는 것만으로 의미가 보존됐다고 판단하지 않고 기존 claim과 수정 문장을 독립 검토한다. 불명확하면 상위 사실 검증으로 돌리거나 보류한다.

- script: 실패 row만 1회 수정. 전체 대본 재생성 금지.
- TTS: 4초 초과 row만 1회 축약하고 그 segment만 재생성. 유지된 음성은 재사용한다. 변경 segment 이후 누적 시작 시각과 master audio를 다시 계산하고 shotlist 타이밍·자막·편집 계약을 무효화한다. 시각 입력 계약이 같은 CLEAN은 재사용할 수 있도록 타이밍 의존성과 시각 의존성을 분리하며, 이 구분을 테스트한다.
- shotlist: 실패 clip만 1회 수정. 상위 표현 계약 문제이면 정확한 brief/script patch로 승격.
- CLEAN: 해당 clip만 1회 교정. INFO와 영상은 해당 clip부터 만료.
- INFO: 해당 overlay/spec만 수정하며 CLEAN 픽셀은 변경하지 않음.
- 동일 fingerprint 재발: 같은 입력 재생성 금지. 주제 고유 참조 문제는 다음 후보, 공통 코드/인증/provider 문제는 전체 batch 중단.

아래 수치는 **실제 실행 전 확정할 초기 정책 제안**이며 이번 조사 세션에 적용한 실행 예산이 아니다.

- 각 대상 최초 생성 1회 + 품질 교정 1회.
- upstream rollback 최대 1회/topic run.
- 네트워크 일시 오류 retry 최대 1회/논리 작업. 결과 불명확은 retry가 아니라 reconcile.
- 후보는 최초 1개 + 교체 최대 2개. batch 전체 예산은 공통.
- 7장 기준 첫 calibration batch: 앱이 시작하는 AI adapter attempt 총 60회, elapsed 45분 상한 제안. 앱이 시작하는 전문 reviewer·재호출·fallback도 모두 계산한다. Codex/ImageGen 내부 tool/provider 호출은 관측 가능한 경우 별도 계측하며, 보이지 않는 내부 호출까지 정확히 60회 이하라고 보장하지 않는다.
- 유료 호출 전 사용 가능한 단가로 비용 상한을 확정한다. CLI 경로에서 비용이 계측되지 않으면 unknown으로 표시하고 호출 수/시간 상한을 강제한다. 무료/0원으로 표시하지 않는다.
- 상한 소진은 `budget_exhausted`로 종료한다. 수치를 자동으로 늘리거나 새 run ID로 우회하지 않는다.

## 8. 단계별 구현과 통과 조건

### M0 — 실패 재현과 읽기 전용 감사

대상: 기존 tests, `scripts/quality-eval-report.mjs`, 신규 `scripts/audit-pipeline.mjs`.

- Topic 159 실패 계약과 Topic 158 실제 블러 이미지를 최소 fixture로 보존. DB 전체/개인 오디오/인증정보를 Git에 넣지 않는다.
- orphan invocation, completed+quality fail, stale+OK, missing file, contract mismatch를 감사 명령으로 보고.
- report에서 DB unavailable을 조용히 0건으로 숨기지 않고 데이터 접근 실패와 품질 회귀를 구분.
- gold misses, 정상 fixture 오탐, 실제 제작 결과를 별도 지표로 표시하고 실패 exit code 계약을 추가.
- 47개 기존 회귀는 보존하되 소스 regex PASS를 E2E PASS로 집계하지 않음.

통과: 기존 결함을 잡는 신규 테스트가 먼저 실패하고, live DB 쓰기/외부 AI 없이 재현된다.

### M1 — durable run/store/runner

대상: `server.js`의 job enqueue/claim/execute/recovery, `lib/pipeline-convergence.js`, 신규 store/runner.

- SQLite 임시 fixture에서 additive migration, stable task key, lease fencing, invocation 연결을 구현.
- 완료와 successor를 한 transaction에 묶음. 파일 reconciliation 구현.
- manual/production_canary 상태 정책 분리. CLEAN/INFO의 AI_PASS→진행과 사용자 최종 승인 의미를 구분.
- 예산 reservation을 transaction에서 선점해 병렬 worker가 상한을 넘지 못하게 함.
- 기존 live DB는 아직 migration하지 않음.

통과: 두 번 요청해도 동일 작업, 7개 clip이 서로 합쳐지지 않음, worker 재시작 후 같은 run ID로 재개, cancel/late result/budget 테스트 통과.

### M2 — feasibility와 구조화 repair

대상: `server.js`의 brief/script/tts/shotlist 검토 경계, 신규 repair contract와 artifact state.

- 단계별 입력/결과 schema를 분리하고 mock provider 주입 가능하게 함.
- 대본 한 행 수정, TTS 초과 한 행 수정, 장면표 국소 수정, 상위 patch와 선택적 stale을 구현.
- 실패 fingerprint와 계약 hash를 함께 사용. 의미가 바뀐 입력에 과거 실패를 무조건 적용하지 않음.
- 후보 교체는 discovery/feasibility부터 새 run을 만들되 부모 batch 예산 유지.

통과: 대본 실패→patch 1회→TTS→장면표 성공 경로와 참조 부족→다음 후보 경로를 격리 E2E로 증명. 수치/claim 변경 patch는 거부.

### M3 — 실제 이미지 QC와 CLEAN/INFO 완주

대상: `scripts/media_qc.py`, `scripts/render_official_photo_clean.py`, `scripts/render_info_overlay.py`, 실제 media tests.

- Topic 158 세 실제 이미지의 큰 blurred contain 구성을 모두 검출한다. 자연스러운 하늘·피사계 심도·저대비 정상 사진을 오탐하지 않는 대조군 포함.
- 단순 edge 임계값만 낮추지 않고 경계/중앙 패널 비율/배경 반복/blur 분포와 renderer 메타데이터를 함께 검증.
- full-bleed crop 시 필수 물리 요소가 잘리면 자동 PASS하지 않고 해당 프레임을 부적합 판정.
- CLEAN 전체 QC 통과 후 INFO 논리 batch는 정확히 1회 등록. 실패 clip만 교정.
- 필요한 INFO가 none/투명 레이어로 대체되면 실패. 선택적 none은 허용하지만 실제 overlay 성공 수에서 제외.
- 같은 CLEAN 기반·overlay 밖 픽셀 보존·한글 폰트·라벨 수·기준점/방향/수치 근거를 검증.

통과: mock 7 CLEAN + 7 INFO 실제 파일, 최소 2 required INFO non-none, 누락/중복 0, 최신 입력 hash 일치, H3/video job 0. 파일 존재만으로 PASS하지 않음.

### M4 — 대시보드와 실제 canary 1회

대상: `dashboard/index.html`, run 조회/취소/승인 API, 신규 `scripts/verify-pipeline-run.mjs`.

- 화면에는 실행 상태, 품질, 최신성, 사용자 승인, 다음 행동, 실패 소유자, 사용량/예산을 별도 표시.
- proposed API: `POST /api/pipeline/runs`, `GET /api/pipeline/runs/:id`, cancel/review action. 기존 API는 호환 adapter로 유지.
- 가짜 provider로 HTTP→DB→파일→화면 성공/실패/취소 흐름을 먼저 확인. 테스트가 서버 import만으로 live DB/worker를 시작하지 않게 bootstrap 분리.
- frontend framework를 추가하지 않고 현재 화면에 최소 변경. 브라우저 자동화 도구는 기존 사용 가능 도구부터 확인.
- backup DB copy에 migration/복구 검증 후에만 사용자 승인된 live migration 적용.
- 실제 canary는 새 run ID로 한 번 시작. 도중 수동 DB/대본/manifest 수정 금지. 실패하면 증거를 남기고 동일 live 반복 대신 isolated 재현으로 돌아감.

통과: 무개입으로 CLEAN/INFO 생성 후 전체 최종 시각 검수. JWST 계약을 유지하면 7+7=14장, 후보를 교체하면 실행 전에 확정한 검증 물리 상태 수 N에 따라 N+N장을 검사한다. required INFO는 각각의 후보 계약으로 고정하되 이번 이미지 파이프라인 검증에는 실제로 필요한 non-none INFO 최소 2개를 지원하는 후보만 허용한다. 검수 중 장면/INFO 개수를 줄여 통과시키지 않는다.

DB/파일/QC/run 상태가 일치하고 **새 run 및 부모 batch 범위**의 active/orphan/duplicate/H3/video가 모두 0이어야 한다. 기존 orphan 6건은 별도 legacy audit 대상으로 남겨, 삭제 없이 근거와 함께 종료 또는 결과 불명확 상태로 분류한다. 과거 기록을 숨기거나 신규 run에 섞어 집계하지 않는다. 마지막 검수 전에는 완료라고 보고하지 않음.

### M5 — 영상과 편집 인계 (별도 실행 승인)

대상: 기존 H3 workflow/queue, FFmpeg 합성, `integrations/openshot/dinobox.py`.

- M4 수용 후 별도 production run에서만 시작. 모델/노드/LoRA/workflow revision과 라이선스 조건을 확인.
- 승인 CLEAN을 H3 입력으로 사용하고 INFO는 결정론적 후처리 레이어로 합성.
- GPU 동시성은 기존 TTS/H3 상호 배제 정책 유지. 4초/24fps 원본과 실측 TTS에 맞춘 1배 트림 확인.
- 짧은 영상, stale 이미지, 잘못된 첫 프레임/INFO 합성, 오디오 충돌은 편집 인계 차단.
- MP4 전체 재생 검수 후 OpenShot에서 실제 project open, 타임라인·음성·자막·수동 편집 보존 확인.

최종 제품 통과: 한 승인 주제가 조사→대본→실측 TTS→장면표→CLEAN→INFO→영상→편집 패키지까지 연결되고, 실패/취소/재시작/부분 교체도 재현된다. 게시물 업로드와 외부 배포는 별도 승인이다.

## 9. 테스트·출시·복구 기준

현재 존재하는 명령:

```bash
node --check server.js
TMP="$PWD/tmp" TEMP="$PWD/tmp" TMPDIR="$PWD/tmp" npm test
npm run quality:report
git diff --check
```

향후 추가할 명령은 M0/M4에서 구현한 뒤 문서화한다. 아직 없는 `pipeline:test` 같은 npm script가 실행 가능하다고 보고하지 않는다.

필수 crash matrix:

1. job claim 후 provider 호출 전.
2. 외부 성공 후 완료 응답/DB 기록 전.
3. 파일 publish 후 DB commit 전.
4. 결과 확정과 successor 저장 transaction 중.
5. 동일 요청 동시 제출 및 이전 lease worker의 늦은 완료.
6. INFO 일부 성공/일부 실패와 retry budget 소진.
7. 사용자 cancel 직후 provider 응답.
8. 상위 계약 revision 변경 도중 하위 결과 도착.

모든 테스트는 프로젝트 내부 임시 data root와 DB를 사용한다. 기본 자동 테스트의 외부 네트워크/AI 호출은 금지한다. mock E2E에서도 실제 renderer·파일 hash·DB transaction을 검사한다.

릴리스 전에는 별도 프로세스·격리 DB에서 migration/restore를 검증하고, 전환 직전 새 백업을 만든다. rollback은 기존 snapshot과 호환 코드를 이용하는 명시적 절차이며 live DB 파일 위에 무조건 덮어쓰지 않는다. 데이터 손실을 피하기 위해 전환 이후 새 데이터의 보존/이관 여부를 먼저 판단한다.

## 10. 실행 순서와 하지 않을 일

확정할 실행 순서: **M0 → M1 → M2 → M3 → M4 → 별도 승인 후 M5**.

- 이번 산출물은 계획이다. 코드 재구축, 의존성 업그레이드, DB migration, 실물 AI/H3 생성은 아직 실행하지 않았다.
- 단계마다 좁은 변경 묶음과 검증 증거를 남긴다. commit/push는 해당 실행 맥락에서 사용자 승인을 받는다.
- Topic 159를 사람이 고쳐 성공 사례로 만들지 않는다.
- 기존 47 PASS, gold 0 misses, job completed 중 어느 것도 실제 완주 증거 대신 사용하지 않는다.
- 라이브 DB를 반복 실험장으로 쓰지 않는다.
- 현 스택을 지우거나 UI를 새로 만드는 것으로 실패 원인을 덮지 않는다.
- 최신 버전이라는 이유로 provider를 교체하지 않는다. 필요하면 동일 fixture와 비용/지연/정확도 비교 후 별도 결정한다.

## 공식 출처

- [R1] Codex TypeScript SDK: https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md
- [R2] Codex subprocess/abort 구현: https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/exec.ts
- [R3] npm 배포 버전: https://registry.npmjs.org/@openai/codex-sdk/latest , https://registry.npmjs.org/@openai/codex/latest
- [R4] OpenAI 이미지 생성/편집: https://platform.openai.com/docs/guides/image-generation
- [R5] Node 24 SQLite API/backup: https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- [R6] SQLite WAL/버그 수정/운영 조건: https://sqlite.org/wal.html
- [R7] Temporal Activity와 멱등성: https://docs.temporal.io/activity-definition
- [R8] AWS transactional outbox: https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html
- [R9] OpenBMB VoxCPM/VoxCPM2: https://raw.githubusercontent.com/OpenBMB/VoxCPM/main/README.md
- [R10] MiniMaxAI H3 모델 카드: https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/README.md
- [R11] Comfy-Org H3 재패키징: https://huggingface.co/Comfy-Org/MiniMax-H3/raw/main/README.md

최신 Node patch 자체, 설치된 Python/torch/CUDA 전체 버전, 로컬 H3 weight SHA-256, 개별 source/모델의 상업 라이선스 적용 결론은 이번 조사에서 확정하지 않았다. 이들은 M4 provider calibration 또는 M5 실행 전 확인 항목이지 이미 통과한 조건이 아니다.
