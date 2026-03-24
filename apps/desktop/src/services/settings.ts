import { join, } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile, } from "@tauri-apps/plugin-fs";
import { getBaseDir, } from "./paths";

export interface Settings {
  aiProvider: AiProvider;
  aiModel: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  googleApiKey: string;
  openrouterApiKey: string;
  currentSttProvider: SttProvider;
  currentSttModel: string;
  sttBaseUrl: string;
  sttApiKey: string;
  spokenLanguages: string[];
  saveRecordings: boolean;
  googleEmailOpenClient: GoogleEmailOpenClient;
  googleCalendarOpenClient: GoogleCalendarOpenClient;
  googleOAuthClientId: string;
  googleAccounts: GoogleAccount[];
  googleAccountEmail: string;
  googleAccessToken: string;
  googleRefreshToken: string;
  googleAccessTokenExpiresAt: string;
  googleGrantedScopes: string[];
  journalDir: string;
  filenamePattern: string;
  vaultDir: string;
  dailyLogsFolder: string;
  excalidrawFolder: string;
  assetsFolder: string;
  widgetGitHistoryEnabled: boolean;
  hasCompletedOnboarding: boolean;
}

const SETTINGS_FILE = "settings.json";
export const SETTINGS_UPDATED_EVENT = "philo:settings-updated";

export const AI_PROVIDERS = ["anthropic", "openai", "google", "openrouter",] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const DEFAULT_AI_PROVIDER: AiProvider = "anthropic";
export const STT_PROVIDERS = [
  "deepgram",
  "assemblyai",
  "openai",
  "gladia",
  "soniox",
  "elevenlabs",
  "mistral",
  "custom",
] as const;
export type SttProvider = (typeof STT_PROVIDERS)[number];
export const DEFAULT_STT_PROVIDER: SttProvider = "openai";
export const GOOGLE_EMAIL_OPEN_CLIENTS = ["gmail", "apple_mail",] as const;
export type GoogleEmailOpenClient = (typeof GOOGLE_EMAIL_OPEN_CLIENTS)[number];
export const DEFAULT_GOOGLE_EMAIL_OPEN_CLIENT: GoogleEmailOpenClient = "gmail";
export const GOOGLE_CALENDAR_OPEN_CLIENTS = ["google_calendar", "apple_calendar",] as const;
export type GoogleCalendarOpenClient = (typeof GOOGLE_CALENDAR_OPEN_CLIENTS)[number];
export const DEFAULT_GOOGLE_CALENDAR_OPEN_CLIENT: GoogleCalendarOpenClient = "google_calendar";
const DEFAULT_SPOKEN_LANGUAGES = ["en",] as string[];

const AI_PROVIDER_DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-5.4",
  google: "gemini-2.5-pro",
  openrouter: "openrouter/auto",
};

const AI_PROVIDER_SUGGESTED_MODELS: Record<AiProvider, string[]> = {
  anthropic: [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
  openai: [
    "gpt-5.4",
    "gpt-5.2",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4.1",
  ],
  google: [
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
  openrouter: [
    "openrouter/auto",
    "anthropic/claude-opus-4.6",
    "openai/gpt-5.2",
    "google/gemini-3.1-pro-preview",
    "anthropic/claude-sonnet-4.6",
  ],
};

const STT_PROVIDER_LABELS: Record<SttProvider, string> = {
  deepgram: "Deepgram",
  assemblyai: "AssemblyAI",
  openai: "OpenAI",
  gladia: "Gladia",
  soniox: "Soniox",
  elevenlabs: "ElevenLabs",
  mistral: "Mistral",
  custom: "Custom",
};

const STT_PROVIDER_DEFAULT_BASE_URLS: Record<SttProvider, string> = {
  deepgram: "https://api.deepgram.com/v1",
  assemblyai: "https://api.assemblyai.com",
  openai: "https://api.openai.com/v1",
  gladia: "https://api.gladia.io",
  soniox: "https://api.soniox.com",
  elevenlabs: "https://api.elevenlabs.io",
  mistral: "https://api.mistral.ai/v1",
  custom: "",
};

const STT_PROVIDER_DEFAULT_MODELS: Record<SttProvider, string> = {
  deepgram: "nova-2-meeting",
  assemblyai: "universal",
  openai: "gpt-4o-transcribe",
  gladia: "solaria-1",
  soniox: "stt-v4",
  elevenlabs: "scribe_v2",
  mistral: "voxtral-mini-2602",
  custom: "",
};

const STT_PROVIDER_SUGGESTED_MODELS: Record<SttProvider, string[]> = {
  deepgram: ["nova-2-meeting", "nova-3-general", "nova-2-phonecall",],
  assemblyai: ["universal",],
  openai: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1",],
  gladia: ["solaria-1",],
  soniox: ["stt-v4", "stt-v3",],
  elevenlabs: ["scribe_v2",],
  mistral: ["voxtral-mini-2602",],
  custom: [],
};

export interface ActiveAiConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
}

export interface ActiveSttConfig {
  provider: SttProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  spokenLanguages: string[];
  saveRecordings: boolean;
}

export interface GoogleAccount {
  email: string;
  accessTokenExpiresAt: string;
  grantedScopes: string[];
}

export const DEFAULT_FILENAME_PATTERN = "{YYYY}-{MM}-{DD}";
const BUNDLED_GOOGLE_OAUTH_CLIENT_ID = "426453142223-dnbr4440defc5ms857fhmd715v4fe68n.apps.googleusercontent.com";
export const DEFAULT_GOOGLE_OAUTH_CLIENT_ID = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID?.trim()
  || BUNDLED_GOOGLE_OAUTH_CLIENT_ID;

const DEFAULT_SETTINGS: Settings = {
  aiProvider: DEFAULT_AI_PROVIDER,
  aiModel: "",
  anthropicApiKey: "",
  openaiApiKey: "",
  googleApiKey: "",
  openrouterApiKey: "",
  currentSttProvider: DEFAULT_STT_PROVIDER,
  currentSttModel: STT_PROVIDER_DEFAULT_MODELS[DEFAULT_STT_PROVIDER],
  sttBaseUrl: STT_PROVIDER_DEFAULT_BASE_URLS[DEFAULT_STT_PROVIDER],
  sttApiKey: "",
  spokenLanguages: [...DEFAULT_SPOKEN_LANGUAGES,],
  saveRecordings: true,
  googleEmailOpenClient: DEFAULT_GOOGLE_EMAIL_OPEN_CLIENT,
  googleCalendarOpenClient: DEFAULT_GOOGLE_CALENDAR_OPEN_CLIENT,
  googleOAuthClientId: DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
  googleAccounts: [],
  googleAccountEmail: "",
  googleAccessToken: "",
  googleRefreshToken: "",
  googleAccessTokenExpiresAt: "",
  googleGrantedScopes: [],
  journalDir: "",
  filenamePattern: "",
  vaultDir: "",
  dailyLogsFolder: "",
  excalidrawFolder: "",
  assetsFolder: "",
  widgetGitHistoryEnabled: true,
  hasCompletedOnboarding: false,
};

function normalizeAiProvider(value: unknown,): AiProvider {
  return typeof value === "string" && AI_PROVIDERS.includes(value as AiProvider,)
    ? value as AiProvider
    : DEFAULT_AI_PROVIDER;
}

function normalizeSttProvider(value: unknown,): SttProvider {
  return typeof value === "string" && STT_PROVIDERS.includes(value as SttProvider,)
    ? value as SttProvider
    : DEFAULT_STT_PROVIDER;
}

function normalizeSpokenLanguages(value: unknown,) {
  if (!Array.isArray(value,)) return [...DEFAULT_SPOKEN_LANGUAGES,];
  const normalized = [
    ...new Set(
      value
        .filter((entry,): entry is string => typeof entry === "string")
        .map((entry,) => entry.trim().toLowerCase())
        .filter(Boolean,),
    ),
  ];
  return normalized.length > 0 ? normalized : [...DEFAULT_SPOKEN_LANGUAGES,];
}

function normalizeGoogleEmailOpenClient(value: unknown,): GoogleEmailOpenClient {
  return typeof value === "string" && GOOGLE_EMAIL_OPEN_CLIENTS.includes(value as GoogleEmailOpenClient,)
    ? value as GoogleEmailOpenClient
    : DEFAULT_GOOGLE_EMAIL_OPEN_CLIENT;
}

function normalizeGoogleCalendarOpenClient(value: unknown,): GoogleCalendarOpenClient {
  return typeof value === "string" && GOOGLE_CALENDAR_OPEN_CLIENTS.includes(value as GoogleCalendarOpenClient,)
    ? value as GoogleCalendarOpenClient
    : DEFAULT_GOOGLE_CALENDAR_OPEN_CLIENT;
}

function normalizeGoogleGrantedScopes(value: unknown,) {
  if (!Array.isArray(value,)) return [];
  return value.filter((entry,): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeGoogleAccounts(value: unknown, legacy?: {
  email?: unknown;
  accessTokenExpiresAt?: unknown;
  grantedScopes?: unknown;
},) {
  const normalized = Array.isArray(value,)
    ? value
      .map((entry,) => {
        if (!entry || typeof entry !== "object") return null;
        const email = typeof entry.email === "string" ? entry.email.trim() : "";
        if (!email) return null;
        return {
          email,
          accessTokenExpiresAt: typeof entry.accessTokenExpiresAt === "string"
            ? entry.accessTokenExpiresAt
            : "",
          grantedScopes: normalizeGoogleGrantedScopes(entry.grantedScopes,),
        } satisfies GoogleAccount;
      },)
      .filter((entry,): entry is GoogleAccount => entry !== null)
    : [];

  if (normalized.length > 0) {
    return normalized;
  }

  const legacyEmail = typeof legacy?.email === "string" ? legacy.email.trim() : "";
  if (!legacyEmail) return [];

  return [{
    email: legacyEmail,
    accessTokenExpiresAt: typeof legacy?.accessTokenExpiresAt === "string"
      ? legacy.accessTokenExpiresAt
      : "",
    grantedScopes: normalizeGoogleGrantedScopes(legacy?.grantedScopes,),
  },];
}

function normalizeGoogleOAuthClientId(_value: unknown,) {
  return DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
}

export function getAiProviderLabel(provider: AiProvider,) {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google";
    case "openrouter":
      return "OpenRouter";
  }
}

export function getDefaultAiModel(provider: AiProvider, purpose: "assistant" | "widget",) {
  void purpose;
  return AI_PROVIDER_DEFAULT_MODELS[provider];
}

export function getSuggestedAiModels(provider: AiProvider,) {
  return AI_PROVIDER_SUGGESTED_MODELS[provider];
}

export function getAiModelLabel(model: string,) {
  switch (model) {
    case "claude-opus-4-6":
      return "Claude Opus 4.6";
    case "claude-sonnet-4-6":
      return "Claude Sonnet 4.6";
    case "claude-haiku-4-5":
      return "Claude Haiku 4.5";
    case "gpt-5.4":
      return "GPT-5.4";
    case "gpt-5.2":
      return "GPT-5.2";
    case "gpt-5-mini":
      return "GPT-5 mini";
    case "gpt-5-nano":
      return "GPT-5 nano";
    case "gpt-4.1":
      return "GPT-4.1";
    case "gemini-2.5-pro":
      return "Gemini 2.5 Pro";
    case "gemini-3-flash-preview":
      return "Gemini 3 Flash Preview";
    case "gemini-2.5-flash":
      return "Gemini 2.5 Flash";
    case "gemini-2.5-flash-lite":
      return "Gemini 2.5 Flash-Lite";
    case "openrouter/auto":
      return "OpenRouter Auto";
    case "anthropic/claude-opus-4.6":
      return "Claude Opus 4.6";
    case "openai/gpt-5.2":
      return "GPT-5.2";
    case "google/gemini-3.1-pro-preview":
      return "Gemini 3.1 Pro Preview";
    case "anthropic/claude-sonnet-4.6":
      return "Claude Sonnet 4.6";
    default:
      return model;
  }
}

export function getSttProviderLabel(provider: SttProvider,) {
  return STT_PROVIDER_LABELS[provider];
}

export function getDefaultSttBaseUrl(provider: SttProvider,) {
  return STT_PROVIDER_DEFAULT_BASE_URLS[provider];
}

export function getDefaultSttModel(provider: SttProvider,) {
  return STT_PROVIDER_DEFAULT_MODELS[provider];
}

export function getSuggestedSttModels(provider: SttProvider,) {
  return STT_PROVIDER_SUGGESTED_MODELS[provider];
}

export function getSttModelLabel(model: string,) {
  switch (model) {
    case "nova-2-meeting":
      return "Nova 2 Meeting";
    case "nova-3-general":
      return "Nova 3 General";
    case "nova-2-phonecall":
      return "Nova 2 Phonecall";
    case "universal":
      return "Universal";
    case "gpt-4o-transcribe":
      return "GPT-4o Transcribe";
    case "gpt-4o-mini-transcribe":
      return "GPT-4o mini Transcribe";
    case "whisper-1":
      return "Whisper 1";
    case "solaria-1":
      return "Solaria 1";
    case "stt-v4":
      return "Soniox v4";
    case "stt-v3":
      return "Soniox v3";
    case "scribe_v2":
      return "Scribe V2";
    case "voxtral-mini-2602":
      return "Voxtral Mini 2602";
    default:
      return model;
  }
}

export function getAiProviderApiKey(settings: Settings, provider: AiProvider,) {
  switch (provider) {
    case "anthropic":
      return settings.anthropicApiKey.trim();
    case "openai":
      return settings.openaiApiKey.trim();
    case "google":
      return settings.googleApiKey.trim();
    case "openrouter":
      return settings.openrouterApiKey.trim();
  }
}

export function getSttProviderApiKey(settings: Settings, provider: SttProvider,) {
  const explicit = settings.sttApiKey.trim();
  if (explicit) return explicit;
  if (provider === "openai") {
    return settings.openaiApiKey.trim();
  }
  return "";
}

export function resolveActiveAiConfig(settings: Settings,): ActiveAiConfig | null {
  const provider = normalizeAiProvider(settings.aiProvider,);
  const apiKey = getAiProviderApiKey(settings, provider,);
  const model = typeof settings.aiModel === "string" && settings.aiModel.trim()
    ? settings.aiModel.trim()
    : getDefaultAiModel(provider, "assistant",);
  if (!apiKey) return null;
  return { provider, model, apiKey, };
}

export function resolveActiveSttConfig(settings: Settings,): ActiveSttConfig | null {
  const provider = normalizeSttProvider(settings.currentSttProvider,);
  const model = settings.currentSttModel.trim() || getDefaultSttModel(provider,);
  const baseUrl = settings.sttBaseUrl.trim() || getDefaultSttBaseUrl(provider,);
  const apiKey = getSttProviderApiKey(settings, provider,);
  const spokenLanguages = normalizeSpokenLanguages(settings.spokenLanguages,);

  if (!model || !baseUrl || !apiKey || spokenLanguages.length === 0) {
    return null;
  }

  return {
    provider,
    model,
    baseUrl,
    apiKey,
    spokenLanguages,
    saveRecordings: settings.saveRecordings !== false,
  };
}

export function hasActiveAiProvider(settings: Settings,) {
  return Boolean(resolveActiveAiConfig(settings,),);
}

async function getSettingsPath(): Promise<string> {
  const base = await getBaseDir();
  return await join(base, SETTINGS_FILE,);
}

export async function loadSettings(): Promise<Settings> {
  const path = await getSettingsPath();
  const fileExists = await exists(path,);
  if (!fileExists) return { ...DEFAULT_SETTINGS, };

  try {
    const raw = await readTextFile(path,);
    const parsed = JSON.parse(raw,);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      aiProvider: normalizeAiProvider(parsed.aiProvider,),
      aiModel: typeof parsed.aiModel === "string" ? parsed.aiModel.trim() : "",
      currentSttProvider: normalizeSttProvider(parsed.currentSttProvider,),
      currentSttModel: typeof parsed.currentSttModel === "string"
        ? parsed.currentSttModel.trim() || getDefaultSttModel(normalizeSttProvider(parsed.currentSttProvider,),)
        : getDefaultSttModel(normalizeSttProvider(parsed.currentSttProvider,),),
      sttBaseUrl: typeof parsed.sttBaseUrl === "string"
        ? parsed.sttBaseUrl.trim() || getDefaultSttBaseUrl(normalizeSttProvider(parsed.currentSttProvider,),)
        : getDefaultSttBaseUrl(normalizeSttProvider(parsed.currentSttProvider,),),
      sttApiKey: typeof parsed.sttApiKey === "string" ? parsed.sttApiKey : "",
      spokenLanguages: normalizeSpokenLanguages(parsed.spokenLanguages,),
      saveRecordings: parsed.saveRecordings !== false,
      googleEmailOpenClient: normalizeGoogleEmailOpenClient(parsed.googleEmailOpenClient,),
      googleCalendarOpenClient: normalizeGoogleCalendarOpenClient(parsed.googleCalendarOpenClient,),
      googleAccounts: normalizeGoogleAccounts(parsed.googleAccounts, {
        email: parsed.googleAccountEmail,
        accessTokenExpiresAt: parsed.googleAccessTokenExpiresAt,
        grantedScopes: parsed.googleGrantedScopes,
      },),
      googleOAuthClientId: normalizeGoogleOAuthClientId(parsed.googleOAuthClientId,),
      googleGrantedScopes: normalizeGoogleGrantedScopes(parsed.googleGrantedScopes,),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, };
  }
}

export async function saveSettings(settings: Settings,): Promise<void> {
  const base = await getBaseDir();
  const dirExists = await exists(base,);
  if (!dirExists) {
    await mkdir(base, { recursive: true, },);
  }
  const path = await join(base, SETTINGS_FILE,);
  await writeTextFile(
    path,
    JSON.stringify(
      {
        ...settings,
        aiModel: settings.aiModel.trim(),
        currentSttProvider: normalizeSttProvider(settings.currentSttProvider,),
        currentSttModel: settings.currentSttModel.trim(),
        sttBaseUrl: settings.sttBaseUrl.trim(),
        sttApiKey: settings.sttApiKey.trim(),
        spokenLanguages: normalizeSpokenLanguages(settings.spokenLanguages,),
        saveRecordings: settings.saveRecordings !== false,
        googleAccounts: normalizeGoogleAccounts(settings.googleAccounts,),
        googleOAuthClientId: DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
      },
      null,
      2,
    ),
  );
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT,),);
  }
}

export async function getApiKey(): Promise<string> {
  const config = await getActiveAiConfig();
  return config?.apiKey ?? "";
}

export async function setApiKey(key: string, provider?: AiProvider,): Promise<void> {
  const settings = await loadSettings();
  switch (provider ?? settings.aiProvider) {
    case "anthropic":
      settings.anthropicApiKey = key;
      break;
    case "openai":
      settings.openaiApiKey = key;
      break;
    case "google":
      settings.googleApiKey = key;
      break;
    case "openrouter":
      settings.openrouterApiKey = key;
      break;
  }
  await saveSettings(settings,);
}

export async function getActiveAiConfig(): Promise<ActiveAiConfig | null> {
  const settings = await loadSettings();
  return resolveActiveAiConfig(settings,);
}

export async function getActiveSttConfig(): Promise<ActiveSttConfig | null> {
  const settings = await loadSettings();
  return resolveActiveSttConfig(settings,);
}

export async function getJournalDirSetting(): Promise<string> {
  const settings = await loadSettings();
  return settings.journalDir;
}

export async function getFilenamePattern(): Promise<string> {
  const settings = await loadSettings();
  return settings.filenamePattern || DEFAULT_FILENAME_PATTERN;
}

export async function getVaultDirSetting(): Promise<string> {
  const settings = await loadSettings();
  return settings.vaultDir;
}

export async function getDailyLogsFolderSetting(): Promise<string> {
  const settings = await loadSettings();
  return settings.dailyLogsFolder;
}

export async function getExcalidrawFolderSetting(): Promise<string> {
  const settings = await loadSettings();
  return settings.excalidrawFolder;
}

export async function getAssetsFolderSetting(): Promise<string> {
  const settings = await loadSettings();
  return settings.assetsFolder;
}

export async function getWidgetGitHistoryEnabledSetting(): Promise<boolean> {
  const settings = await loadSettings();
  return settings.widgetGitHistoryEnabled !== false;
}
