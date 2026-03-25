import { createContext, useContext, useEffect, useMemo, useRef, useState, } from "react";
import type { Context, CSSProperties, ReactNode, } from "react";

interface WidgetSdkBridge {
  runQuery: (name: string, params?: Record<string, unknown>,) => Promise<Array<Record<string, unknown>>>;
  runMutation: (name: string, params?: Record<string, unknown>,) => Promise<number>;
}

interface WidgetSdkStateApi {
  getValue: <T,>(key: string, initialValue?: T,) => T | undefined;
  setValue: (key: string, value: unknown,) => void;
}

interface WidgetSdkContextValue {
  bridge: WidgetSdkBridge;
  state: WidgetSdkStateApi;
  mutationVersion: number;
  bumpMutationVersion: () => void;
}

const WidgetSdkContext = createContext<WidgetSdkContextValue | null>(null,);

function useWidgetSdkContext() {
  const value = useContext(WidgetSdkContext,);
  if (!value) {
    throw new Error("Widget SDK provider is missing.",);
  }
  return value;
}

function useCurrentTime(intervalMs = 1000,) {
  const [now, setNow,] = useState(() => new Date());

  useEffect(() => {
    const sync = () => setNow(new Date(),);
    const intervalId = window.setInterval(sync, intervalMs,);
    return () => window.clearInterval(intervalId,);
  }, [intervalMs,],);

  return now;
}

function gapSize(gap?: "none" | "xs" | "sm" | "md" | "lg",): string {
  if (gap === "none") return "0";
  if (gap === "xs") return "4px";
  if (gap === "sm") return "8px";
  if (gap === "lg") return "20px";
  return "12px";
}

export function WidgetSdkProvider({
  bridge,
  children,
}: {
  bridge: WidgetSdkBridge;
  children: ReactNode;
},) {
  const [mutationVersion, setMutationVersion,] = useState(0,);
  const [stateVersion, setStateVersion,] = useState(0,);
  const valuesRef = useRef<Record<string, unknown>>({},);

  const state = useMemo<WidgetSdkStateApi>(() => ({
    getValue: <T,>(key: string, initialValue?: T,) => {
      if (Object.prototype.hasOwnProperty.call(valuesRef.current, key,)) {
        return valuesRef.current[key] as T;
      }

      if (initialValue !== undefined) {
        valuesRef.current = { ...valuesRef.current, [key]: initialValue, };
      }

      return initialValue;
    },
    setValue: (key: string, value: unknown,) => {
      if (Object.is(valuesRef.current[key], value,)) {
        return;
      }

      valuesRef.current = { ...valuesRef.current, [key]: value, };
      setStateVersion((version,) => version + 1);
    },
  }), [],);

  const contextValue = useMemo<WidgetSdkContextValue>(() => ({
    bridge,
    state,
    mutationVersion,
    bumpMutationVersion: () => setMutationVersion((value,) => value + 1),
  }), [bridge, mutationVersion, state, stateVersion,],);

  return <WidgetSdkContext.Provider value={contextValue}>{children}</WidgetSdkContext.Provider>;
}

export function useWidgetState<T,>(key: string, initialValue: T,) {
  const context = useWidgetSdkContext();
  const value = context.state.getValue<T>(key, initialValue,) as T;
  const setValue = (next: T | ((current: T,) => T),) => {
    const resolved = typeof next === "function"
      ? (next as (current: T,) => T)(value,)
      : next;
    context.state.setValue(key, resolved,);
  };

  return [value, setValue,] as const;
}

export function useNow(intervalMs = 1000,) {
  return useCurrentTime(intervalMs,);
}

export function useQuery(
  name: string,
  params: Record<string, unknown> = {},
): {
  data: Array<Record<string, unknown>>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const context = useWidgetSdkContext();
  const [data, setData,] = useState<Array<Record<string, unknown>>>([],);
  const [loading, setLoading,] = useState(true,);
  const [error, setError,] = useState<string | null>(null,);
  const paramsKey = JSON.stringify(params,);

  const refresh = async () => {
    setLoading(true,);
    setError(null,);
    try {
      const rows = await context.bridge.runQuery(name, params,);
      setData(rows,);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query failed.",);
      setData([],);
    } finally {
      setLoading(false,);
    }
  };

  useEffect(() => {
    void refresh();
  }, [context.bridge, context.mutationVersion, name, paramsKey,],);

  return { data, loading, error, refresh, };
}

export function useMutation(name: string,) {
  const context = useWidgetSdkContext();

  return async (params: Record<string, unknown> = {},) => {
    const changed = await context.bridge.runMutation(name, params,);
    context.bumpMutationVersion();
    return changed;
  };
}

const panelStyle: CSSProperties = {
  fontFamily: "'IBM Plex Sans', sans-serif",
  background: "#fff",
  color: "#1f2937",
};

export function Card({
  title,
  padding = "md",
  style,
  children,
}: {
  title?: string;
  padding?: "none" | "sm" | "md" | "lg";
  style?: CSSProperties;
  children?: ReactNode;
},) {
  return (
    <div
      style={{
        ...panelStyle,
        padding: padding === "none" ? 0 : padding === "sm" ? "8px" : padding === "lg" ? "24px" : "16px",
        ...style,
      }}
    >
      {title
        ? (
          <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px", }}>
            {title}
          </div>
        )
        : null}
      {children}
    </div>
  );
}

export function Stack({
  direction = "vertical",
  gap = "md",
  align = "stretch",
  style,
  children,
}: {
  direction?: "vertical" | "horizontal";
  gap?: "none" | "xs" | "sm" | "md" | "lg";
  align?: "start" | "center" | "end" | "stretch";
  style?: CSSProperties;
  children?: ReactNode;
},) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: direction === "horizontal" ? "row" : "column",
        gap: gapSize(gap,),
        alignItems: align === "start"
          ? "flex-start"
          : align === "end"
          ? "flex-end"
          : align === "center"
          ? "center"
          : "stretch",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Text({
  children,
  size = "md",
  weight = "normal",
  align = "left",
  style,
}: {
  children?: ReactNode;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  weight?: "normal" | "medium" | "semibold" | "bold";
  align?: "left" | "center" | "right";
  style?: CSSProperties;
},) {
  return (
    <span
      style={{
        ...panelStyle,
        display: "block",
        fontSize: size === "xs"
          ? "11px"
          : size === "sm"
          ? "12px"
          : size === "lg"
          ? "16px"
          : size === "xl"
          ? "20px"
          : "14px",
        fontWeight: weight === "normal" ? 400 : weight === "medium" ? 500 : weight === "semibold" ? 600 : 700,
        textAlign: align,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function Heading({
  children,
  level = "h2",
  style,
}: {
  children?: ReactNode;
  level?: "h1" | "h2" | "h3" | 1 | 2 | 3;
  style?: CSSProperties;
},) {
  const normalizedLevel = level === 1 ? "h1" : level === 3 ? "h3" : level === 2 ? "h2" : level;
  const fontSize = normalizedLevel === "h1" ? "20px" : normalizedLevel === "h3" ? "14px" : "16px";
  return <div style={{ ...panelStyle, fontSize, fontWeight: 600, ...style, }}>{children}</div>;
}

export function Button({
  children,
  variant = "primary",
  onClick,
  disabled,
  style,
}: {
  children?: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
},) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: "'IBM Plex Sans', sans-serif",
        fontSize: "13px",
        padding: "6px 14px",
        borderRadius: 0,
        border: variant === "ghost" ? "none" : "1px solid",
        borderColor: variant === "primary" ? "#6366f1" : "#e5e7eb",
        background: variant === "primary" ? "#6366f1" : variant === "ghost" ? "transparent" : "#fff",
        color: variant === "primary" ? "#fff" : "#374151",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function TextInput({
  label,
  value,
  onChange,
  placeholder,
  style,
}: {
  label?: string;
  value: string;
  onChange: (value: string,) => void;
  placeholder?: string;
  style?: CSSProperties;
},) {
  return (
    <label style={{ ...panelStyle, display: "block", }}>
      {label
        ? <span style={{ display: "block", fontSize: "12px", color: "#6b7280", marginBottom: "4px", }}>{label}</span>
        : null}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event,) => onChange(event.target.value,)}
        style={{
          fontFamily: "'IBM Plex Sans', sans-serif",
          width: "100%",
          padding: "8px 12px",
          border: "1px solid #e5e7eb",
          borderRadius: 0,
          fontSize: "13px",
          boxSizing: "border-box",
          ...style,
        }}
      />
    </label>
  );
}

declare global {
  var __PHILO_WIDGET_REACT__: typeof import("react") | undefined;
  var __PHILO_WIDGET_SDK_CONTEXT__: Context<WidgetSdkContextValue | null> | undefined;
}
