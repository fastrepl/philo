import { mergeAttributes, Node, } from "@tiptap/core";
import type { JSONContent, } from "@tiptap/core";
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

function formatSessionKind(value: MeetingSessionKind | "",) {
  switch (value) {
    case "decision_making":
      return "Decision-making";
    case "informative":
      return "Informative";
    default:
      return "";
  }
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

export function decorateMeetingPageDoc(note: PageNote | unknown, doc: JSONContent,) {
  if (!isMeetingPage(note,)) return doc;

  const source = normalizeDoc(doc,).filter((node,) => node.type !== "meetingMeta" && node.type !== "meetingTranscript");
  const transcriptHeadingIndex = source.findIndex((node,) =>
    node.type === "heading" && getNodeText(node,).trim() === "Transcript"
  );

  const content = transcriptHeadingIndex === -1
    ? [...source,]
    : [
      ...source.slice(0, transcriptHeadingIndex,),
      {
        type: "meetingTranscript",
        content: source.slice(transcriptHeadingIndex + 1,),
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
      content.push(createHeading(2, "Transcript",), ...(Array.isArray(node.content,) ? node.content : []),);
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
    attrs.startedAt ? { label: "Started", value: formatDateTime(attrs.startedAt,), } : null,
    attrs.endedAt ? { label: "Ended", value: formatDateTime(attrs.endedAt,), } : null,
    attrs.location ? { label: "Location", value: attrs.location, } : null,
    attrs.sessionKind ? { label: "Type", value: formatSessionKind(attrs.sessionKind,), } : null,
    attrs.participants.length > 0 ? { label: "People", value: attrs.participants.join(", ",), } : null,
  ].filter((row,): row is { label: string; value: string; } => row !== null);

  return (
    <NodeViewWrapper className="meeting-meta-node" contentEditable={false}>
      <div className="meeting-meta-node__label">Meeting info</div>
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

function MeetingTranscriptView() {
  return (
    <NodeViewWrapper className="meeting-transcript-node">
      <div className="meeting-transcript-node__label" contentEditable={false}>
        Transcript
      </div>
      <NodeViewContent className="meeting-transcript-node__content" />
    </NodeViewWrapper>
  );
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
},);
