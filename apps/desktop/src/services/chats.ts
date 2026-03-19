import { join, } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readTextFile, writeTextFile, } from "@tauri-apps/plugin-fs";
import type { AssistantCitation, AssistantPendingChange, AssistantResult, AssistantScope, } from "./assistant";
import { getChatsDir, } from "./paths";

const CHAT_FILE_SUFFIX = ".json";
const CHAT_FILE_VERSION = 2;

export interface ChatTurn {
  prompt: string;
  selectedText: string | null;
  answer: string;
  citations: AssistantCitation[];
  pendingChanges: AssistantPendingChange[];
  createdAt: string;
}

export interface ChatHistoryEntry {
  id: string;
  title: string;
  turns: ChatTurn[];
  prompt: string;
  selectedText: string | null;
  scope: AssistantScope;
  answer: string;
  citations: AssistantCitation[];
  pendingChanges: AssistantPendingChange[];
  createdAt: string;
  updatedAt: string;
}

function normalizeTitleSource(value: string,) {
  return value
    .replace(/\s+/g, " ",)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "",)
    .replace(/[.!?]+$/g, "",);
}

function truncateTitle(value: string, maxLength = 60,) {
  if (value.length <= maxLength) return value;
  const truncated = value.slice(0, maxLength - 3,);
  const boundary = truncated.lastIndexOf(" ",);
  const safe = boundary >= 24 ? truncated.slice(0, boundary,) : truncated;
  return `${safe.trim()}...`;
}

function formatTitle(value: string,) {
  const normalized = truncateTitle(normalizeTitleSource(value,),);
  if (!normalized) return "";
  return normalized.replace(/^[a-z]/, (char,) => char.toUpperCase(),);
}

function slugify(value: string,) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-",)
    .replace(/^-+|-+$/g, "",)
    .slice(0, 48,);
}

function buildChatId(title: string, createdAt: string,) {
  const timestamp = createdAt.replace(/[:.]/g, "-",);
  const slug = slugify(title,) || "chat";
  return `${timestamp}-${slug}`;
}

function isCitation(value: unknown,): value is AssistantCitation {
  if (!value || typeof value !== "object") return false;
  return (
    typeof (value as AssistantCitation).date === "string"
    && typeof (value as AssistantCitation).title === "string"
    && typeof (value as AssistantCitation).snippet === "string"
  );
}

function isPendingChange(value: unknown,): value is AssistantPendingChange {
  if (!value || typeof value !== "object") return false;
  const change = value as AssistantPendingChange;
  return (
    typeof change.date === "string"
    && typeof change.beforeMarkdown === "string"
    && typeof change.afterMarkdown === "string"
    && typeof change.unifiedDiff === "string"
    && (change.cityBefore === null || change.cityBefore === undefined || typeof change.cityBefore === "string")
    && (change.cityAfter === null || change.cityAfter === undefined || typeof change.cityAfter === "string")
  );
}

function isChatTurn(value: unknown,): value is ChatTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as ChatTurn;
  return (
    typeof turn.prompt === "string"
    && typeof turn.answer === "string"
    && typeof turn.createdAt === "string"
    && (turn.selectedText === null || turn.selectedText === undefined || typeof turn.selectedText === "string")
    && Array.isArray(turn.citations,)
    && turn.citations.every(isCitation,)
    && Array.isArray(turn.pendingChanges,)
    && turn.pendingChanges.every(isPendingChange,)
  );
}

function getLatestTurn(turns: ChatTurn[],) {
  return turns[turns.length - 1] ?? null;
}

function materializeChatHistoryEntry(input: {
  id: string;
  title: string;
  turns: ChatTurn[];
  scope: AssistantScope;
  createdAt: string;
  updatedAt: string;
},): ChatHistoryEntry | null {
  if (input.turns.length === 0) return null;
  const latestTurn = getLatestTurn(input.turns,);
  if (!latestTurn) return null;

  return {
    id: input.id,
    title: input.title,
    turns: input.turns,
    prompt: latestTurn.prompt,
    selectedText: latestTurn.selectedText,
    scope: input.scope,
    answer: latestTurn.answer,
    citations: latestTurn.citations,
    pendingChanges: latestTurn.pendingChanges,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function parseChatHistoryEntry(raw: string,): ChatHistoryEntry | null {
  try {
    const value = JSON.parse(raw,) as Partial<ChatHistoryEntry> & { version?: number; };
    if (value.version === 1) {
      if (
        typeof value.id !== "string"
        || typeof value.title !== "string"
        || typeof value.prompt !== "string"
        || typeof value.answer !== "string"
        || typeof value.createdAt !== "string"
        || (value.selectedText !== null && value.selectedText !== undefined && typeof value.selectedText !== "string")
        || (value.scope !== "today" && value.scope !== "recent")
        || !Array.isArray(value.citations,)
        || !value.citations.every(isCitation,)
        || !Array.isArray(value.pendingChanges,)
        || !value.pendingChanges.every(isPendingChange,)
      ) {
        return null;
      }

      return materializeChatHistoryEntry({
        id: value.id,
        title: value.title,
        turns: [{
          prompt: value.prompt,
          selectedText: value.selectedText ?? null,
          answer: value.answer,
          citations: value.citations,
          pendingChanges: value.pendingChanges,
          createdAt: value.createdAt,
        },],
        scope: value.scope,
        createdAt: value.createdAt,
        updatedAt: value.createdAt,
      },);
    }

    if (
      value.version !== CHAT_FILE_VERSION
      || typeof value.id !== "string"
      || typeof value.title !== "string"
      || typeof value.createdAt !== "string"
      || typeof value.updatedAt !== "string"
      || (value.scope !== "today" && value.scope !== "recent")
      || !Array.isArray(value.turns,)
      || !value.turns.every(isChatTurn,)
    ) {
      return null;
    }

    return materializeChatHistoryEntry({
      id: value.id,
      title: value.title,
      turns: value.turns,
      scope: value.scope,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    },);
  } catch {
    return null;
  }
}

export function deriveChatTitle(prompt: string, answer?: string | null,) {
  const fromPrompt = formatTitle(prompt,);
  if (fromPrompt) return fromPrompt;
  const fromAnswer = formatTitle(answer ?? "",);
  return fromAnswer || "Untitled chat";
}

export function buildChatHistoryEntry(input: {
  prompt: string;
  selectedText: string | null;
  scope: AssistantScope;
  result: AssistantResult;
  createdAt?: string;
},): ChatHistoryEntry {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const title = deriveChatTitle(input.prompt, input.result.answer,);
  return materializeChatHistoryEntry({
    id: buildChatId(title, createdAt,),
    title,
    turns: [{
      prompt: input.prompt.trim(),
      selectedText: input.selectedText?.trim() || null,
      answer: input.result.answer,
      citations: input.result.citations,
      pendingChanges: input.result.pendingChanges,
      createdAt,
    },],
    scope: input.scope,
    createdAt,
    updatedAt: createdAt,
  },)!;
}

export function appendChatHistoryTurn(entry: ChatHistoryEntry, input: {
  prompt: string;
  selectedText: string | null;
  result: AssistantResult;
  createdAt?: string;
},): ChatHistoryEntry {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return materializeChatHistoryEntry({
    id: entry.id,
    title: entry.title,
    turns: [
      ...entry.turns,
      {
        prompt: input.prompt.trim(),
        selectedText: input.selectedText?.trim() || null,
        answer: input.result.answer,
        citations: input.result.citations,
        pendingChanges: input.result.pendingChanges,
        createdAt,
      },
    ],
    scope: entry.scope,
    createdAt: entry.createdAt,
    updatedAt: createdAt,
  },)!;
}

export function replaceLatestChatHistoryTurnResult(entry: ChatHistoryEntry, result: AssistantResult,) {
  if (entry.turns.length === 0) return entry;
  const lastIndex = entry.turns.length - 1;
  const nextTurns = entry.turns.map((turn, index,) =>
    index === lastIndex
      ? {
        ...turn,
        answer: result.answer,
        citations: result.citations,
        pendingChanges: result.pendingChanges,
      }
      : turn
  );
  return materializeChatHistoryEntry({
    id: entry.id,
    title: entry.title,
    turns: nextTurns,
    scope: entry.scope,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  },)!;
}

export function getLatestChatTurn(entry: ChatHistoryEntry,) {
  return getLatestTurn(entry.turns,);
}

async function ensureChatsDir() {
  const dir = await getChatsDir();
  if (!(await exists(dir,))) {
    await mkdir(dir, { recursive: true, },);
  }
  return dir;
}

async function getChatFilePath(id: string,) {
  const dir = await ensureChatsDir();
  return await join(dir, `${id}${CHAT_FILE_SUFFIX}`,);
}

export async function saveChatHistoryEntry(entry: ChatHistoryEntry,) {
  const path = await getChatFilePath(entry.id,);
  await writeTextFile(
    path,
    JSON.stringify(
      {
        version: CHAT_FILE_VERSION,
        ...entry,
      },
      null,
      2,
    ),
  );
  return entry;
}

export async function loadChatHistory(): Promise<ChatHistoryEntry[]> {
  const dir = await getChatsDir();
  if (!(await exists(dir,))) return [];

  const entries = await readDir(dir,);
  const chats = await Promise.all(
    entries
      .filter((entry,) => entry.isFile && typeof entry.name === "string" && entry.name.endsWith(CHAT_FILE_SUFFIX,))
      .map(async (entry,) => {
        const path = await join(dir, entry.name,);
        try {
          const raw = await readTextFile(path,);
          return parseChatHistoryEntry(raw,);
        } catch {
          return null;
        }
      },),
  );

  return chats
    .filter((entry,): entry is ChatHistoryEntry => entry !== null)
    .sort((left, right,) => right.updatedAt.localeCompare(left.updatedAt,));
}
