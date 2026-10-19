# ADR 0004. 캘린더 일정에서 원본 회의록 열기: https 중계 + 앱 딥링크

- 상태: 채택
- 날짜: 2026-10-19
- 관련: [plans/2026-10-19-meeting-features.md](../plans/2026-10-19-meeting-features.md) 4장

## 배경

Google 캘린더 일정 설명의 링크를 누르면 그 일정을 만든 회의록 상세 화면(PC 앱·안드로이드 앱)이 열려야 한다. 웹 호스팅이 없고, 서버 기본 주소는 `*.supabase.co`(우리 도메인 아님)다.

## 검토

| 방식 | 결과 |
|---|---|
| Android App Links(https 도메인 검증) | 우리 도메인에 `/.well-known/assetlinks.json`을 올려야 한다. 도메인이 없어 불가 |
| 설명에 `meetingassistant://…` 직접 | Google 캘린더가 사용자 정의 스킴을 클릭 가능한 링크로 만들지 않는 경우가 많다 |
| 웹 앱으로 이동 | 웹 호스팅이 없다 |
| **https 중계 함수 + 사용자 정의 스킴** | 설명에는 https 주소만 넣고, 중계 함수가 기기에 맞는 앱 주소로 넘긴다 |

## 결정

- 설명: `원본 회의록 보기: https://<project>.supabase.co/functions/v1/open-meeting?m=<회의 UUID>`. 모든 등록 일정에 넣는다(목적지 유무와 무관). 이미 등록된 일정은 고치지 않는다.
- `open-meeting` Edge Function: JWT 검사·DB 조회 없이 UUID 형식만 검사한다(회의 존재 여부를 드러내지 않음).
  - 안드로이드 브라우저: `intent://meeting/<UUID>#Intent;scheme=meetingassistant;package=app.meetingassistant.mobile;S.browser_fallback_url=…;end` → 앱이 없으면 같은 함수의 안내 문구.
  - 그 밖(PC): `302 meetingassistant://meeting/<UUID>`.
- 앱: `tauri-plugin-deep-link`. PC는 실행할 때 현재 사용자 레지스트리(HKCU)에 스킴을 등록한다(설치 프로그램 없이 쓰는 설치본이므로). 이미 떠 있으면 단일 인스턴스 플러그인이 링크를 기존 창으로 넘긴다.
- 화면: 링크에서 UUID만 꺼내 기기에 보관 → 로그인 후 해당 회의 상세. 없거나 다른 계정의 회의면 “삭제됐거나 볼 수 없는 회의록” 안내. 권한 검사는 RLS가 한다.
- 링크 기본 주소는 서버 비밀 `GOOGLE_OAUTH_REDIRECT_URI`의 `/functions/v1/` 앞부분에서 만든다(새 비밀 없음).

## 결과·위험

- 앱이 설치되지 않은 PC에서는 브라우저가 스킴을 열지 못해 빈 화면이 보일 수 있다(Supabase 기본 도메인은 HTML 안내 페이지를 줄 수 없음). 안드로이드는 안내 문구로 대체된다.
- 웹 호스팅·도메인이 생기면 App Links와 웹 상세 화면으로 바꿀 수 있다. 링크 형식(`open-meeting?m=`)은 그대로 두고 중계 함수만 바꾸면 된다.
