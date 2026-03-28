import { openUrl, } from "@tauri-apps/plugin-opener";
import { useState, } from "react";
import { markPendingPostUpdate, type PostUpdateInfo, relaunch, type UpdateInfo, } from "../services/updater";

interface UpdateBannerProps {
  update: UpdateInfo | PostUpdateInfo;
  onDismiss: () => void;
  mode?: "available" | "updated";
}

export function UpdateBanner({
  update,
  onDismiss,
  mode = "available",
}: UpdateBannerProps,) {
  const [updating, setUpdating,] = useState(false,);
  const [progress, setProgress,] = useState<number | null>(null,);
  const [installed, setInstalled,] = useState(false,);
  const [restarting, setRestarting,] = useState(false,);
  const isUpdatedMode = mode === "updated";

  const handleUpdate = async () => {
    if (isUpdatedMode) return;
    const availableUpdate = update as UpdateInfo;
    setUpdating(true,);
    try {
      await availableUpdate.downloadAndInstall((downloaded, total,) => {
        if (total > 0) setProgress(Math.round((downloaded / total) * 100,),);
      },);
      markPendingPostUpdate(availableUpdate.version,);
      setInstalled(true,);
    } catch (err) {
      console.error("Update failed:", err,);
      setUpdating(false,);
      setProgress(null,);
    }
  };

  const handleRestart = async () => {
    if (restarting) return;
    setRestarting(true,);
    try {
      await relaunch();
    } catch (err) {
      console.error("Restart failed:", err,);
      setRestarting(false,);
    }
  };

  if (isUpdatedMode) {
    const postUpdate = update as PostUpdateInfo;
    return (
      <div
        className="sticky top-0 z-50 flex items-center justify-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/80"
        style={{ fontFamily: "'IBM Plex Mono', monospace", }}
      >
        <span className="text-xs text-gray-600 dark:text-gray-300">
          v{postUpdate.version} updated
        </span>

        <button
          onClick={() => openUrl(postUpdate.releaseUrl,)}
          className="text-xs px-2.5 py-0.5 rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
        >
          Changelog
        </button>

        <button
          onClick={onDismiss}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors cursor-pointer ml-1"
        >
          ✕
        </button>
      </div>
    );
  }

  if (installed) {
    return (
      <div
        className="sticky top-0 z-50 flex items-center justify-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/80"
        style={{ fontFamily: "'IBM Plex Mono', monospace", }}
      >
        <span className="text-xs text-gray-600 dark:text-gray-300">
          Restart to finish updating to v{update.version}
        </span>

        <button
          onClick={handleRestart}
          disabled={restarting}
          className="text-xs px-2.5 py-0.5 rounded-md text-white transition-all cursor-pointer disabled:opacity-60 disabled:cursor-default"
          style={{ background: "linear-gradient(to bottom, #4b5563, #1f2937)", }}
        >
          {restarting ? "Restarting\u2026" : "Restart"}
        </button>
      </div>
    );
  }

  return (
    <div
      className="sticky top-0 z-50 flex items-center justify-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/80"
      style={{ fontFamily: "'IBM Plex Mono', monospace", }}
    >
      <span className="text-xs text-gray-600 dark:text-gray-300">
        v{update.version} available
      </span>

      <button
        onClick={handleUpdate}
        disabled={updating}
        className="text-xs px-2.5 py-0.5 rounded-md text-white transition-all cursor-pointer disabled:opacity-60 disabled:cursor-default"
        style={{
          background: updating
            ? "linear-gradient(to bottom, #9ca3af, #6b7280)"
            : "linear-gradient(to bottom, #4b5563, #1f2937)",
        }}
      >
        {updating
          ? progress !== null
            ? `Downloading\u2026 ${progress}%`
            : "Preparing\u2026"
          : "Update & Restart"}
      </button>

      {!updating && (
        <button
          onClick={onDismiss}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors cursor-pointer ml-1"
        >
          ✕
        </button>
      )}
    </div>
  );
}
