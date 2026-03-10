import { LoaderCircle, } from "lucide-react";
import type { AssistantCitation, AssistantPendingChange, } from "../../services/assistant";
import { AiDiffPreview, } from "./AiDiffPreview";

interface AiResultPanelProps {
  isThinking: boolean;
  answer: string | null;
  citations: AssistantCitation[];
  pendingChanges: AssistantPendingChange[];
  applyingDates: string[];
  onOpenDate: (date: string,) => void;
  onApplyChange: (date: string,) => void;
  onDiscardChange: (date: string,) => void;
}

export function AiResultPanel({
  isThinking,
  answer,
  citations,
  pendingChanges,
  applyingDates,
  onOpenDate,
  onApplyChange,
  onDiscardChange,
}: AiResultPanelProps,) {
  if (!isThinking && !answer && citations.length === 0 && pendingChanges.length === 0) {
    return null;
  }

  return (
    <div className="max-h-[56vh] overflow-y-auto rounded-[24px] border border-gray-200 bg-white/96 shadow-[0_-12px_36px_rgba(15,23,42,0.12)]">
      <div className="space-y-4 px-4 py-4">
        {isThinking && (
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-slate-500">
              <LoaderCircle size={16} className="animate-spin" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900">Sophia is thinking</p>
              <p className="text-xs text-slate-500">Searching notes and composing a reply.</p>
            </div>
          </div>
        )}

        {answer && (
          <div className="space-y-2">
            <p
              className="text-[11px] uppercase tracking-[0.22em] text-gray-400"
              style={{ fontFamily: "'IBM Plex Mono', monospace", }}
            >
              answer
            </p>
            <p className="whitespace-pre-wrap text-sm leading-6 text-gray-900">
              {answer}
            </p>
          </div>
        )}

        {citations.length > 0 && (
          <div className="space-y-2">
            <p
              className="text-[11px] uppercase tracking-[0.22em] text-gray-400"
              style={{ fontFamily: "'IBM Plex Mono', monospace", }}
            >
              note citations
            </p>
            <div className="space-y-2">
              {citations.map((citation,) => (
                <button
                  key={citation.date}
                  onClick={() => onOpenDate(citation.date,)}
                  className="w-full rounded-2xl border border-gray-200 bg-white px-3 py-3 text-left transition-colors hover:border-gray-300"
                >
                  <p className="text-sm font-medium text-gray-900">{citation.title}</p>
                  <p
                    className="mt-1 text-[11px] uppercase tracking-[0.18em] text-gray-400"
                    style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                  >
                    {citation.date}
                  </p>
                  {citation.snippet && (
                    <p className="mt-2 text-sm leading-5 text-gray-600">
                      {citation.snippet}
                    </p>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {pendingChanges.length > 0 && (
          <div className="space-y-3">
            <p
              className="text-[11px] uppercase tracking-[0.22em] text-gray-400"
              style={{ fontFamily: "'IBM Plex Mono', monospace", }}
            >
              pending changes
            </p>
            {pendingChanges.map((change,) => {
              const isApplying = applyingDates.includes(change.date,);

              return (
                <div
                  key={change.date}
                  className="space-y-3 rounded-2xl border border-gray-200 bg-gray-50/80 px-3 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{change.date}</p>
                      <p
                        className="text-[11px] uppercase tracking-[0.18em] text-gray-400"
                        style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                      >
                        dry run
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onOpenDate(change.date,)}
                        className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900"
                        style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                      >
                        Open note
                      </button>
                      <button
                        onClick={() => onDiscardChange(change.date,)}
                        disabled={isApplying}
                        className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-60"
                        style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                      >
                        Discard
                      </button>
                      <button
                        onClick={() => onApplyChange(change.date,)}
                        disabled={isApplying}
                        className="rounded-full bg-gray-900 px-3 py-1.5 text-xs text-white transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
                        style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                      >
                        {isApplying ? "Applying..." : "Apply"}
                      </button>
                    </div>
                  </div>

                  <AiDiffPreview unifiedDiff={change.unifiedDiff} />
                </div>
              );
            },)}
          </div>
        )}
      </div>
    </div>
  );
}
