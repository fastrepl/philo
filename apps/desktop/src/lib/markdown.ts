import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Table, TableCell, TableHeader, TableRow, } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import Underline from "@tiptap/extension-underline";
import { MarkdownManager, } from "@tiptap/markdown";
import type { JSONContent, } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import { ExcalidrawExtension, } from "../components/editor/extensions/excalidraw/ExcalidrawExtension";
import { HashtagExtension, } from "../components/editor/extensions/hashtag/HashtagExtension";
import { MentionChipExtension, } from "../components/editor/extensions/mention/MentionChipExtension";
import { CustomParagraph, } from "../components/editor/extensions/paragraph/ParagraphExtension";
import { CustomTaskItem, } from "../components/editor/extensions/task-item/TaskItemNode";
import { WidgetExtension, } from "../components/editor/extensions/widget/WidgetExtension";

export const EMPTY_DOC: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", },],
};

export function isValidContent(content: unknown,): content is JSONContent {
  if (!content || typeof content !== "object") return false;
  const obj = content as Record<string, unknown>;
  return obj.type === "doc" && Array.isArray(obj.content,);
}

interface MarkdownIndentation {
  style?: "space" | "tab";
  size?: number;
}

interface MarkdownToken {
  type?: string;
  raw?: string;
}

interface MarkdownListItemToken extends MarkdownToken {
  raw?: string;
  task?: boolean;
}

interface MarkdownListToken extends MarkdownToken {
  type: "list";
  items?: MarkdownListItemToken[];
}

function getExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6,], },
      listKeymap: false,
      paragraph: false,
    },),
    CustomParagraph,
    Image.configure({ inline: true, allowBase64: false, },),
    Underline,
    Link.configure({ openOnClick: false, },),
    TaskList,
    CustomTaskItem.configure({ nested: true, },),
    Table.configure({ resizable: true, },),
    TableRow,
    TableHeader,
    TableCell,
    Highlight,
    MentionChipExtension,
    HashtagExtension,
    ExcalidrawExtension,
    WidgetExtension,
    // FileHandler has no markdown relevance, excluded from MarkdownManager
  ];
}

const DEFAULT_INDENTATION = { style: "space", size: 2, } as const;
const markdownManagers = new Map<string, MarkdownManager>();

function normalizeIndentation(indentation?: MarkdownIndentation,): { style: "space" | "tab"; size: number; } {
  const style = indentation?.style === "tab" ? "tab" : DEFAULT_INDENTATION.style;
  const size = typeof indentation?.size === "number" && Number.isFinite(indentation.size,) && indentation.size > 0
    ? Math.floor(indentation.size,)
    : DEFAULT_INDENTATION.size;
  return { style, size, };
}

function getMarkdownManager(indentation?: MarkdownIndentation,): MarkdownManager {
  const normalized = normalizeIndentation(indentation,);
  const key = `${normalized.style}:${normalized.size}`;
  const existing = markdownManagers.get(key,);
  if (existing) return existing;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manager = new MarkdownManager({ extensions: getExtensions() as any, indentation: normalized, },);
  markdownManagers.set(key, manager,);
  return manager;
}

function mergeTopLevelParagraphRuns(json: JSONContent,): JSONContent {
  if (json.type !== "doc" || !Array.isArray(json.content,)) return json;

  const content: JSONContent[] = [];
  let paragraphRun: JSONContent[] = [];

  const flushParagraphRun = () => {
    if (paragraphRun.length === 0) return;
    if (paragraphRun.length === 1) {
      content.push(paragraphRun[0],);
      paragraphRun = [];
      return;
    }

    const mergedContent: JSONContent[] = [];

    paragraphRun.forEach((node, index,) => {
      if (index > 0) {
        mergedContent.push({ type: "text", text: "\n", },);
      }

      if (Array.isArray(node.content,) && node.content.length > 0) {
        mergedContent.push(...node.content,);
      }
    },);

    const lastParagraph = paragraphRun[paragraphRun.length - 1];
    if (!Array.isArray(lastParagraph.content,) || lastParagraph.content.length === 0) {
      mergedContent.push({ type: "text", text: "\n", },);
    }

    content.push(mergedContent.length > 0 ? { type: "paragraph", content: mergedContent, } : { type: "paragraph", },);
    paragraphRun = [];
  };

  for (const node of json.content) {
    if (node.type === "paragraph") {
      paragraphRun.push(node,);
      continue;
    }

    flushParagraphRun();
    content.push(node,);
  }

  flushParagraphRun();

  return { ...json, content, };
}

function normalizeMarkdownForParsing(markdown: string,): string {
  const lines = markdown.split("\n",);
  let activeFence: string | null = null;

  return lines.map((line,) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/,);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!activeFence) {
        activeFence = marker;
      } else if (marker[0] === activeFence[0] && marker.length >= activeFence.length) {
        activeFence = null;
      }
      return line;
    }

    if (activeFence) {
      return line;
    }

    const leadingWhitespace = line.match(/^[\t ]*/,)?.[0] ?? "";
    const expandedIndentation = leadingWhitespace.replace(/\t/g, "    ",);
    const rest = line.slice(leadingWhitespace.length,);

    if (leadingWhitespace.includes("\t",) && /^\[([ xX])\]\s+/.test(rest,)) {
      return `${expandedIndentation}- ${rest}`;
    }

    return `${expandedIndentation}${rest}`;
  },).join("\n",);
}

function countTrailingNewlines(raw: string,): number {
  return (raw.match(/\n+$/,)?.[0].length) ?? 0;
}

function parseMarkdownContent(raw: string, manager: MarkdownManager,): JSONContent[] {
  const parsed = manager.parse(raw,);
  return isValidContent(parsed,) && parsed.content ? parsed.content : [];
}

function isMixedListToken(token: MarkdownToken,): token is MarkdownListToken {
  if (token.type !== "list") return false;
  if (!Array.isArray((token as MarkdownListToken).items,)) return false;

  const items = (token as MarkdownListToken).items ?? [];
  const hasTask = items.some(item => item.task === true);
  const hasNonTask = items.some(item => item.task !== true);
  return hasTask && hasNonTask;
}

function parseMixedListToken(token: MarkdownListToken, manager: MarkdownManager,): JSONContent[] {
  const groups: string[] = [];
  let currentTaskState: boolean | null = null;
  let currentRaw = "";

  for (const item of token.items ?? []) {
    const itemTaskState = item.task === true;
    const itemRaw = item.raw ?? "";

    if (currentTaskState === null || currentTaskState === itemTaskState) {
      currentTaskState = itemTaskState;
      currentRaw += itemRaw;
      continue;
    }

    if (currentRaw) {
      groups.push(currentRaw,);
    }

    currentTaskState = itemTaskState;
    currentRaw = itemRaw;
  }

  if (currentRaw) {
    groups.push(currentRaw,);
  }

  const content: JSONContent[] = [];

  groups.forEach((groupRaw, index,) => {
    content.push(...parseMarkdownContent(groupRaw, manager,),);

    if (index >= groups.length - 1) {
      return;
    }

    const emptyParagraphCount = Math.max(0, countTrailingNewlines(groupRaw,) - 1,);
    for (let i = 0; i < emptyParagraphCount; i += 1) {
      content.push({ type: "paragraph", },);
    }
  },);

  return content;
}

function parseMarkdownBlocks(markdown: string, manager: MarkdownManager,): JSONContent[] {
  const tokens = manager.instance.lexer(markdown,) as MarkdownToken[];
  const content: JSONContent[] = [];
  let sawContent = false;
  let trailingNewlines = 0;

  const pushEmptyParagraphs = (count: number,) => {
    for (let i = 0; i < count; i += 1) {
      content.push({ type: "paragraph", },);
    }
  };

  for (const token of tokens) {
    const raw = token.raw ?? "";

    if (token.type === "space") {
      const newlineCount: number = (raw.match(/\n/g,) || []).length;
      const separatorNewlines: number = trailingNewlines + newlineCount;
      const emptyParagraphCount: number = sawContent ? Math.max(0, separatorNewlines - 1,) : separatorNewlines;
      pushEmptyParagraphs(emptyParagraphCount,);
      trailingNewlines = 0;
      continue;
    }

    if (!raw.trim()) {
      continue;
    }

    const leadingNewlines: number = (raw.match(/^\n+/,)?.[0].length) ?? 0;
    const separatorNewlines: number = trailingNewlines + leadingNewlines;
    const emptyParagraphCount: number = sawContent ? Math.max(0, separatorNewlines - 1,) : separatorNewlines;
    pushEmptyParagraphs(emptyParagraphCount,);

    const normalizedRaw = raw.replace(/^\n+/, "",).replace(/\n+$/, "",);
    if (!normalizedRaw.trim()) {
      trailingNewlines = (raw.match(/\n+$/,)?.[0].length) ?? 0;
      sawContent = sawContent || emptyParagraphCount > 0;
      continue;
    }

    const parsedContent = isMixedListToken(token,)
      ? parseMixedListToken(token, manager,)
      : parseMarkdownContent(normalizedRaw, manager,);

    if (parsedContent.length > 0) {
      content.push(...parsedContent,);
      sawContent = true;
    }

    trailingNewlines = countTrailingNewlines(raw,);
  }

  const trailingEmptyParagraphCount: number = sawContent ? Math.max(0, trailingNewlines - 1,) : trailingNewlines;
  pushEmptyParagraphs(trailingEmptyParagraphCount,);

  return content;
}

export function md2json(markdown: string, options?: { indentation?: MarkdownIndentation; },): JSONContent {
  try {
    const source = normalizeMarkdownForParsing(markdown.replace(/\r\n?/g, "\n",),);
    const manager = getMarkdownManager(options?.indentation,);
    const content = parseMarkdownBlocks(source, manager,);
    return content.length > 0 ? { type: "doc", content, } : EMPTY_DOC;
  } catch {
    return EMPTY_DOC;
  }
}

export function json2md(json: JSONContent, options?: { indentation?: MarkdownIndentation; },): string {
  try {
    const serialized = getMarkdownManager(options?.indentation,).serialize(mergeTopLevelParagraphRuns(json,),);
    return serialized
      .replace(/\n{4,}/g, (run,) => "\n".repeat(Math.floor(run.length / 2,),),)
      .replace(/^([ \t]*)- $/gm, "$1-",);
  } catch {
    return "";
  }
}

export function parseJsonContent(raw: string | undefined | null,): JSONContent {
  if (typeof raw !== "string" || !raw.trim()) return EMPTY_DOC;
  try {
    const parsed = JSON.parse(raw,);
    return isValidContent(parsed,) ? parsed : EMPTY_DOC;
  } catch {
    return EMPTY_DOC;
  }
}
