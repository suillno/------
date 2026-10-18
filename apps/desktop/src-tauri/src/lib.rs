mod agent;
mod commands;
pub mod paths;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // 단일 인스턴스: 두 번째 실행은 기존 창을 앞으로 가져온다 (docs/design.md 13장)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // 외부 URL 열기는 capabilities/default.json의 허용 주소(Google 동의·캘린더 화면)로 제한한다
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::run_analysis,
            commands::pending_analysis_uploads,
            commands::clear_analysis_upload
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 애플리케이션 실행 실패");
}
