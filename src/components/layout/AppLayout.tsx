import { invoke, } from "@tauri-apps/api/core";
import { listen, } from "@tauri-apps/api/event";
import { getCurrentWindow, } from "@tauri-apps/api/window";
import { watch, } from "@tauri-apps/plugin-fs";
import { openPath, } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState, } from "react";
import { useCurrentDate, } from "../../hooks/useCurrentDate";
import { useTimezoneCity, } from "../../hooks/useTimezoneCity";
import type { LibraryItem, } from "../../services/library";
import { getJournalDir, initJournalScope, } from "../../services/paths";
import { getVaultDirSetting, loadSettings, } from "../../services/settings";
import { getOrCreateDailyNote, loadDailyNote, saveDailyNote, } from "../../services/storage";
import { rolloverTasks, } from "../../services/tasks";
import { checkForUpdate, type UpdateInfo, } from "../../services/updater";
import { DailyNote, formatDate, getDaysAgo, isToday, } from "../../types/note";
import EditableNote, { type EditableNoteHandle, } from "../journal/EditableNote";
import { LibraryDrawer, } from "../library/LibraryDrawer";
import { OnboardingModal, } from "../onboarding/OnboardingModal";
import { SettingsModal, } from "../settings/SettingsModal";
import { UpdateBanner, } from "../UpdateBanner";

function applyCity(savedCity: string | null | undefined, newCity: string,): string {
  if (!savedCity || savedCity === newCity) return newCity;
  const from = savedCity.includes(" → ",) ? savedCity.split(" → ",)[0] : savedCity;
  return `${from} → ${newCity}`;
}

function noteChanged(current: DailyNote | null, incoming: DailyNote,): boolean {
  if (!current) return true;
  return current.content !== incoming.content || current.city !== incoming.city;
}

interface GlobalSearchResult {
  path: string;
  relativePath: string;
  title: string;
  snippet: string;
}

function DateHeader({ date, city, }: { date: string; city?: string | null; },) {
  const showToday = isToday(date,);

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
          className="text-xs font-medium uppercase tracking-wide px-3 py-px rounded-full text-white font-sans"
          style={{ background: "linear-gradient(to bottom, #4b5563, #1f2937)", }}
        >
          today
        </span>
      )}
      {city && (
        <span className="text-sm text-gray-400 dark:text-gray-500 font-sans">
          {city}
        </span>
      )}
    </div>
  );
}

function LazyNote({ date, }: { date: string; },) {
  const [note, setNote,] = useState<DailyNote | null>(null,);
  const containerRef = useRef<HTMLDivElement>(null,);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry,],) => {
        if (entry.isIntersecting) {
          loadDailyNote(date,).then(setNote,).catch(console.error,);
        }
      },
      { rootMargin: "400px", },
    );

    observer.observe(el,);
    return () => observer.disconnect();
  }, [date,],);

  return (
    <div ref={containerRef} className="min-h-[400px]">
      {note && (
        <>
          <div className="px-6 pt-12 pb-4">
            <DateHeader date={note.date} city={note.city} />
          </div>
          <EditableNote note={note} />
        </>
      )}
    </div>
  );
}

export default function AppLayout() {
  const today = useCurrentDate();
  const currentCity = useTimezoneCity();
  const [todayNote, setTodayNote,] = useState<DailyNote | null>(null,);
  const pastDates = useMemo(() => Array.from({ length: 30, }, (_, i,) => getDaysAgo(i + 1,),), [today,],);
  const [settingsOpen, setSettingsOpen,] = useState(false,);
  const [libraryOpen, setLibraryOpen,] = useState(false,);
  const [onboardingOpen, setOnboardingOpen,] = useState(false,);
  const [isConfigured, setIsConfigured,] = useState(false,);
  const [storageRevision, setStorageRevision,] = useState(0,);
  const [updateInfo, setUpdateInfo,] = useState<UpdateInfo | null>(null,);
  const [isPinned, setIsPinned,] = useState(false,);
  const [isWindowFocused, setIsWindowFocused,] = useState(() => document.hasFocus());
  const [globalSearchOpen, setGlobalSearchOpen,] = useState(false,);
  const [globalSearchQuery, setGlobalSearchQuery,] = useState("",);
  const [globalSearchResults, setGlobalSearchResults,] = useState<GlobalSearchResult[]>([],);
  const [globalSearchLoading, setGlobalSearchLoading,] = useState(false,);
  const [globalSearchError, setGlobalSearchError,] = useState<string | null>(null,);
  const cityRef = useRef(currentCity,);
  const prevCityRef = useRef(currentCity,);
  const todayNoteRef = useRef<DailyNote | null>(null,);
  const searchInputRef = useRef<HTMLInputElement>(null,);
  useEffect(() => {
    todayNoteRef.current = todayNote;
  }, [todayNote,],);

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

  const openGlobalSearch = useCallback(() => {
    setGlobalSearchOpen(true,);
  }, [],);

  const closeGlobalSearch = useCallback(() => {
    setGlobalSearchOpen(false,);
    setGlobalSearchQuery("",);
    setGlobalSearchResults([],);
    setGlobalSearchLoading(false,);
    setGlobalSearchError(null,);
  }, [],);

  // Load configuration and extend FS scope on mount
  useEffect(() => {
    loadSettings()
      .then(async (settings,) => {
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

  // Check for app updates on mount
  useEffect(() => {
    checkForUpdate().then((info,) => {
      if (info) setUpdateInfo(info,);
    },);
  }, [],);

  // Listen for macOS menu bar events
  useEffect(() => {
    const unlistenSettings = listen("open-settings", () => setSettingsOpen(true,),);
    const unlistenLibrary = listen("toggle-library", () => setLibraryOpen((prev,) => !prev),);
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
  }, [openGlobalSearch,],);

  useEffect(() => {
    const handleHotkey = (event: KeyboardEvent,) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openGlobalSearch();
        return;
      }
      if (event.key === "Escape" && globalSearchOpen) {
        event.preventDefault();
        closeGlobalSearch();
      }
    };
    window.addEventListener("keydown", handleHotkey,);
    return () => window.removeEventListener("keydown", handleHotkey,);
  }, [closeGlobalSearch, globalSearchOpen, openGlobalSearch,],);

  useEffect(() => {
    if (!globalSearchOpen) return;
    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 0,);
    return () => window.clearTimeout(timer,);
  }, [globalSearchOpen,],);

  useEffect(() => {
    if (!globalSearchOpen) return;
    const query = globalSearchQuery.trim();
    if (!query) {
      setGlobalSearchResults([],);
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
          const vaultDir = (await getVaultDirSetting()).trim();
          const rootDir = vaultDir || await getJournalDir();
          const results = await invoke<GlobalSearchResult[]>("search_markdown_files", {
            rootDir,
            query,
            limit: 120,
          },);
          if (!cancelled) {
            setGlobalSearchResults(results,);
          }
        } catch (error) {
          if (!cancelled) {
            const message = error instanceof Error ? error.message : "Search failed.";
            setGlobalSearchError(message,);
            setGlobalSearchResults([],);
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
    const handleFocus = () => syncTodayNoteFromDisk();
    window.addEventListener("focus", handleFocus,);
    return () => window.removeEventListener("focus", handleFocus,);
  }, [isConfigured, syncTodayNoteFromDisk,],);

  // Roll over unchecked tasks from past days, then load today's note
  useEffect(() => {
    if (!isConfigured) return;
    async function load() {
      await rolloverTasks(30,);

      const note = await getOrCreateDailyNote(today,);

      // Apply current city: if the note's saved city differs, record the transition
      const effectiveCity = currentCity ? applyCity(note.city, currentCity,) : note.city;
      const todayWithCity = { ...note, city: effectiveCity, };
      cityRef.current = effectiveCity ?? currentCity ?? "";
      setTodayNote(todayWithCity,);
      if (effectiveCity !== note.city) {
        saveDailyNote(todayWithCity,).catch(console.error,);
      }
    }
    load();
  }, [isConfigured, storageRevision, today,],);

  // Detect same-day timezone change (travel): update today's note with transition city.
  // Guard (note.date === today) prevents this from running when both today and currentCity
  // change simultaneously (cross-date-line travel) — the [today] load effect handles that.
  useEffect(() => {
    if (!isConfigured) return;
    const prevCity = prevCityRef.current;
    prevCityRef.current = currentCity;
    if (prevCity === currentCity) return;

    const note = todayNoteRef.current;
    if (!note || note.date !== today) return;

    const transition = applyCity(note.city ?? prevCity, currentCity,);
    cityRef.current = transition;
    const updated = { ...note, city: transition, };
    setTodayNote(updated,);
    saveDailyNote(updated,).catch(console.error,);
  }, [currentCity, isConfigured, today,],);

  // Watch the journal directory for external changes
  useEffect(() => {
    if (!isConfigured) return;
    let unwatch: (() => void) | null = null;

    getJournalDir().then(async (dir,) => {
      unwatch = await watch(
        dir,
        (event,) => {
          if (!event.paths.some((path,) => path.endsWith(".md",))) return;
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
    (note: DailyNote,) => {
      saveDailyNote(note,).catch(console.error,);
      setTodayNote(note,);
    },
    [],
  );

  const todayEditorRef = useRef<EditableNoteHandle>(null,);
  const todayRef = useRef<HTMLDivElement>(null,);
  const scrollRef = useRef<HTMLDivElement>(null,);

  // "Go to Today" badge when scrolled away
  const [todayDirection, setTodayDirection,] = useState<"above" | "below" | null>(null,);

  useEffect(() => {
    const todayEl = todayRef.current;
    const scrollEl = scrollRef.current;
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
  }, [],);

  function scrollToToday() {
    todayRef.current?.scrollIntoView({ behavior: "smooth", block: "start", },);
  }

  return (
    <div
      ref={scrollRef}
      className="h-screen bg-white dark:bg-gray-900 overflow-y-scroll overflow-x-hidden relative"
    >
      {/* Titlebar: drag region + pin button */}
      <div
        className="sticky top-0 z-50 h-[38px] w-full flex items-center justify-end shrink-0"
        onMouseDown={(e,) => {
          if (e.buttons === 1 && !(e.target as HTMLElement).closest("button, input",)) {
            e.detail === 2
              ? getCurrentWindow().toggleMaximize()
              : getCurrentWindow().startDragging();
          }
        }}
      >
        <button
          onClick={async () => {
            const next = !isPinned;
            await getCurrentWindow().setAlwaysOnTop(next,);
            setIsPinned(next,);
          }}
          className={`mr-3 p-1 rounded-md transition-colors cursor-default ${
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

              {globalSearchResults.map((result,) => (
                <button
                  key={result.path}
                  className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                  onClick={() => {
                    openPath(result.path,).catch(console.error,);
                  }}
                >
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{result.title}</p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{result.snippet}</p>
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
            {updateInfo && <UpdateBanner update={updateInfo} onDismiss={() => setUpdateInfo(null,)} />}
            <div className="w-full max-w-3xl">
              <div
                ref={todayRef}
                className="min-h-[400px]"
                onClick={() => todayEditorRef.current?.focus()}
              >
                <div className="px-6 pt-6 pb-4">
                  <DateHeader date={today} city={currentCity} />
                </div>
                {todayNote && (
                  <EditableNote
                    ref={todayEditorRef}
                    note={todayNote}
                    onSave={handleTodaySave}
                  />
                )}
              </div>

              {pastDates.map((date,) => (
                <div key={date}>
                  <div className="mx-6 border-t border-gray-200 dark:border-gray-700" />
                  <LazyNote date={date} />
                </div>
              ))}
            </div>

            {todayDirection && (
              <button
                onClick={scrollToToday}
                className="fixed left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium uppercase tracking-wide text-white font-sans shadow-lg transition-all hover:scale-105 active:scale-95 cursor-pointer"
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

      {/* Library drawer — triggered by macOS menu bar Cmd+J */}
      <LibraryDrawer
        open={libraryOpen}
        onClose={() => setLibraryOpen(false,)}
        onInsert={(item: LibraryItem,) => {
          const editor = todayEditorRef.current?.editor;
          if (!editor) return;
          editor.chain().focus().insertContent({
            type: "widget",
            attrs: {
              id: crypto.randomUUID(),
              spec: item.html,
              prompt: item.prompt,
              saved: true,
              loading: false,
              error: "",
            },
          },).run();
          setLibraryOpen(false,);
        }}
      />

      {/* Settings modal — triggered by macOS menu bar Cmd+, */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false,)} />
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
