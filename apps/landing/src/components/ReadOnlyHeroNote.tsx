import { mergeAttributes, Node, } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import type { JSONContent, } from "@tiptap/react";
import { EditorContent, useEditor, } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import "../../../../vendor/hyprnote/packages/tiptap/styles.css";
import "./ReadOnlyHeroNote.css";

const HeroChipExtension = Node.create({
  name: "heroChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      label: {
        default: "",
      },
      tone: {
        default: "today",
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-hero-chip]", },];
  },

  renderHTML({ HTMLAttributes, },) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-hero-chip": "",
        class: `hero-chip hero-chip-${String(HTMLAttributes.tone ?? "today",)}`,
      },),
      String(HTMLAttributes.label ?? "",),
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

function getDaysFromNow(days: number,): string {
  const date = new Date();
  date.setDate(date.getDate() + days,);
  return toLocalDateString(date,);
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

function buildLink(text: string,): JSONContent {
  return {
    type: "text",
    text,
    marks: [
      {
        type: "link",
        attrs: {
          href: text,
        },
      },
    ],
  };
}

function buildChip(label: string, tone: "today" | "date",): JSONContent {
  return {
    type: "heroChip",
    attrs: {
      label,
      tone,
    },
  };
}

function buildNoteDocument(dueDate: string,): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "couldn't agree more", },],
      },
      {
        type: "paragraph",
        content: [buildLink("https://www.youtube.com/watch?v=ZJEnQ0sMt-sU",),],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "might be a good idea for marketing website", },],
      },
      {
        type: "paragraph",
        content: [buildLink("https://x.com/RomaTesla/status/2033528717155373390?s=20",),],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "nice tool ", },
          buildLink("https://dither.neato.fun",),
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text:
              "distribution & development. after coming back from america, keep the work moving without rebuilding the list from scratch.",
          },
        ],
      },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false, },
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "study remotion skills ", },
                  buildChip("Today", "today",),
                ],
              },
            ],
          },
          {
            type: "taskItem",
            attrs: { checked: false, },
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "export the Hilton reservation ", },
                  buildChip("Today", "today",),
                ],
              },
            ],
          },
          {
            type: "taskItem",
            attrs: { checked: false, },
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "finish q2 planning",
                    marks: [{ type: "bold", },],
                  },
                  { type: "text", text: " to prepare for the next quarter ", },
                  buildChip(formatDate(dueDate,), "date",),
                ],
              },
              {
                type: "taskList",
                content: [
                  {
                    type: "taskItem",
                    attrs: { checked: false, },
                    content: [
                      {
                        type: "paragraph",
                        content: [
                          {
                            type: "text",
                            text: "create the document and wire up a deterministic report script",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

export default function ReadOnlyHeroNote() {
  const today = getToday();
  const dueDate = getDaysFromNow(3,);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
      },),
      Link.configure({
        openOnClick: false,
        autolink: false,
      },),
      TaskList,
      TaskItem.configure({ nested: true, },),
      HeroChipExtension,
    ],
    content: buildNoteDocument(dueDate,),
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
      <div className="hero-note-surface">
        <div className="hero-note-header">
          <p className="hero-note-date">{formatDate(today,)}</p>
          <span className="hero-note-pill">Today</span>
          <span className="hero-note-city">Seoul</span>
        </div>

        <EditorContent editor={editor} />
      </div>
    </section>
  );
}
