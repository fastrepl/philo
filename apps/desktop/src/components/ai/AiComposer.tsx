import { ArrowUp, Square, } from "lucide-react";
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
  onStop: () => void;
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
  onSubmit,
  onStop,
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
      <div className="relative mx-auto w-full max-w-2xl px-4 pb-3">
        <div className="space-y-2">
          <AiResultPanel
            isThinking={isSubmitting}
            answer={answer}
            citations={citations}
            pendingChanges={pendingChanges}
            applyingDates={applyingDates}
            onOpenDate={onOpenDate}
            onApplyChange={onApplyChange}
            onDiscardChange={onDiscardChange}
          />

          {!hasAiConfigured
            ? (
              <div className="overflow-hidden rounded-[28px] border border-gray-200 bg-white px-5 py-5 shadow-[0_-20px_60px_rgba(15,23,42,0.12)]">
                <div className="space-y-4">
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
              </div>
            )
            : (
              <div className="space-y-2">
                <form
                  className="flex items-center gap-3 rounded-[28px] border border-gray-200 bg-white px-4 py-3 shadow-[0_-16px_44px_rgba(15,23,42,0.1)]"
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
                    className="min-w-0 flex-1 bg-transparent px-1 text-[15px] text-gray-900 outline-hidden placeholder:text-gray-400"
                  />
                  <button
                    type={isSubmitting ? "button" : "submit"}
                    disabled={!isSubmitting && !prompt.trim()}
                    onClick={isSubmitting ? onStop : undefined}
                    aria-label={isSubmitting ? "Stop generating" : "Send message"}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
                    style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                  >
                    {isSubmitting
                      ? <Square size={14} fill="currentColor" strokeWidth={0} />
                      : <ArrowUp size={18} strokeWidth={2.25} />}
                  </button>
                </form>
                {error && <p className="px-3 text-sm text-red-500">{error}</p>}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
