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
import { CalendarDays, Repeat2, } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useState, } from "react";
import {
  createDateMention,
  createRecurringMention,
  getMentionChipLabel,
  getMentionChipState,
  getMentionSuggestions,
  type MentionSuggestion,
  renderMentionMarkdown,
} from "../../../../services/mentions";

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
  const firstDay = (new Date(viewYear, viewMonth, 1,).getDay() + 6) % 7;
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null,);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d,);

  const pad = (n: number,) => String(n,).padStart(2, "0",);
  const toIso = (day: number,) => `${viewYear}-${pad(viewMonth + 1,)}-${pad(day,)}`;

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
        {cells.map((day, i,) => {
          if (day === null) return <span key={i} className="mention-calendar-cell mention-calendar-empty" />;
          const iso = toIso(day,);
          return (
            <button
              key={i}
              className={`mention-calendar-cell${iso === todayStr ? " is-today" : ""}${
                iso === selected ? " is-selected" : ""
              }`}
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
  const [selectedDate, setSelectedDate,] = useState(referenceDate ?? "",);
  const [recurrence, setRecurrence,] = useState("",);

  useEffect(() => {
    setSelectedIndex(0,);
  }, [items,],);

  useEffect(() => {
    setSelectedDate(referenceDate ?? "",);
  }, [referenceDate,],);

  const applyCustomDate = () => {
    if (!selectedDate) return;
    const nextItem = recurrence ? createRecurringMention(selectedDate, recurrence,) : createDateMention(selectedDate,);
    command([nextItem,],);
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
        if (item?.action === "open_date_picker") {
          setShowDatePicker(true,);
          return true;
        }
        if (item) command([item,],);
        return true;
      }

      return false;
    },
  }), [showDatePicker, items, selectedIndex, command, selectedDate, recurrence,],);

  return (
    <div className="mention-menu">
      {!showDatePicker && (
        <div className="mention-menu-items">
          {items.map((item, index,) => {
            const showActionDivider = item.group !== "action" && index > 0 && items[index - 1]?.group === "action";
            const showRecurringDivider = item.group === "recurring" && items[index - 1]?.group !== "recurring";
            const Icon = item.kind === "recurring" ? Repeat2 : CalendarDays;

            return (
              <div key={item.id}>
                {showActionDivider && <div className="mention-menu-divider" />}
                {showRecurringDivider && <div className="mention-menu-divider" />}
                <button
                  className={`mention-menu-item ${index === selectedIndex ? "is-selected" : ""}`}
                  onClick={() => {
                    if (item.action === "open_date_picker") {
                      setShowDatePicker(true,);
                      return;
                    }
                    command([item,],);
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

export function buildMentionChipSuggestion(referenceDate?: string,): Omit<SuggestionOptions, "editor"> {
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

  return {
    char: "@",
    allowSpaces: true,
    allowedPrefixes: [" ", "(", "[", "{",],
    pluginKey: new PluginKey("mention-chip-suggestion",),
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
                elements.floating.style.maxHeight = `${Math.max(availableHeight, 0,)}px`;
                elements.floating.style.maxWidth = `${Math.max(availableWidth, 0,)}px`;
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
          kind: String(node.attrs.kind ?? "tag",) as "date" | "recurring" | "tag",
          label: String(node.attrs.label ?? "",),
        },),
      deleteTriggerWithBackspace: true,
      renderHTML: ({ node, options, },) => {
        const chip = {
          id: String(node.attrs.id ?? "",),
          kind: String(node.attrs.kind ?? "tag",) as "date" | "recurring" | "tag",
          label: String(node.attrs.label ?? "",),
        };
        const dateState = getMentionChipState(chip,);
        const label = getMentionChipLabel(chip,);

        return [
          "span",
          mergeAttributes(options.HTMLAttributes, {
            "data-mention-chip": "",
            class: [
              "mention-chip",
              `mention-chip-${String(node.attrs.kind ?? "tag",)}`,
              dateState === "today" ? "mention-chip-today" : "",
              dateState === "overdue" ? "mention-chip-overdue" : "",
            ]
              .filter(Boolean,)
              .join(" ",),
          },),
          label,
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
      kind: String(node.attrs?.kind ?? "tag",) as "date" | "recurring" | "tag",
      label: String(node.attrs?.label ?? "",),
    },);
  },
},);
