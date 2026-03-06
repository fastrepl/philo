import { autoUpdate, computePosition, flip, limitShift, offset, shift, type VirtualElement, } from "@floating-ui/dom";
import Mention from "@tiptap/extension-mention";
import { PluginKey, } from "@tiptap/pm/state";
import { ReactRenderer, } from "@tiptap/react";
import type { SuggestionOptions, } from "@tiptap/suggestion";
import { CalendarDays, Repeat2, } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useState, } from "react";
import { getMentionSuggestions, type MentionSuggestion, } from "../../../../services/mentions";

const MentionMenu = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent; },) => boolean; },
  { items: MentionSuggestion[]; command: (item: MentionSuggestion,) => void; }
>(function MentionMenu({ items, command, }, ref,) {
  const [selectedIndex, setSelectedIndex,] = useState(0,);

  useEffect(() => {
    setSelectedIndex(0,);
  }, [items,],);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event, },) => {
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
        if (item) command(item,);
        return true;
      }

      return false;
    },
  }), [items, selectedIndex, command,],);

  if (items.length === 0) return null;

  let sawRecurring = false;

  return (
    <div className="mention-menu">
      {items.map((item, index,) => {
        const showRecurringDivider = item.group === "recurring" && !sawRecurring;
        if (item.group === "recurring") sawRecurring = true;
        const Icon = item.kind === "recurring" ? Repeat2 : CalendarDays;

        return (
          <div key={item.id}>
            {showRecurringDivider && <div className="mention-menu-divider" />}
            <button
              className={`mention-menu-item ${index === selectedIndex ? "is-selected" : ""}`}
              onClick={() => command(item,)}
              type="button"
            >
              <Icon className="mention-menu-icon" size={14} />
              <span className="mention-menu-label">{item.label}</span>
            </button>
          </div>
        );
      },)}
    </div>
  );
},);

export function buildMentionChipSuggestion(referenceDate?: string,): Omit<SuggestionOptions, "editor"> {
  return {
    char: "@",
    allowSpaces: true,
    pluginKey: new PluginKey("mention-chip-suggestion",),
    items: ({ query, },) => getMentionSuggestions(query, referenceDate,),
    command: ({ editor, range, props, },) => {
      const item = props as MentionSuggestion;
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: "mentionChip",
            attrs: {
              id: item.id,
              label: item.label,
              kind: item.kind,
            },
          },
          { type: "text", text: " ", },
        ],)
        .run();
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
              command: (item: MentionSuggestion,) => props.command(item,),
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
            command: (item: MentionSuggestion,) => props.command(item,),
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
