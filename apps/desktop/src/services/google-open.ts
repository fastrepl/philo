import { invoke, } from "@tauri-apps/api/core";
import { openUrl, } from "@tauri-apps/plugin-opener";
import { getMentionChipExternalPayload, type MentionChipData, } from "./mentions";
import { loadSettings, } from "./settings";

async function tryOpenInAppleMail(messageId: string,) {
  return await invoke<boolean>("open_in_apple_mail", {
    messageId,
  },);
}

async function tryOpenInAppleCalendar(eventUid: string,) {
  return await invoke<boolean>("open_in_apple_calendar", {
    eventUid,
  },);
}

export async function openGoogleMentionChip(
  data: Pick<MentionChipData, "id" | "kind">,
) {
  const payload = getMentionChipExternalPayload(data,);
  if (!payload) {
    return false;
  }

  const settings = await loadSettings();

  if (payload.kind === "gmail") {
    if (settings.googleEmailOpenClient === "apple_mail" && payload.messageId) {
      try {
        if (await tryOpenInAppleMail(payload.messageId,)) {
          return true;
        }
      } catch (error) {
        console.error(error,);
      }
    }

    await openUrl(payload.href,);
    return true;
  }

  if (settings.googleCalendarOpenClient === "apple_calendar" && payload.calendarUid) {
    try {
      if (await tryOpenInAppleCalendar(payload.calendarUid,)) {
        return true;
      }
    } catch (error) {
      console.error(error,);
    }
  }

  await openUrl(payload.href,);
  return true;
}
