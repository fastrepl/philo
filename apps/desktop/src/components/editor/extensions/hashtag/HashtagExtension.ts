import { Extension, } from "@tiptap/core";
import { Plugin, PluginKey, } from "@tiptap/pm/state";
import { Decoration, DecorationSet, } from "@tiptap/pm/view";

const HASHTAG_RE = /(?:#|@)[a-zA-Z]\w*/g;

export const HashtagExtension = Extension.create({
  name: "hashtag",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("hashtag",),
        props: {
          decorations(state,) {
            const decorations: Decoration[] = [];

            state.doc.descendants((node, pos,) => {
              if (!node.isText) return;
              // Skip text inside inline code marks
              if (node.marks.some((m,) => m.type.name === "code")) return;

              const text = node.text ?? "";
              HASHTAG_RE.lastIndex = 0;
              let match;
              while ((match = HASHTAG_RE.exec(text,)) !== null) {
                decorations.push(
                  Decoration.inline(pos + match.index, pos + match.index + match[0].length, {
                    class: "hashtag",
                  },),
                );
              }
            },);

            return DecorationSet.create(state.doc, decorations,);
          },
        },
      },),
    ];
  },
},);
