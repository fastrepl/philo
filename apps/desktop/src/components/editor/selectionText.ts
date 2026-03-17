import type { Editor, } from "@tiptap/core";
import type { Node as ProseMirrorNode, } from "@tiptap/pm/model";
import { getMentionChipLabel, type MentionKind, } from "../../services/mentions";

function getLeafSelectionText(node: ProseMirrorNode,) {
  if (node.type.name === "mentionChip") {
    return getMentionChipLabel({
      id: String(node.attrs.id ?? "",),
      kind: String(node.attrs.kind ?? "tag",) as MentionKind,
      label: String(node.attrs.label ?? "",),
    },);
  }

  return "";
}

export function getEditorSelectionText(editor: Editor,) {
  const { from, to, } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, "", getLeafSelectionText,).trim();
}
