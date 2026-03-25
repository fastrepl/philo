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
import {
  DATE_PICKER_RECURRENCE_OPTIONS,
  type DatePickerRecurrence,
  handleDatePickerKeyDown,
  MiniCalendar,
} from "../date-picker";

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

type MentionMenuProps = {
  items: MentionSuggestion[];
  command: (items: MentionSuggestion[],) => void;
  referenceDate?: string;
};

function MentionMenuBody(
  {
    items,
    command,
    defaultDate,
    forwardedRef,
  }: MentionMenuProps & {
    defaultDate: string;
    forwardedRef: React.ForwardedRef<{ onKeyDown: (props: { event: KeyboardEvent; },) => boolean; }>;
  },
) {
  const [selectedIndex, setSelectedIndex,] = useState(0,);
  const [showDatePicker, setShowDatePicker,] = useState(false,);
  const [selectedDate, setSelectedDate,] = useState(defaultDate,);
  const [recurrence, setRecurrence,] = useState<DatePickerRecurrence>("",);
  const [visiblePageCount, setVisiblePageCount,] = useState(INITIAL_PAGE_RESULTS,);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([],);

  useEffect(() => {
    setSelectedIndex(0,);
    setVisiblePageCount(INITIAL_PAGE_RESULTS,);
  }, [items,],);

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

  useImperativeHandle(forwardedRef, () => ({
    onKeyDown: ({ event, },) => {
      if (showDatePicker) {
        return handleDatePickerKeyDown({
          event,
          selectedDate,
          setSelectedDate,
          recurrence,
          setRecurrence,
          onSubmit: applyCustomDate,
          onClose: () => setShowDatePicker(false,),
        },);
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
              {DATE_PICKER_RECURRENCE_OPTIONS.map((opt,) => (
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
}

const MentionMenu = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent; },) => boolean; },
  MentionMenuProps
>(function MentionMenu(props, ref,) {
  const defaultDate = props.referenceDate?.trim() || getToday();
  return <MentionMenuBody key={defaultDate} {...props} defaultDate={defaultDate} forwardedRef={ref} />;
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
            zIndex: "60",
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
        const inlineDateStateClass = chip.kind === "date" && dateState
          ? `mention-chip-date-state-${dateState.replace(/_/g, "-",)}`
          : "";

        return [
          "span",
          mergeAttributes(options.HTMLAttributes, {
            "data-mention-chip": "",
            contenteditable: "false",
            class: [
              "mention-chip",
              `mention-chip-${String(node.attrs.kind ?? "tag",)}`,
              inlineDateStateClass,
              !isInlineChip && dateState === "today" ? "mention-chip-today" : "",
              !isInlineChip && dateState === "past" ? "mention-chip-overdue" : "",
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
