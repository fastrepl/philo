import { RotateCcw, X, } from "lucide-react";
import type { WidgetGitDiff, WidgetGitHistoryEntry, } from "../../../../services/widget-git-history";
import { AiDiffPreview, } from "../../../ai/AiDiffPreview";

function formatReason(reason: WidgetGitHistoryEntry["reason"],): string {
  switch (reason) {
    case "import":
      return "Imported";
    case "create":
      return "Created";
    case "rebuild":
      return "Rebuilt";
    case "edit":
      return "Edited";
    case "insert":
      return "Inserted";
    case "archive":
      return "Archived";
    case "restore":
      return "Restored";
    default:
      return "Updated";
  }
}

function formatTimestamp(value: string,): string {
  const parsed = new Date(value,);
  if (Number.isNaN(parsed.getTime(),)) return value;
  return parsed.toLocaleString();
}

interface WidgetHistoryPanelProps {
  entries: WidgetGitHistoryEntry[];
  loading: boolean;
  error: string;
  diff: WidgetGitDiff | null;
  selectedCommitId: string | null;
  restoring: boolean;
  onClose: () => void;
  onSelect: (commitId: string,) => void;
  onRestore: () => void;
}

export function WidgetHistoryPanel({
  entries,
  loading,
  error,
  diff,
  selectedCommitId,
  restoring,
  onClose,
  onSelect,
  onRestore,
}: WidgetHistoryPanelProps,) {
  const restoreDisabled = restoring || !diff?.canRestore;
  const empty = !loading && entries.length === 0 && !error;

  return (
    <div className="widget-history-panel" onMouseDown={(event,) => event.stopPropagation()}>
      <div className="widget-history-header">
        <div>
          <p className="widget-history-eyebrow">Git History</p>
          <p className="widget-history-title">Widget revisions</p>
        </div>
        <button
          type="button"
          className="widget-btn widget-btn-icon"
          onClick={onClose}
          aria-label="Close widget history"
          title="Close history"
        >
          <X strokeWidth={2} />
        </button>
      </div>

      {error
        ? (
          <div className="widget-history-empty">
            <p className="widget-error-title">History unavailable</p>
            <p className="widget-error-message">{error}</p>
          </div>
        )
        : empty
        ? (
          <div className="widget-history-empty">
            <p className="widget-history-empty-title">No Git history yet</p>
            <p className="widget-error-message">This widget will appear here after its first tracked snapshot.</p>
          </div>
        )
        : (
          <div className="widget-history-grid">
            <div className="widget-history-list" role="listbox" aria-label="Widget history entries">
              {loading && <div className="widget-history-list-loading">Loading history…</div>}
              {entries.map((entry,) => {
                const selected = entry.commitId === selectedCommitId;
                return (
                  <button
                    key={entry.commitId}
                    type="button"
                    className={`widget-history-entry ${selected ? "widget-history-entry-selected" : ""}`}
                    onClick={() => onSelect(entry.commitId,)}
                  >
                    <span className="widget-history-entry-reason">{formatReason(entry.reason,)}</span>
                    <span className="widget-history-entry-title">{entry.title}</span>
                    <span className="widget-history-entry-date">{formatTimestamp(entry.createdAt,)}</span>
                  </button>
                );
              },)}
            </div>

            <div className="widget-history-diff">
              <div className="widget-history-actions">
                <button
                  type="button"
                  className="widget-btn widget-history-restore"
                  onClick={onRestore}
                  disabled={restoreDisabled}
                  title={diff?.blockedReason ?? "Restore this widget revision"}
                >
                  <RotateCcw strokeWidth={2} />
                  <span>{restoring ? "Restoring…" : "Restore revision"}</span>
                </button>
                {diff?.blockedReason && <span className="widget-history-hint">{diff.blockedReason}</span>}
              </div>
              {diff
                ? <AiDiffPreview unifiedDiff={diff.unifiedDiff} />
                : (
                  <div className="widget-history-empty">
                    <p className="widget-history-empty-title">Pick a revision</p>
                    <p className="widget-error-message">Select a Git snapshot to view its diff.</p>
                  </div>
                )}
            </div>
          </div>
        )}
    </div>
  );
}
