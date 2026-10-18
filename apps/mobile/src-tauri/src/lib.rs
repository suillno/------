//! 휴대폰 앱 셸. 화면(apps/mobile, packages/ui features/mobile)이 Supabase에 직접 접속한다.
//! IPC 명령을 두지 않고, 외부 링크 열기(opener)만 capabilities로 허용한다.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 외부 URL은 capabilities/default.json의 Google 캘린더 주소만 연다
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("Tauri 애플리케이션 실행 실패");
}
