import type { Spec, } from "@json-render/core";
import { API_KEY_MISSING, generateAiText, } from "./ai";
import type { SharedStorageSchema, } from "./library";
import { loadSettings, resolveActiveAiConfig, } from "./settings";

const SYSTEM_PROMPT = `You are Sophia, an AI that generates Philo widgets with storage metadata.

Return ONLY a single JSON object with this exact shape:
{
  "uiSpec": {
    "root": "<root-element-id>",
    "elements": {
      "<element-id>": {
        "type": "<ComponentName>",
        "props": { ... },
        "children": ["<child-id-1>", "<child-id-2>"]
      }
    }
  },
  "storageSchema": {
    "tables": [],
    "namedQueries": [],
    "namedMutations": []
  }
}

- Every element needs a unique string ID.
- "children" is an array of element ID strings. Use [] for leaf nodes.
- "root" is the ID of the top-level element.

Supported UI components:
- Card { title?: string, padding?: "none"|"sm"|"md"|"lg" }
- Stack { direction?: "vertical"|"horizontal", gap?: "none"|"xs"|"sm"|"md"|"lg", align?: "start"|"center"|"end"|"stretch", justify?: "start"|"center"|"end"|"between"|"around", wrap?: boolean }
- Grid { columns?: number, gap?: "none"|"xs"|"sm"|"md"|"lg" }
- Divider {}
- Spacer { size?: "xs"|"sm"|"md"|"lg"|"xl" }
- Text { content: string, size?: "xs"|"sm"|"md"|"lg"|"xl", weight?: "normal"|"medium"|"semibold"|"bold", color?: "default"|"muted"|"accent"|"success"|"warning"|"error", align?: "left"|"center"|"right" }
- Heading { content: string, level?: "h1"|"h2"|"h3" }
- Metric { label: string, value: string, unit?: string, trend?: "up"|"down"|"flat" }
- Badge { text: string, variant?: "default"|"success"|"warning"|"error"|"info" }
- Image { src: string, alt?: string, rounded?: boolean }
- ProgressBar { value: number, max?: number, color?: "default"|"success"|"warning"|"error"|"accent", showLabel?: boolean }
- Button { label: string, variant?: "primary"|"secondary"|"ghost", size?: "sm"|"md"|"lg", action?: "append"|"clear"|"pickRandom"|"set", source?: string, target?: string, value?: string, mutation?: string }
- TextInput { placeholder?: string, label?: string, binding?: string, value?: string, query?: string, bindColumn?: string, mutation?: string }
- Checkbox { label: string, binding?: string, checked?: boolean, query?: string, bindColumn?: string, mutation?: string }
- List { items?: [{ label: string, description?: string, trailing?: string }], binding?: string, query?: string, labelColumn?: string, descriptionColumn?: string, trailingColumn?: string }
- Table { headers?: string[], rows?: string[][], query?: string, columns?: [{ header, field }] }

Live bindings available in any string prop:
- {{local.time}}, {{local.shortTime}}, {{local.date}}, {{local.hour}}, {{local.minute}}, {{local.second}}, {{local.period}}, {{local.city}}, {{local.timezone}}, {{local.abbr}}, {{local.offset}}
- {{zone:America/New_York.time}}, {{zone:America/New_York.shortTime}}, {{zone:America/New_York.date}}, {{zone:America/New_York.hour}}, {{zone:America/New_York.minute}}, {{zone:America/New_York.second}}, {{zone:America/New_York.period}}, {{zone:America/New_York.city}}, {{zone:America/New_York.timezone}}, {{zone:America/New_York.abbr}}, {{zone:America/New_York.offset}}
- {{state.someKey}} or {{someKey}}

Storage rules:
- If the widget needs durable user data, use query-backed or mutation-backed components and generate a matching storageSchema.
- If the widget is display-only or only needs lightweight local state, return an empty storageSchema with tables/namedQueries/namedMutations as [].
- Use SQLite-friendly identifiers only: letters, numbers, underscores, hyphens.
- Support only single-table CRUD patterns.
- Do not emit SQL.
- For rebuilds, if an existing storage schema is provided, return it exactly unchanged.

Design rules:
- Always use Card as the root element.
- Design widgets like compact utility panels: functional first, minimal chrome, clear hierarchy.
- Prefer query-backed lists/tables, editable fields, and buttons that perform clear mutations when persistence matters.
- For lightweight inline interactions, use TextInput.binding / Checkbox.binding / Button.action.
- Use Button.action="append" with source/target for add-to-list flows, Button.action="pickRandom" to choose from a bound array, and Button.action="clear" to reset bound state.
- When showing local user-added collections, use List.binding instead of hardcoded placeholders.
- Never hardcode the current time, date, timezone abbreviation, or UTC offset when a live binding fits.`;

export interface GeneratedWidgetResult {
  uiSpec: Spec;
  storageSchema: SharedStorageSchema;
}

function cleanJsonResponse(raw: string,): string {
  return raw.replace(/^```(?:json)?\n?/m, "",).replace(/\n?```$/m, "",).trim();
}

function normalizeSharedStorageSchema(schema: SharedStorageSchema,): SharedStorageSchema {
  return {
    tables: schema.tables.map((table,) => ({
      ...table,
      indexes: table.indexes ?? [],
      columns: table.columns.map((column,) => ({
        ...column,
        name: column.name.trim(),
        type: column.type.toLowerCase(),
        notNull: column.notNull ?? false,
        primaryKey: column.primaryKey ?? false,
      })),
    })),
    namedQueries: schema.namedQueries.map((query,) => ({
      ...query,
      columns: query.columns ?? [],
      filters: query.filters ?? [],
      orderDesc: query.orderDesc ?? false,
    })),
    namedMutations: schema.namedMutations.map((mutation,) => ({
      ...mutation,
      setColumns: mutation.setColumns ?? [],
      filters: mutation.filters ?? [],
    })),
  };
}

function buildStoragePrompt(prompt: string, existingStorageSchema?: SharedStorageSchema,): string {
  if (!existingStorageSchema) {
    return prompt;
  }

  return [
    prompt,
    "",
    "Use this storageSchema exactly as-is. Do not rename, add, remove, or reorder fields:",
    JSON.stringify(existingStorageSchema, null, 2,),
  ].join("\n",);
}

export async function generateWidget(prompt: string,): Promise<Spec> {
  const generated = await generateWidgetWithStorage(prompt,);
  return generated.uiSpec;
}

export async function generateWidgetWithStorage(
  prompt: string,
  existingStorageSchema?: SharedStorageSchema,
): Promise<GeneratedWidgetResult> {
  const settings = await loadSettings();
  const config = resolveActiveAiConfig(settings,);
  if (!config) {
    throw new Error(`${API_KEY_MISSING}:${settings.aiProvider}`,);
  }

  const text = await generateAiText(
    config,
    SYSTEM_PROMPT,
    buildStoragePrompt(prompt, existingStorageSchema,),
  );
  const cleaned = cleanJsonResponse(text,);

  try {
    const parsed = JSON.parse(cleaned,) as Partial<GeneratedWidgetResult>;
    if (!parsed.uiSpec || !parsed.storageSchema) {
      throw new Error("Widget response must include uiSpec and storageSchema.",);
    }
    return {
      uiSpec: parsed.uiSpec,
      storageSchema: normalizeSharedStorageSchema(parsed.storageSchema,),
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("must include",)) {
      throw error;
    }
    throw new Error(`Sophia returned invalid widget JSON: ${cleaned.slice(0, 400,)}`,);
  }
}

export async function generateSharedWidget(
  prompt: string,
  existingStorageSchema?: SharedStorageSchema,
): Promise<GeneratedWidgetResult> {
  return generateWidgetWithStorage(prompt, existingStorageSchema,);
}
