# ADR 0002. Claude Code CLI 비대화형 호출 구성

- 상태: 채택 (Phase 0 검증)
- 날짜: 2026-10-17
- 검증 환경: Windows 11 Home, Claude Code 2.1.291, `claude auth status` → `authMethod: claude.ai`, 구독 Pro, `ANTHROPIC_API_KEY` 미설정

## 결정

분석 에이전트는 다음 인자 배열로 CLI를 실행한다. 회의 원문은 stdin으로만 전달한다. 작업 폴더는 `PathResolver`가 만든 앱 전용 빈 폴더(`analysis/jobs/<job_uuid>/`)다.

```text
claude -p <고정 지시문>
  --output-format json
  --json-schema <analysisResultV1Schema에서 $schema·$id를 뺀 JSON>
  --tools ""
  --restricted
  --safe-mode
  --strict-mcp-config
  --permission-prompts none
  --no-session-persistence
```

| 플래그 | 목적 |
|---|---|
| `--tools ""` | 내장 도구 전부 제거 |
| `--restricted` | 코드 실행 도구·WebFetch 제거, user/project/local 설정 무시, 파일 도구를 작업 폴더로 제한, bypassPermissions 거부 |
| `--safe-mode` | CLAUDE.md, skills, plugins, hooks, MCP, custom commands·agents 비활성화 |
| `--strict-mcp-config` | `--mcp-config`가 없으므로 MCP 서버 0개 |
| `--permission-prompts none` | 권한 요청이 생기면 자동 거부 (대기 상태로 멈추지 않음) |
| `--no-session-persistence` | 회의 원문이 담긴 세션 기록을 디스크에 남기지 않음 |

금지: `--bare`(구독 인증을 읽지 않음), `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions`.

## 확인한 사실 (2026-10-17 실제 실행)

1. stdin + `--output-format json`은 단일 JSON envelope를 stdout에 쓴다. 주요 필드: `type:"result"`, `subtype:"success"`, `is_error`, `api_error_status`, `num_turns`, `result`(문자열), `structured_output`(`--json-schema` 사용 시 객체), `permission_denials`(배열), `terminal_reason`, `stop_reason`, `session_id`, `usage`, `modelUsage`, `total_cost_usd`.
2. `--json-schema`를 주면 `structured_output`에 schema를 만족하는 객체가 오고 `num_turns`가 2가 된다.
3. **CLI는 draft 2020-12 `$schema`를 거부한다.** `--json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`, exit 1. 에이전트는 계약 schema에서 `$schema`·`$id`를 제거한 사본을 넘긴다. `format: "date"`, `const`, `type: [..., "null"]`은 통과했다.
4. **빈 `--json-schema ""`를 넘기면 오류 없이 무시된다.** exit 0, `subtype:"success"`, `structured_output` 없음, `result`는 임의 형식 텍스트였다. 따라서 성공 판정은 exit code나 `subtype`이 아니라 `structured_output` 존재와 에이전트 측 schema 재검증으로 한다.
5. 위 구성에서 "사용 가능한 도구를 나열하라"는 지시에 `NO_TOOLS`를 답했다. 본문에 Bash·Write·설정 파일 읽기 지시를 삽입한 시험(A07)에서 작업 폴더에 파일이 생기지 않았고 `permission_denials`는 비어 있었다(도구 호출 시도 자체가 없었다).
6. 부모 Claude Code 세션 안에서 실행할 때는 `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` 환경변수를 제거했다. 앱이 독립 실행할 때는 해당 없음.

## 미검증·남은 위험

- 도구를 허용한 대조군 실행으로 "차단이 없으면 실제로 실행된다"를 비교하지 않았다(개발 세션의 자동 권한 분류기가 차단). `--tools ""` 하에서 도구 목록이 비어 있음만 확인했다.
- managed(정책) 설정과 `--settings`는 `--restricted`·`--safe-mode`에서도 적용된다. 앱은 `--settings`를 넘기지 않는다.
- CLI 자동 업데이트 후 플래그가 바뀔 수 있다. 에이전트는 시작 시 `claude --version`과 `claude --help`에서 위 플래그 존재를 확인하고, 하나라도 없으면 자동 분석을 중지한다(설계서 13장).
- 구독 한도 초과·로그인 만료 시 envelope 형식(`is_error`, `api_error_status` 값)은 아직 관찰하지 못했다. 관찰 전까지 `is_error: true`는 `retry_wait`, `claude auth status`의 `loggedIn: false`는 `auth_required`로 분류한다.
- 구독 플랜의 자동 실행 허용 범위(약관)는 사람이 확인해야 한다. 로드맵 미확정 항목으로 유지한다.
- 모델 선택: 기본값(실행 시 Opus 계열 + 보조 Haiku)을 썼다. 비용·속도에 따라 `--model`을 고정할지는 Phase 3에서 정한다.
