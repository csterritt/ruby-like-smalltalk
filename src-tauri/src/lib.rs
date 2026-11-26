use std::io::{BufRead, BufReader, ErrorKind, Seek, SeekFrom};
use std::sync::Mutex;

use tauri::{
    Emitter, Manager, PhysicalSize,
    menu::{MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
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

const LINE_INDEX_INTERVAL: usize = 128;

struct IndexedFile {
    reader: BufReader<std::fs::File>,
    offsets: Vec<u64>,
    line_count: usize,
}

#[derive(Default)]
struct PagerState {
    current: Option<(u64, IndexedFile)>,
    next_id: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedFile {
    file_id: u64,
    line_count: usize,
}

fn read_error(error: std::io::Error) -> String {
    if error.kind() == ErrorKind::InvalidData {
        "Can't open a binary file".to_string()
    } else {
        error.to_string()
    }
}

fn trim_line_end(mut line: String) -> String {
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
    line
}

fn index_lines<R: BufRead>(reader: &mut R) -> Result<(Vec<u64>, usize), String> {
    let mut offsets = Vec::new();
    let mut byte_offset = 0_u64;
    let mut line_count = 0_usize;
    let mut line = String::new();

    loop {
        let line_offset = byte_offset;
        line.clear();
        let bytes = reader.read_line(&mut line).map_err(read_error)?;
        if bytes == 0 {
            break;
        }
        if line.as_bytes().contains(&0) {
            return Err("Can't open a binary file".to_string());
        }
        if line_count % LINE_INDEX_INTERVAL == 0 {
            offsets.push(line_offset);
        }
        line_count += 1;
        byte_offset += bytes as u64;
    }

    Ok((offsets, line_count))
}

fn read_indexed_lines<R: BufRead + Seek>(
    reader: &mut R,
    offsets: &[u64],
    line_count: usize,
    indices: &[usize],
) -> Result<Vec<String>, String> {
    if indices.iter().any(|&index| index >= line_count) {
        return Err("Line index out of range".to_string());
    }

    let mut order: Vec<usize> = (0..indices.len()).collect();
    order.sort_by_key(|&position| indices[position]);
    let mut lines = vec![String::new(); indices.len()];
    let mut line = String::new();
    let mut order_pos = 0_usize;

    while order_pos < order.len() {
        let target = indices[order[order_pos]];
        let checkpoint = target / LINE_INDEX_INTERVAL;
        let mut current_line = checkpoint * LINE_INDEX_INTERVAL;
        reader
            .seek(SeekFrom::Start(offsets[checkpoint]))
            .map_err(|e| e.to_string())?;

        while current_line < target {
            line.clear();
            let bytes = reader.read_line(&mut line).map_err(read_error)?;
            if bytes == 0 {
                return Err("File changed while reading".to_string());
            }
            current_line += 1;
        }

        loop {
            line.clear();
            let bytes = reader.read_line(&mut line).map_err(read_error)?;
            if bytes == 0 {
                return Err("File changed while reading".to_string());
            }
            lines[order[order_pos]] = trim_line_end(std::mem::take(&mut line));
            current_line += 1;
            order_pos += 1;

            if order_pos >= order.len() || indices[order[order_pos]] != current_line {
                break;
            }
        }
    }

    Ok(lines)
}

fn scan_file(path: &str) -> Result<IndexedFile, String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        return Err("Can't open a directory".to_string());
    }

    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let (offsets, line_count) = index_lines(&mut reader)?;
    Ok(IndexedFile {
        reader,
        offsets,
        line_count,
    })
}

#[tauri::command(async)]
fn open_text_file(
    path: String,
    state: tauri::State<'_, Mutex<PagerState>>,
) -> Result<OpenedFile, String> {
    let indexed = scan_file(&path)?;
    let line_count = indexed.line_count;
    let mut pager = state
        .lock()
        .map_err(|_| "File pager state unavailable".to_string())?;
    pager.next_id += 1;
    let file_id = pager.next_id;
    pager.current = Some((file_id, indexed));
    Ok(OpenedFile {
        file_id,
        line_count,
    })
}

#[tauri::command(async)]
fn read_text_lines(
    file_id: u64,
    indices: Vec<usize>,
    state: tauri::State<'_, Mutex<PagerState>>,
) -> Result<Vec<String>, String> {
    let mut pager = state
        .lock()
        .map_err(|_| "File pager state unavailable".to_string())?;
    let Some((current_id, indexed)) = pager.current.as_mut() else {
        return Err("No file is open".to_string());
    };
    if *current_id != file_id {
        return Err("File is no longer open".to_string());
    }
    read_indexed_lines(
        &mut indexed.reader,
        &indexed.offsets,
        indexed.line_count,
        &indices,
    )
}

#[tauri::command(async)]
fn close_text_file(file_id: u64, state: tauri::State<'_, Mutex<PagerState>>) -> Result<(), String> {
    let mut pager = state
        .lock()
        .map_err(|_| "File pager state unavailable".to_string())?;
    if pager
        .current
        .as_ref()
        .is_some_and(|(current_id, _)| *current_id == file_id)
    {
        pager.current = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    fn read_lines(bytes: &[u8], indices: &[usize]) -> (usize, Vec<String>) {
        let mut cursor = BufReader::new(Cursor::new(bytes.to_vec()));
        let (offsets, line_count) = index_lines(&mut cursor).unwrap();
        let lines = read_indexed_lines(&mut cursor, &offsets, line_count, indices).unwrap();
        (line_count, lines)
    }

    #[test]
    fn reads_lines_through_sparse_seek_index() {
        let data = (0..300)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        let (line_count, lines) = read_lines(data.as_bytes(), &[0, 127, 128, 255, 299]);
        assert_eq!(line_count, 300);
        assert_eq!(
            lines,
            vec!["line 0", "line 127", "line 128", "line 255", "line 299"]
        );
    }

    #[test]
    fn matches_existing_line_count_and_crlf_behavior() {
        assert_eq!(read_lines(b"", &[]).0, 0);
        assert_eq!(read_lines(b"a\n", &[0]).0, 1);
        assert_eq!(read_lines(b"a\n\n", &[0, 1]).0, 2);

        let (line_count, lines) = read_lines(b"a\r\nb\r\n\r\nc", &[0, 1, 2, 3]);
        assert_eq!(line_count, 4);
        assert_eq!(lines, vec!["a", "b", "", "c"]);
    }

    #[test]
    fn rejects_binary_files() {
        let mut cursor = Cursor::new(vec![b'a', b'\n', 0xff]);
        assert_eq!(
            index_lines(&mut cursor).unwrap_err(),
            "Can't open a binary file"
        );

        let mut cursor = Cursor::new(vec![b'a', 0, b'\n']);
        assert_eq!(
            index_lines(&mut cursor).unwrap_err(),
            "Can't open a binary file"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(PagerState::default()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            current_dir,
            list_dir,
            open_text_file,
            read_text_lines,
            close_text_file
        ])
        .on_menu_event(|app, event| {
            if event.id() == "open" {
                let _ = app.emit("menu-open", ());
            }
        })
        .setup(|app| {
            let menu = tauri::menu::Menu::default(app.handle())?;
            let open_item = MenuItem::with_id(app, "open", "Open...", true, Some("CmdOrCtrl+O"))?;
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
                menu.insert(&Submenu::with_items(app, "File", true, &[&open_item])?, 0)?;
            }
            app.set_menu(menu)?;

            let window = app
                .get_webview_window("main")
                .expect("main window should exist");
            if let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) {
                let screen = monitor.size();
                window.set_size(PhysicalSize::new(
                    screen.width * 3 / 5,
                    screen.height * 3 / 5,
                ))?;
                window.center()?;
            }
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
