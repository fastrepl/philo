import { invoke, } from "@tauri-apps/api/core";
import { listen, type UnlistenFn, } from "@tauri-apps/api/event";
import { dirname, } from "@tauri-apps/api/path";
import { getCurrentWindow, } from "@tauri-apps/api/window";
import { exists, watch, } from "@tauri-apps/plugin-fs";
import { openPath, openUrl, } from "@tauri-apps/plugin-opener";
import type { Editor as TiptapEditor, } from "@tiptap/core";
import type { JSONContent, } from "@tiptap/react";
import { ArrowLeft, ArrowRight, ArrowUpDown, House, LoaderCircle, MapPin, X, } from "lucide-react";
import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCurrentDate, } from "../../hooks/useCurrentDate";
import { useMountEffect, } from "../../hooks/useMountEffect";
import { type MenuItemDef, showNativeContextMenu, } from "../../hooks/useNativeContextMenu";
import { useCurrentCity, } from "../../hooks/useTimezoneCity";
import { EMPTY_DOC, parseJsonContent, } from "../../lib/markdown";
import { getAiConfigurationMessage, } from "../../services/ai";
import { runAiSlashCommand, } from "../../services/ai-slash-commands";
import { trackEvent, } from "../../services/analytics";
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
import {
  getListenerState,
  type ListenerSessionDataEvent,
  type ListenerSessionErrorEvent,
  type ListenerSessionLifecycleEvent,
  type ListenerStreamResponse,
  listenToListenerSessionData,
  listenToListenerSessionError,
  listenToListenerSessionLifecycle,
  listenToListenerSessionProgress,
  startListenerSession,
  stopListenerSession,
} from "../../services/listener";
import { summarizeMeeting, } from "../../services/meeting-summary";
import {
  buildPageLinkTarget,
  getJournalDir,
  getNotePath,
  getPageDisplayTitle,
  getPagePath,
  getPagesDir,
  initJournalScope,
  parseDateFromNoteLinkTarget,
  parsePageTitleFromLinkTarget,
  parsePageTitleFromPath,
  sanitizePageTitle,
} from "../../services/paths";
import { ensureMicrophonePermission, } from "../../services/permissions";
import {
  getFilenamePattern,
  hasActiveAiProvider,
  loadSettings,
  resolveActiveSttConfig,
} from "../../services/settings";
import {
  createAttachedPage,
  createUntitledAttachedPage,
  deletePage,
  getOrCreateDailyNote,
  loadDailyNote,
  loadPage,
  loadPastNotes,
  renamePage,
  saveDailyNote,
  savePage,
} from "../../services/storage";
import { consumeDesktopSyncAuthCallback, scheduleDesktopSync, SYNC_DEEP_LINK_EVENT, } from "../../services/sync";
import { rolloverTasks, sortTasksInNoteContent, } from "../../services/tasks";
import {
  checkForUpdate,
  consumePendingPostUpdate,
  type PostUpdateInfo,
  type UpdateInfo,
} from "../../services/updater";
import { isUrlSummaryPage, } from "../../services/url-summary";
import { createWidgetFile, } from "../../services/widget-files";
import { recordWidgetGitRevision, } from "../../services/widget-git-history";
import { stringifyStorageSchema, } from "../../services/widget-storage";
import {
  DailyNote,
  formatDate,
  getDaysAgo,
  getToday,
  type GitHubCommitLinkData,
  type GitHubIssueLinkData,
  type GitHubPrLinkData,
  isToday,
  type MeetingSessionKind,
  type PageNote,
} from "../../types/note";
import { AiComposer, } from "../ai/AiComposer";
import { stripMeetingPageDoc, } from "../editor/extensions/meeting/MeetingPageExtensions";
import { clearWidgetEditSession as clearWidgetEditSessionStore, } from "../editor/extensions/widget/edit-session";
import EditableNote, { type EditableNoteHandle, type EditableNoteSelection, } from "../journal/EditableNote";
import { LibraryDrawer, } from "../library/LibraryDrawer";
import { OnboardingModal, } from "../onboarding/OnboardingModal";
import { SettingsModal, } from "../settings/SettingsModal";
import { UpdateBanner, } from "../UpdateBanner";
import { useWidgetEditComposer, } from "./useWidgetEditComposer";

const LOCAL_SAVE_WATCH_SUPPRESSION_MS = 1000;
const NOTE_SCROLL_OFFSET_PX = 56;

async function showPathInFinder(path: string,) {
  await invoke("show_path_in_folder", { path, },);
}

function showFinderContextMenu(
  event: ReactMouseEvent<HTMLElement>,
  id: string,
  pathPromise: Promise<string>,
  deleteAction?: Extract<MenuItemDef, { id: string; }>,
) {
  const items: MenuItemDef[] = [
    {
      id,
      text: "Show in Finder",
      action: () => {
        void pathPromise
          .then((path,) => showPathInFinder(path,))
          .catch(console.error,);
      },
    },
  ];

  if (deleteAction) {
    items.push(
      { separator: true, },
      deleteAction,
    );
  }

  void showNativeContextMenu(items, event,);
}

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
type SettingsTab = "ai" | "dictation";

interface MeetingTranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  channel: number;
  speaker: number | null;
}

interface MeetingTranscriptState {
  finalWordsByChannel: Record<number, MeetingTranscriptWord[]>;
  partialWordsByChannel: Record<number, MeetingTranscriptWord[]>;
  finalWordsMaxEndMsByChannel: Record<number, number>;
  fallbackFinalText: string;
  fallbackPartialText: string;
}

interface ActiveMeetingSession {
  sessionId: string;
  pageTitle: string;
  startedAt: string;
  baseDoc: JSONContent;
  existingTranscript: string;
  transcriptState: MeetingTranscriptState;
  failureReason: string | null;
}

interface LiveMeetingTranscript {
  pageTitle: string;
  captionText: string;
  fullText: string;
}

interface MeetingTranscriptBlock {
  speakerKey: string;
  startMs: number;
  text: string;
}

function getNodeText(node: JSONContent | undefined,): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content,)) return "";
  return node.content.map((child,) => getNodeText(child,)).join("",);
}

function createParagraph(text = "",): JSONContent {
  return text
    ? { type: "paragraph", content: [{ type: "text", text, },], }
    : { type: "paragraph", };
}

function createStrongParagraph(text: string,): JSONContent {
  return {
    type: "paragraph",
    content: [{ type: "text", text, marks: [{ type: "bold", },], },],
  };
}

function createPageLinkParagraph(title: string,): JSONContent {
  return {
    type: "paragraph",
    content: [
      {
        type: "mentionChip",
        attrs: {
          id: buildPageLinkTarget(title,),
          kind: "page",
          label: title,
        },
      },
    ],
  };
}

function createHeading(level: number, text: string,): JSONContent {
  return {
    type: "heading",
    attrs: { level, },
    content: [{ type: "text", text, },],
  };
}

function createListItem(text: string,): JSONContent {
  return {
    type: "listItem",
    content: [createParagraph(text,),],
  };
}

function createBulletList(items: string[],): JSONContent | null {
  const cleaned = items.map((item,) => item.trim()).filter(Boolean,);
  if (cleaned.length === 0) return null;
  return {
    type: "bulletList",
    content: cleaned.map((item,) => createListItem(item,)),
  };
}

function createParagraphsFromText(text: string,): JSONContent[] {
  return text
    .split(/\n+/,)
    .map((line,) => line.trim())
    .filter(Boolean,)
    .map((line,) => createParagraph(line,));
}

function formatTranscriptTimestamp(milliseconds: number,) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000,),);
  const hours = Math.floor(totalSeconds / 3600,);
  const minutes = Math.floor((totalSeconds % 3600) / 60,);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [
      String(hours,).padStart(2, "0",),
      String(minutes,).padStart(2, "0",),
      String(seconds,).padStart(2, "0",),
    ].join(":",);
  }

  return [
    String(minutes,).padStart(2, "0",),
    String(seconds,).padStart(2, "0",),
  ].join(":",);
}

function getTranscriptSpeakerKey(word: MeetingTranscriptWord,) {
  return word.speaker !== null ? `speaker:${word.speaker}` : `channel:${word.channel}`;
}

function createTranscriptContent(
  transcript: string | undefined,
  transcriptBlocks?: MeetingTranscriptBlock[],
  transcriptPrefix?: string,
) {
  if (!transcriptBlocks?.length) {
    const transcriptText = transcript?.trim() ?? "";
    return transcriptText ? createParagraphsFromText(transcriptText,) : [];
  }

  const content: JSONContent[] = [];
  const prefixText = transcriptPrefix?.trim() ?? "";
  if (prefixText) {
    content.push(...createParagraphsFromText(prefixText,),);
  }

  const speakerOrder = new Map<string, number>();
  for (const block of transcriptBlocks) {
    const speakerIndex = speakerOrder.get(block.speakerKey,) ?? speakerOrder.size + 1;
    speakerOrder.set(block.speakerKey, speakerIndex,);
    content.push(
      createStrongParagraph(`Speaker ${speakerIndex} - ${formatTranscriptTimestamp(block.startMs,)}`,),
      createParagraph(block.text,),
    );
  }

  return content;
}

function getContentAfterHeading(doc: JSONContent, label: string,) {
  const content = normalizeDocContent(doc,);
  const section: JSONContent[] = [];
  let capturing = false;

  for (const node of content) {
    if (node.type === "heading") {
      const text = getNodeText(node,).trim();
      if (text === label) {
        capturing = true;
        continue;
      }
      if (capturing) {
        break;
      }
    }

    if (capturing) {
      section.push(node,);
    }
  }

  return trimTrailingEmptyParagraphs(section,);
}

function normalizeDocContent(doc: JSONContent,): JSONContent[] {
  const content = Array.isArray(doc.content,) ? [...doc.content,] : [];
  if (content.length !== 1 || content[0]?.type !== "paragraph" || getNodeText(content[0],).trim()) {
    return content;
  }
  return [];
}

function appendAttachedPageLink(doc: JSONContent, title: string,): JSONContent {
  return {
    type: "doc",
    content: [createPageLinkParagraph(title,), ...normalizeDocContent(doc,),],
  };
}

function appendDoc(baseDoc: JSONContent, appendedDoc: JSONContent,): JSONContent {
  const baseContent = normalizeDocContent(baseDoc,);
  const appendedContent = normalizeDocContent(appendedDoc,);
  if (appendedContent.length === 0) {
    return baseContent.length > 0 ? { type: "doc", content: baseContent, } : EMPTY_DOC;
  }

  return {
    type: "doc",
    content: [
      ...baseContent,
      ...(baseContent.length > 0 ? [createParagraph(),] : []),
      ...appendedContent,
    ],
  };
}

function buildMeetingCaptureDoc({
  sessionKind,
  summary,
  decisions,
  keyTakeaways,
  actionItems,
  transcript,
  transcriptBlocks,
  transcriptPrefix,
  transcriptContent,
}: {
  sessionKind?: MeetingSessionKind | null;
  summary?: string[];
  decisions?: string[];
  keyTakeaways?: string[];
  actionItems?: string[];
  transcript?: string;
  transcriptBlocks?: MeetingTranscriptBlock[];
  transcriptPrefix?: string;
  transcriptContent?: JSONContent[];
},): JSONContent {
  const content: JSONContent[] = [];
  const summaryList = createBulletList(summary ?? [],);
  const nextTranscriptContent = transcriptContent?.length
    ? transcriptContent
    : createTranscriptContent(transcript, transcriptBlocks, transcriptPrefix,);

  if (summaryList) {
    content.push(createHeading(2, "Summary",), summaryList,);
  }

  if (sessionKind === "decision_making") {
    content.push(createHeading(2, "Decisions",),);
    content.push(
      createBulletList(
        decisions?.length ? decisions : ["No explicit decisions were captured.",],
      )!,
    );
    content.push(createHeading(2, "Action Items",),);
    content.push(
      createBulletList(
        actionItems?.length ? actionItems : ["No action items were captured.",],
      )!,
    );
  } else if (sessionKind === "informative") {
    content.push(createHeading(2, "Key Takeaways",),);
    content.push(
      createBulletList(
        keyTakeaways?.length
          ? keyTakeaways
          : summary?.length
          ? summary
          : ["No key takeaways were captured.",],
      )!,
    );
  }

  if (nextTranscriptContent.length > 0) {
    content.push(createHeading(2, "Transcript",), ...nextTranscriptContent,);
  }

  return content.length > 0 ? { type: "doc", content, } : EMPTY_DOC;
}

function formatAdHocMeetingTitle(date: Date,) {
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  },);
  return `Ad-hoc meeting ${time}`;
}

function mergeTranscriptText(current: string, next: string,) {
  const currentText = current.trim();
  const nextText = next.trim();
  if (!nextText) return currentText;
  if (!currentText) return nextText;
  if (currentText.endsWith(nextText,)) return currentText;

  const maxOverlap = Math.min(currentText.length, nextText.length,);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (currentText.endsWith(nextText.slice(0, overlap,),)) {
      return `${currentText}${nextText.slice(overlap,)}`.trim();
    }
  }

  return `${currentText}\n\n${nextText}`.trim();
}

function createMeetingTranscriptState(): MeetingTranscriptState {
  return {
    finalWordsByChannel: {},
    partialWordsByChannel: {},
    finalWordsMaxEndMsByChannel: {},
    fallbackFinalText: "",
    fallbackPartialText: "",
  };
}

function fixSpacingForTranscriptWords(words: string[], transcript: string,): string[] {
  const result: string[] = [];
  let position = 0;

  for (const [index, word,] of words.entries()) {
    const trimmed = word.trim();
    if (!trimmed) {
      result.push(word,);
      continue;
    }

    const foundAt = transcript.indexOf(trimmed, position,);
    if (foundAt === -1) {
      result.push(word,);
      continue;
    }

    const prefix = index === 0 ? " " : transcript.slice(position, foundAt,);
    result.push(`${prefix}${trimmed}`,);
    position = foundAt + trimmed.length;
  }

  return result;
}

function toMeetingTranscriptWords(response: ListenerStreamResponse,): MeetingTranscriptWord[] {
  if (response.type !== "Results") return [];

  const channel = response.channel_index[0];
  const alternative = response.channel.alternatives[0];
  if (channel === undefined || !alternative?.words?.length) {
    return [];
  }

  const textsWithSpacing = fixSpacingForTranscriptWords(
    alternative.words.map((word,) => word.punctuated_word ?? word.word),
    alternative.transcript,
  );

  return alternative.words.map((word, index,) => ({
    text: textsWithSpacing[index] ?? ` ${word.punctuated_word ?? word.word}`,
    startMs: Math.round(word.start * 1000,),
    endMs: Math.round(word.end * 1000,),
    channel,
    speaker: word.speaker,
  }));
}

function applyTranscriptResponse(state: MeetingTranscriptState, response: ListenerStreamResponse,) {
  if (response.type !== "Results") return;

  const transcript = response.channel.alternatives[0]?.transcript?.trim() ?? "";
  const words = toMeetingTranscriptWords(response,);
  const channel = response.channel_index[0] ?? 0;

  if (words.length === 0) {
    if (response.is_final) {
      state.fallbackFinalText = mergeTranscriptText(state.fallbackFinalText, transcript,);
      state.fallbackPartialText = "";
    } else {
      state.fallbackPartialText = transcript;
    }
    return;
  }

  if (response.is_final) {
    const lastPersistedEndMs = state.finalWordsMaxEndMsByChannel[channel] ?? 0;
    const firstNewWordIndex = words.findIndex((word,) => word.endMs > lastPersistedEndMs);
    if (firstNewWordIndex === -1) {
      return;
    }

    const newWords = words.slice(firstNewWordIndex,);
    const lastEndMs = newWords[newWords.length - 1]?.endMs ?? lastPersistedEndMs;
    const existingPartial = state.partialWordsByChannel[channel] ?? [];

    state.finalWordsByChannel[channel] = [
      ...(state.finalWordsByChannel[channel] ?? []),
      ...newWords,
    ];
    state.partialWordsByChannel[channel] = existingPartial.filter((word,) => word.startMs > lastEndMs);
    state.finalWordsMaxEndMsByChannel[channel] = lastEndMs;
    return;
  }

  const existingPartial = state.partialWordsByChannel[channel] ?? [];
  const firstStartMs = words[0]?.startMs ?? 0;
  const lastEndMs = words[words.length - 1]?.endMs ?? 0;

  state.partialWordsByChannel[channel] = [
    ...existingPartial.filter((word,) => word.endMs <= firstStartMs),
    ...words,
    ...existingPartial.filter((word,) => word.startMs >= lastEndMs),
  ];
}

function finalizeTranscriptState(state: MeetingTranscriptState,) {
  state.fallbackFinalText = mergeTranscriptText(state.fallbackFinalText, state.fallbackPartialText,);
  state.fallbackPartialText = "";

  for (const channel of Object.keys(state.partialWordsByChannel,).map(Number,)) {
    const partialWords = state.partialWordsByChannel[channel] ?? [];
    if (partialWords.length === 0) continue;

    const lastPersistedEndMs = state.finalWordsMaxEndMsByChannel[channel] ?? 0;
    const firstNewWordIndex = partialWords.findIndex((word,) => word.endMs > lastPersistedEndMs);
    if (firstNewWordIndex !== -1) {
      const newWords = partialWords.slice(firstNewWordIndex,);
      state.finalWordsByChannel[channel] = [
        ...(state.finalWordsByChannel[channel] ?? []),
        ...newWords,
      ];
      state.finalWordsMaxEndMsByChannel[channel] = newWords[newWords.length - 1]?.endMs ?? lastPersistedEndMs;
    }

    state.partialWordsByChannel[channel] = [];
  }
}

function buildFinalTranscriptBlocks(state: MeetingTranscriptState,) {
  const words = Object.values(state.finalWordsByChannel,).flat().sort((left, right,) => {
    if (left.startMs !== right.startMs) return left.startMs - right.startMs;
    if (left.endMs !== right.endMs) return left.endMs - right.endMs;
    return left.channel - right.channel;
  },);

  const blocks: Array<MeetingTranscriptBlock & { endMs: number; }> = [];
  for (const word of words) {
    const speakerKey = getTranscriptSpeakerKey(word,);
    const previousBlock = blocks[blocks.length - 1];
    if (
      !previousBlock
      || previousBlock.speakerKey !== speakerKey
      || word.startMs - previousBlock.endMs >= 4000
    ) {
      blocks.push({
        speakerKey,
        startMs: word.startMs,
        endMs: word.endMs,
        text: word.text,
      },);
      continue;
    }

    previousBlock.text += word.text;
    previousBlock.endMs = Math.max(previousBlock.endMs, word.endMs,);
  }

  return blocks
    .map(({ speakerKey, startMs, text, },) => ({
      speakerKey,
      startMs,
      text: text.trim(),
    }))
    .filter((block,) => block.text.length > 0);
}

function getTranscriptText(state: MeetingTranscriptState, includePartial = true,) {
  const allWords = [
    ...Object.values(state.finalWordsByChannel,).flat(),
    ...(includePartial ? Object.values(state.partialWordsByChannel,).flat() : []),
  ].sort((left, right,) => {
    if (left.startMs !== right.startMs) return left.startMs - right.startMs;
    if (left.endMs !== right.endMs) return left.endMs - right.endMs;
    return left.channel - right.channel;
  },);

  const wordText = allWords.map((word,) => word.text).join("",).trim();
  if (wordText) return wordText;

  return includePartial
    ? [state.fallbackFinalText, state.fallbackPartialText,].filter(Boolean,).join("\n\n",).trim()
    : state.fallbackFinalText.trim();
}

function getLiveTranscriptCaption(transcript: string, maxCharacters = 28,) {
  const normalized = transcript.replace(/\s+/g, " ",).trim();
  if (!normalized) return "Listening...";

  const words = normalized.split(" ",).filter(Boolean,);
  let currentLine = "";

  for (const word of words) {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;
    if (currentLine && nextLine.length > maxCharacters) {
      currentLine = word;
      continue;
    }

    currentLine = nextLine;
  }

  return currentLine || normalized;
}

function createLiveMeetingTranscript(
  pageTitle: string,
  transcript: string,
  liveCaptionText = "",
): LiveMeetingTranscript {
  const fullText = transcript.trim();
  return {
    pageTitle,
    captionText: getLiveTranscriptCaption(liveCaptionText,),
    fullText,
  };
}

function LiveMeetingTranscriptOverlay({
  transcript,
  open,
  onOpen,
  onClose,
}: {
  transcript: LiveMeetingTranscript | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
},) {
  const scrollRef = useRef<HTMLDivElement | null>(null,);

  useEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [open, transcript?.fullText,],);

  if (!transcript) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[90] transition-transform duration-300 ease-out">
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        <div className="overflow-hidden border border-gray-200 bg-white/98 shadow-[0_-20px_60px_rgba(15,23,42,0.16)] backdrop-blur transition-[border-radius,box-shadow] duration-300 ease-out">
          <button
            type="button"
            onClick={open ? onClose : onOpen}
            className="flex w-full flex-col gap-2 px-4 py-3 text-left"
          >
            <div className="flex items-center justify-between gap-4">
              <div
                className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-gray-400"
                style={{ fontFamily: "'IBM Plex Mono', monospace", }}
              >
                <span className="h-2 w-2 rounded-full bg-red-500" />
                live transcript
              </div>
              {open && (
                <span className="rounded-full border border-gray-200 p-2 text-gray-500">
                  <X className="h-4 w-4" strokeWidth={2} />
                </span>
              )}
            </div>
            <p
              className={`${
                open ? "text-base leading-7" : "overflow-hidden whitespace-nowrap text-sm leading-6"
              } text-gray-900`}
            >
              {open ? transcript.pageTitle : transcript.captionText}
            </p>
          </button>

          <div
            className={`grid transition-[grid-template-rows,border-color] duration-300 ease-out ${
              open ? "grid-rows-[1fr] border-t border-gray-200" : "grid-rows-[0fr] border-t border-transparent"
            }`}
          >
            <div className="min-h-0 overflow-hidden">
              <div
                ref={scrollRef}
                className="max-h-[60vh] overflow-y-auto px-4 py-4 sm:px-6 sm:py-5"
              >
                <p className="whitespace-pre-wrap text-sm leading-7 text-gray-900 sm:text-base sm:leading-8">
                  {transcript.fullText || "Listening..."}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatMeetingLifecycleError(
  error: NonNullable<Extract<ListenerSessionLifecycleEvent, { type: "active"; }>["error"]>,
): string {
  switch (error.type) {
    case "authentication_failed":
      return error.provider
        ? `Recording provider authentication failed for ${error.provider}.`
        : "Recording provider authentication failed.";
    case "upstream_unavailable":
      return error.message || "Recording provider is unavailable.";
    case "connection_timeout":
      return "Recording provider connection timed out.";
    case "stream_error":
      return error.message || "Recording provider stream failed.";
  }

  return "Recording provider failed.";
}

function formatMeetingSessionError(event: ListenerSessionErrorEvent,) {
  if (event.type === "connection_error") {
    return event.error || "Recording provider connection failed.";
  }

  return event.device
    ? `${event.error} (${event.device})`
    : event.error || "Audio capture failed.";
}

function getDocPlainText(doc: JSONContent,) {
  return normalizeDocContent(doc,)
    .map((node,) => getNodeText(node,).trim())
    .filter(Boolean,)
    .join("\n\n",);
}

function hasHeading(doc: JSONContent, label: string,) {
  return normalizeDocContent(doc,).some((node,) => node.type === "heading" && getNodeText(node,).trim() === label);
}

function trimTrailingEmptyParagraphs(content: JSONContent[],): JSONContent[] {
  const trimmed = [...content,];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (last?.type !== "paragraph" || getNodeText(last,).trim()) break;
    trimmed.pop();
  }
  return trimmed;
}

function getTextAfterHeading(doc: JSONContent, label: string,) {
  const content = normalizeDocContent(doc,);
  const parts: string[] = [];
  let capturing = false;

  for (const node of content) {
    if (node.type === "heading") {
      const text = getNodeText(node,).trim();
      if (text === label) {
        capturing = true;
        continue;
      }
      if (capturing) {
        break;
      }
    }

    if (!capturing) continue;
    const text = getNodeText(node,).trim();
    if (text) {
      parts.push(text,);
    }
  }

  return parts.join("\n\n",).trim();
}

function splitMeetingCaptureDoc(doc: JSONContent,) {
  const content = normalizeDocContent(doc,);
  let transcriptStartIndex = -1;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const node = content[index];
    if (node.type === "heading" && getNodeText(node,).trim() === "Transcript") {
      transcriptStartIndex = index;
      break;
    }
  }

  if (transcriptStartIndex === -1) {
    return { baseDoc: doc, transcript: "", };
  }

  let captureStartIndex = transcriptStartIndex;
  for (let index = transcriptStartIndex - 1; index >= 0; index -= 1) {
    const node = content[index];
    if (node.type !== "heading") continue;

    const label = getNodeText(node,).trim();
    if (label === "Summary" || label === "Decisions" || label === "Action Items" || label === "Key Takeaways") {
      captureStartIndex = index;
      continue;
    }
    break;
  }

  const baseContent = trimTrailingEmptyParagraphs(content.slice(0, captureStartIndex,),);
  return {
    baseDoc: baseContent.length > 0 ? { type: "doc", content: baseContent, } : EMPTY_DOC,
    transcript: getTextAfterHeading(
      {
        type: "doc",
        content: content.slice(captureStartIndex,),
      },
      "Transcript",
    ),
  };
}

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

function formatSummaryUpdatedAt(value: string | null,) {
  if (!value) return null;
  const date = new Date(value,);
  if (Number.isNaN(date.getTime(),)) return null;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },);
}

function MetadataField({
  label,
  value,
  monospace = false,
}: {
  label: string;
  value: string | null;
  monospace?: boolean;
},) {
  if (!value) return null;

  return (
    <div>
      <p
        className="text-[11px] uppercase tracking-[0.18em] text-gray-400"
        style={{ fontFamily: "'IBM Plex Mono', monospace", }}
      >
        {label}
      </p>
      <p className={`mt-1 text-sm text-gray-700 ${monospace ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function MetadataList({
  label,
  values,
  monospace = false,
}: {
  label: string;
  values: string[];
  monospace?: boolean;
},) {
  if (values.length === 0) return null;

  return (
    <div>
      <p
        className="text-[11px] uppercase tracking-[0.18em] text-gray-400"
        style={{ fontFamily: "'IBM Plex Mono', monospace", }}
      >
        {label}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.map((value,) => (
          <span
            key={`${label}-${value}`}
            className={`rounded-full border border-gray-200 bg-white px-3 py-1 text-sm text-gray-700 ${
              monospace ? "font-mono" : ""
            }`}
          >
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function formatGitHubCount(value: number | null,) {
  if (value === null) return null;
  return value.toLocaleString("en-US",);
}

function formatGitHubDate(value: string | null,) {
  if (!value) return null;
  return formatSummaryUpdatedAt(value,);
}

function GitHubPageHeader({ page, }: { page: PageNote; },) {
  if (page.linkKind === "github_pr" && page.linkData) {
    const data = page.linkData as GitHubPrLinkData;
    return (
      <div className="mt-4 rounded-3xl border border-gray-200 bg-gray-50/80 px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-black px-3 py-1 text-xs font-medium uppercase tracking-wide text-white">
            GitHub Pull Request
          </span>
          <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-sm text-gray-700">
            {data.owner}/{data.repo}
          </span>
          <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-sm text-gray-700">
            {data.state}
          </span>
          {data.isDraft && (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-sm text-amber-700">
              Draft
            </span>
          )}
          {data.isMerged && (
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm text-emerald-700">
              Merged
            </span>
          )}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <MetadataField label="PR" value={`#${data.number}`} monospace />
          <MetadataField label="Author" value={data.author} />
          <MetadataField label="Base Branch" value={data.baseBranch} monospace />
          <MetadataField label="Head Branch" value={data.headBranch} monospace />
          <MetadataField label="Commits" value={formatGitHubCount(data.commitsCount,)} />
          <MetadataField label="Files Changed" value={formatGitHubCount(data.changedFilesCount,)} />
          <MetadataField label="Additions" value={formatGitHubCount(data.additions,)} />
          <MetadataField label="Deletions" value={formatGitHubCount(data.deletions,)} />
        </div>
        <div className="mt-4 space-y-4">
          <MetadataList label="Labels" values={data.labels} />
          <MetadataList label="Assignees" values={data.assignees} />
          <MetadataList label="Reviewers" values={data.reviewers} />
          <MetadataList label="Changed Files" values={data.changedFiles} monospace />
        </div>
      </div>
    );
  }

  if (page.linkKind === "github_issue" && page.linkData) {
    const data = page.linkData as GitHubIssueLinkData;
    return (
      <div className="mt-4 rounded-3xl border border-gray-200 bg-gray-50/80 px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-black px-3 py-1 text-xs font-medium uppercase tracking-wide text-white">
            GitHub Issue
          </span>
          <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-sm text-gray-700">
            {data.owner}/{data.repo}
          </span>
          <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-sm text-gray-700">
            {data.state}
          </span>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <MetadataField label="Issue" value={`#${data.number}`} monospace />
          <MetadataField label="Author" value={data.author} />
          <MetadataField label="Opened" value={formatGitHubDate(data.openedAt,)} />
          <MetadataField label="Closed" value={formatGitHubDate(data.closedAt,)} />
        </div>
        <div className="mt-4 space-y-4">
          <MetadataList label="Labels" values={data.labels} />
          <MetadataList label="Assignees" values={data.assignees} />
        </div>
      </div>
    );
  }

  if (page.linkKind === "github_commit" && page.linkData) {
    const data = page.linkData as GitHubCommitLinkData;
    return (
      <div className="mt-4 rounded-3xl border border-gray-200 bg-gray-50/80 px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-black px-3 py-1 text-xs font-medium uppercase tracking-wide text-white">
            GitHub Commit
          </span>
          <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-sm text-gray-700">
            {data.owner}/{data.repo}
          </span>
          <span className="rounded-full border border-gray-200 bg-white px-3 py-1 font-mono text-sm text-gray-700">
            {data.shortSha}
          </span>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <MetadataField label="Author" value={data.author} />
          <MetadataField label="Committed" value={formatGitHubDate(data.committedAt,)} />
          <MetadataField label="Files Changed" value={formatGitHubCount(data.changedFilesCount,)} />
          <MetadataField label="Additions" value={formatGitHubCount(data.additions,)} />
          <MetadataField label="Deletions" value={formatGitHubCount(data.deletions,)} />
          <MetadataField label="SHA" value={data.sha} monospace />
        </div>
        <div className="mt-4">
          <MetadataList label="Changed Files" values={data.changedFiles} monospace />
        </div>
      </div>
    );
  }

  return null;
}

function DateHeader({
  date,
  city,
  fallbackCity,
  onCityChange,
  onTitleContextMenu,
}: {
  date: string;
  city?: string | null;
  fallbackCity?: string | null;
  onCityChange?: (city: string | null,) => void;
  onTitleContextMenu?: (event: ReactMouseEvent<HTMLElement>,) => void;
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
        onContextMenu={onTitleContextMenu}
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

function LazyNote({
  date,
  pagesRevision,
  onOpenDate,
  onOpenPage,
  onDeletePage,
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
  onDeletePage?: (title: string,) => Promise<void> | void;
  onCreatePage?: (input?: { open?: boolean; title?: string; },) => Promise<string | null> | string | null;
  onInteract?: () => void;
  onChatSelection?: (selection: EditableNoteSelection,) => void;
  onSelectionChange?: (selection: EditableNoteSelection | null,) => void;
  onSelectionBlur?: (editor: TiptapEditor,) => void;
  persistentSelectionRange?: { from: number; to: number; } | null;
},) {
  const [note, setNote,] = useState<DailyNote | null>(null,);
  const containerRef = useRef<HTMLDivElement>(null,);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry,],) => {
        if (entry.isIntersecting) {
          const loadNote = date > getToday() ? getOrCreateDailyNote(date,) : loadDailyNote(date,);
          loadNote.then(setNote,).catch(console.error,);
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
            <DateHeader
              date={note.date}
              city={note.city}
              onCityChange={handleCityChange}
              onTitleContextMenu={(event,) => {
                showFinderContextMenu(event, `show-note-in-finder-${note.date}`, getNotePath(note.date,),);
              }}
            />
          </div>
          <EditableNote
            note={note}
            onOpenDate={onOpenDate}
            onOpenPage={onOpenPage}
            onDeletePage={onDeletePage}
            onCreatePage={onCreatePage}
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
  pageOverride,
  transcriptReadOnly,
  transcriptHidden,
  meetingRecordingError,
  onOpenDate,
  onOpenPage,
  onCreatePage,
  onAskAiPrompt,
  onSave,
  onRenameTitle,
  onDeletePage,
  onInteract,
  editorRef,
  onPageChange,
}: {
  title: string;
  pagesRevision: number;
  pageOverride?: PageNote | null;
  transcriptReadOnly?: boolean;
  transcriptHidden?: boolean;
  meetingRecordingError?: string | null;
  onOpenDate?: (date: string,) => void;
  onOpenPage?: (title: string,) => void;
  onCreatePage?: (input?: { open?: boolean; title?: string; },) => Promise<string | null> | string | null;
  onAskAiPrompt?: (prompt: string,) => void;
  onSave?: (page: PageNote,) => void;
  onRenameTitle?: (page: PageNote, nextTitle: string,) => Promise<PageNote | null> | PageNote | null;
  onDeletePage?: (title: string,) => Promise<void> | void;
  onInteract?: () => void;
  editorRef?: RefObject<EditableNoteHandle | null>;
  onPageChange?: (page: PageNote | null,) => void;
},) {
  const [page, setPage,] = useState<PageNote | null>(null,);
  const [isEditingTitle, setIsEditingTitle,] = useState(false,);
  const [draftTitle, setDraftTitle,] = useState(title,);
  const [titleEditError, setTitleEditError,] = useState<string | null>(null,);
  const titleInputRef = useRef<HTMLInputElement | null>(null,);
  const resolvedPage = pageOverride?.title === title ? pageOverride : page;

  useEffect(() => {
    loadPage(title,).then(setPage,).catch(console.error,);
  }, [pagesRevision, title,],);

  useEffect(() => {
    if (!pageOverride || pageOverride.title !== title) return;
    setPage(pageOverride,);
  }, [pageOverride, title,],);

  useEffect(() => {
    onPageChange?.(resolvedPage ?? null,);
  }, [onPageChange, resolvedPage,],);

  useEffect(() => {
    return () => onPageChange?.(null,);
  }, [onPageChange, title,],);

  const handleSave = useCallback((note: DailyNote | PageNote,) => {
    if ("date" in note) return;
    setPage(note,);
    if (onSave) {
      onSave(note,);
    } else {
      savePage(note,).catch(console.error,);
    }
  }, [onSave,],);

  const pageIsUrlSummary = resolvedPage ? isUrlSummaryPage(resolvedPage,) : false;
  const pageIsTypedGitHub = !!resolvedPage && (
    resolvedPage.linkKind === "github_pr"
    || resolvedPage.linkKind === "github_issue"
    || resolvedPage.linkKind === "github_commit"
  );
  const pageEditableTitle = resolvedPage ? getPageDisplayTitle(resolvedPage.title,) : getPageDisplayTitle(title,);
  const pageHeading = resolvedPage
    ? (pageIsUrlSummary ? resolvedPage.linkTitle ?? pageEditableTitle : pageEditableTitle)
    : pageEditableTitle;
  const canEditTitle = !!resolvedPage && pageHeading === pageEditableTitle && !!onRenameTitle;
  const titleInputWidthCh = Math.max(draftTitle.length, 1,) + 1;
  const meetingLocation = resolvedPage?.type === "meeting" ? resolvedPage.location?.trim() ?? "" : "";
  const summaryUpdatedAt = formatSummaryUpdatedAt(resolvedPage?.summaryUpdatedAt ?? null,);

  useEffect(() => {
    if (!isEditingTitle) {
      setDraftTitle(pageHeading,);
    }
  }, [isEditingTitle, pageHeading,],);

  useEffect(() => {
    if (!isEditingTitle) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [isEditingTitle,],);

  const cancelTitleEdit = useCallback(() => {
    setDraftTitle(pageHeading,);
    setTitleEditError(null,);
    setIsEditingTitle(false,);
  }, [pageHeading,],);

  const saveTitleEdit = useCallback(async () => {
    if (!resolvedPage || !canEditTitle || !onRenameTitle) return;

    const nextTitle = sanitizePageTitle(draftTitle,);
    setIsEditingTitle(false,);

    if (!nextTitle) {
      setDraftTitle(pageEditableTitle,);
      return;
    }

    if (nextTitle === pageEditableTitle || nextTitle === resolvedPage.title) {
      setDraftTitle(pageEditableTitle,);
      setTitleEditError(null,);
      return;
    }

    try {
      setTitleEditError(null,);
      const renamedPage = await onRenameTitle(resolvedPage, nextTitle,);
      setDraftTitle(getPageDisplayTitle(renamedPage?.title ?? nextTitle,),);
    } catch (error) {
      setDraftTitle(pageEditableTitle,);
      setTitleEditError(
        error instanceof Error ? error.message : typeof error === "string" ? error : "Could not rename page.",
      );
    }
  }, [canEditTitle, draftTitle, onRenameTitle, pageEditableTitle, resolvedPage,],);

  if (!resolvedPage) {
    return (
      <div className="w-full max-w-3xl px-6 pt-6 pb-10">
        <p className="text-sm text-gray-500 dark:text-gray-400">Page not found.</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl">
      <div className="px-6 pt-6 pb-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {isEditingTitle && canEditTitle
            ? (
              <input
                ref={titleInputRef}
                value={draftTitle}
                onChange={(event,) => setDraftTitle(event.target.value,)}
                onBlur={() => {
                  void saveTitleEdit();
                }}
                onKeyDown={(event,) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelTitleEdit();
                  }
                }}
                className="min-w-0 bg-transparent p-0 text-2xl italic text-gray-900 dark:text-white focus:outline-hidden"
                style={{
                  fontFamily: '"Instrument Serif", serif',
                  width: `${titleInputWidthCh}ch`,
                  maxWidth: "100%",
                }}
              />
            )
            : (
              <h1
                className={`text-2xl italic text-gray-900 dark:text-white ${canEditTitle ? "cursor-text" : ""}`}
                style={{ fontFamily: '"Instrument Serif", serif', }}
                onClick={() => {
                  if (!canEditTitle) return;
                  setTitleEditError(null,);
                  setDraftTitle(pageEditableTitle,);
                  setIsEditingTitle(true,);
                }}
                onContextMenu={(event,) => {
                  showFinderContextMenu(
                    event,
                    `show-page-in-finder-${resolvedPage.title}`,
                    resolvedPage.path ? Promise.resolve(resolvedPage.path,) : getPagePath(resolvedPage.title,),
                    onDeletePage
                      ? {
                        id: `delete-page-${resolvedPage.title}`,
                        text: "Delete Note",
                        action: () => {
                          void Promise.resolve(onDeletePage(resolvedPage.title,),).catch(console.error,);
                        },
                      }
                      : undefined,
                  );
                }}
              >
                {pageHeading}
              </h1>
            )}
          {resolvedPage.type === "meeting" && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span
                className="text-xs font-medium uppercase tracking-wide px-3 py-1 rounded-md text-white font-sans"
                style={{ background: "linear-gradient(to bottom, #4b5563, #1f2937)", }}
              >
                meeting
              </span>
              {meetingLocation && (
                <div className="inline-flex max-w-full items-center gap-1.5 text-gray-400 dark:text-gray-500">
                  <MapPin className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                  <span className="min-w-0 text-sm font-sans text-gray-500 dark:text-gray-400">
                    {meetingLocation}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
        {titleEditError && (
          <p
            className="mt-3 text-xs text-red-500"
            style={{ fontFamily: "'IBM Plex Mono', monospace", }}
          >
            {titleEditError}
          </p>
        )}
        {resolvedPage.type === "meeting" && meetingRecordingError && (
          <p
            className="mt-3 text-xs text-red-500"
            style={{ fontFamily: "'IBM Plex Mono', monospace", }}
          >
            {meetingRecordingError}
          </p>
        )}
        {pageIsUrlSummary && resolvedPage.source && (
          <div className="mt-3 space-y-2">
            <button
              type="button"
              onClick={() => openUrl(resolvedPage.source!,).catch(console.error,)}
              className="block max-w-full truncate text-left text-sm text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              title={resolvedPage.source}
            >
              {resolvedPage.source}
            </button>
            {summaryUpdatedAt && (
              <p
                className="text-[11px] uppercase tracking-[0.18em] text-gray-400"
                style={{ fontFamily: "'IBM Plex Mono', monospace", }}
              >
                summarized {summaryUpdatedAt}
              </p>
            )}
          </div>
        )}
        {pageIsTypedGitHub && <GitHubPageHeader page={resolvedPage} />}
      </div>
      <EditableNote
        ref={editorRef}
        note={resolvedPage}
        transcriptReadOnly={transcriptReadOnly}
        transcriptHidden={transcriptHidden}
        onSave={handleSave}
        onOpenDate={onOpenDate}
        onOpenPage={onOpenPage}
        onDeletePage={onDeletePage}
        onCreatePage={onCreatePage}
        onInteract={onInteract}
      />
      {pageIsUrlSummary && resolvedPage.followUpQuestions.length > 0 && onAskAiPrompt && (
        <div className="px-6 pt-4 pb-6">
          <p
            className="text-[11px] uppercase tracking-[0.18em] text-gray-400"
            style={{ fontFamily: "'IBM Plex Mono', monospace", }}
          >
            ask ai next
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {resolvedPage.followUpQuestions.map((question,) => (
              <button
                key={question}
                type="button"
                onClick={() => onAskAiPrompt(question,)}
                className="rounded-full border border-gray-200 bg-gray-50 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:border-gray-300 hover:bg-white hover:text-gray-900"
              >
                {question}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AppLayout() {
  const today = useCurrentDate();
  const currentCity = useCurrentCity();
  const [todayNote, setTodayNote,] = useState<DailyNote | null>(null,);
  const todayCity = todayNote?.city;
  const fallbackTodayCity = currentCity.city.trim();
  const pastDates = useMemo(() => Array.from({ length: 30, }, (_, i,) => getDaysAgo(i + 1,),), [today,],);
  const [settingsOpen, setSettingsOpen,] = useState(false,);
  const [settingsInitialTab, setSettingsInitialTab,] = useState<SettingsTab>("ai",);
  const [libraryOpen, setLibraryOpen,] = useState(false,);
  const [onboardingOpen, setOnboardingOpen,] = useState(false,);
  const [isConfigured, setIsConfigured,] = useState(false,);
  const [storageRevision, setStorageRevision,] = useState(0,);
  const [pagesRevision, setPagesRevision,] = useState(0,);
  const [updateInfo, setUpdateInfo,] = useState<UpdateInfo | null>(null,);
  const [postUpdateInfo, setPostUpdateInfo,] = useState<PostUpdateInfo | null>(null,);
  const [isPinned, setIsPinned,] = useState(false,);
  const [isTaskTriaging, setIsTaskTriaging,] = useState(false,);
  const [isWindowFocused, setIsWindowFocused,] = useState(() => document.hasFocus());
  const [isMeetingRecording, setIsMeetingRecording,] = useState(false,);
  const [meetingRecordingError, setMeetingRecordingError,] = useState<string | null>(null,);
  const [liveMeetingTranscript, setLiveMeetingTranscript,] = useState<LiveMeetingTranscript | null>(null,);
  const [meetingTranscriptModalOpen, setMeetingTranscriptModalOpen,] = useState(false,);
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

  const openSettings = useCallback((tab: SettingsTab = "ai",) => {
    setSettingsInitialTab(tab,);
    setSettingsOpen(true,);
  }, [],);
  const [aiApplyingDates, setAiApplyingDates,] = useState<string[]>([],);
  const [activePage, setActivePage,] = useState<PageNote | null>(null,);
  const [meetingSummaryTargetTitle, setMeetingSummaryTargetTitle,] = useState<string | null>(null,);
  const [meetingSummaryError, setMeetingSummaryError,] = useState<string | null>(null,);
  const [viewState, setViewState,] = useState<{ history: AppView[]; index: number; }>({
    history: [{ kind: "home", },],
    index: 0,
  },);
  const aiAbortControllerRef = useRef<AbortController | null>(null,);
  const currentSelectionRef = useRef<EditableNoteSelection | null>(null,);
  const aiLastSubmittedPromptRef = useRef("",);
  const todayNoteRef = useRef<DailyNote | null>(null,);
  const todayEditorRef = useRef<EditableNoteHandle>(null,);
  const currentPageRef = useRef<PageNote | null>(null,);
  const pageEditorRef = useRef<EditableNoteHandle>(null,);
  const activeMeetingSessionRef = useRef<ActiveMeetingSession | null>(null,);
  const meetingListenerUnsubscribersRef = useRef<UnlistenFn[]>([],);
  const homeScrollTopRef = useRef(0,);
  const restoreHomeScrollTopRef = useRef<number | null>(null,);
  const googleSyncRef = useRef<Promise<boolean> | null>(null,);
  const suppressWatcherUntilRef = useRef(0,);
  const searchInputRef = useRef<HTMLInputElement>(null,);
  const searchResultRefs = useRef<(HTMLButtonElement | null)[]>([],);
  const searchNavigationModeRef = useRef<"mouse" | "keyboard">("mouse",);
  const hasMountedViewRef = useRef(false,);
  const nextViewAnimationDirectionRef = useRef<"forward" | "backward" | null>(null,);
  const skipNextViewAnimationRef = useRef(false,);
  const viewAnimationFrameRef = useRef<number | null>(null,);
  const viewAnimationResetRef = useRef<number | null>(null,);
  const currentView = viewState.history[viewState.index] ?? { kind: "home", };
  const currentPageTitle = currentView.kind === "page" ? currentView.title : null;
  const activeMeetingPageTitle = liveMeetingTranscript?.pageTitle ?? activeMeetingSessionRef.current?.pageTitle ?? null;
  const currentViewKey = currentView.kind === "page" ? `page:${currentView.title}` : "home";
  const canGoBack = viewState.index > 0;
  const canGoForward = viewState.index < viewState.history.length - 1;
  const canTriageTasks = currentView.kind === "page" ? Boolean(activePage,) : Boolean(todayNote,);
  const showMeetingRecordingErrorBanner = Boolean(meetingRecordingError,) && activePage?.type !== "meeting";
  const focusedFutureDate = focusedDate && focusedDate !== today && !pastDates.includes(focusedDate,)
    ? focusedDate
    : null;
  const hasFocusedFutureDate = focusedFutureDate !== null;
  const [viewTransitionStyle, setViewTransitionStyle,] = useState<{
    opacity: number;
    transform: string;
    transition: string;
  }>({
    opacity: 1,
    transform: "translateX(0px)",
    transition: "none",
  },);
  useEffect(() => {
    todayNoteRef.current = todayNote;
  }, [todayNote,],);

  useEffect(() => {
    setMeetingSummaryError(null,);
    setMeetingSummaryTargetTitle(null,);
    setMeetingRecordingError(null,);
  }, [activePage?.title,],);

  useEffect(() => {
    if (!meetingTranscriptModalOpen) return;

    const handleKeyDown = (event: KeyboardEvent,) => {
      if (event.key === "Escape") {
        setMeetingTranscriptModalOpen(false,);
      }
    };

    window.addEventListener("keydown", handleKeyDown,);
    return () => window.removeEventListener("keydown", handleKeyDown,);
  }, [meetingTranscriptModalOpen,],);

  const handleCurrentPageChange = useCallback((page: PageNote | null,) => {
    currentPageRef.current = page;
    setActivePage(page,);
  }, [],);

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

  const handleViewTransition = useCallback((from: AppView, to: AppView,) => {
    if (from.kind === "home" && to.kind === "page") {
      homeScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
    }

    if (from.kind === "page" && to.kind === "home") {
      restoreHomeScrollTopRef.current = homeScrollTopRef.current;
    }
  }, [],);

  useEffect(() => {
    if (!hasMountedViewRef.current) {
      hasMountedViewRef.current = true;
      return;
    }

    if (skipNextViewAnimationRef.current) {
      skipNextViewAnimationRef.current = false;
      nextViewAnimationDirectionRef.current = null;
      setViewTransitionStyle({
        opacity: 1,
        transform: "translateX(0px)",
        transition: "none",
      },);
      return;
    }

    if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)",).matches) {
      setViewTransitionStyle({
        opacity: 1,
        transform: "translateX(0px)",
        transition: "none",
      },);
      nextViewAnimationDirectionRef.current = null;
      return;
    }

    if (viewAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(viewAnimationFrameRef.current,);
    }
    if (viewAnimationResetRef.current !== null) {
      window.clearTimeout(viewAnimationResetRef.current,);
    }

    const direction = nextViewAnimationDirectionRef.current ?? "forward";
    nextViewAnimationDirectionRef.current = null;
    const startOffset = direction === "backward" ? -40 : 40;

    setViewTransitionStyle({
      opacity: 0.92,
      transform: `translateX(${startOffset}px)`,
      transition: "none",
    },);

    viewAnimationFrameRef.current = window.requestAnimationFrame(() => {
      viewAnimationFrameRef.current = window.requestAnimationFrame(() => {
        setViewTransitionStyle({
          opacity: 1,
          transform: "translateX(0px)",
          transition: "transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease-out",
        },);
        viewAnimationResetRef.current = window.setTimeout(() => {
          setViewTransitionStyle({
            opacity: 1,
            transform: "translateX(0px)",
            transition: "none",
          },);
          viewAnimationResetRef.current = null;
        }, 240,);
      },);
    },);

    return () => {
      if (viewAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(viewAnimationFrameRef.current,);
        viewAnimationFrameRef.current = null;
      }
      if (viewAnimationResetRef.current !== null) {
        window.clearTimeout(viewAnimationResetRef.current,);
        viewAnimationResetRef.current = null;
      }
    };
  }, [currentViewKey,],);

  const pushView = useCallback((nextView: AppView,) => {
    setViewState((current,) => {
      const activeView = current.history[current.index] ?? { kind: "home", };
      if (JSON.stringify(activeView,) === JSON.stringify(nextView,)) {
        return current;
      }

      nextViewAnimationDirectionRef.current = "forward";
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
      nextViewAnimationDirectionRef.current = "backward";
      handleViewTransition(current.history[current.index], current.history[current.index - 1],);
      return { ...current, index: current.index - 1, };
    },);
  }, [handleViewTransition,],);

  const goForward = useCallback(() => {
    setViewState((current,) => {
      if (current.index >= current.history.length - 1) return current;
      nextViewAnimationDirectionRef.current = "forward";
      handleViewTransition(current.history[current.index], current.history[current.index + 1],);
      return { ...current, index: current.index + 1, };
    },);
  }, [handleViewTransition,],);

  const goHome = useCallback(() => {
    setViewState((current,) => {
      const activeView = current.history[current.index] ?? { kind: "home", };
      if (activeView.kind === "home") return current;

      let homeIndex = current.index - 1;
      while (homeIndex > 0 && current.history[homeIndex]?.kind !== "home") {
        homeIndex -= 1;
      }

      const nextView = current.history[homeIndex] ?? { kind: "home", };
      nextViewAnimationDirectionRef.current = "backward";
      handleViewTransition(activeView, nextView,);
      return { ...current, index: homeIndex, };
    },);
  }, [handleViewTransition,],);

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

  const replaceTodayNoteContent = useCallback((content: JSONContent,) => {
    const note = todayNoteRef.current;
    if (!note) return;
    const updated = { ...note, content: JSON.stringify(content,), };
    suppressWatcherUntilRef.current = Date.now() + LOCAL_SAVE_WATCH_SUPPRESSION_MS;
    todayNoteRef.current = updated;
    setTodayNote(updated,);
    saveDailyNote(updated,).catch(console.error,);
    scheduleDesktopSync();
  }, [],);

  const attachMeetingPageToTodayNote = useCallback((title: string,) => {
    const editor = todayEditorRef.current?.editor;
    if (editor && !editor.isDestroyed) {
      editor.commands.setContent(appendAttachedPageLink(editor.getJSON(), title,), {
        emitUpdate: true,
      },);
      return;
    }

    const note = todayNoteRef.current;
    if (!note) return;
    replaceTodayNoteContent(appendAttachedPageLink(parseJsonContent(note.content,), title,),);
  }, [replaceTodayNoteContent,],);

  const clearMeetingListeners = useCallback(() => {
    const unlisteners = [...meetingListenerUnsubscribersRef.current,];
    meetingListenerUnsubscribersRef.current = [];
    unlisteners.forEach((unlisten,) => {
      try {
        unlisten();
      } catch (error) {
        console.error(error,);
      }
    },);
  }, [],);

  const persistPageUpdate = useCallback(async (page: PageNote,) => {
    suppressWatcherUntilRef.current = Date.now() + LOCAL_SAVE_WATCH_SUPPRESSION_MS;
    currentPageRef.current = page;
    setActivePage(page,);
    await savePage(page,);
    scheduleDesktopSync();
    return page;
  }, [],);

  const getMeetingLocationHint = useCallback(() => {
    const explicitTodayCity = todayNoteRef.current?.city?.trim();
    if (explicitTodayCity) return explicitTodayCity;

    const currentCityName = currentCity.city.trim();
    return currentCityName || null;
  }, [currentCity.city,],);

  const createMeetingPage = useCallback(async (startedAt: string, location: string | null,) => {
    const startedAtDate = new Date(startedAt,);
    const baseTitle = formatAdHocMeetingTitle(startedAtDate,);
    let candidate = baseTitle;
    let suffix = 2;

    while (await exists(await getPagePath(candidate,),)) {
      candidate = `${baseTitle} ${suffix}`;
      suffix += 1;
    }

    const page: PageNote = {
      title: candidate,
      path: await getPagePath(candidate,),
      content: JSON.stringify(EMPTY_DOC,),
      type: "meeting",
      attachedTo: today,
      eventId: null,
      startedAt,
      endedAt: null,
      participants: [],
      location,
      executiveSummary: null,
      sessionKind: null,
      agenda: [],
      actionItems: [],
      source: "ad-hoc",
      linkTitle: null,
      summaryUpdatedAt: null,
      followUpQuestions: [],
      linkKind: null,
      linkData: null,
      frontmatter: {
        type: "meeting",
        started_at: startedAt,
        location: location ?? undefined,
        source: "ad-hoc",
      },
      hasFrontmatter: true,
    };

    await savePage(page,);
    scheduleDesktopSync();
    return page;
  }, [today,],);

  const buildMeetingStartPage = useCallback((page: PageNote, startedAt: string, location: string | null,) => {
    const nextStartedAt = page.startedAt && !page.endedAt ? page.startedAt : startedAt;
    const nextLocation = page.location ?? location;
    const nextSource = page.source ?? "ad-hoc";

    return {
      ...page,
      type: "meeting" as const,
      startedAt: nextStartedAt,
      endedAt: null,
      location: nextLocation,
      executiveSummary: null,
      sessionKind: null,
      agenda: [],
      actionItems: [],
      source: nextSource,
      linkKind: null,
      linkData: null,
      hasFrontmatter: true,
      frontmatter: {
        ...page.frontmatter,
        type: "meeting",
        started_at: nextStartedAt,
        ended_at: undefined,
        location: nextLocation ?? undefined,
        executive_summary: undefined,
        session_kind: undefined,
        agenda: undefined,
        action_items: undefined,
        source: nextSource,
      },
    } satisfies PageNote;
  }, [],);

  const updateMeetingPage = useCallback(async ({
    pageTitle,
    transcript,
    endedAt,
    summaryResult,
    transcriptBlocks,
    preserveTranscriptFormatting = false,
  }: {
    pageTitle: string;
    transcript: string;
    endedAt?: string | null;
    summaryResult?: Awaited<ReturnType<typeof summarizeMeeting>>;
    transcriptBlocks?: MeetingTranscriptBlock[];
    preserveTranscriptFormatting?: boolean;
  },) => {
    const page = currentPageRef.current?.title === pageTitle
      ? currentPageRef.current
      : await loadPage(pageTitle,);
    if (!page) return null;

    const activeSession = activeMeetingSessionRef.current;
    const currentDoc = parseJsonContent(page.content,);
    const baseDoc = activeSession?.pageTitle === pageTitle
      ? activeSession.baseDoc
      : splitMeetingCaptureDoc(currentDoc,).baseDoc;
    const transcriptText = activeSession?.pageTitle === pageTitle
      ? mergeTranscriptText(activeSession.existingTranscript, transcript,)
      : transcript;
    const nextSummary = summaryResult
      ? (summaryResult.summary.length > 0 ? summaryResult.summary : [summaryResult.executiveSummary,])
      : undefined;
    const nextSessionKind = summaryResult?.sessionKind ?? page.sessionKind;
    const nextAgenda = summaryResult
      ? (summaryResult.sessionKind === "decision_making" ? summaryResult.agenda : [])
      : page.agenda;
    const nextActionItems = summaryResult
      ? (summaryResult.sessionKind === "decision_making" ? summaryResult.actionItems : [])
      : page.actionItems;
    const preservedTranscriptContent = preserveTranscriptFormatting && !transcriptBlocks
      ? getContentAfterHeading(currentDoc, "Transcript",)
      : undefined;
    const nextCaptureDoc = buildMeetingCaptureDoc({
      sessionKind: nextSessionKind,
      summary: nextSummary,
      decisions: summaryResult?.decisions,
      keyTakeaways: summaryResult?.keyTakeaways,
      actionItems: nextActionItems,
      transcript: transcriptText,
      transcriptBlocks,
      transcriptPrefix: transcriptBlocks?.length && activeSession?.pageTitle === pageTitle
        ? activeSession.existingTranscript
        : undefined,
      transcriptContent: preservedTranscriptContent,
    },);
    const nextStartedAt = page.startedAt ?? activeSession?.startedAt ?? null;
    const nextLocation = summaryResult?.location ?? page.location;
    const nextParticipants = summaryResult?.participants.length ? summaryResult.participants : page.participants;
    const nextExecutiveSummary = summaryResult?.executiveSummary ?? page.executiveSummary;
    const nextEndedAt = endedAt ?? page.endedAt;
    const nextSource = page.source ?? "ad-hoc";

    return await persistPageUpdate({
      ...page,
      type: "meeting",
      content: JSON.stringify(appendDoc(baseDoc, nextCaptureDoc,),),
      startedAt: nextStartedAt,
      endedAt: nextEndedAt,
      participants: nextParticipants,
      location: nextLocation,
      executiveSummary: nextExecutiveSummary,
      sessionKind: nextSessionKind,
      agenda: nextAgenda,
      actionItems: nextActionItems,
      source: nextSource,
      linkKind: null,
      linkData: null,
      hasFrontmatter: true,
      frontmatter: {
        ...page.frontmatter,
        type: "meeting",
        started_at: nextStartedAt ?? undefined,
        ended_at: nextEndedAt ?? undefined,
        location: nextLocation ?? undefined,
        executive_summary: nextExecutiveSummary ?? undefined,
        session_kind: nextSessionKind ?? undefined,
        participants: nextParticipants.length > 0 ? nextParticipants : undefined,
        agenda: nextAgenda.length > 0 ? nextAgenda : undefined,
        action_items: nextActionItems.length > 0 ? nextActionItems : undefined,
        source: nextSource,
      },
    },);
  }, [persistPageUpdate,],);

  const summarizeMeetingPageNote = useCallback(async (
    pageInput: PageNote | string | null,
    transcriptOverride?: string,
    endedAtOverride?: string | null,
  ) => {
    const page = typeof pageInput === "string"
      ? (
        currentPageRef.current?.title === pageInput
          ? currentPageRef.current
          : await loadPage(pageInput,)
      )
      : pageInput;
    if (!page) return null;

    const currentDoc = parseJsonContent(page.content,);
    const activeSession = activeMeetingSessionRef.current?.pageTitle === page.title
      ? activeMeetingSessionRef.current
      : null;
    const fallbackSplit = splitMeetingCaptureDoc(currentDoc,);
    const transcript = transcriptOverride?.trim() || getTextAfterHeading(currentDoc, "Transcript",);
    if (!transcript) {
      throw new Error("No transcript is available to summarize.",);
    }

    setMeetingSummaryTargetTitle(page.title,);
    setMeetingSummaryError(null,);

    try {
      const result = await summarizeMeeting({
        title: page.title,
        transcript,
        startedAt: page.startedAt,
        endedAt: endedAtOverride ?? page.endedAt,
        attachedTo: page.attachedTo,
        locationHint: page.location ?? getMeetingLocationHint(),
        participantsHint: page.participants,
        notesContext: getDocPlainText(activeSession?.baseDoc ?? fallbackSplit.baseDoc,).slice(0, 6000,),
      },);

      const updated = await updateMeetingPage({
        pageTitle: page.title,
        transcript,
        endedAt: endedAtOverride ?? page.endedAt,
        summaryResult: result,
        preserveTranscriptFormatting: true,
      },);

      trackEvent("meeting_summarized", {
        action_item_count: result.actionItems.length,
        decision_count: result.decisions.length,
        key_takeaway_count: result.keyTakeaways.length,
        session_kind: result.sessionKind,
        source: transcriptOverride ? "recording" : "manual",
      },);
      setMeetingSummaryTargetTitle(null,);
      setMeetingSummaryError(null,);
      return updated;
    } catch (error) {
      setMeetingSummaryTargetTitle(null,);
      setMeetingSummaryError(error instanceof Error ? error.message : "Could not summarize meeting.",);
      throw error;
    }
  }, [getMeetingLocationHint, updateMeetingPage,],);

  const clearWidgetEditSession = useCallback((widgetId?: string | null,) => {
    const didClear = clearWidgetEditSessionStore(widgetId,);
    if (didClear || !widgetId) {
      setAiSelectedLabel(null,);
    }
  }, [],);

  const openGlobalSearch = useCallback(() => {
    clearWidgetEditSession();
    setAiComposerOpen(false,);
    setAiSelectedText(null,);
    setAiSelectionHighlight(null,);
    setAiError(null,);
    setGlobalSearchOpen(true,);
    trackEvent("search_opened", {
      source: currentView.kind,
    },);
  }, [clearWidgetEditSession, currentView.kind,],);

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

  const openAiComposerWithPrompt = useCallback((prompt: string,) => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return;

    clearWidgetEditSession();
    setGlobalSearchOpen(false,);
    setAiScope("recent",);
    setAiSelectedLabel(null,);
    setAiSelectedText(null,);
    setAiSelectionHighlight(null,);
    setAiComposerOpen(true,);
    setAiError(null,);
    setAiPrompt(normalizedPrompt,);
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

  const stopMeetingRecording = useCallback(async () => {
    trackEvent("meeting_recording_stop_requested",);
    try {
      await stopListenerSession();
    } catch (error) {
      console.error(error,);
    }
  }, [],);

  const finalizeMeetingRecording = useCallback(async (endedAt?: string | null, errorMessage?: string | null,) => {
    const activeSession = activeMeetingSessionRef.current;
    if (!activeSession) return;

    finalizeTranscriptState(activeSession.transcriptState,);
    const transcriptBlocks = buildFinalTranscriptBlocks(activeSession.transcriptState,);
    const transcript = mergeTranscriptText(
      activeSession.existingTranscript,
      getTranscriptText(activeSession.transcriptState, false,),
    );
    const finalizedAt = endedAt ?? new Date().toISOString();
    const failureReason = errorMessage ?? activeSession.failureReason;

    try {
      await updateMeetingPage({
        pageTitle: activeSession.pageTitle,
        transcript,
        endedAt: finalizedAt,
        transcriptBlocks,
      },);
    } catch (error) {
      console.error(error,);
    }

    clearMeetingListeners();
    activeMeetingSessionRef.current = null;
    setIsMeetingRecording(false,);
    setLiveMeetingTranscript(null,);
    setMeetingTranscriptModalOpen(false,);
    setMeetingRecordingError(failureReason,);

    if (failureReason) {
      console.error("Meeting recording stopped:", failureReason,);
    }

    trackEvent("meeting_recording_stopped", {
      failure: Boolean(failureReason,),
      has_transcript: Boolean(transcript,),
      transcript_block_count: transcriptBlocks.length,
    },);

    if (!transcript) {
      setMeetingSummaryTargetTitle(null,);
      setMeetingSummaryError(null,);
      return;
    }

    try {
      const settings = await loadSettings();
      const aiAvailable = hasActiveAiProvider(settings,);
      setHasAiConfigured(aiAvailable,);

      if (!aiAvailable) {
        setMeetingSummaryTargetTitle(null,);
        return;
      }

      await summarizeMeetingPageNote(activeSession.pageTitle, transcript, finalizedAt,);
    } catch (error) {
      setMeetingSummaryTargetTitle(null,);
      setMeetingSummaryError(error instanceof Error ? error.message : "Could not summarize meeting.",);
      console.error(error,);
    }
  }, [clearMeetingListeners, summarizeMeetingPageNote, updateMeetingPage,],);

  const handleMeetingRecordClick = useCallback(async () => {
    if (isMeetingRecording) {
      await stopMeetingRecording();
      return;
    }

    closeGlobalSearch();
    setMeetingSummaryTargetTitle(null,);
    setMeetingSummaryError(null,);
    setMeetingRecordingError(null,);

    const settings = await loadSettings();
    const sttConfig = resolveActiveSttConfig(settings,);
    if (!sttConfig) {
      openSettings("dictation",);
      return;
    }

    let speakerOnlyRecording = false;
    try {
      await ensureMicrophonePermission();
    } catch (error) {
      speakerOnlyRecording = true;
      console.warn("Microphone permission unavailable; continuing with system audio only.", error,);
    }

    let page: PageNote | null = null;
    const startedAt = new Date().toISOString();
    const location = getMeetingLocationHint();

    if (currentView.kind === "page") {
      page = currentPageRef.current ?? await loadPage(currentView.title,);
      if (!page) return;
    } else {
      const ensuredTodayNote = todayNoteRef.current ?? await getOrCreateDailyNote(today,);
      if (!todayNoteRef.current) {
        todayNoteRef.current = ensuredTodayNote;
        setTodayNote(ensuredTodayNote,);
      }
      page = await createMeetingPage(startedAt, location,);
      attachMeetingPageToTodayNote(page.title,);
      setPagesRevision((value,) => value + 1);
      openPageView(page.title,);
    }

    const preparedPage = buildMeetingStartPage(page, startedAt, location,);
    const pageEditor = pageEditorRef.current?.editor;
    const currentDoc = currentView.kind === "page" && pageEditor && !pageEditor.isDestroyed
      ? stripMeetingPageDoc(preparedPage, pageEditor.getJSON() as JSONContent,)
      : parseJsonContent(preparedPage.content,);
    const splitDoc = splitMeetingCaptureDoc(currentDoc,);

    await persistPageUpdate(preparedPage,);

    clearMeetingListeners();
    setMeetingTranscriptModalOpen(false,);
    const sessionId = crypto.randomUUID();
    activeMeetingSessionRef.current = {
      sessionId,
      pageTitle: preparedPage.title,
      startedAt: preparedPage.startedAt ?? startedAt,
      baseDoc: splitDoc.baseDoc,
      existingTranscript: splitDoc.transcript,
      transcriptState: createMeetingTranscriptState(),
      failureReason: null,
    };
    setLiveMeetingTranscript(createLiveMeetingTranscript(preparedPage.title, splitDoc.transcript,),);

    const sessionListeners: UnlistenFn[] = [];

    try {
      sessionListeners.push(
        await listenToListenerSessionData(async (event: ListenerSessionDataEvent,) => {
          const activeSession = activeMeetingSessionRef.current;
          if (!activeSession || event.session_id !== activeSession.sessionId) return;
          if (event.type !== "stream_response") return;
          const response = event.response;
          if (response.type !== "Results") return;

          applyTranscriptResponse(activeSession.transcriptState, response,);
          const transcript = mergeTranscriptText(
            activeSession.existingTranscript,
            getTranscriptText(activeSession.transcriptState, true,),
          );
          const liveCaptionText = response.channel.alternatives[0]?.transcript ?? "";
          setLiveMeetingTranscript(
            createLiveMeetingTranscript(activeSession.pageTitle, transcript, liveCaptionText,),
          );

          try {
            await updateMeetingPage({
              pageTitle: activeSession.pageTitle,
              transcript,
            },);
          } catch (error) {
            console.error(error,);
          }
        },),
      );
      sessionListeners.push(
        await listenToListenerSessionLifecycle(async (event: ListenerSessionLifecycleEvent,) => {
          const activeSession = activeMeetingSessionRef.current;
          if (!activeSession || event.session_id !== activeSession.sessionId) return;
          if (event.type === "active" && event.error) {
            activeSession.failureReason = formatMeetingLifecycleError(event.error,);
            setMeetingRecordingError(activeSession.failureReason,);
            await stopMeetingRecording();
            return;
          }
          if (event.type === "inactive") {
            await finalizeMeetingRecording(new Date().toISOString(), event.error,);
          }
        },),
      );
      sessionListeners.push(
        await listenToListenerSessionError((event,) => {
          const activeSession = activeMeetingSessionRef.current;
          if (!activeSession || event.session_id !== activeSession.sessionId) return;
          const message = formatMeetingSessionError(event,);
          activeSession.failureReason = message;
          console.error("Meeting recording error:", message,);
          if (event.type === "connection_error" || event.is_fatal) {
            setMeetingRecordingError(message,);
            void stopMeetingRecording();
          }
        },),
      );
      sessionListeners.push(
        await listenToListenerSessionProgress(() => undefined),
      );
      meetingListenerUnsubscribersRef.current = sessionListeners;
      await startListenerSession({
        session_id: sessionId,
        languages: sttConfig.spokenLanguages,
        onboarding: speakerOnlyRecording,
        record_enabled: sttConfig.saveRecordings,
        model: sttConfig.model,
        base_url: sttConfig.baseUrl,
        api_key: sttConfig.apiKey,
        keywords: [],
      },);
      const listenerState = await getListenerState().catch(() => "inactive");
      const activeSession = activeMeetingSessionRef.current;
      if (!activeSession || activeSession.sessionId !== sessionId) {
        return;
      }

      if (listenerState !== "active") {
        const message = activeSession.failureReason
          || "Could not start meeting recording. Check microphone permissions and recording provider settings.";
        clearMeetingListeners();
        activeMeetingSessionRef.current = null;
        setIsMeetingRecording(false,);
        setLiveMeetingTranscript(null,);
        setMeetingTranscriptModalOpen(false,);
        setMeetingRecordingError(message,);
        trackEvent("meeting_recording_failed", {
          source: currentView.kind === "page" ? "page" : "home",
          system_audio_only: speakerOnlyRecording,
        },);
        console.error("Could not start meeting recording:", message,);
        return;
      }

      setIsMeetingRecording(true,);
      trackEvent("meeting_recording_started", {
        language_count: sttConfig.spokenLanguages.length,
        save_recordings: sttConfig.saveRecordings,
        source: currentView.kind === "page" ? "page" : "home",
        system_audio_only: speakerOnlyRecording,
      },);
      if (speakerOnlyRecording) {
        setMeetingRecordingError("Microphone access unavailable. Recording system audio only.",);
      }
    } catch (error) {
      clearMeetingListeners();
      activeMeetingSessionRef.current = null;
      setIsMeetingRecording(false,);
      setLiveMeetingTranscript(null,);
      setMeetingTranscriptModalOpen(false,);
      setMeetingRecordingError(error instanceof Error ? error.message : "Could not start meeting recording.",);
      trackEvent("meeting_recording_failed", {
        source: currentView.kind === "page" ? "page" : "home",
        system_audio_only: speakerOnlyRecording,
      },);
      console.error("Could not start meeting recording:", error,);
    }
  }, [
    attachMeetingPageToTodayNote,
    buildMeetingStartPage,
    closeGlobalSearch,
    createMeetingPage,
    currentView.kind,
    currentPageTitle,
    finalizeMeetingRecording,
    getListenerState,
    getMeetingLocationHint,
    isMeetingRecording,
    openPageView,
    persistPageUpdate,
    stopMeetingRecording,
    today,
    updateMeetingPage,
    clearMeetingListeners,
    openSettings,
  ],);

  const openGlobalSearchResult = useCallback(async (result: GlobalSearchResult | undefined,) => {
    if (!result) return;

    closeGlobalSearch();

    if (result.kind === "page") {
      const title = parsePageTitleFromLinkTarget(result.relativePath,) ?? parsePageTitleFromPath(result.path,);
      if (title) {
        trackEvent("search_result_opened", {
          kind: result.kind,
        },);
        openPageView(title,);
        return;
      }
    }

    try {
      const pattern = await getFilenamePattern();
      const date = parseDateFromNoteLinkTarget(result.relativePath, pattern,);
      if (date) {
        trackEvent("search_result_opened", {
          kind: result.kind,
        },);
        navigateToDate(date,);
        return;
      }
    } catch (error) {
      console.error(error,);
    }

    trackEvent("search_result_opened", {
      kind: result.kind,
    },);
    openPath(result.path,).catch(console.error,);
  }, [closeGlobalSearch, navigateToDate, openPageView,],);

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
    const unlistenSettings = listen("open-settings", () => openSettings(),);
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
  }, [openGlobalSearch, toggleLibrary, openSettings,],);

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
          const [journalDir, pagesDir,] = await Promise.all([getJournalDir(), getPagesDir(),],);
          const [dailyResults, pageResults,] = await Promise.all([
            invoke<Omit<GlobalSearchResult, "kind">[]>("search_markdown_files", {
              rootDir: journalDir,
              query,
              limit: 120,
            },),
            invoke<Omit<GlobalSearchResult, "kind">[]>("search_markdown_files", {
              rootDir: pagesDir,
              query,
              limit: 120,
            },),
          ],);
          const results = [
            ...dailyResults.map((result,) => ({ ...result, kind: "daily" as const, })),
            ...pageResults.map((result,) => ({ ...result, kind: "page" as const, })),
          ].slice(0, 120,);
          if (!cancelled) {
            setGlobalSearchResults(results,);
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
    return () => {
      clearMeetingListeners();
      void stopListenerSession().catch(console.error,);
    };
  }, [clearMeetingListeners,],);

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

  useMountEffect(() => {
    let unlisten: UnlistenFn | null = null;

    void listen<string[]>(SYNC_DEEP_LINK_EVENT, (event,) => {
      const urls = Array.isArray(event.payload,) ? event.payload : [];
      urls.forEach((url,) => {
        if (!url.startsWith("philo://sync-auth",)) return;
        void consumeDesktopSyncAuthCallback(url,)
          .then(() => {
            scheduleDesktopSync(0,);
          },)
          .catch(console.error,);
      },);
    },).then((dispose,) => {
      unlisten = dispose;
    },).catch(console.error,);

    return () => {
      void unlisten?.();
    };
  },);

  // Re-read today's note from disk when the window regains focus (handles external edits)
  useEffect(() => {
    if (!isConfigured) return;
    const handleFocus = () => {
      runGoogleSync().finally(() => {
        syncTodayNoteFromDisk();
        setPagesRevision((value,) => value + 1);
        scheduleDesktopSync(0,);
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
      setTodayNote(note,);
      scheduleDesktopSync(0,);
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
        scheduleDesktopSync(0,);
      },).catch(console.error,);
    }, 5 * 60 * 1000,);
    return () => window.clearInterval(id,);
  }, [isConfigured, runGoogleSync, syncTodayNoteFromDisk,],);

  useEffect(() => {
    const note = todayNoteRef.current;
    const nextCity = currentCity.city.trim();
    const timezoneCity = currentCity.timezoneCity.trim();
    if (!note || !nextCity) return;

    const existingCity = note.city?.trim() || "";
    const shouldReplaceTimezoneFallback = Boolean(
      existingCity
        && timezoneCity
        && existingCity === timezoneCity
        && existingCity !== nextCity
        && currentCity.source !== "timezone",
    );

    if (existingCity && !shouldReplaceTimezoneFallback) return;

    const updated = { ...note, city: nextCity, };
    suppressWatcherUntilRef.current = Date.now() + LOCAL_SAVE_WATCH_SUPPRESSION_MS;
    todayNoteRef.current = updated;
    setTodayNote(updated,);
    saveDailyNote(updated,).catch(console.error,);
    scheduleDesktopSync();
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
          scheduleDesktopSync();
        },
        { recursive: true, },
      );
    },).catch(console.error,);

    return () => {
      unwatch?.();
    };
  }, [isConfigured, storageRevision, syncTodayNoteFromDisk,],);

  useEffect(() => {
    if (!isConfigured) return;
    let unwatch: (() => void) | null = null;

    getPagesDir().then(async (pagesDir,) => {
      const watchRoot = await exists(pagesDir,) ? pagesDir : await dirname(pagesDir,);
      unwatch = await watch(
        watchRoot,
        (event,) => {
          if (Date.now() < suppressWatcherUntilRef.current) return;
          if (!event.paths.some((path,) => path.startsWith(pagesDir,) && path.endsWith(".md",))) return;
          setPagesRevision((value,) => value + 1);
          scheduleDesktopSync();
        },
        { recursive: true, },
      );
    },).catch(console.error,);

    return () => {
      unwatch?.();
    };
  }, [isConfigured,],);

  const handleTodaySave = useCallback(
    (note: DailyNote | PageNote,) => {
      if (!("date" in note)) return;
      suppressWatcherUntilRef.current = Date.now() + LOCAL_SAVE_WATCH_SUPPRESSION_MS;
      setTodayNote(note,);
      saveDailyNote(note,).catch(console.error,);
      scheduleDesktopSync();
    },
    [],
  );

  const handlePageSave = useCallback((page: PageNote,) => {
    suppressWatcherUntilRef.current = Date.now() + LOCAL_SAVE_WATCH_SUPPRESSION_MS;
    currentPageRef.current = page;
    setActivePage(page,);
    savePage(page,).catch(console.error,);
    scheduleDesktopSync();
  }, [],);

  const handleTriageTasks = useCallback(() => {
    if (isTaskTriaging) return;

    setIsTaskTriaging(true,);

    try {
      if (currentView.kind === "page") {
        const page = currentPageRef.current ?? activePage;
        if (!page) return;

        const nextContent = sortTasksInNoteContent(page.content,);
        if (!nextContent) return;

        handlePageSave({ ...page, content: nextContent, },);
        trackEvent("tasks_triaged", {
          surface: "page",
        },);
        return;
      }

      const note = todayNoteRef.current ?? todayNote;
      if (!note) return;

      const nextContent = sortTasksInNoteContent(note.content,);
      if (!nextContent) return;

      handleTodaySave({ ...note, content: nextContent, },);
      trackEvent("tasks_triaged", {
        surface: "daily_note",
      },);
    } finally {
      setIsTaskTriaging(false,);
    }
  }, [activePage, currentView.kind, handlePageSave, handleTodaySave, isTaskTriaging, todayNote,],);

  const handlePageRename = useCallback(async (page: PageNote, nextTitle: string,) => {
    const currentTitle = page.title;
    suppressWatcherUntilRef.current = Date.now() + LOCAL_SAVE_WATCH_SUPPRESSION_MS;
    const renamedPage = await renamePage(page, nextTitle,);

    currentPageRef.current = renamedPage;
    setActivePage(renamedPage,);
    setPagesRevision((value,) => value + 1);
    skipNextViewAnimationRef.current = true;
    setViewState((current,) => ({
      ...current,
      history: current.history.map((view,) => (
        view.kind === "page" && view.title === currentTitle
          ? { kind: "page", title: renamedPage.title, }
          : view
      )),
    }));
    setMeetingSummaryTargetTitle((value,) => value === currentTitle ? renamedPage.title : value);
    setLiveMeetingTranscript((value,) => (
      value?.pageTitle === currentTitle
        ? { ...value, pageTitle: renamedPage.title, }
        : value
    ));

    if (activeMeetingSessionRef.current?.pageTitle === currentTitle) {
      activeMeetingSessionRef.current = {
        ...activeMeetingSessionRef.current,
        pageTitle: renamedPage.title,
      };
    }

    if (page.attachedTo && todayNoteRef.current?.date === page.attachedTo) {
      const refreshedTodayNote = await loadDailyNote(page.attachedTo,);
      if (refreshedTodayNote) {
        todayNoteRef.current = refreshedTodayNote;
        setTodayNote(refreshedTodayNote,);
      }
    }

    scheduleDesktopSync();
    return renamedPage;
  }, [],);

  const handleDeletePage = useCallback(async (title: string,) => {
    const normalizedTitle = sanitizePageTitle(title,);
    if (!normalizedTitle) return;
    const displayTitle = getPageDisplayTitle(normalizedTitle,);
    if (!window.confirm(`Delete "${displayTitle}"?`,)) return;

    suppressWatcherUntilRef.current = Date.now() + LOCAL_SAVE_WATCH_SUPPRESSION_MS;
    await deletePage(normalizedTitle,);
    currentPageRef.current = currentPageRef.current?.title === normalizedTitle ? null : currentPageRef.current;
    setActivePage((page,) => page?.title === normalizedTitle ? null : page);
    setPagesRevision((value,) => value + 1);
    setMeetingSummaryTargetTitle((value,) => value === normalizedTitle ? null : value);
    setViewState((current,) => {
      let nextIndex = current.index;
      const history = current.history.filter((view, index,) => {
        const shouldRemove = view.kind === "page" && view.title === normalizedTitle;
        if (shouldRemove && index <= current.index) {
          nextIndex -= 1;
        }
        return !shouldRemove;
      },);

      if (history.length === 0) {
        return { history: [{ kind: "home", },], index: 0, };
      }

      return {
        history,
        index: Math.min(Math.max(nextIndex, 0,), history.length - 1,),
      };
    },);
    scheduleDesktopSync();
    trackEvent("page_deleted", {
      source: "context_menu",
    },);
  }, [],);

  const handleTodayCityChange = useCallback((city: string | null,) => {
    const note = todayNoteRef.current;
    if (!note || note.city === city) return;
    const updated = { ...note, city, };
    suppressWatcherUntilRef.current = Date.now() + LOCAL_SAVE_WATCH_SUPPRESSION_MS;
    setTodayNote(updated,);
    saveDailyNote(updated,).catch(console.error,);
  }, [],);

  const handleCreateAttachedPage = useCallback(async (input?: { open?: boolean; title?: string; },) => {
    const page = input?.title ? await createAttachedPage({ title: input.title, },) : await createUntitledAttachedPage();
    trackEvent("page_created", {
      source: "attached_page",
    },);
    if (input?.open !== false) {
      setPagesRevision((value,) => value + 1);
      openPageView(page.title,);
    }
    return page.title;
  }, [openPageView,],);

  const activePageDoc = useMemo(
    () => activePage ? parseJsonContent(activePage.content,) : null,
    [activePage,],
  );
  const shouldShowMeetingSummaryFab = currentView.kind === "page"
    && !!activePage
    && activePage.type === "meeting"
    && !!activePage.endedAt
    && !activePage.executiveSummary
    && !!activePageDoc
    && hasHeading(activePageDoc, "Transcript",);
  const isMeetingSummaryRunning = !!activePage && meetingSummaryTargetTitle === activePage.title;

  const handleMeetingSummaryFabClick = useCallback(async () => {
    if (!activePage) return;
    if (!hasAiConfigured) {
      openSettings("ai",);
      return;
    }

    try {
      await summarizeMeetingPageNote(activePage,);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not summarize meeting.";
      if (message === "AI is not configured.") {
        setHasAiConfigured(false,);
        openSettings("ai",);
        return;
      }
      setMeetingSummaryError(message,);
    }
  }, [activePage, hasAiConfigured, summarizeMeetingPageNote, openSettings,],);

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
    trackEvent("message_sent", {
      scope: aiScope,
      selected_text: Boolean(aiSelectedText,),
      slash_command: normalizedPrompt.startsWith("/",),
    },);
    const controller = new AbortController();
    aiAbortControllerRef.current = controller;
    setAiPrompt("",);
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
        setAiLatestChatId(entry.id,);
        setAiActiveChatId(entry.id,);
        trackEvent("message_completed", {
          pending_change_count: slashCommandResult.pendingChanges.length,
          slash_command: true,
        },);
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
      setAiLatestChatId(entry.id,);
      setAiActiveChatId(entry.id,);
      trackEvent("message_completed", {
        pending_change_count: result.pendingChanges.length,
        slash_command: false,
      },);
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
      trackEvent("message_failed", {
        aborted: error instanceof DOMException && error.name === "AbortError",
        missing_configuration: error instanceof Error && error.message.startsWith(AI_NOT_CONFIGURED,),
      },);
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
      trackEvent("ai_change_applied",);
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
    trackEvent("ai_change_discarded",);
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

  const {
    handleAiSubmit,
    widgetEditSession,
    widgetEditSubmitting,
  } = useWidgetEditComposer({
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
  },);

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
      scrollRef.current?.scrollTo({ top: targetTop, behavior: "auto", },);
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
        <div className="flex items-center gap-1 pl-16">
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
            <ArrowLeft className="h-4 w-4" strokeWidth={2} />
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
            <ArrowRight className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleTriageTasks}
            disabled={!canTriageTasks || isTaskTriaging}
            className={`flex h-5 w-5 items-center justify-center rounded-md transition-colors ${
              canTriageTasks
                ? "text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                : "text-gray-200"
            }`}
            title="Triage and sort tasks"
            aria-label="Triage and sort tasks"
          >
            {isTaskTriaging
              ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              : <ArrowUpDown className="h-3.5 w-3.5" strokeWidth={2} />}
          </button>

          <button
            type="button"
            onClick={() => {
              void handleMeetingRecordClick();
            }}
            className="-translate-y-px flex h-5 w-5 items-center justify-center"
            title={isMeetingRecording ? "Stop meeting recording" : "Start meeting recording"}
            aria-label={isMeetingRecording ? "Stop meeting recording" : "Start meeting recording"}
          >
            <span
              className={`h-3.5 w-3.5 transition-all ${
                isMeetingRecording
                  ? "rounded-[2px] bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.14)]"
                  : "rounded-full bg-red-500/92 hover:bg-red-500"
              }`}
            />
          </button>

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
            {showMeetingRecordingErrorBanner && (
              <div className="w-full max-w-3xl px-6 pt-4">
                <p
                  className="text-xs text-red-500"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", }}
                >
                  {meetingRecordingError}
                </p>
              </div>
            )}
            {currentView.kind === "page"
              ? (
                <div
                  className="overflow-x-hidden will-change-transform"
                  style={viewTransitionStyle}
                >
                  <PageView
                    title={currentView.title}
                    pagesRevision={pagesRevision}
                    pageOverride={activePage}
                    transcriptReadOnly={isMeetingRecording
                      && activeMeetingPageTitle === currentView.title}
                    transcriptHidden={isMeetingRecording
                      && activeMeetingPageTitle === currentView.title}
                    meetingRecordingError={meetingRecordingError}
                    onOpenDate={scrollToDate}
                    onOpenPage={openPageView}
                    onCreatePage={handleCreateAttachedPage}
                    onAskAiPrompt={openAiComposerWithPrompt}
                    onSave={handlePageSave}
                    onRenameTitle={handlePageRename}
                    onDeletePage={handleDeletePage}
                    onInteract={handleEditorInteract}
                    editorRef={pageEditorRef}
                    onPageChange={handleCurrentPageChange}
                  />
                </div>
              )
              : (
                <>
                  <div
                    className="w-full max-w-3xl overflow-x-hidden will-change-transform"
                    style={viewTransitionStyle}
                  >
                    {hasFocusedFutureDate && (
                      <div
                        key={`${focusedFutureDate}-${storageRevision}-${pagesRevision}`}
                        data-note-date={focusedFutureDate}
                      >
                        <LazyNote
                          date={focusedFutureDate}
                          pagesRevision={pagesRevision}
                          onOpenDate={scrollToDate}
                          onOpenPage={openPageView}
                          onDeletePage={handleDeletePage}
                          onCreatePage={handleCreateAttachedPage}
                          onInteract={handleEditorInteract}
                          onChatSelection={openAiComposer}
                          onSelectionChange={handleAiSelectionChange}
                          onSelectionBlur={handleAiSelectionBlur}
                          persistentSelectionRange={aiSelectionHighlight?.noteDate === focusedFutureDate
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
                      {hasFocusedFutureDate && <div className="mx-6 border-t border-gray-200 dark:border-gray-700" />}
                      <div className={`px-6 pb-4 ${hasFocusedFutureDate ? "pt-12" : "pt-6"}`}>
                        <DateHeader
                          date={today}
                          city={todayCity}
                          fallbackCity={fallbackTodayCity}
                          onCityChange={todayNote ? handleTodayCityChange : undefined}
                          onTitleContextMenu={(event,) => {
                            showFinderContextMenu(event, `show-note-in-finder-${today}`, getNotePath(today,),);
                          }}
                        />
                      </div>
                      {todayNote && (
                        <EditableNote
                          ref={todayEditorRef}
                          note={todayNote}
                          onOpenDate={scrollToDate}
                          onOpenPage={openPageView}
                          onDeletePage={handleDeletePage}
                          onSave={handleTodaySave}
                          onCreatePage={handleCreateAttachedPage}
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
                          onDeletePage={handleDeletePage}
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

      {shouldShowMeetingSummaryFab && (
        <button
          type="button"
          onClick={() => {
            void handleMeetingSummaryFabClick();
          }}
          disabled={isMeetingSummaryRunning}
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium uppercase tracking-wide text-white font-sans shadow-lg transition-all ${
            isMeetingSummaryRunning
              ? "cursor-default opacity-80"
              : "cursor-pointer hover:scale-105 active:scale-95"
          }`}
          style={{ background: "linear-gradient(to bottom, #4b5563, #1f2937)", }}
          title={!hasAiConfigured
            ? "Configure AI to summarize this meeting"
            : meetingSummaryError ?? "Summarize this meeting"}
        >
          {isMeetingSummaryRunning ? "Summarizing meeting..." : "Summarize meeting"}
        </button>
      )}

      {isMeetingRecording && (
        <LiveMeetingTranscriptOverlay
          transcript={liveMeetingTranscript}
          open={meetingTranscriptModalOpen}
          onOpen={() => setMeetingTranscriptModalOpen(true,)}
          onClose={() => setMeetingTranscriptModalOpen(false,)}
        />
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
          openSettings("ai",);
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
        initialTab={settingsInitialTab}
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
