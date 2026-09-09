# 최종 재구축 계획 — 공학 쇼츠 자동 제작

작성·공식 자료 조회: 2026-09-05
상태: **2026-09-05 사용자 승인 후 재구축 진행 중. 라이브 DB migration·실물 AI/H3 생성은 실행하지 않았다.**
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
npm run pipeline:test
npm run pipeline:audit
npm run quality:report
node --test test/pipeline-verification.test.js
git diff --check
```

`pipeline:audit`는 읽기 전용이며 발견 사항이 있으면 exit 1, DB/쿼리 접근 오류는 exit 2다. 과거 실패가 남아 있는 운영 데이터에서 exit 1은 테스트 실행 실패와 구분한다.

신규 읽기 전용 수용검사: `node scripts/verify-pipeline-run.mjs --db <DB> --contract <JSON> [--root <프로젝트>] [--python <격리 Python>]`. 운영 DB 기본값은 없다. 계약에는 `version: 1`, `runId`, 최초 `runInputHash`, 최신 `stageInputHashes.clean/info`, `clips` 배열을 명시한다. 각 clip은 `key`, `requiredOverlay`, 이에 일치하는 `infoSpec.requiresOverlay`, `infoSpec`, `claimRefs`, `layoutTrusted`를 포함한다. INFO의 `infoEvidence`에는 renderer가 만든 `overlayPath`, `guidesPath`, `labelsPath`, `renderPath`가 필요하며 artifact metadata 또는 clip 계약에서 제공한다. 최신 입력 hash와 required 조건은 생성 결과를 보고 낮춰 잡지 않고 확정된 입력 계약에서 가져온다. 타이밍만 변경한 이미지의 재사용을 검사하려면 `currentInputSnapshots.clean/info`도 제공한다. 검사기는 최신 generation hash, 발행 job의 원본 snapshot hash, 양쪽 visual fingerprint와 immutable manifest의 versioned binding이 모두 일치할 때만 재사용을 인정한다. binding 없는 legacy 결과를 자동 승격하지 않으며 인정한 항목은 `reusedVisualArtifacts`에 표시한다.

검사기는 run의 ledger·manifest·실제 파일 hash·이미지 decode·픽셀 QC를 확인한다. 부모 batch가 있으면 모든 이전 후보의 작업·attempt·호출 회계·최초 deadline·후보 순서/입력·금지 영상 작업·미종료 invocation까지 검사하며, 초기 batch 계약보다 장면/필수 INFO 수를 줄일 수 없다. 선택적으로 계약에 `batchId`를 고정하면 DB 연결과 일치하는지도 검사한다. scope는 `single_run_ledger_and_media` 또는 `batch_ledger_and_selected_run_media`로 구분한다. PNG 헤더나 저장된 PASS만으로 통과시키지 않는다. exit 0도 `machinePassed`일 뿐, 실제 물리 주장·시각 품질·사용자 승인의 통과를 뜻하지 않는다. 항상 `visualReviewRequired: true`를 유지한다.

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

- 사용자 승인으로 코드 재구축을 시작했다. 의존성 업그레이드, 라이브 DB migration, 실물 AI/H3 생성은 아직 실행하지 않았다.
- 검증된 첫 변경: Topic 158 실제 실패 이미지 3장을 provenance/hash와 함께 fixture로 보존했다. 기존 QC의 false PASS를 실패 테스트로 재현한 뒤, 경계 쌍과 동일 사진 확대 배경 일치를 결합한 검출로 세 장 모두 차단했다. 원본·축소·회전 9개 변형과 정상 full-bleed/저대비/점진적 초점 흐림/가로 사진 12개 대조군을 검사한다.
- INFO QC에서 required none, alpha만 있고 실제 표시가 없는 overlay, 한 채널 1단계 픽셀 변경 누락, 가이드·라벨 분리 레이어와 최종 overlay 불일치를 각각 실패 테스트로 재현·수정했다. 기존 생성물·QC 저장값은 덮어쓰지 않았다.
- M0 읽기 전용 감사 실측: orphan invocation 6건, completed+quality fail 25건, contract mismatch 107건, stale+OK 50건, missing file 28건. legacy job-quality의 일부 연결은 topic/stage/시간 범위 상관관계이며 확정 FK가 아니다. 발견 사항은 삭제하거나 PASS로 덮지 않는다.
- M1의 store/runner, stable key, lease·예산, 결과+successor transaction을 구현했다. 5단계 native generator는 attempt별 DB/file clone에서 실행하고 lease·input·허용된 topic/table delta를 재검사해 승격한다. 호출별 IPC 예산 reservation과 결과 기록을 연결했다. 파일과 DB의 원자성을 주장하지 않으며 journal 미확정은 수동 reconciliation 대상이다. 신규 durable migration은 명시적 opt-in과 프로젝트 tmp 내부 격리 조건으로 보호한다. native CLEAN은 검증된 reference의 결정론적 renderer 경로이고 workspace-write ImageGen fallback은 차단 상태다. 운영 활성화나 실제 외부 provider 품질 검증은 아니다.
- 운영 DB를 read-only online backup한 복사본에서 PipelineStore additive schema를 두 번 적용했다. 기존 24개 테이블 행 내용 보존, integrity_check OK, foreign_key_check 0건을 확인하고 별도 before 복사본에서 복원 검증했다. 원본 DB byte hash 변화 없음. 증거: `tmp/migration-copy-xQTCJI/report.json`. 이 검증은 store schema 범위이며 전체 서버 bootstrap/운영 전환 검증을 대신하지 않는다.
- 별도 synthetic source 7개를 기존 실제 CLEAN/INFO renderer에 통과시켜 7+7장을 만들고, runner immutable publication과 신규 수용검사까지 연결했다. required non-none 2개, 동일 CLEAN 합성·분리 레이어·한글 라벨·파일 hash·manifest·중복/누락·최신 입력을 검사한다. 저장 PASS만 있는 깨진 PNG, 오래된 입력, 누락 레이어, 중복 이미지, 미완료 job은 거부한다. 미디어 회귀와 수용검사 합계 `node --test test/media-pipeline.test.js test/pipeline-verification.test.js` 16/16 통과. synthetic 도형 이미지는 실제 주제나 AI 생성 성공 사례가 아니다.
- M2의 첫 수직 단면을 구현했다. 특정 JWST 문장을 주입하던 공용 대본 수정 지시를 제거하고, durable production canary의 명확한 단일 행 narration finding만 structured patch 1회로 수정한다. 전체 candidate beforeHash, 대상 행/필드, 수치·단위·순서 및 보수적 조건/부정/범위 검사를 적용하며 narration 외 값은 보존하고 ttsText만 재계산한다. 구조 검사는 의미 검증이 아니며 새 독립 검수 통과가 필수다. global repair 기본값 0 및 reviewOnly/명시적 opt-out은 유지한다.
- 검수 실패→2번 행 patch 1회→독립 검수 2라운드→native TTS/장면표/CLEAN/INFO 7+7→사용자 검수 대기 흐름을 검증했다. 원본 생성 1회, 다른 행·claimRefs·visualStateId·행수/순서 불변, required INFO 2개, 동일 run 35/60 호출·22 attempts. 잘못된 행/숫자/조건 변경과 재검수 실패는 승격·후속 없이 중단한다. 증거: `tmp/pipeline-native-server-ryK2Jl/data/native-verification.json`, run `4dd7d446-63c2-47d5-a50c-20be17e2d0c6`. 부모가 전체 `npm test` 193/193을 직접 재실행해 통과 확인했다.
- TTS 단일 초과 행 복구를 연결했다. 실측 5초인 2번 행만 patch 1회·독립 검수 후 2.5초로 재합성하고 나머지 6개 WAV bytes/paths를 보존했다. 무음 간격만 합성해 master 28초, 같은 run 36/60 호출, 7+7·required INFO 2개 검증. 재초과/잘못된 행/semantic 거절/취소는 미승격이다. `ttsRepairLimit:0`·`reviewOnly` continuation 전파도 수정했다. 증거: `tmp/pipeline-native-server-ANlsXB/data/native-verification.json`. 부모가 전체 214/214 직접 재실행 통과 확인.
- 장면표는 명확한 단일 clip `weak_video_motion` finding의 `cameraMotion`만 patch 1회·독립 재검수한다. 나머지 clip, 물리상태·참조·주장·실측 timing·required INFO·상위 script/TTS는 보존한다. 모호한 finding은 상위 책임 단계와 HOLD를 기록한다. 증거: `tmp/pipeline-native-server-TbSM0l/data/native-verification.json`, run `9e115658-18c6-43cb-9aa6-cd1847aeac77`, 35호출·22 attempts·7+7. 실행 에이전트 전체 227/227, 부모 patch 계약 4/4 직접 검증. CLEAN/INFO 기존 국소 교정 경로는 중복 구현하지 않았다.
- 저장 후보의 feasibility→순서 기반 교체를 연결했다. `pipeline_batches`와 nullable `pipeline_runs.batch_id`, 최대 3후보, 공유 호출·attempt·최초 deadline, 멱등 request key를 추가했다. `POST /api/pipeline/batches`, `GET /api/pipeline/batches/:id`, `POST /api/pipeline/batches/:id/cancel`로 조회·취소한다. 시작 계약은 `existingTopicIds`, `startContract: {stage: "script", candidatePolicy: "ordered_existing_only", referenceFailurePolicy: "next_candidate", requiredVisualStates: 7, minimumRequiredInfoOverlays: 2}` 형식이다. 현재는 기존 script가 없는 후보를 대상으로 한다.
- 대본 호출 전 상태/근거/INFO 계약과 검증된 로컬 참조 파일 hash를 검사한다. 구조적 참조 부족만 다음 후보로 넘기며 인증·provider·코드·입력 stale·결과 불명확·일반 품질 실패는 batch 전체를 중단한다. 첫 후보 AI 생성 0회로 `needs_reference`→둘째 후보 native 생성 7+7·required INFO 2→검수 대기를 확인했다. 같은 batch 32/60호출·24 attempts, 두 run의 최초 deadline 동일. 증거: `tmp/pipeline-native-server-QJBYED/data/native-batch-ledger.json`, batch `4ab9b74b-dd50-4c2b-afb5-5229d501cca6`. 부모가 store/feasibility 16/16, native batch 6/6을 직접 재실행 통과 확인했다. 실행 에이전트 전체 249/249 통과.
- 최종 수용검사에 batch 전체 ledger를 연결했다. 이전 후보의 미종료 작업/H3/고아 호출/미확정 attempt, 공유 카운터 초기화·deadline 연장·입력 변경·잘못된 교체 사유·탈락 후보 artifact를 거부한다. 수용검사 테스트 21/21 통과. 위 native batch DB를 독립 읽기 전용으로 검사해 2 runs/24 jobs/24 attempts/32 invocations와 실제 7+7 이미지 QC를 확인했고 원본 DB hash가 변하지 않았다.
- 순수 timing-only 변경은 전체 generation lease hash와 완료 이미지용 visual fingerprint를 분리했다. 실제 PCM 검증 후 timing adapter가 장면표/자막/편집을 stale 처리하고, 원본 이미지·artifact DB·발행 manifest·사용자 승인은 보존한다. native 7+7 후 timing 변경에서 호출 32→32, CLEAN/INFO 추가 호출 0을 확인했다. 의미·물리상태·참조 crop·prompt 변경은 재사용하지 않으며 INFO 사용자 입력만 바뀌면 CLEAN을 유지한다. 증거: `tmp/pipeline-native-server-uEh8wm/data/native-timing-reuse.json`. 실행 에이전트 전체 267/267 통과.
- 부모가 타이밍 재사용을 최종 수용검사에도 연결하고 native timing 시나리오를 재실행했다. 최신/원본 snapshot·DB 및 발행 manifest binding·실제 픽셀 QC를 함께 검사하며 14개 재사용을 확인했다. 현재 snapshot 누락, 내레이션 변경, manifest binding 제거는 실패한다. 부모 직접 native timing 1/1 및 수용검사+visual 계약 26/26 통과. timing adapter는 아직 local export이고 동일 scene identity·segment당 shot 1개·gap 없는 PCM만 수용하며 caption/edit는 만료까지만 처리한다.
- M3 official cover는 verified asset metadata의 `requiredBounds`(EXIF 방향 적용 원본 전체 정규화 좌표)를 source identity·cached SHA-256·입력 revision에 결속하고 그 영역을 보존하도록 위치를 조정한다. 기존 `focusBounds` crop fallback 의미는 유지한다. 선언이 없으면 선택 영역 전체를 보존하며 추가 절단이 필요할 때 HOLD, 선언 영역이 세로 cover에 들어가지 않거나 panel 밖이면 HOLD한다. renderer가 필수 요소를 확인했다고 기록하던 가짜 의미 PASS는 제거했다. 좌표가 실제 필수 요소를 모두 포함하는지는 여전히 독립 시각 검수 대상이다. 기존 JWST 가로 panel은 검증된 보존 영역 또는 다른 근거 없이는 막힐 수 있으며 임의 좌표를 넣지 않았다.
- 실행 에이전트 전체 회귀 278/278 통과 후 부모가 실제 Python crop 계약 9/9, native 불가능 crop(후속 검수 AI 0·미승격) 및 가능한 off-center crop(7+7) 2/2를 직접 재실행했다. 합성 red rectangle의 전체 너비/높이 보존을 픽셀로 검사하고 출력도 열어 확인했다. 실 canary 품질 검증과 구분한다.
- M4 기존 대시보드에 durable 상태 패널과 `GET /api/pipeline/topics/:topicId`를 연결했다. 실행·기계 품질·입력 최신성·사용자 승인·조치 담당·run/batch 예산을 분리한다. 조회는 생성하지 않으며 명시 클릭 시작, 멱등 재요청, 실행/검수 대기 중 중복 409, 공유 batch 취소, 비활성 503을 처리한다. 독립 검수 실패를 생성자 PASS로 덮지 않는다. timing-only 최신성은 원본 job snapshot·현재 fingerprint·발행 manifest·실제 파일 hash를 모두 확인하며 미완료 job의 stale은 유지한다. 부모가 DOM 동작+격리 HTTP 20/20을 직접 재실행하고 패널 fixture 스크린샷을 확인했다. 실행 에이전트 기존 agent-browser로 패널 상호작용도 검증했다. batch 생성 UI 및 terminal resume는 아직 미완료다.
- M4 실제 전체 대시보드를 격리 HTTP에서 열어 주제 선택·CLEAN/INFO 이동·stale/missing 승인 거부·주제 전환 race·현재 hash 결속 승인·부분/전체 승인 구분·새로고침 후 영상 자동 진입 없음·생성 POST 없음까지 브라우저로 검증했다. 증거: `tmp/dashboard-full-m4-v2/browser-evidence.json`, desktop/mobile 스크린샷. TTS/environment 조회만 GPU probe 방지를 위해 mock했고 이미지/QC/승인은 synthetic이다. 부모가 화면을 확인한 뒤 이미 승인된 상태에서 재승인을 요구하던 안내를 수정했다. 실제 run 상태는 유지하고 승인 기록/별도 영상 작업을 안내한다. 부모 직접 DOM+격리 HTTP+fixture 서버 종료 테스트 22/22 통과. 이 검증은 실제 주제의 사용자 승인이 아니다.
- official renderer에 출력 없는 `--preflight`를 추가해 실제 렌더와 기하 계산을 공유한다. 최초 continuation에서 대본 등록 전 검사하고 provider 직전에도 재검사한다. crop 불가능·보존 영역 누락만 구조적 `needs_reference`로 처리하며 Python/decode/코드 오류는 후보 교체 없이 HOLD한다. 부모 직접 crop/feasibility 18/18, native 사전 차단·다음 후보 공유 예산·Python 부재 4/4 통과. 불가능 후보는 대본 job 및 provider 호출 0이다.
- 실제 저장 자료 읽기 전용 조사: `tmp/read-only-crop-evidence.json`. Topic 158 이미지 3개와 Topic 159 이미지 10개의 decoded hash 불일치는 원본 SHA와 파생 파일 SHA를 혼동한 소비자 계약 오류였다. 13/13 원본 SHA가 DB와 일치했고 동일 normalizer의 tmp 재생성 bytes도 13/13 기존 decoded와 일치했다(`tmp/reference-source-audit.json`, `tmp/reference-legacy-proof.json`). JWST brief stale 및 보존 영역 부재는 별도 남은 문제다. 기존 crop 4상태의 비결속 기하 진단은 required_bounds_missing이며 실 canary 준비 완료를 뜻하지 않는다.
- 두 참조 다운로드 경로에 versioned `verification.contentBinding`을 추가했다. 원본 SHA 의미를 유지하면서 파생 contentHash·양쪽 경로·변환·PDF page를 별도 결속하고 feasibility/crop/snapshot 소비자를 통일했다. legacy는 자동 승격하지 않고 read-only 재생성 proof만 제공한다. 운영 DB/cache 변경 없음. 부모 직접 참조 binding/crop/feasibility 20/20 통과 및 재생성 이미지 확인. 이미지 테스트는 실제 normalizer, PDF 변환 프로세스는 Poppler 부재로 mock이므로 실제 PDF 렌더 검증은 미완료다.
- 전체 server bootstrap을 운영 DB online backup 복사본에서 검증했다. 부모 직접 `node scripts/check-server-bootstrap-copy.mjs` 재실행: 기존 24테이블 내용 보존(복사본 경로 재매핑 후 비교), migration 12 기록·4테이블·12컬럼 추가, disabled 503/enabled 200, 두 번째 기동 idempotent, integrity OK/FK 0, 복구 clone 원본 snapshot 일치, 원본 DB·참조 bytes 불변. 외부 프로세스/네트워크 0. 증거: `tmp/full-bootstrap-copy-apbFHX/report.json`. 기동마다 동일 benchmark의 updated_at을 갱신하던 동작도 실제 필드 변경 시에만 UPDATE하도록 수정했다. live durable 활성화는 여전히 차단 상태다.
- durable Vox는 명시적인 프로젝트 내부 `DINOBOX_VOXCPM_MODEL_DIR`와 필수 모델 파일을 대본/음성 호출 전에 검사한다. local directory + local_files_only 및 격리 HF cache/offline 환경으로 미승인 다운로드를 차단했다. legacy 호출 방식은 유지한다. durable renderer Python은 프로젝트 venv 기본값이며 명시 설정과 별도 Poppler 경로를 유지한다. 부모 직접 로컬 모델·offline·선행 HOLD·renderer 설정 테스트 4/4 및 구문/diff 검사 통과. 패키지는 설치돼 있으나 프로젝트 내부 Vox 모델 경로는 미설정이고 실제 모델/GPU 합성은 미검증이다.
- 실 canary의 남은 경계는 명시적인 reference 재결속, 유효한 brief와 필수 영역 보존 계약, 프로젝트 내부 모델 준비·실제 provider/Vox 검증 및 별도 운영 전환 승인이다. 이미지만 정상임을 증명한 legacy receipt를 자동 품질 PASS로 사용하지 않는다.
- INFO 완료 artifact에 versioned clip binding을 추가했다. 모든 clip이 referencePolicy=none인 독립 구도에 한해 원본 job/snapshot·manifest·현재 clip 계약·bytes를 검증하고 타 clip CLEAN bytes/INFO 사용자 입력 변경을 분리한다. INFO 2번 수정 시 CLEAN 7개와 다른 INFO 6개·승인 유지, 미승인 CLEAN 2번 변경 시 CLEAN/INFO 2번만 stale을 확인했다. native 실제 renderer 7+7 후 호출 32→32, 파일·manifest·ledger 불변. 부모 직접 계약 7/7 및 native timing+clip reuse 1/1 재실행 통과. 연결된 reference 정책은 보수적으로 전체 의존성을 유지한다. 일반 CLEAN 부분 요청이 전체를 몰래 enqueue하던 경로는 HOLD로 막았다.
- 동일 run 명시 교정 API `POST /api/pipeline/runs/:runId/clean-repairs`를 구현했다. 입력은 clipIndex/requestKey/beforeHash/inputRevision/panelCrop이며 검증된 원본·requiredBounds 안의 subcrop만 허용한다. 독립 referencePolicy=none·미승인 target pair·clip당 1회 제한, 같은 run/batch 예산과 deadline 유지. CLEAN 독립 재검수→해당 INFO 재생성/독립 검수→검수 대기, 호출 32→37, active 14/history 16, 다른 12개 승인/파일/발행 manifest 보존을 확인했다. 해당 video만 stale이며 영상 생성은 없다. verifier도 supersedes history 및 clip binding 검증을 연결했다. 부모 직접 repair/store+verifier 25/25, native 성공·검수 거절·취소/늦은 응답 3/3 통과. 증거: `tmp/pipeline-native-server-mf6rZ3/data/native-clean-repair-verification.json`. 명시 HTTP API이며 UI 교정 입력은 아직 없다. 실제 AI 품질 검증이나 자동 의미 patch를 완료한 것으로 보지 않는다.
- INFO의 단일 clip unreadable/clutter 실패는 기계 QC 통과 시 labelPositions만 patch 1회·독립 재검수한다. beforeHash·clip·좌표·실제 변경을 검사하고 spec/claim/guide geometry/required INFO/CLEAN은 보존한다. durable canary 기본 1회, reviewOnly/explicit0 및 명시 CLEAN 교정 안에서는 비활성이다. 부모 native 성공·재실패·none/geometry/claim 변조·취소·reviewOnly·0회 제한 8개 PASS를 직접 확인했다. 성공은 32→35호출, 실패 clip renderer만 2회이고 다른 INFO는 각 1회다. 증거: `tmp/pipeline-native-server-LxAVbA/data/native-info-repair.json`. 의미 spec 수정은 지원하지 않는다.
- 전체 회귀 301개 중 300 PASS/1 FAIL을 기록했다. off-center native의 일시적인 runIsolatedProvider export 부재 오류는 현재 재현되지 않았고 실행 에이전트의 같은 시나리오 재실행은 PASS다. 당시 원인은 확정하지 않았으며 전체 회귀가 모두 통과했다고 보고하지 않는다. 누락된 CLEAN/INFO repair 단위 테스트를 package test/pipeline:test 양쪽 명시 목록에 추가했다.
- 최초 shotlist 발행 전 명확한 단일 `narration_expression` finding은 상위 script 한 행 patch·독립 검수·그 TTS segment만 재합성·장면표 재검수를 거쳐 같은 run으로 이어간다. physical storyboard/required INFO/다른 6 WAV 및 원본 음성 bytes 보존, 32→38호출, 7+7·영상 0·검수 대기를 확인했다. 부모 직접 계약 6/6, native 성공·재발·승인 script 보호 3/3 통과. 증거: `tmp/pipeline-native-server-AUWvwq/data/native-upstream-repair.json`. run당 1회이며 before snapshot·파일 hash·실측 길이를 승격 시 재검사한다. 이미 shotlist/visual/review가 있거나 모호·물리/사실 수정이면 HOLD한다. 기존 발행물까지 상위 rollback을 자동 확대하지 않았다.
- 실제 별도 process A에서 CLEAN 3개 완료 후 다음 job claim 상태로 종료하고 B가 같은 DB/run을 재개해 7+7을 완주했다. 기존 3장·QC·발행 manifest·승인·완료 job 불변, calls 19→32, interrupted claim 때문에 attempts 23, active/orphan/video 0. provider 시작 후 결과 불명확은 calls 20→20/reconcile HOLD, 취소는 19→19/실행 0이다. 부모 restart 3/3 직접 재실행 통과. 증거: `tmp/pipeline-restart-srAEzo/data/restart-verification.json`. 이후 소스 고정 전체 회귀 328/328 PASS를 부모가 확인했다. 그 뒤 독립 검토에서 same-revision 원본 snapshot 검증 우회, manifest header/성공 attempt 소속 검사 누락, commit 직전 deadline/lease 경계 누락을 찾아 수정했다. 동일 revision도 원본 검증 필수, manifest run/job/lease를 succeeded attempt에 결속, 두 callback 이후 최종 fence 실패 시 primary 파일/DB rollback과 budget HOLD를 유지한다. 최신 변경의 실행 에이전트 관련 회귀 81/81, 부모 직접 store+verifier 반례 45/45 PASS. 328 전체 통과는 이 마지막 보완 이전 결과로 구분한다.
- legacy orphan을 read-only 재분류했다. IDs 51/96/97/127/128/156은 모두 Topic 159, job 연결·완료 시각·duration 없이 running 기록만 남아 있다. 결과 불명확 6건이며 종료 확인이나 현재 active 증거는 없다(후자가 실행 중이 아님을 증명하지는 않는다). 신규 durable run/batch 통계와 분리하고 삭제/성공처리하지 않았다. 증거: `tmp/legacy-invocation-disposition.json`; 원본 DB SHA 불변.
- 위 흐름은 실제 생성 함수·검수 판정·renderer·승격 코드를 실행하지만 AI/Vox 응답과 원본 이미지는 fixture다. 실제 AI의 사실/의미/시각 검증 성공 사례가 아니다. clip별 변경 영향 처리의 전체 확대, 실 provider 무개입 canary는 미완료다. 신규 discovery/research는 위 저장 후보 교체와 구분하며, 격리 검증만으로 전체 완주를 완료 처리하지 않는다.
- 단계마다 좁은 변경 묶음과 검증 증거를 남긴다. commit/push는 해당 실행 맥락에서 사용자 승인을 받는다.
- Topic 159를 사람이 고쳐 성공 사례로 만들지 않는다.
- 기존 47 PASS, gold 0 misses, job completed 중 어느 것도 실제 완주 증거 대신 사용하지 않는다.
- 라이브 DB를 반복 실험장으로 쓰지 않는다.
- 현 스택을 지우거나 UI를 새로 만드는 것으로 실패 원인을 덮지 않는다.
- 최신 버전이라는 이유로 provider를 교체하지 않는다. 필요하면 동일 fixture와 비용/지연/정확도 비교 후 별도 결정한다.

## 2026-09-08 실제 제작 검증 결과 — 완성 미달

- `tmp/actual-production-20260908/result.html`에서 실제 결과를 열 수 있다. `final-evidence.json`에 호출·파일 hash·실패 및 재검수 기록을 보존했다.
- 정식 run `28b75d33-6494-4f97-ad7a-7ee2db5ef8e3`은 `needs_reference`로 blocked이며 정식 artifacts는 0개다. CLEAN 7장 + INFO 7장, 필수 INFO 최소 2장 목표는 달성하지 못했다. 별도 진단 산출물을 이 run의 성공으로 승격하지 않았다.
- 프로젝트 내부 `models/voxcpm2`에 공개 VoxCPM2 필수 모델을 준비하고 offline 실제 합성을 실행했다. 진단 내레이션 7구간, 합계 17.76초 PCM 음성을 생성했다. 길이·파형은 확인했으나 청취 검수는 하지 않았다. 앞선 모델 미준비 기록은 이 실행 이전 상태다.
- native 시각 검수에서 경로 문자열만으로는 실제 픽셀 전달이 보장되지 않는 결함을 확인했다. CLEAN/INFO 독립 검수와 INFO layout 요청에 SDK `local_image` 첨부를 명시했다. 그 이전 path-only 검수는 실제 이미지를 보았다는 증거로 간주하지 않는다.
- 최신 manifest와 stale shotlist 사이에 치수선 요구·2패널 허용·필수 INFO 누락 충돌이 있었다. 최신 manifest를 실제 AI에 제공해 별도 canonical 진단 계약을 생성하고 VS07 지상 시험 CLEAN과 `실물 크기` factual badge INFO를 제작했다. 배지 위치 국소 수정 후 실제 이미지 첨부 독립 CLEAN·INFO 재검수가 모두 통과했다. 부모도 PNG를 직접 열고 결과 JSON·파일 hash를 확인했다. 필수 INFO 진단 통과는 **1쌍**이며 전체 생산 완주가 아니다.
- VS02/06 필수 구조 전체를 보존하는 세로 참조와 나머지 장면 계약 정합성은 미해결이다. NASA 개별 도식·step 영상 조사만으로 해결됐다고 처리하지 않았다. VS03 수치는 NASA 현재 deployment 페이지의 약 2m와 이전 explorer의 1.22m가 상충하므로 새로 발견한 숫자로 무조건 치환하지 않았다.
- 마지막 변경 후 부모 직접 `test/quality-gates.test.js` 14/14 및 `test/pipeline-server.test.js` 14/14 통과. 후자는 mock 기반 회귀이며 실 제작 성공 증거와 구분한다. 마지막 변경 이후 전체 suite 재실행은 하지 않았다.
- 운영 DB SHA256 `e0c2f3d9344a340d946cf009383eb6a77c5d6a852b82514111cd7d3707bab5b9` 불변을 부모가 재확인했다. 운영 원본·실패 기록 보존, 이번 실제 검증 변경의 commit/push 및 운영 전환은 하지 않았다.

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
