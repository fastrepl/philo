import { isNodeActive, } from "@tiptap/core";
import { ListKeymap, } from "@tiptap/extension-list-keymap";
import { canJoin, } from "@tiptap/pm/transform";

export const CustomListKeymap = ListKeymap.extend({
  addKeyboardShortcuts() {
    const originalShortcuts = this.parent?.() ?? {};

    const getListItemType = () => {
      const state = this.editor.state;
      const taskItemType = this.editor.schema.nodes.taskItem;
      const listItemType = this.editor.schema.nodes.listItem;

      if (taskItemType && isNodeActive(state, taskItemType.name,)) return taskItemType;
      if (listItemType && isNodeActive(state, listItemType.name,)) return listItemType;
      return listItemType ?? taskItemType ?? null;
    };

    const tryJoinLists = (editor: typeof this.editor,): boolean => {
      const { state, } = editor;
      const { selection, doc, schema, } = state;
      const { $from, } = selection;

      if (!selection.empty || $from.parentOffset !== 0) return false;

      const orderedListType = schema.nodes.orderedList;
      const bulletListType = schema.nodes.bulletList;
      const taskListType = schema.nodes.taskList;
      if (!orderedListType && !bulletListType && !taskListType) return false;

      const isListType = (type: typeof orderedListType,) =>
        type === orderedListType || type === bulletListType || type === taskListType;

      const currentNode = $from.parent;
      const isEmptyParagraph = currentNode.type === schema.nodes.paragraph
        && currentNode.content.size === 0;

      if (isEmptyParagraph) {
        const posBefore = $from.before();
        const posAfter = $from.after();
        const $pos = doc.resolve(posBefore,);
        const nodeBefore = $pos.nodeBefore;
        const $posAfter = doc.resolve(posAfter,);
        const nodeAfter = $posAfter.nodeAfter;

        if (!nodeBefore || !nodeAfter) return false;

        if (isListType(nodeBefore.type,) && nodeBefore.type === nodeAfter.type) {
          const joinPos = posBefore;
          editor
            .chain()
            .focus()
            .command(({ tr, },) => {
              tr.delete(posBefore, posAfter,);
              if (canJoin(tr.doc, joinPos,)) tr.join(joinPos,);
              return true;
            },)
            .run();
          return true;
        }
      }

      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth,);
        if (!isListType(node.type,)) continue;

        const indexInParent = $from.index(depth - 1,);
        if (indexInParent === 0) continue;

        const posBeforeList = $from.before(depth,);
        const nodeBefore = doc.resolve(posBeforeList,).nodeBefore;

        if (nodeBefore && nodeBefore.type === node.type) {
          if (canJoin(doc, posBeforeList,)) {
            editor
              .chain()
              .focus()
              .command(({ tr, },) => {
                tr.join(posBeforeList,);
                return true;
              },)
              .run();
            return true;
          }
        }
        break;
      }

      return false;
    };

    return {
      ...originalShortcuts,

      Enter: () => {
        const editor = this.editor;
        const state = editor.state;
        const { selection, } = state;
        const listNodeType = getListItemType();

        if (!listNodeType) return false;

        if (
          isNodeActive(state, listNodeType.name,)
          && selection.$from.parent.content.size === 0
        ) {
          return editor.chain().liftListItem(listNodeType.name,).run();
        }

        return originalShortcuts.Enter
          ? originalShortcuts.Enter({ editor, },)
          : false;
      },

      Backspace: ({ editor, },) => {
        const state = editor.state;
        const { selection, } = state;
        const listNodeType = getListItemType();

        if (
          listNodeType
          && isNodeActive(state, listNodeType.name,)
          && selection.$from.parentOffset === 0
          && selection.$from.parent.content.size === 0
        ) {
          return editor.chain().liftListItem(listNodeType.name,).run();
        }

        if (tryJoinLists(editor,)) return true;

        return originalShortcuts.Backspace
          ? originalShortcuts.Backspace({ editor, },)
          : false;
      },

      Tab: () => {
        const listNodeType = getListItemType();
        if (!listNodeType) return false;
        if (isNodeActive(this.editor.state, listNodeType.name,)) {
          return this.editor.chain().sinkListItem(listNodeType.name,).run();
        }
        return false;
      },

      "Shift-Tab": () => {
        const listNodeType = getListItemType();
        if (!listNodeType) return false;
        if (isNodeActive(this.editor.state, listNodeType.name,)) {
          return this.editor.chain().liftListItem(listNodeType.name,).run();
        }
        return false;
      },
    };
  },
},);
