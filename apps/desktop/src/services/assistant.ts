import { invoke, } from "@tauri-apps/api/core";
import { z, } from "zod";
import type { DailyNote, } from "../types/note";
import { getApiKey, } from "./settings";

export const AI_NOT_CONFIGURED = "AI_NOT_CONFIGURED";

export type AssistantScope = "today" | "recent";

interface AssistantContext {
  today: DailyNote;
  recentNotes: DailyNote[];
}

interface AssistantRequest {
  prompt: string;
  scope: AssistantScope;
  context: AssistantContext;
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

type AnthropicContentBlock =
  | { type: "text"; text: string; }
  | { type: "tool_use"; id: string; name: string; input: unknown; };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: Array<
    | AnthropicContentBlock
    | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }
  >;
};

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
- For information requests, search first and only read the most relevant notes.
- Read at most 5 notes unless the user explicitly names dates.
- Cite note dates in your final answer when making claims.
- Use \`run_philo\` first. Use \`run_safe_shell\` only when \`run_philo\` cannot answer the request.
- Never apply note edits directly. If the user wants a note changed, read it, prepare the full replacement markdown, and call \`run_philo\` with \`note update --dry-run\`.
- Do not call \`note delete\`.
- Daily notes are addressed by ISO date strings.
- If the scope is "today", only work with ${temporal.today} unless the user explicitly asks for another date.

Your final response should be plain text for the user, concise, and mention any cited note dates.`;
}

function buildInitialUserMessage(
  request: AssistantRequest,
  temporal: ReturnType<typeof getTemporalContext>,
): AnthropicMessage {
  return {
    role: "user",
    content: [{
      type: "text",
      text: JSON.stringify(
        {
          prompt: request.prompt,
          scope: request.scope,
          temporalContext: temporal,
          todayNote: {
            date: request.context.today.date,
            city: request.context.today.city ?? null,
          },
          recentNoteDates: request.context.recentNotes.map((note,) => note.date),
        },
        null,
        2,
      ),
    },],
  };
}

const tools = [
  {
    name: "run_philo",
    description:
      "Run the Philo daily-note CLI. argv represents `philo <argv>`. Use this for note search/read/create/update dry-runs.",
    input_schema: {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string", }, },
        stdin: { type: "string", },
      },
      required: ["argv",],
    },
  },
  {
    name: "run_safe_shell",
    description: "Run a read-only shell command inside the journal root. Allowed commands: ls, find, grep, cat.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", enum: ["ls", "find", "grep", "cat",], },
        args: { type: "array", items: { type: "string", }, },
      },
      required: ["command",],
    },
  },
] as const;

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

async function callAnthropic(
  apiKey: string,
  system: string,
  messages: AnthropicMessage[],
) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 8192,
      system,
      tool_choice: { type: "auto", },
      tools,
      messages,
    },),
  },);

  if (!response.ok) {
    throw new Error(`Sophia failed (${response.status}): ${await response.text()}`,);
  }

  return await response.json();
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

export async function runAssistant(request: AssistantRequest,): Promise<AssistantResult> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error(AI_NOT_CONFIGURED,);
  }

  const temporal = getTemporalContext();
  const system = buildSystemPrompt(request.scope, temporal,);
  const messages: AnthropicMessage[] = [buildInitialUserMessage(request, temporal,),];
  const citations = new Map<string, AssistantCitation>();
  const pendingChanges = new Map<string, AssistantPendingChange>();

  for (let step = 0; step < 8; step += 1) {
    const data = await callAnthropic(apiKey, system, messages,);
    const content = Array.isArray(data.content,) ? data.content as AnthropicContentBlock[] : [];
    const textBlocks = content.filter((block,): block is Extract<AnthropicContentBlock, { type: "text"; }> =>
      block.type === "text" && Boolean(block.text.trim(),)
    );
    const toolUses = content.filter((block,) => block.type === "tool_use");

    messages.push({
      role: "assistant",
      content,
    },);

    if (toolUses.length === 0) {
      const answer = textBlocks.map((block,) => block.text.trim()).join("\n\n",).trim()
        || (pendingChanges.size > 0
          ? `Prepared ${pendingChanges.size} note change${pendingChanges.size === 1 ? "" : "s"}.`
          : "Done.");
      return {
        answer,
        citations: Array.from(citations.values(),),
        pendingChanges: Array.from(pendingChanges.values(),),
      };
    }

    const toolResults: AnthropicMessage["content"] = [];
    for (const toolUse of toolUses) {
      try {
        let output: ToolCommandOutput;
        if (toolUse.name === "run_philo") {
          output = await executePhiloTool(toolUseInputSchema.parse(toolUse.input,), citations, pendingChanges,);
        } else if (toolUse.name === "run_safe_shell") {
          output = await executeSafeShellTool(safeShellInputSchema.parse(toolUse.input,),);
        } else {
          throw new Error(`Unsupported tool: ${toolUse.name}`,);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(
            {
              code: output.code,
              stdout: trimToolText(output.stdout,),
              stderr: trimToolText(output.stderr,),
            },
            null,
            2,
          ),
          ...(output.code !== 0 ? { is_error: true, } : {}),
        },);
      } catch (error) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(
            {
              code: 1,
              stdout: "",
              stderr: error instanceof Error ? error.message : "Tool execution failed.",
            },
            null,
            2,
          ),
          is_error: true,
        },);
      }
    }

    messages.push({
      role: "user",
      content: toolResults,
    },);
  }

  throw new Error("Sophia exceeded the tool-call limit.",);
}
