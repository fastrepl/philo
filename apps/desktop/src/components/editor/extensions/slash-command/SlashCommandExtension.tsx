import {
  autoUpdate,
  computePosition,
  flip,
  limitShift,
  offset,
  shift,
  size,
  type VirtualElement,
} from "@floating-ui/dom";
import { type Editor, Extension, } from "@tiptap/core";
import { PluginKey, } from "@tiptap/pm/state";
import { ReactRenderer, } from "@tiptap/react";
import Suggestion, { type SuggestionOptions, } from "@tiptap/suggestion";
import {
  CalendarDays,
  Code2,
  FileImage,
  FilePlus2,
  Hash,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Table2,
  Text,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useState, } from "react";
import { resolveAssetUrl, saveImage, } from "../../../../services/images";
import { createDateMention, createRecurringMention, type MentionSuggestion, } from "../../../../services/mentions";
import { getToday, } from "../../../../types/note";

function formatRecurrenceDescriptionDate(date: string,) {
  return new Date(`${date}T00:00:00`,).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  },);
}

function getRecurrenceDescription(date: string, recurrence: string,) {
  if (!recurrence) return null;
  return `Starting from ${formatRecurrenceDescriptionDate(date,)} this will show up on a ${recurrence} basis.`;
}

type SlashCommandSection = "formatting" | "insert" | "media";

interface SlashCommandItem {
  id: string;
  section: SlashCommandSection;
  title: string;
  subtitle: string;
  keywords: string[];
  action:
    | "attach_page"
    | "open_date_picker"
    | "set_paragraph"
    | "heading_1"
    | "heading_2"
    | "heading_3"
    | "bullet_list"
    | "ordered_list"
    | "task_list"
    | "blockquote"
    | "code_block"
    | "divider"
    | "table"
    | "image";
}

function MiniCalendar({ selected, onSelect, }: { selected: string; onSelect: (date: string,) => void; },) {
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1,).padStart(2, "0",)}-${
      String(d.getDate(),).padStart(2, "0",)
    }`;
  })();
  const init = selected ? new Date(`${selected}T00:00:00`,) : new Date();
  const [viewYear, setViewYear,] = useState(init.getFullYear(),);
  const [viewMonth, setViewMonth,] = useState(init.getMonth(),);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0,).getDate();
  const daysInPreviousMonth = new Date(viewYear, viewMonth, 0,).getDate();
  const firstDay = (new Date(viewYear, viewMonth, 1,).getDay() + 6) % 7;
  const cells: { day: number; monthOffset: -1 | 0 | 1; }[] = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({ day: daysInPreviousMonth - i, monthOffset: -1, },);
  }
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, monthOffset: 0, },);
  while (cells.length % 7 !== 0) {
    cells.push({ day: cells.length - (firstDay + daysInMonth) + 1, monthOffset: 1, },);
  }

  const pad = (n: number,) => String(n,).padStart(2, "0",);
  const toIso = (day: number, monthOffset: -1 | 0 | 1,) => {
    const date = new Date(viewYear, viewMonth + monthOffset, day,);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1,)}-${pad(date.getDate(),)}`;
  };

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewYear((y,) => y - 1);
      setViewMonth(11,);
    } else setViewMonth((m,) => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewYear((y,) => y + 1);
      setViewMonth(0,);
    } else setViewMonth((m,) => m + 1);
  };

  const title = new Date(viewYear, viewMonth, 1,).toLocaleDateString("en-US", { month: "long", year: "numeric", },);

  return (
    <div className="mention-calendar">
      <div className="mention-calendar-header">
        <button className="mention-calendar-nav" onClick={prevMonth} type="button">‹</button>
        <span className="mention-calendar-title">{title}</span>
        <button className="mention-calendar-nav" onClick={nextMonth} type="button">›</button>
      </div>
      <div className="mention-calendar-weekdays">
        {["M", "T", "W", "T", "F", "S", "S",].map((d, i,) => (
          <span key={i} className="mention-calendar-weekday">{d}</span>
        ))}
      </div>
      <div className="mention-calendar-grid">
        {cells.map(({ day, monthOffset, }, i,) => {
          const iso = toIso(day, monthOffset,);
          return (
            <button
              key={i}
              className={`mention-calendar-cell${iso === todayStr ? " is-today" : ""}${
                iso === selected ? " is-selected" : ""
              }${monthOffset !== 0 ? " is-outside-month" : ""}`}
              onClick={() => onSelect(iso,)}
              type="button"
            >
              {day}
            </button>
          );
        },)}
      </div>
    </div>
  );
}

const SlashCommandMenu = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent; },) => boolean; },
  {
    items: SlashCommandItem[];
    insertMention: (items: MentionSuggestion[],) => void;
    runCommand: (item: SlashCommandItem,) => void;
  }
>(function SlashCommandMenu({ items, insertMention, runCommand, }, ref,) {
  const [selectedIndex, setSelectedIndex,] = useState(0,);
  const [showDatePicker, setShowDatePicker,] = useState(false,);
  const [selectedDate, setSelectedDate,] = useState(getToday(),);
  const [recurrence, setRecurrence,] = useState("",);

  useEffect(() => {
    setSelectedIndex(0,);
    setShowDatePicker(false,);
  }, [items,],);

  const applyCustomDate = () => {
    if (!selectedDate) return;
    const nextItem = recurrence ? createRecurringMention(selectedDate, recurrence,) : createDateMention(selectedDate,);
    insertMention([nextItem,],);
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event, },) => {
      if (showDatePicker) {
        if (event.key === "Escape") {
          event.preventDefault();
          setShowDatePicker(false,);
          return true;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          applyCustomDate();
          return true;
        }
        return false;
      }

      if (items.length === 0) return false;

      if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter") {
        event.preventDefault();
      }

      if (event.key === "ArrowUp") {
        setSelectedIndex((current,) => (current + items.length - 1) % items.length);
        return true;
      }

      if (event.key === "ArrowDown") {
        setSelectedIndex((current,) => (current + 1) % items.length);
        return true;
      }

      if (event.key === "Enter") {
        const item = items[selectedIndex];
        if (item) {
          if (item.action === "open_date_picker") {
            setShowDatePicker(true,);
          } else {
            runCommand(item,);
          }
          return true;
        }
      }

      return false;
    },
  }), [showDatePicker, items, selectedIndex, selectedDate, recurrence, insertMention, runCommand,],);

  if (!showDatePicker && items.length === 0) {
    return (
      <div className="slash-menu">
        <div className="slash-menu-empty">No matching commands</div>
      </div>
    );
  }

  return (
    <div className="slash-menu">
      {!showDatePicker && (
        <div className="slash-menu-items">
          {items.map((item, index,) => {
            const previous = index > 0 ? items[index - 1] : null;
            const showSection = !previous || previous.section !== item.section;
            const Icon = (() => {
              switch (item.action) {
                case "attach_page":
                  return FilePlus2;
                case "open_date_picker":
                  return CalendarDays;
                case "set_paragraph":
                  return Text;
                case "heading_1":
                case "heading_2":
                case "heading_3":
                  return Hash;
                case "bullet_list":
                  return List;
                case "ordered_list":
                  return ListOrdered;
                case "task_list":
                  return ListTodo;
                case "blockquote":
                  return Quote;
                case "code_block":
                  return Code2;
                case "divider":
                  return Minus;
                case "table":
                  return Table2;
                case "image":
                  return FileImage;
              }
            })();
            const sectionTitle = item.section === "formatting"
              ? "Formatting"
              : item.section === "insert"
              ? "Insert"
              : "Media";

            return (
              <div key={item.id}>
                {showSection && <div className="slash-menu-section">{sectionTitle}</div>}
                <button
                  type="button"
                  onMouseDown={(event,) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    if (item.action === "open_date_picker") {
                      setShowDatePicker(true,);
                      return;
                    }
                    runCommand(item,);
                  }}
                  className={`slash-menu-item ${index === selectedIndex ? "is-selected" : ""}`}
                >
                  <Icon className="slash-menu-icon" size={15} />
                  <span className="slash-menu-copy">
                    <span className="slash-menu-title">{item.title}</span>
                    <span className="slash-menu-subtitle">{item.subtitle}</span>
                  </span>
                </button>
              </div>
            );
          },)}
        </div>
      )}
      {showDatePicker && (
        <div className="mention-date-picker">
          <MiniCalendar selected={selectedDate} onSelect={setSelectedDate} />
          <div className="mention-recurrence">
            <div className="mention-recurrence-label">Repeat</div>
            <div className="mention-recurrence-options">
              {[
                { value: "", label: "None", },
                { value: "daily", label: "Daily", },
                { value: "weekly", label: "Weekly", },
                { value: "monthly", label: "Monthly", },
              ].map((opt,) => (
                <button
                  key={opt.value || "none"}
                  className={`mention-recurrence-option${recurrence === opt.value ? " is-active" : ""}`}
                  onClick={() => setRecurrence(opt.value,)}
                  type="button"
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {recurrence && (
              <div className="mention-recurrence-description">
                {getRecurrenceDescription(selectedDate, recurrence,)}
              </div>
            )}
          </div>
          <div className="mention-date-picker-actions">
            <button
              className="mention-date-picker-btn"
              disabled={!selectedDate}
              onMouseDown={(event,) => {
                event.preventDefault();
              }}
              onClick={applyCustomDate}
              type="button"
            >
              Insert
            </button>
          </div>
        </div>
      )}
    </div>
  );
},);

export const SlashCommandExtension = Extension.create<{
  onAttachPage?: () => void;
}>({
  name: "pageSlashCommand",

  addOptions() {
    return {
      onAttachPage: undefined,
    };
  },

  addProseMirrorPlugins() {
    const pickImage = async (editor: Editor,) => {
      const input = document.createElement("input",);
      input.type = "file";
      input.accept = "image/*";
      input.multiple = false;

      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return;

        (async () => {
          const relativePath = await saveImage(file,);
          const assetUrl = await resolveAssetUrl(relativePath,);
          editor.chain().focus().setImage({ src: assetUrl, alt: file.name, },).run();
        })().catch(console.error,);
      }, { once: true, },);

      input.click();
    };

    const runSlashCommand = (
      editor: Editor,
      range: Parameters<NonNullable<SuggestionOptions["command"]>>[0]["range"],
      item: SlashCommandItem,
    ) => {
      const chain = editor.chain().focus().deleteRange(range,);

      switch (item.action) {
        case "attach_page":
          chain.run();
          this.options.onAttachPage?.();
          break;
        case "set_paragraph":
          chain.clearNodes().run();
          break;
        case "heading_1":
          chain.toggleHeading({ level: 1, },).run();
          break;
        case "heading_2":
          chain.toggleHeading({ level: 2, },).run();
          break;
        case "heading_3":
          chain.toggleHeading({ level: 3, },).run();
          break;
        case "bullet_list":
          chain.toggleBulletList().run();
          break;
        case "ordered_list":
          chain.toggleOrderedList().run();
          break;
        case "task_list":
          chain.toggleTaskList().run();
          break;
        case "blockquote":
          chain.toggleBlockquote().run();
          break;
        case "code_block":
          chain.toggleCodeBlock().run();
          break;
        case "divider":
          chain.setHorizontalRule().run();
          break;
        case "table":
          chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true, },).run();
          break;
        case "image":
          chain.run();
          void pickImage(editor,);
          break;
        case "open_date_picker":
          chain.run();
          break;
      }
    };

    const insertMentionItems = (
      editor: Parameters<NonNullable<SuggestionOptions["command"]>>[0]["editor"],
      range: Parameters<NonNullable<SuggestionOptions["command"]>>[0]["range"],
      items: MentionSuggestion[],
    ) => {
      const content = items.flatMap((item,) => [
        {
          type: "mentionChip",
          attrs: {
            id: item.id,
            label: item.label,
            kind: item.kind,
          },
        },
        { type: "text", text: " ", },
      ]);

      editor
        .chain()
        .focus()
        .insertContentAt(range, content,)
        .run();
    };

    const suggestion: SuggestionOptions<SlashCommandItem> = {
      editor: this.editor,
      char: "/",
      allowedPrefixes: null,
      startOfLine: false,
      pluginKey: new PluginKey("page-slash-command",),
      allow: ({ state, range, },) => {
        if (!state.selection.empty) return false;

        const $from = state.selection.$from;
        if ($from.parent.type.spec.code) return false;

        const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc",);
        const activeText = textBefore.slice(Math.max(0, range.from - $from.start(),),);

        return /(?:^|\s)\/[^\s/]*$/.test(activeText,);
      },
      items: ({ query, },) => {
        const normalizedQuery = query.trim().toLowerCase();
        const items: SlashCommandItem[] = [
          {
            id: "set-paragraph",
            section: "formatting",
            title: "Text",
            subtitle: "Turn this block into plain text",
            keywords: ["text", "paragraph", "plain",],
            action: "set_paragraph",
          },
          {
            id: "heading-1",
            section: "formatting",
            title: "Heading 1",
            subtitle: "Large section heading",
            keywords: ["heading", "h1", "title",],
            action: "heading_1",
          },
          {
            id: "heading-2",
            section: "formatting",
            title: "Heading 2",
            subtitle: "Medium section heading",
            keywords: ["heading", "h2", "subtitle",],
            action: "heading_2",
          },
          {
            id: "heading-3",
            section: "formatting",
            title: "Heading 3",
            subtitle: "Small section heading",
            keywords: ["heading", "h3",],
            action: "heading_3",
          },
          {
            id: "bullet-list",
            section: "formatting",
            title: "Bullet list",
            subtitle: "Start a bulleted list",
            keywords: ["list", "bullet", "unordered",],
            action: "bullet_list",
          },
          {
            id: "ordered-list",
            section: "formatting",
            title: "Numbered list",
            subtitle: "Start an ordered list",
            keywords: ["list", "numbered", "ordered",],
            action: "ordered_list",
          },
          {
            id: "task-list",
            section: "formatting",
            title: "Task list",
            subtitle: "Start a checklist",
            keywords: ["task", "todo", "checklist",],
            action: "task_list",
          },
          {
            id: "blockquote",
            section: "formatting",
            title: "Quote",
            subtitle: "Insert a quoted block",
            keywords: ["quote", "blockquote",],
            action: "blockquote",
          },
          {
            id: "code-block",
            section: "formatting",
            title: "Code block",
            subtitle: "Insert a fenced code block",
            keywords: ["code", "snippet", "pre",],
            action: "code_block",
          },
          {
            id: "insert-date-mention",
            section: "insert",
            title: "Date mention",
            subtitle: "Insert a date or repeating date chip",
            keywords: ["date", "chip", "mention", "deadline", "schedule",],
            action: "open_date_picker",
          },
          {
            id: "divider",
            section: "insert",
            title: "Divider",
            subtitle: "Insert a horizontal rule",
            keywords: ["divider", "rule", "line", "hr",],
            action: "divider",
          },
          {
            id: "table",
            section: "insert",
            title: "Table",
            subtitle: "Insert a 3x3 table",
            keywords: ["table", "grid", "columns", "rows",],
            action: "table",
          },
          {
            id: "image",
            section: "media",
            title: "Image",
            subtitle: "Upload and insert an image",
            keywords: ["image", "photo", "media", "upload",],
            action: "image",
          },
        ];

        if (this.options.onAttachPage) {
          items.unshift({
            id: "attach-page",
            section: "insert",
            title: "Attach page",
            subtitle: "Create a page attached to this daily note",
            keywords: ["page", "attach", "meeting", "note",],
            action: "attach_page",
          },);
        }

        if (!normalizedQuery) return items;
        return items.filter((item,) =>
          item.title.toLowerCase().includes(normalizedQuery,)
          || item.subtitle.toLowerCase().includes(normalizedQuery,)
          || item.keywords.some((keyword,) => keyword.includes(normalizedQuery,))
        );
      },
      command: ({ editor, range, props, },) => {
        const item = props as SlashCommandItem;
        runSlashCommand(editor, range, item,);
      },
      render: () => {
        let renderer: ReactRenderer;
        let cleanup: (() => void) | undefined;
        let floatingEl: HTMLElement;
        let referenceEl: VirtualElement | null = null;

        const update = () => {
          if (!referenceEl) return;
          void computePosition(referenceEl, floatingEl, {
            strategy: "fixed",
            placement: "bottom-start",
            middleware: [
              offset(6,),
              flip({ padding: 8, },),
              shift({ padding: 8, limiter: limitShift(), },),
              size({
                padding: 8,
                apply: ({ availableHeight, availableWidth, elements, },) => {
                  const maxHeight = `${Math.max(availableHeight, 0,)}px`;
                  const maxWidth = `${Math.max(availableWidth, 0,)}px`;
                  elements.floating.style.maxHeight = maxHeight;
                  elements.floating.style.maxWidth = maxWidth;

                  const popoverRoot = elements.floating.firstElementChild;
                  if (popoverRoot instanceof HTMLElement) {
                    popoverRoot.style.maxHeight = maxHeight;
                    popoverRoot.style.maxWidth = maxWidth;
                  }
                },
              },),
            ],
          },).then(({ x, y, },) => {
            Object.assign(floatingEl.style, {
              left: `${x}px`,
              top: `${y}px`,
            },);
          },);
        };

        return {
          onStart: (props,) => {
            renderer = new ReactRenderer(SlashCommandMenu, {
              props: {
                items: props.items as SlashCommandItem[],
                insertMention: (items: MentionSuggestion[],) => {
                  insertMentionItems(props.editor, props.range, items,);
                },
                runCommand: (item: SlashCommandItem,) => {
                  props.command(item,);
                },
              },
              editor: props.editor,
            },);

            floatingEl = renderer.element as HTMLElement;
            Object.assign(floatingEl.style, {
              position: "fixed",
              top: "0",
              left: "0",
              zIndex: "40",
            },);
            document.body.appendChild(floatingEl,);

            if (!props.clientRect) return;

            referenceEl = {
              getBoundingClientRect: () => props.clientRect?.() ?? new DOMRect(),
            };

            cleanup = autoUpdate(referenceEl, floatingEl, update,);
            update();
          },
          onUpdate: (props,) => {
            renderer.updateProps({
              items: props.items as SlashCommandItem[],
              insertMention: (items: MentionSuggestion[],) => {
                insertMentionItems(props.editor, props.range, items,);
              },
              runCommand: (item: SlashCommandItem,) => {
                props.command(item,);
              },
            },);

            if (props.clientRect && referenceEl) {
              referenceEl.getBoundingClientRect = () => props.clientRect?.() ?? new DOMRect();
            }
            update();
          },
          onKeyDown: (props,) => {
            if (props.event.key === "Escape") {
              cleanup?.();
              floatingEl.remove();
              return true;
            }

            return ((renderer.ref as { onKeyDown?: (input: { event: KeyboardEvent; },) => boolean; } | null)
              ?.onKeyDown?.({ event: props.event, },) ?? false);
          },
          onExit: () => {
            cleanup?.();
            floatingEl.remove();
            renderer.destroy();
          },
        };
      },
    };

    return [Suggestion(suggestion,),];
  },
},);
