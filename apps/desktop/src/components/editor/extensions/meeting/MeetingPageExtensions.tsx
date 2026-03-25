import { mergeAttributes, Node, } from "@tiptap/core";
import type { JSONContent, } from "@tiptap/core";
import { Plugin, } from "@tiptap/pm/state";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, } from "@tiptap/react";
import type { NodeViewProps, } from "@tiptap/react";
import type { MeetingSessionKind, PageNote, } from "../../../../types/note";

type MeetingMetaAttributes = {
  startedAt: string;
  endedAt: string;
  location: string;
  sessionKind: MeetingSessionKind | "";
  participants: string[];
};

export const ALLOW_READ_ONLY_TRANSCRIPT_UPDATE_META = "allowReadOnlyTranscriptUpdate";

function formatDateTime(value: string,) {
  const date = new Date(value,);
  if (Number.isNaN(date.getTime(),)) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },);
}

function formatTime(value: string,) {
  const date = new Date(value,);
  if (Number.isNaN(date.getTime(),)) return value;
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  },);
}

function isSameDay(left: string, right: string,) {
  const leftDate = new Date(left,);
  const rightDate = new Date(right,);
  if (Number.isNaN(leftDate.getTime(),) || Number.isNaN(rightDate.getTime(),)) return false;
  return leftDate.getFullYear() === rightDate.getFullYear()
    && leftDate.getMonth() === rightDate.getMonth()
    && leftDate.getDate() === rightDate.getDate();
}

function formatDateTimeRange(startedAt: string, endedAt: string,) {
  if (!startedAt) return endedAt ? formatDateTime(endedAt,) : "";
  if (!endedAt) return formatDateTime(startedAt,);
  if (isSameDay(startedAt, endedAt,)) {
    return `${formatDateTime(startedAt,)} ~ ${formatTime(endedAt,)}`;
  }
  return `${formatDateTime(startedAt,)} ~ ${formatDateTime(endedAt,)}`;
}

function parseParticipants(value: string | null,) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value,) as unknown;
    return Array.isArray(parsed,)
      ? parsed.filter((entry,): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function getNodeText(node: JSONContent | undefined,): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content,)) return "";
  return node.content.map((child,) => getNodeText(child,)).join("",);
}

function createHeading(level: number, text: string,): JSONContent {
  return {
    type: "heading",
    attrs: { level, },
    content: [{ type: "text", text, },],
  };
}

const MEETING_CAPTURE_HEADINGS = new Set(["Summary", "Decisions", "Action Items", "Key Takeaways", "Transcript",],);

function getHeadingLabel(node: JSONContent,) {
  return node.type === "heading" ? getNodeText(node,).trim() : "";
}

function isMeetingCaptureHeading(node: JSONContent,) {
  return MEETING_CAPTURE_HEADINGS.has(getHeadingLabel(node,),);
}

function isMeetingPage(note: unknown,): note is PageNote {
  return !!note
    && typeof note === "object"
    && !("date" in note)
    && "type" in note
    && note.type === "meeting";
}

function createMeetingMetaNode(note: PageNote,): JSONContent | null {
  const attrs: MeetingMetaAttributes = {
    startedAt: note.startedAt ?? "",
    endedAt: note.endedAt ?? "",
    location: note.location ?? "",
    sessionKind: note.sessionKind ?? "",
    participants: note.participants,
  };

  if (!attrs.startedAt && !attrs.endedAt && !attrs.location && !attrs.sessionKind && attrs.participants.length === 0) {
    return null;
  }

  return {
    type: "meetingMeta",
    attrs,
  };
}

function normalizeDoc(doc: JSONContent,) {
  return doc.type === "doc" && Array.isArray(doc.content,) ? doc.content : [];
}

function trimTrailingEmptyParagraphs(content: JSONContent[],) {
  const trimmed = [...content,];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (last?.type !== "paragraph" || getNodeText(last,).trim()) {
      break;
    }
    trimmed.pop();
  }
  return trimmed;
}

export function decorateMeetingPageDoc(
  note: PageNote | unknown,
  doc: JSONContent,
  options?: { transcriptReadOnly?: boolean; },
) {
  if (!isMeetingPage(note,)) return doc;

  const source = normalizeDoc(doc,).filter((node,) => node.type !== "meetingMeta" && node.type !== "meetingTranscript");
  const transcriptHeadingIndices = source
    .map((node, index,) => getHeadingLabel(node,) === "Transcript" ? index : -1)
    .filter((index,) => index >= 0);

  const staleTranscriptIndexes = new Set<number>();
  for (const transcriptIndex of transcriptHeadingIndices.slice(0, -1,)) {
    let endIndex = source.length;
    for (let index = transcriptIndex + 1; index < source.length; index += 1) {
      if (isMeetingCaptureHeading(source[index],)) {
        endIndex = index;
        break;
      }
    }

    for (let index = transcriptIndex; index < endIndex; index += 1) {
      staleTranscriptIndexes.add(index,);
    }
  }

  const normalizedSource = source.filter((_, index,) => !staleTranscriptIndexes.has(index,));

  let transcriptHeadingIndex = -1;
  for (let index = normalizedSource.length - 1; index >= 0; index -= 1) {
    if (getHeadingLabel(normalizedSource[index],) === "Transcript") {
      transcriptHeadingIndex = index;
      break;
    }
  }

  const content = transcriptHeadingIndex === -1
    ? [...normalizedSource,]
    : [
      ...normalizedSource.slice(0, transcriptHeadingIndex,),
      {
        type: "meetingTranscript",
        attrs: {
          readOnly: options?.transcriptReadOnly === true,
        },
        content: normalizedSource.slice(transcriptHeadingIndex + 1,),
      } satisfies JSONContent,
    ];

  const meetingMetaNode = createMeetingMetaNode(note,);
  return {
    type: "doc",
    content: meetingMetaNode ? [meetingMetaNode, ...content,] : content,
  } satisfies JSONContent;
}

export function stripMeetingPageDoc(note: PageNote | unknown, doc: JSONContent,) {
  if (!isMeetingPage(note,)) return doc;

  const content: JSONContent[] = [];
  for (const node of normalizeDoc(doc,)) {
    if (node.type === "meetingMeta") {
      continue;
    }

    if (node.type === "meetingTranscript") {
      content.push(
        createHeading(2, "Transcript",),
        ...trimTrailingEmptyParagraphs(Array.isArray(node.content,) ? node.content : [],),
      );
      continue;
    }

    content.push(node,);
  }

  return {
    type: "doc",
    content,
  } satisfies JSONContent;
}

function MeetingMetaView({ node, }: NodeViewProps,) {
  const attrs = node.attrs as MeetingMetaAttributes;
  const rows = [
    attrs.startedAt || attrs.endedAt
      ? {
        label: "Time",
        value: formatDateTimeRange(attrs.startedAt, attrs.endedAt,),
      }
      : null,
    attrs.location ? { label: "Location", value: attrs.location, } : null,
    attrs.participants.length > 0 ? { label: "People", value: attrs.participants.join(", ",), } : null,
  ].filter((row,): row is { label: string; value: string; } => row !== null);

  return (
    <NodeViewWrapper className="meeting-meta-node" contentEditable={false}>
      <div className="meeting-meta-node__grid">
        {rows.map((row,) => (
          <div key={row.label} className="meeting-meta-node__row">
            <span className="meeting-meta-node__key">{row.label}</span>
            <span className="meeting-meta-node__value">{row.value}</span>
          </div>
        ))}
      </div>
    </NodeViewWrapper>
  );
}

function MeetingTranscriptView({ node, }: NodeViewProps,) {
  const readOnly = node.attrs.readOnly === true;
  return (
    <NodeViewWrapper className={`meeting-transcript-node ${readOnly ? "meeting-transcript-node--readonly" : ""}`}>
      <div className="meeting-transcript-node__label" contentEditable={false}>
        Transcript
      </div>
      <NodeViewContent className="meeting-transcript-node__content" />
    </NodeViewWrapper>
  );
}

function transactionTouchesReadOnlyTranscript(
  oldDoc: import("@tiptap/pm/model").Node,
  newDoc: import("@tiptap/pm/model").Node,
  mapping: import("@tiptap/pm/transform").Mapping,
) {
  let blocked = false;

  oldDoc.descendants((node, pos,) => {
    if (blocked || node.type.name !== "meetingTranscript" || node.attrs.readOnly !== true) {
      return !blocked;
    }

    const mappedPos = mapping.map(pos, -1,);
    const nextNode = newDoc.nodeAt(mappedPos,);
    if (!nextNode || !node.eq(nextNode,)) {
      blocked = true;
      return false;
    }

    return true;
  },);

  return blocked;
}

export const MeetingMetaExtension = Node.create({
  name: "meetingMeta",
  group: "block",
  atom: true,
  selectable: false,
  draggable: false,

  renderMarkdown() {
    return "";
  },

  addAttributes() {
    return {
      startedAt: {
        default: "",
        parseHTML: (element: HTMLElement,) => element.getAttribute("data-started-at",) ?? "",
      },
      endedAt: {
        default: "",
        parseHTML: (element: HTMLElement,) => element.getAttribute("data-ended-at",) ?? "",
      },
      location: {
        default: "",
        parseHTML: (element: HTMLElement,) => element.getAttribute("data-location",) ?? "",
      },
      sessionKind: {
        default: "",
        parseHTML: (element: HTMLElement,) => element.getAttribute("data-session-kind",) ?? "",
      },
      participants: {
        default: [],
        parseHTML: (element: HTMLElement,) => parseParticipants(element.getAttribute("data-participants",),),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-meeting-meta]", },];
  },

  renderHTML({ HTMLAttributes, },) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-meeting-meta": "",
        "data-started-at": String(HTMLAttributes.startedAt ?? "",),
        "data-ended-at": String(HTMLAttributes.endedAt ?? "",),
        "data-location": String(HTMLAttributes.location ?? "",),
        "data-session-kind": String(HTMLAttributes.sessionKind ?? "",),
        "data-participants": JSON.stringify(HTMLAttributes.participants ?? [],),
      },),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MeetingMetaView,);
  },
},);

export const MeetingTranscriptExtension = Node.create({
  name: "meetingTranscript",
  group: "block",
  content: "block*",
  defining: true,
  isolating: true,

  renderMarkdown(node: JSONContent, helpers,) {
    const body = helpers.renderChildren(node,).trim();
    return body ? `## Transcript\n\n${body}\n\n` : "## Transcript\n\n";
  },

  parseHTML() {
    return [{ tag: "div[data-meeting-transcript]", },];
  },

  renderHTML({ HTMLAttributes, },) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-meeting-transcript": "", },), 0,];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MeetingTranscriptView,);
  },

  addAttributes() {
    return {
      readOnly: {
        default: false,
        rendered: false,
        parseHTML: (element: HTMLElement,) => element.getAttribute("data-read-only",) === "true",
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (transaction, state,) => {
          if (!transaction.docChanged) return true;
          if (transaction.getMeta(ALLOW_READ_ONLY_TRANSCRIPT_UPDATE_META,) === true) {
            return true;
          }
          return !transactionTouchesReadOnlyTranscript(state.doc, transaction.doc, transaction.mapping,);
        },
      },),
    ];
  },
},);
