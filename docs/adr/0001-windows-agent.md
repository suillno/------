# ADR 0001: Windows 에이전트를 Rust로 구현

- 날짜: 2026-10-17
- 상태: 채택

## 배경

설계서 3장은 기존 Python/FastAPI 코드가 있고 재사용할 가치가 있으면 Python 에이전트를, 그렇지 않으면 Rust 에이전트를 쓰도록 한다.

## 확인한 사실

- 저장소 초기화 시점에 이 폴더에는 설계서(`claude.md`) 하나만 있었다. FastAPI/Python 코드, SQLite 파일, 기존 설계서 원문은 없었다.
- 다른 위치에 기존 코드가 있는지는 확인하지 않았다. 사용자가 Rust 신규 구현을 선택했다.

## 결정

Tauri 2 앱(`apps/desktop/src-tauri`) 안의 Rust 모듈 `agent/`가 동기화와 분석을 담당한다. `agents/windows-python/`은 만들지 않는다.

## 결과

- sidecar 패키징, loopback FastAPI, Python 런타임 배포가 필요 없다.
- 동기화·충돌 규칙은 TypeScript(`packages/client-core`, 모바일)와 Rust(PC)에 따로 구현해야 한다. 규칙이 서로 어긋나지 않도록 `packages/contracts`의 계약과 공통 테스트 fixture로 검증한다.
- 나중에 기존 Python 코드가 발견되면 분석 프롬프트와 검증 로직만 참고하고, 이 ADR을 대체하는 새 ADR 없이는 경로를 바꾸지 않는다.
