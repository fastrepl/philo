import type { JSONContent, } from "@tiptap/react";
import { json2md, md2json, parseJsonContent, } from "../lib/markdown";
import { getDaysAgo, getToday, } from "../types/note";
import type { DailyNote, } from "../types/note";
import type { AssistantPendingChange, } from "./assistant";
import { buildUnifiedDiff, } from "./diff";
import { loadDailyNote, saveDailyNote, } from "./storage";

/** Regex matching unchecked task lines: `- [ ] text` or `* [ ] text` */
const UNCHECKED_TASK = /^(\s*)[-*] \[ \] (.+)$/;

/** Regex matching checked task lines: `- [x] text` or `* [x] text` */
const CHECKED_TASK = /^(\s*)[-*] \[x\] (.+)$/i;

/** A task line preserving its original indentation level. */
interface TaskLine {
  indent: string;
  text: string;
}

interface TaskBlock {
  rootText: string;
  lines: TaskLine[];
  hasDueDate: boolean;
}

/**
 * Recurrence tag pattern.
 * Matches: #daily, @daily, [[recurring_daily]], [[2026-03-08(start date),7(days)]], etc.
 */
const RECURRENCE_TAG = /(?:#|@)(daily|weekly|monthly|(\d+)(days?|weeks?|months?))\b/i;
const RECURRENCE_WIKILINK = /\[\[(?:recurring_)?(daily|weekly|monthly|(\d+)(days?|weeks?|months?))(?:\|[^\]]+)?\]\]/i;
const CANONICAL_RECURRING_WIKILINK = /\[\[(\d{4}-\d{2}-\d{2})\(start date\),\s*(\d+)\((day|days)\)\]\]/i;
const DUE_DATE_WIKILINK = /\[\[\d{4}-\d{2}-\d{2}\(due date\)(?:\|[^\]]+)?\]\]/i;
const DUE_DATE_CAPTURE = /\[\[(\d{4}-\d{2}-\d{2})\(due date\)(?:\|[^\]]+)?\]\]/gi;
const GOOGLE_BLOCK_HEADING = "# Google";

function stripManagedGoogleBlock(content: string,) {
  const lines = content.split("\n",);
  const start = lines.findIndex((line,) => line.trim() === GOOGLE_BLOCK_HEADING);
  if (start === -1) return content;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#\s+/.test(lines[index],)) {
      end = index;
      break;
    }
  }

  return [...lines.slice(0, start,), ...lines.slice(end,),].join("\n",).trim();
}

interface Recurrence {
  intervalDays: number;
  tag: string;
  startDate?: string;
}

/** Parse a recurrence tag from task text. Returns null if none found. */
export function parseRecurrence(text: string,): Recurrence | null {
  const canonicalMatch = text.match(CANONICAL_RECURRING_WIKILINK,);
  if (canonicalMatch) {
    return {
      intervalDays: Number(canonicalMatch[2],),
      tag: canonicalMatch[0],
      startDate: canonicalMatch[1],
    };
  }

  const match = text.match(RECURRENCE_TAG,) ?? text.match(RECURRENCE_WIKILINK,);
  if (!match) return null;

  const tag = match[0];
  const keyword = match[1].toLowerCase();

  if (keyword === "daily") return { intervalDays: 1, tag, };
  if (keyword === "weekly") return { intervalDays: 7, tag, };
  if (keyword === "monthly") return { intervalDays: 30, tag, };

  const n = parseInt(match[2], 10,);
  const unit = match[3].toLowerCase();

  if (unit.startsWith("day",)) return { intervalDays: n, tag, };
  if (unit.startsWith("week",)) return { intervalDays: n * 7, tag, };
  if (unit.startsWith("month",)) return { intervalDays: n * 30, tag, };

  return null;
}

/** Format a Date as YYYY-MM-DD in local time. */
function dateToString(d: Date,): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1,).padStart(2, "0",)}-${String(d.getDate(),).padStart(2, "0",)}`;
}

/** Add N days to a YYYY-MM-DD string and return a new YYYY-MM-DD string. */
function addDaysToDate(dateStr: string, days: number,): string {
  const d = new Date(dateStr + "T00:00:00",);
  d.setDate(d.getDate() + days,);
  return dateToString(d,);
}

function nextOccurrenceAfter(startDate: string, intervalDays: number, afterDate: string,): string {
  if (startDate > afterDate) return startDate;

  const start = new Date(startDate + "T00:00:00",).getTime();
  const after = new Date(afterDate + "T00:00:00",).getTime();
  const elapsedDays = Math.floor((after - start) / 86_400_000,);
  const cycles = Math.floor(elapsedDays / intervalDays,) + 1;
  return addDaysToDate(startDate, cycles * intervalDays,);
}

function sortTaskBlocks(taskBlocks: TaskBlock[],): TaskBlock[] {
  const withDueDates = taskBlocks.filter((block,) => block.hasDueDate);
  const withoutDueDates = taskBlocks.filter((block,) => !block.hasDueDate);
  return [...withDueDates, ...withoutDueDates,];
}

function getIndentWidth(indent: string,) {
  return indent.replace(/\t/g, "  ",).length;
}

function getNestedLineCount(block: TaskBlock,) {
  if (block.lines.length <= 1) return 0;
  const rootIndentWidth = getIndentWidth(block.lines[0]?.indent ?? "",);
  return block.lines.filter((line, index,) => index > 0 && getIndentWidth(line.indent,) > rootIndentWidth).length;
}

function shouldReplaceTaskBlock(existing: TaskBlock, candidate: TaskBlock,) {
  const existingNestedLineCount = getNestedLineCount(existing,);
  const candidateNestedLineCount = getNestedLineCount(candidate,);
  if (candidateNestedLineCount !== existingNestedLineCount) {
    return candidateNestedLineCount > existingNestedLineCount;
  }

  if (candidate.lines.length !== existing.lines.length) {
    return candidate.lines.length > existing.lines.length;
  }

  if (candidate.hasDueDate !== existing.hasDueDate) {
    return candidate.hasDueDate;
  }

  return false;
}

function collectNodeText(node: JSONContent | null | undefined,): string {
  if (!node) return "";
  const text = typeof node.text === "string" ? node.text : "";
  if (!Array.isArray(node.content,)) return text;
  return [text, ...node.content.map((child,) => collectNodeText(child,)),].join(" ",).trim();
}

function getEarliestDueDate(text: string,) {
  let earliest: string | null = null;
  for (const match of text.matchAll(DUE_DATE_CAPTURE,)) {
    const dueDate = match[1];
    if (!earliest || dueDate < earliest) {
      earliest = dueDate;
    }
  }
  return earliest;
}

function sortTaskLists(node: JSONContent,): JSONContent {
  const content = Array.isArray(node.content,) ? node.content.map((child,) => sortTaskLists(child,)) : node.content;
  if (node.type !== "taskList" || !Array.isArray(content,)) {
    return content === node.content ? node : { ...node, content, };
  }

  const sortedContent = content
    .map((child, index,) => ({
      child,
      index,
      dueDate: getEarliestDueDate(collectNodeText(child,),),
    }))
    .sort((left, right,) => {
      if (left.dueDate && right.dueDate) {
        if (left.dueDate === right.dueDate) return left.index - right.index;
        return left.dueDate.localeCompare(right.dueDate,);
      }
      if (left.dueDate) return -1;
      if (right.dueDate) return 1;
      return left.index - right.index;
    },)
    .map((item,) => item.child);

  return { ...node, content: sortedContent, };
}

export async function buildSortedTodosPendingChange(note: DailyNote,): Promise<AssistantPendingChange | null> {
  const beforeDoc = parseJsonContent(note.content,);
  const afterDoc = sortTaskLists(beforeDoc,);
  const beforeMarkdown = json2md(beforeDoc,);
  const afterMarkdown = json2md(afterDoc,);

  if (beforeMarkdown.trim() === afterMarkdown.trim()) {
    return null;
  }

  return {
    date: note.date,
    beforeMarkdown,
    afterMarkdown,
    unifiedDiff: await buildUnifiedDiff(beforeMarkdown, afterMarkdown,),
    cityBefore: note.city ?? null,
    cityAfter: note.city ?? null,
  };
}

/**
 * Extract unchecked task blocks from markdown content.
 * Parent tasks keep their nested unchecked descendants so rollover preserves task structure.
 */
function extractUncheckedTaskBlocks(content: string,): { taskBlocks: TaskBlock[]; cleaned: string; } {
  const strippedContent = stripManagedGoogleBlock(content,);
  const lines = strippedContent.split("\n",);
  const taskBlocks: TaskBlock[] = [];
  const movedLineIndexes = new Set<number>();
  const stack: Array<{ indentWidth: number; rootBlockIndex: number | null; isUnchecked: boolean; }> = [];

  for (const [index, line,] of lines.entries()) {
    const uncheckedMatch = line.match(UNCHECKED_TASK,);
    const checkedMatch = uncheckedMatch ? null : line.match(CHECKED_TASK,);
    const match = uncheckedMatch ?? checkedMatch;
    if (!match) continue;

    const indentWidth = getIndentWidth(match[1],);
    while (stack.length > 0 && stack[stack.length - 1].indentWidth >= indentWidth) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (uncheckedMatch) {
      let rootBlockIndex = parent?.isUnchecked ? parent.rootBlockIndex : null;
      if (rootBlockIndex === null) {
        taskBlocks.push({
          rootText: uncheckedMatch[2],
          lines: [],
          hasDueDate: false,
        },);
        rootBlockIndex = taskBlocks.length - 1;
      }

      const block = taskBlocks[rootBlockIndex];
      block.lines.push({ indent: uncheckedMatch[1], text: uncheckedMatch[2], },);
      block.hasDueDate ||= DUE_DATE_WIKILINK.test(uncheckedMatch[2],);
      movedLineIndexes.add(index,);

      stack.push({ indentWidth, rootBlockIndex, isUnchecked: true, },);
      continue;
    }

    stack.push({ indentWidth, rootBlockIndex: null, isUnchecked: false, },);
  }

  // Remove trailing empty lines left by task removal
  let cleaned = lines.filter((_, index,) => !movedLineIndexes.has(index,)).join("\n",);
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n",).trim();

  return { taskBlocks: sortTaskBlocks(taskBlocks,), cleaned, };
}

/**
 * Extract checked tasks that have a recurrence tag.
 * These stay in the source note (history) — we only read them.
 */
function extractCheckedRecurringTasks(content: string,): string[] {
  const lines = stripManagedGoogleBlock(content,).split("\n",);
  const tasks: string[] = [];

  for (const line of lines) {
    const match = line.match(CHECKED_TASK,);
    if (match && parseRecurrence(match[2],)) {
      tasks.push(match[2],);
    }
  }

  return tasks;
}

/**
 * Collect all task texts (checked + unchecked) already present in content.
 * Used for deduplication.
 */
function extractAllTaskTexts(content: string,): Set<string> {
  const lines = stripManagedGoogleBlock(content,).split("\n",);
  const texts = new Set<string>();

  for (const line of lines) {
    const unchecked = line.match(UNCHECKED_TASK,);
    if (unchecked) texts.add(unchecked[2],);

    const checked = line.match(CHECKED_TASK,);
    if (checked) texts.add(checked[2],);
  }

  return texts;
}

function prependTaskBlocks(content: string, taskBlocks: TaskBlock[],): string {
  if (taskBlocks.length === 0) return content;

  const taskLines = taskBlocks.flatMap((block,) => block.lines.map((line,) => `${line.indent}- [ ] ${line.text}`)).join(
    "\n",
  );
  const trimmed = content.trim();
  if (!trimmed) return `\n\n\n${taskLines}`;
  return `${taskLines}\n\n${trimmed}`;
}

/**
 * Roll over unchecked tasks from past notes to today.
 * Also re-creates recurring tasks (e.g. @daily, #weekly, [[2026-03-08(start date),7(days)]])
 * when they were checked off and enough time has passed.
 *
 * Returns true if any tasks were rolled over.
 */
export async function rolloverTasks(days: number = 30,): Promise<boolean> {
  const today = getToday();
  const taskBlockMap = new Map<string, TaskBlock>();
  const modifiedNotes: DailyNote[] = [];

  for (let i = 1; i <= days; i++) {
    const date = getDaysAgo(i,);
    const note = await loadDailyNote(date,);
    if (!note || !note.content.trim()) continue;
    const markdown = json2md(parseJsonContent(note.content,),);
    if (!markdown.trim()) continue;

    const { taskBlocks, cleaned, } = extractUncheckedTaskBlocks(markdown,);
    if (taskBlocks.length > 0) {
      taskBlocks.forEach((block,) => {
        const existingBlock = taskBlockMap.get(block.rootText,);
        if (!existingBlock || shouldReplaceTaskBlock(existingBlock, block,)) {
          taskBlockMap.set(block.rootText, block,);
        }
      },);
      modifiedNotes.push({ ...note, content: JSON.stringify(md2json(cleaned,),), },);
    }

    const checkedRecurring = extractCheckedRecurringTasks(markdown,);
    for (const taskText of checkedRecurring) {
      const recurrence = parseRecurrence(taskText,)!;
      const nextDue = recurrence.startDate
        ? nextOccurrenceAfter(recurrence.startDate, recurrence.intervalDays, date,)
        : addDaysToDate(date, recurrence.intervalDays,);
      if (nextDue <= today && !taskBlockMap.has(taskText,)) {
        taskBlockMap.set(taskText, {
          rootText: taskText,
          lines: [{ indent: "", text: taskText, },],
          hasDueDate: DUE_DATE_WIKILINK.test(taskText,),
        },);
      }
    }
  }

  if (taskBlockMap.size === 0) return false;

  await Promise.all(modifiedNotes.map((note,) => saveDailyNote(note,)),);
  const todayNote = await loadDailyNote(today,);
  const todayMarkdown = todayNote ? json2md(parseJsonContent(todayNote.content,),) : "";
  const existingTasks = extractAllTaskTexts(todayMarkdown,);
  const newTaskBlocks = sortTaskBlocks(
    [...taskBlockMap.values(),].filter((block,) => !existingTasks.has(block.rootText,)),
  );
  if (newTaskBlocks.length === 0) return false;

  const updated = prependTaskBlocks(todayMarkdown, newTaskBlocks,);
  const updatedJson = JSON.stringify(md2json(updated,),);
  await saveDailyNote({ date: today, content: updatedJson, city: todayNote?.city, },);
  return true;
}
