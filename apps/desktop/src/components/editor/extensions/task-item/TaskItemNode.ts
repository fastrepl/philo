import { mergeAttributes, } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";

export interface TaskItemAttributes {
  taskId?: string;
  originDate?: string;
  checked: boolean;
}

export const CustomTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      taskId: {
        default: null,
        parseHTML: element => element.getAttribute("data-task-id",),
        renderHTML: attributes => {
          if (!attributes.taskId) {
            return {};
          }
          return {
            "data-task-id": attributes.taskId,
          };
        },
      },
      originDate: {
        default: null,
        parseHTML: element => element.getAttribute("data-origin-date",),
        renderHTML: attributes => {
          if (!attributes.originDate) {
            return {};
          }
          return {
            "data-origin-date": attributes.originDate,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `li[data-type="${this.name}"]`,
        priority: 51,
      },
    ];
  },

  renderHTML({ node, HTMLAttributes, },) {
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
      "data-type": this.name,
    },);

    return [
      "li",
      attrs,
      [
        "label",
        [
          "input",
          {
            type: "checkbox",
            checked: node.attrs.checked ? "checked" : null,
          },
        ],
        ["span", 0,],
      ],
    ];
  },

  addNodeView() {
    return ({ node, HTMLAttributes, getPos, editor, },) => {
      const listItem = document.createElement("li",);
      const label = document.createElement("label",);
      const checkbox = document.createElement("input",);
      const content = document.createElement("div",);

      checkbox.type = "checkbox";
      checkbox.checked = node.attrs.checked;

      checkbox.addEventListener("change", () => {
        if (typeof getPos === "function") {
          editor.commands.command(({ tr, },) => {
            const pos = getPos();
            if (pos == null) return false;
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              checked: checkbox.checked,
            },);
            return true;
          },);
        }
      },);

      label.contentEditable = "false";
      label.appendChild(checkbox,);
      listItem.appendChild(label,);
      listItem.appendChild(content,);

      // Add rollover badge if originDate exists
      if (node.attrs.originDate && node.attrs.originDate !== node.attrs.checked) {
        const badge = document.createElement("span",);
        badge.textContent = `from ${node.attrs.originDate}`;
        badge.style.cssText = "font-size: 0.75rem; color: #9ca3af; margin-left: 0.5rem;";
        label.appendChild(badge,);
      }

      Object.entries(HTMLAttributes,).forEach(([key, value,],) => {
        listItem.setAttribute(key, value as string,);
      },);

      return {
        dom: listItem,
        contentDOM: content,
        update: (updatedNode,) => {
          if (updatedNode.type !== this.type) {
            return false;
          }
          checkbox.checked = updatedNode.attrs.checked;
          return true;
        },
      };
    };
  },
},);
