import { getRenderedAttributes, type JSONContent, mergeAttributes, } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";

export interface TaskItemAttributes {
  taskId?: string;
  originDate?: string;
  checked: boolean;
}

function hasNestedListChildren(node: JSONContent,) {
  if (!Array.isArray(node.content,) || node.content.length === 0) {
    return false;
  }

  return node.content.some((child,) =>
    child?.type === "bulletList" || child?.type === "orderedList" || child?.type === "taskList"
  );
}

function trimNestedParagraphIndentation(node: JSONContent,): JSONContent {
  if (node.type !== "paragraph" || !Array.isArray(node.content,) || node.content.length === 0) {
    return node;
  }

  const content = [...node.content,];

  while (content[0]?.type === "text" && typeof content[0].text === "string") {
    const trimmed = content[0].text.replace(/^[ \t]+/, "",);

    if (trimmed.length === 0) {
      content.shift();
      continue;
    }

    if (trimmed !== content[0].text) {
      content[0] = { ...content[0], text: trimmed, };
    }
    break;
  }

  return content.length > 0 ? { ...node, content, } : { type: "paragraph", };
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

  parseMarkdown: (token, helpers,) => {
    const content = [];

    if (token.tokens && token.tokens.length > 0) {
      content.push(helpers.createNode("paragraph", undefined, helpers.parseInline(token.tokens,),),);
    } else if (token.text) {
      content.push(helpers.createNode("paragraph", undefined, [helpers.createTextNode(token.text,),],),);
    } else {
      content.push(helpers.createNode("paragraph", undefined, [],),);
    }

    const nestedTokens = token.nestedTokens || [];
    if (nestedTokens.length > 0) {
      let nestedStart = 0;

      if (nestedTokens[0]?.type === "space") {
        const leadingNewlines = (nestedTokens[0].raw?.match(/\n/g,) || []).length;
        for (let i = 1; i < leadingNewlines; i += 1) {
          content.push(helpers.createNode("paragraph", undefined, [],),);
        }
        nestedStart = 1;
      }

      if (nestedStart < nestedTokens.length) {
        content.push(
          ...helpers.parseChildren(nestedTokens.slice(nestedStart,),).map(trimNestedParagraphIndentation,),
        );
      }
    }

    return helpers.createNode("taskItem", { checked: token.checked || false, }, content,);
  },

  addNodeView() {
    return ({ node, HTMLAttributes, getPos, editor, },) => {
      const listItem = document.createElement("li",);
      const label = document.createElement("label",);
      const checkboxStyler = document.createElement("span",);
      const toggle = document.createElement("button",);
      const checkbox = document.createElement("input",);
      const content = document.createElement("div",);
      let currentNode = node.toJSON();
      let isCollapsed = false;

      const isNestedTaskItem = () => {
        if (typeof getPos !== "function") {
          return false;
        }

        const pos = getPos();
        if (typeof pos !== "number") {
          return false;
        }

        const resolvedPos = editor.state.doc.resolve(pos,);
        for (let depth = resolvedPos.depth - 1; depth > 0; depth -= 1) {
          if (resolvedPos.node(depth,).type.name === "taskItem") {
            return true;
          }
        }

        return false;
      };

      const syncNestedDomState = (hasNestedChildren: boolean,) => {
        queueMicrotask(() => {
          Array.from(content.children,).forEach((child,) => {
            if (child instanceof HTMLUListElement || child instanceof HTMLOListElement) {
              child.hidden = hasNestedChildren && isCollapsed;
            }
          },);
        },);
      };

      const syncNestedState = (nextNode: JSONContent,) => {
        const hasNestedChildren = hasNestedListChildren(nextNode,);
        const canToggleNestedChildren = hasNestedChildren && !isNestedTaskItem();
        listItem.classList.toggle("task-item--has-children", canToggleNestedChildren,);

        if (!canToggleNestedChildren) {
          isCollapsed = false;
        }

        listItem.classList.toggle("task-item--collapsed", canToggleNestedChildren && isCollapsed,);
        toggle.disabled = !canToggleNestedChildren;
        toggle.contentEditable = "false";
        toggle.setAttribute("aria-hidden", canToggleNestedChildren ? "false" : "true",);
        toggle.setAttribute("aria-label", isCollapsed ? "Expand nested items" : "Collapse nested items",);
        toggle.setAttribute("aria-expanded", canToggleNestedChildren ? (!isCollapsed).toString() : "false",);
        syncNestedDomState(canToggleNestedChildren,);
      };

      toggle.type = "button";
      toggle.tabIndex = -1;
      toggle.className = "task-item-toggle";
      toggle.setAttribute("aria-hidden", "true",);
      toggle.innerHTML = [
        '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">',
        '<path d="m7 4 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />',
        "</svg>",
      ].join("",);
      const handleToggle = (event: MouseEvent | PointerEvent,) => {
        event.preventDefault();
        event.stopPropagation();
        if (toggle.disabled) {
          return;
        }

        isCollapsed = !isCollapsed;
        syncNestedState(currentNode,);
      };
      toggle.addEventListener("pointerdown", handleToggle,);
      toggle.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
      },);

      checkbox.type = "checkbox";
      checkbox.checked = node.attrs.checked;
      checkbox.addEventListener("mousedown", (event,) => {
        event.preventDefault();
      },);

      checkbox.addEventListener("change", () => {
        if (typeof getPos === "function") {
          editor.commands.command(({ tr, },) => {
            const pos = getPos();
            if (pos == null) return false;
            const attrs = typeof currentNode.attrs === "object" && currentNode.attrs
              ? currentNode.attrs
              : node.attrs;
            tr.setNodeMarkup(pos, undefined, {
              ...attrs,
              checked: checkbox.checked,
            },);
            return true;
          },);
        }
      },);

      listItem.dataset.checked = String(node.attrs.checked,);
      label.contentEditable = "false";
      label.appendChild(checkbox,);
      label.appendChild(checkboxStyler,);
      listItem.appendChild(toggle,);
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

      let prevRenderedAttributeKeys = new Set(Object.keys(HTMLAttributes,),);
      syncNestedState(currentNode,);

      return {
        dom: listItem,
        contentDOM: content,
        stopEvent: event => {
          const target = event.target;
          return target instanceof Node && (toggle.contains(target,) || checkbox.contains(target,));
        },
        update: (updatedNode,) => {
          if (updatedNode.type !== this.type) {
            return false;
          }

          listItem.dataset.checked = String(updatedNode.attrs.checked,);
          checkbox.checked = updatedNode.attrs.checked;
          currentNode = updatedNode.toJSON();
          const extensionAttributes = editor.extensionManager.attributes;
          const newHTMLAttributes = getRenderedAttributes(updatedNode, extensionAttributes,);
          const newKeys = new Set(Object.keys(newHTMLAttributes,),);
          const staticAttrs = this.options.HTMLAttributes as Record<string, string>;

          prevRenderedAttributeKeys.forEach(key => {
            if (!newKeys.has(key,)) {
              if (key in staticAttrs) {
                listItem.setAttribute(key, staticAttrs[key],);
              } else {
                listItem.removeAttribute(key,);
              }
            }
          },);

          Object.entries(newHTMLAttributes,).forEach(([key, value,],) => {
            if (value == null) {
              if (key in staticAttrs) {
                listItem.setAttribute(key, staticAttrs[key],);
              } else {
                listItem.removeAttribute(key,);
              }
              return;
            }

            listItem.setAttribute(key, value as string,);
          },);

          prevRenderedAttributeKeys = newKeys;
          syncNestedState(currentNode,);
          return true;
        },
      };
    };
  },
},);
