import { defineRegistry, } from "@json-render/react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState, } from "react";
import { widgetCatalog, } from "./catalog";

export interface SharedWidgetRuntimeApi {
  mode: "inline" | "shared";
  runQuery: (queryName: string, params?: Record<string, unknown>,) => Promise<Array<Record<string, unknown>>>;
  runMutation: (mutationName: string, params?: Record<string, unknown>,) => Promise<number>;
  refresh: () => void;
  refreshToken: number;
}

const WidgetRuntimeContext = createContext<SharedWidgetRuntimeApi | null>(null,);

export function WidgetRuntimeProvider({
  children,
  runtime,
}: {
  children: ReactNode;
  runtime: SharedWidgetRuntimeApi;
},) {
  return <WidgetRuntimeContext.Provider value={runtime}>{children}</WidgetRuntimeContext.Provider>;
}

function useWidgetRuntime(): SharedWidgetRuntimeApi | null {
  return useContext(WidgetRuntimeContext,);
}

type RowMap = Record<string, unknown>;

function asRowMapArray(rows: unknown,): RowMap[] {
  if (!Array.isArray(rows,)) return [];
  return rows.filter((row,): row is RowMap => {
    if (!row || typeof row !== "object") return false;
    return true;
  },);
}

function useSharedRows(queryName?: string,): {
  loading: boolean;
  rows: RowMap[];
  error: string | null;
  refresh: () => Promise<void>;
} {
  const runtime = useWidgetRuntime();
  const [loading, setLoading,] = useState(false,);
  const [rows, setRows,] = useState<RowMap[]>([],);
  const [error, setError,] = useState<string | null>(null,);

  const refresh = useCallback(async () => {
    if (!queryName || !runtime || runtime.mode !== "shared") {
      setRows([],);
      setError(null,);
      setLoading(false,);
      return;
    }

    setLoading(true,);
    setError(null,);
    try {
      const data = await runtime.runQuery(queryName, {},);
      setRows(asRowMapArray(data,),);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query failed.",);
      setRows([],);
    } finally {
      setLoading(false,);
    }
  }, [queryName, runtime,],);

  useEffect(() => {
    refresh();
  }, [refresh, runtime?.refreshToken,],);

  return { loading, rows, error, refresh, };
}

function toStringValue(value: unknown,): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value,);
}

function normalizeBoolean(value: unknown,): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    return value.toLowerCase() === "true" || value.toLowerCase() === "1";
  }
  return Boolean(value,);
}

function createMutationParams(row: RowMap | null, bindColumn: string | undefined, value: unknown,): RowMap {
  const result: RowMap = {};
  if (row) {
    Object.assign(result, row,);
  }
  if (bindColumn) {
    result[bindColumn] = value;
  }
  return result;
}

export const { registry, } = defineRegistry(widgetCatalog, {
  components: {
    Card: ({ props, children, },) => (
      <div
        style={{
          borderRadius: "12px",
          border: "1px solid #e5e7eb",
          background: "#fff",
          padding: props.padding === "none"
            ? 0
            : props.padding === "sm"
            ? "8px"
            : props.padding === "lg"
            ? "24px"
            : "16px",
          fontFamily: "'IBM Plex Sans', sans-serif",
        }}
      >
        {props.title && (
          <div style={{ fontWeight: 600, fontSize: "14px", color: "#1f2937", marginBottom: "12px", }}>
            {props.title}
          </div>
        )}
        {children}
      </div>
    ),

    Stack: ({ props, children, },) => (
      <div
        style={{
          display: "flex",
          flexDirection: props.direction === "horizontal" ? "row" : "column",
          gap: props.gap === "none"
            ? "0"
            : props.gap === "xs"
            ? "4px"
            : props.gap === "sm"
            ? "8px"
            : props.gap === "lg"
            ? "20px"
            : "12px",
          alignItems: props.align === "center"
            ? "center"
            : props.align === "end"
            ? "flex-end"
            : props.align === "stretch"
            ? "stretch"
            : "flex-start",
          justifyContent: props.justify === "center"
            ? "center"
            : props.justify === "end"
            ? "flex-end"
            : props.justify === "between"
            ? "space-between"
            : props.justify === "around"
            ? "space-around"
            : "flex-start",
          flexWrap: props.wrap ? "wrap" : "nowrap",
        }}
      >
        {children}
      </div>
    ),

    Grid: ({ props, children, },) => (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${props.columns ?? 2}, 1fr)`,
          gap: props.gap === "none"
            ? "0"
            : props.gap === "xs"
            ? "4px"
            : props.gap === "sm"
            ? "8px"
            : props.gap === "lg"
            ? "20px"
            : "12px",
        }}
      >
        {children}
      </div>
    ),

    Text: ({ props, },) => (
      <span
        style={{
          fontFamily: "'IBM Plex Sans', sans-serif",
          fontSize: props.size === "xs"
            ? "11px"
            : props.size === "sm"
            ? "12px"
            : props.size === "lg"
            ? "16px"
            : props.size === "xl"
            ? "20px"
            : "14px",
          fontWeight: props.weight === "normal"
            ? "400"
            : props.weight === "medium"
            ? "500"
            : props.weight === "semibold"
            ? "600"
            : "700",
          color: props.color === "default"
            ? "#1f2937"
            : props.color === "accent"
            ? "#6366f1"
            : props.color === "success"
            ? "#16a34a"
            : props.color === "warning"
            ? "#d97706"
            : "#ef4444",
          textAlign: props.align ?? "left",
          display: "block",
          lineHeight: 1.5,
        }}
      >
        {props.content}
      </span>
    ),

    Heading: ({ props, },) => {
      const sizes = { h1: "20px", h2: "16px", h3: "14px", };
      return (
        <div
          style={{
            fontFamily: "'IBM Plex Sans', sans-serif",
            fontSize: sizes[props.level ?? "h2"],
            fontWeight: 600,
            color: "#1f2937",
            lineHeight: 1.3,
          }}
        >
          {props.content}
        </div>
      );
    },

    Metric: ({ props, },) => (
      <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", }}>
        <div style={{ fontSize: "11px", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", }}>
          {props.label}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: "4px", marginTop: "2px", }}>
          <span style={{ fontSize: "24px", fontWeight: 600, color: "#1f2937", }}>{props.value}</span>
          {props.unit && <span style={{ fontSize: "12px", color: "#9ca3af", }}>{props.unit}</span>}
          {props.trend && (
            <span
              style={{
                fontSize: "12px",
                color: props.trend === "up" ? "#16a34a" : props.trend === "down" ? "#ef4444" : "#9ca3af",
              }}
            >
              {props.trend === "up" ? "↑" : props.trend === "down" ? "↓" : "→"}
            </span>
          )}
        </div>
      </div>
    ),

    Badge: ({ props, },) => {
      const palette = {
        default: { bg: "#f3f4f6", fg: "#6b7280", },
        success: { bg: "#f0fdf4", fg: "#16a34a", },
        warning: { bg: "#fffbeb", fg: "#d97706", },
        error: { bg: "#fef2f2", fg: "#ef4444", },
        info: { bg: "#eef2ff", fg: "#6366f1", },
      } as const;
      const color = palette[props.variant ?? "default"];
      return (
        <span
          style={{
            fontFamily: "'IBM Plex Sans', sans-serif",
            display: "inline-block",
            fontSize: "11px",
            fontWeight: 500,
            padding: "2px 8px",
            borderRadius: "100px",
            background: color.bg,
            color: color.fg,
          }}
        >
          {props.text}
        </span>
      );
    },

    Button: ({ props, },) => {
      const runtime = useWidgetRuntime();
      const [running, setRunning,] = useState(false,);
      const canMutate = Boolean(runtime && runtime.mode === "shared" && props.mutation,);

      const handleClick = async () => {
        if (!canMutate || !runtime || !props.mutation) return;
        setRunning(true,);
        try {
          await runtime.runMutation(props.mutation, {},);
          runtime.refresh();
        } finally {
          setRunning(false,);
        }
      };

      const isPrimary = props.variant === "primary";
      const isGhost = props.variant === "ghost";
      return (
        <button
          onClick={() => {
            void handleClick();
          }}
          disabled={running && canMutate}
          style={{
            fontFamily: "'IBM Plex Sans', sans-serif",
            fontSize: props.size === "sm" ? "12px" : props.size === "lg" ? "14px" : "13px",
            padding: props.size === "sm" ? "4px 10px" : props.size === "lg" ? "10px 20px" : "6px 14px",
            borderRadius: "8px",
            border: isGhost ? "none" : "1px solid",
            borderColor: isPrimary ? "#6366f1" : "#e5e7eb",
            background: isPrimary ? "#6366f1" : isGhost ? "transparent" : "#fff",
            color: isPrimary ? "#fff" : "#374151",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          {running ? "Saving..." : props.label}
        </button>
      );
    },

    TextInput: ({ props, },) => {
      const { rows, loading, error, refresh, } = useSharedRows(props.query,);
      const runtime = useWidgetRuntime();
      const boundRow = rows[0] ?? null;
      const runtimeMode = runtime?.mode ?? "inline";
      const initial = runtimeMode === "shared" && boundRow && props.bindColumn
        ? boundRow[props.bindColumn]
        : props.value;
      const [value, setValue,] = useState(toStringValue(initial ?? "",),);

      useEffect(() => {
        setValue(toStringValue(initial ?? "",),);
      }, [initial, runtimeMode, props.value,],);

      const canWrite = !!(runtimeMode === "shared" && runtime && props.mutation);

      const submit = async (next: string,) => {
        if (!canWrite || !runtime || !props.mutation || !props.bindColumn) {
          return;
        }
        try {
          const params = createMutationParams(boundRow, props.bindColumn, next,);
          await runtime.runMutation(props.mutation, params,);
          runtime.refresh();
          if (props.query) {
            await refresh();
          }
        } catch (err) {
          console.error("Shared mutation failed", err,);
        }
      };

      return (
        <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", }}>
          {props.label && (
            <label style={{ fontSize: "12px", color: "#6b7280", display: "block", marginBottom: "4px", }}>
              {props.label}
            </label>
          )}
          {error && <div style={{ color: "#b91c1c", fontSize: "11px", marginBottom: "4px", }}>{error}</div>}
          <input
            type="text"
            value={value}
            placeholder={props.placeholder}
            disabled={loading}
            onChange={(event,) => {
              const next = event.target.value;
              setValue(next,);
            }}
            onBlur={() => {
              if (runtimeMode === "shared" && canWrite) {
                void submit(value,);
              }
            }}
            onKeyDown={(event,) => {
              if (event.key === "Enter" && runtimeMode === "shared" && canWrite) {
                event.preventDefault();
                void submit(value,);
              }
            }}
            style={{
              fontFamily: "'IBM Plex Sans', sans-serif",
              width: "100%",
              padding: "8px 12px",
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
              fontSize: "13px",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>
      );
    },

    Checkbox: ({ props, },) => {
      const { rows, refresh, error, } = useSharedRows(props.query,);
      const runtime = useWidgetRuntime();
      const boundRow = rows[0] ?? null;
      const runtimeMode = runtime?.mode ?? "inline";
      const initial = runtimeMode === "shared" && boundRow && props.bindColumn
        ? boundRow[props.bindColumn]
        : props.checked;
      const checked = normalizeBoolean(initial,);
      const [localChecked, setLocalChecked,] = useState(checked,);
      const canWrite = !!(runtimeMode === "shared" && runtime && props.mutation);

      useEffect(() => {
        setLocalChecked(checked,);
      }, [checked, runtimeMode,],);

      const submit = async (next: boolean,) => {
        if (!canWrite || !runtime || !props.mutation || !props.bindColumn) {
          return;
        }
        try {
          await runtime.runMutation(props.mutation, createMutationParams(boundRow, props.bindColumn, next ? 1 : 0,),);
          runtime.refresh();
          if (props.query) {
            await refresh();
          }
        } catch (err) {
          console.error("Shared mutation failed", err,);
          setLocalChecked(!next,);
        }
      };

      return (
        <label
          style={{
            fontFamily: "'IBM Plex Sans', sans-serif",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "13px",
            color: "#374151",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={localChecked}
            disabled={runtimeMode === "shared" && props.mutation ? false : false}
            onChange={(event,) => {
              const next = event.target.checked;
              setLocalChecked(next,);
              if (runtimeMode === "shared" && canWrite) {
                void submit(next,);
              }
            }}
            style={{ width: "16px", height: "16px", }}
          />
          {props.label}
          {error && <span style={{ fontSize: "11px", color: "#b91c1c", }}>{error}</span>}
        </label>
      );
    },

    ProgressBar: ({ props, },) => {
      const max = props.max ?? 100;
      const pct = Math.min(100, (props.value / max) * 100,);
      const barColor = props.color === "success"
        ? "#16a34a"
        : props.color === "warning"
        ? "#d97706"
        : props.color === "error"
        ? "#ef4444"
        : props.color === "accent"
        ? "#7c3aed"
        : "#6366f1";
      return (
        <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", }}>
          <div style={{ height: "8px", borderRadius: "4px", background: "#f3f4f6", overflow: "hidden", }}>
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                background: barColor,
                borderRadius: "4px",
                transition: "width 0.3s ease",
              }}
            />
          </div>
          {props.showLabel && (
            <div style={{ fontSize: "11px", color: "#9ca3af", marginTop: "4px", textAlign: "right", }}>
              {Math.round(pct,)}%
            </div>
          )}
        </div>
      );
    },

    Divider: () => <div style={{ borderTop: "1px solid #e5e7eb", }} />,

    Spacer: ({ props, },) => (
      <div
        style={{
          height: props.size === "xs"
            ? "4px"
            : props.size === "sm"
            ? "8px"
            : props.size === "md"
            ? "12px"
            : props.size === "lg"
            ? "16px"
            : props.size === "xl"
            ? "24px"
            : "12px",
        }}
      />
    ),

    Image: ({ props, },) => (
      <img
        src={props.src}
        alt={props.alt ?? ""}
        style={{ maxWidth: "100%", borderRadius: props.rounded ? 8 : 0, }}
      />
    ),

    List: ({ props, },) => {
      const { rows, loading, error, } = useSharedRows(props.query,);
      const runtime = useWidgetRuntime();
      const staticItems = props.items ?? [];
      const items = useMemo(() => {
        if (!props.query || runtime?.mode !== "shared") {
          return staticItems;
        }

        return rows
          .map((row,) => ({
            label: toStringValue(
              row[props.labelColumn ?? "label"],
            ),
            description: toStringValue(
              props.descriptionColumn ? row[props.descriptionColumn] : row.description,
            ),
            trailing: toStringValue(
              props.trailingColumn ? row[props.trailingColumn] : row.trailing,
            ),
          }));
      }, [
        props.query,
        runtime?.mode,
        rows,
        props.descriptionColumn,
        props.labelColumn,
        props.trailingColumn,
        staticItems,
      ],);

      return (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            fontFamily: "'IBM Plex Sans', sans-serif",
            color: "#1f2937",
          }}
        >
          {loading
            ? <li style={{ color: "#9ca3af", padding: "6px 0", fontSize: "12px", }}>Loading…</li>
            : error
            ? <li style={{ color: "#b91c1c", padding: "6px 0", fontSize: "12px", }}>{error}</li>
            : items.length === 0
            ? <li style={{ color: "#9ca3af", padding: "6px 0", fontSize: "12px", }}>No items</li>
            : (
              items.map((item, index,) => (
                <li key={index} style={{ padding: "8px 0", borderBottom: "1px solid #f3f4f6", }}>
                  <div style={{ fontSize: "13px", fontWeight: 500, }}>{item.label}</div>
                  {item.description && <div style={{ fontSize: "12px", color: "#6b7280", }}>{item.description}</div>}
                  {item.trailing && (
                    <div style={{ fontSize: "11px", color: "#9ca3af", marginTop: "2px", }}>{item.trailing}</div>
                  )}
                </li>
              ))
            )}
        </ul>
      );
    },

    Table: ({ props, },) => {
      const runtime = useWidgetRuntime();
      const { rows, loading, error, } = useSharedRows(props.query,);
      const queryColumns = props.columns ?? [];
      const headers = queryColumns.length > 0
        ? queryColumns.map((column,) => column.header)
        : props.headers ?? [];
      const body = useMemo(() => {
        if (!props.query || runtime?.mode !== "shared") {
          return props.rows ?? [];
        }

        return rows.map((row,) =>
          queryColumns.length
            ? queryColumns.map((column,) => toStringValue(row[column.field],))
            : Object.values(row,).map((value,) => toStringValue(value,))
        );
      }, [props.query, runtime?.mode, rows, queryColumns, props.rows,],);

      return (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'IBM Plex Sans', sans-serif", }}>
          <thead>
            <tr>
              {headers.map((h, i,) => (
                <th
                  key={i}
                  style={{
                    textAlign: "left",
                    padding: "8px 12px",
                    borderBottom: "2px solid #e5e7eb",
                    color: "#6b7280",
                    fontWeight: 500,
                    fontSize: "11px",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? (
                <tr>
                  <td
                    style={{ padding: "10px 12px", color: "#9ca3af", fontSize: "12px", }}
                    colSpan={Math.max(1, headers.length,)}
                  >
                    Loading…
                  </td>
                </tr>
              )
              : error
              ? (
                <tr>
                  <td
                    style={{ padding: "10px 12px", color: "#b91c1c", fontSize: "12px", }}
                    colSpan={Math.max(1, headers.length,)}
                  >
                    {error}
                  </td>
                </tr>
              )
              : body.length === 0
              ? (
                <tr>
                  <td
                    style={{ padding: "10px 12px", color: "#9ca3af", fontSize: "12px", }}
                    colSpan={Math.max(1, headers.length,)}
                  >
                    No rows
                  </td>
                </tr>
              )
              : (
                body.map((row, ri,) => (
                  <tr key={ri}>
                    {row.map((cell, ci,) => (
                      <td
                        key={ci}
                        style={{ padding: "8px 12px", borderBottom: "1px solid #f3f4f6", color: "#1f2937", }}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))
              )}
          </tbody>
        </table>
      );
    },
  },
},);
