import { mergeAttributes, Node, } from "@tiptap/core";
import type { JSONContent, } from "@tiptap/core";
import { ReactNodeViewRenderer, } from "@tiptap/react";
import { getAiConfigurationMessage, isAiKeyMissingError, } from "../../../../services/ai";
import { generateWidgetWithStorage, } from "../../../../services/generate";
import {
  compactWidgetSpec,
  decodeWidgetDataAttr,
  encodeWidgetDataAttr,
  escapeWidgetHtmlAttr,
} from "../../../../services/widget-attrs";
import { createWidgetFile, } from "../../../../services/widget-files";
import { stringifyStorageSchema, } from "../../../../services/widget-storage";
import { getEditorSelectionText, } from "../../selectionText";
import { WidgetView, } from "./WidgetView";

function deriveTitle(prompt: string,): string {
  const firstSentence = prompt.split(/[.!?\n]/,)[0].trim();
  if (!firstSentence) return "Widget";
  if (firstSentence.length <= 40) return firstSentence;
  return `${firstSentence.slice(0, 37,)}...`;
}

export interface WidgetAttributes {
  id: string;
  /** JSON-stringified Spec from json-render, or empty string */
  spec: string;
  file?: string;
  path?: string;
  libraryItemId?: string | null;
  componentId?: string | null;
  storageSchema?: string;
  prompt: string;
  saved: boolean;
  loading: boolean;
  error: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType,> {
    widget: {
      insertWidget: (attrs: Partial<WidgetAttributes> & { prompt: string; },) => ReturnType;
    };
  }
}

function updateWidgetById(editor: import("@tiptap/core").Editor, id: string, attrs: Record<string, unknown>,) {
  const { doc, } = editor.state;
  const tr = editor.state.tr;
  let found = false;

  doc.descendants((node, pos,) => {
    if (found) return false;
    if (node.type.name === "widget" && node.attrs.id === id) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs, },);
      found = true;
      return false;
    }
  },);

  if (found) {
    editor.view.dispatch(tr,);
  }
}

export const WidgetExtension = Node.create({
  name: "widget",
  group: "block",
  atom: true,
  draggable: true,

  renderMarkdown(node: JSONContent,) {
    const attrs = node.attrs || {};
    if (attrs.file) {
      return `![[${String(attrs.file,)}]]\n\n`;
    }

    const parts = ['<div data-widget=""',];
    if (attrs.id) parts.push(` data-id="${escapeWidgetHtmlAttr(String(attrs.id,),)}"`,);
    if (attrs.componentId) {
      parts.push(` data-component-id="${escapeWidgetHtmlAttr(String(attrs.componentId,),)}"`,);
    } else if (attrs.spec) {
      parts.push(` data-spec="${encodeWidgetDataAttr(compactWidgetSpec(String(attrs.spec,),),)}"`,);
    }
    if (attrs.libraryItemId) {
      parts.push(` data-library-item-id="${escapeWidgetHtmlAttr(String(attrs.libraryItemId,),)}"`,);
    }
    if (attrs.storageSchema) {
      parts.push(` data-storage-schema="${encodeWidgetDataAttr(String(attrs.storageSchema,),)}"`,);
    }
    if (attrs.prompt) parts.push(` data-prompt="${encodeWidgetDataAttr(String(attrs.prompt,),)}"`,);
    if (attrs.saved) parts.push(' data-saved="true"',);
    parts.push("></div>",);
    return parts.join("",) + "\n\n";
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el: HTMLElement,) => el.getAttribute("data-id",),
      },
      spec: {
        default: "",
        parseHTML: (el: HTMLElement,) => decodeWidgetDataAttr(el.getAttribute("data-spec",),),
      },
      file: {
        default: "",
        parseHTML: (el: HTMLElement,) => el.getAttribute("data-file",) || "",
      },
      path: {
        default: "",
        parseHTML: (el: HTMLElement,) => el.getAttribute("data-path",) || "",
      },
      componentId: {
        default: null,
        parseHTML: (el: HTMLElement,) => {
          const raw = el.getAttribute("data-component-id",);
          return raw || null;
        },
      },
      libraryItemId: {
        default: null,
        parseHTML: (el: HTMLElement,) => {
          const raw = el.getAttribute("data-library-item-id",) || el.getAttribute("data-component-id",);
          return raw || null;
        },
      },
      storageSchema: {
        default: "",
        parseHTML: (el: HTMLElement,) => decodeWidgetDataAttr(el.getAttribute("data-storage-schema",),),
      },
      prompt: {
        default: "",
        parseHTML: (el: HTMLElement,) => decodeWidgetDataAttr(el.getAttribute("data-prompt",),),
      },
      saved: {
        default: false,
        parseHTML: (el: HTMLElement,) => el.getAttribute("data-saved",) === "true",
      },
      loading: { default: false, rendered: false, },
      error: { default: "", rendered: false, },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-widget]", },];
  },

  renderHTML({ HTMLAttributes, },) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-widget": "",
        "data-id": String(HTMLAttributes.id ?? "",),
        "data-spec": encodeWidgetDataAttr(compactWidgetSpec(String(HTMLAttributes.spec ?? "",),),),
        "data-prompt": encodeWidgetDataAttr(String(HTMLAttributes.prompt ?? "",),),
        "data-file": String(HTMLAttributes.file ?? "",),
        "data-path": String(HTMLAttributes.path ?? "",),
        ...(HTMLAttributes.libraryItemId
          ? { "data-library-item-id": String(HTMLAttributes.libraryItemId,), }
          : {}),
        ...(HTMLAttributes.componentId ? { "data-component-id": String(HTMLAttributes.componentId,), } : {}),
        ...(HTMLAttributes.storageSchema
          ? { "data-storage-schema": encodeWidgetDataAttr(String(HTMLAttributes.storageSchema,),), }
          : {}),
        ...(HTMLAttributes.saved ? { "data-saved": "true", } : {}),
      },),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WidgetView,);
  },

  addCommands() {
    return {
      insertWidget: (attrs,) => ({ commands, },) => {
        return commands.insertContent({
          type: this.name,
          attrs: {
            id: crypto.randomUUID(),
            spec: "",
            file: "",
            path: "",
            storageSchema: "",
            saved: false,
            loading: false,
            error: "",
            ...attrs,
          },
        },);
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-b": () => {
        const selectedText = getEditorSelectionText(this.editor,);
        if (!selectedText.trim()) return false;

        const widgetId = crypto.randomUUID();
        this.editor
          .chain()
          .focus()
          .deleteSelection()
          .insertContent({
            type: "widget",
            attrs: { id: widgetId, prompt: selectedText, spec: "", loading: true, saved: false, error: "", },
          },)
          .run();

        generateWidgetWithStorage(selectedText,)
          .then(async ({ uiSpec, storageSchema, },) => {
            const specString = JSON.stringify(uiSpec,);
            const record = await createWidgetFile({
              title: deriveTitle(selectedText,),
              prompt: selectedText,
              spec: specString,
              storageSchema,
              saved: false,
            },);
            updateWidgetById(this.editor, widgetId, {
              id: record.id,
              file: record.file,
              path: record.path,
              spec: record.spec,
              storageSchema: stringifyStorageSchema(record.storageSchema,),
              loading: false,
            },);
          },)
          .catch((err,) => {
            const msg = err instanceof Error && isAiKeyMissingError(err.message,)
              ? getAiConfigurationMessage(err.message,)
              : err instanceof Error
              ? err.message
              : "Something went wrong.";
            updateWidgetById(this.editor, widgetId, { loading: false, error: msg, },);
          },);

        return true;
      },
    };
  },
},);
