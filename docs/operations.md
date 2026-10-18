# 운영·배포·복구

아직 운영 환경이 없다. Phase 5에 작성한다. 다룰 항목은 [design.md 13~14장](design.md#13-windows-실행-파일-패키징백그라운드)과 같다.

- 설치 파일 서명, 업데이트 서명 검증, 실패 시 롤백
- Supabase 마이그레이션 배포 절차와 DB 백업·복원 검증
- 캘린더 등록 Edge Function 배포·모니터링(재시도는 사용자 버튼)
- SQLite 마이그레이션 전 백업과 복구
- 운영 지표: 미전송 건수, sync 오류율, 가장 오래된 대기 작업, lease 만료, 분석 실패, OAuth 만료

## PC 앱 설치본 (2026-10-18)

- 실행: 바탕화면·시작 메뉴 ‘회의 어시스턴트’ → `%LOCALAPPDATA%ProgramsMeetingAssistantmeeting-assistant.exe`. 서버는 클라우드이므로 Docker·Node·개발 서버가 필요 없다.
- 갱신: 코드를 바꾼 뒤 `npm run install:desktop`(설치본이 실행 중이면 닫고). 서버 주소는 빌드 시점의 `.env.local` `VITE_SUPABASE_URL`이 들어가며, 로컬 주소면 스크립트가 거부한다.
- 데이터: `%LOCALAPPDATA%MeetingAssistantproduction`(설치 폴더와 별개). 개발용 debug 앱은 `development`를 쓴다.
- 개발용 debug 앱과 설치본은 같은 앱 ID라 동시에 하나만 뜬다(먼저 뜬 쪽 창이 앞으로 온다).
- 서명된 설치 프로그램(NSIS)·자동 업데이트는 Phase 5에 남아 있다.

## 개발 환경 메모

- **한 번에 실행**: 저장소 루트 `start-meeting-assistant.cmd`(바탕화면 바로가기 가능). `.env.local`의 `VITE_SUPABASE_URL`이 클라우드 주소면 **데스크톱 앱만** 켠다(클라우드 모드). 로컬 주소일 때만 아래 순서로 서버까지 켠다. Docker Desktop 확인·실행 → `db:start` → `functions:serve`(숨김, 로그 `%LOCALAPPDATA%MeetingAssistantdevelopmentlogsunctions-serve.log`) → `dev:desktop`. 앱 창을 닫으면 Edge Function을 끄고 `db:stop`(데이터 보존). 실행기 창은 앱을 쓰는 동안 닫지 않는다. 이미 앱이 떠 있으면 창만 앞으로 가져온다.

- 로컬 Supabase: Docker Desktop을 실행한 뒤 `npm run db:start`
- exe 빌드 결과: `apps/desktop/src-tauri/target/release/` (`--no-bundle`) 또는 `.../release/bundle/nsis/`
- 로컬 Edge Function: `npm run functions:serve` (`supabase/functions/.env` 필요, Git 제외)
- 로컬 통합 테스트: `npm run test:integration` (db와 functions가 실행 중이어야 함)

## Edge Function 운영 배포 (미실행, 운영 환경이 정해지면)

1. `supabase link`로 운영 프로젝트를 연결하고 `supabase db push`로 마이그레이션을 적용한다.
2. 서버 비밀은 `supabase secrets set --env-file <Git 밖의 파일>`로 넣는다. 저장소·셸 기록·로그에 값을 남기지 않는다.
3. `supabase functions deploy calendar-register calendar-retry google-oauth-start google-disconnect`와 `supabase functions deploy google-oauth-callback --no-verify-jwt`.
4. Google 콘솔의 승인된 리디렉션 URI에 운영 콜백 주소를 추가하고 `GOOGLE_OAUTH_REDIRECT_URI`와 맞춘다.
5. 배포 후 웹·데스크톱 번들에서 서버 비밀 문자열이 없는지 검색한다(R03).

## 실패 작업 처리

분석·캘린더 등록 실패는 자동으로 다시 실행하지 않는다. 사용자에게 실패 사유와 ‘재시도’ 버튼을 보여 준다. 운영자가 DB에서 상태를 직접 바꾸지 않는다.

## 안드로이드 APK 빌드·설치 (개발용)

1. 준비(한 번): Android Studio(SDK·NDK·Command-line Tools), 사용자 환경변수 `ANDROID_HOME`·`NDK_HOME`·`JAVA_HOME`(Android Studio 내장 JBR), `rustup target add aarch64-linux-android …`.
2. Windows **개발자 모드를 켠다**(빌드할 때만 필요. Tauri가 라이브러리를 심볼릭 링크로 연결한다). `npm run build:android`가 꺼져 있으면 안내하고 멈춘다.
3. `npm run build:android` → 디버그 서명 arm64 APK. 위치: `apps/mobile/src-tauri/gen/android/app/build/outputs/apk/`.
4. 휴대폰에 APK를 복사하고 "알 수 없는 앱 설치"를 허용해 설치한다.
5. 빌드가 끝나면 개발자 모드는 꺼도 된다.

한글 저장소 경로 대응(2026-10-18):

- NDK 링커가 비ASCII 경로를 열지 못해 Rust 빌드 출력을 `%LOCALAPPDATA%\MeetingAssistant\build\android-target`으로 돌린다(`scripts/build-android.mjs`).
- Android Gradle 플러그인의 비ASCII 경로 검사는 `gen/android/gradle.properties`의 `android.overridePathCheck=true`로 끈다.
- 드라이브 문자 연결(`subst`)은 Rust의 경로 정규화가 원래 경로로 되돌려 Tauri가 거부하므로 쓰지 않는다.
- 저장소를 영문 경로로 옮기면 위 두 우회는 필요 없다.
