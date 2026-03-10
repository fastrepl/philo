import { useEffect, useRef, } from "react";
import type { AssistantCitation, AssistantPendingChange, } from "../../services/assistant";
import { AiResultPanel, } from "./AiResultPanel";

interface AiComposerProps {
  open: boolean;
  prompt: string;
  answer: string | null;
  citations: AssistantCitation[];
  pendingChanges: AssistantPendingChange[];
  applyingDates: string[];
  hasAiConfigured: boolean;
  isSubmitting: boolean;
  error: string | null;
  onPromptChange: (value: string,) => void;
  onClose: () => void;
  onSubmit: () => void;
  onOpenSettings: () => void;
  onOpenDate: (date: string,) => void;
  onApplyChange: (date: string,) => void;
  onDiscardChange: (date: string,) => void;
}

export function AiComposer({
  open,
  prompt,
  answer,
  citations,
  pendingChanges,
  applyingDates,
  hasAiConfigured,
  isSubmitting,
  error,
  onPromptChange,
  onClose,
  onSubmit,
  onOpenSettings,
  onOpenDate,
  onApplyChange,
  onDiscardChange,
}: AiComposerProps,) {
  const inputRef = useRef<HTMLInputElement>(null,);

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
      {open && (
        <div
          className="fixed inset-0 bg-black/20 backdrop-blur-[1px]"
          onClick={onClose}
        />
      )}

      <div className="relative mx-auto w-full max-w-2xl px-4 pb-5">
        <div className="space-y-3">
          <AiResultPanel
            answer={answer}
            citations={citations}
            pendingChanges={pendingChanges}
            applyingDates={applyingDates}
            onOpenDate={onOpenDate}
            onApplyChange={onApplyChange}
            onDiscardChange={onDiscardChange}
          />

          <div className="overflow-hidden rounded-[28px] border border-gray-200 bg-white/95 shadow-[0_-20px_60px_rgba(15,23,42,0.18)] backdrop-blur-xl">
            {!hasAiConfigured
              ? (
                <div className="space-y-4 px-5 py-5">
                  <p className="text-sm leading-6 text-gray-600">
                    AI isn&apos;t configured yet. Add your Anthropic API key to start using note commands.
                  </p>
                  <button
                    onClick={onOpenSettings}
                    className="inline-flex items-center rounded-full bg-gray-900 px-4 py-2 text-sm text-white transition-colors hover:bg-gray-700"
                    style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                  >
                    Click to configure AI
                  </button>
                </div>
              )
              : (
                <div className="space-y-3 px-4 py-4">
                  <form
                    className="flex items-center gap-3 rounded-[22px] border border-gray-200 bg-white px-3 py-3"
                    onSubmit={(event,) => {
                      event.preventDefault();
                      onSubmit();
                    }}
                  >
                    <input
                      ref={inputRef}
                      value={prompt}
                      onChange={(event,) => onPromptChange(event.target.value,)}
                      placeholder="chat with notes."
                      className="min-w-0 flex-1 bg-transparent px-2 text-sm text-gray-900 outline-hidden placeholder:text-gray-400"
                    />
                    <button
                      type="submit"
                      disabled={isSubmitting || !prompt.trim()}
                      className="shrink-0 rounded-full bg-gray-900 px-4 py-2 text-sm text-white transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
                      style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                    >
                      {isSubmitting ? "Running..." : "Run"}
                    </button>
                  </form>
                  <div className="flex items-center justify-between gap-3 px-2">
                    <div className="min-w-0">
                      {error && <p className="truncate text-sm text-red-500">{error}</p>}
                    </div>
                    <button
                      onClick={onClose}
                      className="shrink-0 text-xs text-gray-400 transition-colors hover:text-gray-600"
                      style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                    >
                      esc
                    </button>
                  </div>
                </div>
              )}
          </div>
        </div>
      </div>
    </div>
  );
}
