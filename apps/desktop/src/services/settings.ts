import { join, } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile, } from "@tauri-apps/plugin-fs";
import { getBaseDir, } from "./paths";

export interface Settings {
  aiProvider: AiProvider;
  anthropicApiKey: string;
  openaiApiKey: string;
  googleApiKey: string;
  openrouterApiKey: string;
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
  hasCompletedOnboarding: boolean;
}

const SETTINGS_FILE = "settings.json";

export const AI_PROVIDERS = ["anthropic", "openai", "google", "openrouter",] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const DEFAULT_AI_PROVIDER: AiProvider = "anthropic";

export interface ActiveAiConfig {
  provider: AiProvider;
  apiKey: string;
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
  anthropicApiKey: "",
  openaiApiKey: "",
  googleApiKey: "",
  openrouterApiKey: "",
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
  hasCompletedOnboarding: false,
};

function normalizeAiProvider(value: unknown,): AiProvider {
  return typeof value === "string" && AI_PROVIDERS.includes(value as AiProvider,)
    ? value as AiProvider
    : DEFAULT_AI_PROVIDER;
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

export function resolveActiveAiConfig(settings: Settings,): ActiveAiConfig | null {
  const provider = normalizeAiProvider(settings.aiProvider,);
  const apiKey = getAiProviderApiKey(settings, provider,);
  if (!apiKey) return null;
  return { provider, apiKey, };
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
        googleAccounts: normalizeGoogleAccounts(settings.googleAccounts,),
        googleOAuthClientId: DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
      },
      null,
      2,
    ),
  );
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
