//! Application entry point and Tauri bootstrap.
//!
//! Responsibilities:
//! - Builds the native menu bar (`build_menu`)
//! - Registers every `#[tauri::command]` handler via `generate_handler!`
//! - Starts the attention HTTP server (`attention::start_server`) and installs the Claude hook
//! - Sets up the macOS dock right-click menu (`dock::setup`)
//!
//! Two invoke-handler lists exist behind a feature gate:
//! - default: production handler set
//! - `e2e`: adds `get_debug_stats` and enables `tauri_plugin_webdriver`
//!
//! The `new-window` menu event is handled here — not forwarded to the frontend — so exactly
//! one window opens regardless of how many webviews are currently listening.

mod attention;
mod commands;
#[cfg(debug_assertions)]
mod dev_server;
#[cfg(target_os = "macos")]
mod dock;
pub mod lsp;
mod state;
pub mod terminal;
mod workspace;

use state::AppState;
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};

fn build_menu(app: &tauri::App) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    // App (macOS) submenu
    let app_menu = SubmenuBuilder::new(app, "Splice")
        .about(None)
        .separator()
        .item(&MenuItemBuilder::with_id("settings", "Settings…").accelerator("CmdOrCtrl+,").build(app)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // File submenu
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("new-file", "New File").accelerator("CmdOrCtrl+N").build(app)?)
        .item(&MenuItemBuilder::with_id("open-file", "Open File…").accelerator("CmdOrCtrl+O").build(app)?)
        .item(&MenuItemBuilder::with_id("open-folder", "Open Folder…").accelerator("CmdOrCtrl+Shift+O").build(app)?)
        .item(&MenuItemBuilder::with_id("new-window", "New Window").accelerator("CmdOrCtrl+Shift+N").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("save", "Save").accelerator("CmdOrCtrl+S").build(app)?)
        .item(&MenuItemBuilder::with_id("save-as", "Save As…").accelerator("CmdOrCtrl+Shift+S").build(app)?)
        .item(&MenuItemBuilder::with_id("save-all", "Save All").accelerator("CmdOrCtrl+Alt+S").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("close-tab", "Close Tab").accelerator("CmdOrCtrl+W").build(app)?)
        .item(&MenuItemBuilder::with_id("close-all-tabs", "Close All Tabs").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("close-workspace", "Close Workspace").build(app)?)
        .build()?;

    // Edit submenu
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&MenuItemBuilder::with_id("find", "Find").accelerator("CmdOrCtrl+F").build(app)?)
        .item(&MenuItemBuilder::with_id("find-in-files", "Find in Files").accelerator("CmdOrCtrl+Shift+F").build(app)?)
        .item(&MenuItemBuilder::with_id("replace", "Replace").accelerator("CmdOrCtrl+H").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("goto-line", "Go to Line").accelerator("CmdOrCtrl+G").build(app)?)
        .item(&MenuItemBuilder::with_id("format-document", "Format Document").accelerator("Shift+Alt+F").build(app)?)
        .build()?;

    // View submenu
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("command-palette", "Command Palette").accelerator("CmdOrCtrl+P").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar").accelerator("CmdOrCtrl+B").build(app)?)
        .item(&MenuItemBuilder::with_id("toggle-word-wrap", "Toggle Word Wrap").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("zoom-in", "Zoom In").accelerator("CmdOrCtrl+=").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom-out", "Zoom Out").accelerator("CmdOrCtrl+-").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom-reset", "Reset Zoom").accelerator("CmdOrCtrl+0").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("zen-mode", "Zen Mode").accelerator("CmdOrCtrl+Shift+Enter").build(app)?)
        .build()?;

    // Window submenu
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&MenuItemBuilder::with_id("new-terminal", "New Terminal").build(app)?)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let app_state = AppState::new();

    #[cfg_attr(not(feature = "e2e"), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(feature = "e2e")]
    {
        builder = builder.plugin(tauri_plugin_webdriver::init());
    }

    builder
        .manage(Mutex::new(app_state))
        .setup(|app| {
            // Set up native menu bar
            let menu = build_menu(app)?;
            app.set_menu(menu)?;

            // macOS dock right-click menu ("New Window")
            #[cfg(target_os = "macos")]
            dock::setup(app.handle());

            let token = attention::load_or_create_token();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let port = attention::start_server(handle.clone(), token).await;
                if port > 0 {
                    if let Ok(mut s) = handle.state::<Mutex<AppState>>().lock() {
                        s.attention_port = Some(port);
                    }
                    // Install/update Claude hooks now that the server is running.
                    // Do this here (not from the frontend) to avoid a race where
                    // installClaudeHook() fires before attention_port is set.
                    if let Err(e) = attention::install_hook() {
                        tracing::warn!("Failed to install Claude hook: {}", e);
                    }
                }
            });

            // Dev-only: start the local HTTP API so Claude can drive the UI programmatically.
            #[cfg(debug_assertions)]
            {
                let dev_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    dev_server::start_dev_server(dev_handle).await;
                });
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().0 == "new-window" {
                // Handle in Rust so exactly one window opens regardless of how many
                // windows are currently listening (dock click, menu bar, or keyboard shortcut).
                let label = format!(
                    "main-{:x}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0)
                );
                let _ = commands::workspace::register_window(label.clone());
                let _ = tauri::WebviewWindowBuilder::new(
                    app,
                    &label,
                    tauri::WebviewUrl::App("/".into()),
                )
                .title("Splice")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .decorations(true)
                .resizable(true)
                .build();
            } else {
                let _ = app.emit("menu-event", event.id().0.as_str());
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let _ = window.emit("app:closing", ());
            }
        })
        .invoke_handler({
            #[cfg(all(not(feature = "e2e"), not(debug_assertions)))]
            { tauri::generate_handler![
                commands::ssh::ssh_connect,
                commands::ssh::ssh_disconnect,
                commands::ssh::sftp_list_dir,
                commands::ssh::sftp_read_file,
                commands::ssh::sftp_write_file,
                commands::ssh::ssh_ping,
                commands::fs::read_dir_tree,
                commands::fs::read_file,
                commands::fs::write_file,
                commands::fs::read_file_base64,
                commands::fs::search_files,
                commands::fs::get_git_branch,
                commands::fs::get_recent_files,
                commands::fs::add_recent_file,
                commands::fs::get_recent_projects,
                commands::fs::add_recent_project,
                commands::fs::watch_path,
                commands::fs::unwatch_path,
                commands::fs::create_file_at,
                commands::fs::create_directory_at,
                commands::fs::rename_path,
                commands::fs::delete_path,
                commands::fs::duplicate_path,
                commands::fs::copy_path,
                commands::fs::reveal_in_file_manager,
                commands::fs::save_temp_image,
                commands::fs::write_to_clipboard,
                commands::terminal::spawn_terminal,
                commands::terminal::write_to_terminal,
                commands::terminal::resize_terminal,
                commands::terminal::scroll_terminal,
                commands::terminal::set_terminal_scroll_offset,
                commands::terminal::kill_terminal,
                commands::terminal::search_terminal,
                commands::terminal::get_terminal_cwd,
                commands::terminal::get_terminal_text_range,
                commands::terminal::install_claude_hook,
                commands::workspace::get_workspaces,
                commands::workspace::save_workspace,
                commands::workspace::delete_workspace,
                commands::workspace::close_workspace,
                commands::workspace::set_active_workspace_id,
                commands::workspace::reorder_workspaces,
                commands::workspace::add_allowed_root,
                commands::workspace::check_pid_alive,
                commands::workspace::register_window,
                commands::workspace::unregister_window,
                commands::workspace::get_secondary_window_labels,
                commands::settings::get_settings,
                commands::settings::update_settings,
                lsp::lsp_check,
                lsp::lsp_install,
                lsp::lsp_start,
                lsp::lsp_notify,
                lsp::lsp_request,
            ] }
            #[cfg(all(debug_assertions, not(feature = "e2e")))]
            { tauri::generate_handler![
                commands::ssh::ssh_connect,
                commands::ssh::ssh_disconnect,
                commands::ssh::sftp_list_dir,
                commands::ssh::sftp_read_file,
                commands::ssh::sftp_write_file,
                commands::ssh::ssh_ping,
                commands::fs::read_dir_tree,
                commands::fs::read_file,
                commands::fs::write_file,
                commands::fs::read_file_base64,
                commands::fs::search_files,
                commands::fs::get_git_branch,
                commands::fs::get_recent_files,
                commands::fs::add_recent_file,
                commands::fs::get_recent_projects,
                commands::fs::add_recent_project,
                commands::fs::watch_path,
                commands::fs::unwatch_path,
                commands::fs::create_file_at,
                commands::fs::create_directory_at,
                commands::fs::rename_path,
                commands::fs::delete_path,
                commands::fs::duplicate_path,
                commands::fs::copy_path,
                commands::fs::reveal_in_file_manager,
                commands::fs::save_temp_image,
                commands::fs::write_to_clipboard,
                commands::terminal::spawn_terminal,
                commands::terminal::write_to_terminal,
                commands::terminal::resize_terminal,
                commands::terminal::scroll_terminal,
                commands::terminal::set_terminal_scroll_offset,
                commands::terminal::kill_terminal,
                commands::terminal::search_terminal,
                commands::terminal::get_terminal_cwd,
                commands::terminal::get_terminal_text_range,
                commands::terminal::install_claude_hook,
                commands::workspace::get_workspaces,
                commands::workspace::save_workspace,
                commands::workspace::delete_workspace,
                commands::workspace::close_workspace,
                commands::workspace::set_active_workspace_id,
                commands::workspace::reorder_workspaces,
                commands::workspace::add_allowed_root,
                commands::workspace::check_pid_alive,
                commands::workspace::register_window,
                commands::workspace::unregister_window,
                commands::workspace::get_secondary_window_labels,
                commands::settings::get_settings,
                commands::settings::update_settings,
                lsp::lsp_check,
                lsp::lsp_install,
                lsp::lsp_start,
                lsp::lsp_notify,
                lsp::lsp_request,
                commands::dev::save_screenshot_bytes,
                commands::dev::create_demo_project,
            ] }
            #[cfg(feature = "e2e")]
            { tauri::generate_handler![
                commands::ssh::ssh_connect,
                commands::ssh::ssh_disconnect,
                commands::ssh::sftp_list_dir,
                commands::ssh::sftp_read_file,
                commands::ssh::sftp_write_file,
                commands::ssh::ssh_ping,
                commands::fs::read_dir_tree,
                commands::fs::read_file,
                commands::fs::write_file,
                commands::fs::read_file_base64,
                commands::fs::search_files,
                commands::fs::get_git_branch,
                commands::fs::get_recent_files,
                commands::fs::add_recent_file,
                commands::fs::get_recent_projects,
                commands::fs::add_recent_project,
                commands::fs::watch_path,
                commands::fs::unwatch_path,
                commands::fs::create_file_at,
                commands::fs::create_directory_at,
                commands::fs::rename_path,
                commands::fs::delete_path,
                commands::fs::duplicate_path,
                commands::fs::copy_path,
                commands::fs::reveal_in_file_manager,
                commands::fs::save_temp_image,
                commands::fs::write_to_clipboard,
                commands::terminal::spawn_terminal,
                commands::terminal::write_to_terminal,
                commands::terminal::resize_terminal,
                commands::terminal::scroll_terminal,
                commands::terminal::set_terminal_scroll_offset,
                commands::terminal::kill_terminal,
                commands::terminal::search_terminal,
                commands::terminal::get_terminal_cwd,
                commands::terminal::get_terminal_text_range,
                commands::terminal::install_claude_hook,
                commands::workspace::get_workspaces,
                commands::workspace::save_workspace,
                commands::workspace::delete_workspace,
                commands::workspace::close_workspace,
                commands::workspace::set_active_workspace_id,
                commands::workspace::reorder_workspaces,
                commands::workspace::add_allowed_root,
                commands::workspace::check_pid_alive,
                commands::workspace::register_window,
                commands::workspace::unregister_window,
                commands::workspace::get_secondary_window_labels,
                commands::settings::get_settings,
                commands::settings::update_settings,
                lsp::lsp_check,
                lsp::lsp_install,
                lsp::lsp_start,
                lsp::lsp_notify,
                lsp::lsp_request,
                commands::terminal::get_debug_stats,
            ] }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
