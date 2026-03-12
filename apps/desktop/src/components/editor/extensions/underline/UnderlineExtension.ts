import Underline from "@tiptap/extension-underline";

export const UnderlineExtension = Underline.extend({
  renderMarkdown(node, helpers,) {
    return `<u>${helpers.renderChildren(node,)}</u>`;
  },
},);
