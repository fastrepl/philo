import Paragraph from "@tiptap/extension-paragraph";
import type { JSONContent, } from "@tiptap/react";
import { EditorContent, useEditor, } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, } from "react";

const DiffParagraph = Paragraph.extend({
  addAttributes() {
    return {
      diffKind: {
        default: "context",
        renderHTML: (attributes,) => ({
          "data-diff-kind": attributes.diffKind ?? "context",
        }),
      },
    };
  },
},);

function buildDiffDocument(unifiedDiff: string,): JSONContent {
  const lines = unifiedDiff.split("\n",);
  const content = lines.map((line,) => {
    let diffKind = "context";
    if (line.startsWith("+++",) || line.startsWith("---",)) {
      diffKind = "meta";
    } else if (line.startsWith("@@",)) {
      diffKind = "hunk";
    } else if (line.startsWith("+",)) {
      diffKind = "insert";
    } else if (line.startsWith("-",)) {
      diffKind = "delete";
    }

    return line
      ? {
        type: "paragraph",
        attrs: { diffKind, },
        content: [{ type: "text", text: line, },],
      }
      : {
        type: "paragraph",
        attrs: { diffKind, },
      };
  },);

  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph", attrs: { diffKind: "context", }, },],
  };
}

interface AiDiffPreviewProps {
  unifiedDiff: string;
}

export function AiDiffPreview({ unifiedDiff, }: AiDiffPreviewProps,) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        paragraph: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        codeBlock: false,
        horizontalRule: false,
        heading: false,
      },),
      DiffParagraph,
    ],
    content: buildDiffDocument(unifiedDiff,),
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "ai-diff-preview rounded-xl border border-gray-200 bg-white/70 px-3 py-3 text-[12px] text-gray-800",
      },
    },
  },);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.commands.setContent(buildDiffDocument(unifiedDiff,), { emitUpdate: false, },);
  }, [editor, unifiedDiff,],);

  if (!editor) return null;
  return <EditorContent editor={editor} />;
}
