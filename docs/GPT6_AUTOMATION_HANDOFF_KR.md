# GPT-6 인계서: 무개입 쇼츠 제작 자동화 최적화

최종 갱신: 2026-09-04 이후 현재 작업 트리 기준

## 1. 이 문서의 목적

이 프로젝트에서 최근 며칠 동안 진행한 자동화 최적화 작업의 목표, 구현된 내용, 실패한 내용, 과도한 재시도 원인과 다음 구현 우선순위를 GPT-6에 정확히 전달한다.

이 문서에서 가장 중요한 구분은 다음과 같다.

- 목표는 특정 주제의 이미지를 사람이 직접 고쳐 완성하는 것이 아니다.
- 실제 주제 제작은 자동화 프로그램을 검증하기 위한 production canary다.
- 최종 목표는 검토 AI가 대본 단계부터 오류를 발견하고 허용된 범위에서 스스로 교정해 CLEAN과 INFO까지 완주하는 것이다.
- 근거가 실제로 부족한 주제는 억지로 통과시키지 않는다. 대신 조기에 판정하고 다음 제작 가능한 주제로 자동 교체해야 한다.

## 2. 사용자 의도와 완료 정의

사용자가 처음부터 원한 동작은 다음과 같다.

```text
주제 탐색
-> 사실 검증
-> 제작 가능성 검증
-> 제작 설계서
-> 대본 생성 및 검토 AI 자동 교정
-> 실제 TTS 생성 및 길이 교정
-> 장면표 생성 및 검토 AI 자동 교정
-> CLEAN 생성 및 검토 AI 자동 교정
-> INFO 생성 및 검토 AI 자동 교정
-> 대시보드에서 결과 확인
```

완료 조건은 다음과 같다.

1. 사용자가 중간에 대본, 장면표, 이미지 문제를 찾아 지적하지 않아도 된다.
2. 검토 AI는 단순히 실패를 감지하고 차단하는 데서 끝나지 않는다.
3. 사실 범위를 바꾸지 않는 국소 오류는 해당 단계를 한 번 자동 수정한다.
4. 하위 단계에서 상위 계약 문제가 발견되면 정확한 상위 단계만 수정하고 하위 산출물을 무효화한다.
5. 공식 제작 참조가 본질적으로 부족하면 같은 주제를 무한 재시도하지 않는다.
6. 제작 불가능 주제는 조기에 종료하고 새로운 제작 가능한 주제로 자동 교체한다.
7. 한 production canary가 대본부터 CLEAN/INFO까지 실제 파일을 생성해야 한다.
8. canary 범위에서는 H3와 영상 작업을 절대 생성하지 않는다.
9. 대시보드 `http://localhost:5174`에서 진행 상태, 실패 소유자, 수정 결과와 최종 자산을 확인할 수 있어야 한다.

현재 이 완료 조건은 충족되지 않았다.

## 3. 현재 결론

현재 시스템은 검증 규칙과 실패 차단 능력은 크게 늘었지만, 자동 수렴 시스템으로는 완성되지 않았다.

실제 상태는 다음과 같다.

- 계약 및 회귀 테스트는 현재 `47/47` 통과한다.
- 품질 gold regression은 `0 misses`다.
- 서버 health는 정상이며 AI active/queued/running 작업은 모두 0이다.
- Topic 159에는 대본과 TTS가 있지만 최신 제작 설계서와 장면표는 stale 상태다.
- Topic 159 CLEAN 파일은 0개다.
- Topic 159 INFO 파일은 0개다.
- Topic 159 video job은 0개다.
- 따라서 자동 제작 완주는 실패했다.

테스트 통과와 실제 production canary 완주는 같은 의미가 아니다. 현재 테스트 다수는 코드 문자열, 계약 구조, 결정론 함수와 fixture를 검증하며 실제 외부 AI와 미디어 생성의 종단 수렴을 보증하지 않는다.

## 4. 작업 시간과 사용량 감사

Gari main-agent 로그만 기준으로 계산한 결과다. 다른 도구의 로그와 하위 agent 원문은 포함하지 않았다.

### 4.1 경과 시간

| 날짜 | 세션 범위 | tool/LLM 이벤트 15분 cap 추정 활동 |
|---|---:|---:|
| 2026-09-02 | 5시간 34분 | 1시간 58분 |
| 2026-09-03 | 1시간 44분 | 17분 |
| 2026-09-04 | 11시간 45분 | 2시간 53분 |
| 합계 | 약 19시간 4분 | 약 5시간 9분 |

약 14시간은 장기 agent 대기, timeout, interruption과 이벤트 공백이었다.

2026-09-04에는 다음 장기 실행 실패가 확인됐다.

- `agent-43`: 2시간 timeout 2회
- `agent-65`: 2시간 timeout 2회
- 이후 두 agent 모두 추가 장기 실행이 사용자 interruption으로 끝남

같은 2시간 timeout 방식을 반복한 것은 명백한 운영 실패다.

### 4.2 토큰 사용량

`usageScope=turn` 레코드만 합산했다. session 집계는 중복 가능성이 있어 제외했다.

| 날짜 | inputOther | cache read | output | 합계 |
|---|---:|---:|---:|---:|
| 2026-09-02 | 2,686,533 | 2,641,920 | 18,635 | 5,347,088 |
| 2026-09-03 | 682,095 | 328,960 | 3,155 | 1,014,210 |
| 2026-09-04 | 2,566,430 | 12,665,984 | 20,981 | 15,253,395 |
| 합계 | 5,935,058 | 15,636,864 | 42,771 | 21,614,693 |

비용 필드는 로그에 없으므로 실제 과금액은 계산할 수 없다. cache read를 포함한 총 처리량이 약 2,161만 토큰이었다는 뜻이다.

## 5. Topic 159 production canary 현황

대상은 JWST 차양막 전개 주제다. 이 주제는 프로그램을 실제로 검증하기 위한 canary였으며, 결과물 자체를 수동 완성하는 것이 목적은 아니었다.

현재 DB 및 파일 기준 상태:

- topic ID: `159`
- fact check: `209`, `PASS`, confidence `97`
- production brief: `41`, revision `12`, 현재 `stale`
- script: `26`, `approved`
- latest TTS: `36`, `generated`, 총 `24.06초`
- latest shotlist: `40`, 7 clips, 현재 `stale`
- active jobs: 0
- CLEAN files: 0
- INFO files: 0
- video/edit files: 0
- video jobs: 0
- manifest files: 3
  - `data/projects/topic-159/manifests/IMAGE_SEQUENCE.md`
  - `data/projects/topic-159/manifests/SCRIPT_AI_CACHE.json`
  - `data/projects/topic-159/manifests/SHOTLIST_AI_CACHE.json`
- TTS 파일: `data/audio/topic-159/run-36/full.wav` 및 7개 segment

Topic 159 누적 작업 수:

- fact check: 14회
- production brief: 9회
- script generation: 16회
- shotlist generation: 24회
- TTS generation: 6회
- AI invocation: 127개 기록
- quality run: 68개 기록

`ai_invocations`에는 active job이 없는데도 `running` 상태 레코드 6개가 남아 있었다. 실행 상태와 invocation 계측 상태가 원자적으로 정리되지 않은 orphan record 문제로 취급해야 한다.

### 5.1 마지막에 드러난 세 가지 시각 계약 충돌

1. 첫 장면이 페어링 내부 수납 관계를 단일 공식 정적 프레임으로 증명하도록 요구했다.
2. `약 2m`라는 전개 이동량을 최종 상태 정적 이미지의 치수선으로 표현하도록 만들었다.
3. port에서 starboard로 이어지는 시간 순서를 port-only 공식 중간 사진 없이 정적 이미지로 증명하도록 요구했다.

이 세 항목은 사람이 Topic 159 대본을 직접 고쳐 끝낼 문제가 아니다. 검토 AI가 아래 중 하나를 자동으로 선택해야 하는 시스템 문제다.

- 사실 의미를 유지한 국소 대본 표현 수정
- 제작 설계서의 시각 표현 계약 수정
- 순서 주장을 INFO 또는 내레이션으로만 제한
- 공식 정적 참조가 충분한 다른 주제로 자동 교체

## 6. 구현되어 있고 보존할 가치가 있는 부분

다음 변경은 유지하되 실제 E2E로 다시 검증해야 한다.

### 6.1 계약 및 캐시 결속

- `SCRIPT_CONTRACT_VERSION = 8`
- 대본 cache와 review를 contract hash, candidate hash, review hash에 결속
- 상위 계약이 바뀌면 과거 검수와 실패 지문을 무조건 재사용하지 않음
- shotlist/CLEAN/INFO를 최신 shotlist ID에 결속

관련 위치:

- `server.js`
- `test/dashboard-contract.test.js`
- `test/quality-gates.test.js`

### 6.2 자동 수렴 단계 모델

`lib/pipeline-convergence.js`에 다음 단계 모델이 추가됐다.

```text
script -> tts -> shotlist -> clean -> info -> complete
```

`complete` 이후 `h3Allowed: false`로 종료한다.

현재 이 함수 자체는 단순하고 테스트되지만, 실제 durable run 상태와 결합되지 않아 payload 전달 누락에 취약하다.

### 6.3 TTS 및 장면 수

- 실제 TTS 측정값을 downstream 기준으로 사용
- 4초를 넘는 TTS 행은 국소 수정 대상으로 분류
- 실제 segment가 7개이고 각 segment가 4초 이하라면 7개 장면을 허용
- `ceil(total / 3.4)` 목표값을 hard minimum처럼 사용해 8장을 강제하던 문제를 수정

### 6.4 production canary 보호

- canary와 benchmark 대기를 분리
- NASA 공식 reference allowlist 및 정적 reference preflight
- canary는 CLEAN/INFO까지만 허용
- H3/video enqueue 차단
- 장면표 AI PASS 이후 자동 승인 연결 추가

### 6.5 CLEAN/INFO 생성 연결

- generic `clean_image_generate`를 clip index 없이 enqueue하던 오류 수정
- full CLEAN batch enqueue 경로 사용
- CLEAN master/follow-up job에 `autoConverge`와 `pipeline` 전달
- CLEAN batch가 진행 중일 때 중복 master job 생성을 방지
- 마지막 CLEAN 이후 INFO로 이어지는 successor 구조 추가
- required INFO가 `none`으로 떨어지는 fallback 차단

### 6.6 이미지 QC

- `scripts/media_qc.py`
  - letterbox 검출
  - pillarbox 검출
  - blurred inset 검출
  - small sharp inset 검출
- `scripts/render_official_photo_clean.py`
  - 단순 contain 대신 cover/focus crop
- deterministic INFO renderer가 CLEAN 픽셀을 바꾸는 경우 차단

### 6.7 독립 검토

- 대본, 장면표, CLEAN, INFO에 독립 reviewer/consensus 구조 추가
- INFO 작업을 chunk로 제한하고 일부 검토를 병렬화
- 실패 소유자를 다음과 같이 분류
  - `local_targeted_revision`
  - `fact_contract_revision`
  - `production_contract_revision`
  - `visual_reference_enrichment`

분류는 추가됐지만 분류 결과가 실제 구조화 patch와 자동 재실행으로 안정적으로 이어지지 않는 것이 핵심 미완성이다.

## 7. 핵심 실패 원인

### 7.1 검토 AI가 수렴자가 아니라 차단기로 구현됨

사용자가 원한 것은 문제를 먼저 발견하고 고치는 검토 AI였다. 실제 구현은 issue code, owner와 remediation route를 정교하게 만드는 데 집중했다.

그 결과:

```text
문제 감지
-> 실패 사유 저장
-> needs_reference 또는 needs_revision
-> 파이프라인 중단
```

은 잘하지만 다음 동작이 약하다.

```text
문제 감지
-> 사실을 바꾸지 않는 최소 patch 생성
-> patch 검증
-> 영향받은 하위 단계만 무효화
-> 자동 재개
```

### 7.2 실패 소유자와 실제 patch 사이의 계약이 없음

현재 review 결과는 route를 정할 수 있지만 다음 정보가 durable하게 보장되지 않는다.

- 수정 대상 row/state/field
- 수정 전 hash
- 허용된 사실 claim ID
- 정확한 replacement 값
- 변경하면 안 되는 필드
- patch 적용 후 다시 검증할 invariant
- patch가 실패했을 때 다음 상태

따라서 route가 있어도 전체 생성기를 다시 호출하거나 사람이 문장을 직접 수정하는 방향으로 흐른다.

### 7.3 너무 늦게 발견되는 제작 불가능성

공식 정적 참조로 표현할 수 없는 내부 상태, 시간 순서와 이동량 문제가 장면표 단계까지 내려간 뒤 발견됐다.

주제 선택 직후 다음을 계산해야 한다.

- 핵심 주장 수
- 서로 다른 검증 가능 물리 상태 수
- 각 상태의 실제 정적 reference coverage
- required INFO에 필요한 anchor/baseline/direction 증거
- 예상 TTS segment 수
- 정적 이미지로 표현할 수 없는 temporal claim 수

이 feasibility score가 부족하면 대본 생성 전에 주제를 축소하거나 다른 주제로 교체해야 한다.

### 7.4 사실 근거와 제작 참조를 혼동함

텍스트와 공식 문서는 사실을 입증할 수 있지만, CLEAN 한 장이 모든 시간 순서와 이동량을 직접 증명할 필요는 없다.

세 종류를 분리해야 한다.

1. `factEvidence`: 내레이션 주장이 사실임을 입증
2. `visualReference`: 형상과 상태를 제작할 수 있게 지원
3. `presentationContract`: CLEAN/INFO/시간 흐름 중 어디에서 무엇을 표현할지 지정

현재는 이 셋이 자주 한 계약에 섞여 정적 이미지에 과도한 입증 책임을 준다.

### 7.5 자동 수렴 상태가 durable하지 않음

`autoConverge`와 `pipeline`이 HTTP handler와 job payload를 통해 단계별로 전달된다. 실제로 `/api/topics/script`와 `/api/shotlists/generate`에서 해당 값이 누락돼 후속 단계가 끊겼고 최근에 수정했다.

이 방식은 다음 endpoint가 하나라도 필드를 버리면 다시 끊어진다. 별도의 durable convergence run ID와 DB 상태가 필요하다.

### 7.6 단계별 완료와 전체 완료를 혼동함

DB job의 `completed`는 작업 함수가 종료됐다는 뜻이지 품질 PASS나 다음 단계 진입을 의미하지 않을 수 있다. `needs_revision` 또는 stale 산출물을 저장하고도 job은 completed가 될 수 있다.

반드시 다음 상태를 분리해야 한다.

- execution status
- quality verdict
- artifact freshness
- convergence run status
- terminal reason

### 7.7 재시도 상한이 run 전체에 없음

개별 단계에 retry 제한이 있어도 전체 run이 상위/하위 단계를 왕복하면서 호출 수가 늘어났다. Topic 159에서 fact, brief, script, shotlist 작업이 총 63회 실행됐다.

run 전체에 다음 hard budget이 필요하다.

- 단계별 생성 횟수
- 단계별 reviewer 횟수
- upstream rollback 횟수
- 전체 AI invocation 수
- 전체 wall-clock 시간
- 동일 failure fingerprint 반복 횟수

budget 소진은 단순 실패가 아니라 `terminal_reason`과 다음 자동 행동을 남겨야 한다. 주제 고유 문제라면 다음 후보로 넘어가야 한다.

### 7.8 테스트가 실제 완주를 증명하지 못함

현재 `47/47`은 유용한 회귀 테스트지만 production canary 증거가 아니다.

부족한 테스트:

- mock AI를 사용한 durable E2E state machine 테스트
- process restart 후 같은 convergence run 재개 테스트
- 실제 TTS segment overrun 후 한 행만 수정되는 테스트
- shotlist failure가 구조화 script patch로 이어지는 테스트
- CLEAN 7개 완료 후 INFO가 정확히 한 번 enqueue되는 테스트
- stale brief/shotlist가 있으면 하위 자산 생성을 금지하는 테스트
- terminal `needs_reference` 이후 다음 후보 자동 선택 테스트
- production canary에서 H3/video job이 0개인지 확인하는 테스트

### 7.9 live DB를 개발 루프로 과도하게 사용함

동일 Topic 159에 재시도가 누적돼 상태 해석이 어려워졌다. active job이 0인데 `ai_invocations.running`이 남은 것도 이 문제의 일부다.

개발 단계에서는 isolated DB와 fixture로 state machine을 먼저 검증하고, 마지막 한 번만 live DB production canary를 실행해야 한다.

### 7.10 단일 대형 파일 구조

`server.js`가 약 1.5만 줄 이상 추가된 대형 변경 상태다. orchestration, DB, prompt, review, media와 API handler가 한 파일에 섞여 payload 누락과 상태 불일치를 찾기 어렵다.

기능을 더 추가하기 전에 최소한 다음 경계를 분리해야 한다.

- convergence run/state machine
- repair policy
- artifact invalidation
- job orchestration
- reviewer contracts

대규모 전면 리팩터링은 금지한다. 먼저 E2E 테스트를 만든 뒤 위 경계만 추출한다.

## 8. 반복해서 하면 안 되는 접근

GPT-6는 다음 행동을 피해야 한다.

1. Topic 159의 세 문장을 사람이 직접 수정하고 결과물만 만든 뒤 완료 처리하지 않는다.
2. 같은 입력으로 script 또는 shotlist를 무작정 재생성하지 않는다.
3. 검토 규칙을 느슨하게 만들어 공식 근거 없는 장면을 PASS하지 않는다.
4. `job.status=completed`만 보고 다음 단계가 성공했다고 판단하지 않는다.
5. regex 기반 테스트 추가만으로 자동화가 개선됐다고 판단하지 않는다.
6. live DB에서 수십 회 시행착오를 반복하지 않는다.
7. CLEAN/INFO 실제 파일을 확인하기 전에 성공을 보고하지 않는다.
8. canary에서 H3/video를 실행하지 않는다.
9. 현재 대규모 미커밋 변경을 reset, checkout 또는 overwrite하지 않는다.
10. 30분 이상 걸리는 agent 실행을 체크포인트 없이 방치하지 않는다.

## 9. GPT-6 권장 구현 순서

### P0. 현재 상태 보존과 진단

1. `data/shorts.db`를 별도 백업한다.
2. 현재 작업 트리를 reset하지 않는다.
3. `jobs`, `ai_invocations`, artifact freshness의 불일치를 보고하는 read-only audit 명령을 만든다.
4. orphan `ai_invocations.running`을 식별하되 근거 없이 삭제하지 않는다.
5. Topic 159를 자동화 성공 사례가 아니라 known-failing fixture로 보존한다.

### P1. durable convergence run 도입

별도 테이블 또는 동등한 durable 구조를 추가한다.

권장 필드:

```text
run_id
topic_id
lane
current_stage
run_status
terminal_reason
stage_attempts_json
repair_attempts_json
failure_fingerprint
input_contract_hash
current_artifact_ids_json
ai_invocation_count
started_at
updated_at
completed_at
```

모든 successor는 request payload의 `autoConverge`가 아니라 `run_id`를 기준으로 동작해야 한다.

### P2. 구조화 repair contract 도입

reviewer 출력에 다음 구조를 요구한다.

```json
{
  "verdict": "PASS | REVISE | NEEDS_REFERENCE | REJECT",
  "ownerStage": "fact | brief | script | tts | shotlist | clean | info",
  "failureFingerprint": "stable-code",
  "patch": {
    "targetId": "row/state/clip id",
    "targetField": "field name",
    "beforeHash": "hash",
    "replacement": "new value",
    "preservedClaimRefs": ["C01"],
    "reason": "bounded reason"
  },
  "invalidateFrom": "stage",
  "nextAction": "apply_patch | regenerate_local | select_new_topic | stop"
}
```

patch는 deterministic validator를 통과한 뒤에만 적용한다.

### P3. 단계별 자동 교정 정책 확정

권장 기본 정책:

- fact: 출처 보강 1회, 실패하면 주제 교체
- brief: 동일 claim 범위 국소 수정 1회, reference coverage 부족이면 주제 교체
- script: claim을 추가하지 않는 row 국소 수정 1회
- TTS: 4초 초과 row만 축약 1회
- shotlist: 해당 clip 국소 수정 1회
- shotlist가 상위 시각 계약 문제를 발견하면 구조화 brief/script patch 1회
- CLEAN: 해당 clip 생성/검토 교정 1회
- INFO: 해당 overlay만 교정 1회
- 같은 fingerprint 재발: 재생성 금지, 다음 주제 또는 terminal 상태

### P4. 주제 feasibility gate 추가

대본 전에 아래 조건을 평가한다.

```text
usable official visual references >= required distinct states
unique evidence/state mapping valid
hidden/internal states have section or construction references
required INFO has visible anchors and baseline
expected TTS segments <= producible visual states
static image cannot be solely responsible for proving temporal order
```

실패하면 시스템이 다음 후보를 자동 선택한다. 사용자에게 참조 이미지를 요구하는 것은 사용자가 특정 주제를 반드시 고집한 경우에만 허용한다.

### P5. isolated E2E 먼저 구현

실제 API 호출 전에 mock reviewer와 mock media generator를 이용해 다음 경로를 한 테스트에서 증명한다.

```text
new run
-> script review fails locally
-> structured patch applied once
-> TTS measured
-> shotlist passes
-> CLEAN 7 jobs exactly once
-> INFO 7 jobs exactly once
-> complete
-> H3/video jobs 0
```

별도 실패 fixture도 필요하다.

```text
reference coverage insufficient
-> no repeated generation
-> topic marked terminal
-> next feasible candidate selected
```

### P6. production canary 한 번만 실행

isolated E2E 통과 후 live DB에서 새로운 run ID로 한 번 실행한다.

검증 항목:

- 사용자 입력 없이 끝까지 진행
- CLEAN 7개 실제 파일 존재
- INFO 7개 실제 파일 존재
- required INFO 최소 2개가 실제 non-none overlay
- CLEAN에 텍스트 없음
- INFO가 CLEAN 기반 동일 구도를 보존
- letterbox/pillarbox/blur inset 없음
- 최신 shotlist ID와 모든 QC JSON의 shotlist ID 일치
- active jobs 0
- orphan invocation 0
- H3/video jobs 0
- 대시보드에서 최종 자산 확인 가능

## 10. 수용 기준

프로그램 최적화 완료는 아래 항목을 모두 만족할 때만 선언한다.

### 자동 수렴

- [ ] 대본 검토 실패가 정확한 국소 patch로 이어짐
- [ ] 국소 patch가 사실 claim을 추가하거나 바꾸지 않음
- [ ] 상위 수정 후 영향받은 하위 산출물만 stale 처리됨
- [ ] 동일 failure fingerprint가 무한 반복되지 않음
- [ ] 제작 불가능 주제가 다음 후보로 자동 교체됨

### 실제 산출물

- [ ] 하나의 신규 production canary가 CLEAN까지 완주
- [ ] 같은 canary가 INFO까지 완주
- [ ] CLEAN/INFO 실제 파일 수가 shotlist clip 수와 일치
- [ ] required INFO가 실제 픽셀 overlay로 존재
- [ ] 14개 이미지를 사람이 한 번 최종 시각 검수해 명백한 오류가 없음

### 운영 안정성

- [ ] 서버 재시작 후 같은 run ID로 재개
- [ ] 중복 successor job 없음
- [ ] active job과 invocation 상태가 일치
- [ ] run-level 호출 및 시간 budget 준수
- [ ] canary의 H3/video job이 0

### 검증

- [ ] `node --check server.js`
- [ ] `npm test`
- [ ] `python -m py_compile scripts/media_qc.py scripts/render_official_photo_clean.py`
- [ ] `npm run quality:report`에서 gold misses 0
- [ ] `git diff --check`
- [ ] `/api/health` 정상

## 11. 현재 검증 결과

문서 작성 직전 확인한 결과:

- `node --check server.js`: PASS
- `npm test`: `47/47` PASS
- `npm run quality:report`: gold regression misses `0`
- quality report의 legacy reference gap: `2`
- `/api/health`: 정상
- DB schema version: `11`
- health의 전체 누적 failed jobs: `120`
- health의 active/queued/running jobs: `0/0/0`

`gold misses 0`은 알려진 다섯 fixture의 검출 회귀가 없다는 의미다. production canary 성공을 의미하지 않는다.

## 12. Git 및 작업 트리 주의사항

마지막 commit:

- commit: `cacd44c27ac17b75b52420ee4a17a206d95dd86b`
- date: `2026-08-15T21:36:12+09:00`
- message: `Initial cinematic shorts dashboard`

현재 작업은 대부분 commit되지 않았다.

tracked modified 파일:

- `.gitignore`
- `README.md`
- `dashboard/index.html`
- `docs/FACT_CHECK_GATE_KR.md`
- `docs/PRODUCT_PLAN_KR.md`
- `package-lock.json`
- `package.json`
- `server.js`

그 외 다수 디렉터리와 파일이 untracked 상태다. 현재 tracked diff 통계는 약 19,799 additions / 1,762 deletions다. 이 전체가 최근 3일 작업만을 의미하지는 않는다.

절대 하면 안 되는 것:

- `git reset`
- `git checkout -- ...`
- 대규모 overwrite
- 기존 DB 및 산출물 삭제
- 사용자 확인 없는 commit/push

먼저 현재 diff를 기능 단위로 읽고, 새 변경은 최소 범위로 추가해야 한다.

## 13. 주요 파일 지도

- 서버와 현재 orchestration: `server.js`
- 대시보드: `dashboard/index.html`
- 수렴 단계 모델: `lib/pipeline-convergence.js`
- 품질 게이트: `lib/quality-gates.js`
- dashboard/contract tests: `test/dashboard-contract.test.js`
- convergence tests: `test/pipeline-convergence.test.js`
- media tests: `test/media-pipeline.test.js`
- quality tests: `test/quality-gates.test.js`
- 미디어 QC: `scripts/media_qc.py`
- 공식 이미지 CLEAN renderer: `scripts/render_official_photo_clean.py`
- INFO renderer: `scripts/render_info_overlay.py`
- 품질 보고서: `scripts/quality-eval-report.mjs`
- production canary manifest: `production-canaries/jwst-sunshield.json`
- 최상위 제작 계약: `docs/MD_PIPELINE_SPEC_KR.md`
- 아키텍처: `docs/ARCHITECTURE_KR.md`
- 구현 계획: `docs/IMPLEMENTATION_PLAN_KR.md`
- live DB: `data/shorts.db`

## 14. GPT-6에 전달할 한 문장

검출 규칙을 더 추가하거나 Topic 159를 수동 완성하지 말고, 검토 결과를 구조화 patch와 durable convergence run으로 연결한 뒤 isolated E2E에서 무개입 CLEAN/INFO 완주를 증명하고 마지막에만 production canary를 한 번 실행하라.
