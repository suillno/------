mod agent;
mod commands;
pub mod paths;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // 단일 인스턴스: 두 번째 실행은 기존 창을 앞으로 가져온다 (docs/design.md 13장).
        // deep-link 기능을 켜 두어, 이미 떠 있을 때 누른 meetingassistant:// 링크도 기존 창의 onOpenUrl로 넘어간다.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // 캘린더 ‘원본 회의록 보기’ 링크(meetingassistant://meeting/<UUID>). 화면이 회의 UUID만 꺼내 쓴다.
        .plugin(tauri_plugin_deep_link::init())
        // 외부 URL 열기는 capabilities/default.json의 허용 주소(Google 동의·캘린더 화면)로 제한한다
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 설치 프로그램 없이 쓰는 설치본이라 실행할 때 현재 사용자(HKCU)에 스킴을 등록한다.
            // 실패해도 앱은 동작한다(링크로 여는 기능만 빠진다).
            #[cfg(windows)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            #[cfg(not(windows))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::run_analysis,
            commands::pending_analysis_uploads,
            commands::clear_analysis_upload
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 애플리케이션 실행 실패");
}
