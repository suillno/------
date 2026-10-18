// 데스크톱에서 화면을 확인할 때만 쓰는 진입점. 안드로이드는 lib.rs의 mobile_entry_point를 쓴다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    meeting_assistant_mobile_lib::run()
}
