import { json2md, md2json, parseJsonContent, } from "../lib/markdown";
import { getDaysAgo, getToday, } from "../types/note";
import type { DailyNote, } from "../types/note";
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

/**
 * Recurrence tag pattern.
 * Matches: #daily, @daily, [[recurring_daily]], [[2026-03-08(start date),7(days)]], etc.
 */
const RECURRENCE_TAG = /(?:#|@)(daily|weekly|monthly|(\d+)(days?|weeks?|months?))\b/i;
const RECURRENCE_WIKILINK = /\[\[(?:recurring_)?(daily|weekly|monthly|(\d+)(days?|weeks?|months?))(?:\|[^\]]+)?\]\]/i;
const CANONICAL_RECURRING_WIKILINK = /\[\[(\d{4}-\d{2}-\d{2})\(start date\),\s*(\d+)\((day|days)\)\]\]/i;

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

/**
 * Extract unchecked tasks from markdown content.
 * Preserves indentation so nested task structure survives rollover.
 * Returns the tasks and the content with those tasks removed.
 */
function extractUncheckedTasks(content: string,): { tasks: TaskLine[]; cleaned: string; } {
  const lines = content.split("\n",);
  const tasks: TaskLine[] = [];
  const kept: string[] = [];

  for (const line of lines) {
    const match = line.match(UNCHECKED_TASK,);
    if (match) {
      tasks.push({ indent: match[1], text: match[2], },);
    } else {
      kept.push(line,);
    }
  }

  // Remove trailing empty lines left by task removal
  let cleaned = kept.join("\n",);
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n",).trim();

  return { tasks, cleaned, };
}

/**
 * Extract checked tasks that have a recurrence tag.
 * These stay in the source note (history) — we only read them.
 */
function extractCheckedRecurringTasks(content: string,): string[] {
  const lines = content.split("\n",);
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
  const lines = content.split("\n",);
  const texts = new Set<string>();

  for (const line of lines) {
    const unchecked = line.match(UNCHECKED_TASK,);
    if (unchecked) texts.add(unchecked[2],);

    const checked = line.match(CHECKED_TASK,);
    if (checked) texts.add(checked[2],);
  }

  return texts;
}

function prependTasks(content: string, tasks: TaskLine[],): string {
  if (tasks.length === 0) return content;

  const taskLines = tasks.map((t,) => `${t.indent}- [ ] ${t.text}`).join("\n",);
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
  const taskMap = new Map<string, TaskLine>();
  const modifiedNotes: DailyNote[] = [];

  for (let i = 1; i <= days; i++) {
    const date = getDaysAgo(i,);
    const note = await loadDailyNote(date,);
    if (!note || !note.content.trim()) continue;
    const markdown = json2md(parseJsonContent(note.content,),);
    if (!markdown.trim()) continue;

    const { tasks, cleaned, } = extractUncheckedTasks(markdown,);
    if (tasks.length > 0) {
      tasks.forEach((t,) => {
        if (!taskMap.has(t.text,)) {
          taskMap.set(t.text, t,);
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
      if (nextDue <= today && !taskMap.has(taskText,)) {
        taskMap.set(taskText, { indent: "", text: taskText, },);
      }
    }
  }

  if (taskMap.size === 0) return false;

  await Promise.all(modifiedNotes.map((note,) => saveDailyNote(note,)),);
  const todayNote = await loadDailyNote(today,);
  const todayMarkdown = todayNote ? json2md(parseJsonContent(todayNote.content,),) : "";
  const existingTasks = extractAllTaskTexts(todayMarkdown,);
  const newTasks = [...taskMap.values(),].filter((t,) => !existingTasks.has(t.text,));
  if (newTasks.length === 0) return false;

  const updated = prependTasks(todayMarkdown, newTasks,);
  const updatedJson = JSON.stringify(md2json(updated,),);
  await saveDailyNote({ date: today, content: updatedJson, city: todayNote?.city, },);
  return true;
}
