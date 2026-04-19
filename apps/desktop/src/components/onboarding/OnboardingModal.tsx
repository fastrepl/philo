import { invoke, } from "@tauri-apps/api/core";
import { join, } from "@tauri-apps/api/path";
import { open as openDialog, } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState, } from "react";
import { trackEvent, } from "../../services/analytics";
import { detectObsidianFolders, ensureObsidianVaultStructure, } from "../../services/obsidian";
import { getJournalDir, initJournalScope, resetJournalDir, } from "../../services/paths";
import { loadSettings, saveSettings, type Settings, } from "../../services/settings";
import { VaultPathMarquee, } from "../shared/VaultPathMarquee";

interface OnboardingModalProps {
  open: boolean;
  onComplete: () => void;
}

const mono = { fontFamily: "'IBM Plex Mono', monospace", };

export function OnboardingModal({ open, onComplete, }: OnboardingModalProps,) {
  const [settings, setSettings,] = useState<Settings | null>(null,);
  const [vaultDir, setVaultDir,] = useState("",);
  const [dailyLogsFolder, setDailyLogsFolder,] = useState("Daily Notes",);
  const [excalidrawFolder, setExcalidrawFolder,] = useState("Excalidraw",);
  const [assetsFolder, setAssetsFolder,] = useState("assets",);
  const [vaultCandidates, setVaultCandidates,] = useState<string[]>([],);
  const [detectingFolders, setDetectingFolders,] = useState(false,);
  const [detectedFilenamePattern, setDetectedFilenamePattern,] = useState("",);
  const [saving, setSaving,] = useState(false,);
  const [error, setError,] = useState("",);
  const modalScrollRef = useRef<HTMLDivElement>(null,);

  useEffect(() => {
    if (!open) return;

    loadSettings().then(async (current,) => {
      setSettings(current,);
      const originalVaultDir = current.vaultDir || current.journalDir || await getJournalDir();
      setVaultDir(originalVaultDir || "",);
      setDailyLogsFolder(current.dailyLogsFolder || "Daily Notes",);
      setExcalidrawFolder(current.excalidrawFolder || "Excalidraw",);
      setAssetsFolder(current.assetsFolder || "assets",);
    },).catch(console.error,);

    invoke<string[]>("find_obsidian_vaults",)
      .then((vaults,) => setVaultCandidates(vaults,))
      .catch(() => setVaultCandidates([],));
  }, [open,],);

  const canSubmit = useMemo(() => {
    return !!vaultDir.trim() && !!dailyLogsFolder.trim() && !saving && !detectingFolders;
  }, [dailyLogsFolder, detectingFolders, saving, vaultDir,],);
  const detectedVaults = useMemo(() => new Set(vaultCandidates,), [vaultCandidates,],);

  if (!open || !settings) return null;

  const handleDetectFolders = async (
    selectedVaultDir: string,
    overwriteWithDefaults: boolean = false,
  ) => {
    const normalizedVaultDir = selectedVaultDir.trim();
    if (!normalizedVaultDir) return null;

    setDetectingFolders(true,);
    try {
      const detected = await detectObsidianFolders(normalizedVaultDir,);
      if (overwriteWithDefaults) {
        setDailyLogsFolder(detected.dailyLogsFolder || "Daily Notes",);
        setExcalidrawFolder(detected.excalidrawFolder || "Excalidraw",);
        setAssetsFolder(detected.assetsFolder || "assets",);
      } else {
        setDailyLogsFolder((current,) => detected.dailyLogsFolder || current || "Daily Notes");
        setExcalidrawFolder((current,) => detected.excalidrawFolder || current || "Excalidraw");
        setAssetsFolder((current,) => detected.assetsFolder || current || "assets");
      }
      setDetectedFilenamePattern(detected.filenamePattern || "",);
      return detected;
    } finally {
      setDetectingFolders(false,);
    }
  };

  const handleSelectVault = async (selectedVaultDir: string, fromDetectedChip: boolean = false,) => {
    setVaultDir(selectedVaultDir,);
    const detected = await handleDetectFolders(selectedVaultDir, fromDetectedChip,);

    if (
      fromDetectedChip
      && detected
      && detected.dailyLogsFolder.trim()
      && detected.excalidrawFolder.trim()
      && detected.assetsFolder.trim()
    ) {
      requestAnimationFrame(() => {
        if (!modalScrollRef.current) return;
        modalScrollRef.current.scrollTop = modalScrollRef.current.scrollHeight;
      },);
    }
  };

  const handleChooseVault = async () => {
    const defaultPath = vaultDir.trim();
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: defaultPath || undefined,
    },);
    if (selected) await handleSelectVault(selected,);
  };

  const handleSubmit = async () => {
    const nextVaultDir = vaultDir.trim();
    const nextDailyLogsFolder = dailyLogsFolder.trim();
    const nextExcalidrawFolder = excalidrawFolder.trim();
    const nextAssetsFolder = assetsFolder.trim();

    if (!nextVaultDir) {
      setError("Vault location is required.",);
      return;
    }
    if (!nextDailyLogsFolder) {
      setError("Daily logs folder is required.",);
      return;
    }

    setSaving(true,);
    setError("",);
    try {
      await ensureObsidianVaultStructure(nextVaultDir, {
        dailyLogsFolder: nextDailyLogsFolder,
        excalidrawFolder: nextExcalidrawFolder,
        assetsFolder: nextAssetsFolder,
      },);
      const journalDir = await join(nextVaultDir, nextDailyLogsFolder,);
      const nextSettings: Settings = {
        ...settings,
        journalDir,
        vaultDir: nextVaultDir,
        filenamePattern: detectedFilenamePattern || settings.filenamePattern,
        dailyLogsFolder: nextDailyLogsFolder,
        excalidrawFolder: nextExcalidrawFolder,
        assetsFolder: nextAssetsFolder,
        hasCompletedOnboarding: true,
      };
      await saveSettings(nextSettings,);
      await resetJournalDir(journalDir,);
      await initJournalScope();
      trackEvent("onboarding_completed", {
        assets_folder_customized: nextAssetsFolder !== "assets",
        daily_logs_folder_customized: nextDailyLogsFolder !== "Daily Notes",
        detected_filename_pattern: Boolean(detectedFilenamePattern,),
        detected_vault_selected: detectedVaults.has(nextVaultDir,),
        excalidraw_folder_customized: nextExcalidrawFolder !== "Excalidraw",
        vault_candidates_count: vaultCandidates.length,
      },);
      onComplete();
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : typeof err === "string"
        ? err
        : "Failed to save onboarding settings.";
      setError(message || "Failed to save onboarding settings.",);
    } finally {
      setSaving(false,);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center">
      <div
        className="absolute top-0 left-0 right-0 h-[38px] z-[1]"
        data-tauri-drag-region
      />
      <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" />
      <div
        ref={modalScrollRef}
        className="modal-scroll relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto overflow-x-hidden"
      >
        <h2 className="text-lg font-medium text-gray-900 mb-5" style={mono}>
          Let&apos;s get started.
        </h2>

        <div className="space-y-3">
          <label className="block text-sm text-gray-600" style={mono}>
            Vault Location
          </label>
          <div className="flex items-center gap-2">
            <div
              className="flex-1 min-w-0 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-500 bg-gray-50"
              style={mono}
              title={vaultDir || "..."}
            >
              <VaultPathMarquee
                path={vaultDir || "..."}
                icon={vaultDir && detectedVaults.has(vaultDir,) ? "obsidian" : "folder"}
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
          <p className="text-xs text-gray-400" style={mono}>
            want to use it with your existing obsidian vault?
          </p>

          {vaultCandidates.length > 0 && (
            <div className="space-y-1.5 pt-1">
              {vaultCandidates.map((candidate,) => (
                <button
                  key={candidate}
                  onClick={() => {
                    void handleSelectVault(candidate, true,);
                  }}
                  className={`w-full px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-left ${
                    candidate === vaultDir
                      ? "border-violet-400 bg-violet-50 text-violet-700"
                      : "border-gray-200 text-gray-500 hover:border-gray-300"
                  }`}
                  style={mono}
                >
                  <VaultPathMarquee path={candidate} icon="obsidian" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="my-5 border-t border-gray-100" />

        <div className="space-y-3">
          <label className="block text-sm text-gray-600" style={mono}>
            Daily logs folder (required)
          </label>
          <input
            value={dailyLogsFolder}
            onChange={(e,) => setDailyLogsFolder(e.target.value,)}
            placeholder="Daily Notes"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all"
            style={mono}
          />
        </div>

        <div className="my-5 border-t border-gray-100" />

        <div className="space-y-3">
          <label className="block text-sm text-gray-600" style={mono}>
            Excalidraw folder (optional)
          </label>
          <input
            value={excalidrawFolder}
            onChange={(e,) => setExcalidrawFolder(e.target.value,)}
            placeholder="Excalidraw"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all"
            style={mono}
          />
        </div>

        <div className="my-5 border-t border-gray-100" />

        <div className="space-y-3">
          <label className="block text-sm text-gray-600" style={mono}>
            Assets folder (optional)
          </label>
          <input
            value={assetsFolder}
            onChange={(e,) => setAssetsFolder(e.target.value,)}
            placeholder="assets"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all"
            style={mono}
          />
        </div>

        {error && (
          <p className="mt-4 text-xs text-red-600" style={mono}>
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-start">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-6 py-2 text-sm text-white rounded-lg transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              ...mono,
              background: "linear-gradient(to bottom, #7c3aed, #5b21b6)",
            }}
          >
            {saving ? "Saving..." : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
