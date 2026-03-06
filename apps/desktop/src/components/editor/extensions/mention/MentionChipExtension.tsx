import { autoUpdate, computePosition, flip, limitShift, offset, shift, type VirtualElement, } from "@floating-ui/dom";
import Mention from "@tiptap/extension-mention";
import { PluginKey, } from "@tiptap/pm/state";
import { ReactRenderer, } from "@tiptap/react";
import type { SuggestionOptions, } from "@tiptap/suggestion";
import { CalendarDays, Repeat2, } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, } from "react";
import {
  createDateMention,
  createRecurringMention,
  getMentionSuggestions,
  type MentionSuggestion,
} from "../../../../services/mentions";

const MentionMenu = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent; },) => boolean; },
  { items: MentionSuggestion[]; command: (items: MentionSuggestion[],) => void; referenceDate?: string; }
>(function MentionMenu({ items, command, referenceDate, }, ref,) {
  const [selectedIndex, setSelectedIndex,] = useState(0,);
  const [showDatePicker, setShowDatePicker,] = useState(false,);
  const [selectedDate, setSelectedDate,] = useState(referenceDate ?? "",);
  const [isRecurring, setIsRecurring,] = useState(false,);
  const [recurrence, setRecurrence,] = useState("daily",);
  const dateInputRef = useRef<HTMLInputElement>(null,);

  useEffect(() => {
    setSelectedIndex(0,);
  }, [items,],);

  useEffect(() => {
    if (!showDatePicker) return;
    dateInputRef.current?.focus();
  }, [showDatePicker,],);

  useEffect(() => {
    setSelectedDate(referenceDate ?? "",);
  }, [referenceDate,],);

  const applyCustomDate = () => {
    if (!selectedDate) return;
    const nextItems = [createDateMention(selectedDate,),];
    if (isRecurring) {
      nextItems.push(createRecurringMention(recurrence,),);
    }
    command(nextItems,);
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
  }), [showDatePicker, items, selectedIndex, command, selectedDate, isRecurring, recurrence,],);

  return (
    <div className="mention-menu">
      {items.map((item, index,) => {
        const showActionDivider = item.group !== "action" && index > 0 && items[index - 1]?.group === "action";
        const showRecurringDivider = item.group === "recurring" && items[index - 1]?.group !== "recurring";
        const Icon = item.kind === "recurring" ? Repeat2 : CalendarDays;

        return (
          <div key={item.id}>
            {showActionDivider && <div className="mention-menu-divider" />}
            {showRecurringDivider && <div className="mention-menu-divider" />}
            <button
              className={`mention-menu-item ${index === selectedIndex && !showDatePicker ? "is-selected" : ""}`}
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
      {showDatePicker && (
        <div className="mention-date-picker">
          <div className="mention-date-picker-row">
            <input
              ref={dateInputRef}
              className="mention-date-input"
              type="date"
              value={selectedDate}
              onChange={(event,) => setSelectedDate(event.target.value,)}
            />
          </div>
          <label className="mention-date-picker-toggle">
            <input
              checked={isRecurring}
              type="checkbox"
              onChange={(event,) => setIsRecurring(event.target.checked,)}
            />
            <span>Make recurring</span>
          </label>
          {isRecurring && (
            <div className="mention-date-picker-row">
              <select
                className="mention-date-select"
                value={recurrence}
                onChange={(event,) => setRecurrence(event.target.value,)}
              >
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
                <option value="monthly">monthly</option>
              </select>
            </div>
          )}
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
          placement: "bottom-start",
          middleware: [offset(6,), flip(), shift({ limiter: limitShift(), },),],
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
            position: "absolute",
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
      renderText: ({ node, },) => String(node.attrs.label ?? "",),
      deleteTriggerWithBackspace: true,
      renderHTML: ({ node, },) => [
        "span",
        {
          "data-mention-chip": "",
          class: `mention-chip mention-chip-${String(node.attrs.kind ?? "tag",)}`,
        },
        String(node.attrs.label ?? "",),
      ],
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
    const id = String(node.attrs?.id ?? "",);
    const label = String(node.attrs?.label ?? "",);
    if (!id) return "";
    if (!label || label === id) return `[[${id}]]`;
    return `[[${id}|${label}]]`;
  },
},);
