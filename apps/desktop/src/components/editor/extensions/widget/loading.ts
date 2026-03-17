import type { Spec, } from "@json-render/core";

export function buildLoadingWidgetSpec(prompt: string, phase: "building" | "refreshing",): Spec {
  return {
    root: "card",
    elements: {
      card: {
        type: "Card",
        props: { padding: "md", },
        children: ["stack",],
      },
      stack: {
        type: "Stack",
        props: { gap: "sm", },
        children: ["status", "prompt", "detail",],
      },
      status: {
        type: "Badge",
        props: {
          text: phase === "building" ? "Building" : "Refreshing",
          variant: "info",
        },
      },
      prompt: {
        type: "Text",
        props: {
          content: prompt,
          size: "sm",
          weight: "medium",
        },
      },
      detail: {
        type: "Text",
        props: {
          content: phase === "building"
            ? "You can keep working while Sophia turns this into a widget."
            : "You can keep working while Sophia updates this widget.",
          size: "xs",
          color: "muted",
        },
      },
    },
  };
}

export function waitForNextPaint(): Promise<void> {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }

  return new Promise((resolve,) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    },);
  },);
}
