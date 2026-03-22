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
import { mergeAttributes, } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { PluginKey, } from "@tiptap/pm/state";
import { ReactRenderer, } from "@tiptap/react";
import type { SuggestionOptions, } from "@tiptap/suggestion";
import { CalendarDays, ChevronDown, FileText, Repeat2, } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, } from "react";
import {
  createDateMention,
  createRecurringMention,
  getMentionChipLabel,
  getMentionChipState,
  getMentionSuggestions,
  type MentionKind,
  type MentionSuggestion,
  renderMentionMarkdown,
} from "../../../../services/mentions";
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

const INITIAL_PAGE_RESULTS = 5;
const PAGE_RESULTS_INCREMENT = 3;

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

const MentionMenu = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent; },) => boolean; },
  { items: MentionSuggestion[]; command: (items: MentionSuggestion[],) => void; referenceDate?: string; }
>(function MentionMenu({ items, command, referenceDate, }, ref,) {
  const [selectedIndex, setSelectedIndex,] = useState(0,);
  const [showDatePicker, setShowDatePicker,] = useState(false,);
  const [selectedDate, setSelectedDate,] = useState(getToday(),);
  const [recurrence, setRecurrence,] = useState("",);
  const [visiblePageCount, setVisiblePageCount,] = useState(INITIAL_PAGE_RESULTS,);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([],);

  useEffect(() => {
    setSelectedIndex(0,);
    setVisiblePageCount(INITIAL_PAGE_RESULTS,);
  }, [items,],);

  useEffect(() => {
    setSelectedDate(getToday(),);
  }, [referenceDate,],);

  const renderedItems = useMemo(() => {
    const pageItems = items.filter((item,) => item.group === "page");
    const nonPageItems = items.filter((item,) => item.group !== "page");
    const visiblePages = pageItems.slice(0, visiblePageCount,);
    const hiddenPageCount = Math.max(pageItems.length - visiblePages.length, 0,);

    return [
      ...items.filter((item,) => item.group === "action"),
      ...visiblePages,
      ...(hiddenPageCount > 0
        ? [{
          id: "action_show_more_pages",
          label: "Show more",
          kind: "page" as const,
          group: "page" as const,
          action: "show_more_pages" as const,
        },]
        : []),
      ...nonPageItems.filter((item,) => item.group !== "action"),
    ];
  }, [items, visiblePageCount,],);

  useEffect(() => {
    if (showDatePicker) return;
    itemRefs.current[selectedIndex]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    },);
  }, [renderedItems, selectedIndex, showDatePicker,],);

  const applyCustomDate = () => {
    if (!selectedDate) return;
    const nextItem = recurrence ? createRecurringMention(selectedDate, recurrence,) : createDateMention(selectedDate,);
    command([nextItem,],);
  };

  const handleItemSelect = (item: MentionSuggestion,) => {
    if (item.action === "open_date_picker") {
      setShowDatePicker(true,);
      return;
    }
    if (item.action === "show_more_pages") {
      setVisiblePageCount((current,) => current + PAGE_RESULTS_INCREMENT);
      return;
    }
    command([item,],);
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

      if (renderedItems.length === 0) return false;

      if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter") {
        event.preventDefault();
      }

      if (event.key === "ArrowUp") {
        setSelectedIndex((current,) => (current + renderedItems.length - 1) % renderedItems.length);
        return true;
      }

      if (event.key === "ArrowDown") {
        setSelectedIndex((current,) => (current + 1) % renderedItems.length);
        return true;
      }

      if (event.key === "Enter") {
        const item = renderedItems[selectedIndex];
        if (item) handleItemSelect(item,);
        return true;
      }

      return false;
    },
  }), [showDatePicker, renderedItems, selectedIndex, command, selectedDate, recurrence,],);

  return (
    <div className="mention-menu">
      {!showDatePicker && (
        <div className="mention-menu-items">
          {renderedItems.map((item, index,) => {
            const showDivider = index > 0 && renderedItems[index - 1]?.group !== item.group;
            const Icon = item.action === "show_more_pages"
              ? ChevronDown
              : item.kind === "page"
              ? FileText
              : item.kind === "recurring"
              ? Repeat2
              : CalendarDays;

            return (
              <div key={item.id}>
                {showDivider && <div className="mention-menu-divider" />}
                <button
                  ref={(element,) => {
                    itemRefs.current[index] = element;
                  }}
                  className={`mention-menu-item ${index === selectedIndex ? "is-selected" : ""}`}
                  onClick={() => {
                    handleItemSelect(item,);
                  }}
                  type="button"
                >
                  <Icon className="mention-menu-icon" size={14} />
                  <span className="mention-menu-label">{item.label}</span>
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
              className="mention-date-picker-btn mention-date-picker-btn-muted"
              onClick={() => setShowDatePicker(false,)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="mention-date-picker-btn"
              disabled={!selectedDate}
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

export function buildMentionChipSuggestion(
  referenceDate?: string,
  options?: {
    char?: string;
    pluginKey?: string;
  },
): Omit<SuggestionOptions, "editor"> {
  const triggerChar = options?.char ?? "@";
  const pluginKey = options?.pluginKey ?? "mention-chip-suggestion";

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
          mentionSuggestionChar: triggerChar,
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

  return {
    char: triggerChar,
    allowSpaces: true,
    allowedPrefixes: [" ", "(", "[", "{",],
    pluginKey: new PluginKey(pluginKey,),
    items: ({ query, },) => getMentionSuggestions(query, referenceDate,),
    command: ({ editor, range, props, },) => {
      const item = props as MentionSuggestion;
      insertMentionItems(editor, range, [item,],);
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
          renderer = new ReactRenderer(MentionMenu, {
            props: {
              items: props.items as MentionSuggestion[],
              command: (items: MentionSuggestion[],) => {
                insertMentionItems(props.editor, props.range, items,);
              },
              referenceDate,
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
            items: props.items as MentionSuggestion[],
            command: (items: MentionSuggestion[],) => {
              insertMentionItems(props.editor, props.range, items,);
            },
            referenceDate,
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
}

export const MentionChipExtension = Mention.extend({
  name: "mentionChip",

  addOptions() {
    return {
      HTMLAttributes: {},
      renderText: ({ node, },) =>
        getMentionChipLabel({
          id: String(node.attrs.id ?? "",),
          kind: String(node.attrs.kind ?? "tag",) as MentionKind,
          label: String(node.attrs.label ?? "",),
        },),
      deleteTriggerWithBackspace: true,
      renderHTML: ({ node, options, },) => {
        const chip = {
          id: String(node.attrs.id ?? "",),
          kind: String(node.attrs.kind ?? "tag",) as MentionKind,
          label: String(node.attrs.label ?? "",),
        };
        const dateState = getMentionChipState(chip,);
        const label = getMentionChipLabel(chip,);
        const isInlineChip = chip.kind === "page" || chip.kind === "date";

        return [
          "span",
          mergeAttributes(options.HTMLAttributes, {
            "data-mention-chip": "",
            contenteditable: "false",
            class: [
              "mention-chip",
              `mention-chip-${String(node.attrs.kind ?? "tag",)}`,
              !isInlineChip && dateState === "today" ? "mention-chip-today" : "",
              !isInlineChip && dateState === "overdue" ? "mention-chip-overdue" : "",
            ]
              .filter(Boolean,)
              .join(" ",),
          },),
          ...(isInlineChip
            ? [
              [
                "span",
                {
                  class: `mention-chip-${chip.kind}-icon`,
                  "aria-hidden": "true",
                  contenteditable: "false",
                },
              ],
              ["span", { class: "mention-chip-inline-label", }, label,],
            ]
            : [label,]),
        ];
      },
      suggestions: [],
      suggestion: buildMentionChipSuggestion(),
    };
  },

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (element: Element,) => element.getAttribute("data-id",) ?? "",
        renderHTML: (attributes: { id: string; },) => ({ "data-id": attributes.id, }),
      },
      label: {
        default: "",
        parseHTML: (element: Element,) => element.getAttribute("data-label",) ?? "",
        renderHTML: (attributes: { label: string; },) => ({ "data-label": attributes.label, }),
      },
      kind: {
        default: "tag",
        parseHTML: (element: Element,) => element.getAttribute("data-kind",) ?? "tag",
        renderHTML: (attributes: { kind: string; },) => ({ "data-kind": attributes.kind, }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-mention-chip]", },];
  },

  renderMarkdown(node,) {
    return renderMentionMarkdown({
      id: String(node.attrs?.id ?? "",),
      kind: String(node.attrs?.kind ?? "tag",) as MentionKind,
      label: String(node.attrs?.label ?? "",),
    },);
  },
},);
