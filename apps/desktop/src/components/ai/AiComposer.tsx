import { ArrowUp, LoaderCircle, Square, } from "lucide-react";
import { useEffect, useRef, } from "react";
import type { ChatHistoryEntry, } from "../../services/chats";
import { AiResultPanel, } from "./AiResultPanel";

interface AiComposerProps {
  open: boolean;
  prompt: string;
  selectedText: string | null;
  selectedLabel?: string | null;
  title: string | null;
  activeChatId: string | null;
  chatHistory: ChatHistoryEntry[];
  applyingDates: string[];
  canApplyPendingChanges: boolean;
  hasAiConfigured: boolean;
  isSubmitting: boolean;
  canStopSubmitting?: boolean;
  submittingLabel?: string;
  error: string | null;
  onPromptChange: (value: string,) => void;
  onClose: () => void;
  onNewChat: () => void;
  onSubmit: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
  onOpenDate: (date: string,) => void;
  onSelectChat: (id: string,) => void;
  onApplyChange: (date: string,) => void;
  onDiscardChange: (date: string,) => void;
}

export function AiComposer({
  open,
  prompt,
  selectedText,
  selectedLabel,
  title,
  activeChatId,
  chatHistory,
  applyingDates,
  canApplyPendingChanges,
  hasAiConfigured,
  isSubmitting,
  canStopSubmitting = true,
  submittingLabel = "Sophia is thinking...",
  error,
  onPromptChange,
  onNewChat,
  onSubmit,
  onStop,
  onOpenSettings,
  onOpenDate,
  onSelectChat,
  onApplyChange,
  onDiscardChange,
}: AiComposerProps,) {
  const inputRef = useRef<HTMLInputElement>(null,);
  const visibleSelectedLabel = selectedLabel ?? (selectedText ? formatSelectedLabel(selectedText,) : null);
  const widgetEditLabel = parseWidgetEditLabel(visibleSelectedLabel,);
  const hasPanel = !widgetEditLabel && (chatHistory.length > 0 || Boolean(title,) || Boolean(activeChatId,));

  useEffect(() => {
    if (!open || !hasAiConfigured) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0,);
    return () => window.clearTimeout(timer,);
  }, [hasAiConfigured, open,],);

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[95] transition-transform duration-300 ease-out"
      style={{ transform: open ? "translateY(0)" : "translateY(100%)", }}
    >
      <div className="relative mx-auto w-full max-w-2xl px-4 pb-3">
        {!hasAiConfigured
          ? (
            <div className="overflow-hidden rounded-none border border-gray-200 bg-white px-5 py-5 shadow-[0_-20px_60px_rgba(15,23,42,0.12)]">
              <div className="space-y-4">
                <p className="text-sm leading-6 text-gray-600">
                  AI isn&apos;t configured yet. Add an API key for your selected provider to start using note commands.
                </p>
                <button
                  onClick={onOpenSettings}
                  className="inline-flex items-center rounded-full bg-gray-900 px-4 py-2 text-sm text-white transition-colors hover:bg-gray-700"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                >
                  Click to configure AI
                </button>
              </div>
            </div>
          )
          : (
            <div className="overflow-hidden rounded-none border border-gray-200 bg-white shadow-[0_-18px_52px_rgba(15,23,42,0.12)]">
              {hasPanel && (
                <>
                  <AiResultPanel
                    title={title}
                    activeChatId={activeChatId}
                    chatHistory={chatHistory}
                    applyingDates={applyingDates}
                    canApplyPendingChanges={canApplyPendingChanges}
                    canStartNewChat={!isSubmitting}
                    onNewChat={() => {
                      onNewChat();
                      window.setTimeout(() => inputRef.current?.focus(), 0,);
                    }}
                    onSelectChat={onSelectChat}
                    onOpenDate={onOpenDate}
                    onApplyChange={onApplyChange}
                    onDiscardChange={onDiscardChange}
                  />
                  <div className="mx-4 border-t border-gray-100" />
                </>
              )}

              <div className="space-y-2 px-4 py-3">
                {widgetEditLabel
                  ? (
                    <div className="flex items-center gap-2 px-1 text-sm text-slate-600">
                      <span className="inline-flex items-center border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-blue-700">
                        Edit
                      </span>
                      <span className="truncate text-slate-600">{widgetEditLabel}</span>
                    </div>
                  )
                  : visibleSelectedLabel
                  ? <div className="px-1 text-sm text-slate-500">{visibleSelectedLabel}</div>
                  : null}
                <form
                  className="flex items-center gap-3"
                  onSubmit={(event,) => {
                    event.preventDefault();
                    onSubmit();
                  }}
                >
                  <div className="relative min-w-0 flex-1">
                    <input
                      ref={inputRef}
                      value={prompt}
                      readOnly={isSubmitting}
                      onChange={(event,) => onPromptChange(event.target.value,)}
                      onKeyDown={(event,) => {
                        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "n") return;
                        event.preventDefault();
                        onNewChat();
                      }}
                      placeholder="chat with notes."
                      className={`w-full min-w-0 bg-transparent px-1 text-[15px] text-gray-900 outline-hidden placeholder:text-gray-400 ${
                        isSubmitting ? "text-transparent caret-transparent" : ""
                      }`}
                    />
                    {isSubmitting && (
                      <div className="pointer-events-none absolute inset-0 flex items-center gap-2 px-1 text-[15px] text-slate-500">
                        <LoaderCircle size={14} className="shrink-0 animate-spin" />
                        <span className="truncate">{submittingLabel}</span>
                      </div>
                    )}
                  </div>
                  <button
                    type={isSubmitting ? "button" : "submit"}
                    disabled={isSubmitting ? !canStopSubmitting : !prompt.trim()}
                    onClick={isSubmitting && canStopSubmitting ? onStop : undefined}
                    aria-label={isSubmitting ? (canStopSubmitting ? "Stop generating" : "Submitting") : "Send message"}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-none bg-gray-900 text-white transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
                    style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                  >
                    {isSubmitting
                      ? canStopSubmitting
                        ? <Square size={14} fill="currentColor" strokeWidth={0} />
                        : <LoaderCircle size={18} className="animate-spin" strokeWidth={2.25} />
                      : <ArrowUp size={18} strokeWidth={2.25} />}
                  </button>
                </form>
                {error && <p className="px-1 text-sm text-red-500">{error}</p>}
              </div>
            </div>
          )}
      </div>
    </div>
  );
}

function formatSelectedLabel(selectedText: string,) {
  const normalized = selectedText.replace(/\s+/g, " ",).trim();
  if (!normalized) return null;
  const preview = normalized.length > 72 ? `${normalized.slice(0, 69,)}...` : normalized;
  return `"${preview}" selected`;
}

function parseWidgetEditLabel(label: string | null,) {
  if (!label?.startsWith("[Edit widget] ",)) return null;
  return label.slice("[Edit widget] ".length,).trim() || "Widget";
}
