# GPT Image 2.5 도입 및 전체 제작 경로 감사

작성일: 2026-09-09 UTC. 최초 환경 시각 확인: 01:41:59Z. 사용자 요청: 추가 1시간 내 최신 정보 재조사와 전체 문제 파악.

이 문서는 **조사 보고서**이며 구현 완료·실제 GPT Image 2.5 품질 검증·유료 실행 승인이 아니다. 공개 공식 문서를 조회하고 현재 코드 및 이전 실물 실행 증거를 대조한다. 운영 코드/DB/모델 설정 변경, 패키지 설치, 유료 이미지 호출, 외부 이미지 업로드는 이번 감사에서 하지 않는다.

## 1. 현재 확인된 판단

**GPT Image 2.5 Sunburst는 기존의 크롭 불가능 문제를 다른 제작 방식으로 해결할 후보지만, 모델 이름만 바꾸는 수정으로는 현재 파이프라인을 완성할 수 없다.** 생성 품질 개선 가능성과 연결·상태·검수·비용 계측 문제를 분리해야 한다.

- 공식 문서는 Sunburst를 정밀 편집용, Flare를 빠른 범용 생성용으로 안내한다. 참조 이미지를 입력받는 생성/편집과 사용자 지정 세로 해상도를 지원한다.
- 이 프로젝트에서 Sunburst/Flare로 JWST를 생성한 실측 증거는 없다. 따라서 “2.5면 정확히 된다”, “얼마나 좋아졌다”, “몇 분/몇 달러면 완성”이라는 결론은 낼 수 없다.
- Codex 구독 로그인 성공은 OpenAI Image API 권한·잔액·모델 접근을 증명하지 않는다. 현재 감사 프로세스의 `OPENAI_API_KEY`와 `CODEX_API_KEY`는 둘 다 미설정이다. 다른 서비스의 자격 증명 보유 여부는 확인하지 않았으며 비밀 파일도 읽지 않았다.
- 가장 최근 1시간 실행은 정식 run이 `needs_reference`, 정식 등록 이미지 0개였다. 실물 증거는 별도 진단용 NASA 사진 크롭 + 배지 INFO 1쌍의 이미지 첨부 재검수 통과와 TTS 7구간뿐이다. 이것은 참조 기반 AI 이미지 생성이나 자동 제작 종단 완주의 증거가 아니다.

## 2. 최신 공식 정보

출처별 확인 내용은 `tmp/image25-audit-20260909/research-evidence.json`에도 보존했다. 아래 사실은 계정별 실제 API 호출 성공과 구별한다.

### 2.1 모델과 API

- **Sunburst:** `gpt-image-2.5-sunburst`, 날짜 고정 ID `gpt-image-2.5-sunburst-2026-09-08`. 텍스트·이미지 입력, 이미지 출력. 정밀 편집에 우선 검토한다.[R1]
- **Flare:** `gpt-image-2.5-flare`, 날짜 고정 ID `gpt-image-2.5-flare-2026-09-08`. 빠른 범용 생성 후보다.[R2]
- Image API는 `/v1/images/generations`와 `/v1/images/edits`를 제공한다. edits는 여러 참조 이미지로 새 이미지를 만드는 용도에도 쓰이며 현재 문서는 최대 16개 입력을 명시한다.[R3][R4]
- 단일 이미지 작업에는 Image API가 단순하다. Responses API는 대화·다회 편집 기능이 필요할 때 선택하되 상위 언어 모델 비용과 프롬프트 자동 수정도 별도로 기록해야 한다.[R3]
- `quality`는 `low/medium/high/xhigh/max/auto`. 초기 비교는 동일한 명시 quality·size를 쓰고 `auto`와 `max`부터 시작하지 않는 편이 비교와 비용 해석에 유리하다.
- 현재 앱 출력인 **941×1672는 API 입력 size로 그대로 사용할 수 없다.** 두 변 모두 16의 배수여야 한다. 예를 들어 **1008×1792**는 정확한 9:16, 1,806,336픽셀로 문서의 범위 안이다. 생성 원본을 보존하고 필요한 앱용 파생 변환을 별도 기록해야 한다. 이것은 해당 크기로 실제 호출에 성공했다는 뜻이 아니다.[R3][R4]
- mask는 편집 가이드이며 마스크 바깥 픽셀 완전 불변을 보장하지 않는다. 따라서 CLEAN을 그대로 보존해야 하는 INFO 글자·선은 기존 결정론 합성을 유지하는 것이 현재 계약에 맞는다.[R3]
- 가이드는 복잡한 프롬프트에 약 2분이 걸릴 수 있다고 안내한다. 실제 지연 상한/SLA 보장은 아니다. 구조적 배치·텍스트 정밀성·장면 간 일관성에는 한계가 명시돼 있다. 공학적 구조 정확성을 보장하는 모델이라는 공식 근거는 확인하지 못했다. 가려진 부품이나 근거 부족은 생성 모델로 해결됐다고 처리할 수 없다.[R3]

### 2.2 가격과 사용량

Sunburst와 Flare 모두 100만 토큰당 USD 기준:[R5]

| 항목 | 입력 | 캐시 입력 | 출력 |
|---|---:|---:|---:|
| 텍스트 | $5 | $1.25 | 해당 없음 |
| 이미지 | $8 | $2 | $30 |

같은 요금표라도 요청별 토큰 수가 달라 이미지 한 장 가격은 같지 않을 수 있다. 기존 GPT Image 2의 장당 가격표를 2.5에 그대로 적용해서는 안 된다.[R1][R2] 모델 응답 usage로 각 종류의 비캐시·캐시 토큰을 구분해 계산해야 하며, 캐시 토큰을 총 입력에 이중 가산해서는 안 된다.

기존 실험 증거에서 확인되는 요청은 native 31건과 별도 성공 호출 4건이다. 별도 4건만 입력 76,398토큰(그중 캐시 19,456), 출력 5,184토큰이 기록돼 있다. native 31건은 최종 요약에 duration/model/status만 있어 이 숫자로 전체 비용을 계산할 수 없다. 개발 에이전트 사용량과도 별개이며 사용자의 주간 사용량 비율·청구액은 산출하지 않았다.

### 2.3 인증·SDK·자료 전송

- 공식 Codex 인증 문서는 ChatGPT 구독과 Platform API 사용량 과금을 구분한다. 일반 API에는 Platform API key를 사용한다. Codex 로그인 토큰을 Image API용 키처럼 추출·재사용하는 방식을 제안하지 않는다.[R6]
- 설치 의존성은 `@openai/codex`/`@openai/codex-sdk` 0.147.0 계열이다. 공개 npm registry의 SDK latest는 0.153.4였다. 버전 차이만으로 업그레이드가 해결책이거나 최신 Codex의 imagegen이 2.5라고 결론 내릴 수 없다.[R8]
- SDK는 CLI wrapper이며 `local_image`가 실제 이미지 인자로 변환된다. 프롬프트 속 파일 경로 문자열 자체는 첨부를 뜻하지 않는다. `runStreamed` 사용자는 `turn.completed`의 usage를 직접 수집해야 한다.[R7][R9]
- API 입력은 기본적으로 모델 훈련에 사용되지 않지만 기본 abuse monitoring 보관이 존재한다. ZDR은 승인된 계정 설정이지 자동 보장 사항이 아니다. Files API 업로드는 수명 관리가 별도이므로 단발 이미지 요청에 불필요한 파일 업로드 객체를 만들 이유는 없다.[R14]

### 2.4 문서 간 차이와 미확인 항목

모델 카드에는 `Streaming not supported`라고 표시되지만 이미지 가이드/endpoint는 stream·partial_images를 설명한다. 첫 연결은 비스트리밍으로 좁히고, 스트리밍 지원은 별도 실측 확인한다. 모델 카드의 모든 endpoint 명칭을 나열한 텍스트만 보고 모든 endpoint가 지원된다고 판단하지 않는다. 계정의 quota, 실제 모델 접근, 지역별 처리, 실제 응답 shape와 출력 품질은 미확인이다.

## 3. TTS·영상·출처 정책에서 별도로 남는 경계

- VoxCPM2 공식 모델 카드는 한국어 포함 30개 언어, 48kHz, Apache-2.0을 안내한다. 현재 실제 음성 합성은 성공했으므로 이미지 문제 때문에 TTS 모델까지 교체할 근거는 없다. 다만 PCM 길이·무음 검사는 발음 정확성·문장 누락·화자 일관성·청취 품질 검증을 대신하지 않는다.[R10]
- H3 공식 Base와 hosted Context-IR/Regenerate-2K는 같지 않다. 현재 공식 문서는 4–15초/24FPS, FL2VA와 Ref2VA의 별도 checkpoint를 명시한다. 로컬 Base를 전체 hosted 품질과 동등하다고 설명하면 안 된다.[R11]
- H3 Community License는 **대한민국·미국·EU·영국을 Applicable Territory에서 제외**하며 별도 라이선스 문의를 안내한다. 단순히 일정 매출 이상일 때만 필요한 상업 조항으로 축소하면 안 된다. 사용자의 실제 배포 지역·별도 허가 여부를 확인하지 않았으므로 법적 위반을 단정하지 않지만, 해당 지역 운영이라면 영상 도입 전 권한 확인이 필요하다.[R12]
- NASA 자료는 일괄 무조건 자유 이용이 아니다. 제3자 권리·식별 인물·로고·후원 오인 등을 확인해야 한다. 최신 AI 지침은 원자료 출처 공개와 생성 결과의 NASA 귀속을 구별한다. AI로 재구성한 결과는 “NASA 공식 사진”이나 새로운 사실 근거로 등록해서는 안 되며 AI 재구성임을 명시해야 한다.[R13]

## 4. 실제 제작 경로를 따라 확인한 문제

P0/P1은 이번 제작 재개 우선순위이며 보안 취약점 등급이 아니다. 코드상 결함, 로컬 재현, 실제 모델 품질 실패를 구별한다. 아래 위치는 이번 감사 시점 작업 트리 기준이다.

### P0-1. 공식 참조 캐시가 격리 worker에 전달되지 않는다 — 로컬 재현

- import 저장 위치: `server.js:10592`의 `source-cache/production-canaries`.
- staging 기본 복사 범위: `lib/pipeline-staging.js:85`, `:106`의 `audio`와 `projects/topic-*`. `includeSourceCache`는 기본 false다.
- 실제 adapter도 이를 켜거나 개별 source-cache 입력을 전달하지 않는다: `lib/pipeline-provider-adapter.js:73`.
- DB의 파일 경로는 staged 경로로 치환하지만 파일은 없다: `lib/pipeline-staging.js:142`. 이후 실제 참조 binding 검사에서 파일 접근 실패가 발생할 조건이다: `server.js:11946`.

**재현:** `node tmp/image25-audit-20260909/reproduce-staging-cache.mjs`. 실제 `createPipelineStage`, 독립 SQLite fixture, 기존 NASA PNG bytes를 사용했다. 기본값에서는 source-cache 파일 없음 / projects 참조는 있음, includeSourceCache=true 대조군에서는 둘 다 있음을 확인했다. 결과: `staging-reproduction.json`.

**테스트가 놓친 이유:** 기존 native fixture가 참조를 원래 복사 대상인 `projects/topic-*/references`에 놓는다(`test/fixtures/pipeline-native-server-child.mjs:50`). 실제 import 경로를 대표하지 못한다.

**최소 수정:** 작업이 참조하는 원본·decoded 파일만 입력 목록으로 복사·해시 결속하고, 읽기 전용 입력으로 보호한다. 공유 source-cache 전체를 쓰기 승격 대상으로 여는 처방은 피한다. 이번 formal run은 그 이전 geometry gate에서 막혔으므로 이 결함을 그 run의 직접 원인이라고 하지는 않는다.

### P0-2. 이미지 첨부 수정이 repair 경로까지 적용되지 않았다 — 요청 조립 재현

적용된 곳: CLEAN 본검수 `server.js:11794`, INFO 본검수 `:16010`, 최초 layout `:15887`. adjudicator도 같은 reviewer 함수를 사용하므로 해당 첨부를 받는다(`:7673`).

누락된 곳:

- 사용자 INFO 수정: `server.js:15814`.
- 2차 앵커 교정: `server.js:15944`.
- durable label-position patch: `server.js:16425`.
- M5 contact-sheet 검수: `server.js:13407`.

**재현:** `node tmp/image25-audit-20260909/reproduce-vision-boundary.mjs`. 현재 함수 본문을 읽어 provider/DB 경계만 stub했다. 첨부 수는 CLEAN 2, 최초 layout 1, 2차 layout 0, 사용자 수정 0이었다. 이것은 실제 모델 품질 시험이 아니라 요청 조립 동작 증거다. 결과: `vision-boundary-reproduction.json`.

경로 문자열이 있다고 모델이 절대 이미지를 못 봤다고 단정할 수는 없다. 별도 view_image 호출 가능성은 있다. **명시적 픽셀 입력이 보장되지 않는 것**이 확정 결함이다. 필수 reference가 없으면 CLEAN reviewer가 조용히 첨부를 생략하는 점도 검토해야 한다(`server.js:11760`).

**최소 수정:** 모든 시각 작업에서 필수 첨부 목록·역할·순서·파일 hash를 명시하고 누락 시 호출 전 HOLD. 회귀 테스트는 소스에 문자열이 있는지만 볼 것이 아니라 SDK 전달 인자를 포착해야 한다. 현재 추가 테스트는 문자열/정규식 위주다(`test/quality-gates.test.js:15`).

### P0-3. 구버전 검수 PASS가 수정 후에도 살아남는다 — legacy 분기 재현

- legacy CLEAN은 파일 존재 + passed + 동일 shotlist ID이면 reviewer 전에 재사용한다: `server.js:12047`.
- freshness는 shotlist ID 비교다: `server.js:11421`.
- reviewer protocol/첨부 receipt version 검사도 없고 이 CLEAN 분기에는 `force` 검사도 없다.

**재현:** `node tmp/image25-audit-20260909/reproduce-legacy-qc-reuse.mjs`. 현재 실제 함수의 DB/파일 경계를 stub하고 execution context 없는 legacy 경로를 호출했다. `{passed:true, shotlistId:40}`만으로 force=false/true 모두 `reused:true`, reviewer 호출 0이었다. 결과: `legacy-qc-reuse-reproduction.json`.

**범위:** 일반 legacy QC가 durable origin binding을 우회한다는 증거는 아니다. durable는 origin job·manifest·hash를 별도로 검사한다(`server.js:4307`, `:4465`). 다만 정식 바인딩된 이전 검수도 protocol 자체가 snapshot 요소가 아니다(`lib/pipeline-contract.js:5`, `:75`).

**최소 수정:** reviewer 정책 버전·모델·프롬프트 hash·실제 첨부 hash를 QC에 결속한다. 구버전은 삭제하거나 실패로 바꾸지 말고 재검수 필요로 표시한다. 재검수 요청과 이미지 재생성을 분리해야 같은 이미지에 돈을 다시 쓰지 않는다.

### P1-1. 정답을 만들어도 다른 단계 규칙이 거절한다 — canonical presentation 충돌

- VS05 manifest는 **별도의 공식 정지 패널 2개**를 허용한다: `production-canaries/jwst-sunshield.json:86`.
- CLEAN reviewer는 예외 없이 single cover와 split-screen 금지를 요구한다: `server.js:11765`–`:11770`.
- INFO의 sequence는 항상 이전 작업 흔적→현재 작업 지점의 국소 연결로 정의된다: `server.js:15870`. 독립 패널 간 설명 순서와 다르다.
- 위 요청 조립 재현에서 “두 패널 필요”와 “split screens 거절”이 같은 prompt에 들어감을 확인했다.
- refresh의 순서 감지 정규식은 `/포트|스타보드|순차|순서/`이며 “좌현 … 뒤 우현 …”를 놓쳐 INFO none/양쪽 붐 상태로 바꿀 수 있다: `server.js:8683`–`:8699`.

**최소 수정:** canonical presentation 종류를 brief→shotlist→generator→reviewer에 전달해 단일 물리 장면과 독립 설명 패널을 구분한다. 개별 프롬프트 뒤에 예외 문장을 계속 덧붙이거나, 내레이션 키워드로 승인 계약을 변형하는 방식은 중단한다.

### P1-2. 현재 manifest와 저장 brief의 의미 버전이 연결되지 않는다

- ready brief 재사용 조건은 fact ID·ready·코드 contractVersion이고 manifest hash는 없다: `server.js:8763`.
- import는 snapshot/assets를 갱신하지만 해당 함수 안에서 기존 brief/script/shotlist의 종속 invalidation을 하지 않는다: `server.js:10683`.
- 같은 reference ID의 기존 evidence는 그대로 남는다: `server.js:8646`.
- 단일 run 입력은 DB snapshot이며 manifest 파일의 현재 semantic hash를 읽지 않는다: `server.js:4252`, `:17001`.

**정확한 범위:** 같은 reference ID/URL로 INFO/presentation 의미만 변경하면 공통 재검증이 빠지는 경우가 있다. 그러나 durable 작업 중 DB 변경은 input revision fence로 차단된다(`server.js:4615`). batch는 fact/brief/reference feasibility를 검사하고 이미 script가 있는 후보는 초기 단계에서 막는다(`server.js:4530`). 모든 구계약이 모든 경로를 통과한다는 주장은 틀리다.

또한 현재 새 shotlist 생성기는 brief의 required INFO를 이어받는다(`server.js:14315`). 진단에서 오래된 VS07 INFO none을 사용한 잘못을 “지금 생성기가 반드시 none을 만든다”로 일반화해서는 안 된다.

**최소 수정:** import한 manifest 의미 hash를 명시적으로 저장하고, 변경 시 종속 계약을 stale 처리한다. 한 번 재생성한 canonical 계약으로 모든 파생 prompt를 다시 만든다. 승인된 대본을 몰래 바꾸지 않는다.

### P1-3. GPT Image 2.5를 직접 선택하는 생성 adapter가 없다

- 기존 경로는 Codex에게 `$imagegen`을 요청하고 파일 저장을 맡긴다: `server.js:12097`–`:12126`.
- `gpt-5.6-sol/terra/luna` 등은 그 작업을 수행하는 언어 모델 목록이지 이미지 backend 이름이 아니다: `server.js:11704`.
- 공식 crop 선언이 있으면 Python 렌더러로 분기한다: `server.js:12128`.
- durable worker에서는 agentic 이미지 생성이 `staged_clean_requires_deterministic_reference`로 차단된다: `server.js:11710`.

따라서 언어 모델 목록에 `gpt-image-2.5-sunburst`를 넣거나 기존 `$imagegen` 프롬프트에 이름을 쓰는 것만으로 직접 Image API 연결이 되는 것은 아니다. 구독 경로에서 선택 가능한 실제 backend는 별도 확인이 필요하다.

**최소 수정:** 기존 텍스트/검토 Codex와 별도의 작은 이미지 provider adapter. 명시 모델·참조 bytes·요청 파라미터·실제 응답 usage·요청 식별자·attempt 출력 경로를 관리한다. 기존 안전 차단을 제거하고 workspace-write 에이전트를 정식 worker에 풀어놓는 수정은 하지 않는다.

### P1-4. 새 provider가 있어도 기존 crop preflight에서 먼저 막힐 수 있다

- single run 초기 검사: `server.js:4483`; batch도 구조 검사 후 같은 geometry 검사: `:4495`.
- crop/panelSequence 필드 유무가 direct 판정 기준이다: `server.js:11934`.
- direct state는 렌더 preflight 대상이며 실패하면 needs_reference: `server.js:11959`, `lib/pipeline-feasibility.js:86`.

**기존 crop 선언을 유지한 채 최종 생성 함수만 교체하면**, 불가능한 세로 crop이 새 모델 호출 이전에 차단된다. crop 선언이 없는 모든 입력까지 차단된다는 뜻은 아니다.

**최소 수정:** `official_direct_crop`과 `ai_reference_reconstruction`에 해당하는 명시 제작 모드를 구분한다. 전자는 검증된 crop geometry, 후자는 원자료 범위·필수 구조·허용 재구성·실제 생성물 비교를 검증한다. crop 필드 삭제나 전역 gate 완화로 우회해서는 안 된다. 생성물은 출처 원본과 별도 lineage로 관리한다.

### P1-5. 실제 토큰·비용 계측이 빠져 있다

- ledger와 API budget은 호출 수·시도 수·시간 중심이다: `lib/pipeline-store.js:244`, `server.js:16943`.
- `ai_invocations.usage_json` 컬럼은 있으나 현재 INSERT/finish UPDATE가 이를 기록하지 않는다: `server.js:754`, `:3933`, `:3961`.
- 공통 `runCodexJson` 스트림은 `turn.completed.usage`를 저장하지 않는다: `server.js:4011`.
- worker의 예약 IPC도 task/model/hash 입력을 보존하지 않고 requestId/status 위주로 보낸다: `lib/pipeline-provider-worker.mjs:50`, `lib/pipeline-provider-adapter.js:21`.
- 진단 호출은 정식 execution context 밖에서 실행하면 run/batch 예약과 분리된다: `server.js:3924`.

**판정:** 호출 폭증은 제한하지만 비용 상한은 보장하지 않는다. 과거 모든 외부 로그에 usage가 없다는 뜻은 아니다. TTS batch 호출 1건과 segment 합성 7회도 같은 단위가 아니다.

**최소 수정:** 공통 provider 경계에서 모델·실사용량·실패/결과불명확·단위를 기록하고 진단도 같은 실험 한도에 묶는다. API 응답 유실 시 이미 과금됐을 수 있으므로 새 요청을 자동 중복 발행하지 않는다. 로컬 취소가 원격 생성 취소/환불을 뜻하지 않는 점도 표시한다.

### P1-6. verified reference와 semantic PASS가 혼용될 위험

공식 asset verification은 출처·파일 signature·decode·hash 검사다(`server.js:10567`). manifest 설명을 `visibleFacts`로 넣기도 한다(`:8654`). 이것만으로 모든 부품이 실제 픽셀에 보인다는 뜻은 아니다. geometry preflight도 geometry only다.

**최소 수정:** 다운로드/권리·바이트 결속, 기하 적합성, 의미 가시성, 생성물 품질을 구분한다. 새 모델 출력이 그럴듯하다는 이유로 새 근거를 생성한 것으로 인정하지 않는다.

### P2. TTS·운영 UI·M5의 실제 수용 범위

- 실제 진단 TTS 17.76초는 청취 미검수다. 정식 경로는 reference voice와 master 간격을 요구한다(`server.js:14124`, `:14158`). 진단 합성 성공은 그 전체 경로의 완료 증거가 아니다.
- durable enable은 tmp 격리 경로와 background/remediation disable 조건에 묶인다(`lib/pipeline-bootstrap.js:16`). staged provider도 opt-in이다(`server.js:4621`). 운영에 바로 켜도 된다는 상태가 아니다.
- UI는 run 시작/취소·상태·승인을 구분하지만 batch 후보 구성 UI까지 있는 것은 아니다(`dashboard/index.html:5630`, `:5686`).
- M5는 별도 승인·실제 영상 재생·편집 인계 검증이 필요하다. 이미지 모델 교체로 해결되는 범위가 아니다. 이번 감사에서 영상 생성·OpenShot 실행은 하지 않았다.

### P1. 보존·Git 경계도 최신 작업을 반영해야 한다

- 이번 확인의 로컬 HEAD는 `2bbbf00`(재구축 계획)이다. 새 durable 모듈·테스트 다수는 아직 untracked이며 기존 소스 변경도 미커밋 상태다. 초기 snapshot push 기록을 지금 작업까지 Git에 보존됐다는 뜻으로 읽으면 안 된다. 이번 감사에서는 원격 최신 상태를 별도로 조회하거나 commit/push하지 않았다.
- `models/voxcpm2/model.safetensors`는 실제 4,580,080,592 bytes이며 **Git ignore 대상이 아니다**. `.gitignore:1`–`:27`에 models 배제 규칙이 없고 `git check-ignore`로도 확인했다. 전체 필수 모델은 이전 다운로드 기록상 약 4.96GB다.
- 다음 백업/커밋 전에 모델 weight와 재현용 metadata의 보존 정책을 구분해야 한다. 무심코 `git add .`를 실행하면 거대 바이너리를 포함할 수 있다. 모델을 삭제하거나 이번 감사에서 ignore 규칙을 임의 변경하지 않았다.

## 5. 왜 수정이 계속됐는데 완성이 안 됐나

1. **실제로 필요한 생성 기능보다 제어·차단 체계를 먼저 확장했다.** queue/lease/hash 검증은 가치가 있지만 deterministic crop만 가능한 경로로 불가능한 구도를 해결할 수는 없다.
2. **테스트 입력이 운영 입력을 대표하지 못했다.** 참조 파일을 다른 폴더에 둔 native fixture가 대표 사례다. 많은 PASS가 해당 운영 경로의 완주 증거로 이어지지 않았다.
3. **수정된 계약과 오래된 파생 문장을 섞었다.** 생성과 검수가 서로 다른 정답을 요구했다. 이 경우 모델을 반복 호출해도 실패가 재생산된다.
4. **검수자의 실제 입력과 구검수 유효기간을 충분히 관리하지 않았다.** 일부 첨부 수정 후에도 repair와 이전 PASS가 남았다.
5. **정식 실행이 막힌 뒤 진단 호출을 늘렸지만 비용 계측·산출물 수용 조건은 연결되지 않았다.** 한 장면 1쌍 진단 성공을 제품 완성의 진척처럼 표현한 것도 잘못이다.

기존 테스트가 전부 쓸모없다는 결론도 틀리다. lease/CAS/취소/부분 무효화/출력 hash/결정론 INFO 합성은 보존할 가치가 있다. 다만 이들은 실제 생성 품질과 전체 자동화 수용의 충분조건이 아니다.

## 6. 2.5가 바꾸는 것 / 바꾸지 못하는 것

| 문제 | 2.5 도입 판단 |
|---|---|
| 가로 원자료를 자르기만 해 필수 구조가 사라짐 | 참조 기반 세로 재구성으로 개선 가능. 실제 시험 필요 |
| 참조를 보존하면서 국소 구도·재질 수정 | Sunburst의 공식 주력 용도와 맞음. 구조 보존은 별도 검증 |
| 여러 장면의 일관된 외형 | 개선 후보지만 일관성 보장 없음 |
| 가려진 부품·근거 없는 수치/운동 | 해결 불가. 생성으로 증명할 수 없음 |
| staging 참조 누락·인증/API 미연결 | 해결 안 됨. 코드/환경 경계 수정 필요 |
| two-panel 금지 충돌·구계약 재사용 | 해결 안 됨. canonical 계약 일치 필요 |
| 미첨부 검수·구 PASS 재사용 | 해결 안 됨. 검수 입력/버전 결속 필요 |
| 실제 사용량·달러 예산 미기록 | 해결 안 됨. provider 계측 필요 |
| INFO의 글꼴·정확한 라벨·CLEAN 픽셀 불변 | 기존 PIL 합성 유지 권장. 이미지 모델로 바꿀 이유 부족 |
| TTS 청취 품질·H3 라이선스/영상 완주 | 별도 문제 |

## 7. 다음 실행 판단 — 재구축부터 다시 시작하지 않는다

**추천 결정: Sunburst 소규모 도입 시험은 진행 가치 있음 / 즉시 전면 교체는 보류 / 현 앱 완성 판정은 불가.**

### A. 모델 자체의 가치를 먼저 분리해서 판정

이 실험은 위 인프라를 전부 고친 뒤에야 할 수 있는 일이 아니다. 승인을 받은 Image API 자격 증명과 공개 참조만으로, 운영 DB를 거치지 않는 좁은 호출 경계에서 비교할 수 있다. 반대로 이 실험 PASS를 정식 pipeline PASS로 보고해서도 안 된다.

- 비교 대상: VS02 팔레트 전개 / VS06 다섯 층 분리처럼 기존 crop이 실제로 실패한 두 장면. 현재 manifest의 필수 구조와 금지사항을 그대로 고정한다.
- 입력: 동일 공식 참조 bytes, 동일 명시 제작 계약, `n=1`, 1008×1792, 같은 quality. 결과는 AI 재구성으로 표시하며 공식 원본과 구분한다.
- 후보: Sunburst와 Flare 각각 장면당 최초 1장. **최초 4장, 필요한 경우 결과당 국소 교정 1회까지 총 8회 생성 이하**를 제안한다. 이는 후속 실험 제안이지 이번 사용자가 이미 승인한 과금 한도가 아니다. 실제 달러 한도도 실행 전에 별도로 정해야 한다.
- 검수: 원본과 결과 pixels를 함께 첨부. 필수 부품·층수·가려짐·추가 구조·물리 상태·세로 구도·인접 장면 identity를 비교한다. 모델명을 가린 결과 비교와 사용자의 시각 판단을 포함한다. 단순 자기점수 0.9는 수용 근거가 아니다.
- 비용 절약: 첫 판정 1회, 명확한 수정만 1회. 판정 충돌 때만 추가 검토한다. 원본만으로 판별할 수 없는 구조는 추정 대신 미검증으로 남긴다. 같은 모델의 다른 role 두 번은 통계적으로 독립된 전문가 두 명이 아니다(`server.js:7644`).
- 기록: 실제 model ID, 요청 파라미터, prompt hash, 참조 hash, 생성 hash, request ID, usage, 지연, 실패·수정·재검수 결과. 크롭 기준선은 기존 산출물을 사용해 재생성 비용을 쓰지 않는다.
- 중단 기준: 401/403/권한/한도 문제는 모델 변경으로 반복하지 않는다. 동일 구조 실패가 교정 후 남으면 그 입력·모델 조합을 실패로 기록한다. 새 주제나 새로운 “진단 run”으로 같은 실험 예산을 초기화하지 않는다.

### B. 품질 가치가 확인된 후 운영 경로의 최소 결함만 수정

1. staging에 작업별 reference 입력을 정확히 포함한다. 운영형 cache 경로 fixture로 검증한다.
2. 모든 시각 consumer에 첨부와 review protocol을 연결하고 구 PASS의 재검수 필요를 표시한다.
3. canonical presentation 및 manifest revision을 brief/shotlist/검수 전체에 결속한다. VS05/VS03/VS07 회귀를 먼저 확인한다.
4. 명시 제작 모드와 Image API adapter를 기존 attempt staging/lease/취소/승격 경계에 연결하고 usage를 보존한다. 임의 쓰기 가능 에이전트로 대체하지 않는다.
5. 그 뒤 **정식 run 하나**로 실제 CLEAN/INFO 7쌍·필수 INFO 2개·국소 수정·최종 대시보드 검수 대기까지 수행한다. JWST의 7쌍 조건을 다른 모든 주제에 강제하지 않는다(`docs/REBUILD_PLAN_2026-09-05_KR.md:178`).

A에서 실패하면 B를 크게 확장하지 않는다. A의 성공 여부가 확인되기 전 완성 소요시간은 신뢰성 있게 산정할 수 없다. 모델/API 권한 및 실제 품질이 확인되지 않은 상태에서 다시 “한 시간 완성”을 약속해서는 안 된다.

## 8. 감사 증거와 한계

- 공식 자료: 위 JSON의 R1–R14. 모델 기능/가격은 공개 문서 확인이며 실제 계정 접근 시험이 아니다.
- 코드 조사: 생성·참조·brief/shotlist·검수/repair·staging·예산/IPC·TTS·UI/M5 연결을 읽고 핵심 결론을 재확인했다.
- 로컬 재현 3종: `staging-reproduction.json`, `vision-boundary-reproduction.json`, `legacy-qc-reuse-reproduction.json` 및 각각의 실행 스크립트. 모두 `tmp/image25-audit-20260909/` 아래에 있다.
- 운영 DB SHA256은 감사 중 `e0c2f3d9344a340d946cf009383eb6a77c5d6a852b82514111cd7d3707bab5b9`로 이전 기록과 같았다. 실제 canonical CLEAN/INFO 파일 hash도 기존 증거와 일치했다.
- 이번 감사에서는 전체 regression suite를 반복하지 않았다. 기존 PASS 수를 새 결론의 근거로 사용하지 않았다. scratch fixture 재현은 모델 품질 증거가 아니다.
- 미확인: 계정별 Sunburst/Flare 접근·실사용 비용·공학 이미지 품질, 모든 과거 호출의 총비용, 실제 한국어 청취 품질, 운영 배포와 H3 사용 권한/영상 완주. 유료 호출 없이 확인할 수 없는 범위를 확정 사실처럼 쓰지 않았다.

## 공식 출처

- [R1] https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
- [R2] https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
- [R3] https://developers.openai.com/api/docs/guides/image-generation
- [R4] https://developers.openai.com/api/reference/resources/images/methods/edit
- [R5] https://developers.openai.com/api/docs/pricing
- [R6] https://developers.openai.com/codex/auth
- [R7] https://developers.openai.com/codex/noninteractive
- [R8] https://registry.npmjs.org/@openai%2Fcodex-sdk/latest
- [R9] https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/thread.ts
- [R10] https://huggingface.co/openbmb/VoxCPM2/raw/main/README.md
- [R11] https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/README.md
- [R12] https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/LICENSE
- [R13] https://www.nasa.gov/nasa-brand-center/images-and-media/
- [R14] https://developers.openai.com/api/docs/guides/your-data
