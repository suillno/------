# meeting-analysis prompt v2 (2026-10-19)

v1과의 차이: stdin의 `user_instructions`(사용자 추가 요청사항)를 원문과 분리해 받고, 일정 후보에 `location`·`location_uncertain`(schema v2)을 채운다.
출력 schema 원본: `packages/contracts/src/analysis.ts`(`analysisResultV2Schema`). Rust 에이전트가 `include_str!`로 포함한다(`apps/desktop/src-tauri/src/agent/cli.rs`).
