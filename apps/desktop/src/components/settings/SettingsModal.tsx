import { join, } from "@tauri-apps/api/path";
import { open as openDialog, } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, } from "react";
import {
  connectGoogleAccount,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_GMAIL_SCOPE,
  hasGoogleAccess,
  isGoogleAccountConnected,
} from "../../services/google";
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

const FILENAME_PRESETS = [
  { label: "Flat", value: "{YYYY}-{MM}-{DD}", },
  { label: "By year", value: "{YYYY}/{YYYY}-{MM}-{DD}", },
  { label: "By year + month", value: "{YYYY}/{MM}/{YYYY}-{MM}-{DD}", },
];

const AI_PROVIDER_PLACEHOLDERS: Record<AiProvider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  google: "AIza...",
  openrouter: "sk-or-v1-...",
};

const mono = { fontFamily: "'IBM Plex Mono', monospace", };

export function SettingsModal({ open, onClose, }: SettingsModalProps,) {
  const [settings, setSettings,] = useState<Settings | null>(null,);
  const [saveState, setSaveState,] = useState<"idle" | "saving" | "error">("idle",);
  const [defaultJournalDir, setDefaultJournalDir,] = useState("",);
  const [googleBusy, setGoogleBusy,] = useState(false,);
  const [googleError, setGoogleError,] = useState("",);
  const inputRef = useRef<HTMLInputElement>(null,);
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

  const handleDisconnectGoogle = async () => {
    setGoogleBusy(true,);
    setGoogleError("",);
    try {
      await persistGooglePatch({
        googleAccountEmail: "",
        googleAccessToken: "",
        googleRefreshToken: "",
        googleAccessTokenExpiresAt: "",
        googleGrantedScopes: [],
      },);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to disconnect Google account.";
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

  const handleRequestClose = async () => {
    const nextSettings = settingsRef.current;
    if (!nextSettings) {
      onClose();
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

  const googleConnected = isGoogleAccountConnected(settings,);
  const hasCalendarAccess = hasGoogleAccess(settings, GOOGLE_CALENDAR_SCOPE,);
  const hasGmailAccess = hasGoogleAccess(settings, GOOGLE_GMAIL_SCOPE,);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      onClick={() => void handleRequestClose()}
      onKeyDown={handleKeyDown}
    >
      <div
        className="absolute top-0 left-0 right-0 h-[38px] z-[1]"
        data-tauri-drag-region
        onClick={(e,) => e.stopPropagation()}
      />
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />

      {/* Modal */}
      <div
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
                      className={`inline-block h-2 w-2 rounded-full ${selected ? "bg-violet-500" : "bg-gray-300"}`}
                    />
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
          <p className="text-xs text-gray-400" style={mono}>
            Connect a Google account to fetch read-only data from Google Calendar and Gmail.
          </p>
          <input
            type="text"
            value={settings.googleOAuthClientId}
            onChange={(e,) => update({ googleOAuthClientId: e.target.value, },)}
            placeholder="1234567890-abcdefg.apps.googleusercontent.com"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all"
            style={mono}
          />
          <p className="text-xs text-gray-400" style={mono}>
            Use a Google OAuth Desktop client ID. Philo stores the resulting Calendar and Gmail tokens on this device.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <span
              className={`px-2 py-1 text-xs rounded-md border ${
                hasCalendarAccess
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : "border-gray-200 text-gray-500"
              }`}
              style={mono}
            >
              Calendar {hasCalendarAccess ? "connected" : "read only"}
            </span>
            <span
              className={`px-2 py-1 text-xs rounded-md border ${
                hasGmailAccess
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : "border-gray-200 text-gray-500"
              }`}
              style={mono}
            >
              Gmail {hasGmailAccess ? "connected" : "read only"}
            </span>
          </div>
          <div
            className={`rounded-lg border px-3 py-3 ${
              googleConnected
                ? "border-emerald-200 bg-emerald-50/70"
                : "border-gray-200 bg-gray-50"
            }`}
          >
            <p
              className={`text-sm ${googleConnected ? "text-emerald-800" : "text-gray-600"}`}
              style={mono}
            >
              {googleConnected
                ? `Connected as ${settings.googleAccountEmail}`
                : "No Google account connected."}
            </p>
            {settings.googleAccessTokenExpiresAt && googleConnected && (
              <p className="mt-1 text-xs text-emerald-700/80" style={mono}>
                Access token expires at {new Date(settings.googleAccessTokenExpiresAt,).toLocaleString()}
              </p>
            )}
          </div>
          {googleError && (
            <p className="text-xs text-red-600" style={mono}>
              {googleError}
            </p>
          )}
          <div className="flex justify-end gap-3">
            {googleConnected && (
              <button
                onClick={handleDisconnectGoogle}
                disabled={googleBusy}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
                style={mono}
              >
                Disconnect
              </button>
            )}
            <button
              onClick={handleConnectGoogle}
              disabled={googleBusy || !settings.googleOAuthClientId.trim()}
              className="px-4 py-2 text-sm text-white rounded-lg transition-all cursor-pointer disabled:opacity-60 disabled:cursor-default"
              style={{
                ...mono,
                background: "linear-gradient(to bottom, #1d4ed8, #1e3a8a)",
              }}
            >
              {googleBusy
                ? "Waiting for Google…"
                : googleConnected
                ? "Reconnect Google"
                : "Connect Google"}
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
          <p className="text-xs text-amber-600" style={mono}>
            Changing this will not move existing files.
          </p>
        </div>

        {/* Divider */}
        <div className="my-5 border-t border-gray-100" />

        {/* Filename Pattern */}
        <div className="space-y-3">
          <label className="block text-sm text-gray-600" style={mono}>
            Filename Pattern
          </label>
          <input
            type="text"
            value={settings.filenamePattern}
            onChange={(e,) => update({ filenamePattern: e.target.value, },)}
            placeholder={DEFAULT_FILENAME_PATTERN}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all"
            style={mono}
          />
          <div className="flex flex-wrap gap-1.5">
            {FILENAME_PRESETS.map((preset,) => (
              <button
                key={preset.value}
                onClick={() => update({ filenamePattern: preset.value, },)}
                className={`px-2 py-1 text-xs rounded-md border transition-colors cursor-pointer ${
                  effectivePattern === preset.value
                    ? "border-violet-400 bg-violet-50 text-violet-700"
                    : "border-gray-200 text-gray-500 hover:border-gray-300"
                }`}
                style={mono}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400" style={mono}>
            Preview: <span className="text-gray-600">{filenamePreview}</span>
          </p>
          <p className="text-xs text-gray-400" style={mono}>
            Tokens: {"{"}
            <span className="text-gray-600">YYYY</span>
            {"}"}, {"{"}
            <span className="text-gray-600">MM</span>
            {"}"}, {"{"}
            <span className="text-gray-600">DD</span>
            {"}"}. Use <span className="text-gray-600">/</span> for subdirectories.
          </p>
          <p className="text-xs text-amber-600" style={mono}>
            Changing this will not rename existing files.
          </p>
        </div>

        <p
          className={`mt-6 text-xs ${
            saveState === "error"
              ? "text-red-600"
              : "text-gray-400"
          }`}
          style={mono}
        >
          {saveState === "saving"
            ? "Saving changes..."
            : saveState === "error"
            ? "Could not save changes."
            : "Changes save when you close settings."}
        </p>
      </div>
    </div>
  );
}
