import { invoke, } from "@tauri-apps/api/core";
import { join, } from "@tauri-apps/api/path";
import { getCurrentWindow, } from "@tauri-apps/api/window";
import { open as openDialog, } from "@tauri-apps/plugin-dialog";
import { exists, } from "@tauri-apps/plugin-fs";
import { AlertTriangle, Check, ChevronDown, RefreshCw, X, } from "lucide-react";
import { useEffect, useRef, useState, } from "react";
import { connectGoogleAccount, disconnectGoogleAccount, isGoogleAccountConnected, } from "../../services/google";
import { detectObsidianFolders, } from "../../services/obsidian";
import { applyFilenamePattern, getJournalDir, initJournalScope, resetJournalDir, } from "../../services/paths";
import {
  AI_PROVIDERS,
  type AiProvider,
  DEFAULT_FILENAME_PATTERN,
  getAiProviderLabel,
  getDefaultSttBaseUrl,
  getDefaultSttModel,
  getSttModelLabel,
  getSttProviderLabel,
  getSuggestedSttModels,
  GOOGLE_CALENDAR_OPEN_CLIENTS,
  GOOGLE_EMAIL_OPEN_CLIENTS,
  type GoogleCalendarOpenClient,
  type GoogleEmailOpenClient,
  loadSettings,
  saveSettings,
  type Settings,
  STT_PROVIDERS,
  type SttProvider,
} from "../../services/settings";
import { getToday, } from "../../types/note";
import { VaultPathMarquee, } from "../shared/VaultPathMarquee";
import { SpokenLanguagesField, } from "./SpokenLanguagesField";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type ValidationField = "filenamePattern";
type ProviderSettingsTab = "ai" | "dictation";

const AI_PROVIDER_PLACEHOLDERS: Record<AiProvider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  google: "AIza...",
  openrouter: "sk-or-v1-...",
};

const STT_PROVIDER_HINTS: Record<SttProvider, string> = {
  deepgram: "BYOK",
  assemblyai: "BYOK",
  openai: "Reuse OpenAI key if blank",
  gladia: "BYOK",
  soniox: "BYOK",
  elevenlabs: "BYOK",
  mistral: "BYOK",
  custom: "Manual",
};

const CUSTOM_STT_MODEL_VALUE = "__philo_custom_stt_model__";

const GOOGLE_EMAIL_OPEN_CLIENT_LABELS: Record<GoogleEmailOpenClient, string> = {
  gmail: "Gmail",
  apple_mail: "Apple Mail",
};

const GOOGLE_CALENDAR_OPEN_CLIENT_LABELS: Record<GoogleCalendarOpenClient, string> = {
  google_calendar: "Google Calendar",
  apple_calendar: "Apple Calendar",
};

const GOOGLE_EMAIL_OPEN_CLIENT_HINTS: Record<GoogleEmailOpenClient, string> = {
  gmail: "Web",
  apple_mail: "macOS",
};

const GOOGLE_CALENDAR_OPEN_CLIENT_HINTS: Record<GoogleCalendarOpenClient, string> = {
  google_calendar: "Web",
  apple_calendar: "macOS",
};

const mono = { fontFamily: "'IBM Plex Mono', monospace", };
const googleButtonText = { fontFamily: "'Roboto', 'IBM Plex Sans', sans-serif", };
const filenameTokenChip =
  "inline-flex items-center rounded-none border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-600";
const FILENAME_TOKEN_REGEX = /(\{YYYY\}|\{MM\}|\{DD\})/g;

function getErrorMessage(error: unknown, fallback: string,) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallback;
}

function getSttModelHint(model: string,) {
  switch (model) {
    case "nova-2-meeting":
    case "gpt-4o-transcribe":
    case "stt-v4":
      return "Recommended";
    case "nova-3-general":
      return "General";
    case "nova-2-phonecall":
      return "Phone";
    case "gpt-4o-mini-transcribe":
      return "Lower cost";
    case "whisper-1":
    case "stt-v3":
      return "Legacy";
    default:
      return "Default";
  }
}

function getAiProviderDraftKey(settings: Settings, provider: AiProvider,) {
  switch (provider) {
    case "anthropic":
      return settings.anthropicApiKey;
    case "openai":
      return settings.openaiApiKey;
    case "google":
      return settings.googleApiKey;
    case "openrouter":
      return settings.openrouterApiKey;
  }
}

function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      className="h-[18px] w-[18px] shrink-0"
      viewBox="0 0 18 18"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.716v2.258h2.909c1.703-1.567 2.684-3.874 2.684-6.615"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.909-2.258c-.806.54-1.837.859-3.047.859-2.344 0-4.328-1.583-5.037-3.711H.957v2.332A8.997 8.997 0 0 0 9 18"
      />
      <path
        fill="#FBBC05"
        d="M3.963 10.71A5.41 5.41 0 0 1 3.68 9c0-.593.102-1.17.283-1.71V4.958H.957A9 9 0 0 0 0 9c0 1.45.347 2.823.957 4.042z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.346l2.582-2.582C13.463.892 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.963 7.29C4.672 5.163 6.656 3.58 9 3.58"
      />
    </svg>
  );
}

function FilenameTokenChip(
  {
    token,
    variant = "legend",
    muted = false,
  }: {
    token: "YYYY" | "MM" | "DD";
    variant?: "legend" | "field";
    muted?: boolean;
  },
) {
  const classes = variant === "field"
    ? `inline-flex items-center rounded-none border px-2 py-1 text-xs ${
      muted
        ? "border-gray-200 bg-gray-50 text-gray-400"
        : "border-violet-200 bg-violet-50 text-violet-700"
    }`
    : filenameTokenChip;

  return (
    <span className={classes} style={mono}>
      {token}
    </span>
  );
}

function FilenamePatternFieldValue({ value, muted = false, }: { value: string; muted?: boolean; },) {
  const segments = value.split(FILENAME_TOKEN_REGEX,).filter(Boolean,);

  return (
    <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
      {segments.map((segment, index,) => {
        if (segment === "{YYYY}" || segment === "{MM}" || segment === "{DD}") {
          return (
            <FilenameTokenChip
              key={`${segment}-${index}`}
              token={segment.slice(1, -1,) as "YYYY" | "MM" | "DD"}
              variant="field"
              muted={muted}
            />
          );
        }

        return (
          <span
            key={`${segment}-${index}`}
            className={muted ? "text-gray-400" : "text-gray-900"}
            style={mono}
          >
            {segment}
          </span>
        );
      },)}
    </div>
  );
}

function ProviderModeTabs(
  {
    selected,
    onChange,
  }: {
    selected: ProviderSettingsTab;
    onChange: (value: ProviderSettingsTab,) => void;
  },
) {
  const tabs = [
    { label: "AI", value: "ai", },
    { label: "Dictation", value: "dictation", },
  ] as const satisfies ReadonlyArray<{ label: string; value: ProviderSettingsTab; }>;

  return (
    <div role="tablist" aria-label="Provider settings" className="flex gap-2">
      {tabs.map((tab,) => {
        const isSelected = tab.value === selected;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={isSelected}
            onClick={() => onChange(tab.value,)}
            className={`min-w-[104px] rounded-none border px-3 py-1.5 text-[13px] text-left transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-violet-500/30 ${
              isSelected
                ? "border-violet-300 bg-violet-50 text-violet-700"
                : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"
            }`}
            style={mono}
          >
            {tab.label}
          </button>
        );
      },)}
    </div>
  );
}

function ProviderConfigurationPanel(
  {
    children,
    description,
    eyebrow,
    status,
    statusTone = "muted",
    title,
  }: {
    children: React.ReactNode;
    description: string;
    eyebrow: string;
    status: string;
    statusTone?: "accent" | "muted";
    title: string;
  },
) {
  return (
    <div className="rounded-none border border-gray-200 bg-gray-50/60 p-3">
      <div className="flex flex-col gap-2 border-b border-gray-200 pb-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-[0.18em] text-gray-400" style={mono}>
            {eyebrow}
          </p>
          <h3 className="text-[13px] text-gray-900" style={mono}>
            {title}
          </h3>
          <p className="text-[11px] leading-4 text-gray-400" style={mono}>
            {description}
          </p>
        </div>
        <span
          className={`inline-flex items-center self-start rounded-none border px-2 py-1 text-[9px] uppercase tracking-[0.18em] ${
            statusTone === "accent"
              ? "border-violet-200 bg-violet-50 text-violet-700"
              : "border-gray-200 bg-white text-gray-500"
          }`}
          style={mono}
        >
          {status}
        </span>
      </div>
      <div className="mt-3 space-y-4">
        {children}
      </div>
    </div>
  );
}

function SharpSelectField<T extends string,>(
  {
    label,
    options,
    value,
    onChange,
  }: {
    label: string;
    options: Array<{ hint: string; label: string; value: T; }>;
    value: T;
    onChange: (value: T,) => void;
  },
) {
  const [open, setOpen,] = useState(false,);
  const rootRef = useRef<HTMLDivElement>(null,);
  const selected = options.find((option,) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent,) => {
      if (!rootRef.current?.contains(event.target as Node,)) {
        setOpen(false,);
      }
    };

    const handleEscape = (event: KeyboardEvent,) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false,);
      }
    };

    window.addEventListener("mousedown", handlePointerDown,);
    window.addEventListener("keydown", handleEscape,);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown,);
      window.removeEventListener("keydown", handleEscape,);
    };
  }, [open,],);

  return (
    <div ref={rootRef} className="relative space-y-2">
      <label className="block text-xs text-gray-500" style={mono}>
        {label}
      </label>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current,) => !current)}
        className={`flex min-h-12 w-full items-center justify-between rounded-none border px-3 py-2 text-left transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-violet-500/30 ${
          open
            ? "border-gray-900 bg-gray-50"
            : "border-gray-200 bg-white hover:bg-gray-50"
        }`}
        style={mono}
      >
        <span className="min-w-0">
          <span className="block text-[10px] uppercase tracking-[0.18em] text-gray-400">
            {selected.hint}
          </span>
          <span className="block truncate text-sm leading-5 text-gray-700">
            {selected.label}
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={label}
          className="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-none border border-gray-900 bg-white shadow-[0_14px_32px_rgba(15,23,42,0.14)]"
        >
          {options.map((option,) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.value,);
                  setOpen(false,);
                }}
                className={`flex w-full items-center justify-between border-t px-3 py-2 text-left transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-violet-500/30 first:border-t-0 ${
                  isSelected
                    ? "bg-gray-900 text-white"
                    : "bg-white text-gray-700 hover:bg-gray-50"
                }`}
                style={mono}
              >
                <span className="min-w-0">
                  <span
                    className={`block text-[10px] uppercase tracking-[0.18em] ${
                      isSelected ? "text-gray-300" : "text-gray-400"
                    }`}
                  >
                    {option.hint}
                  </span>
                  <span className="block truncate text-sm leading-5">{option.label}</span>
                </span>
                <Check className={`h-4 w-4 shrink-0 ${isSelected ? "opacity-100" : "opacity-0"}`} strokeWidth={2.2} />
              </button>
            );
          },)}
        </div>
      )}
    </div>
  );
}

export function SettingsModal({ open, onClose, }: SettingsModalProps,) {
  const [settings, setSettings,] = useState<Settings | null>(null,);
  const [providerSettingsTab, setProviderSettingsTab,] = useState<ProviderSettingsTab>("ai",);
  const [saveState, setSaveState,] = useState<"idle" | "saving" | "error">("idle",);
  const [validationErrors, setValidationErrors,] = useState<Partial<Record<ValidationField, string>>>({},);
  const [isFilenamePatternFocused, setIsFilenamePatternFocused,] = useState(false,);
  const [defaultJournalDir, setDefaultJournalDir,] = useState("",);
  const [googleAction, setGoogleAction,] = useState<
    null | {
      type: "connecting" | "refreshing" | "disconnecting";
      email?: string;
    }
  >(null,);
  const [googleError, setGoogleError,] = useState("",);
  const [googleSessionAccounts, setGoogleSessionAccounts,] = useState<string[]>([],);
  const [isObsidianVault, setIsObsidianVault,] = useState(false,);
  const inputRef = useRef<HTMLInputElement>(null,);
  const modalRef = useRef<HTMLDivElement>(null,);
  const filenamePatternSectionRef = useRef<HTMLDivElement>(null,);
  const filenamePatternInputRef = useRef<HTMLInputElement>(null,);
  const sttApiKeyInputRef = useRef<HTMLInputElement>(null,);
  const sttModelInputRef = useRef<HTMLInputElement>(null,);
  const settingsRef = useRef<Settings | null>(null,);
  const lastSavedSettingsRef = useRef<Settings | null>(null,);
  const activeSaveRef = useRef<Promise<void> | null>(null,);
  const googleAbortControllerRef = useRef<AbortController | null>(null,);

  useEffect(() => {
    if (open) {
      loadSettings().then((s,) => {
        settingsRef.current = s;
        lastSavedSettingsRef.current = s;
        setSettings(s,);
        setProviderSettingsTab("ai",);
        setSaveState("idle",);
        setValidationErrors({},);
        setIsFilenamePatternFocused(false,);
        setGoogleAction(null,);
        setGoogleError("",);
        setGoogleSessionAccounts([],);
      },);
      // Resolve the default journal dir for display
      getJournalDir().then(setDefaultJournalDir,);
      setTimeout(() => inputRef.current?.focus(), 100,);
    }
  }, [open,],);

  useEffect(() => {
    if (open) return;
    googleAbortControllerRef.current?.abort();
    googleAbortControllerRef.current = null;
  }, [open,],);

  useEffect(() => {
    const vaultPath = settings?.vaultDir.trim();
    if (!open || !vaultPath) {
      setIsObsidianVault(false,);
      return;
    }

    let cancelled = false;

    join(vaultPath, ".obsidian",)
      .then((obsidianPath,) => exists(obsidianPath,))
      .then((found,) => {
        if (!cancelled) {
          setIsObsidianVault(found,);
        }
      },)
      .catch(() => {
        if (!cancelled) {
          setIsObsidianVault(false,);
        }
      },);

    return () => {
      cancelled = true;
    };
  }, [open, settings?.vaultDir,],);

  useEffect(() => {
    if (!open || !settings) return;

    let cancelled = false;
    invoke<string[]>("list_google_oauth_session_accounts",)
      .then((accounts,) => {
        if (!cancelled) {
          setGoogleSessionAccounts(accounts.map((account,) => account.trim().toLowerCase()),);
        }
      },)
      .catch(() => {
        if (!cancelled) {
          setGoogleSessionAccounts([],);
        }
      },);

    return () => {
      cancelled = true;
    };
  }, [open, settings?.googleAccounts,],);

  const buildPersistedSettings = async (current: Settings,) => {
    const normalizedVault = current.vaultDir.trim();
    const normalizedDaily = current.dailyLogsFolder.trim();
    const normalizedOpenAiApiKey = current.openaiApiKey.trim();
    const normalizedSttApiKey = current.sttApiKey.trim();
    return {
      ...current,
      anthropicApiKey: current.anthropicApiKey.trim(),
      openaiApiKey: normalizedOpenAiApiKey,
      googleApiKey: current.googleApiKey.trim(),
      openrouterApiKey: current.openrouterApiKey.trim(),
      currentSttModel: current.currentSttModel.trim(),
      sttBaseUrl: current.sttBaseUrl.trim(),
      sttApiKey: current.currentSttProvider === "openai" && normalizedSttApiKey === normalizedOpenAiApiKey
        ? ""
        : normalizedSttApiKey,
      spokenLanguages: [
        ...new Set(
          current.spokenLanguages.map((language,) => language.trim().toLowerCase()).filter(Boolean,),
        ),
      ],
      saveRecordings: current.saveRecordings !== false,
      googleOAuthClientId: current.googleOAuthClientId.trim(),
      googleAccounts: current.googleAccounts.map((account,) => ({
        email: account.email.trim(),
        accessTokenExpiresAt: account.accessTokenExpiresAt,
        grantedScopes: [...account.grantedScopes,],
      })),
      googleAccountEmail: current.googleAccountEmail.trim(),
      googleAccessToken: current.googleAccessToken.trim(),
      googleRefreshToken: current.googleRefreshToken.trim(),
      googleAccessTokenExpiresAt: current.googleAccessTokenExpiresAt,
      googleGrantedScopes: [...current.googleGrantedScopes,],
      vaultDir: normalizedVault,
      dailyLogsFolder: normalizedDaily,
      excalidrawFolder: current.excalidrawFolder.trim(),
      assetsFolder: current.assetsFolder.trim(),
      journalDir: normalizedVault && normalizedDaily
        ? await join(normalizedVault, normalizedDaily,)
        : current.journalDir,
    };
  };

  const buildGooglePatch = (current: Settings, partial: Partial<Settings>,) => ({
    googleOAuthClientId: (partial.googleOAuthClientId ?? current.googleOAuthClientId).trim(),
    googleAccounts: partial.googleAccounts ?? current.googleAccounts,
  });

  const persistSettingsNow = async (nextSettings: Settings,) => {
    const task = (async () => {
      try {
        const normalized = await buildPersistedSettings(nextSettings,);
        await saveSettings(normalized,);

        const previous = lastSavedSettingsRef.current;
        const scopeChanged = !previous
          || previous.journalDir !== normalized.journalDir
          || previous.vaultDir !== normalized.vaultDir
          || previous.dailyLogsFolder !== normalized.dailyLogsFolder
          || previous.excalidrawFolder !== normalized.excalidrawFolder
          || previous.assetsFolder !== normalized.assetsFolder;

        if (scopeChanged) {
          await resetJournalDir(normalized.journalDir || undefined,);
          await initJournalScope();
        }

        lastSavedSettingsRef.current = normalized;
        settingsRef.current = normalized;
        setSettings(normalized,);
      } catch (err) {
        console.error("Failed to save settings:", err,);
        setSaveState("error",);
        throw err;
      }
    })();

    activeSaveRef.current = task;
    await task;
    if (activeSaveRef.current === task) {
      activeSaveRef.current = null;
    }
  };

  const update = (partial: Partial<Settings>,) => {
    const current = settingsRef.current;
    if (!current) return;
    const nextSettings = { ...current, ...partial, };
    settingsRef.current = nextSettings;
    setSettings(nextSettings,);
    if (saveState === "error") {
      setSaveState("idle",);
    }
    if (
      validationErrors.filenamePattern
      && Object.prototype.hasOwnProperty.call(partial, "filenamePattern",)
    ) {
      setValidationErrors((currentErrors,) => {
        const nextErrors = { ...currentErrors, };
        delete nextErrors.filenamePattern;
        return nextErrors;
      },);
    }
  };

  const persistGooglePatch = async (partial: Partial<Settings>,) => {
    const currentDraft = settingsRef.current ?? settings;
    if (!currentDraft) return;
    const googlePatch = buildGooglePatch(currentDraft, partial,);
    const persisted = await loadSettings();
    const savedSettings = { ...persisted, ...googlePatch, };
    await saveSettings(savedSettings,);
    const nextDraft: Settings = { ...currentDraft, ...googlePatch, };
    settingsRef.current = nextDraft;
    lastSavedSettingsRef.current = savedSettings;
    setSettings(nextDraft,);
    setSaveState("idle",);
  };

  const updateAiKey = (provider: AiProvider, value: string,) => {
    switch (provider) {
      case "anthropic":
        update({ aiProvider: provider, anthropicApiKey: value, },);
        break;
      case "openai":
        update({ aiProvider: provider, openaiApiKey: value, },);
        break;
      case "google":
        update({ aiProvider: provider, googleApiKey: value, },);
        break;
      case "openrouter":
        update({ aiProvider: provider, openrouterApiKey: value, },);
        break;
    }
  };

  const handleSttProviderChange = (provider: SttProvider,) => {
    update({
      currentSttProvider: provider,
      currentSttModel: getDefaultSttModel(provider,),
      sttBaseUrl: getDefaultSttBaseUrl(provider,),
    },);
  };

  const handleSttModelChange = (model: string,) => {
    const currentSettings = settingsRef.current ?? settings;
    if (!currentSettings) return;
    const suggestedModels = getSuggestedSttModels(currentSettings.currentSttProvider,);
    const hasPresetSttModel = suggestedModels.includes(currentSettings.currentSttModel.trim(),);

    if (model === CUSTOM_STT_MODEL_VALUE) {
      update({ currentSttModel: hasPresetSttModel ? "" : currentSettings.currentSttModel, },);
      requestAnimationFrame(() => {
        sttModelInputRef.current?.focus();
        sttModelInputRef.current?.select();
      },);
      return;
    }

    update({ currentSttModel: model, },);
  };

  const handleConnectGoogle = async () => {
    const controller = new AbortController();
    googleAbortControllerRef.current = controller;
    setGoogleAction({ type: "connecting", },);
    setGoogleError("",);
    try {
      const currentSettings = settingsRef.current;
      if (!currentSettings) return;
      const googlePatch = await connectGoogleAccount(currentSettings, { signal: controller.signal, },);
      if (controller.signal.aborted) return;
      await persistGooglePatch(googlePatch,);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      const message = getErrorMessage(err, "Failed to connect Google account.",);
      setGoogleError(message,);
    } finally {
      if (googleAbortControllerRef.current === controller) {
        googleAbortControllerRef.current = null;
        setGoogleAction(null,);
      }
    }
  };

  const handleRefreshGoogle = async (accountEmail: string,) => {
    const controller = new AbortController();
    googleAbortControllerRef.current = controller;
    setGoogleAction({ type: "refreshing", email: accountEmail, },);
    setGoogleError("",);
    try {
      const currentSettings = settingsRef.current;
      if (!currentSettings) return;
      const googlePatch = await connectGoogleAccount(currentSettings, {
        expectedAccountEmail: accountEmail,
        signal: controller.signal,
      },);
      if (controller.signal.aborted) return;
      await persistGooglePatch(googlePatch,);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      const message = getErrorMessage(err, "Failed to refresh Google account.",);
      setGoogleError(message,);
    } finally {
      if (googleAbortControllerRef.current === controller) {
        googleAbortControllerRef.current = null;
        setGoogleAction(null,);
      }
    }
  };

  const cancelGoogleConnect = () => {
    const controller = googleAbortControllerRef.current;
    if (!controller) return;
    googleAbortControllerRef.current = null;
    controller.abort();
    setGoogleAction(null,);
    setGoogleError("",);
  };

  const handleDisconnectGoogle = async (accountEmail: string,) => {
    setGoogleAction({ type: "disconnecting", email: accountEmail, },);
    setGoogleError("",);
    try {
      const currentSettings = settingsRef.current;
      if (!currentSettings) return;
      const nextSettings = await disconnectGoogleAccount(currentSettings, accountEmail,);
      settingsRef.current = nextSettings;
      lastSavedSettingsRef.current = nextSettings;
      setSettings(nextSettings,);
    } finally {
      setGoogleAction(null,);
    }
  };

  const detectFromVault = async (vaultDir: string,) => {
    const normalizedVaultDir = vaultDir.trim();
    if (!normalizedVaultDir) return null;

    const detected = await detectObsidianFolders(normalizedVaultDir,);
    return {
      filenamePattern: detected.filenamePattern || undefined,
      dailyLogsFolder: detected.dailyLogsFolder || undefined,
      excalidrawFolder: detected.excalidrawFolder || undefined,
      assetsFolder: detected.assetsFolder || undefined,
    };
  };

  const handleChooseVault = async () => {
    if (!settings) return;
    const defaultPath = (settings.vaultDir || settings.journalDir || defaultJournalDir).trim();
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: defaultPath || undefined,
    },);
    if (selected) {
      const detected = await detectFromVault(selected,);
      update({
        vaultDir: selected,
        ...(detected ?? {}),
      },);
    }
  };

  const validateSettings = (current: Settings,) => {
    const nextErrors: Partial<Record<ValidationField, string>> = {};
    const pattern = current.filenamePattern.trim();

    if (pattern) {
      const hasRequiredTokens = ["YYYY", "MM", "DD",].every((token,) => pattern.includes(`{${token}}`,));
      if (!hasRequiredTokens) {
        nextErrors.filenamePattern = "Include {YYYY}, {MM}, and {DD} in the filename pattern.";
      } else {
        const unsupportedTokens = Array.from(pattern.matchAll(/\{([^}]+)\}/g,),)
          .map((match,) => match[1])
          .filter((token,) => !["YYYY", "MM", "DD",].includes(token,));

        if (unsupportedTokens.length > 0) {
          nextErrors.filenamePattern = "Only {YYYY}, {MM}, and {DD} tokens are supported.";
        } else {
          const preview = applyFilenamePattern(pattern, getToday(),);
          const segments = preview.split("/",);
          if (segments.some((segment,) => segment.trim().length === 0)) {
            nextErrors.filenamePattern = "Filename pattern cannot start or end with / or contain empty folders.";
          }
        }
      }
    }

    return nextErrors;
  };

  const shakeModal = () => {
    const modal = modalRef.current;
    if (!modal) return;
    modal.style.animation = "none";
    void modal.offsetWidth;
    modal.style.animation = "settings-modal-shake 280ms ease-in-out";
  };

  const revealValidationError = (field: ValidationField,) => {
    if (field === "filenamePattern") {
      filenamePatternSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center", },);
      filenamePatternInputRef.current?.focus();
      filenamePatternInputRef.current?.select();
    }
  };

  const handleRequestClose = async () => {
    cancelGoogleConnect();
    const nextSettings = settingsRef.current;
    if (!nextSettings) {
      onClose();
      return;
    }

    const nextErrors = validateSettings(nextSettings,);
    if (Object.keys(nextErrors,).length > 0) {
      setValidationErrors(nextErrors,);
      setSaveState("idle",);
      shakeModal();
      const firstField = (["filenamePattern",] as const).find((field,) => nextErrors[field]);
      if (firstField) {
        requestAnimationFrame(() => revealValidationError(firstField,));
      }
      return;
    }

    setSaveState("saving",);
    try {
      await persistSettingsNow(nextSettings,);
      onClose();
    } catch {
      // Keep the modal open so the user can retry or copy their changes.
    }
  };

  useEffect(() => {
    if (!open) return;

    const handleEscape = (event: KeyboardEvent,) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      void handleRequestClose();
    };

    window.addEventListener("keydown", handleEscape,);
    return () => {
      window.removeEventListener("keydown", handleEscape,);
    };
  }, [open, handleRequestClose,],);

  const handleHeaderMouseDown = (e: React.MouseEvent<HTMLDivElement>,) => {
    if (e.buttons === 1 && !(e.target as HTMLElement).closest("button, input",)) {
      e.detail === 2
        ? void getCurrentWindow().toggleMaximize()
        : void getCurrentWindow().startDragging();
    }
  };

  if (!open || !settings) return null;

  const effectivePattern = settings.filenamePattern || DEFAULT_FILENAME_PATTERN;
  const filenamePreview = applyFilenamePattern(effectivePattern, getToday(),) + ".md";
  const googleConnected = isGoogleAccountConnected(settings,);
  const googleAccounts = settings.googleAccounts;
  const isGoogleConnecting = googleAction?.type === "connecting";
  const refreshingGoogleAccount = googleAction?.type === "refreshing" ? googleAction.email : null;
  const isGoogleBusy = googleAction !== null;
  const selectedAiProvider = settings.aiProvider;
  const selectedAiKey = getAiProviderDraftKey(settings, selectedAiProvider,);
  const selectedAiHasKey = Boolean(selectedAiKey.trim(),);
  const trimmedOpenAiApiKey = settings.openaiApiKey.trim();
  const isReusingOpenAiSttKey = settings.currentSttProvider === "openai"
    && !settings.sttApiKey.trim()
    && Boolean(trimmedOpenAiApiKey,);
  const displayedSttApiKey = isReusingOpenAiSttKey ? settings.openaiApiKey : settings.sttApiKey;
  const suggestedSttModels = getSuggestedSttModels(settings.currentSttProvider,);
  const normalizedCurrentSttModel = settings.currentSttModel.trim();
  const hasPresetSttModel = suggestedSttModels.includes(normalizedCurrentSttModel,);
  const selectedSttModelValue = hasPresetSttModel ? normalizedCurrentSttModel : CUSTOM_STT_MODEL_VALUE;
  const showCustomSttModelInput = settings.currentSttProvider === "custom"
    || selectedSttModelValue === CUSTOM_STT_MODEL_VALUE;
  const activeSttConfigured = Boolean(
    (settings.currentSttModel.trim() || getDefaultSttModel(settings.currentSttProvider,))
      && (settings.sttBaseUrl.trim() || getDefaultSttBaseUrl(settings.currentSttProvider,))
      && displayedSttApiKey.trim()
      && settings.spokenLanguages.length > 0,
  );
  const activeProviderDescription = providerSettingsTab === "ai"
    ? "Choose the provider for summaries and chat. Keys stay on this device."
    : "Choose the speech-to-text provider for recording. Recording auth stays on this device.";

  return (
    <div
      className="fixed inset-0 z-[100]"
      onClick={() => void handleRequestClose()}
    >
      <style>
        {`
          @keyframes settings-modal-shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-8px); }
            75% { transform: translateX(8px); }
          }
        `}
      </style>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="relative flex h-full w-full flex-col bg-white"
        onClick={(e,) => e.stopPropagation()}
      >
        <div
          className="border-b border-gray-100"
          onMouseDown={handleHeaderMouseDown}
        >
          <div className="grid h-[38px] w-full grid-cols-[96px_minmax(0,1fr)_96px] items-center px-3">
            <div />
            <h2 className="justify-self-center text-base font-medium text-gray-900" style={mono}>
              Settings
            </h2>
            <button
              type="button"
              onClick={() => void handleRequestClose()}
              className="justify-self-end rounded-md p-1 text-gray-400 transition-colors cursor-pointer hover:bg-gray-100 hover:text-gray-600"
              aria-label="Close settings"
            >
              <X className="h-5 w-5" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        <div className="modal-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto flex w-full max-w-4xl flex-col px-6 py-6">
            <div className="space-y-4">
              <ProviderModeTabs
                selected={providerSettingsTab}
                onChange={setProviderSettingsTab}
              />
              <p className="text-[11px] leading-4 text-gray-400" style={mono}>
                {activeProviderDescription}
              </p>
              {providerSettingsTab === "ai"
                ? (
                  <>
                    <ProviderConfigurationPanel
                      eyebrow="Active provider"
                      title={getAiProviderLabel(selectedAiProvider,)}
                      description="Philo uses the selected provider for summaries and chat."
                      status={selectedAiHasKey ? "Configured" : "Missing API key"}
                      statusTone={selectedAiHasKey ? "accent" : "muted"}
                    >
                      <div className="space-y-2">
                        <SharpSelectField
                          label="Provider"
                          options={AI_PROVIDERS.map((provider,) => ({
                            hint: getAiProviderDraftKey(settings, provider,).trim() ? "Saved" : "Add key",
                            label: getAiProviderLabel(provider,),
                            value: provider,
                          }))}
                          value={selectedAiProvider}
                          onChange={(provider,) => {
                            update({ aiProvider: provider, },);
                            requestAnimationFrame(() => {
                              inputRef.current?.focus();
                              inputRef.current?.select();
                            },);
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="block text-xs text-gray-500" style={mono}>
                          API key
                        </label>
                        <input
                          ref={inputRef}
                          type="password"
                          value={selectedAiKey}
                          onChange={(e,) => updateAiKey(selectedAiProvider, e.target.value,)}
                          placeholder={AI_PROVIDER_PLACEHOLDERS[selectedAiProvider]}
                          className="w-full border border-gray-200 bg-white px-3 py-2 text-sm transition-all focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                          style={mono}
                        />
                      </div>
                    </ProviderConfigurationPanel>
                  </>
                )
                : (
                  <>
                    <ProviderConfigurationPanel
                      eyebrow="Active provider"
                      title={getSttProviderLabel(settings.currentSttProvider,)}
                      description="Recording uses this provider. Summaries continue to use the AI provider above."
                      status={isReusingOpenAiSttKey
                        ? "Reusing OpenAI key"
                        : activeSttConfigured
                        ? "Configured"
                        : "Needs setup"}
                      statusTone={isReusingOpenAiSttKey || activeSttConfigured ? "accent" : "muted"}
                    >
                      <div className="space-y-2">
                        <SharpSelectField
                          label="Provider"
                          options={STT_PROVIDERS.map((provider,) => ({
                            hint: STT_PROVIDER_HINTS[provider],
                            label: getSttProviderLabel(provider,),
                            value: provider,
                          }))}
                          value={settings.currentSttProvider}
                          onChange={handleSttProviderChange}
                        />
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-2">
                          {settings.currentSttProvider === "custom"
                            ? (
                              <>
                                <label className="block text-xs text-gray-500" style={mono}>
                                  Model
                                </label>
                                <input
                                  ref={sttModelInputRef}
                                  type="text"
                                  value={settings.currentSttModel}
                                  onChange={(e,) => update({ currentSttModel: e.target.value, },)}
                                  placeholder="Enter model ID"
                                  className="w-full border border-gray-200 bg-white px-3 py-2 text-sm transition-all focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                                  style={mono}
                                />
                                <p className="text-[11px] text-gray-400" style={mono}>
                                  Paste the upstream model ID your API expects.
                                </p>
                              </>
                            )
                            : (
                              <>
                                <SharpSelectField
                                  label="Model"
                                  options={[
                                    ...suggestedSttModels.map((model,) => ({
                                      hint: getSttModelHint(model,),
                                      label: getSttModelLabel(model,),
                                      value: model,
                                    })),
                                    {
                                      hint: "Manual",
                                      label: "Custom model ID",
                                      value: CUSTOM_STT_MODEL_VALUE,
                                    },
                                  ]}
                                  value={selectedSttModelValue}
                                  onChange={handleSttModelChange}
                                />
                                {showCustomSttModelInput && (
                                  <input
                                    ref={sttModelInputRef}
                                    type="text"
                                    value={settings.currentSttModel}
                                    onChange={(e,) => update({ currentSttModel: e.target.value, },)}
                                    placeholder={getDefaultSttModel(settings.currentSttProvider,)}
                                    className="w-full border border-gray-200 bg-white px-3 py-2 text-sm transition-all focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                                    style={mono}
                                  />
                                )}
                                <p className="text-[11px] text-gray-400" style={mono}>
                                  {showCustomSttModelInput
                                    ? "Use a manual model ID if your provider needs something outside the presets."
                                    : `Model ID: ${settings.currentSttModel}`}
                                </p>
                              </>
                            )}
                        </div>
                        <div className="space-y-2">
                          <label className="block text-xs text-gray-500" style={mono}>
                            Spoken languages
                          </label>
                          <SpokenLanguagesField
                            value={settings.spokenLanguages}
                            onChange={(spokenLanguages,) => update({ spokenLanguages, },)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                        <div className="space-y-2">
                          <label className="block text-xs text-gray-500" style={mono}>
                            Base URL
                          </label>
                          <input
                            type="text"
                            value={settings.sttBaseUrl}
                            onChange={(e,) => update({ sttBaseUrl: e.target.value, },)}
                            placeholder={getDefaultSttBaseUrl(settings.currentSttProvider,) || "https://example.com/v1"}
                            className="w-full border border-gray-200 bg-white px-3 py-2 text-sm transition-all focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                            style={mono}
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="block text-xs text-gray-500" style={mono}>
                            STT API key
                          </label>
                          <input
                            ref={sttApiKeyInputRef}
                            type="password"
                            value={displayedSttApiKey}
                            onChange={(e,) => update({ sttApiKey: e.target.value, },)}
                            placeholder={settings.currentSttProvider === "openai"
                              ? "Leave blank to reuse OpenAI key"
                              : "Enter BYOK STT key"}
                            readOnly={isReusingOpenAiSttKey}
                            className="w-full border border-gray-200 bg-white px-3 py-2 text-sm transition-all focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                            style={mono}
                          />
                          {isReusingOpenAiSttKey && (
                            <div
                              className="flex items-center justify-between gap-3 text-[11px] text-gray-400"
                              style={mono}
                            >
                              <span>Using your OpenAI key above.</span>
                              <button
                                type="button"
                                onClick={() => {
                                  update({ sttApiKey: settings.openaiApiKey, },);
                                  requestAnimationFrame(() => {
                                    sttApiKeyInputRef.current?.focus();
                                    sttApiKeyInputRef.current?.select();
                                  },);
                                }}
                                className="text-violet-600 transition-colors cursor-pointer hover:text-violet-700"
                              >
                                Use separate key
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="space-y-2 pt-1">
                        <label className="block text-sm text-gray-600" style={mono}>
                          Save raw recordings
                        </label>
                        <button
                          type="button"
                          onClick={() => update({ saveRecordings: !settings.saveRecordings, },)}
                          className={`flex w-full items-center justify-between rounded-none border px-3 py-2 text-left text-sm transition-colors cursor-pointer ${
                            settings.saveRecordings
                              ? "border-violet-300 bg-violet-50/40 text-violet-700"
                              : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                          }`}
                          style={mono}
                        >
                          <span>{settings.saveRecordings ? "Enabled" : "Disabled"}</span>
                          <span
                            className={`inline-flex h-5 w-9 items-center border ${
                              settings.saveRecordings
                                ? "border-violet-400 bg-violet-600 justify-end"
                                : "border-gray-300 bg-gray-200 justify-start"
                            }`}
                          >
                            <span className="mx-0.5 h-3.5 w-3.5 bg-white" />
                          </span>
                        </button>
                        <p className="text-xs text-gray-400" style={mono}>
                          Transcript capture still works without AI. Summary generation uses your existing AI provider
                          separately.
                        </p>
                      </div>
                    </ProviderConfigurationPanel>
                  </>
                )}
            </div>

            <div className="my-5 border-t border-gray-100" />

            <div className="space-y-3">
              <label className="block text-sm text-gray-600" style={mono}>
                Google Account
              </label>
              <p className="text-xs text-gray-400" style={mono}>
                Connect your account to get summaries
              </p>
              {googleConnected
                ? (
                  <div className="space-y-1.5">
                    {googleAccounts.map((account,) => {
                      const isRefreshing = refreshingGoogleAccount === account.email;
                      const isDisconnecting = googleAction?.type === "disconnecting"
                        && googleAction.email === account.email;
                      const hasSecureSession = googleSessionAccounts.includes(account.email.trim().toLowerCase(),);
                      const isRefreshDisabled = isGoogleBusy && !isRefreshing;
                      return (
                        <div key={account.email} className="flex min-w-0 items-start gap-1">
                          <div className="min-w-0 flex-1">
                            <p
                              className="min-w-0 truncate text-xs text-gray-500"
                              style={mono}
                              title={account.email}
                            >
                              {account.email}
                            </p>
                            {!hasSecureSession && (
                              <p className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-amber-600" style={mono}>
                                Reconnect required
                              </p>
                            )}
                          </div>
                          <button
                            onClick={() => {
                              if (isRefreshing) {
                                cancelGoogleConnect();
                                return;
                              }
                              void handleRefreshGoogle(account.email,);
                            }}
                            disabled={isRefreshDisabled}
                            className={`group relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-none transition-colors cursor-pointer focus:outline-none focus:ring-2 disabled:cursor-default disabled:opacity-60 ${
                              hasSecureSession
                                ? "text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700 focus:ring-emerald-300/40"
                                : "text-amber-600 hover:bg-amber-50 hover:text-amber-700 focus:ring-amber-300/40"
                            }`}
                            title={isRefreshing
                              ? `Cancel reconnect for ${account.email}`
                              : `${hasSecureSession ? "Refresh" : "Reconnect"} ${account.email}`}
                            aria-label={isRefreshing
                              ? `Cancel reconnect for ${account.email}`
                              : `${hasSecureSession ? "Refresh" : "Reconnect"} ${account.email}`}
                          >
                            {isRefreshing
                              ? <X className="h-3.5 w-3.5" strokeWidth={2.1} />
                              : (
                                <>
                                  {hasSecureSession
                                    ? (
                                      <Check
                                        className="h-3.5 w-3.5 transition-opacity group-hover:opacity-0"
                                        strokeWidth={2.25}
                                      />
                                    )
                                    : (
                                      <AlertTriangle
                                        className="h-3.5 w-3.5 transition-opacity group-hover:opacity-0"
                                        strokeWidth={2.1}
                                      />
                                    )}
                                  <RefreshCw
                                    className="absolute h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100"
                                    strokeWidth={2}
                                  />
                                </>
                              )}
                          </button>
                          <button
                            onClick={() => handleDisconnectGoogle(account.email,)}
                            disabled={isGoogleBusy}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-none text-gray-400 transition-colors cursor-pointer hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-300/40 disabled:cursor-default disabled:opacity-60"
                            title={`Disconnect ${account.email}`}
                            aria-label={`Disconnect ${account.email}`}
                          >
                            <X className={`h-3.5 w-3.5 ${isDisconnecting ? "opacity-60" : ""}`} strokeWidth={2} />
                          </button>
                        </div>
                      );
                    },)}
                  </div>
                )
                : (
                  <p className="text-xs text-gray-500" style={mono}>
                    No Google account connected yet.
                  </p>
                )}
              {googleError && (
                <p className="text-xs text-red-600" style={mono}>
                  {googleError}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => {
                    if (isGoogleConnecting) {
                      cancelGoogleConnect();
                      return;
                    }
                    void handleConnectGoogle();
                  }}
                  disabled={isGoogleBusy && !isGoogleConnecting}
                  className="inline-flex min-h-10 items-center gap-3 rounded-none border px-3 pr-4 text-[14px] leading-5 font-medium text-[#1f1f1f] transition-colors cursor-pointer hover:bg-[#e8eaed] focus:outline-none focus:ring-2 focus:ring-[#1a73e8]/20 disabled:cursor-default disabled:opacity-60"
                  style={{
                    ...googleButtonText,
                    backgroundColor: "#f2f2f2",
                    borderColor: "#d2d2d2",
                  }}
                >
                  <GoogleMark />
                  <span>
                    {isGoogleConnecting
                      ? "Cancel"
                      : googleConnected
                      ? "Connect more"
                      : "Continue with Google"}
                  </span>
                </button>
              </div>
              <div className="grid gap-3 pt-2 md:grid-cols-2">
                <SharpSelectField
                  label="Email opens in"
                  options={GOOGLE_EMAIL_OPEN_CLIENTS.map((client,) => ({
                    hint: GOOGLE_EMAIL_OPEN_CLIENT_HINTS[client],
                    label: GOOGLE_EMAIL_OPEN_CLIENT_LABELS[client],
                    value: client,
                  }))}
                  value={settings.googleEmailOpenClient}
                  onChange={(value,) => update({ googleEmailOpenClient: value, },)}
                />
                <SharpSelectField
                  label="Calendar opens in"
                  options={GOOGLE_CALENDAR_OPEN_CLIENTS.map((client,) => ({
                    hint: GOOGLE_CALENDAR_OPEN_CLIENT_HINTS[client],
                    label: GOOGLE_CALENDAR_OPEN_CLIENT_LABELS[client],
                    value: client,
                  }))}
                  value={settings.googleCalendarOpenClient}
                  onChange={(value,) => update({ googleCalendarOpenClient: value, },)}
                />
              </div>
            </div>

            <div className="my-5 border-t border-gray-100" />

            <div className="space-y-3">
              <label className="block text-sm text-gray-600" style={mono}>
                Vault Location
              </label>
              <div className="flex items-center gap-2">
                <div
                  className="flex-1 min-w-0 px-3 py-2 border border-gray-200 rounded-none text-sm text-gray-500 bg-gray-50"
                  style={mono}
                  title={settings.vaultDir || settings.journalDir || defaultJournalDir}
                >
                  <VaultPathMarquee
                    path={settings.vaultDir || settings.journalDir || defaultJournalDir || "..."}
                    icon={isObsidianVault ? "obsidian" : "folder"}
                  />
                </div>
                <button
                  onClick={handleChooseVault}
                  className="shrink-0 px-3 py-2 text-sm border border-gray-200 rounded-none hover:bg-gray-50 transition-colors cursor-pointer text-gray-700"
                  style={mono}
                >
                  Choose…
                </button>
              </div>
              {settings.vaultDir && (
                <button
                  onClick={() => update({ vaultDir: "", },)}
                  className="text-xs text-violet-600 hover:text-violet-800 transition-colors cursor-pointer"
                  style={mono}
                >
                  Reset to default
                </button>
              )}
              <div className="grid gap-3 lg:grid-cols-3">
                <div className="space-y-2 lg:col-span-1">
                  <label className="block text-sm text-gray-600 pt-2" style={mono}>
                    Daily logs folder
                  </label>
                  <input
                    type="text"
                    value={settings.dailyLogsFolder}
                    onChange={(e,) => update({ dailyLogsFolder: e.target.value, },)}
                    placeholder="Daily Notes"
                    className="w-full px-3 py-2 border border-gray-200 rounded-none text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all"
                    style={mono}
                  />
                </div>
                <div className="space-y-2 lg:col-span-1">
                  <label className="block text-sm text-gray-600 pt-2" style={mono}>
                    Excalidraw folder (optional)
                  </label>
                  <input
                    type="text"
                    value={settings.excalidrawFolder}
                    onChange={(e,) => update({ excalidrawFolder: e.target.value, },)}
                    placeholder="Excalidraw"
                    className="w-full px-3 py-2 border border-gray-200 rounded-none text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all"
                    style={mono}
                  />
                </div>
                <div className="space-y-2 lg:col-span-1">
                  <label className="block text-sm text-gray-600 pt-2" style={mono}>
                    Assets folder (optional)
                  </label>
                  <input
                    type="text"
                    value={settings.assetsFolder}
                    onChange={(e,) => update({ assetsFolder: e.target.value, },)}
                    placeholder="assets"
                    className="w-full px-3 py-2 border border-gray-200 rounded-none text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all"
                    style={mono}
                  />
                </div>
              </div>
              <div className="space-y-2 pt-2">
                <label className="block text-sm text-gray-600" style={mono}>
                  Widget Git history
                </label>
                <button
                  type="button"
                  onClick={() => update({ widgetGitHistoryEnabled: !settings.widgetGitHistoryEnabled, },)}
                  className={`flex w-full items-center justify-between rounded-none border px-3 py-2 text-left text-sm transition-colors cursor-pointer ${
                    settings.widgetGitHistoryEnabled
                      ? "border-violet-300 bg-violet-50/40 text-violet-700"
                      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                  style={mono}
                >
                  <span>{settings.widgetGitHistoryEnabled ? "Enabled by default" : "Disabled"}</span>
                  <span
                    className={`inline-flex h-5 w-9 items-center border ${
                      settings.widgetGitHistoryEnabled
                        ? "border-violet-400 bg-violet-600 justify-end"
                        : "border-gray-300 bg-gray-200 justify-start"
                    }`}
                  >
                    <span className="mx-0.5 h-3.5 w-3.5 bg-white" />
                  </span>
                </button>
                <p className="text-xs text-gray-400" style={mono}>
                  Keeps an app-managed Git history for widget snapshots. Widget databases are not versioned.
                </p>
              </div>
            </div>

            <div className="my-5 border-t border-gray-100" />

            <div ref={filenamePatternSectionRef} className="space-y-3">
              <label className="block text-sm text-gray-600" style={mono}>
                Filename Pattern
              </label>
              <div className="relative">
                <div
                  className={`pointer-events-none absolute inset-0 flex items-center overflow-hidden px-3 py-2 ${
                    isFilenamePatternFocused ? "opacity-0" : "opacity-100"
                  }`}
                >
                  <FilenamePatternFieldValue
                    value={settings.filenamePattern || DEFAULT_FILENAME_PATTERN}
                    muted={!settings.filenamePattern}
                  />
                </div>
                <input
                  ref={filenamePatternInputRef}
                  type="text"
                  value={settings.filenamePattern}
                  onChange={(e,) => update({ filenamePattern: e.target.value, },)}
                  onFocus={() => setIsFilenamePatternFocused(true,)}
                  onBlur={() => setIsFilenamePatternFocused(false,)}
                  placeholder={DEFAULT_FILENAME_PATTERN}
                  className={`w-full px-3 py-2 border rounded-none text-sm caret-gray-900 focus:outline-none focus:ring-2 transition-all ${
                    isFilenamePatternFocused
                      ? "text-gray-900 placeholder:text-gray-400"
                      : "text-transparent placeholder:text-transparent"
                  } ${
                    validationErrors.filenamePattern
                      ? "border-red-300 bg-red-50/40 focus:ring-red-500/20 focus:border-red-400"
                      : "border-gray-200 focus:ring-violet-500/30 focus:border-violet-400"
                  }`}
                  style={mono}
                />
              </div>
              {validationErrors.filenamePattern && (
                <p className="text-xs text-red-600" style={mono}>
                  {validationErrors.filenamePattern}
                </p>
              )}
              <p className="text-xs text-gray-400" style={mono}>
                Preview: <span className="text-gray-600">{filenamePreview}</span>
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                <span style={mono}>
                  Use <span className="text-gray-600">/</span> for subdirectories.
                </span>
              </div>
            </div>

            <p
              className={`mt-6 text-xs ${
                validationErrors.filenamePattern || saveState === "error"
                  ? "text-red-600"
                  : "text-gray-400"
              }`}
              style={mono}
            >
              {validationErrors.filenamePattern
                ? "Fix the highlighted setting before closing."
                : saveState === "saving"
                ? "Saving changes..."
                : saveState === "error"
                ? "Could not save changes."
                : ""}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
