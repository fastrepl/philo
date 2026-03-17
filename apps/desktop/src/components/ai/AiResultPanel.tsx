import { ChevronDown, Plus, } from "lucide-react";
import { useEffect, useMemo, useRef, useState, } from "react";
import type { AssistantCitation, AssistantPendingChange, } from "../../services/assistant";
import type { ChatHistoryEntry, } from "../../services/chats";
import { AiDiffPreview, } from "./AiDiffPreview";

interface AiResultPanelProps {
  title: string | null;
  activeChatId: string | null;
  chatHistory: ChatHistoryEntry[];
  answer: string | null;
  citations: AssistantCitation[];
  pendingChanges: AssistantPendingChange[];
  applyingDates: string[];
  canApplyPendingChanges: boolean;
  canStartNewChat: boolean;
  onNewChat: () => void;
  onSelectChat: (id: string,) => void;
  onOpenDate: (date: string,) => void;
  onApplyChange: (date: string,) => void;
  onDiscardChange: (date: string,) => void;
}

export function AiResultPanel({
  title,
  activeChatId,
  chatHistory,
  answer,
  citations,
  pendingChanges,
  applyingDates,
  canApplyPendingChanges,
  canStartNewChat,
  onNewChat,
  onSelectChat,
  onOpenDate,
  onApplyChange,
  onDiscardChange,
}: AiResultPanelProps,) {
  const hasContent = Boolean(answer,) || citations.length > 0 || pendingChanges.length > 0;
  const [historyOpen, setHistoryOpen,] = useState(false,);
  const scrollRef = useRef<HTMLDivElement>(null,);
  const activeChat = useMemo(
    () => chatHistory.find((chat,) => chat.id === activeChatId) ?? null,
    [activeChatId, chatHistory,],
  );
  const panelTitle = title || activeChat?.title || "New chat";

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !hasContent) return;
    container.scrollTop = container.scrollHeight;
  }, [answer, citations.length, hasContent, pendingChanges.length,],);

  useEffect(() => {
    setHistoryOpen(false,);
  }, [activeChatId,],);

  if (!hasContent && chatHistory.length === 0 && !title) {
    return null;
  }

  return (
    <div ref={scrollRef} className="hide-scrollbar max-h-[52vh] overflow-y-auto">
      <div className="sticky top-0 z-10 border-b border-gray-100 bg-white/95 px-4 pt-4 pb-3 backdrop-blur-sm">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-2">
              <p className="min-w-0 truncate text-sm font-medium text-gray-900">
                {panelTitle}
              </p>
              {chatHistory.length > 0 && (
                <button
                  type="button"
                  onClick={() => setHistoryOpen((open,) => !open)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-900"
                  aria-label={historyOpen ? "Hide chat history" : "Show chat history"}
                >
                  <ChevronDown size={15} className={`transition-transform ${historyOpen ? "rotate-180" : ""}`} />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setHistoryOpen(false,);
                onNewChat();
              }}
              disabled={!canStartNewChat}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Start new chat"
              title="Start new chat"
            >
              <Plus size={15} />
            </button>
          </div>

          {historyOpen && chatHistory.length > 0 && (
            <div className="border-t border-gray-100 pt-1">
              {chatHistory.map((chat, index,) => (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => onSelectChat(chat.id,)}
                  className={`w-full px-0 py-3 text-left transition-colors ${
                    index > 0 ? "border-t border-gray-100" : ""
                  } ${
                    chat.id === activeChatId
                      ? "bg-gray-50 text-gray-900"
                      : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                  }`}
                >
                  <p className="truncate text-sm font-medium">{chat.title}</p>
                  <p
                    className="mt-1 text-[11px] uppercase tracking-[0.18em] text-gray-400"
                    style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                  >
                    {formatChatTimestamp(chat.createdAt,)}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4 px-4 pt-4 pb-3">
        {answer && (
          <div className="space-y-2">
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
                        {canApplyPendingChanges ? "dry run" : "history snapshot"}
                      </p>
                    </div>
                    {canApplyPendingChanges
                      ? (
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
                      )
                      : (
                        <button
                          onClick={() => onOpenDate(change.date,)}
                          className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900"
                          style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                        >
                          Open note
                        </button>
                      )}
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

function formatChatTimestamp(value: string,) {
  const date = new Date(value,);
  if (Number.isNaN(date.getTime(),)) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },).format(date,);
}
