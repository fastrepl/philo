import type { Editor, } from "@tiptap/core";
import { Extension, } from "@tiptap/core";
import { Plugin, PluginKey, } from "@tiptap/pm/state";
import { Decoration, DecorationSet, } from "@tiptap/pm/view";

export interface PersistentSelectionRange {
  from: number;
  to: number;
}

const persistentSelectionHighlightKey = new PluginKey<PersistentSelectionRange | null>("persistentSelectionHighlight",);

export function setPersistentSelectionHighlight(editor: Editor, range: PersistentSelectionRange | null,) {
  const nextRange = range && range.from < range.to ? range : null;
  editor.view.dispatch(
    editor.state.tr
      .setMeta(persistentSelectionHighlightKey, nextRange,)
      .setMeta("addToHistory", false,),
  );
}

export const PersistentSelectionHighlightExtension = Extension.create({
  name: "persistentSelectionHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<PersistentSelectionRange | null>({
        key: persistentSelectionHighlightKey,
        state: {
          init: (): PersistentSelectionRange | null => null,
          apply(tr, value: PersistentSelectionRange | null,) {
            const nextValue = tr.getMeta(persistentSelectionHighlightKey,);
            if (nextValue !== undefined) {
              return nextValue as PersistentSelectionRange | null;
            }
            if (!value) return null;

            const from = tr.mapping.map(value.from, 1,);
            const to = tr.mapping.map(value.to, -1,);
            return from < to ? { from, to, } : null;
          },
        },
        props: {
          decorations(state,) {
            const range = persistentSelectionHighlightKey.getState(state,);
            if (!range) return null;

            return DecorationSet.create(state.doc, [
              Decoration.inline(range.from, range.to, {
                class: "persistent-selection-highlight",
              },),
            ],);
          },
        },
      },),
    ];
  },
},);
