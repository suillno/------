# PC 앱 설치본 만들기·갱신. 실행: npm run install:desktop
#
# 화면까지 포함된 독립 실행 파일(release exe)을 빌드해 사용자 프로그램 폴더에 복사하고
# 바탕화면·시작 메뉴 바로가기를 만든다. 설치본은 개발 서버·Node 없이 실행된다.
#   설치 위치: %LOCALAPPDATA%\Programs\MeetingAssistant\meeting-assistant.exe
#   데이터 위치(별도): %LOCALAPPDATA%\MeetingAssistant\production  (paths.rs)
# 서버 주소는 빌드할 때 .env.local의 VITE_SUPABASE_URL이 들어간다(클라우드 주소여야 한다).
# 비밀값을 읽거나 출력하지 않는다.

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if ((Test-Path $cargoBin) -and ($env:PATH -notlike "*$cargoBin*")) { $env:PATH = "$cargoBin;$env:PATH" }

function Fail($text) { Write-Host "✘ $text" -ForegroundColor Red; exit 1 }

# 1. 서버 주소 확인: 설치본은 클라우드 주소로만 만든다(로컬 Supabase는 PC를 켜 둔 개발 때만 있음)
$urlLine = Select-String -Path ".env.local" -Pattern "^VITE_SUPABASE_URL=(.+)$" | Select-Object -First 1
if (-not $urlLine) { Fail ".env.local에 VITE_SUPABASE_URL이 없습니다." }
if ($urlLine.Matches[0].Groups[1].Value.Trim() -match "^https?://(127\.0\.0\.1|localhost)") {
    Fail "VITE_SUPABASE_URL이 로컬 주소입니다. 설치본은 클라우드 주소로 빌드해야 합니다."
}

# 2. 설치본이 실행 중이면 파일을 덮어쓸 수 없다 (개발용 debug 앱은 다른 파일이라 상관없다)
$installDir = Join-Path $env:LOCALAPPDATA "Programs\MeetingAssistant"
$exe = Join-Path $installDir "meeting-assistant.exe"
$runningInstalled = Get-Process -Name "meeting-assistant" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
if ($runningInstalled) { Fail "설치된 회의 어시스턴트가 실행 중입니다. 앱 창을 닫고 다시 실행하세요." }

# 3. release exe 빌드 (화면 빌드 포함, 설치 프로그램 없이)
Write-Host "▶ PC 앱 빌드 중… (처음에는 몇 분 걸립니다)" -ForegroundColor Cyan
& npm run tauri -w @meeting/desktop -- build --no-bundle
if ($LASTEXITCODE -ne 0) { Fail "빌드에 실패했습니다. 위 메시지를 확인하세요." }
$built = Join-Path $Root "apps\desktop\src-tauri\target\release\meeting-assistant.exe"
if (-not (Test-Path $built)) { Fail "빌드 결과 파일을 찾을 수 없습니다: $built" }

# 4. 설치 폴더에 복사
New-Item -ItemType Directory -Force $installDir | Out-Null
Copy-Item $built $exe -Force
$icon = Join-Path $installDir "icon.ico"
Copy-Item (Join-Path $Root "apps\desktop\src-tauri\icons\icon.ico") $icon -Force

# 5. 바로가기 (바탕화면, 시작 메뉴)
$ws = New-Object -ComObject WScript.Shell
$targets = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "회의 어시스턴트.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Programs")) "회의 어시스턴트.lnk")
)
foreach ($lnkPath in $targets) {
    $s = $ws.CreateShortcut($lnkPath)
    $s.TargetPath = $exe
    $s.WorkingDirectory = $installDir
    $s.IconLocation = "$icon,0"
    $s.Description = "회의 어시스턴트 (클라우드 연결)"
    $s.Save()
}

Write-Host "✔ 설치 완료: $exe" -ForegroundColor Green
Write-Host "  바로가기: 바탕화면·시작 메뉴 '회의 어시스턴트'"
