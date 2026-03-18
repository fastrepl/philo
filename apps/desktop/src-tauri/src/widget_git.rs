use chrono::{DateTime, Utc};
use git2::{Delta, DiffOptions, ErrorCode, Oid, Repository, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::TextDiff;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

const HISTORY_DIR: &str = "widget-history";
const HISTORY_AUTHOR_NAME: &str = "Philo";
const HISTORY_AUTHOR_EMAIL: &str = "widget-history@local";
const DEFAULT_WIDGET_TITLE: &str = "Widget";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureWidgetGitBaselineInput {
    pub widgets_root: String,
    pub relative_widget_path: String,
    pub snapshot: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordWidgetGitRevisionInput {
    pub widgets_root: String,
    pub relative_widget_path: String,
    pub snapshot: String,
    #[serde(default)]
    pub previous_snapshot: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetGitHistoryInput {
    pub widgets_root: String,
    pub relative_widget_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetGitDiffInput {
    pub widgets_root: String,
    pub relative_widget_path: String,
    pub commit_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreWidgetGitRevisionInput {
    pub widgets_root: String,
    pub relative_widget_path: String,
    pub commit_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetGitHistoryEntry {
    pub commit_id: String,
    pub reason: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetGitDiff {
    pub commit_id: String,
    pub parent_commit_id: Option<String>,
    pub unified_diff: String,
    pub can_restore: bool,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetGitRestoreResult {
    pub commit_id: String,
    pub snapshot: String,
}

pub fn ensure_widget_git_history_baseline(
    app_data_dir: &Path,
    input: EnsureWidgetGitBaselineInput,
) -> Result<(), String> {
    let repo = ensure_repo(app_data_dir, &input.widgets_root)?;
    let relative_path = normalize_relative_widget_path(&input.relative_widget_path)?;
    if tracked_blob_content(&repo, &relative_path)?.is_some() {
        return Ok(());
    }

    commit_snapshot(
        &repo,
        &relative_path,
        input.snapshot.trim_end_matches('\n'),
        "import",
        &normalize_title(&input.title),
    )
}

pub fn record_widget_git_revision(
    app_data_dir: &Path,
    input: RecordWidgetGitRevisionInput,
) -> Result<(), String> {
    let repo = ensure_repo(app_data_dir, &input.widgets_root)?;
    let relative_path = normalize_relative_widget_path(&input.relative_widget_path)?;
    let next_snapshot = input.snapshot.trim_end_matches('\n');
    let current_snapshot = tracked_blob_content(&repo, &relative_path)?;

    if current_snapshot.is_none() {
        if let Some(previous_snapshot) = input.previous_snapshot.as_deref() {
            let previous_snapshot = previous_snapshot.trim_end_matches('\n');
            if !previous_snapshot.is_empty() && previous_snapshot != next_snapshot {
                commit_snapshot(
                    &repo,
                    &relative_path,
                    previous_snapshot,
                    "import",
                    &normalize_title(&input.title),
                )?;
            }
        }
    }

    if tracked_blob_content(&repo, &relative_path)?.as_deref() == Some(next_snapshot) {
        return Ok(());
    }

    commit_snapshot(
        &repo,
        &relative_path,
        next_snapshot,
        input.reason.trim(),
        &normalize_title(&input.title),
    )
}

pub fn list_widget_git_history(
    app_data_dir: &Path,
    input: WidgetGitHistoryInput,
) -> Result<Vec<WidgetGitHistoryEntry>, String> {
    let repo = open_repo(app_data_dir, &input.widgets_root)?;
    let relative_path = normalize_relative_widget_path(&input.relative_widget_path)?;
    let head = match repo.head() {
        Ok(head) => head,
        Err(err) if err.code() == ErrorCode::UnbornBranch => return Ok(Vec::new()),
        Err(err) if err.code() == ErrorCode::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.to_string()),
    };
    let Some(head_oid) = head.target() else {
        return Ok(Vec::new());
    };

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push(head_oid).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();

    for oid in revwalk {
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        if !commit_touches_path(&repo, &commit, &relative_path)? {
            continue;
        }
        let (reason, title) = parse_commit_summary(commit.summary().unwrap_or_default());
        entries.push(WidgetGitHistoryEntry {
            commit_id: oid.to_string(),
            reason,
            title,
            created_at: commit_timestamp(&commit),
        });
    }

    Ok(entries)
}

pub fn get_widget_git_diff(
    app_data_dir: &Path,
    input: WidgetGitDiffInput,
) -> Result<WidgetGitDiff, String> {
    let repo = open_repo(app_data_dir, &input.widgets_root)?;
    let relative_path = normalize_relative_widget_path(&input.relative_widget_path)?;
    let oid = Oid::from_str(input.commit_id.trim()).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let parent_commit = commit.parent(0).ok();
    let before = parent_commit
        .as_ref()
        .map(|parent| blob_content_at_commit(&repo, parent.id(), &relative_path))
        .transpose()?
        .flatten()
        .unwrap_or_default();
    let after = blob_content_at_commit(&repo, commit.id(), &relative_path)?.unwrap_or_default();
    let head_oid = repo.head().ok().and_then(|head| head.target());
    let can_restore = head_oid != Some(commit.id());

    Ok(WidgetGitDiff {
        commit_id: commit.id().to_string(),
        parent_commit_id: parent_commit.map(|parent| parent.id().to_string()),
        unified_diff: build_unified_diff(&before, &after),
        can_restore,
        blocked_reason: if can_restore {
            None
        } else {
            Some("Already using this version.".to_string())
        },
    })
}

pub fn restore_widget_git_revision(
    app_data_dir: &Path,
    input: RestoreWidgetGitRevisionInput,
) -> Result<WidgetGitRestoreResult, String> {
    let repo = open_repo(app_data_dir, &input.widgets_root)?;
    let relative_path = normalize_relative_widget_path(&input.relative_widget_path)?;
    let oid = Oid::from_str(input.commit_id.trim()).map_err(|e| e.to_string())?;
    let snapshot = blob_content_at_commit(&repo, oid, &relative_path)?
        .ok_or_else(|| "Snapshot not found for widget revision.".to_string())?;

    Ok(WidgetGitRestoreResult {
        commit_id: oid.to_string(),
        snapshot,
    })
}

fn normalize_title(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        DEFAULT_WIDGET_TITLE.to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_relative_widget_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Err("Widget path is required.".to_string());
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return Err("Widget path must be relative.".to_string());
    }
    if !candidate
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
    {
        return Err("Widget path must end with .md.".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => continue,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err("Widget path is invalid.".to_string())
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("Widget path is invalid.".to_string());
    }

    Ok(normalized)
}

fn repo_dir(app_data_dir: &Path, widgets_root: &str) -> Result<PathBuf, String> {
    let normalized_root = widgets_root.trim();
    if normalized_root.is_empty() {
        return Err("Widgets root is required.".to_string());
    }
    let root_path = Path::new(normalized_root);
    let canonical = fs::canonicalize(root_path).unwrap_or_else(|_| root_path.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let key = format!("{:x}", hasher.finalize());
    Ok(app_data_dir.join(HISTORY_DIR).join(key))
}

fn ensure_repo(app_data_dir: &Path, widgets_root: &str) -> Result<Repository, String> {
    let repo_path = repo_dir(app_data_dir, widgets_root)?;
    fs::create_dir_all(&repo_path).map_err(|e| e.to_string())?;
    match Repository::open(&repo_path) {
        Ok(repo) => Ok(repo),
        Err(err) if err.code() == ErrorCode::NotFound => {
            Repository::init(&repo_path).map_err(|e| e.to_string())
        }
        Err(err) => Err(err.to_string()),
    }
}

fn open_repo(app_data_dir: &Path, widgets_root: &str) -> Result<Repository, String> {
    let repo_path = repo_dir(app_data_dir, widgets_root)?;
    match Repository::open(&repo_path) {
        Ok(repo) => Ok(repo),
        Err(err) if err.code() == ErrorCode::NotFound => {
            Ok(Repository::init(&repo_path).map_err(|e| e.to_string())?)
        }
        Err(err) => Err(err.to_string()),
    }
}

fn tracked_blob_content(repo: &Repository, relative_path: &Path) -> Result<Option<String>, String> {
    let head = match repo.head() {
        Ok(head) => head,
        Err(err) if err.code() == ErrorCode::UnbornBranch => return Ok(None),
        Err(err) if err.code() == ErrorCode::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    let Some(head_oid) = head.target() else {
        return Ok(None);
    };
    blob_content_at_commit(repo, head_oid, relative_path)
}

fn blob_content_at_commit(
    repo: &Repository,
    commit_id: Oid,
    relative_path: &Path,
) -> Result<Option<String>, String> {
    let commit = repo.find_commit(commit_id).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let entry = match tree.get_path(relative_path) {
        Ok(entry) => entry,
        Err(err) if err.code() == ErrorCode::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
    let content = std::str::from_utf8(blob.content()).map_err(|e| e.to_string())?;
    Ok(Some(content.to_string()))
}

fn commit_snapshot(
    repo: &Repository,
    relative_path: &Path,
    snapshot: &str,
    reason: &str,
    title: &str,
) -> Result<(), String> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Widget history repo is bare.".to_string())?;
    let absolute_path = workdir.join(relative_path);
    if let Some(parent) = absolute_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&absolute_path, format!("{snapshot}\n")).map_err(|e| e.to_string())?;

    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.add_path(relative_path).map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let signature =
        Signature::now(HISTORY_AUTHOR_NAME, HISTORY_AUTHOR_EMAIL).map_err(|e| e.to_string())?;
    let message = build_commit_summary(reason, title);

    let parent = repo
        .head()
        .ok()
        .and_then(|head| head.target())
        .and_then(|oid| repo.find_commit(oid).ok());

    match parent {
        Some(parent) => {
            repo.commit(
                Some("HEAD"),
                &signature,
                &signature,
                &message,
                &tree,
                &[&parent],
            )
            .map_err(|e| e.to_string())?;
        }
        None => {
            repo.commit(Some("HEAD"), &signature, &signature, &message, &tree, &[])
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn build_commit_summary(reason: &str, title: &str) -> String {
    let normalized_reason = reason.trim().to_lowercase();
    format!("widget:{normalized_reason} {}", normalize_title(title))
}

fn parse_commit_summary(summary: &str) -> (String, String) {
    let trimmed = summary.trim();
    if let Some(rest) = trimmed.strip_prefix("widget:") {
        let mut parts = rest.splitn(2, ' ');
        let reason = parts.next().unwrap_or("update").trim();
        let title = parts.next().unwrap_or(DEFAULT_WIDGET_TITLE).trim();
        return (
            if reason.is_empty() { "update" } else { reason }.to_string(),
            if title.is_empty() {
                DEFAULT_WIDGET_TITLE.to_string()
            } else {
                title.to_string()
            },
        );
    }
    ("update".to_string(), normalize_title(trimmed))
}

fn commit_touches_path(
    repo: &Repository,
    commit: &git2::Commit<'_>,
    relative_path: &Path,
) -> Result<bool, String> {
    let commit_tree = commit.tree().map_err(|e| e.to_string())?;
    if commit.parent_count() == 0 {
        return Ok(commit_tree.get_path(relative_path).is_ok());
    }

    let parent = commit.parent(0).map_err(|e| e.to_string())?;
    let parent_tree = parent.tree().map_err(|e| e.to_string())?;
    let mut diff_options = DiffOptions::new();
    diff_options.pathspec(relative_path);
    let diff = repo
        .diff_tree_to_tree(
            Some(&parent_tree),
            Some(&commit_tree),
            Some(&mut diff_options),
        )
        .map_err(|e| e.to_string())?;
    for delta in diff.deltas() {
        if matches!(
            delta.status(),
            Delta::Added
                | Delta::Copied
                | Delta::Deleted
                | Delta::Modified
                | Delta::Renamed
                | Delta::Typechange
        ) {
            return Ok(true);
        }
    }

    Ok(false)
}

fn commit_timestamp(commit: &git2::Commit<'_>) -> String {
    let seconds = commit.time().seconds();
    let system_time = if seconds >= 0 {
        UNIX_EPOCH + Duration::from_secs(seconds as u64)
    } else {
        UNIX_EPOCH
            .checked_sub(Duration::from_secs(seconds.unsigned_abs()))
            .unwrap_or(UNIX_EPOCH)
    };
    let datetime: DateTime<Utc> = system_time.into();
    datetime.to_rfc3339()
}

fn build_unified_diff(before: &str, after: &str) -> String {
    TextDiff::from_lines(before, after)
        .unified_diff()
        .context_radius(3)
        .header("before", "after")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn temp_dir(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("philo-widget-git-{label}-{nonce}"));
        path
    }

    fn ensure_app_data() -> (PathBuf, String) {
        let app_data = temp_dir("app");
        let widgets_root = temp_dir("widgets");
        fs::create_dir_all(&app_data).unwrap();
        fs::create_dir_all(&widgets_root).unwrap();
        (app_data, widgets_root.to_string_lossy().to_string())
    }

    fn history_input(widgets_root: &str) -> WidgetGitHistoryInput {
        WidgetGitHistoryInput {
            widgets_root: widgets_root.to_string(),
            relative_widget_path: "tracker.widget.md".to_string(),
        }
    }

    #[test]
    fn records_baseline_and_material_revisions() {
        let (app_data, widgets_root) = ensure_app_data();

        record_widget_git_revision(
            &app_data,
            RecordWidgetGitRevisionInput {
                widgets_root: widgets_root.clone(),
                relative_widget_path: "tracker.widget.md".to_string(),
                snapshot: "---\nprompt: \"Next\"\n---\n".to_string(),
                previous_snapshot: Some("---\nprompt: \"Current\"\n---\n".to_string()),
                reason: "edit".to_string(),
                title: "Tracker".to_string(),
            },
        )
        .unwrap();

        let entries = list_widget_git_history(&app_data, history_input(&widgets_root)).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].reason, "edit");
        assert_eq!(entries[1].reason, "import");

        let repo_path = repo_dir(&app_data, &widgets_root).unwrap();
        assert!(repo_path.join(".git").exists());
        assert!(!Path::new(&widgets_root).join(".git").exists());

        let _ = fs::remove_dir_all(&app_data);
        let _ = fs::remove_dir_all(&widgets_root);
    }

    #[test]
    fn skips_duplicate_snapshot_commits() {
        let (app_data, widgets_root) = ensure_app_data();
        let input = RecordWidgetGitRevisionInput {
            widgets_root: widgets_root.clone(),
            relative_widget_path: "tracker.widget.md".to_string(),
            snapshot: "---\nprompt: \"Current\"\n---\n".to_string(),
            previous_snapshot: None,
            reason: "create".to_string(),
            title: "Tracker".to_string(),
        };

        record_widget_git_revision(&app_data, input.clone()).unwrap();
        record_widget_git_revision(&app_data, input).unwrap();

        let entries = list_widget_git_history(&app_data, history_input(&widgets_root)).unwrap();
        assert_eq!(entries.len(), 1);

        let _ = fs::remove_dir_all(&app_data);
        let _ = fs::remove_dir_all(&widgets_root);
    }

    #[test]
    fn returns_diff_and_restore_snapshot() {
        let (app_data, widgets_root) = ensure_app_data();
        record_widget_git_revision(
            &app_data,
            RecordWidgetGitRevisionInput {
                widgets_root: widgets_root.clone(),
                relative_widget_path: "tracker.widget.md".to_string(),
                snapshot: "---\nprompt: \"New\"\n---\n".to_string(),
                previous_snapshot: Some("---\nprompt: \"Old\"\n---\n".to_string()),
                reason: "edit".to_string(),
                title: "Tracker".to_string(),
            },
        )
        .unwrap();

        let entries = list_widget_git_history(&app_data, history_input(&widgets_root)).unwrap();
        let diff = get_widget_git_diff(
            &app_data,
            WidgetGitDiffInput {
                widgets_root: widgets_root.clone(),
                relative_widget_path: "tracker.widget.md".to_string(),
                commit_id: entries[0].commit_id.clone(),
            },
        )
        .unwrap();
        assert!(diff.unified_diff.contains("-prompt: \"Old\""));
        assert!(diff.unified_diff.contains("+prompt: \"New\""));
        assert!(!diff.can_restore);

        let restored = restore_widget_git_revision(
            &app_data,
            RestoreWidgetGitRevisionInput {
                widgets_root: widgets_root.clone(),
                relative_widget_path: "tracker.widget.md".to_string(),
                commit_id: entries[1].commit_id.clone(),
            },
        )
        .unwrap();
        assert!(restored.snapshot.contains("\"Old\""));

        let _ = fs::remove_dir_all(&app_data);
        let _ = fs::remove_dir_all(&widgets_root);
    }

    #[test]
    fn ensures_baseline_once_for_existing_widget() {
        let (app_data, widgets_root) = ensure_app_data();

        ensure_widget_git_history_baseline(
            &app_data,
            EnsureWidgetGitBaselineInput {
                widgets_root: widgets_root.clone(),
                relative_widget_path: "tracker.widget.md".to_string(),
                snapshot: "---\nprompt: \"Imported\"\n---\n".to_string(),
                title: "Tracker".to_string(),
            },
        )
        .unwrap();
        ensure_widget_git_history_baseline(
            &app_data,
            EnsureWidgetGitBaselineInput {
                widgets_root: widgets_root.clone(),
                relative_widget_path: "tracker.widget.md".to_string(),
                snapshot: "---\nprompt: \"Imported\"\n---\n".to_string(),
                title: "Tracker".to_string(),
            },
        )
        .unwrap();

        let entries = list_widget_git_history(&app_data, history_input(&widgets_root)).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].reason, "import");

        let _ = fs::remove_dir_all(&app_data);
        let _ = fs::remove_dir_all(&widgets_root);
    }
}
