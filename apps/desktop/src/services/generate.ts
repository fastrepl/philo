import type { Spec, } from "@json-render/core";
import { API_KEY_MISSING, generateAiText, } from "./ai";
import type { SharedStorageSchema, } from "./library";
import { loadSettings, resolveActiveAiConfig, } from "./settings";

const SYSTEM_PROMPT = `You are Sophia, an AI that generates UI widgets as JSON specs.

OUTPUT FORMAT:
Return ONLY a JSON object with this exact shape (no markdown, no explanation, no code fences):
{
  "root": "<root-element-id>",
  "elements": {
    "<element-id>": {
      "type": "<ComponentName>",
      "props": { ... },
      "children": ["<child-id-1>", "<child-id-2>"]
    }
  }
}

- Every element needs a unique string ID (e.g. "main-card", "title-text", "stats-grid").
- "children" is an array of element ID strings. Use [] for leaf nodes.
- "root" is the ID of the top-level element.

AVAILABLE COMPONENTS:

Layout:
- Card { title?: string, padding?: "none"|"sm"|"md"|"lg" } — Top-level container. Always use as root.
- Stack { direction?: "vertical"|"horizontal", gap?: "none"|"xs"|"sm"|"md"|"lg", align?: "start"|"center"|"end"|"stretch", justify?: "start"|"center"|"end"|"between"|"around", wrap?: boolean } — Flex layout.
- Grid { columns?: number, gap?: "none"|"xs"|"sm"|"md"|"lg" } — Grid layout.
- Divider {} — Horizontal line.
- Spacer { size?: "xs"|"sm"|"md"|"lg"|"xl" } — Vertical spacing.

Content:
- Text { content: string, size?: "xs"|"sm"|"md"|"lg"|"xl", weight?: "normal"|"medium"|"semibold"|"bold", color?: "default"|"muted"|"accent"|"success"|"warning"|"error", align?: "left"|"center"|"right" }
- Heading { content: string, level?: "h1"|"h2"|"h3" }
- Metric { label: string, value: string, unit?: string, trend?: "up"|"down"|"flat" } — Key number display.
- Badge { text: string, variant?: "default"|"success"|"warning"|"error"|"info" }
- Image { src: string, alt?: string, rounded?: boolean }

Data:
- List { items: [{ label: string, description?: string, trailing?: string }], variant?: "plain"|"bordered"|"striped" }
- Table { headers: string[], rows: string[][] }
- ProgressBar { value: number, max?: number, color?: "default"|"success"|"warning"|"error"|"accent", showLabel?: boolean }

Interactive:
- Button { label: string, variant?: "primary"|"secondary"|"ghost", size?: "sm"|"md"|"lg" }
- TextInput { placeholder?: string, label?: string }
- Checkbox { label: string }

RULES:
- Always use Card as the root element.
- Use Stack for vertical/horizontal layout, Grid for columns.
- Use Metric for key numbers, Badge for status labels, List for enumerations, Table for tabular data.
- Be creative and make it visually clean.`;

const SHARED_SYSTEM_PROMPT = `You are Sophia, an AI that generates shared Philo widgets.

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
    "tables": [
      {
        "name": "items",
        "columns": [
          { "name": "id", "type": "integer", "primaryKey": true },
          { "name": "title", "type": "text", "notNull": true }
        ],
        "indexes": [
          { "name": "idx_items_title", "columns": ["title"] }
        ]
      }
    ],
    "namedQueries": [
      {
        "name": "listItems",
        "table": "items",
        "columns": ["*"],
        "filters": [],
        "orderBy": "id",
        "orderDesc": true,
        "limit": 100
      }
    ],
    "namedMutations": [
      {
        "name": "updateTitle",
        "table": "items",
        "kind": "update",
        "setColumns": ["title"],
        "filters": [{ "column": "id", "operator": "eq", "parameter": "id" }]
      }
    ]
  }
}

Supported UI components:
- Card, Stack, Grid, Divider, Spacer
- Text, Heading, Metric, Badge, Image
- Button { mutation }
- TextInput { query, bindColumn, mutation, label?, placeholder? }
- Checkbox { query, bindColumn, mutation, label }
- List { query, labelColumn, descriptionColumn?, trailingColumn? }
- Table { query, columns: [{ header, field }] }

Storage schema rules:
- Use SQLite-friendly identifiers only: letters, numbers, underscores, hyphens.
- Support only single-table CRUD patterns.
- Do not emit SQL.
- For rebuilds, if an existing storage schema is provided, return it exactly unchanged.`;

export interface SharedGenerationResult {
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

function buildSharedPrompt(prompt: string, existingStorageSchema?: SharedStorageSchema,): string {
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
  const settings = await loadSettings();
  const config = resolveActiveAiConfig(settings,);
  if (!config) {
    throw new Error(`${API_KEY_MISSING}:${settings.aiProvider}`,);
  }

  const text = await generateAiText(config, SYSTEM_PROMPT, prompt,);

  const cleaned = cleanJsonResponse(text,);
  try {
    return JSON.parse(cleaned,) as Spec;
  } catch {
    throw new Error(`Sophia returned invalid JSON: ${cleaned.slice(0, 200,)}`,);
  }
}

export async function generateSharedWidget(
  prompt: string,
  existingStorageSchema?: SharedStorageSchema,
): Promise<SharedGenerationResult> {
  const settings = await loadSettings();
  const config = resolveActiveAiConfig(settings,);
  if (!config) {
    throw new Error(`${API_KEY_MISSING}:${settings.aiProvider}`,);
  }

  const text = await generateAiText(
    config,
    SHARED_SYSTEM_PROMPT,
    buildSharedPrompt(prompt, existingStorageSchema,),
  );
  const cleaned = cleanJsonResponse(text,);

  try {
    const parsed = JSON.parse(cleaned,) as Partial<SharedGenerationResult>;
    if (!parsed.uiSpec || !parsed.storageSchema) {
      throw new Error("Shared component response must include uiSpec and storageSchema.",);
    }
    return {
      uiSpec: parsed.uiSpec,
      storageSchema: normalizeSharedStorageSchema(parsed.storageSchema,),
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("must include",)) {
      throw error;
    }
    throw new Error(`Sophia returned invalid shared widget JSON: ${cleaned.slice(0, 200,)}`,);
  }
}
