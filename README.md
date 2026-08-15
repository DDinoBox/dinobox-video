# Cinematic Shorts Dashboard

로컬에서 시네마틱 쇼츠 제작 흐름을 관리하는 개인용 대시보드입니다.

## 실행

```bash
npm install
npm start
```

대시보드는 기본적으로 아래 주소에서 열립니다.

```text
http://localhost:5174
```

## 현재 기능

- 메인 주제 / 세부 주제 기반 쇼츠 후보 탐색
- SQLite 기반 후보, 검증 결과, 대본, TTS 계획 저장
- Codex CLI를 이용한 사실 검증 및 대본 생성
- 검증 PASS/HOLD/REJECT 게이트
- TTS 목소리 프리셋과 장면별 TTS 세그먼트 준비
- 로컬 GPU, ffmpeg, ffprobe, Docker 상태 확인

## 생성 데이터

`data/`, `projects/`, `node_modules/`는 로컬 생성물이라 Git에 올리지 않습니다.
