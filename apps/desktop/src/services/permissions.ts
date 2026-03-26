import { invoke, } from "@tauri-apps/api/core";

export function ensureMicrophonePermission() {
  return invoke<void>("ensure_microphone_permission",);
}
