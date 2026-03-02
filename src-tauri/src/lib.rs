#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use std::{env, fs};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_fs::FsExt;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
fn set_window_opacity(_app: AppHandle, _opacity: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = _app.get_webview_window("main").ok_or("Window not found")?;
        let ns_win = window.ns_window().map_err(|e| e.to_string())?;
        unsafe {
            let _: () =
                objc::msg_send![ns_win as *mut objc::runtime::Object, setAlphaValue: _opacity];
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_macos_process_name(name: &str) {
    use std::ffi::CString;

    let Ok(c_name) = CString::new(name) else {
        return;
    };

    unsafe {
        let ns_string_class = match objc::runtime::Class::get("NSString") {
            Some(class) => class,
            None => return,
        };
        let allocated: *mut objc::runtime::Object = objc::msg_send![ns_string_class, alloc];
        let ns_name: *mut objc::runtime::Object =
            objc::msg_send![allocated, initWithUTF8String:c_name.as_ptr()];

        let process_info_class = match objc::runtime::Class::get("NSProcessInfo") {
            Some(class) => class,
            None => return,
        };
        let process_info: *mut objc::runtime::Object =
            objc::msg_send![process_info_class, processInfo];
        let _: () = objc::msg_send![process_info, setProcessName: ns_name];
    }
}

#[tauri::command]
fn read_markdown_file(path: String) -> Result<Option<String>, String> {
    let normalized_path = path.trim();
    if normalized_path.is_empty() {
        return Ok(None);
    }

    match fs::read_to_string(normalized_path) {
        Ok(content) => Ok(Some(content)),
        Err(err) => {
            if err.kind() == std::io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(err.to_string())
            }
        }
    }
}

#[tauri::command]
fn write_markdown_file(path: String, content: String) -> Result<(), String> {
    let normalized_path = path.trim();
    if normalized_path.is_empty() {
        return Ok(());
    }

    let target = PathBuf::from(normalized_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::write(target, content).map_err(|e| e.to_string())
}

fn should_skip_dir(name: &str) -> bool {
    if name.starts_with('.') && name != ".obsidian" {
        return true;
    }
    matches!(
        name,
        "Library"
            | "Applications"
            | "Movies"
            | "Pictures"
            | "Music"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianSettingsDetection {
    daily_logs_folder: String,
    excalidraw_folder: String,
    assets_folder: String,
    filename_pattern: String,
}

fn normalize_folder(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed == "/" || trimmed == "./" || trimmed == "." {
        return ".".to_string();
    }

    let without_prefix = trimmed.trim_start_matches("./").trim_start_matches('/');
    without_prefix.trim_end_matches('/').to_string()
}

fn read_json_file(path: &PathBuf) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn get_string(value: &Value, key: &str) -> Option<String> {
    let text = value.get(key)?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn map_obsidian_date_format_to_filename_pattern(format: &str) -> String {
    let mut cleaned = String::new();
    let mut bracket_depth = 0;
    for ch in format.trim().chars() {
        if ch == '[' {
            bracket_depth += 1;
            continue;
        }
        if ch == ']' {
            bracket_depth = (bracket_depth - 1).max(0);
            continue;
        }
        if bracket_depth >= 0 {
            cleaned.push(ch);
        }
    }

    if cleaned.trim().is_empty() {
        return String::new();
    }

    let chars: Vec<char> = cleaned.chars().collect();
    let mut output = String::new();
    let mut i = 0;
    let mut seen_year = false;
    let mut seen_month = false;
    let mut seen_day = false;

    while i < chars.len() {
        let ch = chars[i];
        let is_token_char = matches!(ch, 'Y' | 'y' | 'M' | 'D' | 'd');
        if !is_token_char {
            output.push(ch);
            i += 1;
            continue;
        }

        let mut j = i + 1;
        while j < chars.len() && chars[j] == ch {
            j += 1;
        }
        let token: String = chars[i..j].iter().collect();
        match token.as_str() {
            "YYYY" | "yyyy" => {
                output.push_str("{YYYY}");
                seen_year = true;
            }
            "MM" => {
                output.push_str("{MM}");
                seen_month = true;
            }
            "DD" | "dd" => {
                output.push_str("{DD}");
                seen_day = true;
            }
            _ => {
                return String::new();
            }
        }
        i = j;
    }

    if seen_year && seen_month && seen_day {
        output
    } else {
        String::new()
    }
}

fn contains_case_insensitive(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

fn ensure_folder_in_vault(vault_dir: &Path, folder: &str) -> Result<(), String> {
    let normalized = normalize_folder(folder);
    if normalized.is_empty() || normalized == "." {
        return Ok(());
    }
    fs::create_dir_all(vault_dir.join(normalized)).map_err(|e| e.to_string())
}

fn write_json_file(path: &Path, value: Value) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(path, serialized).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownSearchResult {
    path: String,
    relative_path: String,
    title: String,
    snippet: String,
}

fn truncate_chars(input: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let mut chars = input.chars();
    let taken: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{taken}...")
    } else {
        taken
    }
}

fn extract_markdown_title(path: &Path, content: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('#') {
            continue;
        }
        let heading = trimmed.trim_start_matches('#').trim();
        if !heading.is_empty() {
            return truncate_chars(heading, 80);
        }
    }
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| truncate_chars(stem, 80))
        .unwrap_or_else(|| "Untitled".to_string())
}

fn should_skip_search_dir(name: &str) -> bool {
    should_skip_dir(name) || name == ".obsidian"
}

fn normalize_mtime(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn ensure_search_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS search_docs (
            path TEXT PRIMARY KEY,
            root_dir TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            mtime INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_search_docs_root_dir ON search_docs(root_dir);
        CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_fts USING fts5(
            path UNINDEXED,
            relative_path,
            title,
            content,
            content='search_docs',
            content_rowid='rowid',
            tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
            INSERT INTO search_docs_fts(rowid, path, relative_path, title, content)
            VALUES (new.rowid, new.path, new.relative_path, new.title, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
            INSERT INTO search_docs_fts(search_docs_fts, rowid, path, relative_path, title, content)
            VALUES ('delete', old.rowid, old.path, old.relative_path, old.title, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
            INSERT INTO search_docs_fts(search_docs_fts, rowid, path, relative_path, title, content)
            VALUES ('delete', old.rowid, old.path, old.relative_path, old.title, old.content);
            INSERT INTO search_docs_fts(rowid, path, relative_path, title, content)
            VALUES (new.rowid, new.path, new.relative_path, new.title, new.content);
        END;
        "#,
    )
    .map_err(|e| e.to_string())
}

fn build_fts_query(query: &str) -> Option<String> {
    let parts: Vec<String> = query
        .split_whitespace()
        .map(|part| {
            part.chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
        })
        .filter(|part| !part.is_empty())
        .map(|part| format!("{part}*"))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" AND "))
    }
}

fn ensure_search_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    Ok(app_data_dir.join("search-index.sqlite3"))
}

fn refresh_markdown_index(conn: &mut Connection, root: &Path) -> Result<(), String> {
    let root_key = root.to_string_lossy().to_string();
    let mut existing: HashMap<String, i64> = HashMap::new();

    {
        let mut stmt = conn
            .prepare("SELECT path, mtime FROM search_docs WHERE root_dir = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![&root_key]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let path: String = row.get(0).map_err(|e| e.to_string())?;
            let mtime: i64 = row.get(1).map_err(|e| e.to_string())?;
            existing.insert(path, mtime);
        }
    }

    let mut seen_paths: HashSet<String> = HashSet::new();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries {
            let entry = match entry {
                Ok(value) => value,
                Err(_) => continue,
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(value) => value,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();

            if file_type.is_dir() {
                if should_skip_search_dir(&name) {
                    continue;
                }
                stack.push(path);
                continue;
            }

            if !file_type.is_file() {
                continue;
            }
            if !path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
            {
                continue;
            }

            let absolute_path = path.to_string_lossy().to_string();
            seen_paths.insert(absolute_path.clone());
            let mtime = normalize_mtime(&path);

            if existing.get(&absolute_path) == Some(&mtime) {
                continue;
            }

            let content = match fs::read_to_string(&path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let relative_path = path
                .strip_prefix(root)
                .ok()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| absolute_path.clone());
            let title = extract_markdown_title(&path, &content);

            tx.execute(
                r#"
                INSERT INTO search_docs(path, root_dir, relative_path, title, content, mtime)
                VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(path) DO UPDATE SET
                    root_dir = excluded.root_dir,
                    relative_path = excluded.relative_path,
                    title = excluded.title,
                    content = excluded.content,
                    mtime = excluded.mtime
                "#,
                params![absolute_path, &root_key, relative_path, title, content, mtime],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    for stale_path in existing.keys().filter(|path| !seen_paths.contains(*path)) {
        tx.execute(
            "DELETE FROM search_docs WHERE path = ?1 AND root_dir = ?2",
            params![stale_path, &root_key],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn search_markdown_files(
    app: AppHandle,
    root_dir: String,
    query: String,
    limit: Option<u16>,
) -> Result<Vec<MarkdownSearchResult>, String> {
    let normalized_root = root_dir.trim();
    if normalized_root.is_empty() {
        return Ok(Vec::new());
    }

    let normalized_query = query.trim();
    if normalized_query.is_empty() {
        return Ok(Vec::new());
    }
    let Some(fts_query) = build_fts_query(normalized_query) else {
        return Ok(Vec::new());
    };

    let root_path = PathBuf::from(normalized_root);
    if !root_path.exists() || !root_path.is_dir() {
        return Ok(Vec::new());
    }
    let root = fs::canonicalize(&root_path).map_err(|e| e.to_string())?;
    let root_key = root.to_string_lossy().to_string();

    let clamped_limit = limit.unwrap_or(80).clamp(1, 500) as usize;
    let search_db = ensure_search_db_path(&app)?;
    let mut conn = Connection::open(search_db).map_err(|e| e.to_string())?;
    ensure_search_schema(&conn)?;
    refresh_markdown_index(&mut conn, &root)?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                search_docs.path,
                search_docs.relative_path,
                search_docs.title,
                snippet(search_docs_fts, 3, '[', ']', ' ... ', 16)
            FROM search_docs_fts
            JOIN search_docs ON search_docs_fts.rowid = search_docs.rowid
            WHERE search_docs.root_dir = ?1 AND search_docs_fts MATCH ?2
            ORDER BY bm25(search_docs_fts, 0.2, 0.4, 3.0, 1.0)
            LIMIT ?3
            "#,
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(
            params![root_key, fts_query, clamped_limit as i64],
            |row| {
                Ok(MarkdownSearchResult {
                    path: row.get(0)?,
                    relative_path: row.get(1)?,
                    title: row.get(2)?,
                    snippet: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for result in rows {
        results.push(result.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

#[tauri::command]
fn detect_obsidian_settings(vault_dir: String) -> ObsidianSettingsDetection {
    if vault_dir.trim().is_empty() {
        return ObsidianSettingsDetection {
            daily_logs_folder: String::new(),
            excalidraw_folder: String::new(),
            assets_folder: String::new(),
            filename_pattern: String::new(),
        };
    }

    let obsidian_dir = PathBuf::from(vault_dir).join(".obsidian");
    let daily_notes = read_json_file(&obsidian_dir.join("daily-notes.json"));
    let periodic_notes = read_json_file(&obsidian_dir.join("plugins/periodic-notes/data.json"));
    let app = read_json_file(&obsidian_dir.join("app.json"));
    let excalidraw = read_json_file(&obsidian_dir.join("plugins/obsidian-excalidraw-plugin/data.json"));

    let mut daily_logs_folder = String::new();
    let mut filename_pattern = String::new();

    if let Some(daily_notes_value) = daily_notes.as_ref() {
        if let Some(folder) = get_string(daily_notes_value, "folder") {
            daily_logs_folder = normalize_folder(&folder);
        }
        if let Some(format) = get_string(daily_notes_value, "format") {
            filename_pattern = map_obsidian_date_format_to_filename_pattern(&format);
        }
    }

    if let Some(periodic_notes_value) = periodic_notes.as_ref().and_then(|v| v.get("daily")) {
        if daily_logs_folder.is_empty() {
            if let Some(folder) = periodic_notes_value.get("folder").and_then(|v| v.as_str()) {
                daily_logs_folder = normalize_folder(folder);
            }
        }
        if filename_pattern.is_empty() {
            if let Some(format) = periodic_notes_value.get("format").and_then(|v| v.as_str()) {
                filename_pattern = map_obsidian_date_format_to_filename_pattern(format);
            }
        }
    }

    let assets_folder = app
        .as_ref()
        .and_then(|v| get_string(v, "attachmentFolderPath"))
        .map(|value| normalize_folder(&value))
        .unwrap_or_default();

    let mut excalidraw_folder = String::new();
    if let Some(excalidraw_value) = excalidraw.as_ref() {
        for key in ["folder", "excalidrawFolder", "drawingFolder", "drawingFolderPath", "folderPath"] {
            if let Some(value) = get_string(excalidraw_value, key) {
                excalidraw_folder = normalize_folder(&value);
                break;
            }
        }

        if excalidraw_folder.is_empty() {
            if let Some(obj) = excalidraw_value.as_object() {
                for (key, value) in obj {
                    let Some(text) = value.as_str() else { continue; };
                    if !(contains_case_insensitive(key, "folder")
                        || contains_case_insensitive(key, "path")
                        || contains_case_insensitive(key, "dir"))
                    {
                        continue;
                    }
                    if contains_case_insensitive(key, "excalidraw")
                        || contains_case_insensitive(text, "excalidraw")
                    {
                        excalidraw_folder = normalize_folder(text);
                        break;
                    }
                }
            }
        }
    }

    ObsidianSettingsDetection {
        daily_logs_folder,
        excalidraw_folder,
        assets_folder,
        filename_pattern,
    }
}

#[tauri::command]
fn bootstrap_obsidian_vault(
    vault_dir: String,
    daily_logs_folder: String,
    excalidraw_folder: String,
    assets_folder: String,
) -> Result<(), String> {
    let normalized_vault = vault_dir.trim();
    if normalized_vault.is_empty() {
        return Ok(());
    }

    let vault_path = PathBuf::from(normalized_vault);
    let obsidian_dir = vault_path.join(".obsidian");
    if obsidian_dir.exists() {
        return Ok(());
    }

    fs::create_dir_all(&obsidian_dir).map_err(|e| e.to_string())?;

    let normalized_daily = normalize_folder(&daily_logs_folder);
    let normalized_excalidraw = normalize_folder(&excalidraw_folder);
    let normalized_assets = normalize_folder(&assets_folder);

    ensure_folder_in_vault(&vault_path, &normalized_daily)?;
    ensure_folder_in_vault(&vault_path, &normalized_excalidraw)?;
    ensure_folder_in_vault(&vault_path, &normalized_assets)?;

    if !normalized_daily.is_empty() && normalized_daily != "." {
        write_json_file(
            &obsidian_dir.join("daily-notes.json"),
            json!({
                "format": "YYYY-MM-DD",
                "folder": normalized_daily,
                "template": ""
            }),
        )?;
    }

    if !normalized_assets.is_empty() && normalized_assets != "." {
        write_json_file(
            &obsidian_dir.join("app.json"),
            json!({
                "attachmentFolderPath": normalized_assets
            }),
        )?;
    }

    if !normalized_excalidraw.is_empty() && normalized_excalidraw != "." {
        let plugin_dir = obsidian_dir.join("plugins/obsidian-excalidraw-plugin");
        fs::create_dir_all(&plugin_dir).map_err(|e| e.to_string())?;
        write_json_file(
            &plugin_dir.join("data.json"),
            json!({
                "folder": normalized_excalidraw
            }),
        )?;
    }

    Ok(())
}

#[tauri::command]
fn find_obsidian_vaults() -> Result<Vec<String>, String> {
    let home = env::var("HOME").map_err(|_| "Could not resolve HOME directory".to_string())?;
    let mut vaults: Vec<String> = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(PathBuf::from(home), 0)];
    let max_depth = 5usize;
    let max_vaults = 25usize;

    while let Some((dir, depth)) = stack.pop() {
        if depth > max_depth {
            continue;
        }

        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        let mut has_obsidian = false;
        let mut children: Vec<PathBuf> = Vec::new();

        for entry_result in entries {
            let entry = match entry_result {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if !file_type.is_dir() {
                continue;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".obsidian" {
                has_obsidian = true;
                break;
            }
            if should_skip_dir(&name) {
                continue;
            }
            children.push(entry.path());
        }

        if has_obsidian {
            vaults.push(dir.to_string_lossy().to_string());
            if vaults.len() >= max_vaults {
                break;
            }
            continue;
        }

        if depth < max_depth {
            for child in children {
                stack.push((child, depth + 1));
            }
        }
    }

    vaults.sort();
    vaults.dedup();
    Ok(vaults)
}

#[tauri::command]
fn extend_fs_scope(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    // Extend fs plugin scope
    app.fs_scope()
        .allow_directory(&p, true)
        .map_err(|e| e.to_string())?;
    // Extend asset protocol scope
    app.asset_protocol_scope()
        .allow_directory(&p, true)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            extend_fs_scope,
            find_obsidian_vaults,
            detect_obsidian_settings,
            bootstrap_obsidian_vault,
            read_markdown_file,
            write_markdown_file,
            set_window_opacity,
            search_markdown_files
        ])
        .setup(|app| {
            let app_name = if cfg!(debug_assertions) {
                "Philo Dev"
            } else {
                "Philo"
            };
            let about_title = if cfg!(debug_assertions) {
                "About Philo Dev"
            } else {
                "About Philo"
            };
            #[cfg(target_os = "macos")]
            if cfg!(debug_assertions) {
                set_macos_process_name(app_name);
            }

            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let settings = MenuItemBuilder::with_id("settings", "Settings...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let library = MenuItemBuilder::with_id("library", "Widget Library")
                .accelerator("CmdOrCtrl+J")
                .build(app)?;

            let global_search = MenuItemBuilder::with_id("global-search", "Global Search")
                .accelerator("CmdOrCtrl+F")
                .build(app)?;

            let check_updates =
                MenuItemBuilder::with_id("check-updates", "Check for Updates...").build(app)?;

            let app_menu = SubmenuBuilder::new(app, app_name)
                .item(&PredefinedMenuItem::about(app, Some(about_title), None)?)
                .item(&check_updates)
                .separator()
                .item(&settings)
                .item(&library)
                .item(&global_search)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .close_window()
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(move |app_handle, event| {
                if event.id() == "settings" {
                    let _ = app_handle.emit("open-settings", ());
                } else if event.id() == "library" {
                    let _ = app_handle.emit("toggle-library", ());
                } else if event.id() == "global-search" {
                    let _ = app_handle.emit("open-global-search", ());
                } else if event.id() == "check-updates" {
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        match handle.updater() {
                            Ok(updater) => match updater.check().await {
                                Ok(Some(_)) => {
                                    let _ = handle.emit("update-available", ());
                                }
                                Ok(None) => {
                                    handle
                                        .dialog()
                                        .message("You're running the latest version.")
                                        .title("No Updates Available")
                                        .kind(MessageDialogKind::Info)
                                        .blocking_show();
                                }
                                Err(e) => {
                                    handle
                                        .dialog()
                                        .message(format!("Could not check for updates: {}", e))
                                        .title("Update Error")
                                        .kind(MessageDialogKind::Error)
                                        .blocking_show();
                                }
                            },
                            Err(e) => {
                                handle
                                    .dialog()
                                    .message(format!("Updater not available: {}", e))
                                    .title("Update Error")
                                    .kind(MessageDialogKind::Error)
                                    .blocking_show();
                            }
                        }
                    });
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
