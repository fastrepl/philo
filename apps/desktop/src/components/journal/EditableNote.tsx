import { openUrl, } from "@tauri-apps/plugin-opener";
import type { Editor as TiptapEditor, } from "@tiptap/core";
import FileHandler from "@tiptap/extension-file-handler";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow, } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import { Fragment, type Node as ProseMirrorNode, } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, } from "@tiptap/pm/state";
import { EditorContent, useEditor, } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { forwardRef, useEffect, useImperativeHandle, useRef, } from "react";
import { useDebounceCallback, } from "usehooks-ts";
import "../editor/Editor.css";
import { parseJsonContent, } from "../../lib/markdown";
import { openGoogleMentionChip, } from "../../services/google-open";
import { resolveAssetUrl, saveImage, } from "../../services/images";
import { getMentionChipDate, getMentionChipHref, type MentionKind, } from "../../services/mentions";
import { buildPageLinkTarget, parsePageTitleFromLinkTarget, } from "../../services/paths";
import { saveDailyNote, } from "../../services/storage";
import { ensureUrlSummaryPage, } from "../../services/url-summary";
import { type DailyNote, getToday, type PageNote, } from "../../types/note";
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
import { SlashCommandExtension, } from "../editor/extensions/slash-command/SlashCommandExtension";
import { CustomTaskItem, } from "../editor/extensions/task-item/TaskItemNode";
import { UnderlineExtension, } from "../editor/extensions/underline/UnderlineExtension";
import { getUrlSummaryOccurrences, UrlSummaryExtension, } from "../editor/extensions/url-summary/UrlSummaryExtension";
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
  note: DailyNote | PageNote;
  placeholder?: string;
  onSave?: (note: DailyNote | PageNote,) => void;
  onOpenDate?: (date: string,) => void;
  onOpenPage?: (title: string,) => void;
  onInteract?: () => void;
  onChatSelection?: (selection: EditableNoteSelection,) => void;
  onSelectionChange?: (selection: EditableNoteSelection | null,) => void;
  onSelectionBlur?: (editor: TiptapEditor,) => void;
  onCreatePage?: (date: string,) => Promise<string | null> | string | null;
  persistentSelectionRange?: PersistentSelectionRange | null;
}

const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp",];

function getReferenceDate(note: DailyNote | PageNote,) {
  if ("date" in note) return note.date;
  return note.attachedTo ?? getToday();
}

function isListItemNode(node: ProseMirrorNode,) {
  return node.type.name === "listItem" || node.type.name === "taskItem";
}

function isListContainerNode(node: ProseMirrorNode,) {
  return node.type.name === "bulletList" || node.type.name === "orderedList" || node.type.name === "taskList";
}

function findNestedListChildIndex(node: ProseMirrorNode, listTypeName: string,) {
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.child(index,).type.name === listTypeName) {
      return index;
    }
  }

  return -1;
}

function getDescendantNodePos(ancestorPos: number, ancestorNode: ProseMirrorNode, path: number[],): number {
  let currentPos = ancestorPos;
  let currentNode = ancestorNode;

  for (const index of path) {
    let childPos = currentPos + 1;

    for (let childIndex = 0; childIndex < index; childIndex += 1) {
      childPos += currentNode.child(childIndex,).nodeSize;
    }

    currentPos = childPos;
    currentNode = currentNode.child(index,);
  }

  return currentPos;
}

function getMovableNodeContext(state: import("@tiptap/pm/state").EditorState,) {
  const { doc, selection, } = state;

  if (selection instanceof NodeSelection) {
    if (!selection.node.isBlock) return null;

    const $nodePos = doc.resolve(selection.from,);
    const parentDepth = $nodePos.depth;

    return {
      node: selection.node,
      nodePos: selection.from,
      parentDepth,
      parent: $nodePos.node(parentDepth,),
      index: $nodePos.index(parentDepth,),
    };
  }

  const { $from, } = selection;
  let moveDepth = 1;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth,);
    if (node.type.name === "listItem" || node.type.name === "taskItem") {
      moveDepth = depth;
      break;
    }
  }

  const node = $from.node(moveDepth,);
  if (!node.isBlock) return null;

  const nodePos = $from.before(moveDepth,);
  if (selection.from < nodePos || selection.to > nodePos + node.nodeSize) {
    return null;
  }

  const parentDepth = moveDepth - 1;

  return {
    node,
    nodePos,
    parentDepth,
    parent: $from.node(parentDepth,),
    index: $from.index(parentDepth,),
  };
}

function tryMoveListItemIntoNextSibling(
  view: import("@tiptap/pm/view").EditorView,
  context: ReturnType<typeof getMovableNodeContext>,
): boolean {
  if (!context) return false;

  const { state, } = view;
  const { selection, } = state;
  const {
    index,
    node,
    nodePos,
    parent,
    parentDepth,
  } = context;

  if (!isListItemNode(node,) || !isListContainerNode(parent,) || index >= parent.childCount - 1) {
    return false;
  }

  const nextSibling = parent.child(index + 1,);
  if (!isListItemNode(nextSibling,)) {
    return false;
  }

  const nestedListIndex = findNestedListChildIndex(nextSibling, parent.type.name,);
  if (nestedListIndex < 0) {
    return false;
  }

  const nestedList = nextSibling.child(nestedListIndex,);
  const nestedListChildren = Array.from(
    { length: nestedList.childCount, },
    (_, childIndex,) => nestedList.child(childIndex,),
  );
  nestedListChildren.unshift(node,);

  const nextSiblingChildren = Array.from(
    { length: nextSibling.childCount, },
    (_, childIndex,) => nextSibling.child(childIndex,),
  );
  nextSiblingChildren[nestedListIndex] = nestedList.copy(Fragment.fromArray(nestedListChildren,),);

  const parentChildren = Array.from({ length: parent.childCount, }, (_, childIndex,) => parent.child(childIndex,),);
  parentChildren.splice(index, 1,);
  parentChildren[index] = nextSibling.copy(Fragment.fromArray(nextSiblingChildren,),);

  const tr = state.tr;
  const $nodePos = state.doc.resolve(nodePos,);
  const parentStart = parentDepth === 0 ? 0 : $nodePos.start(parentDepth,);
  const parentEnd = parentDepth === 0 ? state.doc.content.size : $nodePos.end(parentDepth,);
  tr.replaceWith(parentStart, parentEnd, Fragment.fromArray(parentChildren,),);

  if (parentDepth === 0) {
    view.dispatch(tr.scrollIntoView(),);
    return true;
  }

  const parentNodePos = $nodePos.before(parentDepth,);
  const updatedParent = tr.doc.nodeAt(parentNodePos,);
  if (!updatedParent) {
    view.dispatch(tr.scrollIntoView(),);
    return true;
  }

  const newNodePos = getDescendantNodePos(parentNodePos, updatedParent, [index, nestedListIndex, 0,],);

  if (selection instanceof NodeSelection) {
    tr.setSelection(NodeSelection.create(tr.doc, newNodePos,),);
  } else {
    tr.setSelection(TextSelection.near(tr.doc.resolve(newNodePos + 1,),),);
  }

  view.dispatch(tr.scrollIntoView(),);
  return true;
}

function moveSelectedNode(view: import("@tiptap/pm/view").EditorView, direction: "up" | "down",): boolean {
  const { state, } = view;
  const { selection, } = state;
  const context = getMovableNodeContext(state,);
  if (!context) return false;

  const {
    index,
    nodePos,
    parent,
    parentDepth,
  } = context;

  if (direction === "down" && tryMoveListItemIntoNextSibling(view, context,)) {
    return true;
  }

  const targetIndex = direction === "up" ? index - 1 : index + 1;

  if (targetIndex < 0 || targetIndex >= parent.childCount) {
    return true;
  }

  const children = Array.from({ length: parent.childCount, }, (_, i,) => parent.child(i,),);
  const [movingNode,] = children.splice(index, 1,);
  children.splice(targetIndex, 0, movingNode,);

  const tr = state.tr;
  const $nodePos = state.doc.resolve(nodePos,);
  const parentStart = parentDepth === 0 ? 0 : $nodePos.start(parentDepth,);
  const parentEnd = parentDepth === 0 ? state.doc.content.size : $nodePos.end(parentDepth,);
  tr.replaceWith(parentStart, parentEnd, Fragment.fromArray(children,),);

  const adjacentNodeSize = direction === "up"
    ? parent.child(index - 1,).nodeSize
    : parent.child(index + 1,).nodeSize;
  const positionDelta = direction === "up" ? -adjacentNodeSize : adjacentNodeSize;
  const newNodePos = nodePos + positionDelta;

  if (selection instanceof NodeSelection) {
    tr.setSelection(NodeSelection.create(tr.doc, newNodePos,),);
  } else {
    const movedSelection = TextSelection.create(
      tr.doc,
      selection.anchor + positionDelta,
      selection.head + positionDelta,
    );
    tr.setSelection(movedSelection,);
  }

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
      onOpenPage,
      onInteract,
      onChatSelection,
      onSelectionChange,
      onSelectionBlur,
      onCreatePage,
      persistentSelectionRange,
    },
    ref,
  ) {
    const noteRef = useRef(note,);
    noteRef.current = note;

    const onSaveRef = useRef(onSave,);
    onSaveRef.current = onSave;

    const onCreatePageRef = useRef(onCreatePage,);
    onCreatePageRef.current = onCreatePage;

    const selfUpdateRef = useRef(false,);

    const saveDebounced = useDebounceCallback((jsonStr: string,) => {
      const updated = { ...noteRef.current, content: jsonStr, };
      selfUpdateRef.current = true;
      if (onSaveRef.current) {
        onSaveRef.current(updated,);
      } else if ("date" in updated) {
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
                      const pageTitle = onOpenPage && chipData.kind === "page"
                        ? parsePageTitleFromLinkTarget(chipData.id,)
                        : null;
                      if (pageTitle) {
                        event.preventDefault();
                        onOpenPage?.(pageTitle,);
                        return true;
                      }
                      const date = onOpenDate
                        ? getMentionChipDate(chipData, getReferenceDate(noteRef.current,),)
                        : null;
                      if (date) {
                        event.preventDefault();
                        onOpenDate?.(date,);
                        return true;
                      }

                      if (chipData.kind === "gmail" || chipData.kind === "google_calendar") {
                        event.preventDefault();
                        openGoogleMentionChip(chipData,).catch(console.error,);
                        return true;
                      }

                      const href = getMentionChipHref(chipData,);
                      if (href) {
                        event.preventDefault();
                        openUrl(href,);
                        return true;
                      }
                    }

                    const anchor = (event.target as HTMLElement).closest("a",);
                    const anchorHref = anchor?.getAttribute("href",) ?? "";
                    const pageTitle = onOpenPage ? parsePageTitleFromLinkTarget(anchorHref,) : null;
                    if (pageTitle) {
                      event.preventDefault();
                      onOpenPage?.(pageTitle,);
                      return true;
                    }

                    if (!(event.metaKey || event.ctrlKey)) return false;
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
        MentionChipExtension.configure({
          suggestions: [
            buildMentionChipSuggestion(getReferenceDate(note,), {
              char: "@",
              pluginKey: "mention-chip-suggestion-at",
            },),
            buildMentionChipSuggestion(getReferenceDate(note,), {
              char: "[[",
              pluginKey: "mention-chip-suggestion-wikilink",
            },),
          ],
        },),
        HashtagExtension,
        ExcalidrawExtension,
        WidgetExtension,
        UrlSummaryExtension.configure({
          async onStaleUrl({ occurrence, },) {
            if (!editor || editor.isDestroyed) return true;

            try {
              const result = await ensureUrlSummaryPage(occurrence.text,);
              const latestOccurrence = getUrlSummaryOccurrences(editor.state,).find((entry,) =>
                entry.id === occurrence.id
              );
              if (!latestOccurrence || latestOccurrence.text !== occurrence.text) {
                return true;
              }

              const mentionNode = editor.schema.nodes.mentionChip?.create({
                id: buildPageLinkTarget(result.pageTitle,),
                kind: "page",
                label: result.chipLabel,
              },);
              if (!mentionNode) return false;

              editor.view.dispatch(
                editor.state.tr.replaceWith(latestOccurrence.from, latestOccurrence.to, mentionNode,),
              );
              return true;
            } catch (error) {
              console.error(error,);
              return false;
            }
          },
        },),
        SlashCommandExtension.configure({
          onAttachPage: () => {
            const currentNote = noteRef.current;
            if (!("date" in currentNote)) return null;
            return onCreatePageRef.current?.(currentNote.date,) ?? null;
          },
        },),
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
          if (
            event.metaKey
            && !event.altKey
            && !event.ctrlKey
            && (event.key === "ArrowUp" || event.key === "ArrowDown")
          ) {
            const { doc, } = _view.state;
            const selection = event.key === "ArrowUp" ? Selection.atStart(doc,) : Selection.atEnd(doc,);
            _view.dispatch(_view.state.tr.setSelection(selection,).scrollIntoView(),);
            return true;
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
              noteDate: getReferenceDate(noteRef.current,),
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
                noteDate: getReferenceDate(noteRef.current,),
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
