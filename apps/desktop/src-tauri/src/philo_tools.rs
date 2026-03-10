use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::UNIX_EPOCH;

const DEFAULT_FILENAME_PATTERN: &str = "{YYYY}-{MM}-{DD}";

#[derive(Clone, Debug, Deserialize, Default)]
pub struct PhiloSettings {
    #[serde(default)]
    pub journal_dir: String,
    #[serde(default)]
    pub filename_pattern: String,
    #[serde(default)]
    pub vault_dir: String,
    #[serde(default)]
    pub daily_logs_folder: String,
}

#[derive(Clone, Debug)]
pub struct NoteContext {
    pub settings_path: PathBuf,
    pub journal_dir: PathBuf,
    pub filename_pattern: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCommandOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteEnvelope {
    note: NoteRecord,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchEnvelope {
    hits: Vec<SearchHit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEnvelope {
    change: NoteChange,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedEnvelope {
    applied: Vec<AppliedNote>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub date: String,
    pub city: Option<String>,
    pub markdown: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub date: String,
    pub title: String,
    pub snippet: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteChange {
    pub date: String,
    pub before_markdown: String,
    pub after_markdown: String,
    pub unified_diff: String,
    pub city_before: Option<String>,
    pub city_after: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedNote {
    pub date: String,
    pub path: String,
}

#[derive(Clone, Debug)]
pub enum ToolCommand {
    Philo {
        argv: Vec<String>,
        stdin: Option<String>,
    },
    SafeShell {
        command: String,
        args: Vec<String>,
    },
}

#[derive(Clone, Debug)]
enum ParsedCommand {
    Search { query: String, limit: usize },
    Read { date: String },
    Create { date: String },
    Update { date: String, apply: bool },
    Delete { date: String },
}

fn default_settings_path() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("PHILO_SETTINGS_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let home = env::var("HOME").map_err(|_| "Could not resolve HOME directory".to_string())?;
    let base_dir = if cfg!(debug_assertions) {
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("com.philo.dev")
    } else {
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("philo")
    };

    Ok(base_dir.join("settings.json"))
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

fn join_paths(base: &Path, extra: &str) -> PathBuf {
    base.join(extra)
}

pub fn resolve_note_context() -> Result<NoteContext, String> {
    let settings_path = default_settings_path()?;
    let raw = fs::read_to_string(&settings_path).map_err(|e| {
        format!(
            "Could not read settings at {}: {}",
            settings_path.display(),
            e
        )
    })?;
    let settings: PhiloSettings =
        serde_json::from_str(&raw).map_err(|e| format!("Could not parse settings: {}", e))?;

    let mut journal_dir = settings.journal_dir.trim().to_string();
    if journal_dir.is_empty() {
        let vault_dir = settings.vault_dir.trim();
        if !vault_dir.is_empty() {
            let daily_logs_folder = normalize_folder(&settings.daily_logs_folder);
            let root = PathBuf::from(vault_dir);
            journal_dir = if daily_logs_folder.is_empty() || daily_logs_folder == "." {
                root.to_string_lossy().to_string()
            } else {
                join_paths(&root, &daily_logs_folder)
                    .to_string_lossy()
                    .to_string()
            };
        }
    }

    if journal_dir.trim().is_empty() {
        return Err("Journal is not configured.".to_string());
    }

    let filename_pattern = if settings.filename_pattern.trim().is_empty() {
        DEFAULT_FILENAME_PATTERN.to_string()
    } else {
        settings.filename_pattern.trim().to_string()
    };

    Ok(NoteContext {
        settings_path,
        journal_dir: PathBuf::from(journal_dir),
        filename_pattern,
    })
}

fn apply_filename_pattern(pattern: &str, date: &str) -> Result<String, String> {
    let [yyyy, mm, dd] = date
        .split('-')
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| format!("Invalid date: {}", date))?;

    Ok(pattern
        .replace("{YYYY}", yyyy)
        .replace("{MM}", mm)
        .replace("{DD}", dd))
}

fn escape_regex(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        if matches!(
            ch,
            '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn parse_date_from_relative_path(relative_path: &str, pattern: &str) -> Option<String> {
    let normalized = relative_path
        .trim()
        .trim_matches('/')
        .trim_end_matches(".md");
    if normalized.is_empty() {
        return None;
    }

    let mut regex_source = String::new();
    let mut token_order: Vec<&str> = Vec::new();
    let mut cursor = 0;

    for token in ["{YYYY}", "{MM}", "{DD}"] {
        let _ = token;
    }

    for matched in pattern.match_indices('{') {
        let start = matched.0;
        if start < cursor {
            continue;
        }

        let rest = &pattern[start..];
        let Some(end_offset) = rest.find('}') else {
            break;
        };
        let end = start + end_offset + 1;
        regex_source.push_str(&escape_regex(&pattern[cursor..start]));

        let token = &pattern[start..end];
        match token {
            "{YYYY}" => {
                regex_source.push_str("(\\d{4})");
                token_order.push("YYYY");
            }
            "{MM}" => {
                regex_source.push_str("(\\d{2})");
                token_order.push("MM");
            }
            "{DD}" => {
                regex_source.push_str("(\\d{2})");
                token_order.push("DD");
            }
            _ => {
                regex_source.push_str(&escape_regex(token));
            }
        }

        cursor = end;
    }

    regex_source.push_str(&escape_regex(&pattern[cursor..]));
    let regex = regex::Regex::new(&format!("^{}$", regex_source)).ok()?;
    let captures = regex.captures(normalized)?;

    let mut yyyy = None;
    let mut mm = None;
    let mut dd = None;
    for (index, token) in token_order.iter().enumerate() {
        let value = captures.get(index + 1)?.as_str().to_string();
        match *token {
            "YYYY" => yyyy = Some(value),
            "MM" => mm = Some(value),
            "DD" => dd = Some(value),
            _ => {}
        }
    }

    Some(format!("{}-{}-{}", yyyy?, mm?, dd?,))
}

fn note_path(context: &NoteContext, date: &str) -> Result<PathBuf, String> {
    let relative = apply_filename_pattern(&context.filename_pattern, date)?;
    Ok(context.journal_dir.join(format!("{}.md", relative)))
}

fn parse_frontmatter(raw: &str) -> (Option<String>, String) {
    let frontmatter_re =
        regex::Regex::new(r"(?s)^---\n(.*?)\n---\n?").expect("valid frontmatter regex");
    let Some(matched) = frontmatter_re.find(raw) else {
        return (None, raw.to_string());
    };
    let frontmatter = &raw[matched.start()..matched.end()];
    let body = raw[matched.end()..].to_string();
    let city_re = regex::Regex::new(r"(?m)^city:\s*(.+)$").expect("valid city regex");
    let city = city_re
        .captures(frontmatter)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_string());
    (city, body)
}

fn build_frontmatter(city: Option<&str>, body: &str) -> String {
    match city {
        Some(value) if !value.trim().is_empty() => {
            format!("---\ncity: {}\n---\n{}", value.trim(), body)
        }
        _ => body.to_string(),
    }
}

fn read_note(context: &NoteContext, date: &str) -> Result<Option<NoteRecord>, String> {
    let path = note_path(context, date)?;
    let raw = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    let (city, markdown) = parse_frontmatter(&raw);
    Ok(Some(NoteRecord {
        date: date.to_string(),
        city,
        markdown,
        path: path.to_string_lossy().to_string(),
    }))
}

fn write_note(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::write(path, content).map_err(|e| e.to_string())
}

fn create_note(context: &NoteContext, date: &str) -> Result<NoteRecord, String> {
    let path = note_path(context, date)?;
    if path.exists() {
        return read_note(context, date)?
            .ok_or_else(|| "Could not load existing note.".to_string());
    }

    write_note(&path, "")?;
    Ok(NoteRecord {
        date: date.to_string(),
        city: None,
        markdown: String::new(),
        path: path.to_string_lossy().to_string(),
    })
}

fn build_unified_diff(before: &str, after: &str) -> String {
    similar::TextDiff::from_lines(before, after)
        .unified_diff()
        .context_radius(3)
        .header("before", "after")
        .to_string()
}

fn update_note(
    context: &NoteContext,
    date: &str,
    markdown: &str,
    apply: bool,
) -> Result<NoteChange, String> {
    let existing = read_note(context, date)?;
    let Some(before) = existing else {
        return Err(format!("Note {} does not exist.", date));
    };
    let change = NoteChange {
        date: date.to_string(),
        before_markdown: before.markdown.clone(),
        after_markdown: markdown.to_string(),
        unified_diff: build_unified_diff(&before.markdown, markdown),
        city_before: before.city.clone(),
        city_after: before.city.clone(),
    };

    if apply {
        let path = note_path(context, date)?;
        let serialized = build_frontmatter(before.city.as_deref(), markdown);
        write_note(&path, &serialized)?;
    }

    Ok(change)
}

fn delete_note(context: &NoteContext, date: &str) -> Result<AppliedNote, String> {
    let path = note_path(context, date)?;
    if !path.exists() {
        return Err(format!("Note {} does not exist.", date));
    }
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(AppliedNote {
        date: date.to_string(),
        path: path.to_string_lossy().to_string(),
    })
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
    name.starts_with('.') && name != ".obsidian"
        || matches!(name, "node_modules" | "target" | "dist" | "build")
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
            mtime INTEGER NOT NULL,
            note_date TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_search_docs_root_dir ON search_docs(root_dir);
        CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_fts USING fts5(
            path UNINDEXED,
            relative_path,
            title,
            content,
            note_date UNINDEXED,
            content='search_docs',
            content_rowid='rowid',
            tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
            INSERT INTO search_docs_fts(rowid, path, relative_path, title, content, note_date)
            VALUES (new.rowid, new.path, new.relative_path, new.title, new.content, new.note_date);
        END;
        CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
            INSERT INTO search_docs_fts(search_docs_fts, rowid, path, relative_path, title, content, note_date)
            VALUES ('delete', old.rowid, old.path, old.relative_path, old.title, old.content, old.note_date);
        END;
        CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
            INSERT INTO search_docs_fts(search_docs_fts, rowid, path, relative_path, title, content, note_date)
            VALUES ('delete', old.rowid, old.path, old.relative_path, old.title, old.content, old.note_date);
            INSERT INTO search_docs_fts(rowid, path, relative_path, title, content, note_date)
            VALUES (new.rowid, new.path, new.relative_path, new.title, new.content, new.note_date);
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

fn ensure_search_db_path(settings_path: &Path) -> Result<PathBuf, String> {
    let Some(base_dir) = settings_path.parent() else {
        return Err("Settings path has no parent directory.".to_string());
    };
    fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
    Ok(base_dir.join("search-index.sqlite3"))
}

fn refresh_markdown_index(conn: &mut Connection, context: &NoteContext) -> Result<(), String> {
    let root = fs::canonicalize(&context.journal_dir).map_err(|e| e.to_string())?;
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

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut stack: Vec<PathBuf> = vec![root.clone()];

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries {
            let Ok(entry) = entry else {
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
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

            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let relative_path = path
                .strip_prefix(&root)
                .ok()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| absolute_path.clone());
            let note_date =
                parse_date_from_relative_path(&relative_path, &context.filename_pattern);
            let title = extract_markdown_title(&path, &content);

            tx.execute(
                r#"
                INSERT INTO search_docs(path, root_dir, relative_path, title, content, mtime, note_date)
                VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(path) DO UPDATE SET
                    root_dir = excluded.root_dir,
                    relative_path = excluded.relative_path,
                    title = excluded.title,
                    content = excluded.content,
                    mtime = excluded.mtime,
                    note_date = excluded.note_date
                "#,
                params![
                    absolute_path,
                    &root_key,
                    relative_path,
                    title,
                    content,
                    mtime,
                    note_date,
                ],
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

fn search_notes(
    context: &NoteContext,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, String> {
    let normalized_query = query.trim();
    if normalized_query.is_empty() {
        return Ok(Vec::new());
    }
    let Some(fts_query) = build_fts_query(normalized_query) else {
        return Ok(Vec::new());
    };

    let search_db = ensure_search_db_path(&context.settings_path)?;
    let mut conn = Connection::open(search_db).map_err(|e| e.to_string())?;
    ensure_search_schema(&conn)?;
    refresh_markdown_index(&mut conn, context)?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                title,
                snippet(search_docs_fts, 3, '[', ']', ' ... ', 16),
                path,
                note_date
            FROM search_docs_fts
            JOIN search_docs ON search_docs_fts.rowid = search_docs.rowid
            WHERE search_docs.root_dir = ?1
              AND search_docs_fts MATCH ?2
              AND search_docs.note_date IS NOT NULL
            ORDER BY bm25(search_docs_fts, 0.2, 0.4, 3.0, 1.0)
            LIMIT ?3
            "#,
        )
        .map_err(|e| e.to_string())?;

    let root_key = fs::canonicalize(&context.journal_dir)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    let rows = stmt
        .query_map(params![root_key, fts_query, limit as i64], |row| {
            Ok(SearchHit {
                title: row.get(0)?,
                snippet: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                path: row.get(2)?,
                date: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut hits = Vec::new();
    for row in rows {
        hits.push(row.map_err(|e| e.to_string())?);
    }
    Ok(hits)
}

fn parse_limit(args: &[String], index: usize) -> Result<usize, String> {
    args.get(index)
        .ok_or_else(|| "Missing limit value.".to_string())?
        .parse::<usize>()
        .map_err(|_| "Invalid limit value.".to_string())
}

fn parse_command(argv: &[String]) -> Result<ParsedCommand, String> {
    if argv.is_empty() {
        return Err("Missing philo subcommand.".to_string());
    }

    if argv[0] != "note" {
        return Err(format!("Unsupported subcommand: {}", argv[0]));
    }
    if argv.len() < 2 {
        return Err("Missing note action.".to_string());
    }

    match argv[1].as_str() {
        "search" => {
            let mut query = None;
            let mut limit = 8usize;
            let mut index = 2usize;
            while index < argv.len() {
                match argv[index].as_str() {
                    "--query" => {
                        query = argv.get(index + 1).cloned();
                        index += 2;
                    }
                    "--limit" => {
                        limit = parse_limit(argv, index + 1)?;
                        index += 2;
                    }
                    "--json" => index += 1,
                    other => return Err(format!("Unsupported flag for note search: {}", other)),
                }
            }
            Ok(ParsedCommand::Search {
                query: query.ok_or_else(|| "Missing --query.".to_string())?,
                limit,
            })
        }
        "read" => {
            let mut date = None;
            let mut index = 2usize;
            while index < argv.len() {
                match argv[index].as_str() {
                    "--date" => {
                        date = argv.get(index + 1).cloned();
                        index += 2;
                    }
                    "--json" => index += 1,
                    other => return Err(format!("Unsupported flag for note read: {}", other)),
                }
            }
            Ok(ParsedCommand::Read {
                date: date.ok_or_else(|| "Missing --date.".to_string())?,
            })
        }
        "create" => {
            let mut date = None;
            let mut index = 2usize;
            while index < argv.len() {
                match argv[index].as_str() {
                    "--date" => {
                        date = argv.get(index + 1).cloned();
                        index += 2;
                    }
                    "--json" => index += 1,
                    other => return Err(format!("Unsupported flag for note create: {}", other)),
                }
            }
            Ok(ParsedCommand::Create {
                date: date.ok_or_else(|| "Missing --date.".to_string())?,
            })
        }
        "update" => {
            let mut date = None;
            let mut apply = false;
            let mut dry_run = false;
            let mut index = 2usize;
            while index < argv.len() {
                match argv[index].as_str() {
                    "--date" => {
                        date = argv.get(index + 1).cloned();
                        index += 2;
                    }
                    "--apply" => {
                        apply = true;
                        index += 1;
                    }
                    "--dry-run" => {
                        dry_run = true;
                        index += 1;
                    }
                    "--json" => index += 1,
                    other => return Err(format!("Unsupported flag for note update: {}", other)),
                }
            }

            if apply == dry_run {
                return Err("Use exactly one of --dry-run or --apply.".to_string());
            }

            Ok(ParsedCommand::Update {
                date: date.ok_or_else(|| "Missing --date.".to_string())?,
                apply,
            })
        }
        "delete" => {
            let mut date = None;
            let mut index = 2usize;
            while index < argv.len() {
                match argv[index].as_str() {
                    "--date" => {
                        date = argv.get(index + 1).cloned();
                        index += 2;
                    }
                    "--json" => index += 1,
                    other => return Err(format!("Unsupported flag for note delete: {}", other)),
                }
            }
            Ok(ParsedCommand::Delete {
                date: date.ok_or_else(|| "Missing --date.".to_string())?,
            })
        }
        other => Err(format!("Unsupported note action: {}", other)),
    }
}

pub fn run_philo_command(argv: &[String], stdin: Option<String>) -> Result<String, String> {
    let context = resolve_note_context()?;
    let command = parse_command(argv)?;
    let value = match command {
        ParsedCommand::Search { query, limit } => serde_json::to_string(&SearchEnvelope {
            hits: search_notes(&context, &query, limit.min(20))?,
        }),
        ParsedCommand::Read { date } => {
            let note = read_note(&context, &date)?
                .ok_or_else(|| format!("Note {} does not exist.", date))?;
            serde_json::to_string(&NoteEnvelope { note })
        }
        ParsedCommand::Create { date } => serde_json::to_string(&NoteEnvelope {
            note: create_note(&context, &date)?,
        }),
        ParsedCommand::Update { date, apply } => {
            let markdown =
                stdin.ok_or_else(|| "Note update requires stdin markdown.".to_string())?;
            if apply {
                let change = update_note(&context, &date, &markdown, true)?;
                serde_json::to_string(&AppliedEnvelope {
                    applied: vec![AppliedNote {
                        date,
                        path: note_path(&context, &change.date)?
                            .to_string_lossy()
                            .to_string(),
                    }],
                })
            } else {
                serde_json::to_string(&UpdateEnvelope {
                    change: update_note(&context, &date, &markdown, false)?,
                })
            }
        }
        ParsedCommand::Delete { date } => serde_json::to_string(&AppliedEnvelope {
            applied: vec![delete_note(&context, &date)?],
        }),
    }
    .map_err(|e| e.to_string())?;

    Ok(value)
}

fn reject_find_args(args: &[String]) -> Result<(), String> {
    for arg in args {
        if matches!(
            arg.as_str(),
            "-exec" | "-execdir" | "-delete" | "-ok" | "-okdir"
        ) {
            return Err(format!("Unsupported find flag: {}", arg));
        }
    }
    Ok(())
}

fn safe_shell_program_path(command: &str) -> Result<&'static str, String> {
    match command {
        "ls" => Ok("/bin/ls"),
        "find" => Ok("/usr/bin/find"),
        "grep" => Ok("/usr/bin/grep"),
        "cat" => Ok("/bin/cat"),
        _ => Err(format!("Unsupported shell command: {}", command)),
    }
}

pub fn run_tool_command(tool: ToolCommand) -> Result<ToolCommandOutput, String> {
    match tool {
        ToolCommand::Philo { argv, stdin } => {
            let stdout = run_philo_command(&argv, stdin)?;
            Ok(ToolCommandOutput {
                code: 0,
                stdout,
                stderr: String::new(),
            })
        }
        ToolCommand::SafeShell { command, args } => {
            if command == "find" {
                reject_find_args(&args)?;
            }

            let context = resolve_note_context()?;
            let program = safe_shell_program_path(&command)?;
            let child = StdCommand::new(program)
                .args(&args)
                .current_dir(&context.journal_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            let output = child.wait_with_output().map_err(|e| e.to_string())?;

            Ok(ToolCommandOutput {
                code: output.status.code().unwrap_or(1),
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            })
        }
    }
}

pub fn run_sidecar_philo(
    argv: &[String],
    stdin: Option<String>,
) -> Result<ToolCommandOutput, String> {
    let context = resolve_note_context()?;
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = current_exe
        .parent()
        .ok_or_else(|| "Current executable has no parent directory.".to_string())?;
    let base_dir = if exe_dir.ends_with("deps") {
        exe_dir.parent().unwrap_or(exe_dir)
    } else {
        exe_dir
    };
    let binary_path = base_dir.join("philo-cli");
    #[cfg(windows)]
    {
        binary_path.set_extension("exe");
    }

    if !binary_path.exists() {
        return run_tool_command(ToolCommand::Philo {
            argv: argv.to_vec(),
            stdin,
        });
    }

    let mut child = StdCommand::new(binary_path)
        .args(argv)
        .env("PHILO_SETTINGS_PATH", context.settings_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    if let Some(stdin_content) = stdin {
        let Some(mut writer) = child.stdin.take() else {
            return Err("Could not open sidecar stdin.".to_string());
        };
        writer
            .write_all(stdin_content.as_bytes())
            .map_err(|e| e.to_string())?;
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(ToolCommandOutput {
        code: output.status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{apply_filename_pattern, build_unified_diff, parse_date_from_relative_path};

    #[test]
    fn applies_filename_pattern() {
        assert_eq!(
            apply_filename_pattern("{YYYY}/{MM}/{DD}", "2026-03-10").unwrap(),
            "2026/03/10"
        );
    }

    #[test]
    fn parses_date_from_relative_path() {
        assert_eq!(
            parse_date_from_relative_path("2026/03/10.md", "{YYYY}/{MM}/{DD}"),
            Some("2026-03-10".to_string())
        );
    }

    #[test]
    fn builds_unified_diff() {
        let diff = build_unified_diff("- [ ] one\n", "- [ ] one\n- [ ] two\n");
        assert!(diff.contains("+++ after"));
        assert!(diff.contains("+"));
    }
}
