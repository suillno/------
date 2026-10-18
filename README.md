# 회의 어시스턴트 (MeetingAssistant)

Windows 앱과 모바일 웹에서 회의록을 조회·수정하고 클라우드로 동기화합니다. Windows PC의 Claude Code CLI가 일정 후보를 분석하고, 사용자가 승인한 일정만 Google Calendar에 등록합니다.

> 현재 상태: 저장소 뼈대와 실행 가능한 템플릿만 있습니다. 기능은 [docs/roadmap.md](docs/roadmap.md) 순서대로 구현합니다.

## 사전 요구사항

| 도구 | 용도 |
|---|---|
| Node.js 22.12 이상 | 웹·데스크톱 프런트엔드, Supabase CLI |
| Rust (rustup, MSVC 툴체인) + Visual Studio Build Tools(C++) | Tauri 데스크톱 빌드 |
| WebView2 Runtime | Tauri 실행 (Windows 11은 기본 포함) |
| Docker Desktop | 로컬 Supabase (`npm run db:start`) |
| Claude Code CLI (구독 로그인) | PC 분석 에이전트 (Phase 3) |

## 시작하기

```sh
npm install
cp .env.example .env.local   # 값 채우기 (docs/configuration.md)
npm run dev:web              # http://localhost:5173
npm run dev:desktop          # Tauri 창
```

## 문서

- [docs/design.md](docs/design.md): 설계서 v2.2
- [docs/roadmap.md](docs/roadmap.md): 단계별 작업과 미확정 결정
- [docs/file-map.md](docs/file-map.md): 폴더·파일 책임
- [docs/configuration.md](docs/configuration.md): 환경변수·로컬 경로
- [docs/api.md](docs/api.md): API 계약
- [docs/operations.md](docs/operations.md): 배포·백업·복구
- [AGENTS.md](AGENTS.md): 개발 규칙·명령
