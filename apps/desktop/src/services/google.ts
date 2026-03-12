import { invoke, } from "@tauri-apps/api/core";
import { openUrl, } from "@tauri-apps/plugin-opener";
import { loadSettings, saveSettings, type Settings, } from "./settings";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_CONNECT_TIMEOUT_MS = 180_000;
const GOOGLE_EXPIRY_BUFFER_MS = 60_000;

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
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

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfoResponse {
  email?: string;
}

interface GoogleTokenResult {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  scope?: string;
}

export function isGoogleAccountConnected(settings: Settings,) {
  return !!settings.googleAccountEmail.trim()
    && (!!settings.googleRefreshToken.trim() || !!settings.googleAccessToken.trim());
}

export function hasGoogleAccess(settings: Settings, scope: string,) {
  return settings.googleGrantedScopes.includes(scope,);
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

async function parseGoogleError(response: Response,) {
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    throw new Error("Google request failed.",);
  }

  const error = typeof payload.error === "string" ? payload.error : "request_failed";
  const description = typeof payload.error_description === "string"
    ? payload.error_description
    : typeof payload.error?.message === "string"
    ? payload.error.message
    : "";
  throw new Error(description ? `Google ${error}: ${description}` : `Google ${error}.`,);
}

async function exchangeAuthorizationCode(
  clientId: string,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<GoogleTokenResult> {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  },);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  },);

  if (!response.ok) {
    await parseGoogleError(response,);
  }

  const payload = await response.json() as GoogleTokenResponse;
  if (!payload.access_token || !payload.expires_in) {
    throw new Error("Google did not return an access token.",);
  }
  return {
    accessToken: payload.access_token,
    expiresIn: payload.expires_in,
    refreshToken: payload.refresh_token,
    scope: payload.scope,
  };
}

async function fetchGoogleUserEmail(accessToken: string,) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  },);

  if (!response.ok) {
    await parseGoogleError(response,);
  }

  const payload = await response.json() as GoogleUserInfoResponse;
  if (!payload.email) {
    throw new Error("Google did not return an email address.",);
  }
  return payload.email;
}

function buildGrantedScopes(scopeValue: string | undefined,) {
  if (!scopeValue) return [...GOOGLE_ACCOUNT_SCOPES,];
  return Array.from(
    new Set(
      scopeValue
        .split(" ",)
        .map((scope,) => scope.trim())
        .filter(Boolean,),
    ),
  );
}

function toExpiryTimestamp(expiresInSeconds: number,) {
  return new Date(Date.now() + (expiresInSeconds * 1000),).toISOString();
}

function buildConnectionPatch(
  clientId: string,
  accessToken: string,
  expiresInSeconds: number,
  refreshToken: string,
  email: string,
  grantedScopes: string[],
) {
  return {
    googleOAuthClientId: clientId.trim(),
    googleAccessToken: accessToken,
    googleAccessTokenExpiresAt: toExpiryTimestamp(expiresInSeconds,),
    googleRefreshToken: refreshToken,
    googleAccountEmail: email,
    googleGrantedScopes: grantedScopes,
  } satisfies Pick<
    Settings,
    | "googleOAuthClientId"
    | "googleAccessToken"
    | "googleAccessTokenExpiresAt"
    | "googleRefreshToken"
    | "googleAccountEmail"
    | "googleGrantedScopes"
  >;
}

async function saveGoogleFields(currentSettings: Settings, partial: Partial<Settings>,) {
  const nextSettings = { ...currentSettings, ...partial, };
  await saveSettings(nextSettings,);
  return nextSettings;
}

export async function connectGoogleAccount(settings: Settings,) {
  const clientId = settings.googleOAuthClientId.trim();
  if (!clientId) {
    throw new Error("Add a Google OAuth client ID before connecting.",);
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
  authUrl.searchParams.set("prompt", "consent",);
  authUrl.searchParams.set("redirect_uri", session.redirectUri,);
  authUrl.searchParams.set("response_type", "code",);
  authUrl.searchParams.set("scope", GOOGLE_ACCOUNT_SCOPES.join(" ",),);
  authUrl.searchParams.set("state", state,);

  await openUrl(authUrl.toString(),);

  const callback = await invoke<GoogleOAuthCallback>("wait_for_google_oauth_callback", {
    sessionId: session.sessionId,
    timeoutMs: GOOGLE_CONNECT_TIMEOUT_MS,
  },);

  if (callback.error) {
    throw new Error(callback.error,);
  }
  if (!callback.code) {
    throw new Error("Google did not return an authorization code.",);
  }
  if (callback.state !== state) {
    throw new Error("Google OAuth state mismatch. Please try again.",);
  }

  const token = await exchangeAuthorizationCode(clientId, callback.code, session.redirectUri, verifier,);
  const email = await fetchGoogleUserEmail(token.accessToken,);
  const grantedScopes = buildGrantedScopes(token.scope,);
  const refreshToken = token.refreshToken ?? settings.googleRefreshToken.trim();
  if (!refreshToken) {
    throw new Error("Google did not return a refresh token. Use a desktop OAuth client ID and try again.",);
  }

  return buildConnectionPatch(
    clientId,
    token.accessToken,
    token.expiresIn,
    refreshToken,
    email,
    grantedScopes,
  );
}

export async function disconnectGoogleAccount(settings: Settings,) {
  const next = {
    ...settings,
    googleAccountEmail: "",
    googleAccessToken: "",
    googleRefreshToken: "",
    googleAccessTokenExpiresAt: "",
    googleGrantedScopes: [],
  } satisfies Settings;

  await saveSettings(next,);
  return next;
}

async function refreshGoogleAccessToken(settings: Settings,) {
  const clientId = settings.googleOAuthClientId.trim();
  const refreshToken = settings.googleRefreshToken.trim();
  if (!clientId || !refreshToken) {
    throw new Error("Reconnect Google to refresh access.",);
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  },);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  },);

  if (!response.ok) {
    await parseGoogleError(response,);
  }

  const payload = await response.json() as GoogleTokenResponse;
  if (!payload.access_token || !payload.expires_in) {
    throw new Error("Google did not return a refreshed access token.",);
  }

  return buildConnectionPatch(
    clientId,
    payload.access_token,
    payload.expires_in,
    refreshToken,
    settings.googleAccountEmail.trim(),
    buildGrantedScopes(payload.scope || settings.googleGrantedScopes.join(" ",),),
  );
}

export async function getGoogleAccessToken() {
  const settings = await loadSettings();
  const expiry = settings.googleAccessTokenExpiresAt
    ? new Date(settings.googleAccessTokenExpiresAt,).getTime()
    : 0;
  if (
    settings.googleAccessToken.trim()
    && expiry > (Date.now() + GOOGLE_EXPIRY_BUFFER_MS)
  ) {
    return settings.googleAccessToken.trim();
  }

  const refreshed = await refreshGoogleAccessToken(settings,);
  const nextSettings = await saveGoogleFields(settings, refreshed,);
  return nextSettings.googleAccessToken;
}
