mod commands;
mod state;
mod terminal;
mod workspace;

use state::AppState;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(app_state))
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_dir_tree,
            commands::fs::read_file,
            commands::fs::write_file,
            commands::terminal::spawn_terminal,
            commands::terminal::write_to_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::scroll_terminal,
            commands::terminal::kill_terminal,
            commands::workspace::get_workspaces,
            commands::workspace::save_workspace,
            commands::workspace::delete_workspace,
            commands::workspace::close_workspace,
            commands::settings::get_settings,
            commands::settings::update_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
