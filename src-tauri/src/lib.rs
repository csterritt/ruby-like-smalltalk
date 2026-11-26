use tauri::{Manager, PhysicalSize};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
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
