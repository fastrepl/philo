import { invoke, } from "@tauri-apps/api/core";
import type { SharedStorageSchema, } from "./library";

export const EMPTY_STORAGE_SCHEMA: SharedStorageSchema = {
  tables: [],
  namedQueries: [],
  namedMutations: [],
};

const WIDGET_STORAGE_SCHEMA_VERSION = 1;

function normalizeStorageSchema(schema?: SharedStorageSchema | null,): SharedStorageSchema {
  if (!schema) return EMPTY_STORAGE_SCHEMA;

  return {
    tables: schema.tables.map((table,) => ({
      ...table,
      columns: table.columns.map((column,) => ({
        ...column,
        name: column.name.trim(),
        type: column.type.toLowerCase(),
        notNull: column.notNull ?? false,
        primaryKey: column.primaryKey ?? false,
      })),
      indexes: (table.indexes ?? []).map((index,) => ({
        ...index,
        columns: index.columns.map((column,) => column.trim()).filter((column,) => column),
        unique: index.unique ?? false,
      })),
    })),
    namedQueries: schema.namedQueries.map((query,) => ({
      ...query,
      columns: (query.columns ?? []).map((column,) => column.trim()).filter((column,) => column),
      filters: query.filters ?? [],
      orderBy: query.orderBy?.trim() || undefined,
      orderDesc: query.orderDesc ?? false,
      limit: query.limit,
    })),
    namedMutations: schema.namedMutations.map((mutation,) => ({
      ...mutation,
      setColumns: (mutation.setColumns ?? []).map((column,) => column.trim()).filter((column,) => column),
      filters: mutation.filters ?? [],
    })),
  };
}

export function parseStorageSchema(raw: unknown,): SharedStorageSchema | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return normalizeStorageSchema(JSON.parse(raw,) as SharedStorageSchema,);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object") return null;
  return normalizeStorageSchema(raw as SharedStorageSchema,);
}

export function stringifyStorageSchema(schema?: SharedStorageSchema | null,): string {
  if (!schema) return "";
  return JSON.stringify(normalizeStorageSchema(schema,),);
}

export function hasPersistentStorage(schema?: SharedStorageSchema | null,): boolean {
  const normalized = normalizeStorageSchema(schema,);
  return normalized.tables.length > 0
    || normalized.namedQueries.length > 0
    || normalized.namedMutations.length > 0;
}

function widgetInputArgs(
  widgetPath: string,
  widgetId: string,
  storageSchema: SharedStorageSchema,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    input: {
      widgetPath,
      widget_path: widgetPath,
      widgetId,
      widget_id: widgetId,
      storageSchema,
      storage_schema: storageSchema,
      schemaVersion: WIDGET_STORAGE_SCHEMA_VERSION,
      schema_version: WIDGET_STORAGE_SCHEMA_VERSION,
      ...overrides,
    },
  };
}

export async function ensureWidgetStorage(
  widgetPath: string,
  widgetId: string,
  storageSchema?: SharedStorageSchema | null,
): Promise<void> {
  const normalized = normalizeStorageSchema(storageSchema,);
  if (!hasPersistentStorage(normalized,)) return;

  await invoke("ensure_widget_storage", widgetInputArgs(widgetPath, widgetId, normalized,),);
}

export async function runWidgetStorageQuery(
  widgetPath: string,
  widgetId: string,
  storageSchema: SharedStorageSchema,
  queryName: string,
  params: Record<string, unknown> = {},
): Promise<Array<Record<string, unknown>>> {
  const normalized = normalizeStorageSchema(storageSchema,);
  const result = await invoke<{ rows: Array<Record<string, unknown>>; }>(
    "run_widget_storage_query",
    widgetInputArgs(widgetPath, widgetId, normalized, {
      queryName,
      query_name: queryName,
      params,
    },),
  );
  return result.rows;
}

export async function runWidgetStorageMutation(
  widgetPath: string,
  widgetId: string,
  storageSchema: SharedStorageSchema,
  mutationName: string,
  params: Record<string, unknown> = {},
): Promise<number> {
  const normalized = normalizeStorageSchema(storageSchema,);
  const result = await invoke<{ changedRows: number; }>(
    "run_widget_storage_mutation",
    widgetInputArgs(widgetPath, widgetId, normalized, {
      mutationName,
      mutation_name: mutationName,
      params,
    },),
  );
  return result.changedRows;
}
