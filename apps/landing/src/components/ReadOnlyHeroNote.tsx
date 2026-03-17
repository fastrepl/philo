import { mergeAttributes, Node, } from "@tiptap/core";
import type { JSONContent, } from "@tiptap/react";
import { EditorContent, useEditor, } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import "../../../../vendor/hyprnote/packages/tiptap/styles.css";
import "./ReadOnlyHeroNote.css";

const HeroPlaceholderExtension = Node.create({
  name: "heroPlaceholder",
  group: "block",
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      width: {
        default: "wide",
      },
      gap: {
        default: "default",
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-hero-placeholder]", },];
  },

  renderHTML({ HTMLAttributes, },) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-hero-placeholder": "",
        class: `hero-placeholder hero-placeholder-${String(HTMLAttributes.width ?? "wide",)} hero-placeholder-gap-${
          String(HTMLAttributes.gap ?? "default",)
        }`,
      },),
    ];
  },
},);

const HeroTaskRowExtension = Node.create({
  name: "heroTaskRow",
  group: "block",
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      width: {
        default: "wide",
      },
      gap: {
        default: "default",
      },
      indent: {
        default: "none",
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-hero-task-row]", },];
  },

  renderHTML({ HTMLAttributes, },) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-hero-task-row": "",
        class: `hero-task-row hero-task-row-${String(HTMLAttributes.width ?? "wide",)} hero-task-row-gap-${
          String(HTMLAttributes.gap ?? "default",)
        } hero-task-row-indent-${String(HTMLAttributes.indent ?? "none",)}`,
      },),
      ["span", { class: "hero-task-box", },],
      ["span", { class: "hero-task-line", },],
    ];
  },
},);

function toLocalDateString(date: Date,): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1,).padStart(2, "0",)}-${
    String(date.getDate(),).padStart(2, "0",)
  }`;
}

function getToday(): string {
  return toLocalDateString(new Date(),);
}

function ordinalSuffix(day: number,): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function formatDate(dateStr: string,): string {
  const date = new Date(`${dateStr}T00:00:00`,);
  const month = date.toLocaleDateString("en-US", { month: "long", },);
  const day = date.getDate();
  return `${month} ${day}${ordinalSuffix(day,)}`;
}

function buildNoteDocument(): JSONContent {
  return {
    type: "doc",
    content: [
      { type: "heroPlaceholder", attrs: { width: "medium", }, },
      { type: "heroPlaceholder", attrs: { width: "wide", }, },
      { type: "heroPlaceholder", attrs: { width: "short", gap: "section", }, },
      { type: "heroPlaceholder", attrs: { width: "wide", }, },
      { type: "heroPlaceholder", attrs: { width: "wide", }, },
      { type: "heroPlaceholder", attrs: { width: "medium", }, },
      { type: "heroTaskRow", attrs: { width: "wide", gap: "section", }, },
      { type: "heroTaskRow", attrs: { width: "medium", }, },
      { type: "heroTaskRow", attrs: { width: "full", }, },
      { type: "heroTaskRow", attrs: { width: "wide", indent: "nested", }, },
    ],
  };
}

export default function ReadOnlyHeroNote() {
  const today = getToday();

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
      },),
      HeroPlaceholderExtension,
      HeroTaskRowExtension,
    ],
    content: buildNoteDocument(),
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "tiptap hero-note-editor",
      },
    },
  },);

  return (
    <section className="hero-note-shell" aria-label="Read-only Philo note demo">
      <div className="hero-note-titlebar" aria-hidden="true">
        <div className="hero-note-dots">
          <span />
          <span />
          <span />
        </div>
        <svg className="hero-note-pin" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z" />
        </svg>
      </div>

      <div className="hero-note-surface">
        <div className="hero-note-header">
          <p className="hero-note-date">{formatDate(today,)}</p>
          <span className="hero-note-pill">TODAY</span>
          <span className="hero-note-city">Seoul</span>
        </div>

        <EditorContent editor={editor} />
      </div>
    </section>
  );
}
