use crate::settings_paths::{
    default_settings_path, normalize_filename_pattern, resolve_journal_dir,
};
use chrono::{Duration, NaiveDate};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
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
    pub pages_dir: PathBuf,
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
struct PageEnvelope {
    page: PageRecord,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageSearchEnvelope {
    hits: Vec<PageSearchHit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadRangeEnvelope {
    notes: Vec<NoteRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEnvelope {
    change: NoteChange,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageUpdateEnvelope {
    change: PageChange,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedEnvelope {
    applied: Vec<AppliedNote>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageAppliedEnvelope {
    applied: Vec<AppliedPage>,
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
pub struct PageRecord {
    pub title: String,
    pub path: String,
    pub markdown: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub attached_to: Option<String>,
    pub event_id: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub participants: Vec<String>,
    pub location: Option<String>,
    pub executive_summary: Option<String>,
    pub session_kind: Option<String>,
    pub agenda: Vec<String>,
    pub action_items: Vec<String>,
    pub source: Option<String>,
    pub link_title: Option<String>,
    pub summary_updated_at: Option<String>,
    pub follow_up_questions: Vec<String>,
    pub link_kind: Option<String>,
    pub link_data: Option<JsonValue>,
    pub frontmatter: JsonValue,
    pub has_frontmatter: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSearchHit {
    pub title: String,
    pub snippet: String,
    pub path: String,
    #[serde(rename = "type")]
    pub r#type: String,
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
pub struct PageChange {
    pub title: String,
    pub before_markdown: String,
    pub after_markdown: String,
    pub unified_diff: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedNote {
    pub date: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedPage {
    pub title: String,
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
    NoteSearch { query: String, limit: usize },
    NoteRead { date: String },
    NoteReadRange { from: String, to: String },
    NoteCreate { date: String },
    NoteUpdate { date: String, apply: bool },
    NoteDelete { date: String },
    PageSearch { query: String, limit: usize },
    PageRead { title: String },
    PageCreate { title: String },
    PageUpdate { title: String, apply: bool },
    PageDelete { title: String },
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

    let default_base_dir = settings_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let journal_dir = resolve_journal_dir(
        &settings.journal_dir,
        &settings.vault_dir,
        &settings.daily_logs_folder,
    )
    .unwrap_or_else(|| default_base_dir.join("journal"));
    let pages_dir = if settings.vault_dir.trim().is_empty() {
        journal_dir
            .parent()
            .map(|parent| parent.join("pages"))
            .unwrap_or_else(|| default_base_dir.join("pages"))
    } else {
        PathBuf::from(settings.vault_dir.trim()).join("pages")
    };

    Ok(NoteContext {
        settings_path,
        journal_dir,
        pages_dir,
        filename_pattern: normalize_filename_pattern(&settings.filename_pattern),
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

struct ParsedMarkdownFrontmatter {
    frontmatter: JsonMap<String, JsonValue>,
    body: String,
    raw_block: Option<String>,
    has_frontmatter: bool,
}

fn parse_markdown_frontmatter(raw: &str) -> ParsedMarkdownFrontmatter {
    let frontmatter_re =
        regex::Regex::new(r"(?s)^---\n(.*?)\n---\n?").expect("valid frontmatter regex");
    let Some(captures) = frontmatter_re.captures(raw) else {
        return ParsedMarkdownFrontmatter {
            frontmatter: JsonMap::new(),
            body: raw.to_string(),
            raw_block: None,
            has_frontmatter: false,
        };
    };
    let Some(matched) = captures.get(0) else {
        return ParsedMarkdownFrontmatter {
            frontmatter: JsonMap::new(),
            body: raw.to_string(),
            raw_block: None,
            has_frontmatter: false,
        };
    };

    let frontmatter = captures
        .get(1)
        .and_then(|value| serde_yaml::from_str::<serde_yaml::Value>(value.as_str()).ok())
        .and_then(|value| serde_json::to_value(value).ok())
        .and_then(|value| match value {
            JsonValue::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();

    ParsedMarkdownFrontmatter {
        frontmatter,
        body: raw[matched.end()..].to_string(),
        raw_block: Some(raw[matched.start()..matched.end()].to_string()),
        has_frontmatter: true,
    }
}

fn parse_frontmatter(raw: &str) -> (Option<String>, String) {
    let parsed = parse_markdown_frontmatter(raw);
    let city = parsed
        .frontmatter
        .get("city")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    (city, parsed.body)
}

fn build_frontmatter(city: Option<&str>, body: &str) -> String {
    match city {
        Some(value) if !value.trim().is_empty() => {
            format!("---\ncity: {}\n---\n{}", value.trim(), body)
        }
        _ => body.to_string(),
    }
}

fn normalize_page_title_input(title: &str) -> String {
    let trimmed = title.trim();
    let trimmed_lower = trimmed.to_ascii_lowercase();
    let without_extension = if trimmed_lower.ends_with(".md") {
        &trimmed[..trimmed.len() - 3]
    } else {
        trimmed
    };

    let mut normalized = String::new();
    let mut previous_was_space = false;
    for ch in without_extension.chars() {
        let next = if matches!(ch, '/' | '\\') || ch.is_control() {
            ' '
        } else {
            ch
        };
        if next.is_whitespace() {
            if !previous_was_space {
                normalized.push(' ');
                previous_was_space = true;
            }
        } else {
            normalized.push(next);
            previous_was_space = false;
        }
    }

    normalized.trim().trim_matches('.').trim().to_string()
}

fn page_path(context: &NoteContext, title: &str) -> Result<(String, PathBuf), String> {
    let normalized_title = normalize_page_title_input(title);
    if normalized_title.is_empty() {
        return Err("Page title is required.".to_string());
    }

    Ok((
        normalized_title.clone(),
        context.pages_dir.join(format!("{normalized_title}.md")),
    ))
}

fn decode_url_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hi = bytes[index + 1] as char;
                let lo = bytes[index + 2] as char;
                if let (Some(hi), Some(lo)) = (hi.to_digit(16), lo.to_digit(16)) {
                    decoded.push(((hi * 16) + lo) as u8);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            value => {
                decoded.push(value);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&decoded).to_string()
}

fn parse_page_title_from_link_target(target: &str) -> Option<String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains("://")
        || regex::Regex::new(r"^[A-Za-z][A-Za-z0-9+.-]*:")
            .expect("valid page scheme regex")
            .is_match(trimmed)
    {
        return None;
    }

    let path_only = trimmed.split(['?', '#']).next().unwrap_or(trimmed);
    let decoded = decode_url_component(path_only);
    let decoded = decoded
        .trim_start_matches('/')
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string();
    if decoded.is_empty() {
        return None;
    }

    let lower = decoded.to_ascii_lowercase();
    if lower.ends_with(".excalidraw")
        || lower.ends_with(".excalidraw.md")
        || lower.ends_with(".widget.md")
    {
        return None;
    }

    let without_extension = if lower.ends_with(".md") {
        &decoded[..decoded.len() - 3]
    } else {
        decoded.as_str()
    };
    let without_prefix =
        if without_extension.len() >= 6 && without_extension[..6].eq_ignore_ascii_case("pages/") {
            &without_extension[6..]
        } else {
            without_extension
        };
    if without_prefix.contains('/') || without_prefix.contains('\\') {
        return None;
    }

    let normalized = normalize_page_title_input(without_prefix);
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn extract_linked_page_titles(markdown: &str) -> HashSet<String> {
    let wiki_link_re =
        regex::Regex::new(r"\[\[([^|\]]+)(?:\|[^\]]+)?\]\]").expect("valid wiki link regex");
    let markdown_link_re = regex::Regex::new(r#"\[[^\]]+\]\(([^)\s"]+)(?:\s+"[^"]*")?\)"#)
        .expect("valid markdown link regex");
    let mut titles = HashSet::new();

    for captures in wiki_link_re.captures_iter(markdown) {
        let Some(full) = captures.get(0) else {
            continue;
        };
        if full.start() > 0 && markdown.as_bytes()[full.start() - 1] == b'!' {
            continue;
        }

        let Some(target) = captures.get(1) else {
            continue;
        };
        if target.as_str().contains("(due date)") {
            continue;
        }

        if let Some(title) = parse_page_title_from_link_target(target.as_str()) {
            titles.insert(title);
        }
    }

    for captures in markdown_link_re.captures_iter(markdown) {
        let Some(full) = captures.get(0) else {
            continue;
        };
        if full.start() > 0 && markdown.as_bytes()[full.start() - 1] == b'!' {
            continue;
        }

        let Some(target) = captures.get(1) else {
            continue;
        };
        if let Some(title) = parse_page_title_from_link_target(target.as_str()) {
            titles.insert(title);
        }
    }

    titles
}

fn collect_markdown_files(root: &Path) -> Vec<PathBuf> {
    if !root.exists() {
        return Vec::new();
    }

    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
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

            if file_type.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("md"))
                    .unwrap_or(false)
            {
                files.push(path);
            }
        }
    }

    files
}

fn json_string(frontmatter: &JsonMap<String, JsonValue>, key: &str) -> Option<String> {
    frontmatter
        .get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn json_string_array(frontmatter: &JsonMap<String, JsonValue>, key: &str) -> Vec<String> {
    frontmatter
        .get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|value| value.as_str())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn page_type_from_frontmatter(frontmatter: &JsonMap<String, JsonValue>) -> String {
    match json_string(frontmatter, "type").as_deref() {
        Some("meeting") => "meeting".to_string(),
        _ => "page".to_string(),
    }
}

fn page_link_kind_from_frontmatter(frontmatter: &JsonMap<String, JsonValue>) -> Option<String> {
    match json_string(frontmatter, "link_kind").as_deref() {
        Some("generic" | "github_pr" | "github_issue" | "github_commit") => {
            json_string(frontmatter, "link_kind")
        }
        _ => {
            if frontmatter
                .get("link_title")
                .and_then(|value| value.as_str())
                .is_some()
                || frontmatter
                    .get("summary_updated_at")
                    .and_then(|value| value.as_str())
                    .is_some()
                || frontmatter
                    .get("follow_up_questions")
                    .and_then(|value| value.as_array())
                    .is_some()
            {
                Some("generic".to_string())
            } else {
                None
            }
        }
    }
}

fn find_date_linking_to_page(context: &NoteContext, title: &str) -> Result<Option<String>, String> {
    let normalized_title = normalize_page_title_input(title);
    if normalized_title.is_empty() {
        return Ok(None);
    }

    let root = match fs::canonicalize(&context.journal_dir) {
        Ok(path) => path,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    let mut latest_date: Option<String> = None;

    for path in collect_markdown_files(&root) {
        let relative_path = match path.strip_prefix(&root) {
            Ok(value) => value.to_string_lossy().to_string(),
            Err(_) => continue,
        };
        let Some(date) = parse_date_from_relative_path(&relative_path, &context.filename_pattern)
        else {
            continue;
        };

        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let (_, body) = parse_frontmatter(&raw);
        if !extract_linked_page_titles(&body).contains(&normalized_title) {
            continue;
        }

        if latest_date
            .as_ref()
            .map(|current| current < &date)
            .unwrap_or(true)
        {
            latest_date = Some(date);
        }
    }

    Ok(latest_date)
}

fn page_frontmatter_to_value(frontmatter: &JsonMap<String, JsonValue>) -> JsonValue {
    JsonValue::Object(frontmatter.clone())
}

fn build_page_record(
    context: &NoteContext,
    title: &str,
    path: &Path,
    raw: &str,
    infer_attached_to: bool,
) -> Result<PageRecord, String> {
    let parsed = parse_markdown_frontmatter(raw);
    let frontmatter = parsed.frontmatter;
    let link_kind = page_link_kind_from_frontmatter(&frontmatter);
    let attached_to = if infer_attached_to {
        find_date_linking_to_page(context, title)?
    } else {
        None
    }
    .or_else(|| json_string(&frontmatter, "attached_to"));

    Ok(PageRecord {
        title: normalize_page_title_input(title),
        path: path.to_string_lossy().to_string(),
        markdown: parsed.body,
        r#type: page_type_from_frontmatter(&frontmatter),
        attached_to,
        event_id: json_string(&frontmatter, "event_id"),
        started_at: json_string(&frontmatter, "started_at"),
        ended_at: json_string(&frontmatter, "ended_at"),
        participants: json_string_array(&frontmatter, "participants"),
        location: json_string(&frontmatter, "location"),
        executive_summary: json_string(&frontmatter, "executive_summary"),
        session_kind: json_string(&frontmatter, "session_kind"),
        agenda: json_string_array(&frontmatter, "agenda"),
        action_items: json_string_array(&frontmatter, "action_items"),
        source: json_string(&frontmatter, "source"),
        link_title: json_string(&frontmatter, "link_title"),
        summary_updated_at: json_string(&frontmatter, "summary_updated_at"),
        follow_up_questions: json_string_array(&frontmatter, "follow_up_questions"),
        link_kind: link_kind.clone(),
        link_data: match link_kind.as_deref() {
            Some("github_pr" | "github_issue" | "github_commit") => frontmatter
                .get("link_data")
                .filter(|value| value.is_object())
                .cloned(),
            _ => None,
        },
        frontmatter: page_frontmatter_to_value(&frontmatter),
        has_frontmatter: parsed.has_frontmatter,
    })
}

fn read_page(context: &NoteContext, title: &str) -> Result<Option<PageRecord>, String> {
    let (normalized_title, path) = page_path(context, title)?;
    let raw = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };

    Ok(Some(build_page_record(
        context,
        &normalized_title,
        &path,
        &raw,
        true,
    )?))
}

fn serialize_page_markdown(raw_block: Option<&str>, body: &str) -> String {
    match raw_block {
        Some(block) => format!("{block}{body}"),
        None => body.to_string(),
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

fn parse_iso_date(date: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| format!("Invalid date: {}", date))
}

fn read_notes_in_range(
    context: &NoteContext,
    from: &str,
    to: &str,
) -> Result<Vec<NoteRecord>, String> {
    let from_date = parse_iso_date(from)?;
    let to_date = parse_iso_date(to)?;
    if from_date > to_date {
        return Err("--from must be on or before --to.".to_string());
    }

    let span_days = (to_date - from_date).num_days();
    if span_days > 31 {
        return Err("Date range cannot exceed 31 days.".to_string());
    }

    let mut notes = Vec::new();
    let mut cursor = from_date;
    while cursor <= to_date {
        let date = cursor.format("%Y-%m-%d").to_string();
        if let Some(note) = read_note(context, &date)? {
            notes.push(note);
        }
        cursor += Duration::days(1);
    }

    Ok(notes)
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

pub fn build_unified_diff(before: &str, after: &str) -> String {
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

fn normalize_search_terms(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|part| part.trim().to_ascii_lowercase())
        .filter(|part| !part.is_empty())
        .collect()
}

fn condense_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
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

fn build_search_snippet(markdown: &str, terms: &[String]) -> String {
    for line in markdown.lines() {
        let trimmed = condense_whitespace(line);
        if trimmed.is_empty() {
            continue;
        }
        let normalized = trimmed.to_ascii_lowercase();
        if terms.iter().any(|term| normalized.contains(term)) {
            return truncate_chars(&trimmed, 180);
        }
    }

    truncate_chars(&condense_whitespace(markdown), 180)
}

fn create_page(context: &NoteContext, title: &str) -> Result<PageRecord, String> {
    let (normalized_title, path) = page_path(context, title)?;
    if path.exists() {
        return read_page(context, &normalized_title)?
            .ok_or_else(|| "Could not load existing page.".to_string());
    }

    write_note(&path, "---\ntype: \"page\"\n---\n")?;
    read_page(context, &normalized_title)?.ok_or_else(|| "Could not load created page.".to_string())
}

fn update_page(
    context: &NoteContext,
    title: &str,
    markdown: &str,
    apply: bool,
) -> Result<PageChange, String> {
    let (normalized_title, path) = page_path(context, title)?;
    let raw = fs::read_to_string(&path).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            format!("Page {} does not exist.", normalized_title)
        } else {
            err.to_string()
        }
    })?;
    let parsed = parse_markdown_frontmatter(&raw);
    let change = PageChange {
        title: normalized_title.clone(),
        before_markdown: parsed.body.clone(),
        after_markdown: markdown.to_string(),
        unified_diff: build_unified_diff(&parsed.body, markdown),
    };

    if apply {
        write_note(
            &path,
            &serialize_page_markdown(parsed.raw_block.as_deref(), markdown),
        )?;
    }

    Ok(change)
}

fn delete_page(context: &NoteContext, title: &str) -> Result<AppliedPage, String> {
    let (normalized_title, path) = page_path(context, title)?;
    if !path.exists() {
        return Err(format!("Page {} does not exist.", normalized_title));
    }

    fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(AppliedPage {
        title: normalized_title,
        path: path.to_string_lossy().to_string(),
    })
}

fn search_pages(
    context: &NoteContext,
    query: &str,
    limit: usize,
) -> Result<Vec<PageSearchHit>, String> {
    let terms = normalize_search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    struct PageSearchCandidate {
        title_matches: usize,
        mtime: i64,
        hit: PageSearchHit,
    }

    let mut candidates = Vec::new();
    for path in collect_markdown_files(&context.pages_dir) {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let title = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(normalize_page_title_input)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Untitled".to_string());
        let parsed = parse_markdown_frontmatter(&raw);
        let frontmatter_json = serde_json::to_string(&parsed.frontmatter).unwrap_or_default();
        let haystack = format!("{title}\n{}\n{frontmatter_json}", parsed.body);
        let normalized_haystack = haystack.to_ascii_lowercase();
        if !terms.iter().all(|term| normalized_haystack.contains(term)) {
            continue;
        }

        let title_lower = title.to_ascii_lowercase();
        let title_matches = terms
            .iter()
            .filter(|term| title_lower.contains(term.as_str()))
            .count();
        candidates.push(PageSearchCandidate {
            title_matches,
            mtime: normalize_mtime(&path),
            hit: PageSearchHit {
                title,
                snippet: build_search_snippet(&parsed.body, &terms),
                path: path.to_string_lossy().to_string(),
                r#type: page_type_from_frontmatter(&parsed.frontmatter),
            },
        });
    }

    candidates.sort_by(|left, right| {
        right
            .title_matches
            .cmp(&left.title_matches)
            .then_with(|| right.mtime.cmp(&left.mtime))
            .then_with(|| left.hit.title.cmp(&right.hit.title))
    });

    Ok(candidates
        .into_iter()
        .take(limit.min(20))
        .map(|candidate| candidate.hit)
        .collect())
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

fn parse_note_command(argv: &[String]) -> Result<ParsedCommand, String> {
    if argv.is_empty() {
        return Err("Missing note action.".to_string());
    }

    match argv[0].as_str() {
        "search" => {
            let mut query = None;
            let mut limit = 8usize;
            let mut index = 1usize;
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
            Ok(ParsedCommand::NoteSearch {
                query: query.ok_or_else(|| "Missing --query.".to_string())?,
                limit,
            })
        }
        "read" => {
            let mut date = None;
            let mut index = 1usize;
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
            Ok(ParsedCommand::NoteRead {
                date: date.ok_or_else(|| "Missing --date.".to_string())?,
            })
        }
        "read-range" => {
            let mut from = None;
            let mut to = None;
            let mut index = 1usize;
            while index < argv.len() {
                match argv[index].as_str() {
                    "--from" => {
                        from = argv.get(index + 1).cloned();
                        index += 2;
                    }
                    "--to" => {
                        to = argv.get(index + 1).cloned();
                        index += 2;
                    }
                    "--json" => index += 1,
                    other => {
                        return Err(format!("Unsupported flag for note read-range: {}", other))
                    }
                }
            }
            Ok(ParsedCommand::NoteReadRange {
                from: from.ok_or_else(|| "Missing --from.".to_string())?,
                to: to.ok_or_else(|| "Missing --to.".to_string())?,
            })
        }
        "create" => {
            let mut date = None;
            let mut index = 1usize;
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
            Ok(ParsedCommand::NoteCreate {
                date: date.ok_or_else(|| "Missing --date.".to_string())?,
            })
        }
        "update" => {
            let mut date = None;
            let mut apply = false;
            let mut dry_run = false;
            let mut index = 1usize;
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

            Ok(ParsedCommand::NoteUpdate {
                date: date.ok_or_else(|| "Missing --date.".to_string())?,
                apply,
            })
        }
        "delete" => {
            let mut date = None;
            let mut index = 1usize;
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
            Ok(ParsedCommand::NoteDelete {
                date: date.ok_or_else(|| "Missing --date.".to_string())?,
            })
        }
        other => Err(format!("Unsupported note action: {}", other)),
    }
}

fn parse_page_command(argv: &[String]) -> Result<ParsedCommand, String> {
    if argv.is_empty() {
        return Err("Missing page action.".to_string());
    }

    match argv[0].as_str() {
        "search" => {
            let mut query = None;
            let mut limit = 8usize;
            let mut index = 1usize;
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
                    other => return Err(format!("Unsupported flag for page search: {}", other)),
                }
            }
            Ok(ParsedCommand::PageSearch {
                query: query.ok_or_else(|| "Missing --query.".to_string())?,
                limit,
            })
        }
        "read" => {
            let mut title = None;
            let mut index = 1usize;
            while index < argv.len() {
                match argv[index].as_str() {
                    "--title" => {
                        title = argv.get(index + 1).cloned();
                        index += 2;
                    }
                    "--json" => index += 1,
                    other => return Err(format!("Unsupported flag for page read: {}", other)),
                }
            }
            Ok(ParsedCommand::PageRead {
                title: title.ok_or_else(|| "Missing --title.".to_string())?,
            })
        }
        "create" => {
            let mut title = None;
            let mut index = 1usize;
            while index < argv.len() {
                match argv[index].as_str() {
                    "--title" => {
                        title = argv.get(index + 1).cloned();
                        index += 2;
                    }
                    "--json" => index += 1,
                    other => return Err(format!("Unsupported flag for page create: {}", other)),
                }
            }
            Ok(ParsedCommand::PageCreate {
                title: title.ok_or_else(|| "Missing --title.".to_string())?,
            })
        }
        "update" => {
            let mut title = None;
            let mut apply = false;
            let mut dry_run = false;
            let mut index = 1usize;
            while index < argv.len() {
                match argv[index].as_str() {
                    "--title" => {
                        title = argv.get(index + 1).cloned();
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
                    other => return Err(format!("Unsupported flag for page update: {}", other)),
                }
            }

            if apply == dry_run {
                return Err("Use exactly one of --dry-run or --apply.".to_string());
            }

            Ok(ParsedCommand::PageUpdate {
                title: title.ok_or_else(|| "Missing --title.".to_string())?,
                apply,
            })
        }
        "delete" => {
            let mut title = None;
            let mut index = 1usize;
            while index < argv.len() {
                match argv[index].as_str() {
                    "--title" => {
                        title = argv.get(index + 1).cloned();
                        index += 2;
                    }
                    "--json" => index += 1,
                    other => return Err(format!("Unsupported flag for page delete: {}", other)),
                }
            }
            Ok(ParsedCommand::PageDelete {
                title: title.ok_or_else(|| "Missing --title.".to_string())?,
            })
        }
        other => Err(format!("Unsupported page action: {}", other)),
    }
}

fn parse_command(argv: &[String]) -> Result<ParsedCommand, String> {
    if argv.is_empty() {
        return Err("Missing philo subcommand.".to_string());
    }

    match argv[0].as_str() {
        "note" => parse_note_command(&argv[1..]),
        "page" => parse_page_command(&argv[1..]),
        other => Err(format!("Unsupported subcommand: {}", other)),
    }
}

pub fn run_philo_command(argv: &[String], stdin: Option<String>) -> Result<String, String> {
    let context = resolve_note_context()?;
    let command = parse_command(argv)?;
    let value = match command {
        ParsedCommand::NoteSearch { query, limit } => serde_json::to_string(&SearchEnvelope {
            hits: search_notes(&context, &query, limit.min(20))?,
        }),
        ParsedCommand::NoteRead { date } => {
            let note = read_note(&context, &date)?
                .ok_or_else(|| format!("Note {} does not exist.", date))?;
            serde_json::to_string(&NoteEnvelope { note })
        }
        ParsedCommand::NoteReadRange { from, to } => serde_json::to_string(&ReadRangeEnvelope {
            notes: read_notes_in_range(&context, &from, &to)?,
        }),
        ParsedCommand::NoteCreate { date } => serde_json::to_string(&NoteEnvelope {
            note: create_note(&context, &date)?,
        }),
        ParsedCommand::NoteUpdate { date, apply } => {
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
        ParsedCommand::NoteDelete { date } => serde_json::to_string(&AppliedEnvelope {
            applied: vec![delete_note(&context, &date)?],
        }),
        ParsedCommand::PageSearch { query, limit } => serde_json::to_string(&PageSearchEnvelope {
            hits: search_pages(&context, &query, limit.min(20))?,
        }),
        ParsedCommand::PageRead { title } => {
            let page = read_page(&context, &title)?.ok_or_else(|| {
                format!(
                    "Page {} does not exist.",
                    normalize_page_title_input(&title)
                )
            })?;
            serde_json::to_string(&PageEnvelope { page })
        }
        ParsedCommand::PageCreate { title } => serde_json::to_string(&PageEnvelope {
            page: create_page(&context, &title)?,
        }),
        ParsedCommand::PageUpdate { title, apply } => {
            let markdown =
                stdin.ok_or_else(|| "Page update requires stdin markdown.".to_string())?;
            if apply {
                let change = update_page(&context, &title, &markdown, true)?;
                let (_, path) = page_path(&context, &change.title)?;
                serde_json::to_string(&PageAppliedEnvelope {
                    applied: vec![AppliedPage {
                        title: change.title,
                        path: path.to_string_lossy().to_string(),
                    }],
                })
            } else {
                serde_json::to_string(&PageUpdateEnvelope {
                    change: update_page(&context, &title, &markdown, false)?,
                })
            }
        }
        ParsedCommand::PageDelete { title } => serde_json::to_string(&PageAppliedEnvelope {
            applied: vec![delete_page(&context, &title)?],
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
    #[cfg(windows)]
    let binary_path = {
        let mut path = base_dir.join("philo-cli");
        path.set_extension("exe");
        path
    };
    #[cfg(not(windows))]
    let binary_path = base_dir.join("philo-cli");

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
    use super::{
        apply_filename_pattern, build_unified_diff, parse_date_from_relative_path,
        read_notes_in_range, read_page, search_pages, update_page, NoteContext,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_test_context() -> NoteContext {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("philo-tools-test-{unique}"));
        fs::create_dir_all(&base).unwrap();
        NoteContext {
            settings_path: base.join("settings.json"),
            journal_dir: base.join("notes"),
            pages_dir: base.join("pages"),
            filename_pattern: "{YYYY}-{MM}-{DD}".to_string(),
        }
    }

    fn write_test_note(dir: &PathBuf, date: &str, markdown: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(format!("{date}.md")), markdown).unwrap();
    }

    fn write_test_page(dir: &PathBuf, title: &str, markdown: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(format!("{title}.md")), markdown).unwrap();
    }

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

    #[test]
    fn reads_existing_notes_in_date_range() {
        let context = make_test_context();
        write_test_note(
            &context.journal_dir,
            "2026-03-16",
            "# Mar 16\n- [x] shipped\n",
        );
        write_test_note(
            &context.journal_dir,
            "2026-03-18",
            "# Mar 18\n- [x] fixed\n",
        );
        write_test_note(
            &context.journal_dir,
            "2026-03-23",
            "# Mar 23\n- [x] today\n",
        );

        let notes = read_notes_in_range(&context, "2026-03-16", "2026-03-22").unwrap();
        let dates = notes
            .iter()
            .map(|note| note.date.as_str())
            .collect::<Vec<_>>();

        assert_eq!(dates, vec!["2026-03-16", "2026-03-18"]);
    }

    #[test]
    fn deserializes_camel_case_settings() {
        let settings: super::PhiloSettings = serde_json::from_str(
            r#"{
                "journalDir": "/tmp/journal",
                "filenamePattern": "{YYYY}_{MM}_{DD}",
                "vaultDir": "/tmp/vault",
                "dailyLogsFolder": "journals"
            }"#,
        )
        .unwrap();

        assert_eq!(settings.journal_dir, "/tmp/journal");
        assert_eq!(settings.filename_pattern, "{YYYY}_{MM}_{DD}");
        assert_eq!(settings.vault_dir, "/tmp/vault");
        assert_eq!(settings.daily_logs_folder, "journals");
    }

    #[test]
    fn reads_page_metadata_and_infers_attached_date() {
        let context = make_test_context();
        write_test_note(
            &context.journal_dir,
            "2026-03-16",
            "See [Launch plan](pages/Launch%20plan.md)\n",
        );
        write_test_page(
            &context.pages_dir,
            "Launch plan",
            "---\ntype: meeting\nparticipants:\n  - Alex\nlocation: HQ\n---\n# Launch\nNotes\n",
        );

        let page = read_page(&context, "Launch plan").unwrap().unwrap();

        assert_eq!(page.title, "Launch plan");
        assert_eq!(page.r#type, "meeting");
        assert_eq!(page.attached_to.as_deref(), Some("2026-03-16"));
        assert_eq!(page.participants, vec!["Alex"]);
        assert_eq!(page.location.as_deref(), Some("HQ"));
    }

    #[test]
    fn updates_page_body_without_dropping_frontmatter() {
        let context = make_test_context();
        write_test_page(
            &context.pages_dir,
            "Launch plan",
            "---\ntype: meeting\nlocation: HQ\n---\n# Launch\nOld body\n",
        );

        let change = update_page(&context, "Launch plan", "# Launch\nNew body\n", true).unwrap();
        let raw = fs::read_to_string(context.pages_dir.join("Launch plan.md")).unwrap();

        assert_eq!(change.title, "Launch plan");
        assert!(raw.contains("type: meeting"));
        assert!(raw.contains("location: HQ"));
        assert!(raw.ends_with("# Launch\nNew body\n"));
    }

    #[test]
    fn searches_pages_by_title_and_body() {
        let context = make_test_context();
        write_test_page(
            &context.pages_dir,
            "Launch plan",
            "---\ntype: page\n---\nChecklist for launch review\n",
        );
        write_test_page(
            &context.pages_dir,
            "Retro",
            "---\ntype: page\n---\nNotes from the retro\n",
        );

        let hits = search_pages(&context, "launch review", 10).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Launch plan");
    }
}
