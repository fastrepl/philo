import { generateObject, } from "ai";
import { z, } from "zod";
import type { MeetingSessionKind, } from "../types/note";
import { getAiSdkModel, } from "./ai-sdk";
import { loadSettings, resolveActiveAiConfig, } from "./settings";

const MeetingSummarySchema = z.object({
  sessionKind: z.enum(["decision_making", "informative",],),
  executiveSummary: z.string().trim().min(1,),
  participants: z.array(z.string().trim().min(1,),).max(16,),
  location: z.string().trim().nullable(),
  agenda: z.array(z.string().trim().min(1,),).max(12,),
  actionItems: z.array(z.string().trim().min(1,),).max(16,),
  summary: z.array(z.string().trim().min(1,),).max(8,),
  decisions: z.array(z.string().trim().min(1,),).max(12,),
  keyTakeaways: z.array(z.string().trim().min(1,),).max(12,),
},);

export interface MeetingSummaryInput {
  title: string;
  transcript: string;
  startedAt: string | null;
  endedAt: string | null;
  attachedTo: string | null;
  locationHint?: string | null;
  participantsHint?: string[];
  notesContext?: string | null;
}

export interface MeetingSummaryResult {
  sessionKind: MeetingSessionKind;
  executiveSummary: string;
  participants: string[];
  location: string | null;
  agenda: string[];
  actionItems: string[];
  summary: string[];
  decisions: string[];
  keyTakeaways: string[];
}

const SYSTEM_PROMPT = `You turn transcripts into structured meeting notes for Philo.

Classify the session as:
- decision_making: collaborative meetings where people discussed options, aligned, made decisions, or assigned next steps.
- informative: lectures, demos, videos, podcasts, conference talks, interviews, or informational sessions without concrete decisions.

Rules:
- Use only information grounded in the transcript or provided context.
- Do not guess names, companies, or locations.
- If a field is uncertain, leave it empty.
- executiveSummary must be a crisp 1-3 sentence summary.
- summary should cover who, what, when, where, why, and how when the transcript supports them.
- agenda should list the topics that structured a decision-making session. Leave it empty for informative sessions.
- actionItems should contain clear owner/task follow-ups only when they are explicit or strongly implied. Leave it empty for informative sessions.
- decisions should only contain actual conclusions, not discussion topics.
- keyTakeaways should capture the main learnings for informative sessions.
- Keep the output compact and concrete.`;

function cleanItems(items: string[],): string[] {
  return items.map((item,) => item.trim()).filter(Boolean,);
}

function cleanLocation(value: string | null,) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export async function summarizeMeeting(input: MeetingSummaryInput,): Promise<MeetingSummaryResult> {
  const settings = await loadSettings();
  const config = resolveActiveAiConfig(settings,);
  if (!config) {
    throw new Error("AI is not configured.",);
  }

  if (!input.transcript.trim()) {
    throw new Error("Cannot summarize an empty meeting transcript.",);
  }

  const result = await generateObject({
    model: getAiSdkModel(config, "assistant",),
    schema: MeetingSummarySchema,
    system: SYSTEM_PROMPT,
    prompt: JSON.stringify(
      {
        meeting: {
          title: input.title,
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          attachedTo: input.attachedTo,
          locationHint: input.locationHint ?? null,
          participantsHint: input.participantsHint ?? [],
          notesContext: input.notesContext?.trim() || null,
        },
        transcript: input.transcript,
      },
      null,
      2,
    ),
  },);

  const object = result.object;
  const sessionKind = object.sessionKind;

  return {
    sessionKind,
    executiveSummary: object.executiveSummary.trim(),
    participants: cleanItems(object.participants,),
    location: cleanLocation(object.location,),
    agenda: sessionKind === "decision_making" ? cleanItems(object.agenda,) : [],
    actionItems: sessionKind === "decision_making" ? cleanItems(object.actionItems,) : [],
    summary: cleanItems(object.summary,),
    decisions: sessionKind === "decision_making" ? cleanItems(object.decisions,) : [],
    keyTakeaways: sessionKind === "informative" ? cleanItems(object.keyTakeaways,) : [],
  };
}
