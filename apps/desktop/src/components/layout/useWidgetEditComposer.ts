import { useCallback, useRef, } from "react";
import { useMountEffect, } from "../../hooks/useMountEffect";
import type { AssistantScope, } from "../../services/assistant";
import {
  registerWidgetEditComposerController,
  setWidgetEditBuildState,
  submitWidgetEditInstruction,
  useWidgetEditSessionStore,
} from "../editor/extensions/widget/edit-session";

export function useWidgetEditComposer({
  aiPrompt,
  clearWidgetEditSession,
  refreshAiAvailability,
  runAiPrompt,
  setAiComposerOpen,
  setAiError,
  setAiPrompt,
  setAiScope,
  setAiSelectedLabel,
  setAiSelectedText,
  setAiSelectionHighlight,
}: {
  aiPrompt: string;
  clearWidgetEditSession: (widgetId?: string | null,) => void;
  refreshAiAvailability: () => void;
  runAiPrompt: (prompt: string,) => Promise<void>;
  setAiComposerOpen: (open: boolean,) => void;
  setAiError: (value: string | null,) => void;
  setAiPrompt: (value: string,) => void;
  setAiScope: (scope: AssistantScope,) => void;
  setAiSelectedLabel: (value: string | null,) => void;
  setAiSelectedText: (value: string | null,) => void;
  setAiSelectionHighlight: (value: { noteDate: string; from: number; to: number; } | null,) => void;
},) {
  const widgetEditState = useWidgetEditSessionStore();
  const widgetEditSession = widgetEditState.session;
  const widgetEditSubmitting = widgetEditState.isBuilding;
  const controllerRef = useRef({
    finishBuild: (_widgetId: string,) => {},
    openSession: (_title: string,) => {},
  },);

  const openWidgetEditSession = useCallback((title: string,) => {
    setAiScope("recent",);
    setAiSelectedText(null,);
    setAiSelectedLabel(`[Edit widget] ${title}`,);
    setAiSelectionHighlight(null,);
    setAiPrompt("",);
    setAiError(null,);
    setAiComposerOpen(true,);
    refreshAiAvailability();
  }, [
    refreshAiAvailability,
    setAiComposerOpen,
    setAiError,
    setAiPrompt,
    setAiScope,
    setAiSelectedLabel,
    setAiSelectedText,
    setAiSelectionHighlight,
  ],);

  const finishWidgetEditBuild = useCallback((widgetId: string,) => {
    setAiPrompt("",);
    setAiComposerOpen(false,);
    setAiError(null,);
    setAiSelectedText(null,);
    setAiSelectionHighlight(null,);
    clearWidgetEditSession(widgetId,);
    setAiSelectedLabel(null,);
  }, [
    clearWidgetEditSession,
    setAiComposerOpen,
    setAiError,
    setAiPrompt,
    setAiSelectedLabel,
    setAiSelectedText,
    setAiSelectionHighlight,
  ],);

  controllerRef.current.openSession = (title: string,) => {
    openWidgetEditSession(title,);
  };
  controllerRef.current.finishBuild = (widgetId: string,) => {
    finishWidgetEditBuild(widgetId,);
  };

  useMountEffect(() => {
    return registerWidgetEditComposerController({
      finishBuild: (widgetId,) => {
        controllerRef.current.finishBuild(widgetId,);
      },
      openSession: (session,) => {
        controllerRef.current.openSession(session.title,);
      },
    },);
  },);

  const handleAiSubmit = useCallback(async () => {
    if (widgetEditSession) {
      const instruction = aiPrompt.trim();
      if (!instruction) return;
      setWidgetEditBuildState(widgetEditSession.widgetId, true,);
      const submitted = await submitWidgetEditInstruction(instruction,);
      if (!submitted) {
        clearWidgetEditSession();
        setAiError("Widget editor is no longer available.",);
      }
      return;
    }

    await runAiPrompt(aiPrompt,);
  }, [aiPrompt, clearWidgetEditSession, runAiPrompt, setAiError, widgetEditSession,],);

  return {
    handleAiSubmit,
    widgetEditSession,
    widgetEditSubmitting,
  };
}
