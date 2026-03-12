import { defineCatalog, } from "@json-render/core";
import { schema, } from "@json-render/react";
import { z, } from "zod";

export const widgetCatalog = defineCatalog(schema, {
  components: {
    Card: {
      props: z.object({
        title: z.string().optional(),
        padding: z.enum(["none", "sm", "md", "lg",],).optional(),
      },),
      description: "A container card with optional title and padding. Use as the top-level wrapper.",
    },
    Stack: {
      props: z.object({
        direction: z.enum(["vertical", "horizontal",],).optional(),
        gap: z.enum(["none", "xs", "sm", "md", "lg",],).optional(),
        align: z.enum(["start", "center", "end", "stretch",],).optional(),
        justify: z.enum(["start", "center", "end", "between", "around",],).optional(),
        wrap: z.boolean().optional(),
      },),
      description: "Flex layout container. Arranges children vertically or horizontally with gap.",
    },
    Grid: {
      props: z.object({
        columns: z.number().optional(),
        gap: z.enum(["none", "xs", "sm", "md", "lg",],).optional(),
      },),
      description: "Grid layout with N columns.",
    },
    Text: {
      props: z.object({
        content: z.string(),
        size: z.enum(["xs", "sm", "md", "lg", "xl",],).optional(),
        weight: z.enum(["normal", "medium", "semibold", "bold",],).optional(),
        color: z.enum(["default", "muted", "accent", "success", "warning", "error",],).optional(),
        align: z.enum(["left", "center", "right",],).optional(),
      },),
      description: "Display text with size, weight, and color options.",
    },
    Heading: {
      props: z.object({
        content: z.string(),
        level: z.enum(["h1", "h2", "h3",],).optional(),
      },),
      description: "A heading/title element.",
    },
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        unit: z.string().optional(),
        trend: z.enum(["up", "down", "flat",],).optional(),
      },),
      description: "Display a key metric with label, value, optional unit and trend indicator.",
    },
    Badge: {
      props: z.object({
        text: z.string(),
        variant: z.enum(["default", "success", "warning", "error", "info",],).optional(),
      },),
      description: "Small status badge/chip.",
    },
    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(["primary", "secondary", "ghost",],).optional(),
        size: z.enum(["sm", "md", "lg",],).optional(),
        mutation: z.string().optional(),
      },),
      description: "Clickable button with label.",
    },
    TextInput: {
      props: z.object({
        placeholder: z.string().optional(),
        label: z.string().optional(),
        query: z.string().optional(),
        bindColumn: z.string().optional(),
        mutation: z.string().optional(),
        value: z.string().optional(),
      },),
      description: "Text input field, optionally backed by a query and mutation.",
    },
    Checkbox: {
      props: z.object({
        label: z.string(),
        query: z.string().optional(),
        bindColumn: z.string().optional(),
        mutation: z.string().optional(),
        checked: z.boolean().optional(),
      },),
      description: "Checkbox with label, optionally backed by a query and mutation.",
    },
    ProgressBar: {
      props: z.object({
        value: z.number(),
        max: z.number().optional(),
        color: z.enum(["default", "success", "warning", "error", "accent",],).optional(),
        showLabel: z.boolean().optional(),
      },),
      description: "Progress bar showing completion. Value 0-100 (or 0-max).",
    },
    Divider: {
      props: z.object({},),
      description: "Horizontal divider/separator line.",
    },
    Spacer: {
      props: z.object({
        size: z.enum(["xs", "sm", "md", "lg", "xl",],).optional(),
      },),
      description: "Vertical spacing element.",
    },
    Image: {
      props: z.object({
        src: z.string(),
        alt: z.string().optional(),
        rounded: z.boolean().optional(),
      },),
      description: "Display an image.",
    },
    List: {
      props: z.object({
        items: z.array(z.object({
          label: z.string(),
          description: z.string().optional(),
          trailing: z.string().optional(),
        },),),
        query: z.string().optional(),
        labelColumn: z.string().optional(),
        descriptionColumn: z.string().optional(),
        trailingColumn: z.string().optional(),
        variant: z.enum(["plain", "bordered", "striped",],).optional(),
      },),
      description: "A list of items with label, optional description, and trailing text.",
    },
    Table: {
      props: z.object({
        headers: z.array(z.string(),).optional(),
        rows: z.array(z.array(z.string(),),).optional(),
        query: z.string().optional(),
        columns: z.array(z.object({
          header: z.string(),
          field: z.string(),
        },),).optional(),
      },),
      description: "Simple data table with either static rows or rows from a query.",
    },
  },
  actions: {},
},);
