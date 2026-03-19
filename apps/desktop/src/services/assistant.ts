import { invoke, } from "@tauri-apps/api/core";
import { stepCountIs, streamText, tool, } from "ai";
import { z, } from "zod";
import { json2md, parseJsonContent, } from "../lib/markdown";
import type { DailyNote, } from "../types/note";
import { getAiSdkModel, } from "./ai-sdk";
import { loadSettings, resolveActiveAiConfig, } from "./settings";

export const AI_NOT_CONFIGURED = "AI_NOT_CONFIGURED";

export type AssistantScope = "today" | "recent";

interface AssistantContext {
  today: DailyNote;
  recentNotes: DailyNote[];
}

export interface AssistantConversationTurn {
  prompt: string;
  answer: string;
  selectedText?: string | null;
  createdAt?: string;
}

interface AssistantRequest {
  prompt: string;
  selectedText?: string | null;
  history?: AssistantConversationTurn[];
  scope: AssistantScope;
  context: AssistantContext;
}

interface RunAssistantOptions {
  signal?: AbortSignal;
  onUpdate?: (result: AssistantResult,) => void;
}

export interface AssistantCitation {
  date: string;
  title: string;
  snippet: string;
}

export interface AssistantPendingChange {
  date: string;
  beforeMarkdown: string;
  afterMarkdown: string;
  unifiedDiff: string;
  cityBefore: string | null;
  cityAfter: string | null;
}

export interface AssistantResult {
  answer: string;
  citations: AssistantCitation[];
  pendingChanges: AssistantPendingChange[];
}

interface ToolCommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

const searchEnvelopeSchema = z.object({
  hits: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/,),
    title: z.string(),
    snippet: z.string(),
    path: z.string(),
  },),),
},);

const noteEnvelopeSchema = z.object({
  note: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/,),
    city: z.string().nullable().optional(),
    markdown: z.string(),
    path: z.string(),
  },),
},);

const pendingChangeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/,),
  beforeMarkdown: z.string(),
  afterMarkdown: z.string(),
  unifiedDiff: z.string(),
  cityBefore: z.string().nullable().optional(),
  cityAfter: z.string().nullable().optional(),
},);

const updateEnvelopeSchema = z.object({
  change: pendingChangeSchema,
},);

const appliedEnvelopeSchema = z.object({
  applied: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/,),
    path: z.string(),
  },),),
},);

const toolUseInputSchema = z.object({
  argv: z.array(z.string(),).min(1,),
  stdin: z.string().optional(),
},);

const safeShellInputSchema = z.object({
  command: z.enum(["ls", "find", "grep", "cat",],),
  args: z.array(z.string(),).default([],),
},);

function getTemporalContext() {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const city = timezone.split("/",).pop()?.replace(/_/g, " ",) ?? "";
  const today = toIsoDate(now,);
  const yesterdayDate = new Date(now,);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1,);
  const tomorrowDate = new Date(now,);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1,);
  const localTime = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  },);

  return {
    today,
    yesterday: toIsoDate(yesterdayDate,),
    tomorrow: toIsoDate(tomorrowDate,),
    localTime,
    timezone,
    city,
  };
}

function toIsoDate(date: Date,) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1,).padStart(2, "0",)}-${
    String(date.getDate(),).padStart(2, "0",)
  }`;
}

function buildSystemPrompt(scope: AssistantScope, temporal: ReturnType<typeof getTemporalContext>,) {
  return `You are Sophia, an AI assistant inside the Philo daily notes app.

You answer questions about daily notes and can prepare note edits via tools.

Current local date context:
- today: ${temporal.today}
- yesterday: ${temporal.yesterday}
- tomorrow: ${temporal.tomorrow}
- local time: ${temporal.localTime}
- timezone: ${temporal.timezone}
- city: ${temporal.city || "unknown"}
- requested scope: ${scope}

Rules:
- Use tools instead of guessing.
- The currently open note is already included in the request as \`openNoteSnapshot\`. Treat it as accessible source material.
- If \`selectedText\` is present in the request, treat it as the user's current focus.
- If \`conversationHistory\` is present in the request, treat it as the current chat thread and answer follow-up questions in that context.
- For information requests, search first and only read the most relevant notes.
- Read at most 5 notes unless the user explicitly names dates.
- Cite note dates in your final answer when making claims.
- Use \`run_philo\` first. Use \`run_safe_shell\` only when \`run_philo\` cannot answer the request.
- Never apply note edits directly. If the user wants a note changed, read it, prepare the full replacement markdown, and call \`run_philo\` with \`note update --dry-run\`.
- Do not call \`note delete\`.
- Daily notes are addressed by ISO date strings.
- If the scope is "today", only work with ${temporal.today} unless the user explicitly asks for another date.
- Do not say you cannot access today's note if \`openNoteSnapshot\` is present.

Your final response should be plain text for the user, concise, and mention any cited note dates.`;
}

function getOpenNoteMarkdown(note: DailyNote,) {
  return trimToolText(json2md(parseJsonContent(note.content,),), 20000,);
}

function buildInitialPrompt(
  request: AssistantRequest,
  temporal: ReturnType<typeof getTemporalContext>,
): string {
  return JSON.stringify(
    {
      prompt: request.prompt,
      selectedText: request.selectedText?.trim() || null,
      conversationHistory: (request.history ?? []).map((turn,) => ({
        prompt: turn.prompt,
        answer: turn.answer,
        selectedText: turn.selectedText?.trim() || null,
        createdAt: turn.createdAt ?? null,
      })),
      scope: request.scope,
      temporalContext: temporal,
      openNoteSnapshot: {
        date: request.context.today.date,
        city: request.context.today.city ?? null,
        markdown: getOpenNoteMarkdown(request.context.today,),
      },
      recentNoteDates: request.context.recentNotes.map((note,) => note.date),
    },
    null,
    2,
  );
}

function toAssistantResult(
  answer: string,
  citations: Map<string, AssistantCitation>,
  pendingChanges: Map<string, AssistantPendingChange>,
): AssistantResult {
  return {
    answer,
    citations: Array.from(citations.values(),),
    pendingChanges: Array.from(pendingChanges.values(),),
  };
}

function getFallbackAnswer(pendingChanges: Map<string, AssistantPendingChange>,) {
  if (pendingChanges.size > 0) {
    return `Prepared ${pendingChanges.size} note change${pendingChanges.size === 1 ? "" : "s"}.`;
  }

  return "Done.";
}

async function runToolWithErrorCapture(
  action: () => Promise<ToolCommandOutput>,
): Promise<ToolCommandOutput> {
  try {
    return await action();
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Tool execution failed.",
    };
  }
}

async function runAssistantStream(
  request: AssistantRequest,
  signal: AbortSignal | undefined,
  onUpdate: ((result: AssistantResult,) => void) | undefined,
): Promise<AssistantResult> {
  const settings = await loadSettings();
  const config = resolveActiveAiConfig(settings,);
  if (!config) {
    throw new Error(`${AI_NOT_CONFIGURED}:${settings.aiProvider}`,);
  }

  const temporal = getTemporalContext();
  const system = buildSystemPrompt(request.scope, temporal,);
  const citations = new Map<string, AssistantCitation>();
  const pendingChanges = new Map<string, AssistantPendingChange>();
  let answer = "";
  const emitUpdate = () => {
    onUpdate?.(toAssistantResult(answer, citations, pendingChanges,),);
  };

  const result = streamText({
    model: getAiSdkModel(config, "assistant",),
    system,
    prompt: buildInitialPrompt(request, temporal,),
    tools: {
      run_philo: tool({
        description:
          "Run the Philo daily-note CLI. argv represents `philo <argv>`. Use this for note search/read/create/update dry-runs.",
        inputSchema: toolUseInputSchema,
        execute: async (input,) => {
          const output = await runToolWithErrorCapture(async () =>
            await executePhiloTool(input, citations, pendingChanges,)
          );
          emitUpdate();
          return {
            code: output.code,
            stdout: trimToolText(output.stdout,),
            stderr: trimToolText(output.stderr,),
          };
        },
      },),
      run_safe_shell: tool({
        description: "Run a read-only shell command inside the journal root. Allowed commands: ls, find, grep, cat.",
        inputSchema: safeShellInputSchema,
        execute: async (input,) => {
          const output = await runToolWithErrorCapture(async () => await executeSafeShellTool(input,));
          return {
            code: output.code,
            stdout: trimToolText(output.stdout,),
            stderr: trimToolText(output.stderr,),
          };
        },
      },),
    },
    stopWhen: stepCountIs(8,),
    abortSignal: signal,
    onStepFinish() {
      emitUpdate();
    },
  },);

  for await (const delta of result.textStream) {
    answer += delta;
    emitUpdate();
  }

  const finalAnswer = answer.trim() || getFallbackAnswer(pendingChanges,);
  if (finalAnswer !== answer) {
    answer = finalAnswer;
    emitUpdate();
  }

  return toAssistantResult(answer, citations, pendingChanges,);
}

function trimToolText(value: string, maxChars = 12000,) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars,)}\n...[truncated]`;
}

function extractNoteTitle(markdown: string, date: string,) {
  const title = markdown
    .split("\n",)
    .map((line,) => line.trim())
    .find((line,) => line.startsWith("#",) && line.replace(/^#+\s*/, "",).trim())
    ?.replace(/^#+\s*/, "",)
    .trim();
  return title || date;
}

function extractNoteSnippet(markdown: string,) {
  const cleaned = markdown
    .replace(/^---[\s\S]*?---\n?/m, "",)
    .replace(/[#>*_`[\]-]/g, " ",)
    .replace(/\s+/g, " ",)
    .trim();
  return cleaned.slice(0, 180,);
}

function addCitation(citations: Map<string, AssistantCitation>, note: z.infer<typeof noteEnvelopeSchema>["note"],) {
  citations.set(note.date, {
    date: note.date,
    title: extractNoteTitle(note.markdown, note.date,),
    snippet: extractNoteSnippet(note.markdown,),
  },);
}

async function executePhiloTool(
  input: z.infer<typeof toolUseInputSchema>,
  citations: Map<string, AssistantCitation>,
  pendingChanges: Map<string, AssistantPendingChange>,
) {
  const output = await invoke<ToolCommandOutput>("run_ai_tool", {
    command: "philo",
    argv: input.argv,
    stdin: input.stdin ?? null,
  },);

  if (output.code === 0) {
    if (input.argv[0] === "note" && input.argv[1] === "read") {
      addCitation(citations, noteEnvelopeSchema.parse(JSON.parse(output.stdout,),).note,);
    } else if (input.argv[0] === "note" && input.argv[1] === "search") {
      searchEnvelopeSchema.parse(JSON.parse(output.stdout,),);
    } else if (input.argv[0] === "note" && input.argv[1] === "update" && input.argv.includes("--dry-run",)) {
      const parsed = updateEnvelopeSchema.parse(JSON.parse(output.stdout,),);
      pendingChanges.set(parsed.change.date, {
        ...parsed.change,
        cityBefore: parsed.change.cityBefore ?? null,
        cityAfter: parsed.change.cityAfter ?? null,
      },);
    }
  }

  return output;
}

async function executeSafeShellTool(input: z.infer<typeof safeShellInputSchema>,) {
  return await invoke<ToolCommandOutput>("run_ai_tool", {
    command: input.command,
    argv: input.args,
    stdin: null,
  },);
}

function throwIfAborted(signal?: AbortSignal,) {
  if (!signal?.aborted) return;
  throw new DOMException("AI request cancelled.", "AbortError",);
}

export async function applyAssistantPendingChanges(
  changes: AssistantPendingChange[],
): Promise<string[]> {
  const appliedDates: string[] = [];

  for (const change of changes) {
    const output = await invoke<ToolCommandOutput>("run_ai_tool", {
      command: "philo",
      argv: ["note", "update", "--date", change.date, "--apply", "--json",],
      stdin: change.afterMarkdown,
    },);

    if (output.code !== 0) {
      throw new Error(output.stderr || `Failed to apply note ${change.date}.`,);
    }

    const parsed = appliedEnvelopeSchema.parse(JSON.parse(output.stdout,),);
    appliedDates.push(...parsed.applied.map((item,) => item.date),);
  }

  return appliedDates;
}

export async function runAssistant(
  request: AssistantRequest,
  options: RunAssistantOptions = {},
): Promise<AssistantResult> {
  throwIfAborted(options.signal,);
  return await runAssistantStream(request, options.signal, options.onUpdate,);
}
