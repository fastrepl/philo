import { autoUpdate, computePosition, flip, limitShift, offset, shift, size, } from "@floating-ui/dom";
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
import type { JSONContent, } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, } from "react";
import { useDebounceCallback, } from "usehooks-ts";
import "../editor/Editor.css";
import { showNativeContextMenu, } from "../../hooks/useNativeContextMenu";
import { parseJsonContent, } from "../../lib/markdown";
import { openGoogleMentionChip, } from "../../services/google-open";
import { resolveAssetUrl, saveImage, } from "../../services/images";
import {
  createDateMention,
  createRecurringMention,
  getMentionChipDate,
  getMentionChipHref,
  getMentionChipLabel,
  getMentionChipRecurringIntervalDays,
  type MentionKind,
} from "../../services/mentions";
import { buildPageLinkTarget, parsePageTitleFromLinkTarget, } from "../../services/paths";
import { saveDailyNote, } from "../../services/storage";
import { ensureUrlSummaryPage, } from "../../services/url-summary";
import { type DailyNote, getToday, type PageNote, } from "../../types/note";
import { EditorBubbleMenu, } from "../editor/EditorBubbleMenu";
import { ClipboardTextSerializer, } from "../editor/extensions/clipboard";
import {
  DATE_PICKER_RECURRENCE_OPTIONS,
  type DatePickerRecurrence,
  handleDatePickerKeyDown,
  MiniCalendar,
} from "../editor/extensions/date-picker";
import { ExcalidrawExtension, } from "../editor/extensions/excalidraw/ExcalidrawExtension";
import { HashtagExtension, } from "../editor/extensions/hashtag/HashtagExtension";
import { CustomListKeymap, } from "../editor/extensions/list-keymap";
import {
  decorateMeetingPageDoc,
  MeetingMetaExtension,
  MeetingTranscriptExtension,
  stripMeetingPageDoc,
} from "../editor/extensions/meeting/MeetingPageExtensions";
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

interface EditableDateChipState {
  element: HTMLElement;
  pos: number;
  selectedDate: string;
  recurrence: DatePickerRecurrence;
}

const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp",];

function getReferenceDate(note: DailyNote | PageNote,) {
  if ("date" in note) return note.date;
  return note.attachedTo ?? getToday();
}

function getEditorNoteContent(note: DailyNote | PageNote,) {
  return "date" in note
    ? parseJsonContent(note.content,)
    : decorateMeetingPageDoc(note, parseJsonContent(note.content,),);
}

function getMeetingDecorationKey(note: DailyNote | PageNote,) {
  if ("date" in note || note.type !== "meeting") return "";
  return JSON.stringify({
    endedAt: note.endedAt,
    location: note.location,
    participants: note.participants,
    sessionKind: note.sessionKind,
    startedAt: note.startedAt,
  },);
}

function isDateChipKind(kind: MentionKind,): kind is "date" | "recurring" {
  return kind === "date" || kind === "recurring";
}

function getMentionChipDataFromElement(chipElement: HTMLElement,) {
  return {
    id: chipElement.getAttribute("data-id",) ?? "",
    kind: (chipElement.getAttribute("data-kind",) ?? "tag") as MentionKind,
    label: chipElement.getAttribute("data-label",) ?? "",
  };
}

function getDatePickerRecurrence(intervalDays: number | null,): DatePickerRecurrence {
  if (intervalDays === 1) return "daily";
  if (intervalDays === 7) return "weekly";
  if (intervalDays === 30) return "monthly";
  return "";
}

function formatRecurrenceDescriptionDate(date: string,) {
  return new Date(`${date}T00:00:00`,).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  },);
}

function getRecurrenceDescription(date: string, recurrence: DatePickerRecurrence,) {
  if (!recurrence) return null;
  return `Starting from ${formatRecurrenceDescriptionDate(date,)} this will show up on a ${recurrence} basis.`;
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

    const onOpenDateRef = useRef(onOpenDate,);
    onOpenDateRef.current = onOpenDate;

    const onSaveRef = useRef(onSave,);
    onSaveRef.current = onSave;

    const onCreatePageRef = useRef(onCreatePage,);
    onCreatePageRef.current = onCreatePage;

    const selfUpdateRef = useRef(false,);
    const meetingDecorationKey = getMeetingDecorationKey(note,);
    const [editingDateChip, setEditingDateChip,] = useState<EditableDateChipState | null>(null,);
    const dateChipPopoverRef = useRef<HTMLDivElement | null>(null,);
    const editingDateChipRef = useRef<EditableDateChipState | null>(null,);
    editingDateChipRef.current = editingDateChip;

    const closeDateChipEditor = useCallback(() => {
      setEditingDateChip(null,);
    }, [],);

    const updateEditingDateChip = useCallback(
      (updates: Partial<Pick<EditableDateChipState, "selectedDate" | "recurrence">>,) => {
        setEditingDateChip((current,) => (current ? { ...current, ...updates, } : current));
      },
      [],
    );

    const saveDebounced = useDebounceCallback((jsonStr: string,) => {
      const updated = { ...noteRef.current, content: jsonStr, };
      selfUpdateRef.current = true;
      if (onSaveRef.current) {
        onSaveRef.current(updated,);
      } else if ("date" in updated) {
        saveDailyNote(updated,).catch(console.error,);
      }
    }, 500,);

    const openDateChipEditorRef = useRef<
      (
        _view: import("@tiptap/pm/view").EditorView,
        _chipElement: HTMLElement,
      ) => boolean
    >((_view, _chipElement,) => false);
    openDateChipEditorRef.current = (view, chipElement,) => {
      const chipData = getMentionChipDataFromElement(chipElement,);
      if (!isDateChipKind(chipData.kind,)) return false;

      const pos = view.posAtDOM(chipElement, 0,);
      const selectedDate = getMentionChipDate(chipData, getReferenceDate(noteRef.current,),);
      if (!selectedDate) return false;

      setEditingDateChip({
        element: chipElement,
        pos,
        selectedDate,
        recurrence: getDatePickerRecurrence(getMentionChipRecurringIntervalDays(chipData,),),
      },);
      return true;
    };

    const showDateChipContextMenuRef = useRef<
      (
        _event: MouseEvent,
        _chipElement: HTMLElement,
      ) => boolean
    >((_event, _chipElement,) => false);
    showDateChipContextMenuRef.current = (event, chipElement,) => {
      const chipData = getMentionChipDataFromElement(chipElement,);
      if (!isDateChipKind(chipData.kind,)) return false;

      const date = getMentionChipDate(chipData, getReferenceDate(noteRef.current,),);
      if (!date) return false;

      const label = getMentionChipLabel(chipData, getReferenceDate(noteRef.current,),);
      setEditingDateChip(null,);
      void showNativeContextMenu([
        {
          id: `go-to-${date}`,
          text: `Go to ${label}`,
          action: () => onOpenDateRef.current?.(date,),
          disabled: !onOpenDateRef.current,
        },
      ], event,);
      return true;
    };

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
                  handleClick(view, _pos, event,) {
                    const chip = (event.target as HTMLElement).closest("[data-mention-chip]",);
                    if (chip) {
                      if (openDateChipEditorRef.current(view, chip as HTMLElement,)) {
                        event.preventDefault();
                        return true;
                      }

                      const chipData = getMentionChipDataFromElement(chip as HTMLElement,);
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
        MeetingMetaExtension,
        MeetingTranscriptExtension,
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
      content: getEditorNoteContent(note,),
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
        handleDOMEvents: {
          contextmenu: (_view, event,) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return false;

            const chip = target.closest("[data-mention-chip]",);
            if (!(chip instanceof HTMLElement)) return false;

            return showDateChipContextMenuRef.current(event as MouseEvent, chip,);
          },
        },
      },
      onUpdate: ({ editor, },) => {
        const nextContent = "date" in noteRef.current
          ? editor.getJSON()
          : stripMeetingPageDoc(noteRef.current, editor.getJSON() as JSONContent,);
        saveDebounced(JSON.stringify(nextContent,),);
      },
    },);

    const applyDateChipEdit = useCallback(() => {
      if (!editor || !editingDateChip) return;

      const currentNode = editor.state.doc.nodeAt(editingDateChip.pos,);
      if (!currentNode || currentNode.type.name !== "mentionChip") {
        setEditingDateChip(null,);
        return;
      }

      const nextChip = editingDateChip.recurrence
        ? createRecurringMention(editingDateChip.selectedDate, editingDateChip.recurrence,)
        : createDateMention(editingDateChip.selectedDate,);
      const nextNode = editor.schema.nodes.mentionChip?.create({
        id: nextChip.id,
        kind: nextChip.kind,
        label: nextChip.label,
      },);
      if (!nextNode) {
        setEditingDateChip(null,);
        return;
      }

      editor.view.dispatch(
        editor.state.tr.replaceWith(
          editingDateChip.pos,
          editingDateChip.pos + currentNode.nodeSize,
          nextNode,
        ),
      );
      editor.commands.focus();
      setEditingDateChip(null,);
    }, [editor, editingDateChip,],);

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
      const incoming = getEditorNoteContent(note,);
      editor.commands.setContent(incoming, { emitUpdate: false, },);
    }, [meetingDecorationKey, note.content,],);

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

    useEffect(() => {
      if (!editingDateChip || !dateChipPopoverRef.current) return;

      const floatingEl = dateChipPopoverRef.current;
      floatingEl.style.visibility = "hidden";

      const updatePosition = () => {
        void computePosition(editingDateChip.element, floatingEl, {
          strategy: "fixed",
          placement: "bottom-start",
          middleware: [
            offset(6,),
            flip({ padding: 8, },),
            shift({ padding: 8, limiter: limitShift(), },),
            size({
              padding: 8,
              apply: ({ availableHeight, availableWidth, elements, },) => {
                const maxHeight = `${Math.max(availableHeight, 0,)}px`;
                const maxWidth = `${Math.max(availableWidth, 0,)}px`;
                elements.floating.style.maxHeight = maxHeight;
                elements.floating.style.maxWidth = maxWidth;

                const popoverRoot = elements.floating.firstElementChild;
                if (popoverRoot instanceof HTMLElement) {
                  popoverRoot.style.maxHeight = maxHeight;
                  popoverRoot.style.maxWidth = maxWidth;
                }
              },
            },),
          ],
        },).then(({ x, y, },) => {
          floatingEl.style.left = `${x}px`;
          floatingEl.style.top = `${y}px`;
          floatingEl.style.visibility = "visible";
        },);
      };

      const cleanup = autoUpdate(editingDateChip.element, floatingEl, updatePosition,);
      floatingEl.focus();
      updatePosition();
      return cleanup;
    }, [editingDateChip,],);

    useEffect(() => {
      if (!editingDateChip) return;

      const handlePointerDown = (event: PointerEvent,) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (dateChipPopoverRef.current?.contains(target,)) return;
        if (editingDateChipRef.current?.element.contains(target,)) return;
        setEditingDateChip(null,);
      };

      const handleKeyDown = (event: KeyboardEvent,) => {
        const current = editingDateChipRef.current;
        if (!current) return;

        const handled = handleDatePickerKeyDown({
          event,
          selectedDate: current.selectedDate,
          setSelectedDate: (selectedDate,) => updateEditingDateChip({ selectedDate, },),
          recurrence: current.recurrence,
          setRecurrence: (recurrence,) => updateEditingDateChip({ recurrence, },),
          onSubmit: applyDateChipEdit,
          onClose: closeDateChipEditor,
        },);
        if (handled) {
          event.stopPropagation();
        }
      };

      document.addEventListener("pointerdown", handlePointerDown, true,);
      document.addEventListener("keydown", handleKeyDown, true,);
      return () => {
        document.removeEventListener("pointerdown", handlePointerDown, true,);
        document.removeEventListener("keydown", handleKeyDown, true,);
      };
    }, [applyDateChipEdit, closeDateChipEditor, editingDateChip, updateEditingDateChip,],);

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
        {editingDateChip && (
          <div
            ref={dateChipPopoverRef}
            className="mention-menu"
            style={{ position: "fixed", top: 0, left: 0, zIndex: 60, }}
            tabIndex={-1}
          >
            <div className="mention-date-picker">
              <MiniCalendar
                selected={editingDateChip.selectedDate}
                onSelect={(selectedDate,) => updateEditingDateChip({ selectedDate, },)}
              />
              <div className="mention-recurrence">
                <div className="mention-recurrence-label">Repeat</div>
                <div className="mention-recurrence-options">
                  {DATE_PICKER_RECURRENCE_OPTIONS.map((option,) => (
                    <button
                      key={option.value || "none"}
                      className={`mention-recurrence-option${
                        editingDateChip.recurrence === option.value ? " is-active" : ""
                      }`}
                      onClick={() => updateEditingDateChip({ recurrence: option.value, },)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {editingDateChip.recurrence && (
                  <div className="mention-recurrence-description">
                    {getRecurrenceDescription(editingDateChip.selectedDate, editingDateChip.recurrence,)}
                  </div>
                )}
              </div>
              <div className="mention-date-picker-actions">
                <button
                  className="mention-date-picker-btn mention-date-picker-btn-muted"
                  onClick={closeDateChipEditor}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="mention-date-picker-btn"
                  disabled={!editingDateChip.selectedDate}
                  onClick={applyDateChipEdit}
                  type="button"
                >
                  Update
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  },
);

export default EditableNote;
