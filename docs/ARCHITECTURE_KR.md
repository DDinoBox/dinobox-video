# Cinematic Shorts OS 아키텍처

## 원본 MD 제작 계약

`docs/MD_PIPELINE_SPEC_KR.md`가 미디어 제작 순서와 승인 게이트의 최상위 계약이다. 공학 프로젝트는 `domains/engineering.yaml`을 사용하며, 주장 원장, 공학 대본 4요소, 물리 상태 기반 장면표, CLEAN, 동일 구도 INFO, CLEAN 기반 4초 영상과 INFO 후처리 순서를 건너뛸 수 없다.

이미지 검수는 `asset_reviews`에 CLEAN과 INFO를 별도로 저장한다. 대표 벤치마크는 독립 AI 검수를 통과한 `AI_PASS` 자산으로 다음 샘플 단계까지 진행할 수 있고, 전체 제작은 사용자가 `OK`로 최종 승인해야 잠금이 풀린다. H3에는 CLEAN을 첫 프레임으로 전달하고, 승인 INFO의 가이드와 라벨 레이어는 FFmpeg가 생성 영상 위에 단계적으로 합성한다.

기준일: 2026-08-29

## 구성

```text
Browser dashboard
  -> Local Node HTTP API
      -> SQLite: 상태, 작업, 승인, 산출물 메타데이터
      -> Codex SDK: 사실 검증, 대본
      -> VoxCPM2 worker: TTS
      -> File workspace: WAV, PNG, MP4, manifest
      -> ComfyUI: MiniMax H3 영상
      -> FFmpeg / ffprobe: 조립과 미디어 검사
```

## 실행 모델

짧은 조회와 승인 저장은 일반 HTTP 요청으로 처리한다. 수초 이상 걸릴 수 있는 검증, 대본, TTS, 이미지와 영상 생성은 작업으로 등록한다.

작업 상태:

```text
queued -> running -> completed
                  -> failed
                  -> canceled
```

`jobs`는 현재 상태를, `job_events`는 시간순 진행 이력을 저장한다. 브라우저는 Server-Sent Events로 새 이벤트를 받고, 연결이 끊기면 마지막 이벤트 ID 다음부터 다시 받는다.

## SQLite 정책

- `foreign_keys = ON`
- `busy_timeout = 5000`
- 현재 Node 내장 SQLite가 3.50.4이므로 다중 writer WAL은 사용하지 않는다.
- DB 쓰기는 로컬 Node 프로세스의 동기 연결 하나로 직렬화한다.
- Node가 SQLite 3.50.7 이상 또는 3.51.3 이상을 포함하는 버전으로 올라간 뒤 WAL 전환을 다시 검토한다.
- 스키마 변경은 `schema_migrations`에 버전을 기록한다.

## AI 실행

Codex TypeScript SDK의 구조화 출력과 스트리밍 이벤트를 사용한다. 사실 검증과 대본은 JSON Schema를 통과한 결과만 저장한다. 작업 취소 시 AbortSignal로 현재 Codex turn을 중단한다. `evidence_packets`는 사실 검증의 주장·시각 근거·출처 스냅샷과 계약 hash를 append-only로 보존하고, 제작 설계서는 이 패킷의 결정론 preflight 뒤 blind 독립 검토를 통과해야 한다. `ai_invocations`는 모델 시도별 prompt/schema/input hash, 결과·실패·지연 시간과 fallback 횟수만 계측한다.

동시에 실행할 Codex 작업 수는 `AI_WORKER_CONCURRENCY`로 1~3 사이에서 조정한다. 사실 검증 내부의 2차 실행은 임의 재시도가 아니라 HOLD 후보의 독립 출처 보강 단계다.

## 품질 루프

사실 검증 PASS에는 주장 근거뿐 아니라 제작 가능한 `visualEvidence`가 최소 2개 필요하다. 각 상태는 실제 형상, 지지·접촉, 운동 또는 유동과 출처 URL을 함께 저장한다. 재검증에서 의미가 같은 주장은 claim ID를 유지하며, 대본이 쓰는 주장 의미가 바뀌지 않고 시각 근거만 보강된 경우 대본과 TTS는 유지하고 제작 설계서와 장면표만 만료한다.

대본, 장면표, CLEAN, INFO, H3 영상은 모두 같은 합의 엔진을 사용한다. 각 생성 결과는 먼저 결정론 계약 검사와 근거·물리·시청각 제작성을 함께 보는 통합 검수자 1회의 판정을 받는다. 명확한 통과 또는 구체적인 실패는 그 판정을 저장하고 종료한다. 점수가 경계 구간이거나 실패인데 지적 항목이 비어 있을 때만 전문 제작 검수자를 추가하고, 두 판정이 엇갈릴 때만 제3 판정을 실행한다. 영상은 MP4 접촉 시트와 CLEAN·INFO 기준 이미지를 함께 비교해 동작, 물리 방향, 동일성, 연속성과 반복 화면을 검수한다. 자동 재생성은 기본적으로 하지 않는다. 실패 산출물과 지문을 보존한 뒤 다섯 벤치마크를 한 번씩 비교하고, 여러 주제에서 반복된 실패만 공유 계약에 반영한다.

장면표 검수 실패는 작업 자체를 폐기하지 않는다. `needs_revision` 장면표로 저장해 대시보드에서 장면과 판정 이유를 확인할 수 있지만 승인과 하위 이미지 생성은 차단한다. 이 상태는 다음 벤치마크 검증을 막지 않는다.

검증된 근거가 지탱하는 물리 상태 수보다 대본 행과 길이가 많으면 반복으로 판정하고, 카메라 거리·각도·날씨·표면 묘사만 다른 행은 병합하거나 삭제한다. 하위 장면표에서 `insufficient_visual_depth`가 발생하면 그 실패 지문을 다음 대본 생성 계약에 포함한다. 추가 공식 시각 근거가 없으면 문제가 된 구간만 압축하고 필수 인과는 유지한다.

장면 수는 고정 최소값을 사용하지 않는다. 최소 수량은 `ceil(실제 TTS 길이 / 4초)`, 기본 목표는 `ceil(실제 TTS 길이 / 3.4초)`다. 장면 초안과 교정은 TTS 한 구간씩 최대 2개 worker로 처리하고, 완성본은 전체 편집 순서로 독립 검수한다. 완료된 묶음은 디스크에 저장하며 실패한 묶음만 이어서 처리한다.

제작 설계서, 대본, TTS, 사실 근거는 각각 계약 버전과 해시를 가진다. 캐시와 같은 주제의 과거 실패 이력은 현재 상위 계약 해시가 일치할 때만 재사용한다. 내레이션이 미래 상태를 예고할 때는 내레이션 claim과 현재 화면의 직접 claim을 분리한다.

CLEAN은 한 카메라에서 본 한 물리 상태다. 분할 화면, 콜라주, 평면도, 입면도, 기술 도식, 개념 단면과 전후 동시 표시는 CLEAN 필수 요소에 넣지 않는다. 외부 숏에서 수중·강바닥·내부 부품을 필수 가시 요소로 요구하는 제작 설계서도 차단한다. INFO는 첫 TTS 구간에서 사용하지 않고, 같은 TTS 구간에는 최대 하나만 남긴다. 세 개 이상의 독립 입력을 라벨 두 개짜리 한 오버레이에 합치지 않는다.

## GPU 실행

VoxCPM2와 MiniMax H3는 같은 GPU를 동시에 사용하지 않는다. H3 영상은 한 번에 한 클립씩 생성한다. CPU 자료 준비와 DB 조회는 GPU 작업과 병행할 수 있다.

## 산출물 무효화

```text
사실 재검증 -> 사용 주장 의미 변경 시 대본, TTS, 장면표 stale
사실 재검증 -> 시각 근거만 변경 시 제작 설계서, 장면표 stale
대본 재생성 -> TTS, 장면표 stale
TTS 재생성 -> 장면표 stale
CLEAN 교체 -> 해당 INFO 교체 필요, 해당 장면의 영상 stale
INFO 교체 -> 해당 장면의 영상 stale
영상 프롬프트 변경 -> 해당 장면의 영상 stale
```

파일은 즉시 삭제하지 않는다. 활성 버전과 stale 버전을 구분해 복구와 비교가 가능해야 한다.

CLEAN과 INFO의 자동 QC에는 생성 기준 `shotlistId`를 기록한다. 최신 장면표 ID와 다르거나 ID가 없는 기존 자산은 `REPLACE_CANDIDATE`로 표시하고 승인·INFO 생성·영상 생성에서 제외한다. 파일명이 우연히 같아도 다른 장면표의 자산을 재사용하지 않는다.

## 아직 남은 구조 변경

현재 `server.js`와 `dashboard/index.html`은 기능이 집중된 상태다. 동작을 작업 큐로 안정화한 뒤 다음 경계로 분리한다.

```text
server/db
server/jobs
server/topics
server/fact-check
server/scripts
server/tts
server/media
dashboard/workflow
dashboard/studio
dashboard/workbench
dashboard/jobs
```

분리는 동작 변경과 동시에 하지 않고 회귀 테스트가 생긴 뒤 순차 수행한다.
