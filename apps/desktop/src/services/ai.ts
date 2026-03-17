import { invoke, } from "@tauri-apps/api/core";
import { type ActiveAiConfig, type AiProvider, getAiProviderLabel, } from "./settings";

export const API_KEY_MISSING = "API_KEY_MISSING";

type AiTextBlock = {
  type: "text";
  text: string;
};

type AiToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type AiContentBlock = AiTextBlock | AiToolUseBlock;

export type AiMessage = {
  role: "user" | "assistant";
  content: Array<
    | AiTextBlock
    | AiToolUseBlock
    | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }
  >;
};

export interface AiToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: readonly string[];
  };
}

type GeminiPart =
  | { text: string; }
  | { functionCall: { name: string; args: unknown; }; }
  | { functionResponse: { name: string; response: { content: string; is_error: boolean; }; }; };

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

interface NativeHttpResponse {
  status: number;
  body: string;
}

type NativeJsonRequest = {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
};

function getModel(provider: AiProvider, purpose: "assistant" | "widget",) {
  switch (provider) {
    case "anthropic":
      return purpose === "assistant" ? "claude-sonnet-4-5" : "claude-opus-4-6";
    case "openai":
      return "gpt-4.1";
    case "google":
      return "gemini-2.0-flash";
    case "openrouter":
      return "openai/gpt-4.1";
  }
}

function getProviderUrl(provider: AiProvider,) {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com/v1/messages";
    case "openai":
      return "https://api.openai.com/v1/chat/completions";
    case "google":
      return null;
    case "openrouter":
      return "https://openrouter.ai/api/v1/chat/completions";
  }
}

export function isAiKeyMissingError(message: string, code: string = API_KEY_MISSING,) {
  return message === code || message.startsWith(`${code}:`,);
}

export function getAiConfigurationMessage(message: string, code: string = API_KEY_MISSING,) {
  if (!isAiKeyMissingError(message, code,)) return message;
  const provider = message.split(":", 2,)[1] as AiProvider | undefined;
  const label = provider ? getAiProviderLabel(provider,) : "AI";
  return `No ${label} API key configured. Add it in Settings (⌘,).`;
}

function getToolNameById(messages: AiMessage[], toolUseId: string,) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const match = message.content.find((block,) => block.type === "tool_use" && block.id === toolUseId);
    if (match && match.type === "tool_use") {
      return match.name;
    }
  }
  return null;
}

function toOpenAiMessages(system: string, messages: AiMessage[],) {
  const result: Array<Record<string, unknown>> = [{
    role: "system",
    content: system,
  },];

  for (const message of messages) {
    if (message.role === "user") {
      const text = message.content
        .filter((block,) => block.type === "text")
        .map((block,) => block.text)
        .join("\n\n",)
        .trim();
      if (text) {
        result.push({
          role: "user",
          content: text,
        },);
      }
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        result.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.content,
        },);
      }
      continue;
    }

    const text = message.content
      .filter((block,) => block.type === "text")
      .map((block,) => block.text)
      .join("\n\n",)
      .trim();
    const toolCalls = message.content
      .filter((block,) => block.type === "tool_use")
      .map((block,) => ({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {},),
        },
      }));

    if (!text && toolCalls.length === 0) continue;

    result.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls, } : {}),
    },);
  }

  return result;
}

function toOpenAiTools(tools: readonly AiToolDefinition[],) {
  return tools.map((tool,) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

function toGeminiSchema(schema: unknown,): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema,)) {
    return schema.map((item,) => toGeminiSchema(item,));
  }

  const record = schema as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, value,] of Object.entries(record,)) {
    if (key === "type" && typeof value === "string") {
      next.type = value.toUpperCase();
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value,)) {
      next.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>,).map(([propertyKey, propertyValue,],) => [
          propertyKey,
          toGeminiSchema(propertyValue,),
        ]),
      );
      continue;
    }
    next[key] = toGeminiSchema(value,);
  }
  return next;
}

function toGeminiContents(messages: AiMessage[],): GeminiContent[] {
  const contents: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          parts.push({ text: block.text, },);
          continue;
        }
        if (block.type === "tool_use") {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input ?? {},
            },
          },);
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts, },);
      }
      continue;
    }

    const textParts: GeminiPart[] = [];
    const toolParts: GeminiPart[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        textParts.push({ text: block.text, },);
        continue;
      }
      if (block.type !== "tool_result") continue;
      const name = getToolNameById(messages, block.tool_use_id,);
      if (!name) continue;
      toolParts.push({
        functionResponse: {
          name,
          response: {
            content: block.content,
            is_error: Boolean(block.is_error,),
          },
        },
      },);
    }
    if (textParts.length > 0) {
      contents.push({ role: "user", parts: textParts, },);
    }
    if (toolParts.length > 0) {
      contents.push({ role: "user", parts: toolParts, },);
    }
  }

  return contents;
}

async function postJson(input: NativeJsonRequest, signal?: AbortSignal,) {
  signal?.throwIfAborted();
  const response = await invoke<NativeHttpResponse>("post_json", { input, },);
  signal?.throwIfAborted();

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Sophia failed (${response.status}): ${response.body}`,);
  }

  return JSON.parse(response.body,) as Record<string, unknown>;
}

async function callAnthropicText(config: ActiveAiConfig, system: string, prompt: string, signal?: AbortSignal,) {
  const data = await postJson({
    url: getProviderUrl("anthropic",)!,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: getModel("anthropic", "widget",),
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: prompt, },],
    },
  }, signal,) as { content?: Array<{ type?: string; text?: string; }>; };
  const content = Array.isArray(data.content,) ? data.content as Array<{ type?: string; text?: string; }> : [];
  return content
    .filter((block,) => block.type === "text" && typeof block.text === "string")
    .map((block,) => block.text)
    .join("\n\n",)
    .trim();
}

async function callOpenAiCompatibleText(config: ActiveAiConfig, system: string, prompt: string, signal?: AbortSignal,) {
  const data = await postJson({
    url: getProviderUrl(config.provider,)!,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      ...(config.provider === "openrouter"
        ? {
          "HTTP-Referer": "https://philo.app",
          "X-Title": "Philo",
        }
        : {}),
    },
    body: {
      model: getModel(config.provider, "widget",),
      messages: [
        { role: "system", content: system, },
        { role: "user", content: prompt, },
      ],
    },
  }, signal,) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string; }>; }; }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content,)) {
    return content
      .map((item,) => item?.text)
      .filter((item,) => typeof item === "string")
      .join("\n\n",)
      .trim();
  }
  return "";
}

async function callGoogleText(config: ActiveAiConfig, system: string, prompt: string, signal?: AbortSignal,) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${
    getModel("google", "widget",)
  }:generateContent?key=${config.apiKey}`;
  const data = await postJson({
    url,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      systemInstruction: {
        parts: [{ text: system, },],
      },
      contents: [{
        role: "user",
        parts: [{ text: prompt, },],
      },],
      generationConfig: {
        responseMimeType: "application/json",
      },
    },
  }, signal,) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; }>; }; }>;
  };
  const parts = data.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts,)) return "";
  return parts
    .map((part,) => part?.text)
    .filter((part,) => typeof part === "string")
    .join("\n\n",)
    .trim();
}

export async function generateAiText(
  config: ActiveAiConfig,
  system: string,
  prompt: string,
  signal?: AbortSignal,
) {
  switch (config.provider) {
    case "anthropic":
      return await callAnthropicText(config, system, prompt, signal,);
    case "openai":
    case "openrouter":
      return await callOpenAiCompatibleText(config, system, prompt, signal,);
    case "google":
      return await callGoogleText(config, system, prompt, signal,);
  }
}

async function callAnthropicTools(
  config: ActiveAiConfig,
  system: string,
  messages: AiMessage[],
  tools: readonly AiToolDefinition[],
  signal?: AbortSignal,
): Promise<AiContentBlock[]> {
  const data = await postJson({
    url: getProviderUrl("anthropic",)!,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: getModel("anthropic", "assistant",),
      max_tokens: 8192,
      system,
      tool_choice: { type: "auto", },
      tools,
      messages,
    },
  }, signal,) as {
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown; }>;
  };
  const content = Array.isArray(data.content,)
    ? data.content as Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown; }>
    : [];
  const blocks: AiContentBlock[] = [];

  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text, },);
      continue;
    }
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input ?? {},
      },);
    }
  }

  return blocks;
}

async function callOpenAiCompatibleTools(
  config: ActiveAiConfig,
  system: string,
  messages: AiMessage[],
  tools: readonly AiToolDefinition[],
  signal?: AbortSignal,
): Promise<AiContentBlock[]> {
  const data = await postJson({
    url: getProviderUrl(config.provider,)!,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      ...(config.provider === "openrouter"
        ? {
          "HTTP-Referer": "https://philo.app",
          "X-Title": "Philo",
        }
        : {}),
    },
    body: {
      model: getModel(config.provider, "assistant",),
      messages: toOpenAiMessages(system, messages,),
      tools: toOpenAiTools(tools,),
      tool_choice: "auto",
    },
  }, signal,) as {
    choices?: Array<{
      message?: {
        content?: string;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string; };
        }>;
      };
    }>;
  };
  const message = data.choices?.[0]?.message;
  if (!message) return [];

  const contentBlocks: AiContentBlock[] = [];
  if (typeof message.content === "string" && message.content.trim()) {
    contentBlocks.push({
      type: "text",
      text: message.content,
    },);
  }

  if (Array.isArray(message.tool_calls,)) {
    for (const toolCall of message.tool_calls) {
      if (toolCall?.type !== "function") continue;
      contentBlocks.push({
        type: "tool_use",
        id: typeof toolCall.id === "string" ? toolCall.id : crypto.randomUUID(),
        name: toolCall.function?.name ?? "unknown",
        input: (() => {
          const rawArguments = toolCall.function?.arguments;
          if (typeof rawArguments !== "string" || !rawArguments.trim()) return {};
          try {
            return JSON.parse(rawArguments,);
          } catch {
            return {};
          }
        })(),
      },);
    }
  }

  return contentBlocks;
}

async function callGoogleTools(
  config: ActiveAiConfig,
  system: string,
  messages: AiMessage[],
  tools: readonly AiToolDefinition[],
  signal?: AbortSignal,
): Promise<AiContentBlock[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${
    getModel("google", "assistant",)
  }:generateContent?key=${config.apiKey}`;
  const data = await postJson({
    url,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      systemInstruction: {
        parts: [{ text: system, },],
      },
      contents: toGeminiContents(messages,),
      tools: [{
        functionDeclarations: tools.map((tool,) => ({
          name: tool.name,
          description: tool.description,
          parameters: toGeminiSchema(tool.input_schema,),
        })),
      },],
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
    },
  }, signal,) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown; }; }>; };
    }>;
  };
  const parts = Array.isArray(data.candidates?.[0]?.content?.parts,)
    ? data.candidates[0].content.parts as Array<{ text?: string; functionCall?: { name?: string; args?: unknown; }; }>
    : [];
  const blocks: AiContentBlock[] = [];

  for (const part of parts) {
    if (typeof part.text === "string" && part.text.trim()) {
      blocks.push({ type: "text", text: part.text, },);
      continue;
    }
    if (part.functionCall?.name) {
      blocks.push({
        type: "tool_use",
        id: crypto.randomUUID(),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      },);
    }
  }

  return blocks;
}

export async function runAiToolStep(
  config: ActiveAiConfig,
  system: string,
  messages: AiMessage[],
  tools: readonly AiToolDefinition[],
  signal?: AbortSignal,
) {
  switch (config.provider) {
    case "anthropic":
      return await callAnthropicTools(config, system, messages, tools, signal,);
    case "openai":
    case "openrouter":
      return await callOpenAiCompatibleTools(config, system, messages, tools, signal,);
    case "google":
      return await callGoogleTools(config, system, messages, tools, signal,);
  }
}
