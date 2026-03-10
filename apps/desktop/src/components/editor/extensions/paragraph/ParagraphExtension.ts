import { Paragraph, } from "@tiptap/extension-paragraph";

const EMPTY_MARKER = "\u200B";

export const CustomParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers,) => {
    const tokens = token.tokens || [];

    const content = helpers.parseInline(tokens,);

    if (
      content.length === 1
      && content[0].type === "text"
      && (content[0].text === EMPTY_MARKER || content[0].text === "&nbsp;" || content[0].text === "\u00A0")
    ) {
      return helpers.createNode("paragraph", undefined, [],);
    }

    return helpers.createNode("paragraph", undefined, content,);
  },

  renderMarkdown: (node, helpers,) => {
    return helpers.renderChildren(node.content || [],);
  },
},);
