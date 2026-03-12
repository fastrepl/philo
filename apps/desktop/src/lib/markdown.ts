import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Table, TableCell, TableHeader, TableRow, } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import { MarkdownManager, } from "@tiptap/markdown";
import type { JSONContent, } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import { ExcalidrawExtension, } from "../components/editor/extensions/excalidraw/ExcalidrawExtension";
import { HashtagExtension, } from "../components/editor/extensions/hashtag/HashtagExtension";
import { MentionChipExtension, } from "../components/editor/extensions/mention/MentionChipExtension";
import { CustomParagraph, } from "../components/editor/extensions/paragraph/ParagraphExtension";
import { CustomTaskItem, } from "../components/editor/extensions/task-item/TaskItemNode";
import { UnderlineExtension, } from "../components/editor/extensions/underline/UnderlineExtension";
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
      underline: false,
    },),
    CustomParagraph,
    Image.configure({ inline: true, allowBase64: false, },),
    UnderlineExtension,
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

function isEmptyParagraph(node: JSONContent,): boolean {
  return node.type === "paragraph" && (!Array.isArray(node.content,) || node.content.length === 0);
}

function isListNode(node: JSONContent,): boolean {
  return [
    "bulletList",
    "orderedList",
    "taskList",
  ].includes(node.type as string,);
}

function mergeParagraphNodes(paragraphs: JSONContent[],): JSONContent {
  if (paragraphs.length === 1) {
    return paragraphs[0];
  }

  const mergedContent: JSONContent[] = [];

  paragraphs.forEach((node, index,) => {
    if (index > 0) {
      mergedContent.push({ type: "text", text: "\n", },);
    }

    if (Array.isArray(node.content,) && node.content.length > 0) {
      mergedContent.push(...node.content,);
    }
  },);

  const lastParagraph = paragraphs[paragraphs.length - 1];
  if (isEmptyParagraph(lastParagraph,)) {
    mergedContent.push({ type: "text", text: "\n", },);
  }

  return mergedContent.length > 0 ? { type: "paragraph", content: mergedContent, } : { type: "paragraph", };
}

function serializeBlock(node: JSONContent, manager: MarkdownManager,): string {
  return manager.serialize({ type: "doc", content: [node,], },).replace(/\n+$/, "",);
}

function json2mdContent(json: JSONContent, manager: MarkdownManager,): string {
  if (json.type !== "doc" || !Array.isArray(json.content,)) {
    return serializeBlock(json, manager,);
  }

  const sourceContent = json.content.length >= 2
      && isEmptyParagraph(json.content[0],)
      && isListNode(json.content[1],)
    ? json.content.slice(1,)
    : json.content;

  const parts: string[] = [];
  let pendingEmptyParagraphs = 0;
  let sawContent = false;
  let index = 0;

  const pushBlock = (node: JSONContent,) => {
    const markdown = serializeBlock(node, manager,);
    if (!markdown) return;

    if (!sawContent) {
      if (pendingEmptyParagraphs > 0) {
        parts.push("\n".repeat(pendingEmptyParagraphs,),);
      }
    } else {
      parts.push("\n".repeat(pendingEmptyParagraphs + 1,),);
    }

    parts.push(markdown,);
    sawContent = true;
    pendingEmptyParagraphs = 0;
  };

  while (index < sourceContent.length) {
    const node = sourceContent[index];

    if (node.type !== "paragraph") {
      pushBlock(node,);
      index += 1;
      continue;
    }

    let runEnd = index;
    while (runEnd < sourceContent.length && sourceContent[runEnd].type === "paragraph") {
      runEnd += 1;
    }

    const paragraphRun = sourceContent.slice(index, runEnd,);
    const firstNonEmptyIndex = paragraphRun.findIndex(paragraph => !isEmptyParagraph(paragraph,));

    if (firstNonEmptyIndex === -1) {
      pendingEmptyParagraphs += paragraphRun.length;
      index = runEnd;
      continue;
    }

    let lastNonEmptyIndex = paragraphRun.length - 1;
    while (lastNonEmptyIndex >= 0 && isEmptyParagraph(paragraphRun[lastNonEmptyIndex],)) {
      lastNonEmptyIndex -= 1;
    }

    pendingEmptyParagraphs += firstNonEmptyIndex;

    const contentParagraphs = paragraphRun.slice(firstNonEmptyIndex, lastNonEmptyIndex + 1,);
    pushBlock(mergeParagraphNodes(contentParagraphs,),);

    pendingEmptyParagraphs += paragraphRun.length - lastNonEmptyIndex - 1;
    index = runEnd;
  }

  if (!sawContent) {
    return pendingEmptyParagraphs > 0 ? "\n".repeat(pendingEmptyParagraphs,) : "";
  }

  return pendingEmptyParagraphs > 0
    ? `${parts.join("",)}${"\n".repeat(pendingEmptyParagraphs + 1,)}`
    : parts.join("",);
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

function shouldSplitListToken(token: MarkdownToken,): token is MarkdownListToken {
  if (token.type !== "list") return false;
  if (!Array.isArray((token as MarkdownListToken).items,)) return false;

  const items = (token as MarkdownListToken).items ?? [];
  const hasTask = items.some(item => item.task === true);
  const hasNonTask = items.some(item => item.task !== true);
  if (hasTask && hasNonTask) return true;

  if (items.length === 0) return false;

  let previousTrailingNewlines = countTrailingNewlines(items[0].raw ?? "",);

  for (let index = 1; index < items.length; index += 1) {
    const currentTrailingNewlines = countTrailingNewlines(items[index].raw ?? "",);
    if (previousTrailingNewlines > 1) {
      return true;
    }
    previousTrailingNewlines = currentTrailingNewlines;
  }

  return false;
}

function parseListToken(token: MarkdownListToken, manager: MarkdownManager,): JSONContent[] {
  const groups: string[] = [];
  let currentTaskState: boolean | null = null;
  let currentRaw = "";
  let previousTrailingNewlines = 0;

  for (const item of token.items ?? []) {
    const itemTaskState = item.task === true;
    const itemRaw = item.raw ?? "";
    const currentTrailingNewlines = countTrailingNewlines(itemRaw,);

    if (
      currentRaw
      && (currentTaskState !== itemTaskState || previousTrailingNewlines > 1)
    ) {
      groups.push(currentRaw,);
      currentRaw = "";
    }

    if (currentTaskState === null || currentTaskState === itemTaskState) {
      currentTaskState = itemTaskState;
      currentRaw += itemRaw;
    } else {
      currentTaskState = itemTaskState;
      currentRaw = itemRaw;
    }

    previousTrailingNewlines = currentTrailingNewlines;
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

function getBlockSeparatorParagraphCount(separatorNewlines: number, sawContent: boolean,): number {
  return sawContent ? Math.max(0, separatorNewlines - 1,) : separatorNewlines;
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
      const emptyParagraphCount = getBlockSeparatorParagraphCount(separatorNewlines, sawContent,);
      pushEmptyParagraphs(emptyParagraphCount,);
      trailingNewlines = 0;
      continue;
    }

    if (!raw.trim()) {
      continue;
    }

    const leadingNewlines: number = (raw.match(/^\n+/,)?.[0].length) ?? 0;
    const separatorNewlines: number = trailingNewlines + leadingNewlines;
    const emptyParagraphCount = getBlockSeparatorParagraphCount(separatorNewlines, sawContent,);
    pushEmptyParagraphs(emptyParagraphCount,);

    const normalizedRaw = raw.replace(/^\n+/, "",).replace(/\n+$/, "",);
    if (!normalizedRaw.trim()) {
      trailingNewlines = (raw.match(/\n+$/,)?.[0].length) ?? 0;
      sawContent = sawContent || emptyParagraphCount > 0;
      continue;
    }

    const parsedContent = shouldSplitListToken(token,)
      ? parseListToken(token, manager,)
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
    const serialized = json2mdContent(json, getMarkdownManager(options?.indentation,),);
    return serialized.replace(/^([ \t]*)- $/gm, "$1-",);
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
