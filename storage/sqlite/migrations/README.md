# SQLite 캐시 마이그레이션

PC 캐시 전용 (`server_snapshot`, `local_draft`, `outbox`, `sync_state`, `conflicts`). 파일명: `0001_initial.sql`처럼 순번 + 설명.
적용한 파일은 수정하지 않고 새 파일을 추가한다. 적용 전 SQLite backup API로 백업한다 (docs/design.md 13장, 20.6).
