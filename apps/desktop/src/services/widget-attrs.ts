const ENCODED_WIDGET_ATTR_PREFIX = "__philo_encoded__:";

export function escapeWidgetHtmlAttr(value: string,): string {
  return value
    .replace(/&/g, "&amp;",)
    .replace(/"/g, "&quot;",)
    .replace(/</g, "&lt;",)
    .replace(/>/g, "&gt;",);
}

export function encodeWidgetDataAttr(value: string,): string {
  return `${ENCODED_WIDGET_ATTR_PREFIX}${encodeURIComponent(value,)}`;
}

export function decodeWidgetDataAttr(value: string | null | undefined,): string {
  if (!value) return "";
  if (!value.startsWith(ENCODED_WIDGET_ATTR_PREFIX,)) {
    return value;
  }

  try {
    return decodeURIComponent(value.slice(ENCODED_WIDGET_ATTR_PREFIX.length,),);
  } catch {
    return value;
  }
}

export function compactWidgetSpec(spec: string,): string {
  try {
    return JSON.stringify(JSON.parse(spec,),);
  } catch {
    return spec;
  }
}
