import { join, } from "@tauri-apps/api/path";
import { open as openDialog, } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, } from "react";
import claudeAiSymbol from "../../assets/claude-ai-symbol.svg";
import googleGeminiIcon from "../../assets/google-gemini-icon.svg";
import openaiSymbol from "../../assets/openai-symbol.svg";
import openrouterIcon from "../../assets/openrouter.svg";
import { connectGoogleAccount, } from "../../services/google";
import { detectObsidianFolders, } from "../../services/obsidian";
import { applyFilenamePattern, getJournalDir, initJournalScope, resetJournalDir, } from "../../services/paths";
import {
  AI_PROVIDERS,
  type AiProvider,
  DEFAULT_FILENAME_PATTERN,
  getAiProviderLabel,
  loadSettings,
  saveSettings,
  type Settings,
} from "../../services/settings";
import { getToday, } from "../../types/note";
import { VaultPathMarquee, } from "../shared/VaultPathMarquee";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type ValidationField = "filenamePattern";

const AI_PROVIDER_PLACEHOLDERS: Record<AiProvider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  google: "AIza...",
  openrouter: "sk-or-v1-...",
};

const AI_PROVIDER_ICONS: Record<AiProvider, string> = {
  anthropic: claudeAiSymbol,
  openai: openaiSymbol,
  google: googleGeminiIcon,
  openrouter: openrouterIcon,
};

const mono = { fontFamily: "'IBM Plex Mono', monospace", };
const googleButtonText = { fontFamily: "'Roboto', 'IBM Plex Sans', sans-serif", };
const filenameTokenChip =
  "inline-flex items-center rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-600";
const FILENAME_TOKEN_REGEX = /(\{YYYY\}|\{MM\}|\{DD\})/g;

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
    ? `inline-flex items-center rounded-md border px-2 py-1 text-xs ${
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

export function SettingsModal({ open, onClose, }: SettingsModalProps,) {
  const [settings, setSettings,] = useState<Settings | null>(null,);
  const [saveState, setSaveState,] = useState<"idle" | "saving" | "error">("idle",);
  const [validationErrors, setValidationErrors,] = useState<Partial<Record<ValidationField, string>>>({},);
  const [defaultJournalDir, setDefaultJournalDir,] = useState("",);
  const [googleBusy, setGoogleBusy,] = useState(false,);
  const [googleError, setGoogleError,] = useState("",);
  const inputRef = useRef<HTMLInputElement>(null,);
  const modalRef = useRef<HTMLDivElement>(null,);
  const filenamePatternSectionRef = useRef<HTMLDivElement>(null,);
  const filenamePatternInputRef = useRef<HTMLInputElement>(null,);
  const settingsRef = useRef<Settings | null>(null,);
  const lastSavedSettingsRef = useRef<Settings | null>(null,);
  const activeSaveRef = useRef<Promise<void> | null>(null,);

  useEffect(() => {
    if (open) {
      loadSettings().then((s,) => {
        settingsRef.current = s;
        lastSavedSettingsRef.current = s;
        setSettings(s,);
        setSaveState("idle",);
        setValidationErrors({},);
        setGoogleBusy(false,);
        setGoogleError("",);
      },);
      // Resolve the default journal dir for display
      getJournalDir().then(setDefaultJournalDir,);
      setTimeout(() => inputRef.current?.focus(), 100,);
    }
  }, [open,],);

  if (!open || !settings) return null;

  const effectivePattern = settings.filenamePattern || DEFAULT_FILENAME_PATTERN;
  const filenamePreview = applyFilenamePattern(effectivePattern, getToday(),) + ".md";

  const buildPersistedSettings = async (current: Settings,) => {
    const normalizedVault = current.vaultDir.trim();
    const normalizedDaily = current.dailyLogsFolder.trim();
    return {
      ...current,
      anthropicApiKey: current.anthropicApiKey.trim(),
      openaiApiKey: current.openaiApiKey.trim(),
      googleApiKey: current.googleApiKey.trim(),
      openrouterApiKey: current.openrouterApiKey.trim(),
      googleOAuthClientId: current.googleOAuthClientId.trim(),
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

  const buildGooglePatch = (partial: Partial<Settings>,) => ({
    googleOAuthClientId: (partial.googleOAuthClientId ?? settings.googleOAuthClientId).trim(),
    googleAccountEmail: partial.googleAccountEmail ?? settings.googleAccountEmail,
    googleAccessToken: partial.googleAccessToken ?? settings.googleAccessToken,
    googleRefreshToken: partial.googleRefreshToken ?? settings.googleRefreshToken,
    googleAccessTokenExpiresAt: partial.googleAccessTokenExpiresAt ?? settings.googleAccessTokenExpiresAt,
    googleGrantedScopes: partial.googleGrantedScopes ?? settings.googleGrantedScopes,
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
    const googlePatch = buildGooglePatch(partial,);
    const persisted = await loadSettings();
    const nextSettings = { ...persisted, ...googlePatch, };
    await saveSettings(nextSettings,);
    settingsRef.current = nextSettings;
    lastSavedSettingsRef.current = nextSettings;
    setSettings(nextSettings,);
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

  const getAiKey = (provider: AiProvider,) => {
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
  };

  const handleConnectGoogle = async () => {
    setGoogleBusy(true,);
    setGoogleError("",);
    try {
      const googlePatch = await connectGoogleAccount(settings,);
      await persistGooglePatch(googlePatch,);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect Google account.";
      setGoogleError(message,);
    } finally {
      setGoogleBusy(false,);
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

  const handleKeyDown = (e: React.KeyboardEvent,) => {
    if (e.key === "Escape") {
      void handleRequestClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      onClick={() => void handleRequestClose()}
      onKeyDown={handleKeyDown}
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
        className="absolute top-0 left-0 right-0 h-[38px] z-[1]"
        data-tauri-drag-region
        onClick={(e,) => e.stopPropagation()}
      />
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />

      {/* Modal */}
      <div
        ref={modalRef}
        className="modal-scroll relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 max-h-[80vh] overflow-y-auto overflow-x-hidden"
        onClick={(e,) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-medium text-gray-900" style={mono}>
            Settings
          </h2>
          <button
            onClick={() => void handleRequestClose()}
            className="text-gray-400 hover:text-gray-600 transition-colors text-lg cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <label className="block text-sm text-gray-600" style={mono}>
            AI Provider
          </label>
          <p className="text-xs text-gray-400" style={mono}>
            Click a card to select the active provider. Keys stay on this device.
          </p>
          <div className="space-y-3">
            {AI_PROVIDERS.map((provider,) => {
              const selected = settings.aiProvider === provider;
              return (
                <div
                  key={provider}
                  onClick={() => update({ aiProvider: provider, },)}
                  className={`rounded-lg border p-3 transition-colors cursor-pointer ${
                    selected
                      ? "border-violet-300 bg-violet-50/50 ring-1 ring-violet-300"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <label className="mb-2 flex items-center gap-2 text-sm cursor-pointer" style={mono}>
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-md border bg-white ${
                        selected ? "border-violet-200" : "border-gray-200"
                      }`}
                    >
                      <img
                        src={AI_PROVIDER_ICONS[provider]}
                        alt=""
                        className="h-4 w-4 object-contain"
                        aria-hidden="true"
                      />
                    </span>
                    <span className={selected ? "text-violet-700" : "text-gray-600"}>
                      {getAiProviderLabel(provider,)}
                    </span>
                  </label>
                  <input
                    ref={selected ? inputRef : undefined}
                    type="password"
                    value={getAiKey(provider,)}
                    onChange={(e,) => updateAiKey(provider, e.target.value,)}
                    onClick={(e,) => e.stopPropagation()}
                    onFocus={() => update({ aiProvider: provider, },)}
                    placeholder={AI_PROVIDER_PLACEHOLDERS[provider]}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all bg-white"
                    style={mono}
                  />
                </div>
              );
            },)}
          </div>
        </div>

        {/* Divider */}
        <div className="my-5 border-t border-gray-100" />

        <div className="space-y-3">
          <label className="block text-sm text-gray-600" style={mono}>
            Google Account
          </label>
          {googleError && (
            <p className="text-xs text-red-600" style={mono}>
              {googleError}
            </p>
          )}
          <div className="flex justify-start">
            <button
              onClick={handleConnectGoogle}
              disabled={googleBusy}
              className="inline-flex min-h-10 items-center gap-3 rounded-full border px-3 pr-4 text-[14px] leading-5 font-medium text-[#1f1f1f] transition-colors cursor-pointer hover:bg-[#e8eaed] focus:outline-none focus:ring-2 focus:ring-[#1a73e8]/20 disabled:cursor-default disabled:opacity-60"
              style={{
                ...googleButtonText,
                backgroundColor: "#f2f2f2",
                borderColor: "#d2d2d2",
              }}
            >
              <GoogleMark />
              <span>{googleBusy ? "Waiting for Google..." : "Continue with Google"}</span>
            </button>
          </div>
        </div>

        <div className="my-5 border-t border-gray-100" />

        {/* Vault Settings */}
        <div className="space-y-3">
          <label className="block text-sm text-gray-600" style={mono}>
            Vault Location
          </label>
          <div className="flex items-center gap-2">
            <div
              className="flex-1 min-w-0 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-500 bg-gray-50"
              style={mono}
              title={settings.vaultDir || settings.journalDir || defaultJournalDir}
            >
              <VaultPathMarquee
                path={settings.vaultDir || settings.journalDir || defaultJournalDir || "..."}
              />
            </div>
            <button
              onClick={handleChooseVault}
              className="shrink-0 px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors cursor-pointer text-gray-700"
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
          <label className="block text-sm text-gray-600 pt-2" style={mono}>
            Daily logs folder
          </label>
          <input
            type="text"
            value={settings.dailyLogsFolder}
            onChange={(e,) => update({ dailyLogsFolder: e.target.value, },)}
            placeholder="Daily Notes"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all"
            style={mono}
          />
          <label className="block text-sm text-gray-600 pt-2" style={mono}>
            Excalidraw folder (optional)
          </label>
          <input
            type="text"
            value={settings.excalidrawFolder}
            onChange={(e,) => update({ excalidrawFolder: e.target.value, },)}
            placeholder="Excalidraw"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all"
            style={mono}
          />
          <label className="block text-sm text-gray-600 pt-2" style={mono}>
            Assets folder (optional)
          </label>
          <input
            type="text"
            value={settings.assetsFolder}
            onChange={(e,) => update({ assetsFolder: e.target.value, },)}
            placeholder="assets"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all"
            style={mono}
          />
          <p className="text-xs text-gray-400" style={mono}>
            Philo uses these to resolve notes, `![[*.excalidraw]]` embeds, and pasted image paths inside your vault.
          </p>
        </div>

        {/* Divider */}
        <div className="my-5 border-t border-gray-100" />

        {/* Filename Pattern */}
        <div ref={filenamePatternSectionRef} className="space-y-3">
          <label className="block text-sm text-gray-600" style={mono}>
            Filename Pattern
          </label>
          <div className="relative">
            <div className="pointer-events-none absolute inset-0 flex items-center overflow-hidden px-3 py-2">
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
              placeholder={DEFAULT_FILENAME_PATTERN}
              className={`w-full px-3 py-2 border rounded-lg text-sm text-transparent caret-gray-900 placeholder:text-transparent focus:outline-none focus:ring-2 transition-all ${
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
            <FilenameTokenChip token="YYYY" />
            <FilenameTokenChip token="MM" />
            <FilenameTokenChip token="DD" />
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
  );
}
