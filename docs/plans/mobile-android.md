# 계획: 안드로이드 휴대폰 앱 (회의 등록 → 분석 요청 → 일정 확인)

- 상태: **계획 (미구현)**. 6장의 확정 사항을 따른다.
- 작성: 2026-10-18, 확정 사항 반영: 2026-10-18
- 관련: [design.md](../design.md) 2·4·10장, [ADR 0003](../adr/0003-manual-execution.md), [roadmap.md](../roadmap.md)

## 1. 목표

휴대폰에서 회의 내용을 등록하고 분석을 요청한다. 분석은 PC가 한다. 휴대폰에서는 분석 화면(요약 편집 등)을 보지 않고, 분석이 끝난 회의의 일정만 확인해 사용자가 승인한 뒤 캘린더에 등록한다.

```text
[안드로이드 앱]
  ① 회의 등록 (제목·일시·본문 저장)
  ② 등록 내역 확인 (목록·상태)
  ③ 내역에서 '분석 요청' 버튼
        │
        ▼
[클라우드 Supabase]  휴대폰과 PC가 함께 쓰는 서버
        │  사용자가 요청한 대기 작업
        ▼
[PC 데스크톱 앱]  Claude Code로 분석 → 결과 업로드 (지금 구현된 기능 그대로)
        │
        ▼
[안드로이드 앱]
  ④ 일정 확인: 날짜 확인·수정 → '확인' = 사용자 승인 후 캘린더 등록
```

## 2. 가능 여부 확인 결과

**가능하다.**

| 단계 | 필요한 서버 기능 | 현재 상태 |
|---|---|---|
| ① 회의 등록 | `meeting_create` RPC | ✅ 구현·테스트됨 |
| ② 내역 확인 | `meetings` 읽기, `meeting_analysis_state` | ✅ 구현·테스트됨 |
| ③ 분석 요청 | `analysis_request`(버튼으로만), PC 에이전트 처리 | ✅ 구현·테스트됨 (PC 앱이 켜져 있고 ‘이 PC에서 분석 실행’이 켜져 있어야 처리) |
| ④ 일정 확인·등록 | `candidate_patch`, `calendar-register`(승인 + 등록), `calendar-retry` | ✅ 구현·테스트됨. 클라우드에서 동작하므로 PC가 꺼져 있어도 휴대폰에서 등록 가능 |
| 휴대폰 앱 화면 | 위 API를 호출하는 안드로이드 앱 | ⬜ 새로 필요 |
| 휴대폰↔PC 연결 | 클라우드 Supabase | ⬜ 배포 필요 (4장) |

제약:

- 분석은 PC가 켜져 있고 데스크톱 앱이 실행 중일 때만 진행된다. PC가 꺼져 있으면 요청은 대기하고, 휴대폰 내역에 "대기 중"으로 보인다. 분석 완료는 휴대폰 내역의 상태로 확인한다.
- 이 PC는 공인 IP로 인터넷에 직접 연결되어 있어(2026-10-18 확인) PC를 휴대폰용 서버로 열면 안 된다. 로컬 Supabase는 공개된 개발용 키를 쓰므로 노출되면 관리자 권한을 위조할 수 있다. 그래서 클라우드 Supabase가 필수다.

## 3. 휴대폰 앱 화면

분석 결과 화면(요약·결정사항 편집, 새 결과 적용)은 휴대폰에 두지 않는다. 그 기능은 PC 앱에 남는다.

| 화면 | 내용 | 버튼 |
|---|---|---|
| 로그인 | PC와 같은 계정(Supabase Auth) | 로그인 |
| 회의 등록 | 제목, 회의 일시(기본: 지금), 시간대(기본: 휴대폰 설정), 본문 | 저장 (분석은 시작하지 않음) |
| 등록 내역 | 최신순 목록. 각 항목에 분석 상태 배지: 분석 전 / 대기 중 / 분석 중 / 완료 / 실패(사유) | 항목 열기 |
| 내역 상세 | 본문 보기, 분석 상태 | **분석 요청**(분석 전), **재시도**(실패), 진행 중이면 비활성 |
| 일정 확인 | 분석이 끝난 회의의 일정 후보 목록: 제목, 날짜·시각, 근거 문장, “확인 필요” 표시 | 날짜 수정 → **저장**, **확인**(= 승인하고 캘린더 등록, 내용 확인 단계 포함), **거절**, 실패 시 **재시도**, 등록 후 “캘린더에서 보기” |

- 캘린더 등록은 사용자가 ‘확인’을 눌러 승인한 후보만 한다. 자동 등록은 하지 않는다.
- 중복 클릭 방지·상태 표시·재시도 규칙은 PC와 같다(`client-core`의 `analysisView`, `candidateView`, `SingleFlight` 재사용).
- 휴대폰은 분석을 실행하지 않는다(분석 실행기 없음). 분석 요청만 서버에 남긴다.

## 4. 클라우드 배포 (휴대폰 앱의 선행 조건)

| 순서 | 작업 | 담당 |
|---|---|---|
| 1 | Supabase 계정 가입 | ✅ 사용자 완료 (2026-10-18) |
| 2 | 프로젝트 생성 (무료 플랜, 지역: 서울 `ap-northeast-2` 권장) | 사용자 |
| 3 | 6.2의 위치에 프로젝트 정보 등록, `supabase link` | 사용자 + 개발 |
| 4 | `supabase db push`로 마이그레이션 적용 | 개발 |
| 5 | 서버 비밀 등록 `supabase secrets set --env-file <Git 밖 파일>` | 사용자가 값 입력, 개발이 절차 안내 |
| 6 | Edge Function 배포 (`google-oauth-callback`만 `--no-verify-jwt`) | 개발 |
| 7 | Google 콘솔: 승인된 리디렉션 URI에 클라우드 콜백 주소 추가 | 사용자 |
| 8 | 데스크톱 앱을 클라우드 주소로 바꾸고 다시 로그인·Google 연결 | 개발 + 사용자 확인 |

- Google 연결 완료 화면은 별도 웹 호스팅 없이 `google-oauth-callback` Edge Function이 “연결 완료, 앱으로 돌아가세요” 안내를 직접 응답한다. 2026-10-18 구현: `APP_WEB_ORIGIN`이 없으면 안내 문구를 응답한다. Supabase 기본 도메인은 Edge Function의 HTML 응답을 허용하지 않으므로 `text/plain` 문구로 보낸다.
- 로컬 테스트 데이터는 옮기지 않고 클라우드에서 새로 시작한다.

## 5. 안드로이드 앱 기술

**Tauri 2 Android로 진행한다** (6.1). 지금 저장소의 Tauri 2·React UI·`client-core`를 그대로 재사용한다.

- 폴더: `apps/mobile/` (Vite + React, `packages/ui`의 휴대폰 전용 화면 `features/mobile/`).
- APK에는 Supabase URL과 anon(공개) 키만 넣는다. service-role·Google secret·암호화 키는 넣지 않는다.
- 로그인 세션은 안드로이드 Keystore 기반 보안 저장소에 둔다.
- 설치: 서명한 APK를 휴대폰에 복사해 설치(“알 수 없는 앱 설치” 허용). Play 스토어 배포는 범위 밖.
- 준비물: Android Studio(SDK·NDK·에뮬레이터, 약 5~10GB), JDK 17 이상, `rustup target add aarch64-linux-android armv7-linux-androideabi`. 2026-10-18 현재 이 PC에는 Android SDK가 없다.

## 6. 구현 전 결정

### 6.1 확정 사항 (2026-10-18)

| 항목 | 결정 |
|---|---|
| 캘린더 등록 | 사용자 승인 후 등록한다. 자동 등록은 하지 않는다. 기존 규칙 “사용자 승인 없이 Google 이벤트를 등록하지 않는다”를 그대로 따른다 |
| 안드로이드 앱 기술 | 기존 코드 재사용을 위해 Tauri 2 Android로 진행한다 |
| Google 연결 완료 화면 | 별도 웹 호스팅 없이 Edge Function 안내 페이지로 처리한다 |
| 알림 | Gmail 알림은 제외한다. 메일 발송·실패·재발송 기능을 만들지 않으며 `gmail.send` scope도 추가하지 않는다 |

### 6.2 추가 확인 사항: Supabase 클라우드 정보 등록 위치

가입은 완료했다. 프로젝트를 만든 뒤 아래 값을 각 위치에 등록한다. **비밀값은 저장소 파일·문서·대화에 붙여 넣지 않는다.**

| 값 | 어디서 보나 (Supabase 대시보드) | 등록 위치 | 비밀 여부 |
|---|---|---|---|
| Project URL (`https://<ref>.supabase.co`) | Project Settings → Data API | `.env.local`의 `CLOUD_SUPABASE_URL` 입력칸 (Git 제외). 전환 시 `VITE_SUPABASE_URL`로 옮김 | 공개 |
| anon(공개) 키 | Project Settings → API Keys | `.env.local`의 `CLOUD_SUPABASE_ANON_KEY` 입력칸. 전환 시 `VITE_SUPABASE_ANON_KEY`로 옮김 | 공개(번들 포함, RLS 전제) |
| Project ref (`<ref>`) | Project Settings → General | `.env.local`의 `CLOUD_SUPABASE_PROJECT_REF` 입력칸, `npx supabase link --project-ref <ref>` 실행 시 사용. CLI가 `supabase/.temp`(Git 제외)에 기록 | 공개 |
| 개인 액세스 토큰 | `npx supabase login` 실행 시 브라우저 인증으로 자동 발급 | CLI가 사용자 프로필에 보관 (저장소 밖) | **비밀** |
| DB 비밀번호 | 프로젝트 생성 시 직접 정함 | `supabase link`·`db push`가 물을 때 터미널에만 입력 | **비밀** |
| service-role 키 | Project Settings → API Keys | **등록하지 않는다.** Edge Function 실행 환경이 자동으로 넣는다 | **비밀** |
| Google client ID·secret, `TOKEN_ENCRYPTION_KEY` | Google 콘솔 / 새로 생성(운영용은 로컬과 다른 값) | `supabase secrets set --env-file <저장소 밖 파일>` → 등록 후 파일 삭제 | **비밀** |
| Google 콜백 주소 | `https://<ref>.supabase.co/functions/v1/google-oauth-callback` | Google 콘솔 → OAuth 클라이언트 → 승인된 리디렉션 URI에 **추가**(로컬 주소는 유지), `GOOGLE_OAUTH_REDIRECT_URI` 비밀값 | 공개 |
| Auth 설정 | Authentication → URL Configuration | Site URL·Redirect URLs는 이메일 로그인만 쓰는 동안 기본값 유지. 휴대폰 딥링크를 쓰게 되면 그때 추가 | 공개 |

- `.env.local`에 클라우드 입력칸(`CLOUD_SUPABASE_*`)을 만들어 두었다(2026-10-18). 같은 날 데스크톱 앱을 클라우드로 전환했다: `VITE_SUPABASE_*`에 클라우드 값을 넣고 로컬 값은 `LOCAL_DEV_SUPABASE_*`로 보관한다. 실행기는 `VITE_SUPABASE_URL`을 보고 로컬/클라우드 모드를 고른다.
- 남은 결정: 프로젝트 지역·요금제(로드맵 기존 항목). 권장은 서울, 무료 플랜.

## 7. 구현 순서

1. 클라우드 배포(4장) — 6.2의 프로젝트 생성·등록이 선행.
2. `google-oauth-callback`을 안내 페이지 응답으로 변경, vitest 테스트.
3. `packages/ui/src/features/mobile/` 화면 5개와 `client-core` 재사용. 웹 브라우저에서 먼저 확인.
4. `apps/mobile/` Tauri 2 Android 초기화, 서명 키 생성(Git 제외), 디버그 APK → 휴대폰 설치 확인.
5. 통합 확인: 휴대폰 등록 → 분석 요청 → PC 분석 → 휴대폰 내역에서 완료 확인 → 일정 확인(승인) → Google 캘린더 등록.
6. 문서: design.md(2·4·10장), ADR(휴대폰 앱 기술), file-map, configuration(클라우드 변수), operations(APK 서명·배포).

## 8. 추가할 테스트 시나리오

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| MB01 | 휴대폰에서 저장만 함 | 분석 작업 없음 |
| MB02 | 휴대폰 ‘분석 요청’ 연속 클릭 | 작업 1건 |
| MB03 | PC 꺼짐 상태에서 요청 | 휴대폰에 “대기 중”, PC 켜고 허용되면 처리 |
| MB04 | 분석 완료 | 휴대폰 내역 상태가 “완료”로 바뀌고 일정 확인에 후보 표시 |
| MB05 | 휴대폰에서 날짜 수정 후 확인 | 수정된 내용으로 1건 등록, 이전 승인 미사용 |
| MB06 | 확인을 누르지 않은 후보 | 캘린더에 등록되지 않음 |
| MB07 | PC 꺼짐 상태에서 휴대폰 확인 | 클라우드가 등록 |
| MB08 | APK 안의 비밀값 검사 | anon 키 외 서버 비밀 없음 |
| MB09 | Google 연결 완료 | 안내 페이지 표시, 웹 호스팅 없이 동작 |
