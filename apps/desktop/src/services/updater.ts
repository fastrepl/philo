import { getVersion, } from "@tauri-apps/api/app";
import { relaunch as tauriRelaunch, } from "@tauri-apps/plugin-process";
import { check, } from "@tauri-apps/plugin-updater";

const RELEASE_URL_PREFIX = "https://github.com/ComputelessComputer/philo/releases/tag";
const PENDING_UPDATED_VERSION_KEY = "philo.pending-updated-version";

export interface UpdateInfo {
  version: string;
  body: string | null;
  releaseUrl: string;
  downloadAndInstall: (onProgress?: (downloaded: number, total: number,) => void,) => Promise<void>;
}

export interface PostUpdateInfo {
  version: string;
  releaseUrl: string;
}

function getReleaseUrl(version: string,) {
  return `${RELEASE_URL_PREFIX}/v${version}`;
}

export async function relaunch(): Promise<void> {
  await tauriRelaunch();
}

export function markPendingPostUpdate(version: string,) {
  localStorage.setItem(PENDING_UPDATED_VERSION_KEY, version,);
}

export async function consumePendingPostUpdate(): Promise<PostUpdateInfo | null> {
  const pendingVersion = localStorage.getItem(PENDING_UPDATED_VERSION_KEY,);
  if (!pendingVersion) return null;

  const currentVersion = await getVersion();
  if (pendingVersion !== currentVersion) return null;

  localStorage.removeItem(PENDING_UPDATED_VERSION_KEY,);
  return {
    version: pendingVersion,
    releaseUrl: getReleaseUrl(pendingVersion,),
  };
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    if (!update) return null;

    return {
      version: update.version,
      body: update.body ?? null,
      releaseUrl: getReleaseUrl(update.version,),
      downloadAndInstall: async (onProgress,) => {
        let downloaded = 0;
        let contentLength = 0;

        await update.downloadAndInstall((event,) => {
          switch (event.event) {
            case "Started":
              contentLength = event.data.contentLength ?? 0;
              break;
            case "Progress":
              downloaded += event.data.chunkLength;
              onProgress?.(downloaded, contentLength,);
              break;
          }
        },);
      },
    };
  } catch (err) {
    console.error("Update check failed:", err,);
    return null;
  }
}
