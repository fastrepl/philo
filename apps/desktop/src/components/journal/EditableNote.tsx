import { openUrl, } from "@tauri-apps/plugin-opener";
import type { Editor as TiptapEditor, } from "@tiptap/core";
import FileHandler from "@tiptap/extension-file-handler";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow, } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import { Fragment, } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, } from "@tiptap/pm/state";
import { EditorContent, useEditor, } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { forwardRef, useEffect, useImperativeHandle, useRef, } from "react";
import { useDebounceCallback, } from "usehooks-ts";
import "../editor/Editor.css";
import { parseJsonContent, } from "../../lib/markdown";
import { resolveAssetUrl, saveImage, } from "../../services/images";
import { getMentionChipDate, getMentionChipHref, type MentionKind, } from "../../services/mentions";
import { saveDailyNote, } from "../../services/storage";
import type { DailyNote, } from "../../types/note";
import { EditorBubbleMenu, } from "../editor/EditorBubbleMenu";
import { ClipboardTextSerializer, } from "../editor/extensions/clipboard";
import { ExcalidrawExtension, } from "../editor/extensions/excalidraw/ExcalidrawExtension";
import { HashtagExtension, } from "../editor/extensions/hashtag/HashtagExtension";
import { CustomListKeymap, } from "../editor/extensions/list-keymap";
import { buildMentionChipSuggestion, MentionChipExtension, } from "../editor/extensions/mention/MentionChipExtension";
import { CustomParagraph, } from "../editor/extensions/paragraph/ParagraphExtension";
import {
  PersistentSelectionHighlightExtension,
  type PersistentSelectionRange,
  setPersistentSelectionHighlight,
} from "../editor/extensions/persistent-selection/PersistentSelectionHighlightExtension";
import { CustomTaskItem, } from "../editor/extensions/task-item/TaskItemNode";
import { UnderlineExtension, } from "../editor/extensions/underline/UnderlineExtension";
import { WidgetExtension, } from "../editor/extensions/widget/WidgetExtension";
import { getEditorSelectionText, } from "../editor/selectionText";

export interface EditableNoteHandle {
  focus(): void;
  editor: TiptapEditor | null;
}

export interface EditableNoteSelection {
  editor: TiptapEditor;
  noteDate: string;
  from: number;
  to: number;
  text: string;
}

interface EditableNoteProps {
  note: DailyNote;
  placeholder?: string;
  onSave?: (note: DailyNote,) => void;
  onOpenDate?: (date: string,) => void;
  onInteract?: () => void;
  onChatSelection?: (selection: EditableNoteSelection,) => void;
  onSelectionChange?: (selection: EditableNoteSelection | null,) => void;
  onSelectionBlur?: (editor: TiptapEditor,) => void;
  persistentSelectionRange?: PersistentSelectionRange | null;
}

const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp",];

function moveSelectedNode(view: import("@tiptap/pm/view").EditorView, direction: "up" | "down",): boolean {
  const { state, } = view;
  const { selection, } = state;

  if (!(selection instanceof NodeSelection)) return false;
  if (!selection.node.isBlock) return false;

  const nodePos = selection.from;
  const $nodePos = state.doc.resolve(nodePos,);
  const depth = $nodePos.depth;
  const parent = $nodePos.node(depth,);
  const index = $nodePos.index(depth,);
  const targetIndex = direction === "up" ? index - 1 : index + 1;

  if (targetIndex < 0 || targetIndex >= parent.childCount) {
    return true;
  }

  const children = Array.from({ length: parent.childCount, }, (_, i,) => parent.child(i,),);
  const [movingNode,] = children.splice(index, 1,);
  children.splice(targetIndex, 0, movingNode,);

  const tr = state.tr;
  const parentStart = depth === 0 ? 0 : $nodePos.start(depth,);
  const parentEnd = depth === 0 ? state.doc.content.size : $nodePos.end(depth,);
  tr.replaceWith(parentStart, parentEnd, Fragment.fromArray(children,),);

  const adjacentNodeSize = direction === "up"
    ? parent.child(index - 1,).nodeSize
    : parent.child(index + 1,).nodeSize;
  const newNodePos = direction === "up"
    ? nodePos - adjacentNodeSize
    : nodePos + adjacentNodeSize;
  tr.setSelection(NodeSelection.create(tr.doc, newNodePos,),);

  view.dispatch(tr.scrollIntoView(),);
  return true;
}

const EditableNote = forwardRef<EditableNoteHandle, EditableNoteProps>(
  function EditableNote(
    {
      note,
      placeholder = "Start writing...",
      onSave,
      onOpenDate,
      onInteract,
      onChatSelection,
      onSelectionChange,
      onSelectionBlur,
      persistentSelectionRange,
    },
    ref,
  ) {
    const noteRef = useRef(note,);
    noteRef.current = note;

    const onSaveRef = useRef(onSave,);
    onSaveRef.current = onSave;

    const selfUpdateRef = useRef(false,);

    const saveDebounced = useDebounceCallback((jsonStr: string,) => {
      const updated = { ...noteRef.current, content: jsonStr, };
      selfUpdateRef.current = true;
      if (onSaveRef.current) {
        onSaveRef.current(updated,);
      } else {
        saveDailyNote(updated,).catch(console.error,);
      }
    }, 500,);

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6,], },
          listKeymap: false,
          paragraph: false,
          underline: false,
        },),
        CustomParagraph,
        Image.configure({ inline: true, allowBase64: false, },),
        UnderlineExtension,
        Placeholder.configure({
          placeholder: ({ editor, },) => (editor.isEmpty ? placeholder : ""),
        },),
        Link.extend({
          inclusive() {
            return false;
          },
          addProseMirrorPlugins() {
            return [
              new Plugin({
                key: new PluginKey("linkCmdClick",),
                props: {
                  handleClick(_view, _pos, event,) {
                    const chip = (event.target as HTMLElement).closest("[data-mention-chip]",);
                    if (chip) {
                      const chipData = {
                        id: chip.getAttribute("data-id",) ?? "",
                        kind: (chip.getAttribute("data-kind",) ?? "tag") as MentionKind,
                      };
                      const date = onOpenDate ? getMentionChipDate(chipData, noteRef.current.date,) : null;
                      if (date) {
                        event.preventDefault();
                        onOpenDate?.(date,);
                        return true;
                      }

                      const href = getMentionChipHref(chipData,);
                      if (href) {
                        event.preventDefault();
                        openUrl(href,);
                        return true;
                      }
                    }

                    if (!(event.metaKey || event.ctrlKey)) return false;
                    const anchor = (event.target as HTMLElement).closest("a",);
                    if (anchor && (anchor as HTMLAnchorElement).href) {
                      event.preventDefault();
                      openUrl((anchor as HTMLAnchorElement).href,);
                      return true;
                    }
                    return false;
                  },
                },
              },),
            ];
          },
        },).configure({ openOnClick: false, autolink: true, },),
        TaskList,
        CustomTaskItem.configure({ nested: true, },),
        Table.configure({ resizable: true, HTMLAttributes: { class: "tiptap-table", }, },),
        TableRow,
        TableHeader,
        TableCell,
        Highlight,
        MentionChipExtension.configure({ suggestion: buildMentionChipSuggestion(note.date,), },),
        HashtagExtension,
        ExcalidrawExtension,
        WidgetExtension,
        PersistentSelectionHighlightExtension,
        CustomListKeymap,
        ClipboardTextSerializer,
        FileHandler.configure({
          allowedMimeTypes: IMAGE_MIME_TYPES,
          onDrop: (_editor: TiptapEditor, files: File[], pos: number,) => {
            (async () => {
              for (const file of files) {
                const relativePath = await saveImage(file,);
                const assetUrl = await resolveAssetUrl(relativePath,);
                _editor.chain().insertContentAt(pos, {
                  type: "image",
                  attrs: { src: assetUrl, alt: file.name, },
                },).focus().run();
              }
            })().catch(console.error,);
            return true;
          },
        },),
      ],
      content: parseJsonContent(note.content,),
      editable: true,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: "max-w-none focus:outline-hidden px-6 text-gray-900 dark:text-gray-100",
        },
        handlePaste: (_view, event,) => {
          const files = Array.from(event.clipboardData?.files ?? [],).filter(file =>
            IMAGE_MIME_TYPES.includes(file.type,)
          );
          if (files.length === 0) {
            return false;
          }

          event.preventDefault();
          event.stopPropagation();

          (async () => {
            for (const file of files) {
              const relativePath = await saveImage(file,);
              const assetUrl = await resolveAssetUrl(relativePath,);
              editor?.chain().focus().insertContent({
                type: "image",
                attrs: { src: assetUrl, alt: file.name, },
              },).run();
            }
          })().catch(console.error,);

          return true;
        },
        handleKeyDown: (_view, event,) => {
          if (
            event.altKey
            && !event.shiftKey
            && !event.metaKey
            && !event.ctrlKey
            && (event.key === "ArrowUp" || event.key === "ArrowDown")
          ) {
            const moved = moveSelectedNode(_view, event.key === "ArrowUp" ? "up" : "down",);
            if (moved) {
              event.preventDefault();
              return true;
            }
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "a") {
            const { doc, } = _view.state;
            const from = Selection.atStart(doc,).from;
            const to = Selection.atEnd(doc,).to;
            _view.dispatch(_view.state.tr.setSelection(TextSelection.create(doc, from, to,),),);
            return true;
          }
          if (event.metaKey && event.key === "l") {
            event.preventDefault();
            editor?.chain().focus().toggleTaskList().run();
            return true;
          }
          if (event.key === "Backspace") {
            const { $from, empty, } = _view.state.selection;
            if (empty && $from.parentOffset === 0 && $from.parent.type.name === "heading") {
              const tr = _view.state.tr.setBlockType(
                $from.before(),
                $from.after(),
                _view.state.schema.nodes.paragraph,
              );
              _view.dispatch(tr,);
              return true;
            }
          }
          return false;
        },
      },
      onUpdate: ({ editor, },) => {
        saveDebounced(JSON.stringify(editor.getJSON(),),);
      },
    },);

    useImperativeHandle(
      ref,
      () => {
        return {
          focus: () => {
            editor?.commands.focus();
          },
          editor: editor ?? null,
        };
      },
      [editor,],
    );

    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      if (selfUpdateRef.current) {
        selfUpdateRef.current = false;
        return;
      }
      const incoming = parseJsonContent(note.content,);
      editor.commands.setContent(incoming, { emitUpdate: false, },);
    }, [note.content,],);

    useEffect(() => {
      if (!editor || !onSelectionChange) return;

      const syncSelection = () => {
        const { from, to, } = editor.state.selection;
        const selectedText = getEditorSelectionText(editor,);
        if (!editor.isFocused && !selectedText) return;
        onSelectionChange(
          selectedText
            ? {
              editor,
              noteDate: noteRef.current.date,
              from,
              to,
              text: selectedText,
            }
            : null,
        );
      };

      syncSelection();
      editor.on("selectionUpdate", syncSelection,);

      return () => {
        editor.off("selectionUpdate", syncSelection,);
      };
    }, [editor, onSelectionChange,],);

    useEffect(() => {
      if (!editor || !onSelectionBlur) return;

      const handleBlur = () => onSelectionBlur(editor,);
      editor.on("blur", handleBlur,);

      return () => {
        editor.off("blur", handleBlur,);
      };
    }, [editor, onSelectionBlur,],);

    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      setPersistentSelectionHighlight(editor, persistentSelectionRange ?? null,);
    }, [
      editor,
      persistentSelectionRange?.from,
      persistentSelectionRange?.to,
    ],);

    return (
      <>
        {editor && onChatSelection && (
          <EditorBubbleMenu
            editor={editor}
            onChatSelection={(selectedText,) => {
              const { from, to, } = editor.state.selection;
              onChatSelection({
                editor,
                noteDate: noteRef.current.date,
                from,
                to,
                text: selectedText,
              },);
            }}
          />
        )}
        <div onMouseDownCapture={onInteract}>
          <EditorContent editor={editor} />
        </div>
      </>
    );
  },
);

export default EditableNote;
