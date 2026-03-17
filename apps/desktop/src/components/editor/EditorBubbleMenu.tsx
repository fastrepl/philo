import type { Editor, } from "@tiptap/core";
import { BubbleMenu, } from "@tiptap/react/menus";
import { useState, } from "react";
import { getAiConfigurationMessage, isAiKeyMissingError, } from "../../services/ai";
import { generateWidget, } from "../../services/generate";
import { createWidgetFile, } from "../../services/widget-files";
import { waitForNextPaint, } from "./extensions/widget/loading";
import { getEditorSelectionText, } from "./selectionText";

interface EditorBubbleMenuProps {
  editor: Editor;
  onChatSelection: (selectedText: string,) => void;
}

function updateWidgetById(editor: Editor, id: string, attrs: Record<string, unknown>,) {
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

function deriveTitle(prompt: string,): string {
  const firstSentence = prompt.split(/[.!?\n]/,)[0].trim();
  if (!firstSentence) return "Widget";
  if (firstSentence.length <= 40) return firstSentence;
  return `${firstSentence.slice(0, 37,)}...`;
}

export function EditorBubbleMenu({ editor, onChatSelection, }: EditorBubbleMenuProps,) {
  const [building, setBuilding,] = useState(false,);

  const getSelectedText = () => {
    return getEditorSelectionText(editor,);
  };

  const handleBuild = async () => {
    const selectedText = getSelectedText();
    if (!selectedText || building) return;

    setBuilding(true,);

    const widgetId = crypto.randomUUID();
    editor
      .chain()
      .focus()
      .deleteSelection()
      .insertContent({
        type: "widget",
        attrs: { id: widgetId, prompt: selectedText, spec: "", loading: true, saved: false, error: "", },
      },)
      .run();

    await waitForNextPaint();

    try {
      const spec = await generateWidget(selectedText,);
      const specString = JSON.stringify(spec,);
      const record = await createWidgetFile({
        title: deriveTitle(selectedText,),
        prompt: selectedText,
        spec: specString,
        saved: false,
      },);
      updateWidgetById(editor, widgetId, {
        id: record.id,
        file: record.file,
        path: record.path,
        spec: record.spec,
        loading: false,
      },);
    } catch (err) {
      console.error("Build failed:", err,);
      const msg = err instanceof Error && isAiKeyMissingError(err.message,)
        ? getAiConfigurationMessage(err.message,)
        : err instanceof Error
        ? err.message
        : "Something went wrong.";
      updateWidgetById(editor, widgetId, { loading: false, error: msg, },);
    } finally {
      setBuilding(false,);
    }
  };

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8, }}
      shouldShow={({ from, to, }: { from: number; to: number; },) => from !== to}
    >
      <div className="bubble-menu">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`bubble-btn ${editor.isActive("bold",) ? "bubble-btn-active" : ""}`}
        >
          B
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`bubble-btn bubble-btn-italic ${editor.isActive("italic",) ? "bubble-btn-active" : ""}`}
        >
          I
        </button>
        <button
          onClick={() => editor.chain().focus().toggleStrike().run()}
          className={`bubble-btn bubble-btn-strike ${editor.isActive("strike",) ? "bubble-btn-active" : ""}`}
        >
          S
        </button>
        <button
          onClick={() => editor.chain().focus().toggleCode().run()}
          className={`bubble-btn ${editor.isActive("code",) ? "bubble-btn-active" : ""}`}
        >
          {"</>"}
        </button>
        <div className="bubble-divider" />
        <button
          onClick={() => {
            const selectedText = getSelectedText();
            if (!selectedText) return;
            onChatSelection(selectedText,);
          }}
          className="bubble-btn bubble-btn-chat"
        >
          Chat
        </button>
        <button
          onClick={handleBuild}
          className={`bubble-btn bubble-btn-build ${building ? "bubble-btn-building" : ""}`}
          disabled={building}
        >
          {building ? "Building..." : "Build"}
        </button>
      </div>
    </BubbleMenu>
  );
}
