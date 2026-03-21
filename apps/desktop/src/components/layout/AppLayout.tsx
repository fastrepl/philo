import { invoke, } from "@tauri-apps/api/core";
import { listen, } from "@tauri-apps/api/event";
import { getCurrentWindow, } from "@tauri-apps/api/window";
import { watch, } from "@tauri-apps/plugin-fs";
import { openPath, } from "@tauri-apps/plugin-opener";
import type { Editor as TiptapEditor, } from "@tiptap/core";
import { ChevronLeft, ChevronRight, FileText, House, MapPin, Plus, } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, } from "react";
import { useCurrentDate, } from "../../hooks/useCurrentDate";
import { useCurrentCity, } from "../../hooks/useTimezoneCity";
import { getAiConfigurationMessage, } from "../../services/ai";
import { runAiSlashCommand, } from "../../services/ai-slash-commands";
import {
  AI_NOT_CONFIGURED,
  applyAssistantPendingChanges,
  type AssistantResult,
  type AssistantScope,
  runAssistant,
} from "../../services/assistant";
import {
  appendChatHistoryTurn,
  buildChatHistoryEntry,
  type ChatHistoryEntry,
  deriveChatTitle,
  getLatestChatTurn,
  loadChatHistory,
  replaceLatestChatHistoryTurnResult,
  saveChatHistoryEntry,
} from "../../services/chats";
import { syncGoogleImports, } from "../../services/google-imports";
import type { LibraryItem, } from "../../services/library";
import { cleanupLegacyLibraryState, } from "../../services/library";
import { getJournalDir, initJournalScope, parseDateFromNoteLinkTarget, sanitizePageTitle, } from "../../services/paths";
import { getFilenamePattern, hasActiveAiProvider, loadSettings, } from "../../services/settings";
import {
  createAttachedPage,
  getOrCreateDailyNote,
  listPagesAttachedTo,
  loadDailyNote,
  loadPage,
  loadPastNotes,
  saveDailyNote,
  savePage,
} from "../../services/storage";
import { rolloverTasks, } from "../../services/tasks";
import {
  checkForUpdate,
  consumePendingPostUpdate,
  type PostUpdateInfo,
  type UpdateInfo,
} from "../../services/updater";
import { createWidgetFile, } from "../../services/widget-files";
import { recordWidgetGitRevision, } from "../../services/widget-git-history";
import { stringifyStorageSchema, } from "../../services/widget-storage";
import { type AttachedPage, DailyNote, formatDate, getDaysAgo, isToday, type PageNote, } from "../../types/note";
import { AiComposer, } from "../ai/AiComposer";
import {
  WIDGET_BUILD_STATE_EVENT,
  WIDGET_EDIT_REQUEST_EVENT,
  WIDGET_EDIT_STATE_EVENT,
  WIDGET_EDIT_SUBMIT_EVENT,
  type WidgetBuildStateDetail,
  type WidgetEditRequestDetail,
} from "../editor/extensions/widget/events";
import EditableNote, { type EditableNoteHandle, type EditableNoteSelection, } from "../journal/EditableNote";
import { LibraryDrawer, } from "../library/LibraryDrawer";
import { OnboardingModal, } from "../onboarding/OnboardingModal";
import { SettingsModal, } from "../settings/SettingsModal";
import { UpdateBanner, } from "../UpdateBanner";

const LOCAL_SAVE_WATCH_SUPPRESSION_MS = 1000;
const NOTE_SCROLL_OFFSET_PX = 56;

function noteChanged(current: DailyNote | null, incoming: DailyNote,): boolean {
  if (!current) return true;
  return current.content !== incoming.content || current.city !== incoming.city;
}

interface GlobalSearchResult {
  kind: "daily" | "page";
  path: string;
  relativePath: string;
  title: string;
  snippet: string;
}

interface AiSelectionHighlight {
  noteDate: string;
  from: number;
  to: number;
}

type AppView = { kind: "home"; } | { kind: "page"; title: string; };

function renderSearchSnippet(snippet: string,) {
  const parts = snippet.split(/(\[[^\]]+\])/,);
  return parts.filter(Boolean,).map((part, index,) => {
    if (part.startsWith("[",) && part.endsWith("]",) && part.length > 2) {
      return (
        <mark
          key={`h-${index}`}
          className="bg-yellow-200 dark:bg-yellow-500/70 text-gray-900 rounded px-0.5"
        >
          {part.slice(1, -1,)}
        </mark>
      );
    }
    return <Fragment key={`t-${index}`}>{part}</Fragment>;
  },);
}

function DateHeader({
  date,
  city,
  fallbackCity,
  onCityChange,
}: {
  date: string;
  city?: string | null;
  fallbackCity?: string | null;
  onCityChange?: (city: string | null,) => void;
},) {
  const showToday = isToday(date,);
  const [isEditingCity, setIsEditingCity,] = useState(false,);
  const displayCity = city?.trim() || fallbackCity?.trim() || "";
  const [draftCity, setDraftCity,] = useState(displayCity,);
  const cityInputWidthCh = Math.max(draftCity.length, "Add city".length,) + 1;

  useEffect(() => {
    if (!isEditingCity) {
      setDraftCity(displayCity,);
    }
  }, [displayCity, isEditingCity,],);

  const cancelCityEdit = () => {
    setDraftCity(displayCity,);
    setIsEditingCity(false,);
  };

  const saveCity = () => {
    const nextCity = draftCity.trim();
    if (nextCity !== displayCity) {
      onCityChange?.(nextCity || null,);
    }
    setIsEditingCity(false,);
  };

  return (
    <div className="flex items-center gap-4">
      <h1
        className="text-2xl italic text-gray-900 dark:text-white"
        style={{ fontFamily: '"Instrument Serif", serif', }}
      >
        {formatDate(date,)}
      </h1>
      {showToday && (
        <span
          className="text-xs font-medium uppercase tracking-wide px-3 py-1 rounded-md text-white font-sans"
          style={{ background: "linear-gradient(to bottom, #4b5563, #1f2937)", }}
        >
          today
        </span>
      )}
      {(displayCity || onCityChange) && (
        <div className="inline-flex items-center gap-1.5 text-gray-400 dark:text-gray-500">
          <MapPin className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          {isEditingCity && onCityChange
            ? (
              <input
                autoFocus
                value={draftCity}
                onChange={(event,) => setDraftCity(event.target.value,)}
                onClick={(event,) => event.stopPropagation()}
                onMouseDown={(event,) => event.stopPropagation()}
                onBlur={saveCity}
                onKeyDown={(event,) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    saveCity();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelCityEdit();
                  }
                }}
                placeholder="Add city"
                className="min-w-0 bg-transparent text-sm text-gray-500 dark:text-gray-400 font-sans focus:outline-hidden"
                style={{ width: `${cityInputWidthCh}ch`, maxWidth: "100%", }}
              />
            )
            : (
              onCityChange
                ? (
                  <button
                    type="button"
                    onMouseDown={(event,) => event.stopPropagation()}
                    onClick={(event,) => {
                      event.stopPropagation();
                      setIsEditingCity(true,);
                    }}
                    className="cursor-pointer text-sm text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 font-sans transition-colors"
                    title="Click to change city"
                  >
                    {displayCity || "Add city"}
                  </button>
                )
                : (
                  <span className="text-sm text-gray-400 dark:text-gray-500 font-sans">
                    {displayCity}
                  </span>
                )
            )}
        </div>
      )}
    </div>
  );
}

function AttachedPagesRow({
  pages,
  onCreatePage,
  onOpenPage,
}: {
  pages: AttachedPage[];
  onCreatePage?: () => void;
  onOpenPage?: (title: string,) => void;
},) {
  if (pages.length === 0 && !onCreatePage) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {pages.map((page,) => (
        <button
          key={page.path}
          type="button"
          onClick={() => onOpenPage?.(page.title,)}
          className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:border-gray-600 dark:hover:text-white"
        >
          <FileText className="h-3.5 w-3.5" strokeWidth={2} />
          <span>{page.title}</span>
          {page.type === "meeting" && (
            <span
              className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400"
              style={{ fontFamily: "'IBM Plex Mono', monospace", }}
            >
              meeting
            </span>
          )}
        </button>
      ))}
      {onCreatePage && (
        <button
          type="button"
          onClick={onCreatePage}
          className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          <span>Page</span>
        </button>
      )}
    </div>
  );
}

function LazyNote({
  date,
  pagesRevision,
  onOpenDate,
  onOpenPage,
  onCreatePage,
  onInteract,
  onChatSelection,
  onSelectionChange,
  onSelectionBlur,
  persistentSelectionRange,
}: {
  date: string;
  pagesRevision: number;
  onOpenDate?: (date: string,) => void;
  onOpenPage?: (title: string,) => void;
  onCreatePage?: (date: string,) => void;
  onInteract?: () => void;
  onChatSelection?: (selection: EditableNoteSelection,) => void;
  onSelectionChange?: (selection: EditableNoteSelection | null,) => void;
  onSelectionBlur?: (editor: TiptapEditor,) => void;
  persistentSelectionRange?: { from: number; to: number; } | null;
},) {
  const [note, setNote,] = useState<DailyNote | null>(null,);
  const [attachedPages, setAttachedPages,] = useState<AttachedPage[]>([],);
  const containerRef = useRef<HTMLDivElement>(null,);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry,],) => {
        if (entry.isIntersecting) {
          Promise.all([loadDailyNote(date,), listPagesAttachedTo(date,),])
            .then(([loadedNote, pages,]) => {
              setNote(loadedNote,);
              setAttachedPages(pages,);
            },)
            .catch(console.error,);
        }
      },
      { rootMargin: "400px", },
    );

    observer.observe(el,);
    return () => observer.disconnect();
  }, [date, pagesRevision,],);

  const handleCityChange = useCallback((city: string | null,) => {
    if (!note || note.city === city) return;
    const updated = { ...note, city, };
    setNote(updated,);
    saveDailyNote(updated,).catch(console.error,);
  }, [note,],);

  return (
    <div ref={containerRef} className="min-h-[400px]">
      {note && (
        <>
          <div className="px-6 pt-12 pb-4">
            <DateHeader date={note.date} city={note.city} onCityChange={handleCityChange} />
            <AttachedPagesRow
              pages={attachedPages}
              onOpenPage={onOpenPage}
              onCreatePage={onCreatePage ? () => onCreatePage(date,) : undefined}
            />
          </div>
          <EditableNote
            note={note}
            onOpenDate={onOpenDate}
            onInteract={onInteract}
            onChatSelection={onChatSelection}
            onSelectionChange={onSelectionChange}
            onSelectionBlur={onSelectionBlur}
            persistentSelectionRange={persistentSelectionRange}
          />
        </>
      )}
    </div>
  );
}

function PageView({
  title,
  pagesRevision,
  onOpenDate,
  onInteract,
}: {
  title: string;
  pagesRevision: number;
  onOpenDate?: (date: string,) => void;
  onInteract?: () => void;
},) {
  const [page, setPage,] = useState<PageNote | null>(null,);

  useEffect(() => {
    loadPage(title,).then(setPage,).catch(console.error,);
  }, [pagesRevision, title,],);

  const handleSave = useCallback((note: DailyNote | PageNote,) => {
    if ("date" in note) return;
    setPage(note,);
    savePage(note,).catch(console.error,);
  }, [],);

  if (!page) {
    return (
      <div className="w-full max-w-3xl px-6 pt-12 pb-10">
        <p className="text-sm text-gray-500 dark:text-gray-400">Page not found.</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl">
      <div className="px-6 pt-12 pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1
            className="text-2xl italic text-gray-900 dark:text-white"
            style={{ fontFamily: '"Instrument Serif", serif', }}
          >
            {page.title}
          </h1>
          {page.type === "meeting" && (
            <span
              className="text-xs font-medium uppercase tracking-wide px-3 py-1 rounded-md text-white font-sans"
              style={{ background: "linear-gradient(to bottom, #4b5563, #1f2937)", }}
            >
              meeting
            </span>
          )}
        </div>
        {page.attachedTo && (
          <button
            type="button"
            onClick={() => onOpenDate?.(page.attachedTo!,)}
            className="mt-3 text-sm text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          >
            Attached to {formatDate(page.attachedTo,)}
          </button>
        )}
      </div>
      <EditableNote
        note={page}
        onSave={handleSave}
        onOpenDate={onOpenDate}
        onInteract={onInteract}
      />
    </div>
  );
}

export default function AppLayout() {
  const today = useCurrentDate();
  const currentCity = useCurrentCity();
  const [todayNote, setTodayNote,] = useState<DailyNote | null>(null,);
  const [todayAttachedPages, setTodayAttachedPages,] = useState<AttachedPage[]>([],);
  const pastDates = useMemo(() => Array.from({ length: 30, }, (_, i,) => getDaysAgo(i + 1,),), [today,],);
  const [settingsOpen, setSettingsOpen,] = useState(false,);
  const [libraryOpen, setLibraryOpen,] = useState(false,);
  const [onboardingOpen, setOnboardingOpen,] = useState(false,);
  const [isConfigured, setIsConfigured,] = useState(false,);
  const [storageRevision, setStorageRevision,] = useState(0,);
  const [pagesRevision, setPagesRevision,] = useState(0,);
  const [updateInfo, setUpdateInfo,] = useState<UpdateInfo | null>(null,);
  const [postUpdateInfo, setPostUpdateInfo,] = useState<PostUpdateInfo | null>(null,);
  const [isPinned, setIsPinned,] = useState(false,);
  const [isWindowFocused, setIsWindowFocused,] = useState(() => document.hasFocus());
  const [globalSearchOpen, setGlobalSearchOpen,] = useState(false,);
  const [globalSearchQuery, setGlobalSearchQuery,] = useState("",);
  const [globalSearchResults, setGlobalSearchResults,] = useState<GlobalSearchResult[]>([],);
  const [globalSearchSelectedIndex, setGlobalSearchSelectedIndex,] = useState(-1,);
  const [globalSearchLoading, setGlobalSearchLoading,] = useState(false,);
  const [globalSearchError, setGlobalSearchError,] = useState<string | null>(null,);
  const [focusedDate, setFocusedDate,] = useState<string | null>(null,);
  const [pendingScrollDate, setPendingScrollDate,] = useState<string | null>(null,);
  const [aiComposerOpen, setAiComposerOpen,] = useState(false,);
  const [aiPrompt, setAiPrompt,] = useState("",);
  const [aiSelectedText, setAiSelectedText,] = useState<string | null>(null,);
  const [aiSelectedLabel, setAiSelectedLabel,] = useState<string | null>(null,);
  const [aiSelectionHighlight, setAiSelectionHighlight,] = useState<AiSelectionHighlight | null>(null,);
  const [aiScope, setAiScope,] = useState<AssistantScope>("recent",);
  const [hasAiConfigured, setHasAiConfigured,] = useState(false,);
  const [aiRunning, setAiRunning,] = useState(false,);
  const [aiError, setAiError,] = useState<string | null>(null,);
  const [aiResult, setAiResult,] = useState<AssistantResult | null>(null,);
  const [aiChatHistory, setAiChatHistory,] = useState<ChatHistoryEntry[]>([],);
  const [aiActiveChatId, setAiActiveChatId,] = useState<string | null>(null,);
  const [aiLatestChatId, setAiLatestChatId,] = useState<string | null>(null,);
  const [aiApplyingDates, setAiApplyingDates,] = useState<string[]>([],);
  const [widgetEditSession, setWidgetEditSession,] = useState<WidgetEditRequestDetail | null>(null,);
  const [widgetEditSubmitting, setWidgetEditSubmitting,] = useState(false,);
  const [viewState, setViewState,] = useState<{ history: AppView[]; index: number; }>({
    history: [{ kind: "home", }],
    index: 0,
  },);
  const aiAbortControllerRef = useRef<AbortController | null>(null,);
  const currentSelectionRef = useRef<EditableNoteSelection | null>(null,);
  const aiLastSubmittedPromptRef = useRef("",);
  const widgetEditSessionRef = useRef<WidgetEditRequestDetail | null>(null,);
  const todayNoteRef = useRef<DailyNote | null>(null,);
  const todayEditorRef = useRef<EditableNoteHandle>(null,);
  const homeScrollTopRef = useRef(0,);
  const restoreHomeScrollTopRef = useRef<number | null>(null,);
  const googleSyncRef = useRef<Promise<boolean> | null>(null,);
  const suppressWatcherUntilRef = useRef(0,);
  const searchInputRef = useRef<HTMLInputElement>(null,);
  const searchResultRefs = useRef<(HTMLButtonElement | null)[]>([],);
  const searchNavigationModeRef = useRef<"mouse" | "keyboard">("mouse",);
  const currentView = viewState.history[viewState.index] ?? { kind: "home", };
  const canGoBack = viewState.index > 0;
  const canGoForward = viewState.index < viewState.history.length - 1;
  useEffect(() => {
    todayNoteRef.current = todayNote;
  }, [todayNote,],);

  useEffect(() => {
    widgetEditSessionRef.current = widgetEditSession;
  }, [widgetEditSession,],);

  const upsertAiChatHistoryEntry = useCallback((entry: ChatHistoryEntry, persist = true,) => {
    setAiChatHistory((current,) => {
      const next = [entry, ...current.filter((item,) => item.id !== entry.id),];
      next.sort((left, right,) => right.updatedAt.localeCompare(left.updatedAt,));
      return next;
    },);
    if (persist) {
      saveChatHistoryEntry(entry,).catch(console.error,);
    }
  }, [],);

  const activeAiChat = useMemo(
    () => aiChatHistory.find((chat,) => chat.id === aiActiveChatId) ?? null,
    [aiActiveChatId, aiChatHistory,],
  );
  const canApplyPendingChanges = !aiRunning && !!aiResult && !!activeAiChat && activeAiChat.id === aiLatestChatId;
  const aiPanelTitle = useMemo(() => {
    if (activeAiChat) return activeAiChat.title;
    return aiPrompt.trim() ? deriveChatTitle(aiPrompt, null,) : null;
  }, [activeAiChat, aiPrompt,],);

  const syncLatestAiChatHistory = useCallback((result: AssistantResult | null,) => {
    if (!aiLatestChatId) return;
    const existing = aiChatHistory.find((chat,) => chat.id === aiLatestChatId);
    if (!existing) return;

    upsertAiChatHistoryEntry(replaceLatestChatHistoryTurnResult(existing, {
      answer: result?.answer ?? "",
      citations: result?.citations ?? [],
      pendingChanges: result?.pendingChanges ?? [],
    },),);
  }, [aiChatHistory, aiLatestChatId, upsertAiChatHistoryEntry,],);

  const clearWidgetEditSession = useCallback(() => {
    const activeSession = widgetEditSessionRef.current;
    if (activeSession?.widgetId) {
      window.dispatchEvent(
        new CustomEvent(WIDGET_EDIT_STATE_EVENT, {
          detail: { widgetId: activeSession.widgetId, isEditing: false, },
        },),
      );
    }
    widgetEditSessionRef.current = null;
    setWidgetEditSession(null,);
    setWidgetEditSubmitting(false,);
    setAiSelectedLabel(null,);
  }, [],);

  const syncTodayNoteFromDisk = useCallback(() => {
    loadDailyNote(today,)
      .then((reloaded,) => {
        if (!reloaded) return;
        if (noteChanged(todayNoteRef.current, reloaded,)) {
          setTodayNote(reloaded,);
        }
      },)
      .catch(console.error,);
  }, [today,],);

  const syncTodayAttachedPages = useCallback(() => {
    listPagesAttachedTo(today,).then(setTodayAttachedPages,).catch(console.error,);
  }, [today,],);

  const handleViewTransition = useCallback((from: AppView, to: AppView,) => {
    if (from.kind === "home" && to.kind === "page") {
      homeScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
    }

    if (from.kind === "page" && to.kind === "home") {
      restoreHomeScrollTopRef.current = homeScrollTopRef.current;
    }
  }, [],);

  const pushView = useCallback((nextView: AppView,) => {
    setViewState((current,) => {
      const activeView = current.history[current.index] ?? { kind: "home", };
      if (JSON.stringify(activeView,) === JSON.stringify(nextView,)) {
        return current;
      }

      handleViewTransition(activeView, nextView,);
      return {
        history: [...current.history.slice(0, current.index + 1,), nextView,],
        index: current.index + 1,
      };
    },);
  }, [handleViewTransition,],);

  const goBack = useCallback(() => {
    setViewState((current,) => {
      if (current.index === 0) return current;
      handleViewTransition(current.history[current.index], current.history[current.index - 1],);
      return { ...current, index: current.index - 1, };
    },);
  }, [handleViewTransition,],);

  const goForward = useCallback(() => {
    setViewState((current,) => {
      if (current.index >= current.history.length - 1) return current;
      handleViewTransition(current.history[current.index], current.history[current.index + 1],);
      return { ...current, index: current.index + 1, };
    },);
  }, [handleViewTransition,],);

  const goHome = useCallback(() => {
    pushView({ kind: "home", },);
  }, [pushView,],);

  const openPageView = useCallback((title: string,) => {
    const normalizedTitle = sanitizePageTitle(title,);
    if (!normalizedTitle) return;
    pushView({ kind: "page", title: normalizedTitle, },);
  }, [pushView,],);

  const runGoogleSync = useCallback(async () => {
    if (googleSyncRef.current) {
      return await googleSyncRef.current;
    }

    const active = syncGoogleImports()
      .catch((error,) => {
        console.error(error,);
        return false;
      },)
      .finally(() => {
        googleSyncRef.current = null;
      },);

    googleSyncRef.current = active;
    return await active;
  }, [],);

  const getCurrentTodayNoteForAi = useCallback(() => {
    const note = todayNoteRef.current;
    if (!note) return null;
    const editor = todayEditorRef.current?.editor;
    if (!editor || editor.isDestroyed) return note;
    return {
      ...note,
      content: JSON.stringify(editor.getJSON(),),
    };
  }, [],);

  const openGlobalSearch = useCallback(() => {
    clearWidgetEditSession();
    setAiComposerOpen(false,);
    setAiSelectedText(null,);
    setAiSelectionHighlight(null,);
    setAiError(null,);
    setGlobalSearchOpen(true,);
  }, [clearWidgetEditSession,],);

  const closeGlobalSearch = useCallback(() => {
    setGlobalSearchOpen(false,);
    setGlobalSearchQuery("",);
    setGlobalSearchResults([],);
    setGlobalSearchSelectedIndex(-1,);
    setGlobalSearchLoading(false,);
    setGlobalSearchError(null,);
  }, [],);

  const refreshAiAvailability = useCallback(() => {
    loadSettings()
      .then((settings,) => {
        setHasAiConfigured(hasActiveAiProvider(settings,),);
      },)
      .catch(console.error,);
  }, [],);

  const openAiComposer = useCallback((selection?: EditableNoteSelection | string,) => {
    const nextSelection = typeof selection === "string"
      ? currentSelectionRef.current
      : selection ?? currentSelectionRef.current;
    const nextSelectedText = typeof selection === "string"
      ? selection.trim() || nextSelection?.text || null
      : selection?.text || nextSelection?.text || null;
    clearWidgetEditSession();
    setGlobalSearchOpen(false,);
    setAiScope("recent",);
    setAiSelectedText(nextSelectedText,);
    setAiSelectionHighlight(
      nextSelection
        ? { noteDate: nextSelection.noteDate, from: nextSelection.from, to: nextSelection.to, }
        : null,
    );
    setAiComposerOpen(true,);
    setAiError(null,);
    refreshAiAvailability();
  }, [clearWidgetEditSession, refreshAiAvailability,],);

  const handleStartNewAiChat = useCallback(() => {
    const selection = currentSelectionRef.current;
    setAiActiveChatId(null,);
    setAiPrompt("",);
    setAiResult(null,);
    setAiError(null,);
    setAiSelectedLabel(null,);
    setAiSelectedText(selection?.text ?? null,);
    setAiSelectionHighlight(
      selection ? { noteDate: selection.noteDate, from: selection.from, to: selection.to, } : null,
    );
    setAiScope("recent",);
    aiLastSubmittedPromptRef.current = "";
  }, [],);

  const closeAiComposer = useCallback(() => {
    clearWidgetEditSession();
    setAiComposerOpen(false,);
    setAiError(null,);
    setAiSelectedText(null,);
    setAiSelectionHighlight(null,);
  }, [clearWidgetEditSession,],);

  const handleAiSelectionChange = useCallback((selection: EditableNoteSelection | null,) => {
    currentSelectionRef.current = selection;
    if (aiComposerOpen) {
      setAiSelectedText(selection?.text ?? null,);
      setAiSelectionHighlight(
        selection
          ? { noteDate: selection.noteDate, from: selection.from, to: selection.to, }
          : null,
      );
    }
  }, [aiComposerOpen,],);

  const handleAiSelectionBlur = useCallback((editor: TiptapEditor,) => {
    if (currentSelectionRef.current?.editor === editor) {
      currentSelectionRef.current = null;
    }
  }, [],);

  const getCurrentSelectionText = useCallback(() => {
    return currentSelectionRef.current?.text || window.getSelection?.()?.toString().trim() || undefined;
  }, [],);

  const toggleLibrary = useCallback(() => {
    setLibraryOpen((prev,) => !prev);
  }, [],);

  const navigateToDate = useCallback((date: string,) => {
    closeGlobalSearch();
    if (currentView.kind !== "home") {
      goHome();
    }
    const isVisibleInFeed = date === today || pastDates.includes(date,);
    setFocusedDate(isVisibleInFeed ? null : date,);
    setPendingScrollDate(date,);
  }, [closeGlobalSearch, currentView.kind, goHome, pastDates, today,],);

  const openGlobalSearchResult = useCallback(async (result: GlobalSearchResult | undefined,) => {
    if (!result) return;

    try {
      const pattern = await getFilenamePattern();
      const date = parseDateFromNoteLinkTarget(result.relativePath, pattern,);
      if (date) {
        navigateToDate(date,);
        return;
      }
    } catch (error) {
      console.error(error,);
    }

    openPath(result.path,).catch(console.error,);
  }, [navigateToDate,],);

  // Load configuration and extend FS scope on mount
  useEffect(() => {
    void cleanupLegacyLibraryState();
    loadSettings()
      .then(async (settings,) => {
        setHasAiConfigured(hasActiveAiProvider(settings,),);
        const hasJournalConfig = !!settings.journalDir || !!settings.vaultDir;
        if (settings.hasCompletedOnboarding || hasJournalConfig) {
          await initJournalScope();
          setIsConfigured(true,);
        } else {
          setOnboardingOpen(true,);
        }
      },)
      .catch(console.error,);
  }, [],);

  useEffect(() => {
    if (!isConfigured) return;
    loadChatHistory()
      .then((history,) => {
        setAiChatHistory(history,);
        setAiActiveChatId((current,) => current ?? history[0]?.id ?? null);
        setAiLatestChatId((current,) => current ?? history[0]?.id ?? null);
      },)
      .catch(console.error,);
  }, [isConfigured,],);

  // Poll for app updates every 5 minutes
  useEffect(() => {
    const poll = () => {
      checkForUpdate().then((info,) => {
        if (info) setUpdateInfo(info,);
      },);
    };
    poll();
    const id = setInterval(poll, 5 * 60 * 1000,);
    return () => clearInterval(id,);
  }, [],);

  useEffect(() => {
    consumePendingPostUpdate()
      .then((info,) => {
        if (info) setPostUpdateInfo(info,);
      },)
      .catch(console.error,);
  }, [],);

  // Listen for macOS menu bar events
  useEffect(() => {
    const unlistenSettings = listen("open-settings", () => setSettingsOpen(true,),);
    const unlistenLibrary = listen("toggle-library", toggleLibrary,);
    const unlistenGlobalSearch = listen("open-global-search", () => openGlobalSearch(),);
    const unlistenUpdate = listen("update-available", () => {
      checkForUpdate().then((info,) => {
        if (info) setUpdateInfo(info,);
      },);
    },);
    return () => {
      unlistenSettings.then((fn,) => fn());
      unlistenLibrary.then((fn,) => fn());
      unlistenGlobalSearch.then((fn,) => fn());
      unlistenUpdate.then((fn,) => fn());
    };
  }, [openGlobalSearch, toggleLibrary,],);

  useEffect(() => {
    const handleHotkey = (event: KeyboardEvent,) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n" && aiComposerOpen) {
        event.preventDefault();
        handleStartNewAiChat();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        if (aiComposerOpen) {
          closeAiComposer();
        } else {
          openAiComposer(currentSelectionRef.current ?? getCurrentSelectionText(),);
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        toggleLibrary();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openGlobalSearch();
        return;
      }

      if (globalSearchOpen && globalSearchResults.length > 0 && event.key === "ArrowDown") {
        event.preventDefault();
        searchNavigationModeRef.current = "keyboard";
        setGlobalSearchSelectedIndex((prev,) => {
          const lastIndex = globalSearchResults.length - 1;
          if (prev < 0) return 0;
          if (prev >= lastIndex) return lastIndex;
          return prev + 1;
        },);
        return;
      }

      if (globalSearchOpen && globalSearchResults.length > 0 && event.key === "ArrowUp") {
        event.preventDefault();
        searchNavigationModeRef.current = "keyboard";
        setGlobalSearchSelectedIndex((prev,) => {
          if (prev <= 0) return 0;
          return prev - 1;
        },);
        return;
      }

      if (globalSearchOpen && event.key === "Enter" && globalSearchSelectedIndex >= 0) {
        event.preventDefault();
        openGlobalSearchResult(globalSearchResults[globalSearchSelectedIndex],);
        return;
      }

      if (event.key === "Escape" && globalSearchOpen) {
        event.preventDefault();
        closeGlobalSearch();
        return;
      }

      if (event.key === "Escape" && aiComposerOpen) {
        event.preventDefault();
        closeAiComposer();
      }
    };
    window.addEventListener("keydown", handleHotkey,);
    return () => window.removeEventListener("keydown", handleHotkey,);
  }, [
    aiComposerOpen,
    closeAiComposer,
    closeGlobalSearch,
    globalSearchOpen,
    globalSearchResults,
    globalSearchSelectedIndex,
    getCurrentSelectionText,
    handleStartNewAiChat,
    openAiComposer,
    openGlobalSearch,
    openGlobalSearchResult,
    toggleLibrary,
  ],);

  useEffect(() => {
    if (!globalSearchOpen) return;
    searchNavigationModeRef.current = "mouse";
    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 0,);
    return () => window.clearTimeout(timer,);
  }, [globalSearchOpen,],);

  useEffect(() => {
    if (!globalSearchOpen) return;
    const handleMouseMove = () => {
      searchNavigationModeRef.current = "mouse";
    };
    window.addEventListener("mousemove", handleMouseMove, { passive: true, },);
    return () => window.removeEventListener("mousemove", handleMouseMove,);
  }, [globalSearchOpen,],);

  useEffect(() => {
    if (!globalSearchOpen) return;
    const query = globalSearchQuery.trim();
    if (!query) {
      setGlobalSearchResults([],);
      setGlobalSearchSelectedIndex(-1,);
      setGlobalSearchLoading(false,);
      setGlobalSearchError(null,);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setGlobalSearchLoading(true,);
      setGlobalSearchError(null,);
      (async () => {
        try {
          const rootDir = await getJournalDir();
          const results = await invoke<GlobalSearchResult[]>("search_markdown_files", {
            rootDir,
            query,
            limit: 120,
          },);
          if (!cancelled) {
            setGlobalSearchResults(results.map((result,) => ({ ...result, kind: "daily", })),);
            setGlobalSearchSelectedIndex(results.length > 0 ? 0 : -1,);
          }
        } catch (error) {
          if (!cancelled) {
            const message = error instanceof Error ? error.message : "Search failed.";
            setGlobalSearchError(message,);
            setGlobalSearchResults([],);
            setGlobalSearchSelectedIndex(-1,);
          }
        } finally {
          if (!cancelled) {
            setGlobalSearchLoading(false,);
          }
        }
      })().catch(console.error,);
    }, 200,);

    return () => {
      cancelled = true;
      window.clearTimeout(timer,);
    };
  }, [globalSearchOpen, globalSearchQuery,],);

  useEffect(() => {
    if (!globalSearchOpen || globalSearchSelectedIndex < 0) return;
    searchResultRefs.current[globalSearchSelectedIndex]?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    },);
  }, [globalSearchOpen, globalSearchSelectedIndex,],);

  useEffect(() => {
    return () => {
      aiAbortControllerRef.current?.abort();
    };
  }, [],);

  useEffect(() => {
    const handleFocus = () => setIsWindowFocused(true,);
    const handleBlur = () => setIsWindowFocused(false,);
    window.addEventListener("focus", handleFocus,);
    window.addEventListener("blur", handleBlur,);
    return () => {
      window.removeEventListener("focus", handleFocus,);
      window.removeEventListener("blur", handleBlur,);
    };
  }, [],);

  useEffect(() => {
    const baseOpacity = 1;
    const inactiveOpacity = Math.max(0.2, Math.min(baseOpacity * 0.55, 0.85,),);
    const targetOpacity = isPinned && !isWindowFocused ? inactiveOpacity : baseOpacity;
    invoke("set_window_opacity", { opacity: targetOpacity, },).catch(console.error,);
  }, [isPinned, isWindowFocused,],);

  // Re-read today's note from disk when the window regains focus (handles external edits)
  useEffect(() => {
    if (!isConfigured) return;
    const handleFocus = () => {
      runGoogleSync().finally(() => {
        syncTodayNoteFromDisk();
      },);
    };
    window.addEventListener("focus", handleFocus,);
    return () => window.removeEventListener("focus", handleFocus,);
  }, [isConfigured, runGoogleSync, syncTodayNoteFromDisk,],);

  // Roll over unchecked tasks from past days, then load today's note
  useEffect(() => {
    if (!isConfigured) return;
    async function load() {
      await rolloverTasks(30,);
      await runGoogleSync();
      const note = await getOrCreateDailyNote(today,);
      const pages = await listPagesAttachedTo(today,);
      setTodayNote(note,);
      setTodayAttachedPages(pages,);
    }
    load().catch(console.error,);
  }, [isConfigured, pagesRevision, runGoogleSync, storageRevision, today,],);

  useEffect(() => {
    if (!isConfigured) return;
    const id = window.setInterval(() => {
      runGoogleSync().then((changed,) => {
        if (changed) {
          syncTodayNoteFromDisk();
        }
      },).catch(console.error,);
    }, 5 * 60 * 1000,);
    return () => window.clearInterval(id,);
  }, [isConfigured, runGoogleSync, syncTodayNoteFromDisk,],);

  useEffect(() => {
    const note = todayNoteRef.current;
    if (!note || note.city?.trim() || !currentCity) return;
    const updated = { ...note, city: currentCity, };
    suppressWatcherUntilRef.current = Date.now() + LOCAL_SAVE_WATCH_SUPPRESSION_MS;
    setTodayNote(updated,);
    saveDailyNote(updated,).catch(console.error,);
  }, [currentCity, todayNote,],);

  // Watch the journal directory for external changes
  useEffect(() => {
    if (!isConfigured) return;
    let unwatch: (() => void) | null = null;

    getJournalDir().then(async (dir,) => {
      unwatch = await watch(
        dir,
        (event,) => {
          if (!event.paths.some((path,) => path.endsWith(".md",))) return;
          if (Date.now() < suppressWatcherUntilRef.current) return;
          syncTodayNoteFromDisk();
        },
        { recursive: true, },
      );
    },).catch(console.error,);

    return () => {
      unwatch?.();
    };
  }, [isConfigured, storageRevision, syncTodayNoteFromDisk,],);

  const handleTodaySave = useCallback(
    (note: DailyNote | PageNote,) => {
      if (!("date" in note)) return;
      suppressWatcherUntilRef.current = Date.now() + LOCAL_SAVE_WATCH_SUPPRESSION_MS;
      setTodayNote(note,);
      saveDailyNote(note,).catch(console.error,);
    },
    [],
  );

  const handleTodayCityChange = useCallback((city: string | null,) => {
    const note = todayNoteRef.current;
    if (!note || note.city === city) return;
    const updated = { ...note, city, };
    suppressWatcherUntilRef.current = Date.now() + LOCAL_SAVE_WATCH_SUPPRESSION_MS;
    setTodayNote(updated,);
    saveDailyNote(updated,).catch(console.error,);
  }, [],);

  const handleCreateAttachedPage = useCallback(async (date: string,) => {
    const title = window.prompt("Page title",);
    if (!title?.trim()) return;

    const page = await createAttachedPage({ title, attachedTo: date, },);
    setPagesRevision((value,) => value + 1);
    if (date === today) {
      syncTodayAttachedPages();
    }
    openPageView(page.title,);
  }, [openPageView, syncTodayAttachedPages, today,],);

  const runAiPrompt = useCallback(async (promptText: string,) => {
    const todayNoteValue = getCurrentTodayNoteForAi();
    const normalizedPrompt = promptText.trim();
    if (!todayNoteValue || aiRunning || !normalizedPrompt) return;
    const previousActiveChatId = aiActiveChatId;
    const previousLatestChatId = aiLatestChatId;
    const currentChat = aiActiveChatId
      ? aiChatHistory.find((chat,) => chat.id === aiActiveChatId) ?? null
      : null;
    const draftEntry = currentChat
      ? appendChatHistoryTurn(currentChat, {
        prompt: normalizedPrompt,
        selectedText: aiSelectedText ?? null,
        result: {
          answer: "",
          citations: [],
          pendingChanges: [],
        },
      },)
      : buildChatHistoryEntry({
        prompt: normalizedPrompt,
        selectedText: aiSelectedText ?? null,
        scope: aiScope,
        result: {
          answer: "",
          citations: [],
          pendingChanges: [],
        },
      },);
    let latestResult: AssistantResult | null = null;

    const syncDraftEntry = (result: AssistantResult, persist = false,) => {
      const nextEntry = replaceLatestChatHistoryTurnResult(draftEntry, result,);
      upsertAiChatHistoryEntry(nextEntry, persist,);
      return nextEntry;
    };

    aiLastSubmittedPromptRef.current = normalizedPrompt;
    const controller = new AbortController();
    aiAbortControllerRef.current = controller;
    setAiRunning(true,);
    setAiError(null,);
    setAiResult(null,);
    setAiLatestChatId(draftEntry.id,);
    setAiActiveChatId(draftEntry.id,);
    upsertAiChatHistoryEntry(draftEntry, false,);

    try {
      const slashCommandResult = await runAiSlashCommand(normalizedPrompt, todayNoteValue,);
      if (slashCommandResult) {
        latestResult = slashCommandResult;
        const entry = syncDraftEntry(slashCommandResult, true,);
        setAiResult(slashCommandResult,);
        setAiPrompt("",);
        setAiLatestChatId(entry.id,);
        setAiActiveChatId(entry.id,);
        return;
      }

      const recentNotes = aiScope === "recent" ? await loadPastNotes(14,) : [];
      const result = await runAssistant({
        prompt: normalizedPrompt,
        selectedText: aiSelectedText,
        history: (currentChat?.turns ?? []).map((turn,) => ({
          prompt: turn.prompt,
          answer: turn.answer,
          selectedText: turn.selectedText,
          createdAt: turn.createdAt,
        })),
        scope: aiScope,
        context: {
          today: todayNoteValue,
          recentNotes,
        },
      }, {
        signal: controller.signal,
        onUpdate(nextResult,) {
          latestResult = nextResult;
          setAiResult(nextResult,);
          syncDraftEntry(nextResult, false,);
        },
      },);

      latestResult = result;
      const entry = syncDraftEntry(result, true,);
      setAiResult(result,);
      setAiPrompt("",);
      setAiLatestChatId(entry.id,);
      setAiActiveChatId(entry.id,);
    } catch (error) {
      const hasDraftContent = !!latestResult
        && (
          !!latestResult.answer
          || latestResult.citations.length > 0
          || latestResult.pendingChanges.length > 0
        );
      if (!hasDraftContent) {
        if (currentChat) {
          upsertAiChatHistoryEntry(currentChat, false,);
        } else {
          setAiChatHistory((current,) => current.filter((item,) => item.id !== draftEntry.id));
        }
        setAiActiveChatId(previousActiveChatId,);
        setAiLatestChatId(previousLatestChatId,);
      } else if (latestResult) {
        syncDraftEntry(latestResult, true,);
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        setAiError(null,);
      } else if (error instanceof Error && error.message.startsWith(AI_NOT_CONFIGURED,)) {
        setHasAiConfigured(false,);
        setAiError(getAiConfigurationMessage(error.message, AI_NOT_CONFIGURED,),);
      } else {
        setAiError(error instanceof Error ? error.message : "AI command failed.",);
      }
    } finally {
      if (aiAbortControllerRef.current === controller) {
        aiAbortControllerRef.current = null;
      }
      setAiRunning(false,);
    }
  }, [
    aiActiveChatId,
    aiChatHistory,
    aiLatestChatId,
    getCurrentTodayNoteForAi,
    aiRunning,
    aiScope,
    aiSelectedText,
    upsertAiChatHistoryEntry,
  ],);

  const handleAiSubmit = useCallback(async () => {
    if (widgetEditSession) {
      const instruction = aiPrompt.trim();
      if (!instruction) return;
      setWidgetEditSubmitting(true,);
      window.dispatchEvent(
        new CustomEvent(WIDGET_EDIT_SUBMIT_EVENT, {
          detail: { widgetId: widgetEditSession.widgetId, instruction, },
        },),
      );
      return;
    }

    await runAiPrompt(aiPrompt,);
  }, [aiPrompt, closeAiComposer, runAiPrompt, widgetEditSession,],);

  const handleStopAi = useCallback(() => {
    aiAbortControllerRef.current?.abort();
  }, [],);

  const handleApplyAiChange = useCallback(async (date: string,) => {
    const change = aiResult?.pendingChanges.find((item,) => item.date === date);
    if (!change) return;

    setAiApplyingDates((current,) => current.includes(date,) ? current : [...current, date,]);
    setAiError(null,);

    try {
      const appliedDates = await applyAssistantPendingChanges([change,],);
      if (appliedDates.includes(today,)) {
        const reloadedToday = await loadDailyNote(today,);
        if (reloadedToday) {
          setTodayNote(reloadedToday,);
        }
      }

      const nextResult = aiResult
        ? {
          ...aiResult,
          pendingChanges: aiResult.pendingChanges.filter((item,) => item.date !== date),
        }
        : null;
      setAiResult(nextResult,);
      syncLatestAiChatHistory(nextResult,);
      setStorageRevision((value,) => value + 1);
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "Could not apply note changes.",);
    } finally {
      setAiApplyingDates((current,) => current.filter((value,) => value !== date));
    }
  }, [aiResult, syncLatestAiChatHistory, today,],);

  const handleDiscardAiChange = useCallback((date: string,) => {
    if (!aiResult) return;
    const pendingChanges = aiResult.pendingChanges.filter((item,) => item.date !== date);
    const nextResult = !aiResult.answer && aiResult.citations.length === 0 && pendingChanges.length === 0
      ? null
      : { ...aiResult, pendingChanges, };
    setAiResult(nextResult,);
    syncLatestAiChatHistory(nextResult,);
  }, [aiResult, syncLatestAiChatHistory,],);

  const handleSelectAiChat = useCallback((id: string,) => {
    const chat = aiChatHistory.find((item,) => item.id === id);
    if (!chat) return;
    const latestTurn = getLatestChatTurn(chat,);
    setAiActiveChatId(chat.id,);
    setAiPrompt("",);
    setAiResult(
      chat.id === aiLatestChatId && latestTurn
        ? {
          answer: latestTurn.answer,
          citations: latestTurn.citations,
          pendingChanges: latestTurn.pendingChanges,
        }
        : null,
    );
    setAiError(null,);
    setAiSelectedText(null,);
    setAiSelectionHighlight(null,);
    setAiScope(chat.scope,);
    aiLastSubmittedPromptRef.current = latestTurn?.prompt ?? "";
  }, [aiChatHistory, aiLatestChatId,],);

  const handleEditorInteract = useCallback(() => {
    if (!aiComposerOpen) return;
    closeAiComposer();
  }, [aiComposerOpen, closeAiComposer,],);

  useEffect(() => {
    const handleWidgetEditRequest = (event: Event,) => {
      const detail = (event as CustomEvent<WidgetEditRequestDetail>).detail;
      if (!detail?.widgetId) return;

      clearWidgetEditSession();
      setGlobalSearchOpen(false,);
      setAiScope("recent",);
      setAiSelectedText(null,);
      setAiSelectedLabel(`[Edit widget] ${detail.title}`,);
      setAiSelectionHighlight(null,);
      setAiPrompt("",);
      setAiError(null,);
      setWidgetEditSession(detail,);
      setAiComposerOpen(true,);
      refreshAiAvailability();
      window.dispatchEvent(
        new CustomEvent(WIDGET_EDIT_STATE_EVENT, {
          detail: { widgetId: detail.widgetId, isEditing: true, },
        },),
      );
    };

    window.addEventListener(WIDGET_EDIT_REQUEST_EVENT, handleWidgetEditRequest,);
    return () => window.removeEventListener(WIDGET_EDIT_REQUEST_EVENT, handleWidgetEditRequest,);
  }, [clearWidgetEditSession, refreshAiAvailability,],);

  useEffect(() => {
    const handleWidgetBuildState = (event: Event,) => {
      const detail = (event as CustomEvent<WidgetBuildStateDetail>).detail;
      if (!detail?.widgetId) return;
      if (detail.widgetId !== widgetEditSessionRef.current?.widgetId) return;

      setWidgetEditSubmitting(detail.isBuilding,);
      if (detail.isBuilding) {
        return;
      }

      setAiPrompt("",);
      setAiComposerOpen(false,);
      setAiError(null,);
      setAiSelectedText(null,);
      setAiSelectionHighlight(null,);
      clearWidgetEditSession();
    };

    window.addEventListener(WIDGET_BUILD_STATE_EVENT, handleWidgetBuildState,);
    return () => window.removeEventListener(WIDGET_BUILD_STATE_EVENT, handleWidgetBuildState,);
  }, [clearWidgetEditSession,],);

  const todayRef = useRef<HTMLDivElement>(null,);
  const scrollRef = useRef<HTMLDivElement>(null,);

  // "Go to Today" badge when scrolled away
  const [todayDirection, setTodayDirection,] = useState<"above" | "below" | null>(null,);

  useEffect(() => {
    const todayEl = todayRef.current;
    const scrollEl = scrollRef.current;
    if (currentView.kind !== "home") return;
    if (!todayEl || !scrollEl) return;

    const observer = new IntersectionObserver(
      ([entry,],) => {
        if (entry.isIntersecting) {
          setTodayDirection(null,);
        } else {
          // If today's top is above the viewport, today is above → scroll up
          // If today's top is below the viewport, today is below → scroll down
          const rect = todayEl.getBoundingClientRect();
          setTodayDirection(rect.top < 0 ? "above" : "below",);
        }
      },
      { root: scrollEl, threshold: 0, },
    );

    observer.observe(todayEl,);
    return () => observer.disconnect();
  }, [currentView.kind,],);

  function scrollToToday() {
    const todayEl = todayRef.current;
    const scrollEl = scrollRef.current;
    if (!todayEl || !scrollEl) {
      todayEl?.scrollIntoView({ behavior: "smooth", block: "start", },);
      return;
    }

    const scrollBounds = scrollEl.getBoundingClientRect();
    const targetBounds = todayEl.getBoundingClientRect();
    const top = scrollEl.scrollTop + targetBounds.top - scrollBounds.top - NOTE_SCROLL_OFFSET_PX;
    scrollEl.scrollTo({ top: Math.max(0, top,), behavior: "smooth", },);
  }

  const scrollToDate = useCallback((date: string,) => {
    navigateToDate(date,);
  }, [navigateToDate,],);

  useEffect(() => {
    if (currentView.kind !== "home") return;
    if (!pendingScrollDate || globalSearchOpen) return;
    const scrollEl = scrollRef.current;
    const target = pendingScrollDate === today
      ? todayRef.current
      : document.querySelector<HTMLElement>(`[data-note-date="${pendingScrollDate}"]`,);
    if (!target || !scrollEl) return;

    const scrollBounds = scrollEl.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const top = scrollEl.scrollTop + targetBounds.top - scrollBounds.top - NOTE_SCROLL_OFFSET_PX;
    scrollEl.scrollTo({ top: Math.max(0, top,), behavior: "smooth", },);
    setPendingScrollDate(null,);
  }, [currentView.kind, focusedDate, globalSearchOpen, pendingScrollDate, today,],);

  useEffect(() => {
    if (currentView.kind !== "home") return;
    if (restoreHomeScrollTopRef.current === null) return;

    const targetTop = restoreHomeScrollTopRef.current;
    const frameId = window.requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: targetTop, behavior: "auto", });
      restoreHomeScrollTopRef.current = null;
    },);

    return () => window.cancelAnimationFrame(frameId,);
  }, [currentView.kind,],);

  return (
    <div
      ref={scrollRef}
      className="hide-scrollbar h-screen bg-white dark:bg-gray-900 overflow-y-auto overflow-x-hidden relative"
    >
      {/* Titlebar: drag region + pin button */}
      <div
        className="sticky top-0 z-50 h-[38px] w-full flex items-center justify-between shrink-0 px-3"
        onMouseDown={(e,) => {
          if (e.buttons === 1 && !(e.target as HTMLElement).closest("button, input",)) {
            e.detail === 2
              ? getCurrentWindow().toggleMaximize()
              : getCurrentWindow().startDragging();
          }
        }}
      >
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={goHome}
            disabled={currentView.kind === "home"}
            className={`p-1 rounded-md transition-colors ${
              currentView.kind === "home"
                ? "text-gray-300 dark:text-gray-700"
                : "text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800"
            }`}
            title="Home"
          >
            <House className="h-4 w-4" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={goBack}
            disabled={!canGoBack}
            className={`p-1 rounded-md transition-colors ${
              canGoBack
                ? "text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800"
                : "text-gray-300 dark:text-gray-700"
            }`}
            title="Back"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={goForward}
            disabled={!canGoForward}
            className={`p-1 rounded-md transition-colors ${
              canGoForward
                ? "text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800"
                : "text-gray-300 dark:text-gray-700"
            }`}
            title="Forward"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <button
          onClick={async () => {
            const next = !isPinned;
            await getCurrentWindow().setAlwaysOnTop(next,);
            setIsPinned(next,);
          }}
          className={`p-1 rounded-md transition-colors cursor-default ${
            isPinned
              ? "text-gray-900 dark:text-white bg-gray-200/60 dark:bg-gray-700/60"
              : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          }`}
          title={isPinned ? "Unpin window" : "Pin window on top"}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`transition-transform ${isPinned ? "" : "rotate-45"}`}
          >
            <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z" />
          </svg>
        </button>
      </div>

      {globalSearchOpen
        ? (
          <div className="w-full max-w-3xl px-6 pt-6 pb-10">
            <div className="flex items-center justify-between gap-3">
              <h2
                className="text-sm uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400"
                style={{ fontFamily: "'IBM Plex Mono', monospace", }}
              >
                Global Search
              </h2>
              <button
                onClick={closeGlobalSearch}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                style={{ fontFamily: "'IBM Plex Mono', monospace", }}
              >
                esc
              </button>
            </div>

            <input
              ref={searchInputRef}
              value={globalSearchQuery}
              onChange={(event,) => setGlobalSearchQuery(event.target.value,)}
              placeholder="Search all markdown notes..."
              className="mt-3 w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white/90 dark:bg-gray-900/80 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-hidden focus:border-gray-400 dark:focus:border-gray-500"
              style={{ fontFamily: "'IBM Plex Mono', monospace", }}
            />

            <div className="mt-4 space-y-2">
              {globalSearchLoading && (
                <p
                  className="text-xs text-gray-400 dark:text-gray-500"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                >
                  searching...
                </p>
              )}

              {globalSearchError && (
                <p
                  className="text-xs text-red-500"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                >
                  {globalSearchError}
                </p>
              )}

              {!globalSearchLoading && !globalSearchError && globalSearchQuery.trim()
                && globalSearchResults.length === 0 && (
                <p
                  className="text-xs text-gray-400 dark:text-gray-500"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                >
                  no results
                </p>
              )}

              {globalSearchResults.map((result, index,) => (
                <button
                  key={result.path}
                  ref={(element,) => {
                    searchResultRefs.current[index] = element;
                  }}
                  className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                    globalSearchSelectedIndex === index
                      ? "border-gray-400 dark:border-gray-500 bg-gray-50 dark:bg-gray-800/80"
                      : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-600"
                  }`}
                  onMouseEnter={() => {
                    if (searchNavigationModeRef.current !== "mouse") return;
                    setGlobalSearchSelectedIndex(index,);
                  }}
                  onClick={() => {
                    openGlobalSearchResult(result,);
                  }}
                >
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{result.title}</p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {renderSearchSnippet(result.snippet,)}
                  </p>
                  <p
                    className="mt-2 text-[10px] text-gray-400 dark:text-gray-500"
                    style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                  >
                    {result.relativePath}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )
        : (
          <>
            {postUpdateInfo
              ? (
                <UpdateBanner
                  mode="updated"
                  update={postUpdateInfo}
                  onDismiss={() => setPostUpdateInfo(null,)}
                />
              )
              : updateInfo && <UpdateBanner update={updateInfo} onDismiss={() => setUpdateInfo(null,)} />}
            {currentView.kind === "page"
              ? (
                <PageView
                  title={currentView.title}
                  pagesRevision={pagesRevision}
                  onOpenDate={scrollToDate}
                  onInteract={handleEditorInteract}
                />
              )
              : (
                <>
                  <div className="w-full max-w-3xl">
                    {focusedDate && focusedDate !== today && !pastDates.includes(focusedDate,) && (
                      <div key={`${focusedDate}-${storageRevision}-${pagesRevision}`} data-note-date={focusedDate}>
                        <div className="mx-6 border-t border-gray-200 dark:border-gray-700" />
                        <LazyNote
                          date={focusedDate}
                          pagesRevision={pagesRevision}
                          onOpenDate={scrollToDate}
                          onOpenPage={openPageView}
                          onCreatePage={handleCreateAttachedPage}
                          onInteract={handleEditorInteract}
                          onChatSelection={openAiComposer}
                          onSelectionChange={handleAiSelectionChange}
                          onSelectionBlur={handleAiSelectionBlur}
                          persistentSelectionRange={aiSelectionHighlight?.noteDate === focusedDate
                            ? { from: aiSelectionHighlight.from, to: aiSelectionHighlight.to, }
                            : null}
                        />
                      </div>
                    )}

                    <div
                      ref={todayRef}
                      data-note-date={today}
                      className="min-h-[400px]"
                      onClick={() => todayEditorRef.current?.focus()}
                    >
                      <div className="px-6 pt-6 pb-4">
                        <DateHeader
                          date={today}
                          city={todayNote?.city}
                          fallbackCity={currentCity}
                          onCityChange={todayNote ? handleTodayCityChange : undefined}
                        />
                        <AttachedPagesRow
                          pages={todayAttachedPages}
                          onOpenPage={openPageView}
                          onCreatePage={() => handleCreateAttachedPage(today,)}
                        />
                      </div>
                      {todayNote && (
                        <EditableNote
                          ref={todayEditorRef}
                          note={todayNote}
                          onOpenDate={scrollToDate}
                          onSave={handleTodaySave}
                          onInteract={handleEditorInteract}
                          onChatSelection={openAiComposer}
                          onSelectionChange={handleAiSelectionChange}
                          onSelectionBlur={handleAiSelectionBlur}
                          persistentSelectionRange={aiSelectionHighlight?.noteDate === todayNote.date
                            ? { from: aiSelectionHighlight.from, to: aiSelectionHighlight.to, }
                            : null}
                        />
                      )}
                    </div>

                    {pastDates.map((date,) => (
                      <div key={`${date}-${storageRevision}-${pagesRevision}`} data-note-date={date}>
                        <div className="mx-6 border-t border-gray-200 dark:border-gray-700" />
                        <LazyNote
                          date={date}
                          pagesRevision={pagesRevision}
                          onOpenDate={scrollToDate}
                          onOpenPage={openPageView}
                          onCreatePage={handleCreateAttachedPage}
                          onInteract={handleEditorInteract}
                          onChatSelection={openAiComposer}
                          onSelectionChange={handleAiSelectionChange}
                          onSelectionBlur={handleAiSelectionBlur}
                          persistentSelectionRange={aiSelectionHighlight?.noteDate === date
                            ? { from: aiSelectionHighlight.from, to: aiSelectionHighlight.to, }
                            : null}
                        />
                      </div>
                    ))}
                  </div>

                  {todayDirection && (
                    <button
                      onClick={scrollToToday}
                      className="fixed left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-medium uppercase tracking-wide text-white font-sans shadow-lg transition-all hover:scale-105 active:scale-95 cursor-pointer"
                      style={{
                        background: "linear-gradient(to bottom, #4b5563, #1f2937)",
                        ...(todayDirection === "above" ? { top: 16, } : { bottom: 16, }),
                      }}
                    >
                      {todayDirection === "above" ? "↑" : "↓"} today
                    </button>
                  )}
                </>
              )}
          </>
        )}

      <AiComposer
        open={aiComposerOpen}
        prompt={aiPrompt}
        selectedText={aiSelectedText}
        selectedLabel={aiSelectedLabel}
        title={aiPanelTitle}
        activeChatId={aiActiveChatId}
        chatHistory={aiChatHistory}
        applyingDates={aiApplyingDates}
        canApplyPendingChanges={canApplyPendingChanges}
        hasAiConfigured={hasAiConfigured}
        isSubmitting={widgetEditSession ? widgetEditSubmitting : aiRunning}
        canStopSubmitting={!widgetEditSession}
        submittingLabel={widgetEditSession ? "Building new widget version..." : undefined}
        error={aiError}
        onPromptChange={setAiPrompt}
        onClose={closeAiComposer}
        onNewChat={handleStartNewAiChat}
        onSubmit={handleAiSubmit}
        onStop={handleStopAi}
        onOpenDate={scrollToDate}
        onSelectChat={handleSelectAiChat}
        onApplyChange={handleApplyAiChange}
        onDiscardChange={handleDiscardAiChange}
        onOpenSettings={() => {
          setSettingsOpen(true,);
          refreshAiAvailability();
        }}
      />

      {/* Library drawer — triggered by macOS menu bar Cmd+P */}
      <LibraryDrawer
        open={libraryOpen}
        onClose={() => setLibraryOpen(false,)}
        onInsert={async (item: LibraryItem,) => {
          const editor = todayEditorRef.current?.editor;
          if (!editor) return;
          try {
            const source = item.source?.trim() ?? "";
            if (!source) {
              throw new Error("This saved widget still uses the retired JSON runtime. Rebuild it first.",);
            }
            const isShared = !!item.componentId && !!item.storageKind;
            const record = item.file && item.path && item.storageId
              ? {
                id: item.storageId,
                runtime: "code" as const,
                spec: "",
                source,
                file: item.file,
                path: item.path,
                libraryItemId: item.id,
                componentId: isShared ? item.componentId : null,
                storageSchema: item.storageSchema ?? null,
              }
              : await (async () => {
                const nextRecord = await createWidgetFile({
                  title: item.title,
                  prompt: item.prompt,
                  runtime: "code",
                  spec: "",
                  source,
                  favorite: item.favorite,
                  saved: true,
                  libraryItemId: item.id,
                  componentId: isShared ? item.componentId : null,
                  storageSchema: item.storageSchema,
                },);
                await recordWidgetGitRevision(nextRecord, "insert", null,);
                return nextRecord;
              })();
            editor.chain().focus().insertContent({
              type: "widget",
              attrs: {
                id: crypto.randomUUID(),
                storageId: record.id,
                runtime: record.runtime,
                spec: record.spec,
                source: record.source,
                file: record.file,
                path: record.path,
                libraryItemId: item.id,
                componentId: isShared ? item.componentId : null,
                storageSchema: stringifyStorageSchema(record.storageSchema,),
                prompt: item.prompt,
                saved: true,
                loading: false,
                error: "",
              },
            },).run();
            setLibraryOpen(false,);
          } catch (err) {
            console.error("Failed to insert widget from library:", err,);
          }
        }}
      />

      {/* Settings modal — triggered by macOS menu bar Cmd+, */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false,);
          refreshAiAvailability();
        }}
      />
      <OnboardingModal
        open={onboardingOpen}
        onComplete={() => {
          setOnboardingOpen(false,);
          setIsConfigured(true,);
          setStorageRevision((value,) => value + 1);
        }}
      />
    </div>
  );
}
