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
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
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
                is_dir: entry.path().is_dir(),
            });
        }
    }
    if let Some(parent) = std::path::Path::new(&path).parent() {
        items.insert(
            0,
            DirEntry {
                name: "..".to_string(),
                path: parent.to_string_lossy().into_owned(),
                is_dir: true,
            },
        );
    }
    Ok(items)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        return Err("Can't open a directory".to_string());
    }
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("File too large".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("Can't open a binary file".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "Can't open a binary file".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![current_dir, list_dir, read_text_file])
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
