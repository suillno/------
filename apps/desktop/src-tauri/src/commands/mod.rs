//! UI에 노출하는 IPC 명령. 임의 경로·SQL·프로세스 실행 명령을 추가하지 않는다.
//! 분석 명령은 고정된 CLI를 고정 인자로만 실행하며 회의 원문은 stdin 데이터로만 쓴다.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::agent::cli::{self, CliExecutor, FailureCode, SystemCli};
use crate::agent::store::{self, SavedAnalysis};
use crate::agent::{self, Claimed, RunOutcome};
use crate::paths::{AppEnv, PathResolver};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformStatus {
    kind: &'static str,
    app_version: String,
    environment: &'static str,
    diagnostics: BTreeMap<&'static str, String>,
}

#[tauri::command]
pub async fn app_status(app: tauri::AppHandle) -> Result<PlatformStatus, String> {
    let cli = tauri::async_runtime::spawn_blocking(claude_cli_version)
        .await
        .map_err(|e| e.to_string())?;

    let mut diagnostics = BTreeMap::new();
    diagnostics.insert("claudeCli", cli.unwrap_or_else(|| "찾을 수 없음".into()));

    Ok(PlatformStatus {
        kind: "desktop",
        app_version: app.package_info().version.to_string(),
        environment: AppEnv::current().as_str(),
        diagnostics,
    })
}

/// 설치된 Claude Code CLI 버전. 인자 배열로 실행하며 셸을 거치지 않는다.
fn claude_cli_version() -> Option<String> {
    let program = cli::find_cli()?;
    let tmp = std::env::temp_dir();
    let out = SystemCli { program }.run(&["--version".into()], "", &tmp, agent::limits::PROBE_TIMEOUT).ok()?;
    let text = out.stdout.trim().to_string();
    (out.status_ok && !text.is_empty()).then_some(text)
}

/// 기기당 동시 분석 1개 (docs/design.md 9장)
static ANALYSIS_RUNNING: AtomicBool = AtomicBool::new(false);

fn resolver() -> Result<PathResolver, String> {
    PathResolver::from_os(AppEnv::current()).map_err(|e| e.to_string())
}

/// 서버에서 claim한 작업 하나를 이 PC의 Claude Code CLI로 분석한다.
/// 새 작업을 만들지 않으며, 사용자가 요청해 서버에 대기 중이던 작업만 받는다.
#[tauri::command]
pub async fn run_analysis(user_id: String, claimed: Claimed) -> Result<RunOutcome, String> {
    if ANALYSIS_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("이 PC에서 이미 분석을 실행하고 있습니다".into());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let paths = resolver()?;
        let Some(program) = cli::find_cli() else {
            return Ok(RunOutcome::failed(FailureCode::CliNotFound));
        };
        agent::run_job(&SystemCli { program }, &paths, &user_id, &claimed).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string());
    ANALYSIS_RUNNING.store(false, Ordering::SeqCst);
    result?
}

#[tauri::command]
pub async fn pending_analysis_uploads(user_id: String) -> Result<Vec<SavedAnalysis>, String> {
    store::pending(&resolver()?, &user_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_analysis_upload(user_id: String, job_id: String) -> Result<(), String> {
    store::clear(&resolver()?, &user_id, &job_id).map_err(|e| e.to_string())
}
