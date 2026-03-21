import { invoke, } from "@tauri-apps/api/core";
import { openUrl, } from "@tauri-apps/plugin-opener";
import { type GoogleAccount, loadSettings, saveSettings, type Settings, } from "./settings";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_CONNECT_TIMEOUT_MS = 180_000;

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const GOOGLE_GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export const GOOGLE_ACCOUNT_SCOPES = [
  "openid",
  "email",
  "profile",
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_GMAIL_SCOPE,
] as const;

interface GoogleOAuthSession {
  sessionId: string;
  redirectUri: string;
}

interface GoogleOAuthCallback {
  code?: string;
  state?: string;
  error?: string;
}

interface GoogleLegacySessionInput {
  accessToken: string;
  accessTokenExpiresAtMs: number;
  refreshToken: string;
}

interface GoogleOAuthConnectionResult {
  accountEmail: string;
  accessTokenExpiresAtMs: number;
  grantedScopes: string[];
}

interface GoogleAccessTokenResult {
  accountEmail: string;
  accessToken: string;
  accessTokenExpiresAtMs: number;
  grantedScopes: string[];
}

export function isGoogleAccountConnected(settings: Settings,) {
  return settings.googleAccounts.length > 0;
}

function createAbortError() {
  return new DOMException("Google authorization cancelled.", "AbortError",);
}

function throwIfAborted(signal?: AbortSignal,) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

async function cancelGoogleOAuthCallback(sessionId: string,) {
  await invoke("cancel_google_oauth_callback", { sessionId, },);
}

async function waitForGoogleOAuthCallback(sessionId: string, timeoutMs: number, signal?: AbortSignal,) {
  throwIfAborted(signal,);

  if (!signal) {
    return await invoke<GoogleOAuthCallback>("wait_for_google_oauth_callback", {
      sessionId,
      timeoutMs,
    },);
  }

  return await new Promise<GoogleOAuthCallback>((resolve, reject,) => {
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort,);
    };

    const settle = (callback: () => void,) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const handleAbort = () => {
      void cancelGoogleOAuthCallback(sessionId,)
        .catch(() => undefined)
        .finally(() => {
          settle(() => reject(createAbortError(),));
        },);
    };

    signal.addEventListener("abort", handleAbort, { once: true, },);

    invoke<GoogleOAuthCallback>("wait_for_google_oauth_callback", {
      sessionId,
      timeoutMs,
    },)
      .then((callback,) => {
        settle(() => resolve(callback,));
      },)
      .catch((error,) => {
        settle(() => reject(error,));
      },);
  },);
}

export function hasGoogleAccess(settings: Settings, scope: string, accountEmail?: string,) {
  const normalizedScope = scope.trim();
  if (!normalizedScope) return false;

  return settings.googleAccounts.some((account,) => {
    if (accountEmail && account.email.toLowerCase() !== accountEmail.trim().toLowerCase()) {
      return false;
    }
    return account.grantedScopes.includes(normalizedScope,);
  },);
}

function toBase64Url(bytes: Uint8Array,) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte,);
  }
  return btoa(binary,)
    .replace(/\+/g, "-",)
    .replace(/\//g, "_",)
    .replace(/=+$/g, "",);
}

function createRandomVerifier(byteLength: number = 32,) {
  const bytes = new Uint8Array(byteLength,);
  crypto.getRandomValues(bytes,);
  return toBase64Url(bytes,);
}

async function createCodeChallenge(verifier: string,) {
  const bytes = new TextEncoder().encode(verifier,);
  const digest = await crypto.subtle.digest("SHA-256", bytes,);
  return toBase64Url(new Uint8Array(digest,),);
}

function buildGrantedScopes(scopes: string[] | undefined,) {
  if (!scopes || scopes.length === 0) return [...GOOGLE_ACCOUNT_SCOPES,];
  return Array.from(
    new Set(
      scopes
        .map((scope,) => scope.trim())
        .filter(Boolean,),
    ),
  );
}

function toExpiryTimestamp(expiresAtMs: number,) {
  if (!Number.isFinite(expiresAtMs,) || expiresAtMs <= 0) return "";
  return new Date(expiresAtMs,).toISOString();
}

function buildLegacySessionInput(settings: Settings, accountEmail?: string,): GoogleLegacySessionInput | null {
  const legacyEmail = settings.googleAccountEmail.trim();
  if (accountEmail && legacyEmail.toLowerCase() !== accountEmail.trim().toLowerCase()) {
    return null;
  }

  const refreshToken = settings.googleRefreshToken.trim();
  if (!refreshToken) return null;

  const accessTokenExpiresAtMs = settings.googleAccessTokenExpiresAt
    ? new Date(settings.googleAccessTokenExpiresAt,).getTime()
    : 0;

  return {
    accessToken: settings.googleAccessToken.trim(),
    accessTokenExpiresAtMs: Number.isFinite(accessTokenExpiresAtMs,) && accessTokenExpiresAtMs > 0
      ? accessTokenExpiresAtMs
      : 0,
    refreshToken,
  };
}

function buildGoogleAccount(
  accessTokenExpiresAtMs: number,
  email: string,
  grantedScopes: string[],
): GoogleAccount {
  return {
    email,
    accessTokenExpiresAt: toExpiryTimestamp(accessTokenExpiresAtMs,),
    grantedScopes: buildGrantedScopes(grantedScopes,),
  };
}

function upsertGoogleAccount(accounts: GoogleAccount[], account: GoogleAccount,) {
  const normalizedEmail = account.email.trim().toLowerCase();
  const next = accounts.filter((entry,) => entry.email.trim().toLowerCase() !== normalizedEmail);
  next.push(account,);
  return next;
}

function removeGoogleAccount(accounts: GoogleAccount[], email: string,) {
  const normalizedEmail = email.trim().toLowerCase();
  return accounts.filter((entry,) => entry.email.trim().toLowerCase() !== normalizedEmail);
}

function buildConnectionPatch(clientId: string, accounts: GoogleAccount[],) {
  return {
    googleOAuthClientId: clientId.trim(),
    googleAccounts: accounts,
  } satisfies Pick<
    Settings,
    | "googleOAuthClientId"
    | "googleAccounts"
  >;
}

async function saveGoogleFields(currentSettings: Settings, partial: Partial<Settings>,) {
  const nextSettings = { ...currentSettings, ...partial, };
  await saveSettings(nextSettings,);
  return nextSettings;
}

export async function connectGoogleAccount(
  settings: Settings,
  options?: { expectedAccountEmail?: string; signal?: AbortSignal; },
) {
  const clientId = settings.googleOAuthClientId.trim();
  if (!clientId) {
    throw new Error("Google sign-in is not configured yet.",);
  }

  const verifier = createRandomVerifier(64,);
  const challenge = await createCodeChallenge(verifier,);
  const state = createRandomVerifier(32,);

  const session = await invoke<GoogleOAuthSession>("start_google_oauth_callback",);
  const authUrl = new URL(GOOGLE_AUTH_URL,);
  authUrl.searchParams.set("access_type", "offline",);
  authUrl.searchParams.set("client_id", clientId,);
  authUrl.searchParams.set("code_challenge", challenge,);
  authUrl.searchParams.set("code_challenge_method", "S256",);
  authUrl.searchParams.set("include_granted_scopes", "true",);
  authUrl.searchParams.set("prompt", options?.expectedAccountEmail ? "consent select_account" : "consent",);
  authUrl.searchParams.set("redirect_uri", session.redirectUri,);
  authUrl.searchParams.set("response_type", "code",);
  authUrl.searchParams.set("scope", GOOGLE_ACCOUNT_SCOPES.join(" ",),);
  authUrl.searchParams.set("state", state,);
  if (options?.expectedAccountEmail) {
    authUrl.searchParams.set("login_hint", options.expectedAccountEmail,);
  }

  try {
    throwIfAborted(options?.signal,);
    await openUrl(authUrl.toString(),);
  } catch (error) {
    await cancelGoogleOAuthCallback(session.sessionId,).catch(() => undefined);
    throw error;
  }

  const callback = await waitForGoogleOAuthCallback(
    session.sessionId,
    GOOGLE_CONNECT_TIMEOUT_MS,
    options?.signal,
  );

  if (callback.error) {
    throw new Error(callback.error,);
  }
  if (!callback.code) {
    throw new Error("Google did not return an authorization code.",);
  }
  if (callback.state !== state) {
    throw new Error("Google OAuth state mismatch. Please try again.",);
  }

  throwIfAborted(options?.signal,);

  const result = await invoke<GoogleOAuthConnectionResult>("complete_google_oauth", {
    input: {
      clientId,
      code: callback.code,
      codeVerifier: verifier,
      expectedAccountEmail: options?.expectedAccountEmail,
      legacyAccountEmail: settings.googleAccountEmail.trim(),
      legacySession: buildLegacySessionInput(settings, options?.expectedAccountEmail,),
      redirectUri: session.redirectUri,
    },
  },);

  throwIfAborted(options?.signal,);

  const account = buildGoogleAccount(
    result.accessTokenExpiresAtMs,
    result.accountEmail,
    result.grantedScopes,
  );

  return buildConnectionPatch(
    clientId,
    upsertGoogleAccount(settings.googleAccounts, account,),
  );
}

export async function disconnectGoogleAccount(settings: Settings, accountEmail: string,) {
  await invoke("clear_google_oauth_session", { accountEmail, },);
  const next = {
    ...settings,
    googleAccounts: removeGoogleAccount(settings.googleAccounts, accountEmail,),
  } satisfies Settings;

  await saveSettings(next,);
  return next;
}

export async function getGoogleAccessToken(accountEmail?: string,) {
  const settings = await loadSettings();
  const clientId = settings.googleOAuthClientId.trim();
  if (!clientId) {
    throw new Error("Reconnect Google to refresh access.",);
  }

  const account = accountEmail
    ? settings.googleAccounts.find((entry,) => entry.email.toLowerCase() === accountEmail.trim().toLowerCase())
    : settings.googleAccounts.length === 1
    ? settings.googleAccounts[0]
    : null;
  if (!account) {
    throw new Error("Select a Google account before fetching Google data.",);
  }

  const result = await invoke<GoogleAccessTokenResult>("ensure_google_access_token", {
    input: {
      accountEmail: account.email,
      clientId,
      grantedScopes: [...account.grantedScopes,],
      legacyAccountEmail: settings.googleAccountEmail.trim(),
      legacySession: buildLegacySessionInput(settings, account.email,),
    },
  },);
  const updatedAccount = buildGoogleAccount(
    result.accessTokenExpiresAtMs,
    result.accountEmail,
    result.grantedScopes,
  );
  await saveGoogleFields(
    settings,
    {
      googleOAuthClientId: clientId,
      googleAccounts: upsertGoogleAccount(settings.googleAccounts, updatedAccount,),
    },
  );
  return result.accessToken;
}
