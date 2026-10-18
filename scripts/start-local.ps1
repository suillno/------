# 회의 어시스턴트 한 번에 실행. 실행: 저장소 루트의 start-meeting-assistant.cmd 더블클릭
#
# .env.local의 VITE_SUPABASE_URL로 모드를 정한다.
#   로컬 모드(127.0.0.1·localhost): Docker → 로컬 Supabase → Edge Function → 데스크톱 앱.
#     앱 창을 닫으면 Edge Function과 Supabase를 정리한다(-KeepServices면 Supabase는 켜 둔다).
#   클라우드 모드(그 밖의 주소): 서버는 클라우드에 있으므로 데스크톱 앱만 켠다.
# 이 스크립트는 비밀값을 읽거나 출력하지 않는다. .env.local에서는 서버 주소만, supabase/functions/.env는 존재 여부만 확인한다.
param(
    [switch]$KeepServices
)

# 외부 명령(docker, npm)의 실패는 종료 코드로 직접 판단한다. PowerShell 5.1에서 Stop이면 stderr만으로 예외가 난다.
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Host.UI.RawUI.WindowTitle = "회의 어시스턴트 실행기"

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if ((Test-Path $cargoBin) -and ($env:PATH -notlike "*$cargoBin*")) { $env:PATH = "$cargoBin;$env:PATH" }

$LogDir = Join-Path $env:LOCALAPPDATA "MeetingAssistant\development\logs"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$FunctionsLog = Join-Path $LogDir "functions-serve.log"

function Step($text) { Write-Host "`n▶ $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  ✔ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Fail($text) {
    Write-Host "  ✘ $text" -ForegroundColor Red
    Read-Host "Enter를 누르면 닫습니다" | Out-Null
    exit 1
}

function Test-Docker {
    & docker info --format "{{.ServerVersion}}" *> $null
    return $LASTEXITCODE -eq 0
}

function Stop-Tree($proc) {
    if ($proc -and -not $proc.HasExited) { & taskkill /PID $proc.Id /T /F *> $null }
}

# ── 0. 이미 실행 중이면 창만 앞으로 ──
$running = Get-Process -Name "meeting-assistant" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($running) {
    (New-Object -ComObject WScript.Shell).AppActivate($running.Id) | Out-Null
    Write-Host "회의 어시스턴트가 이미 실행 중입니다. 창을 앞으로 가져왔습니다."
    Start-Sleep -Seconds 2
    exit 0
}

# ── 1. 사전 확인 ──
Step "사전 확인"
if (-not (Test-Path "node_modules")) { Fail "node_modules가 없습니다. 저장소 루트에서 npm install을 먼저 실행하세요." }
if (-not (Test-Path ".env.local")) { Fail ".env.local이 없습니다. .env.example을 참고해 만드세요." }
$urlLine = Select-String -Path ".env.local" -Pattern "^VITE_SUPABASE_URL=(.+)$" | Select-Object -First 1
if (-not $urlLine) { Fail ".env.local에 VITE_SUPABASE_URL이 없습니다." }
$supabaseUrl = $urlLine.Matches[0].Groups[1].Value.Trim()
$LocalMode = $supabaseUrl -match "^https?://(127\.0\.0\.1|localhost)(:|/|$)"
if ($LocalMode) { Ok "로컬 모드 (PC의 로컬 Supabase 사용)" } else { Ok "클라우드 모드 (서버는 클라우드, 이 PC는 앱만 실행)" }
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok "Claude Code CLI 확인" } else { Warn "Claude Code CLI가 없어 이 PC에서 분석할 수 없습니다." }

$functions = $null
if ($LocalMode) {
    $HasFunctionsEnv = Test-Path "supabase\functions\.env"
    if (-not $HasFunctionsEnv) { Warn "supabase\functions\.env가 없어 Google 연동 없이 실행합니다." }

    # ── 2. Docker ──
    Step "Docker Desktop"
    if (Test-Docker) {
        Ok "실행 중"
    } else {
        $dockerExe = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
        if (-not (Test-Path $dockerExe)) { Fail "Docker Desktop이 설치되어 있지 않습니다." }
        Start-Process $dockerExe | Out-Null
        Write-Host "  Docker Desktop을 시작하는 중… (최대 3분)"
        $deadline = (Get-Date).AddMinutes(3)
        while (-not (Test-Docker)) {
            if ((Get-Date) -gt $deadline) { Fail "Docker Desktop이 시작되지 않았습니다. 직접 실행한 뒤 다시 시도하세요." }
            Start-Sleep -Seconds 3
        }
        Ok "시작됨"
    }

    # ── 3. Supabase ──
    Step "로컬 Supabase"
    & npx supabase status *> $null
    if ($LASTEXITCODE -eq 0) {
        Ok "실행 중"
    } else {
        Write-Host "  시작하는 중… (처음에는 1~2분)"
        & npm run db:start
        if ($LASTEXITCODE -ne 0) { Fail "Supabase를 시작하지 못했습니다. 위 메시지를 확인하세요." }
        Ok "시작됨"
    }

    # ── 4. Edge Function ──
    if ($HasFunctionsEnv) {
        Step "Edge Function (Google 연결·캘린더 등록)"
        for ($attempt = 1; $attempt -le 3 -and -not $functions; $attempt++) {
            # db:start가 띄운 기본 런타임(비밀 없음)을 정리하고 .env를 읽는 런타임으로 바꾼다
            & docker rm -f supabase_edge_runtime_meeting-assistant *> $null
            Start-Sleep -Seconds 2
            Remove-Item $FunctionsLog -ErrorAction SilentlyContinue
            $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run functions:serve > `"$FunctionsLog`" 2>&1" `
                -WorkingDirectory $Root -WindowStyle Hidden -PassThru
            $deadline = (Get-Date).AddSeconds(90)
            while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
                if ((Test-Path $FunctionsLog) -and (Select-String -Path $FunctionsLog -Pattern "Serving functions" -Quiet)) { $functions = $proc; break }
                Start-Sleep -Seconds 1
            }
            if (-not $functions) {
                Stop-Tree $proc
                Warn "시작 실패 ($attempt/3). 다시 시도합니다."
            }
        }
        if ($functions) { Ok "실행 중 (로그: $FunctionsLog)" } else { Warn "Edge Function을 시작하지 못했습니다. Google 연동 없이 계속합니다. 로그: $FunctionsLog" }
    }
}

# ── 5. 데스크톱 앱 ──
Step "데스크톱 앱"
if ($LocalMode) { Write-Host "  앱 창을 닫으면 서버도 정리합니다. 이 창은 닫지 말고 두세요." -ForegroundColor Gray }
try {
    & npm run dev:desktop
} finally {
    if ($LocalMode) {
        Step "정리"
        if ($functions) { Stop-Tree $functions; & docker rm -f supabase_edge_runtime_meeting-assistant *> $null; Ok "Edge Function 종료" }
        if ($KeepServices) {
            Ok "Supabase는 켜 둡니다 (-KeepServices)"
        } else {
            & npm run db:stop *> $null
            Ok "Supabase 종료 (데이터는 보존됩니다)"
        }
    }
    Write-Host "`n완료. 3초 뒤 닫힙니다."
    Start-Sleep -Seconds 3
}
