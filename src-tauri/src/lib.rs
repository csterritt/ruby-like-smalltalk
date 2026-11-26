use tauri::{
    menu::{MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    Emitter, Manager, PhysicalSize,
};

#[tauri::command]
fn current_dir() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with('.') {
            items.push(DirEntry {
                name,
                path: entry.path().to_string_lossy().into_owned(),
            });
        }
    }
    Ok(items)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![current_dir, list_dir])
        .on_menu_event(|app, event| {
            if event.id() == "open" {
                let _ = app.emit("menu-open", ());
            }
        })
        .setup(|app| {
            let menu = tauri::menu::Menu::default(app.handle())?;
            let open_item =
                MenuItem::with_id(app, "open", "Open...", true, Some("CmdOrCtrl+O"))?;
            let mut file_menu = None;
            for item in menu.items()? {
                if let MenuItemKind::Submenu(s) = item {
                    if s.text()? == "File" {
                        file_menu = Some(s);
                        break;
                    }
                }
            }
            if let Some(file_menu) = file_menu {
                file_menu.insert(&open_item, 0)?;
                file_menu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
            } else {
                menu.insert(
                    &Submenu::with_items(app, "File", true, &[&open_item])?,
                    0,
                )?;
            }
            app.set_menu(menu)?;

            let window = app
                .get_webview_window("main")
                .expect("main window should exist");
            if let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) {
                let screen = monitor.size();
                window.set_size(PhysicalSize::new(screen.width * 3 / 5, screen.height * 3 / 5))?;
                window.center()?;
            }
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
