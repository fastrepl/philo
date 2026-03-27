#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

#[cfg(target_os = "macos")]
mod macos_location;
pub mod philo_tools;
pub mod settings_paths;
pub mod widget_git;

use crate::settings_paths::normalize_folder;
use keyring::{Entry as KeyringEntry, Error as KeyringError};
use reqwest::blocking::{Client as HttpClient, Response as HttpResponse};
use reqwest::{Client as AsyncHttpClient, Method};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, fs, process::Command};
use tauri::ipc::Channel;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_fs::FsExt;
use tauri_plugin_permissions::{Permission, PermissionStatus, PermissionsPluginExt};
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
use widget_git::{
    EnsureWidgetGitBaselineInput, RecordWidgetGitRevisionInput, RestoreWidgetGitRevisionInput,
    WidgetGitDiff, WidgetGitDiffInput, WidgetGitHistoryEntry, WidgetGitHistoryInput,
    WidgetGitRestoreResult,
};

#[cfg(target_os = "macos")]
#[repr(C)]
struct NSPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct NSSize {
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct NSRect {
    origin: NSPoint,
    size: NSSize,
}

const GOOGLE_OAUTH_DEFAULT_TIMEOUT_MS: u64 = 180_000;
const GOOGLE_OAUTH_ACCESS_TOKEN_BUFFER_MS: u64 = 60_000;
const GOOGLE_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_OAUTH_USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_OAUTH_KEYRING_SERVICE: &str = "com.johnjeong.philo.google-oauth";
const GOOGLE_OAUTH_KEYRING_SERVICE_DEV: &str = "com.johnjeong.philo.dev.google-oauth";
const GOOGLE_OAUTH_KEYRING_ACCOUNT: &str = "session";

#[derive(Default)]
struct GoogleOAuthState {
    sessions: Mutex<HashMap<String, Arc<GoogleOAuthPendingSession>>>,
}

struct GoogleOAuthPendingSession {
    cancelled: AtomicBool,
    receiver: Mutex<mpsc::Receiver<GoogleOAuthCallbackPayload>>,
}

#[derive(Default)]
struct HttpStreamState {
    requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleOAuthSession {
    session_id: String,
    redirect_uri: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleOAuthCallbackPayload {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleOAuthLegacySessionInput {
    #[serde(default)]
    access_token: String,
    access_token_expires_at_ms: u64,
    refresh_token: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleCompleteOAuthInput {
    client_id: String,
    code: String,
    code_verifier: String,
    #[serde(default)]
    expected_account_email: Option<String>,
    #[serde(default)]
    legacy_account_email: Option<String>,
    #[serde(default)]
    legacy_session: Option<GoogleOAuthLegacySessionInput>,
    redirect_uri: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEnsureAccessTokenInput {
    client_id: String,
    account_email: String,
    #[serde(default)]
    legacy_account_email: Option<String>,
    #[serde(default)]
    granted_scopes: Vec<String>,
    #[serde(default)]
    legacy_session: Option<GoogleOAuthLegacySessionInput>,
}

type GoogleStoredSessions = HashMap<String, GoogleStoredSession>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleStoredSession {
    access_token: String,
    access_token_expires_at_ms: u64,
    refresh_token: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GoogleTokenResponse {
    access_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    scope: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct GoogleUserInfoResponse {
    email: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleOAuthConnectionResult {
    access_token_expires_at_ms: u64,
    account_email: String,
    granted_scopes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleAccessTokenResult {
    account_email: String,
    access_token: String,
    access_token_expires_at_ms: u64,
    granted_scopes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpJsonResponse {
    status: u16,
    body: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpJsonRequestInput {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpStreamRequestInput {
    request_id: String,
    url: String,
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum HttpStreamEvent {
    Start {
        status: u16,
        headers: Vec<[String; 2]>,
    },
    Chunk {
        data: Vec<u8>,
    },
    End,
    Error {
        message: String,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCurrentPosition {
    latitude: f64,
    longitude: f64,
    accuracy: f64,
}

#[tauri::command]
fn set_window_opacity(_app: AppHandle, _opacity: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = _app.get_webview_window("main").ok_or("Window not found")?;
        let ns_win = window.ns_window().map_err(|e| e.to_string())?;
        unsafe {
            let _: () =
                objc::msg_send![ns_win as *mut objc::runtime::Object, setAlphaValue: _opacity];
        }
    }
    Ok(())
}

#[tauri::command]
async fn get_native_current_position(
    app: AppHandle,
) -> Result<Option<NativeCurrentPosition>, String> {
    #[cfg(target_os = "macos")]
    {
        let position =
            tauri::async_runtime::spawn_blocking(move || macos_location::get_current_position(app))
                .await
                .map_err(|e| e.to_string())??;
        Ok(Some(NativeCurrentPosition {
            latitude: position.latitude,
            longitude: position.longitude,
            accuracy: position.accuracy,
        }))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn set_macos_process_name(name: &str) {
    use std::ffi::CString;

    let Ok(c_name) = CString::new(name) else {
        return;
    };

    unsafe {
        let ns_string_class = match objc::runtime::Class::get("NSString") {
            Some(class) => class,
            None => return,
        };
        let allocated: *mut objc::runtime::Object = objc::msg_send![ns_string_class, alloc];
        let ns_name: *mut objc::runtime::Object =
            objc::msg_send![allocated, initWithUTF8String:c_name.as_ptr()];

        let process_info_class = match objc::runtime::Class::get("NSProcessInfo") {
            Some(class) => class,
            None => return,
        };
        let process_info: *mut objc::runtime::Object =
            objc::msg_send![process_info_class, processInfo];
        let _: () = objc::msg_send![process_info, setProcessName: ns_name];
    }
}

#[cfg(target_os = "macos")]
fn offset_macos_traffic_lights(window: &tauri::WebviewWindow, delta_y: f64) -> Result<(), String> {
    let ns_win = window.ns_window().map_err(|e| e.to_string())?;
    let ns_window = ns_win as *mut objc::runtime::Object;

    unsafe {
        let close_button: *mut objc::runtime::Object =
            msg_send![ns_window, standardWindowButton: 0usize];
        if close_button.is_null() {
            return Ok(());
        }

        let title_bar_view: *mut objc::runtime::Object = msg_send![close_button, superview];
        if title_bar_view.is_null() {
            return Ok(());
        }

        let title_bar_container: *mut objc::runtime::Object = msg_send![title_bar_view, superview];
        if title_bar_container.is_null() {
            return Ok(());
        }

        let mut title_bar_rect: NSRect = msg_send![title_bar_container, frame];
        let window_rect: NSRect = msg_send![ns_window, frame];
        title_bar_rect.size.height += delta_y;
        title_bar_rect.origin.y = window_rect.size.height - title_bar_rect.size.height;

        let _: () = msg_send![title_bar_container, setFrame: title_bar_rect];
    }

    Ok(())
}

#[tauri::command]
fn read_markdown_file(path: String) -> Result<Option<String>, String> {
    let normalized_path = path.trim();
    if normalized_path.is_empty() {
        return Ok(None);
    }

    match fs::read_to_string(normalized_path) {
        Ok(content) => Ok(Some(content)),
        Err(err) => {
            if err.kind() == std::io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(err.to_string())
            }
        }
    }
}

#[tauri::command]
fn write_markdown_file(path: String, content: String) -> Result<(), String> {
    let normalized_path = path.trim();
    if normalized_path.is_empty() {
        return Ok(());
    }

    let target = PathBuf::from(normalized_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::write(target, content).map_err(|e| e.to_string())
}

fn decode_url_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hi = bytes[index + 1] as char;
                let lo = bytes[index + 2] as char;
                if let (Some(hi), Some(lo)) = (hi.to_digit(16), lo.to_digit(16)) {
                    decoded.push(((hi * 16) + lo) as u8);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            value => {
                decoded.push(value);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&decoded).to_string()
}

fn parse_google_oauth_callback(path: &str) -> GoogleOAuthCallbackPayload {
    let query = path
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or_default();
    let mut params = HashMap::new();

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        params.insert(decode_url_component(key), decode_url_component(value));
    }

    let error = params.get("error").cloned();
    let code = params.get("code").cloned();
    let state = params.get("state").cloned();

    GoogleOAuthCallbackPayload {
        code,
        state,
        error: error.or_else(|| {
            if params.contains_key("code") {
                None
            } else {
                Some("Google did not return an authorization code.".to_string())
            }
        }),
    }
}

fn write_google_oauth_response(
    stream: &mut std::net::TcpStream,
    status: &str,
    body: &str,
) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|e| e.to_string())
}

fn focus_main_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn google_oauth_callback_page(success: bool) -> String {
    let offer_deep_link = success && !cfg!(debug_assertions);
    let eyebrow = if success {
        "Google connected"
    } else {
        "Google sign-in failed"
    };
    let title = if success {
        "Account connected."
    } else {
        "Connection didn't go through."
    };
    let description = if success {
        "Your Google account is now connected to Philo."
    } else {
        "Philo could not finish connecting your Google account."
    };
    let detail = if offer_deep_link {
        "Philo should reopen automatically. If it stays in the background, open it below."
    } else if success {
        "Philo should come forward automatically. If it stays in the background, switch back to the app."
    } else {
        "Close this window and try again from Philo."
    };
    let panel_class = if success {
        "panel panel-success"
    } else {
        "panel panel-error"
    };
    let action_markup = if offer_deep_link {
        r#"<div class="actions">
          <a class="open-button" href="philo://google-connected">Open Philo</a>
        </div>"#
            .to_string()
    } else {
        String::new()
    };
    let auto_open_script = if offer_deep_link {
        r#"<script>
      window.setTimeout(() => {
        window.location.href = "philo://google-connected";
      }, 300);
    </script>"#
            .to_string()
    } else {
        String::new()
    };

    format!(
        r#"<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title} | Philo</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap"
      rel="stylesheet"
    />
    <style>
      :root {{
        color-scheme: light;
        --bg: #f4f4f1;
        --bg-soft: rgba(255, 255, 255, 0.72);
        --line: #e2e2db;
        --text: #252525;
        --muted: #646460;
        --accent: #5f70d8;
        --success: #2f7a58;
        --success-bg: rgba(47, 122, 88, 0.08);
        --error: #a14e42;
        --error-bg: rgba(161, 78, 66, 0.08);
      }}

      * {{
        box-sizing: border-box;
      }}

      body {{
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Mono", "SFMono-Regular", Menlo, monospace;
        background: linear-gradient(150deg, #f6f6f4 0%, #efefeb 100%);
        color: var(--text);
        position: relative;
        overflow: hidden;
      }}

      .ambient {{
        position: fixed;
        inset: 0;
        pointer-events: none;
        background:
          radial-gradient(circle at 10% 12%, rgba(255, 255, 255, 0.95) 0%, transparent 32%),
          radial-gradient(circle at 92% 88%, rgba(95, 112, 216, 0.16) 0%, transparent 34%);
        opacity: 0.95;
      }}

      .shell {{
        position: relative;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 32px 20px;
      }}

      .frame {{
        width: min(100%, 560px);
      }}

      .brand {{
        margin: 0 0 14px;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #3f3f3d;
      }}

      .panel {{
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 28px;
        background: var(--bg-soft);
        backdrop-filter: blur(18px);
        box-shadow: 0 20px 60px rgba(32, 32, 29, 0.08);
      }}

      .panel-success {{
        box-shadow:
          0 20px 60px rgba(32, 32, 29, 0.08),
          inset 0 0 0 1px rgba(47, 122, 88, 0.08);
      }}

      .panel-error {{
        box-shadow:
          0 20px 60px rgba(32, 32, 29, 0.08),
          inset 0 0 0 1px rgba(161, 78, 66, 0.08);
      }}

      .eyebrow {{
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        padding: 7px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }}

      .panel-success .eyebrow {{
        color: var(--success);
        background: var(--success-bg);
      }}

      .panel-error .eyebrow {{
        color: var(--error);
        background: var(--error-bg);
      }}

      h1 {{
        margin: 18px 0 10px;
        font-size: clamp(28px, 4vw, 40px);
        line-height: 1.1;
        font-weight: 500;
        letter-spacing: -0.04em;
      }}

      .description {{
        margin: 0;
        font-size: 14px;
        line-height: 1.7;
        color: #3f3f3d;
      }}

      .detail {{
        margin: 20px 0 0;
        padding-top: 16px;
        border-top: 1px solid var(--line);
        font-size: 12px;
        line-height: 1.7;
        color: var(--muted);
      }}

      .actions {{
        display: flex;
        margin-top: 22px;
      }}

      .open-button {{
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 0 18px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #ffffff;
        color: var(--text);
        font-size: 14px;
        font-weight: 500;
        text-decoration: none;
        transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
      }}

      .open-button:hover {{
        border-color: rgba(95, 112, 216, 0.35);
        box-shadow: 0 16px 28px rgba(95, 112, 216, 0.14);
        transform: translateY(-1px);
      }}

      .open-button:active {{
        transform: translateY(0);
        box-shadow: none;
      }}

      @media (max-width: 640px) {{
        .shell {{
          padding: 18px;
        }}

        .panel {{
          padding: 22px;
          border-radius: 20px;
        }}
      }}
    </style>
  </head>
  <body>
    <div class="ambient"></div>
    <main class="shell">
      <div class="frame">
        <p class="brand">Philo</p>
        <section class="{panel_class}">
          <p class="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p class="description">{description}</p>
          <p class="detail">{detail}</p>
          {action_markup}
        </section>
      </div>
    </main>
    {auto_open_script}
  </body>
</html>"#
    )
}

fn receive_google_oauth_callback(listener: TcpListener) -> GoogleOAuthCallbackPayload {
    let Ok((mut stream, _addr)) = listener.accept() else {
        return GoogleOAuthCallbackPayload {
            code: None,
            state: None,
            error: Some("Could not receive Google authorization callback.".to_string()),
        };
    };

    let mut buffer = [0_u8; 8192];
    let request_size = match stream.read(&mut buffer) {
        Ok(size) if size > 0 => size,
        _ => {
            let _ = write_google_oauth_response(
                &mut stream,
                "400 Bad Request",
                &google_oauth_callback_page(false),
            );
            return GoogleOAuthCallbackPayload {
                code: None,
                state: None,
                error: Some("Google callback request was empty.".to_string()),
            };
        }
    };

    let request = String::from_utf8_lossy(&buffer[..request_size]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");

    let payload = parse_google_oauth_callback(path);
    let body = if payload.error.is_some() {
        google_oauth_callback_page(false)
    } else {
        google_oauth_callback_page(true)
    };
    let status = if payload.error.is_some() {
        "400 Bad Request"
    } else {
        "200 OK"
    };

    let _ = write_google_oauth_response(&mut stream, status, &body);
    payload
}

#[tauri::command]
fn start_google_oauth_callback(
    app: AppHandle,
    state: State<GoogleOAuthState>,
) -> Result<GoogleOAuthSession, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let session_id = format!(
        "google-oauth-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );

    let (sender, receiver) = mpsc::channel();
    state
        .sessions
        .lock()
        .map_err(|_| "Google OAuth state is unavailable.".to_string())?
        .insert(
            session_id.clone(),
            Arc::new(GoogleOAuthPendingSession {
                cancelled: AtomicBool::new(false),
                receiver: Mutex::new(receiver),
            }),
        );

    std::thread::spawn(move || {
        let payload = receive_google_oauth_callback(listener);
        let _ = sender.send(payload);
        focus_main_window(&app);
    });

    Ok(GoogleOAuthSession {
        session_id,
        redirect_uri: format!("http://127.0.0.1:{port}/"),
    })
}

#[tauri::command]
fn wait_for_google_oauth_callback(
    session_id: String,
    timeout_ms: Option<u64>,
    state: State<GoogleOAuthState>,
) -> Result<GoogleOAuthCallbackPayload, String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "Google OAuth state is unavailable.".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or("Google OAuth session not found.".to_string())?;

    let started_at = SystemTime::now();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(GOOGLE_OAUTH_DEFAULT_TIMEOUT_MS));

    loop {
        if session.cancelled.load(Ordering::Relaxed) {
            let _ = state
                .sessions
                .lock()
                .map_err(|_| "Google OAuth state is unavailable.".to_string())?
                .remove(&session_id);
            return Err("Google authorization cancelled.".to_string());
        }

        if started_at.elapsed().map_err(|e| e.to_string())? >= timeout {
            let _ = state
                .sessions
                .lock()
                .map_err(|_| "Google OAuth state is unavailable.".to_string())?
                .remove(&session_id);
            return Err("Timed out waiting for Google authorization.".to_string());
        }

        let callback = {
            let receiver = session
                .receiver
                .lock()
                .map_err(|_| "Google OAuth state is unavailable.".to_string())?;
            receiver.recv_timeout(Duration::from_millis(250))
        };

        match callback {
            Ok(payload) => {
                let _ = state
                    .sessions
                    .lock()
                    .map_err(|_| "Google OAuth state is unavailable.".to_string())?
                    .remove(&session_id);
                return Ok(payload);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = state
                    .sessions
                    .lock()
                    .map_err(|_| "Google OAuth state is unavailable.".to_string())?
                    .remove(&session_id);
                return Err(
                    "Google OAuth session ended before authorization completed.".to_string()
                );
            }
        }
    }
}

#[tauri::command]
fn cancel_google_oauth_callback(
    session_id: String,
    state: State<GoogleOAuthState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "Google OAuth state is unavailable.".to_string())?
        .remove(&session_id);

    if let Some(session) = session {
        session.cancelled.store(true, Ordering::Relaxed);
    }

    Ok(())
}

fn google_oauth_client_secret() -> Option<String> {
    env::var("GOOGLE_OAUTH_CLIENT_SECRET")
        .ok()
        .or_else(|| option_env!("GOOGLE_OAUTH_CLIENT_SECRET").map(ToOwned::to_owned))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn google_oauth_keyring_service() -> &'static str {
    if cfg!(debug_assertions) {
        GOOGLE_OAUTH_KEYRING_SERVICE_DEV
    } else {
        GOOGLE_OAUTH_KEYRING_SERVICE
    }
}

fn google_oauth_keyring_entry() -> Result<KeyringEntry, String> {
    KeyringEntry::new(google_oauth_keyring_service(), GOOGLE_OAUTH_KEYRING_ACCOUNT)
        .map_err(|e| format!("Could not access secure Google session storage: {e}"))
}

fn normalize_google_account_email(email: &str) -> Option<String> {
    let normalized = email.trim().to_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn build_google_stored_session(
    legacy_session: Option<GoogleOAuthLegacySessionInput>,
) -> Option<GoogleStoredSession> {
    let legacy = legacy_session?;
    let refresh_token = legacy.refresh_token.trim().to_string();
    if refresh_token.is_empty() {
        return None;
    }

    Some(GoogleStoredSession {
        access_token: legacy.access_token.trim().to_string(),
        access_token_expires_at_ms: legacy.access_token_expires_at_ms,
        refresh_token,
    })
}

fn load_google_stored_sessions(
) -> Result<(GoogleStoredSessions, Option<GoogleStoredSession>), String> {
    let entry = google_oauth_keyring_entry()?;
    match entry.get_password() {
        Ok(raw) => {
            if raw.trim().is_empty() {
                return Ok((HashMap::new(), None));
            }

            if let Ok(sessions) = serde_json::from_str::<GoogleStoredSessions>(&raw) {
                return Ok((sessions, None));
            }

            if let Ok(session) = serde_json::from_str::<GoogleStoredSession>(&raw) {
                return Ok((HashMap::new(), Some(session)));
            }

            Err("Could not read secure Google session storage.".to_string())
        }
        Err(KeyringError::NoEntry) => Ok((HashMap::new(), None)),
        Err(e) => Err(format!(
            "Could not access secure Google session storage: {e}"
        )),
    }
}

fn store_google_stored_sessions(sessions: &GoogleStoredSessions) -> Result<(), String> {
    let entry = google_oauth_keyring_entry()?;
    let payload = serde_json::to_string(sessions)
        .map_err(|e| format!("Could not serialize Google session: {e}"))?;
    entry
        .set_password(&payload)
        .map_err(|e| format!("Could not store Google session securely: {e}"))
}

fn clear_google_stored_session() -> Result<(), String> {
    let entry = google_oauth_keyring_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!(
            "Could not clear secure Google session storage: {e}"
        )),
    }
}

fn migrate_legacy_google_stored_session(
    sessions: &mut GoogleStoredSessions,
    legacy_keyring_session: Option<GoogleStoredSession>,
    legacy_account_email: Option<&str>,
    legacy_session: Option<GoogleOAuthLegacySessionInput>,
) -> bool {
    let Some(legacy_account_email) = legacy_account_email.and_then(normalize_google_account_email)
    else {
        return false;
    };
    if sessions.contains_key(&legacy_account_email) {
        return false;
    }

    let legacy_session =
        legacy_keyring_session.or_else(|| build_google_stored_session(legacy_session));
    let Some(legacy_session) = legacy_session else {
        return false;
    };
    sessions.insert(legacy_account_email, legacy_session);
    true
}

fn resolve_google_stored_session(
    sessions: &GoogleStoredSessions,
    account_email: &str,
    legacy_session: Option<GoogleOAuthLegacySessionInput>,
    legacy_account_email: Option<&str>,
) -> Result<Option<GoogleStoredSession>, String> {
    let Some(normalized_account_email) = normalize_google_account_email(account_email) else {
        return Ok(None);
    };

    if let Some(stored) = sessions.get(&normalized_account_email) {
        return Ok(Some(stored.clone()));
    }

    let legacy_account_email = legacy_account_email
        .and_then(normalize_google_account_email)
        .unwrap_or_default();
    if legacy_account_email == normalized_account_email {
        return Ok(build_google_stored_session(legacy_session));
    }

    Ok(None)
}

fn google_http_client() -> Result<HttpClient, String> {
    HttpClient::builder()
        .build()
        .map_err(|e| format!("Could not start Google OAuth client: {e}"))
}

fn async_http_client() -> Result<AsyncHttpClient, String> {
    AsyncHttpClient::builder()
        .build()
        .map_err(|e| format!("Could not start HTTP client: {e}"))
}

#[tauri::command]
async fn post_json(input: HttpJsonRequestInput) -> Result<HttpJsonResponse, String> {
    let url = input.url.trim();
    if url.is_empty() {
        return Err("Request URL is missing.".to_string());
    }

    let mut request = async_http_client()?.post(url);
    for (key, value) in input.headers {
        request = request.header(key, value);
    }

    let response = request
        .json(&input.body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Could not read HTTP response: {e}"))?;

    Ok(HttpJsonResponse { status, body })
}

#[tauri::command]
async fn stream_http(
    input: HttpStreamRequestInput,
    on_event: Channel<HttpStreamEvent>,
    state: State<'_, HttpStreamState>,
) -> Result<(), String> {
    let request_id = input.request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("Request ID is missing.".to_string());
    }

    let url = input.url.trim().to_string();
    if url.is_empty() {
        return Err("Request URL is missing.".to_string());
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    state
        .requests
        .lock()
        .map_err(|_| "Could not access HTTP stream state.".to_string())?
        .insert(request_id.clone(), cancel_flag.clone());

    let result = async {
        let method = Method::from_bytes(input.method.trim().as_bytes())
            .map_err(|e| format!("Unsupported HTTP method: {e}"))?;

        let mut request = async_http_client()?.request(method, url);
        for (key, value) in input.headers {
            request = request.header(key, value);
        }
        if let Some(body) = input.body {
            request = request.body(body);
        }

        let mut response = request
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {e}"))?;

        let headers = response
            .headers()
            .iter()
            .filter_map(|(key, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| [key.to_string(), value.to_string()])
            })
            .collect::<Vec<_>>();

        if on_event
            .send(HttpStreamEvent::Start {
                status: response.status().as_u16(),
                headers,
            })
            .is_err()
        {
            return Ok(());
        }

        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                return Ok(());
            }

            let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| format!("Could not read HTTP response stream: {e}"))?
            else {
                let _ = on_event.send(HttpStreamEvent::End);
                return Ok(());
            };

            if on_event
                .send(HttpStreamEvent::Chunk {
                    data: chunk.to_vec(),
                })
                .is_err()
            {
                return Ok(());
            }
        }
    }
    .await;

    state
        .requests
        .lock()
        .map_err(|_| "Could not access HTTP stream state.".to_string())?
        .remove(&request_id);

    if let Err(message) = result {
        let _ = on_event.send(HttpStreamEvent::Error { message });
    }

    Ok(())
}

#[tauri::command]
fn cancel_http_stream(request_id: String, state: State<'_, HttpStreamState>) -> Result<(), String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Ok(());
    }

    if let Some(cancel_flag) = state
        .requests
        .lock()
        .map_err(|_| "Could not access HTTP stream state.".to_string())?
        .get(request_id)
        .cloned()
    {
        cancel_flag.store(true, Ordering::Relaxed);
    }

    Ok(())
}

fn parse_google_error(response: HttpResponse) -> String {
    let payload = response.json::<Value>().unwrap_or(Value::Null);
    let error = payload
        .get("error")
        .and_then(|value| value.as_str())
        .unwrap_or("request_failed");
    let description = payload
        .get("error_description")
        .and_then(|value| value.as_str())
        .or_else(|| {
            payload
                .get("error")
                .and_then(|value| value.get("message"))
                .and_then(|value| value.as_str())
        })
        .unwrap_or_default();
    if description.is_empty() {
        format!("Google {error}.")
    } else {
        format!("Google {error}: {description}")
    }
}

fn exchange_google_token(
    client: &HttpClient,
    body: Vec<(String, String)>,
) -> Result<GoogleTokenResponse, String> {
    let response = client
        .post(GOOGLE_OAUTH_TOKEN_URL)
        .form(&body)
        .send()
        .map_err(|e| format!("Google token request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(parse_google_error(response));
    }

    response
        .json::<GoogleTokenResponse>()
        .map_err(|e| format!("Could not parse Google token response: {e}"))
}

fn fetch_google_user_email(client: &HttpClient, access_token: &str) -> Result<String, String> {
    let response = client
        .get(GOOGLE_OAUTH_USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .map_err(|e| format!("Google user info request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(parse_google_error(response));
    }

    let payload = response
        .json::<GoogleUserInfoResponse>()
        .map_err(|e| format!("Could not parse Google user info response: {e}"))?;
    payload
        .email
        .filter(|email| !email.trim().is_empty())
        .ok_or("Google did not return an email address.".to_string())
}

fn build_google_granted_scopes(
    scope_value: Option<String>,
    fallback_scopes: &[String],
) -> Vec<String> {
    let Some(scope_value) = scope_value else {
        return fallback_scopes.to_vec();
    };
    let normalized = scope_value
        .split(' ')
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(ToOwned::to_owned)
        .collect::<HashSet<_>>();

    if normalized.is_empty() {
        fallback_scopes.to_vec()
    } else {
        normalized.into_iter().collect()
    }
}

fn current_time_ms() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64)
}

fn access_token_expires_at_ms(expires_in: u64) -> Result<u64, String> {
    Ok(current_time_ms()? + (expires_in * 1000))
}

#[tauri::command]
fn complete_google_oauth(
    input: GoogleCompleteOAuthInput,
) -> Result<GoogleOAuthConnectionResult, String> {
    let client_id = input.client_id.trim();
    if client_id.is_empty() {
        return Err("Google sign-in is not configured yet.".to_string());
    }

    let mut body = vec![
        ("client_id".to_string(), client_id.to_string()),
        ("code".to_string(), input.code),
        ("code_verifier".to_string(), input.code_verifier),
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("redirect_uri".to_string(), input.redirect_uri),
    ];
    if let Some(client_secret) = google_oauth_client_secret() {
        body.push(("client_secret".to_string(), client_secret.to_string()));
    }

    let client = google_http_client()?;
    let token = exchange_google_token(&client, body)?;
    let access_token = token
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or("Google did not return an access token.".to_string())?;
    let expires_in = token
        .expires_in
        .ok_or("Google did not return an access token expiry.".to_string())?;
    let granted_scopes = build_google_granted_scopes(token.scope, &[]);
    let account_email = fetch_google_user_email(&client, &access_token)?;
    if let Some(expected_account_email) = input
        .expected_account_email
        .as_deref()
        .and_then(normalize_google_account_email)
    {
        let normalized_account_email = normalize_google_account_email(&account_email)
            .ok_or("Google did not return an email address.".to_string())?;
        if normalized_account_email != expected_account_email {
            return Err("Google connected a different account than expected.".to_string());
        }
    }

    let (mut sessions, legacy_keyring_session) = load_google_stored_sessions()?;
    let migrated_legacy = migrate_legacy_google_stored_session(
        &mut sessions,
        legacy_keyring_session,
        input.legacy_account_email.as_deref(),
        input.legacy_session,
    );
    let existing_session = resolve_google_stored_session(
        &sessions,
        &account_email,
        None,
        input.legacy_account_email.as_deref(),
    )?;
    let refresh_token = token
        .refresh_token
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            existing_session
                .as_ref()
                .map(|session| session.refresh_token.clone())
        })
        .ok_or(
            "Google did not return a refresh token. Reconnect Google and try again.".to_string(),
        )?;
    let access_token_expires_at_ms = access_token_expires_at_ms(expires_in)?;

    let Some(normalized_account_email) = normalize_google_account_email(&account_email) else {
        return Err("Google did not return an email address.".to_string());
    };
    sessions.insert(
        normalized_account_email,
        GoogleStoredSession {
            access_token,
            access_token_expires_at_ms,
            refresh_token,
        },
    );
    if migrated_legacy || !sessions.is_empty() {
        store_google_stored_sessions(&sessions)?;
    }

    Ok(GoogleOAuthConnectionResult {
        access_token_expires_at_ms,
        account_email,
        granted_scopes,
    })
}

#[tauri::command]
fn ensure_google_access_token(
    input: GoogleEnsureAccessTokenInput,
) -> Result<GoogleAccessTokenResult, String> {
    let client_id = input.client_id.trim();
    if client_id.is_empty() {
        return Err("Reconnect Google to refresh access.".to_string());
    }
    let account_email = input.account_email.trim();
    if account_email.is_empty() {
        return Err("Select a Google account to refresh access.".to_string());
    }

    let (mut sessions, legacy_keyring_session) = load_google_stored_sessions()?;
    let migrated_legacy = migrate_legacy_google_stored_session(
        &mut sessions,
        legacy_keyring_session,
        input.legacy_account_email.as_deref(),
        input.legacy_session,
    );
    if migrated_legacy {
        store_google_stored_sessions(&sessions)?;
    }

    let mut session = resolve_google_stored_session(
        &sessions,
        account_email,
        None,
        input.legacy_account_email.as_deref(),
    )?
    .ok_or("Reconnect Google to refresh access.".to_string())?;
    let now_ms = current_time_ms()?;
    if !session.access_token.trim().is_empty()
        && session.access_token_expires_at_ms > (now_ms + GOOGLE_OAUTH_ACCESS_TOKEN_BUFFER_MS)
    {
        return Ok(GoogleAccessTokenResult {
            account_email: account_email.to_string(),
            access_token: session.access_token,
            access_token_expires_at_ms: session.access_token_expires_at_ms,
            granted_scopes: input.granted_scopes,
        });
    }

    let mut body = vec![
        ("client_id".to_string(), client_id.to_string()),
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), session.refresh_token.clone()),
    ];
    if let Some(client_secret) = google_oauth_client_secret() {
        body.push(("client_secret".to_string(), client_secret.to_string()));
    }

    let client = google_http_client()?;
    let token = exchange_google_token(&client, body)?;
    session.access_token = token
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or("Google did not return an access token.".to_string())?;
    session.access_token_expires_at_ms = access_token_expires_at_ms(
        token
            .expires_in
            .ok_or("Google did not return an access token expiry.".to_string())?,
    )?;
    if let Some(refresh_token) = token.refresh_token.filter(|value| !value.trim().is_empty()) {
        session.refresh_token = refresh_token;
    }
    let normalized_account_email = normalize_google_account_email(account_email)
        .ok_or("Select a Google account to refresh access.".to_string())?;
    sessions.insert(normalized_account_email, session.clone());
    store_google_stored_sessions(&sessions)?;

    Ok(GoogleAccessTokenResult {
        account_email: account_email.to_string(),
        access_token: session.access_token,
        access_token_expires_at_ms: session.access_token_expires_at_ms,
        granted_scopes: build_google_granted_scopes(token.scope, &input.granted_scopes),
    })
}

#[tauri::command]
fn clear_google_oauth_session(account_email: String) -> Result<(), String> {
    let (mut sessions, legacy_keyring_session) = load_google_stored_sessions()?;
    let normalized_account_email = normalize_google_account_email(&account_email)
        .ok_or("Select a Google account to disconnect.".to_string())?;
    if sessions.remove(&normalized_account_email).is_some() {
        if sessions.is_empty() {
            return clear_google_stored_session();
        }
        return store_google_stored_sessions(&sessions);
    }
    if legacy_keyring_session.is_some() {
        return clear_google_stored_session();
    }
    Ok(())
}

#[tauri::command]
fn list_google_oauth_session_accounts() -> Result<Vec<String>, String> {
    let (sessions, _) = load_google_stored_sessions()?;
    let mut accounts = sessions.keys().cloned().collect::<Vec<_>>();
    accounts.sort();
    Ok(accounts)
}

#[cfg(target_os = "macos")]
fn run_osascript(lines: &[&str], args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("/usr/bin/osascript");
    for line in lines {
        command.arg("-e").arg(line);
    }
    if !args.is_empty() {
        command.arg("--");
        for arg in args {
            command.arg(arg);
        }
    }

    let output = command
        .output()
        .map_err(|e| format!("Could not run AppleScript: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "AppleScript failed.".to_string()
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
fn open_in_apple_mail(message_id: String) -> Result<bool, String> {
    let normalized = message_id.trim().to_string();
    if normalized.is_empty() {
        return Ok(false);
    }

    #[cfg(target_os = "macos")]
    {
        let result = run_osascript(
            &[
                "on run argv",
                "set targetMessageId to item 1 of argv",
                "tell application \"Mail\"",
                "set inboxMatches to (messages of inbox whose message id is targetMessageId)",
                "if (count of inboxMatches) > 0 then",
                "set targetMessage to item 1 of inboxMatches",
                "open targetMessage",
                "activate",
                "return \"opened\"",
                "end if",
                "repeat with mailboxRef in mailboxes",
                "set mailboxMatches to (messages of mailboxRef whose message id is targetMessageId)",
                "if (count of mailboxMatches) > 0 then",
                "set targetMessage to item 1 of mailboxMatches",
                "open targetMessage",
                "activate",
                "return \"opened\"",
                "end if",
                "end repeat",
                "end tell",
                "return \"missing\"",
                "end run",
            ],
            &[normalized.as_str()],
        )?;
        Ok(result == "opened")
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = normalized;
        Ok(false)
    }
}

#[tauri::command]
fn open_in_apple_calendar(event_uid: String) -> Result<bool, String> {
    let normalized = event_uid.trim().to_string();
    if normalized.is_empty() {
        return Ok(false);
    }

    #[cfg(target_os = "macos")]
    {
        let result = run_osascript(
            &[
                "on run argv",
                "set targetEventUid to item 1 of argv",
                "tell application \"Calendar\"",
                "repeat with calendarRef in calendars",
                "set eventMatches to (every event of calendarRef whose uid is targetEventUid)",
                "if (count of eventMatches) > 0 then",
                "set targetEvent to item 1 of eventMatches",
                "show targetEvent",
                "activate",
                "return \"opened\"",
                "end if",
                "end repeat",
                "end tell",
                "return \"missing\"",
                "end run",
            ],
            &[normalized.as_str()],
        )?;
        Ok(result == "opened")
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = normalized;
        Ok(false)
    }
}

#[tauri::command]
fn show_path_in_folder(path: String) -> Result<(), String> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err("Path is required.".to_string());
    }

    let target = PathBuf::from(normalized);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", target.display()));
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&target)
            .status()
            .map_err(|e| format!("Could not show item in Finder: {e}"))?;
        if !status.success() {
            return Err("Finder failed to show the item.".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("explorer.exe")
            .arg(format!("/select,{}", target.display()))
            .status()
            .map_err(|e| format!("Could not show item in File Explorer: {e}"))?;
        if !status.success() {
            return Err("File Explorer failed to show the item.".to_string());
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = target
            .parent()
            .ok_or("Path does not have a parent directory.".to_string())?;
        let status = Command::new("xdg-open")
            .arg(parent)
            .status()
            .map_err(|e| format!("Could not open parent directory: {e}"))?;
        if !status.success() {
            return Err("The file manager failed to open the parent directory.".to_string());
        }
    }

    Ok(())
}

#[tauri::command]
fn run_ai_tool(
    command: String,
    argv: Vec<String>,
    stdin: Option<String>,
) -> Result<philo_tools::ToolCommandOutput, String> {
    if command == "philo" {
        philo_tools::run_sidecar_philo(&argv, stdin)
    } else {
        philo_tools::run_tool_command(philo_tools::ToolCommand::SafeShell {
            command,
            args: argv,
        })
    }
}

#[tauri::command]
fn build_unified_diff(before: String, after: String) -> Result<String, String> {
    Ok(philo_tools::build_unified_diff(&before, &after))
}

fn should_skip_dir(name: &str) -> bool {
    if name.starts_with('.') && name != ".obsidian" {
        return true;
    }
    matches!(
        name,
        "Library"
            | "Applications"
            | "Movies"
            | "Pictures"
            | "Music"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianSettingsDetection {
    daily_logs_folder: String,
    excalidraw_folder: String,
    assets_folder: String,
    filename_pattern: String,
}

fn read_json_file(path: &PathBuf) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

const SHARED_SCHEMA_VERSION: u32 = 1;
const SHARED_METADATA_TABLE: &str = "philo_component_metadata";
const WIDGET_STORAGE_SCHEMA_VERSION: u32 = 1;
const WIDGET_METADATA_TABLE: &str = "philo_widget_metadata";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedComponentManifest {
    id: String,
    title: String,
    description: String,
    prompt: String,
    #[serde(default)]
    favorite: bool,
    created_at: String,
    updated_at: String,
    ui_spec: Value,
    storage_kind: String,
    storage_schema: SharedStorageSchema,
    schema_version: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SharedStorageSchema {
    tables: Vec<SharedStorageTable>,
    named_queries: Vec<SharedStorageQuery>,
    named_mutations: Vec<SharedStorageMutation>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SharedStorageTable {
    name: String,
    columns: Vec<SharedStorageColumn>,
    indexes: Option<Vec<SharedStorageIndex>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SharedStorageColumn {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    not_null: bool,
    #[serde(default)]
    primary_key: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SharedStorageIndex {
    name: String,
    columns: Vec<String>,
    #[serde(default)]
    unique: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SharedStorageQuery {
    name: String,
    table: String,
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default)]
    filters: Vec<SharedStorageFilter>,
    #[serde(default)]
    order_by: Option<String>,
    #[serde(default)]
    order_desc: bool,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SharedStorageMutation {
    name: String,
    table: String,
    kind: String,
    #[serde(default)]
    set_columns: Vec<String>,
    #[serde(default)]
    filters: Vec<SharedStorageFilter>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SharedStorageFilter {
    column: String,
    #[serde(default = "default_filter_operator")]
    operator: String,
    parameter: String,
}

fn default_filter_operator() -> String {
    "eq".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSharedComponentInput {
    library_dir: String,
    id: String,
    title: String,
    description: String,
    prompt: String,
    #[serde(default)]
    favorite: bool,
    ui_spec: Value,
    storage_schema: SharedStorageSchema,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSharedComponentInput {
    library_dir: String,
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    favorite: Option<bool>,
    #[serde(default)]
    ui_spec: Option<Value>,
    #[serde(default)]
    storage_schema: Option<SharedStorageSchema>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedQueryInput {
    library_dir: String,
    component_id: String,
    query_name: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedMutationInput {
    library_dir: String,
    component_id: String,
    mutation_name: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WidgetStorageInput {
    widget_path: String,
    widget_id: String,
    storage_schema: SharedStorageSchema,
    schema_version: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WidgetQueryInput {
    widget_path: String,
    widget_id: String,
    storage_schema: SharedStorageSchema,
    schema_version: u32,
    query_name: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WidgetMutationInput {
    widget_path: String,
    widget_id: String,
    storage_schema: SharedStorageSchema,
    schema_version: u32,
    mutation_name: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedMutationResult {
    changed_rows: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedQueryResult {
    rows: Vec<Value>,
}

fn now_timestamp() -> String {
    match std::time::SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("{}.{:03}Z", duration.as_secs(), duration.subsec_millis()),
        Err(_) => "1970-01-01T00:00:00.000Z".to_string(),
    }
}

fn get_string(value: &Value, key: &str) -> Option<String> {
    let text = value.get(key)?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn map_obsidian_date_format_to_filename_pattern(format: &str) -> String {
    let mut cleaned = String::new();
    let mut bracket_depth = 0;
    for ch in format.trim().chars() {
        if ch == '[' {
            bracket_depth += 1;
            continue;
        }
        if ch == ']' {
            bracket_depth = (bracket_depth - 1).max(0);
            continue;
        }
        if bracket_depth >= 0 {
            cleaned.push(ch);
        }
    }

    if cleaned.trim().is_empty() {
        return String::new();
    }

    let chars: Vec<char> = cleaned.chars().collect();
    let mut output = String::new();
    let mut i = 0;
    let mut seen_year = false;
    let mut seen_month = false;
    let mut seen_day = false;

    while i < chars.len() {
        let ch = chars[i];
        let is_token_char = matches!(ch, 'Y' | 'y' | 'M' | 'D' | 'd');
        if !is_token_char {
            output.push(ch);
            i += 1;
            continue;
        }

        let mut j = i + 1;
        while j < chars.len() && chars[j] == ch {
            j += 1;
        }
        let token: String = chars[i..j].iter().collect();
        match token.as_str() {
            "YYYY" | "yyyy" => {
                output.push_str("{YYYY}");
                seen_year = true;
            }
            "MM" => {
                output.push_str("{MM}");
                seen_month = true;
            }
            "DD" | "dd" => {
                output.push_str("{DD}");
                seen_day = true;
            }
            _ => {
                return String::new();
            }
        }
        i = j;
    }

    if seen_year && seen_month && seen_day {
        output
    } else {
        String::new()
    }
}

fn contains_case_insensitive(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

fn ensure_folder_in_vault(vault_dir: &Path, folder: &str) -> Result<(), String> {
    let normalized = normalize_folder(folder);
    if normalized.is_empty() || normalized == "." {
        return Ok(());
    }
    fs::create_dir_all(vault_dir.join(normalized)).map_err(|e| e.to_string())
}

fn write_json_file(path: &Path, value: Value) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(path, serialized).map_err(|e| e.to_string())
}

fn is_valid_identifier(input: &str) -> bool {
    !input.is_empty()
        && input
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn is_valid_table_name(name: &str) -> bool {
    is_valid_identifier(name)
}

fn is_valid_column_name(name: &str) -> bool {
    is_valid_identifier(name)
}

fn is_valid_component_id(name: &str) -> bool {
    is_valid_identifier(name)
}

fn resolve_component_dir(library_dir: &str, component_id: &str) -> Result<PathBuf, String> {
    if !is_valid_component_id(component_id) {
        return Err("Invalid component id.".to_string());
    }
    let trimmed = library_dir.trim();
    if trimmed.is_empty() {
        return Err("libraryDir is required.".to_string());
    }
    let dir = PathBuf::from(trimmed).join(component_id);
    if !dir.is_absolute() {
        return Err("libraryDir must be an absolute path.".to_string());
    }
    Ok(dir)
}

fn manifest_path(library_dir: &str, component_id: &str) -> Result<PathBuf, String> {
    Ok(resolve_component_dir(library_dir, component_id)?.join("manifest.json"))
}

fn component_db_path(library_dir: &str, component_id: &str) -> Result<PathBuf, String> {
    Ok(resolve_component_dir(library_dir, component_id)?.join("component.sqlite3"))
}

fn storage_table_name() -> &'static str {
    SHARED_METADATA_TABLE
}

fn widget_storage_table_name() -> &'static str {
    WIDGET_METADATA_TABLE
}

fn widget_db_path(widget_path: &str) -> Result<PathBuf, String> {
    let trimmed = widget_path.trim();
    if trimmed.is_empty() {
        return Err("widgetPath is required.".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("widgetPath must be an absolute path.".to_string());
    }

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "widgetPath must point to a file.".to_string())?;
    let db_name = if let Some(stem) = file_name.strip_suffix(".widget.md") {
        format!("{stem}.widget.sqlite3")
    } else {
        format!("{file_name}.sqlite3")
    };
    Ok(path.with_file_name(db_name))
}

fn canonicalize_component_storage_type(raw: &str) -> Option<&'static str> {
    match raw.to_lowercase().as_str() {
        "text" | "string" => Some("TEXT"),
        "integer" | "int" | "boolean" | "bool" | "tinyint" => Some("INTEGER"),
        "real" | "float" | "double" => Some("REAL"),
        "blob" | "bytes" => Some("BLOB"),
        _ => None,
    }
}

fn quoted_identifier(value: &str) -> String {
    format!("\"{value}\"")
}

fn valid_filter_operator(raw: &str) -> Option<&'static str> {
    match raw.to_lowercase().as_str() {
        "eq" => Some("="),
        "neq" => Some("!="),
        "lt" => Some("<"),
        "lte" => Some("<="),
        "gt" => Some(">"),
        "gte" => Some(">="),
        _ => None,
    }
}

fn validate_storage_schema(schema: &SharedStorageSchema) -> Result<(), String> {
    let mut table_names = std::collections::HashSet::new();
    for table in &schema.tables {
        if !is_valid_table_name(&table.name) {
            return Err(format!("Invalid table name: {}", table.name));
        }
        if !table_names.insert(table.name.clone()) {
            return Err(format!("Duplicate table name: {}", table.name));
        }
        if table.columns.is_empty() {
            return Err(format!(
                "Table {} must have at least one column.",
                table.name
            ));
        }
        let mut column_names = std::collections::HashSet::new();
        for column in &table.columns {
            if !is_valid_column_name(&column.name) {
                return Err(format!(
                    "Invalid column name '{}' in table '{}'.",
                    column.name, table.name,
                ));
            }
            if !column_names.insert(column.name.clone()) {
                return Err(format!(
                    "Duplicate column '{}' in table '{}'.",
                    column.name, table.name,
                ));
            }
            if canonicalize_component_storage_type(&column.kind).is_none() {
                return Err(format!(
                    "Unsupported column type '{}' in table '{}'.",
                    column.kind, table.name,
                ));
            }
        }
        if let Some(indexes) = &table.indexes {
            for index in indexes {
                if !is_valid_identifier(&index.name) {
                    return Err(format!(
                        "Invalid index name '{}' in table '{}'.",
                        index.name, table.name
                    ));
                }
                if index.columns.is_empty() {
                    return Err(format!(
                        "Index '{}' in table '{}' must include at least one column.",
                        index.name, table.name
                    ));
                }
                for column in &index.columns {
                    if !is_valid_column_name(column) {
                        return Err(format!(
                            "Invalid index column '{}' for table '{}'.",
                            column, table.name
                        ));
                    }
                    if !column_names.contains(column) {
                        return Err(format!(
                            "Index '{}' references missing column '{}' in table '{}'.",
                            index.name, column, table.name,
                        ));
                    }
                }
            }
        }
    }

    let mut table_columns = HashMap::new();
    for table in &schema.tables {
        let mut columns = HashSet::new();
        for column in &table.columns {
            columns.insert(column.name.clone());
        }
        table_columns.insert(table.name.clone(), columns);
    }

    let named_queries: HashMap<&str, &SharedStorageQuery> = schema
        .named_queries
        .iter()
        .map(|query| (query.name.as_str(), query))
        .collect();
    for (name, query) in named_queries {
        if !is_valid_identifier(name) {
            return Err(format!("Invalid query name: {name}"));
        }
        if query.table.is_empty() || !is_valid_table_name(&query.table) {
            return Err(format!(
                "Query '{name}' has invalid table '{}'.",
                query.table
            ));
        }
        let valid_columns = table_columns
            .get(&query.table)
            .ok_or_else(|| format!("Query '{name}' references unknown table '{}'.", query.table))?;
        for column in &query.columns {
            if !valid_columns.contains(column) && column != "*" {
                return Err(format!(
                    "Query '{name}' references unknown column '{column}' on table '{}'.",
                    query.table
                ));
            }
        }
        if let Some(order_by) = &query.order_by {
            if !is_valid_column_name(order_by) {
                return Err(format!(
                    "Query '{name}' has invalid orderBy '{}'.",
                    order_by
                ));
            }
            if !valid_columns.contains(order_by) {
                return Err(format!(
                    "Query '{name}' orders by unknown column '{order_by}'."
                ));
            }
        }
        for filter in &query.filters {
            if !valid_columns.contains(&filter.column) {
                return Err(format!(
                    "Query '{name}' filters on unknown column '{}'.",
                    filter.column,
                ));
            }
            if !is_valid_identifier(&filter.parameter) {
                return Err(format!(
                    "Query '{name}' has invalid parameter '{}'.",
                    filter.parameter,
                ));
            }
            if valid_filter_operator(&filter.operator).is_none() {
                return Err(format!(
                    "Query '{name}' uses unsupported operator '{}'.",
                    filter.operator,
                ));
            }
        }
    }

    let mut query_names = HashSet::new();
    for query in &schema.named_queries {
        if !query_names.insert(query.name.clone()) {
            return Err(format!("Duplicate query name '{}'.", query.name));
        }
    }

    let mut mutation_names = HashSet::new();
    for mutation in &schema.named_mutations {
        if !mutation_names.insert(mutation.name.clone()) {
            return Err(format!("Duplicate mutation name '{}'.", mutation.name));
        }
        if !is_valid_identifier(&mutation.kind) {
            return Err(format!("Mutation '{}' has invalid kind.", mutation.name));
        }
        let kind = mutation.kind.to_lowercase();
        if !matches!(kind.as_str(), "insert" | "update" | "delete") {
            return Err(format!(
                "Mutation '{}' has unsupported kind '{}'.",
                mutation.name, mutation.kind
            ));
        }
        let valid_columns = table_columns.get(&mutation.table).ok_or_else(|| {
            format!(
                "Mutation '{}' references unknown table '{}'.",
                mutation.name, mutation.table
            )
        })?;
        for filter in &mutation.filters {
            if !valid_columns.contains(&filter.column) {
                return Err(format!(
                    "Mutation '{}' filters on unknown column '{}'.",
                    mutation.name, filter.column,
                ));
            }
            if !is_valid_identifier(&filter.parameter) {
                return Err(format!(
                    "Mutation '{}' has invalid parameter '{}'.",
                    mutation.name, filter.parameter,
                ));
            }
            if valid_filter_operator(&filter.operator).is_none() {
                return Err(format!(
                    "Mutation '{}' uses unsupported operator '{}'.",
                    mutation.name, filter.operator,
                ));
            }
        }
        for column in &mutation.set_columns {
            if !valid_columns.contains(column) {
                return Err(format!(
                    "Mutation '{}' sets unknown column '{}'.",
                    mutation.name, column,
                ));
            }
        }
        if kind == "update" && mutation.set_columns.is_empty() {
            return Err(format!(
                "Update mutation '{}' needs at least one set column.",
                mutation.name
            ));
        }
        if kind == "delete" && mutation.filters.is_empty() {
            return Err(format!(
                "Delete mutation '{}' needs filters.",
                mutation.name
            ));
        }
        if kind == "insert" && mutation.set_columns.is_empty() {
            return Err(format!(
                "Insert mutation '{}' needs set columns.",
                mutation.name
            ));
        }
    }

    Ok(())
}

fn build_component_directory(dir: &str, id: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(dir);
    if !root.is_absolute() {
        return Err("libraryDir must be an absolute path.".to_string());
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.join(id))
}

fn read_params_as_object(value: &Value) -> Result<HashMap<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "params must be an object.".to_string())?;
    Ok(object.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

fn to_sql_value(value: &Value) -> Result<rusqlite::types::Value, String> {
    match value {
        Value::Null => Ok(rusqlite::types::Value::Null),
        Value::Bool(v) => Ok(rusqlite::types::Value::Integer(if *v { 1 } else { 0 })),
        Value::Number(v) => {
            if let Some(int) = v.as_i64() {
                Ok(rusqlite::types::Value::Integer(int))
            } else if let Some(float) = v.as_f64() {
                Ok(rusqlite::types::Value::Real(float))
            } else {
                Err("Invalid numeric value.".to_string())
            }
        }
        Value::String(value) => Ok(rusqlite::types::Value::Text(value.clone())),
        Value::Array(_) | Value::Object(_) => Ok(rusqlite::types::Value::Text(value.to_string())),
    }
}

fn row_to_json(row: &rusqlite::Row<'_>, names: &[String]) -> Value {
    let mut object = serde_json::Map::new();
    for (i, name) in names.iter().enumerate() {
        let value = match row.get_ref(i) {
            Ok(rusqlite::types::ValueRef::Null) => Value::Null,
            Ok(rusqlite::types::ValueRef::Integer(v)) => Value::from(v),
            Ok(rusqlite::types::ValueRef::Real(v)) => Value::from(v),
            Ok(rusqlite::types::ValueRef::Text(v)) => match std::str::from_utf8(v) {
                Ok(text) => Value::String(text.to_string()),
                Err(_) => Value::String("".to_string()),
            },
            Ok(rusqlite::types::ValueRef::Blob(v)) => Value::String(format!("{:x?}", v)),
            Err(_) => Value::Null,
        };
        object.insert(name.clone(), value);
    }
    Value::Object(object)
}

fn build_named_select(schema: &SharedStorageSchema, query_name: &str) -> Result<String, String> {
    let named_query = schema
        .named_queries
        .iter()
        .find(|q| q.name == query_name)
        .ok_or_else(|| format!("Unknown query '{query_name}'.",))?;
    if named_query.columns.is_empty() {
        return Err(format!("Query '{query_name}' has no columns.",));
    }
    let select_expr = if named_query.columns.len() == 1 && named_query.columns[0] == "*" {
        "*".to_string()
    } else {
        named_query
            .columns
            .iter()
            .map(|column| quoted_identifier(column))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let mut sql = format!(
        "SELECT {select_expr} FROM {} WHERE 1=1",
        quoted_identifier(&named_query.table),
    );
    for filter in &named_query.filters {
        let op = valid_filter_operator(&filter.operator).ok_or_else(|| {
            format!(
                "Query '{query_name}' uses unsupported operator '{}'.",
                filter.operator
            )
        })?;
        sql.push_str(&format!(
            " AND {} {} ?",
            quoted_identifier(&filter.column),
            op,
        ));
    }
    if let Some(order_by) = &named_query.order_by {
        sql.push_str(&format!(
            " ORDER BY {} {}",
            quoted_identifier(order_by),
            if named_query.order_desc {
                "DESC"
            } else {
                "ASC"
            }
        ));
    }
    if let Some(limit) = named_query.limit {
        sql.push_str(&format!(" LIMIT {limit}"));
    }
    Ok(sql)
}

fn build_named_mutation(
    schema: &SharedStorageSchema,
    mutation_name: &str,
) -> Result<(String, SharedStorageMutation), String> {
    let mutation = schema
        .named_mutations
        .iter()
        .find(|m| m.name == mutation_name)
        .ok_or_else(|| format!("Unknown mutation '{mutation_name}'.",))?;
    let kind = mutation.kind.to_lowercase();
    let table = quoted_identifier(&mutation.table);
    let sql = match kind.as_str() {
        "insert" => {
            let set_columns = mutation
                .set_columns
                .iter()
                .map(|column| quoted_identifier(column))
                .collect::<Vec<_>>()
                .join(", ");
            let placeholders = mutation
                .set_columns
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {table} ({set_columns}) VALUES ({placeholders})")
        }
        "update" => {
            let set_columns = mutation
                .set_columns
                .iter()
                .map(|column| format!("{} = ?", quoted_identifier(column)))
                .collect::<Vec<_>>()
                .join(", ");
            let mut filter_expr = String::new();
            for filter in &mutation.filters {
                let op = valid_filter_operator(&filter.operator).ok_or_else(|| {
                    format!(
                        "Mutation '{}' uses unsupported operator '{}'.",
                        mutation.name, filter.operator,
                    )
                })?;
                filter_expr.push_str(&format!(
                    " AND {} {} ?",
                    quoted_identifier(&filter.column),
                    op,
                ));
            }
            format!("UPDATE {table} SET {set_columns} WHERE 1=1{filter_expr}")
        }
        "delete" => {
            let mut filter_expr = String::new();
            for filter in &mutation.filters {
                let op = valid_filter_operator(&filter.operator).ok_or_else(|| {
                    format!(
                        "Mutation '{}' uses unsupported operator '{}'.",
                        mutation.name, filter.operator,
                    )
                })?;
                filter_expr.push_str(&format!(
                    " AND {} {} ?",
                    quoted_identifier(&filter.column),
                    op,
                ));
            }
            format!("DELETE FROM {table} WHERE 1=1{filter_expr}")
        }
        _ => return Err(format!("Unsupported mutation kind '{}'.", mutation.kind)),
    };
    Ok((sql, mutation.clone()))
}

fn list_directory_dirs(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut entries = Vec::new();
    let read = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            entries.push(entry.path());
        }
    }
    Ok(entries)
}

fn write_manifest(path: &Path, manifest: &SharedComponentManifest) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(path, serialized).map_err(|e| e.to_string())
}

fn read_manifest(path: &Path) -> Option<SharedComponentManifest> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<SharedComponentManifest>(&raw).ok()
}

fn verify_storage_metadata(
    conn: &Connection,
    owner_id: &str,
    schema_version: u32,
    metadata_table: &str,
    id_column: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {id_column}, schema_version FROM {metadata_table}"
        ))
        .map_err(|e| e.to_string())?;
    let row = stmt
        .query_row(params![], |row| {
            let stored_owner_id: String = row.get(0)?;
            let stored_schema_version: u32 = row.get(1)?;
            Ok((stored_owner_id, stored_schema_version))
        })
        .map_err(|e| e.to_string())?;
    if row.0 != owner_id {
        return Err("Storage owner mismatch.".to_string());
    }
    if row.1 != schema_version {
        return Err("Storage schema version mismatch.".to_string());
    }
    Ok(())
}

fn initialize_storage_db(
    path: &Path,
    owner_id: &str,
    schema_version: u32,
    schema: &SharedStorageSchema,
    metadata_table: &str,
    id_column: &str,
) -> Result<(), String> {
    let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("PRAGMA foreign_keys = ON;", params![])
        .map_err(|e| e.to_string())?;
    for table in &schema.tables {
        let mut columns = Vec::new();
        for column in &table.columns {
            let typ = canonicalize_component_storage_type(&column.kind).ok_or_else(|| {
                format!(
                    "Unsupported type '{}' for column '{}'.",
                    column.kind, column.name
                )
            })?;
            let nullable = if column.not_null { " NOT NULL" } else { "" };
            let primary = if column.primary_key {
                " PRIMARY KEY"
            } else {
                ""
            };
            columns.push(format!(
                "{} {}{}{}",
                quoted_identifier(&column.name),
                typ,
                primary,
                nullable
            ));
        }
        let sql = format!(
            "CREATE TABLE {} ({})",
            quoted_identifier(&table.name),
            columns.join(", "),
        );
        tx.execute(&sql, params![]).map_err(|e| e.to_string())?;

        if let Some(indexes) = &table.indexes {
            for index in indexes {
                let unique = if index.unique { "UNIQUE " } else { "" };
                let index_columns = index
                    .columns
                    .iter()
                    .map(|c| quoted_identifier(c))
                    .collect::<Vec<_>>()
                    .join(", ");
                let create_index_sql = format!(
                    "CREATE {unique}INDEX {} ON {} ({index_columns})",
                    quoted_identifier(&index.name),
                    quoted_identifier(&table.name),
                );
                tx.execute(&create_index_sql, params![])
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    let metadata_sql = format!(
        "CREATE TABLE {metadata_table} ({id_column} TEXT PRIMARY KEY, schema_version INTEGER NOT NULL)"
    );
    tx.execute(&metadata_sql, params![])
        .map_err(|e| e.to_string())?;
    tx.execute(
        &format!("INSERT INTO {metadata_table} ({id_column}, schema_version) VALUES (?1, ?2)"),
        params![owner_id, schema_version as i64],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn verify_component_metadata(
    conn: &Connection,
    component_id: &str,
    schema_version: u32,
) -> Result<(), String> {
    verify_storage_metadata(
        conn,
        component_id,
        schema_version,
        storage_table_name(),
        "component_id",
    )
}

fn verify_widget_metadata(
    conn: &Connection,
    widget_id: &str,
    schema_version: u32,
) -> Result<(), String> {
    verify_storage_metadata(
        conn,
        widget_id,
        schema_version,
        widget_storage_table_name(),
        "widget_id",
    )
}

fn initialize_component_db(path: &Path, manifest: &SharedComponentManifest) -> Result<(), String> {
    initialize_storage_db(
        path,
        &manifest.id,
        manifest.schema_version,
        &manifest.storage_schema,
        storage_table_name(),
        "component_id",
    )
}

fn initialize_widget_db(
    path: &Path,
    widget_id: &str,
    storage_schema: &SharedStorageSchema,
) -> Result<(), String> {
    initialize_storage_db(
        path,
        widget_id,
        WIDGET_STORAGE_SCHEMA_VERSION,
        storage_schema,
        widget_storage_table_name(),
        "widget_id",
    )
}

fn ensure_widget_storage_ready(input: &WidgetStorageInput) -> Result<PathBuf, String> {
    if input.schema_version != WIDGET_STORAGE_SCHEMA_VERSION {
        return Err("Unsupported widget storage schema version.".to_string());
    }

    validate_storage_schema(&input.storage_schema)?;
    let db_path = widget_db_path(&input.widget_path)?;
    if db_path.exists() {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        verify_widget_metadata(&conn, &input.widget_id, input.schema_version)?;
        return Ok(db_path);
    }

    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    initialize_widget_db(&db_path, &input.widget_id, &input.storage_schema)?;
    Ok(db_path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownSearchResult {
    path: String,
    relative_path: String,
    title: String,
    snippet: String,
}

fn truncate_chars(input: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let mut chars = input.chars();
    let taken: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{taken}...")
    } else {
        taken
    }
}

fn extract_markdown_title(path: &Path, content: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('#') {
            continue;
        }
        let heading = trimmed.trim_start_matches('#').trim();
        if !heading.is_empty() {
            return truncate_chars(heading, 80);
        }
    }
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| truncate_chars(stem, 80))
        .unwrap_or_else(|| "Untitled".to_string())
}

fn should_skip_search_dir(name: &str) -> bool {
    should_skip_dir(name) || name == ".obsidian"
}

fn normalize_mtime(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn ensure_search_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS search_docs (
            path TEXT PRIMARY KEY,
            root_dir TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            mtime INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_search_docs_root_dir ON search_docs(root_dir);
        CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_fts USING fts5(
            path UNINDEXED,
            relative_path,
            title,
            content,
            content='search_docs',
            content_rowid='rowid',
            tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
            INSERT INTO search_docs_fts(rowid, path, relative_path, title, content)
            VALUES (new.rowid, new.path, new.relative_path, new.title, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
            INSERT INTO search_docs_fts(search_docs_fts, rowid, path, relative_path, title, content)
            VALUES ('delete', old.rowid, old.path, old.relative_path, old.title, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
            INSERT INTO search_docs_fts(search_docs_fts, rowid, path, relative_path, title, content)
            VALUES ('delete', old.rowid, old.path, old.relative_path, old.title, old.content);
            INSERT INTO search_docs_fts(rowid, path, relative_path, title, content)
            VALUES (new.rowid, new.path, new.relative_path, new.title, new.content);
        END;
        "#,
    )
    .map_err(|e| e.to_string())
}

fn build_fts_query(query: &str) -> Option<String> {
    let parts: Vec<String> = query
        .split_whitespace()
        .map(|part| {
            part.chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
        })
        .filter(|part| !part.is_empty())
        .map(|part| format!("{part}*"))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" AND "))
    }
}

fn ensure_search_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    Ok(app_data_dir.join("search-index.sqlite3"))
}

fn refresh_markdown_index(conn: &mut Connection, root: &Path) -> Result<(), String> {
    let root_key = root.to_string_lossy().to_string();
    let mut existing: HashMap<String, i64> = HashMap::new();

    {
        let mut stmt = conn
            .prepare("SELECT path, mtime FROM search_docs WHERE root_dir = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![&root_key]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let path: String = row.get(0).map_err(|e| e.to_string())?;
            let mtime: i64 = row.get(1).map_err(|e| e.to_string())?;
            existing.insert(path, mtime);
        }
    }

    let mut seen_paths: HashSet<String> = HashSet::new();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries {
            let entry = match entry {
                Ok(value) => value,
                Err(_) => continue,
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(value) => value,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();

            if file_type.is_dir() {
                if should_skip_search_dir(&name) {
                    continue;
                }
                stack.push(path);
                continue;
            }

            if !file_type.is_file() {
                continue;
            }
            if !path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
            {
                continue;
            }

            let absolute_path = path.to_string_lossy().to_string();
            seen_paths.insert(absolute_path.clone());
            let mtime = normalize_mtime(&path);

            if existing.get(&absolute_path) == Some(&mtime) {
                continue;
            }

            let content = match fs::read_to_string(&path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let relative_path = path
                .strip_prefix(root)
                .ok()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| absolute_path.clone());
            let title = extract_markdown_title(&path, &content);

            tx.execute(
                r#"
                INSERT INTO search_docs(path, root_dir, relative_path, title, content, mtime)
                VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(path) DO UPDATE SET
                    root_dir = excluded.root_dir,
                    relative_path = excluded.relative_path,
                    title = excluded.title,
                    content = excluded.content,
                    mtime = excluded.mtime
                "#,
                params![
                    absolute_path,
                    &root_key,
                    relative_path,
                    title,
                    content,
                    mtime
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    for stale_path in existing.keys().filter(|path| !seen_paths.contains(*path)) {
        tx.execute(
            "DELETE FROM search_docs WHERE path = ?1 AND root_dir = ?2",
            params![stale_path, &root_key],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn search_markdown_files(
    app: AppHandle,
    root_dir: String,
    query: String,
    limit: Option<u16>,
) -> Result<Vec<MarkdownSearchResult>, String> {
    let normalized_root = root_dir.trim();
    if normalized_root.is_empty() {
        return Ok(Vec::new());
    }

    let normalized_query = query.trim();
    if normalized_query.is_empty() {
        return Ok(Vec::new());
    }
    let Some(fts_query) = build_fts_query(normalized_query) else {
        return Ok(Vec::new());
    };

    let root_path = PathBuf::from(normalized_root);
    if !root_path.exists() || !root_path.is_dir() {
        return Ok(Vec::new());
    }
    let root = fs::canonicalize(&root_path).map_err(|e| e.to_string())?;
    let root_key = root.to_string_lossy().to_string();

    let clamped_limit = limit.unwrap_or(80).clamp(1, 500) as usize;
    let search_db = ensure_search_db_path(&app)?;
    let mut conn = Connection::open(search_db).map_err(|e| e.to_string())?;
    ensure_search_schema(&conn)?;
    refresh_markdown_index(&mut conn, &root)?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                search_docs.path,
                search_docs.relative_path,
                search_docs.title,
                snippet(search_docs_fts, 3, '[', ']', ' ... ', 16)
            FROM search_docs_fts
            JOIN search_docs ON search_docs_fts.rowid = search_docs.rowid
            WHERE search_docs.root_dir = ?1 AND search_docs_fts MATCH ?2
            ORDER BY bm25(search_docs_fts, 0.2, 0.4, 3.0, 1.0)
            LIMIT ?3
            "#,
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![root_key, fts_query, clamped_limit as i64], |row| {
            Ok(MarkdownSearchResult {
                path: row.get(0)?,
                relative_path: row.get(1)?,
                title: row.get(2)?,
                snippet: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for result in rows {
        results.push(result.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

#[tauri::command]
fn create_shared_component(
    input: CreateSharedComponentInput,
) -> Result<SharedComponentManifest, String> {
    if input.title.trim().is_empty() {
        return Err("title is required.".to_string());
    }
    if input.prompt.trim().is_empty() {
        return Err("prompt is required.".to_string());
    }
    if !is_valid_component_id(&input.id) {
        return Err("Invalid component id.".to_string());
    }
    validate_storage_schema(&input.storage_schema)?;

    let schema_version = SHARED_SCHEMA_VERSION;
    let component_dir = build_component_directory(&input.library_dir, &input.id)?;
    let manifest_file = component_dir.join("manifest.json");
    let db_file = component_dir.join("component.sqlite3");
    if manifest_file.exists() || db_file.exists() || component_dir.exists() {
        return Err("A component with this id already exists.".to_string());
    }
    fs::create_dir_all(&component_dir).map_err(|e| e.to_string())?;

    let now = now_timestamp();
    let manifest = SharedComponentManifest {
        id: input.id.clone(),
        title: input.title,
        description: input.description,
        prompt: input.prompt,
        favorite: input.favorite,
        created_at: now.clone(),
        updated_at: now,
        ui_spec: input.ui_spec,
        storage_kind: "sqlite".to_string(),
        storage_schema: input.storage_schema,
        schema_version,
    };

    if let Err(err) = initialize_component_db(&db_file, &manifest) {
        let _ = fs::remove_dir_all(&component_dir);
        return Err(err);
    }
    if let Err(err) = write_manifest(&manifest_file, &manifest) {
        let _ = fs::remove_dir_all(&component_dir);
        return Err(err);
    }
    Ok(manifest)
}

#[tauri::command]
fn list_shared_components(library_dir: String) -> Result<Vec<SharedComponentManifest>, String> {
    let root = PathBuf::from(library_dir.trim());
    if !root.is_absolute() {
        return Err("libraryDir must be an absolute path.".to_string());
    }
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut output = Vec::new();
    let entries = list_directory_dirs(&root)?;
    for path in entries {
        let manifest = read_manifest(&path.join("manifest.json"));
        if let Some(mut parsed) = manifest {
            parsed
                .storage_schema
                .tables
                .sort_by(|a, b| a.name.cmp(&b.name));
            output.push(parsed);
        }
    }
    output.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(output)
}

#[tauri::command]
fn get_shared_component(
    library_dir: String,
    id: String,
) -> Result<SharedComponentManifest, String> {
    let path = manifest_path(&library_dir, &id)?;
    match read_manifest(&path) {
        Some(manifest) => Ok(manifest),
        None => Err("Component not found.".to_string()),
    }
}

#[tauri::command]
fn update_shared_component(
    input: UpdateSharedComponentInput,
) -> Result<SharedComponentManifest, String> {
    if input.id.trim().is_empty() {
        return Err("id is required.".to_string());
    }

    let existing_path = manifest_path(&input.library_dir, &input.id)?;
    let existing =
        read_manifest(&existing_path).ok_or_else(|| "Component not found.".to_string())?;
    if let Some(proposed_schema) = input.storage_schema {
        if proposed_schema != existing.storage_schema {
            return Err("storageSchema cannot be changed for this component version.".to_string());
        }
    }

    let next = SharedComponentManifest {
        id: existing.id,
        title: input.title.unwrap_or(existing.title),
        description: input.description.unwrap_or(existing.description),
        prompt: input.prompt.unwrap_or(existing.prompt),
        favorite: input.favorite.unwrap_or(existing.favorite),
        ui_spec: input.ui_spec.unwrap_or(existing.ui_spec),
        created_at: existing.created_at,
        updated_at: now_timestamp(),
        storage_kind: existing.storage_kind,
        storage_schema: existing.storage_schema,
        schema_version: existing.schema_version,
    };

    write_manifest(&existing_path, &next)?;
    Ok(next)
}

#[tauri::command]
fn delete_shared_component(library_dir: String, id: String) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("id is required.".to_string());
    }
    let dir = resolve_component_dir(&library_dir, &id)?;
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(dir).map_err(|e| e.to_string())
}

fn legacy_library_json_paths() -> Vec<PathBuf> {
    let home = match env::var("HOME") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return Vec::new(),
    };
    let app_support = PathBuf::from(home)
        .join("Library")
        .join("Application Support");
    vec![
        app_support.join("com.philo.dev").join("library.json"),
        app_support.join("philo").join("library.json"),
    ]
}

#[tauri::command]
fn cleanup_legacy_library_state() -> Result<(), String> {
    for path in legacy_library_json_paths() {
        if let Err(error) = fs::remove_file(&path) {
            if error.kind() != ErrorKind::NotFound {
                return Err(error.to_string());
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn run_shared_component_query(input: SharedQueryInput) -> Result<SharedQueryResult, String> {
    let manifest = get_shared_component(input.library_dir.clone(), input.component_id.clone())?;
    let params = read_params_as_object(&input.params)?;
    let named_query = manifest
        .storage_schema
        .named_queries
        .iter()
        .find(|query| query.name == input.query_name)
        .ok_or_else(|| format!("Unknown query '{}'.", input.query_name))?;
    let sql = build_named_select(&manifest.storage_schema, &named_query.name)?;

    let db_path = component_db_path(&input.library_dir, &input.component_id)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    verify_component_metadata(&conn, &manifest.id, manifest.schema_version)?;

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut values = Vec::new();
    for filter in &named_query.filters {
        let value = params
            .get(&filter.parameter)
            .ok_or_else(|| format!("Missing query param '{}'.", filter.parameter))?;
        values.push(to_sql_value(value)?);
    }

    let column_names = if named_query.columns.len() == 1 && named_query.columns[0] == "*" {
        let mut pragma = conn
            .prepare(&format!(
                "PRAGMA table_info({})",
                quoted_identifier(&named_query.table)
            ))
            .map_err(|e| e.to_string())?;
        let rows = pragma
            .query_map(params![], |row| {
                let name: String = row.get(1)?;
                Ok(name)
            })
            .map_err(|e| e.to_string())?;
        let mut names = Vec::new();
        for row in rows {
            names.push(row.map_err(|e| e.to_string())?);
        }
        names
    } else {
        named_query.columns.clone()
    };

    let rows = stmt
        .query_map(rusqlite::params_from_iter(values), |row| {
            Ok(row_to_json(row, &column_names))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(SharedQueryResult { rows })
}

#[tauri::command]
fn run_shared_component_mutation(
    input: SharedMutationInput,
) -> Result<SharedMutationResult, String> {
    let manifest = get_shared_component(input.library_dir.clone(), input.component_id.clone())?;
    let params = read_params_as_object(&input.params)?;
    let named_mutation = manifest
        .storage_schema
        .named_mutations
        .iter()
        .find(|mutation| mutation.name == input.mutation_name)
        .ok_or_else(|| format!("Unknown mutation '{}'.", input.mutation_name))?;

    let (sql, mutation) = build_named_mutation(&manifest.storage_schema, &named_mutation.name)?;
    let db_path = component_db_path(&input.library_dir, &input.component_id)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    verify_component_metadata(&conn, &manifest.id, manifest.schema_version)?;
    let mut values = Vec::new();

    for column in &mutation.set_columns {
        let value = params
            .get(column)
            .ok_or_else(|| format!("Missing mutation value '{}'.", column))?;
        values.push(to_sql_value(value)?);
    }
    for filter in &mutation.filters {
        let value = params
            .get(&filter.parameter)
            .ok_or_else(|| format!("Missing mutation param '{}'.", filter.parameter))?;
        values.push(to_sql_value(value)?);
    }

    let changed_rows = conn
        .execute(&sql, rusqlite::params_from_iter(values))
        .map_err(|e| e.to_string())?;

    Ok(SharedMutationResult {
        changed_rows: changed_rows as u64,
    })
}

#[tauri::command]
fn ensure_widget_storage(input: WidgetStorageInput) -> Result<(), String> {
    ensure_widget_storage_ready(&input)?;
    Ok(())
}

#[tauri::command]
fn run_widget_storage_query(input: WidgetQueryInput) -> Result<SharedQueryResult, String> {
    let storage_input = WidgetStorageInput {
        widget_path: input.widget_path.clone(),
        widget_id: input.widget_id.clone(),
        storage_schema: input.storage_schema.clone(),
        schema_version: input.schema_version,
    };
    let params = read_params_as_object(&input.params)?;
    let named_query = input
        .storage_schema
        .named_queries
        .iter()
        .find(|query| query.name == input.query_name)
        .ok_or_else(|| format!("Unknown query '{}'.", input.query_name))?;
    let sql = build_named_select(&input.storage_schema, &named_query.name)?;

    let db_path = ensure_widget_storage_ready(&storage_input)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    verify_widget_metadata(&conn, &input.widget_id, input.schema_version)?;

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut values = Vec::new();
    for filter in &named_query.filters {
        let value = params
            .get(&filter.parameter)
            .ok_or_else(|| format!("Missing query param '{}'.", filter.parameter))?;
        values.push(to_sql_value(value)?);
    }

    let column_names = if named_query.columns.len() == 1 && named_query.columns[0] == "*" {
        let mut pragma = conn
            .prepare(&format!(
                "PRAGMA table_info({})",
                quoted_identifier(&named_query.table)
            ))
            .map_err(|e| e.to_string())?;
        let rows = pragma
            .query_map(params![], |row| {
                let name: String = row.get(1)?;
                Ok(name)
            })
            .map_err(|e| e.to_string())?;
        let mut names = Vec::new();
        for row in rows {
            names.push(row.map_err(|e| e.to_string())?);
        }
        names
    } else {
        named_query.columns.clone()
    };

    let rows = stmt
        .query_map(rusqlite::params_from_iter(values), |row| {
            Ok(row_to_json(row, &column_names))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(SharedQueryResult { rows })
}

#[tauri::command]
fn run_widget_storage_mutation(input: WidgetMutationInput) -> Result<SharedMutationResult, String> {
    let storage_input = WidgetStorageInput {
        widget_path: input.widget_path.clone(),
        widget_id: input.widget_id.clone(),
        storage_schema: input.storage_schema.clone(),
        schema_version: input.schema_version,
    };
    let params = read_params_as_object(&input.params)?;
    let named_mutation = input
        .storage_schema
        .named_mutations
        .iter()
        .find(|mutation| mutation.name == input.mutation_name)
        .ok_or_else(|| format!("Unknown mutation '{}'.", input.mutation_name))?;

    let (sql, mutation) = build_named_mutation(&input.storage_schema, &named_mutation.name)?;
    let db_path = ensure_widget_storage_ready(&storage_input)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    verify_widget_metadata(&conn, &input.widget_id, input.schema_version)?;
    let mut values = Vec::new();

    for column in &mutation.set_columns {
        let value = params
            .get(column)
            .ok_or_else(|| format!("Missing mutation value '{}'.", column))?;
        values.push(to_sql_value(value)?);
    }
    for filter in &mutation.filters {
        let value = params
            .get(&filter.parameter)
            .ok_or_else(|| format!("Missing mutation param '{}'.", filter.parameter))?;
        values.push(to_sql_value(value)?);
    }

    let changed_rows = conn
        .execute(&sql, rusqlite::params_from_iter(values))
        .map_err(|e| e.to_string())?;

    Ok(SharedMutationResult {
        changed_rows: changed_rows as u64,
    })
}

#[tauri::command]
fn detect_obsidian_settings(vault_dir: String) -> ObsidianSettingsDetection {
    if vault_dir.trim().is_empty() {
        return ObsidianSettingsDetection {
            daily_logs_folder: String::new(),
            excalidraw_folder: String::new(),
            assets_folder: String::new(),
            filename_pattern: String::new(),
        };
    }

    let obsidian_dir = PathBuf::from(vault_dir).join(".obsidian");
    let daily_notes = read_json_file(&obsidian_dir.join("daily-notes.json"));
    let periodic_notes = read_json_file(&obsidian_dir.join("plugins/periodic-notes/data.json"));
    let app = read_json_file(&obsidian_dir.join("app.json"));
    let excalidraw =
        read_json_file(&obsidian_dir.join("plugins/obsidian-excalidraw-plugin/data.json"));

    let mut daily_logs_folder = String::new();
    let mut filename_pattern = String::new();

    if let Some(daily_notes_value) = daily_notes.as_ref() {
        if let Some(folder) = get_string(daily_notes_value, "folder") {
            daily_logs_folder = normalize_folder(&folder);
        }
        if let Some(format) = get_string(daily_notes_value, "format") {
            filename_pattern = map_obsidian_date_format_to_filename_pattern(&format);
        }
    }

    if let Some(periodic_notes_value) = periodic_notes.as_ref().and_then(|v| v.get("daily")) {
        if daily_logs_folder.is_empty() {
            if let Some(folder) = periodic_notes_value.get("folder").and_then(|v| v.as_str()) {
                daily_logs_folder = normalize_folder(folder);
            }
        }
        if filename_pattern.is_empty() {
            if let Some(format) = periodic_notes_value.get("format").and_then(|v| v.as_str()) {
                filename_pattern = map_obsidian_date_format_to_filename_pattern(format);
            }
        }
    }

    let assets_folder = app
        .as_ref()
        .and_then(|v| get_string(v, "attachmentFolderPath"))
        .map(|value| normalize_folder(&value))
        .unwrap_or_default();

    let mut excalidraw_folder = String::new();
    if let Some(excalidraw_value) = excalidraw.as_ref() {
        for key in [
            "folder",
            "excalidrawFolder",
            "drawingFolder",
            "drawingFolderPath",
            "folderPath",
        ] {
            if let Some(value) = get_string(excalidraw_value, key) {
                excalidraw_folder = normalize_folder(&value);
                break;
            }
        }

        if excalidraw_folder.is_empty() {
            if let Some(obj) = excalidraw_value.as_object() {
                for (key, value) in obj {
                    let Some(text) = value.as_str() else {
                        continue;
                    };
                    if !(contains_case_insensitive(key, "folder")
                        || contains_case_insensitive(key, "path")
                        || contains_case_insensitive(key, "dir"))
                    {
                        continue;
                    }
                    if contains_case_insensitive(key, "excalidraw")
                        || contains_case_insensitive(text, "excalidraw")
                    {
                        excalidraw_folder = normalize_folder(text);
                        break;
                    }
                }
            }
        }
    }

    ObsidianSettingsDetection {
        daily_logs_folder,
        excalidraw_folder,
        assets_folder,
        filename_pattern,
    }
}

#[tauri::command]
fn bootstrap_obsidian_vault(
    vault_dir: String,
    daily_logs_folder: String,
    excalidraw_folder: String,
    assets_folder: String,
) -> Result<(), String> {
    let normalized_vault = vault_dir.trim();
    if normalized_vault.is_empty() {
        return Ok(());
    }

    let vault_path = PathBuf::from(normalized_vault);
    let obsidian_dir = vault_path.join(".obsidian");
    if obsidian_dir.exists() {
        return Ok(());
    }

    fs::create_dir_all(&obsidian_dir).map_err(|e| e.to_string())?;

    let normalized_daily = normalize_folder(&daily_logs_folder);
    let normalized_excalidraw = normalize_folder(&excalidraw_folder);
    let normalized_assets = normalize_folder(&assets_folder);

    ensure_folder_in_vault(&vault_path, &normalized_daily)?;
    ensure_folder_in_vault(&vault_path, &normalized_excalidraw)?;
    ensure_folder_in_vault(&vault_path, &normalized_assets)?;

    if !normalized_daily.is_empty() && normalized_daily != "." {
        write_json_file(
            &obsidian_dir.join("daily-notes.json"),
            json!({
                "format": "YYYY-MM-DD",
                "folder": normalized_daily,
                "template": ""
            }),
        )?;
    }

    if !normalized_assets.is_empty() && normalized_assets != "." {
        write_json_file(
            &obsidian_dir.join("app.json"),
            json!({
                "attachmentFolderPath": normalized_assets
            }),
        )?;
    }

    if !normalized_excalidraw.is_empty() && normalized_excalidraw != "." {
        let plugin_dir = obsidian_dir.join("plugins/obsidian-excalidraw-plugin");
        fs::create_dir_all(&plugin_dir).map_err(|e| e.to_string())?;
        write_json_file(
            &plugin_dir.join("data.json"),
            json!({
                "folder": normalized_excalidraw
            }),
        )?;
    }

    Ok(())
}

#[tauri::command]
fn find_obsidian_vaults() -> Result<Vec<String>, String> {
    let home = env::var("HOME").map_err(|_| "Could not resolve HOME directory".to_string())?;
    let mut vaults: Vec<String> = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(PathBuf::from(home), 0)];
    let max_depth = 5usize;
    let max_vaults = 25usize;

    while let Some((dir, depth)) = stack.pop() {
        if depth > max_depth {
            continue;
        }

        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        let mut has_obsidian = false;
        let mut children: Vec<PathBuf> = Vec::new();

        for entry_result in entries {
            let entry = match entry_result {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if !file_type.is_dir() {
                continue;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".obsidian" {
                has_obsidian = true;
                break;
            }
            if should_skip_dir(&name) {
                continue;
            }
            children.push(entry.path());
        }

        if has_obsidian {
            vaults.push(dir.to_string_lossy().to_string());
            if vaults.len() >= max_vaults {
                break;
            }
            continue;
        }

        if depth < max_depth {
            for child in children {
                stack.push((child, depth + 1));
            }
        }
    }

    vaults.sort();
    vaults.dedup();
    Ok(vaults)
}

#[tauri::command]
fn extend_fs_scope(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    // Extend fs plugin scope
    app.fs_scope()
        .allow_directory(&p, true)
        .map_err(|e| e.to_string())?;
    // Extend asset protocol scope
    app.asset_protocol_scope()
        .allow_directory(&p, true)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn ensure_microphone_permission(app: AppHandle) -> Result<(), String> {
    let mut status = app
        .permissions()
        .check(Permission::Microphone)
        .await
        .map_err(|e| format!("Could not check microphone permission: {e}"))?;

    if matches!(status, PermissionStatus::NeverRequested) {
        app.permissions()
            .request(Permission::Microphone)
            .await
            .map_err(|e| format!("Could not request microphone permission: {e}"))?;

        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(250));
            status = app
                .permissions()
                .check(Permission::Microphone)
                .await
                .map_err(|e| format!("Could not check microphone permission: {e}"))?;
            if !matches!(status, PermissionStatus::NeverRequested) {
                break;
            }
        }
    }

    match status {
        PermissionStatus::Authorized => Ok(()),
        PermissionStatus::Denied => {
            let _ = app.permissions().open(Permission::Microphone).await;
            Err(microphone_permission_error_message())
        }
        PermissionStatus::NeverRequested => Err(microphone_permission_pending_message()),
    }
}

#[cfg(target_os = "macos")]
fn microphone_permission_error_message() -> String {
    let mut message = "Microphone access is required to record meetings. Allow the app in System Settings > Privacy & Security > Microphone.".to_string();

    if cfg!(debug_assertions) && !is_running_inside_app_bundle() {
        message.push_str(
            " You are running an unpackaged dev build, so macOS may list the launcher app instead of a separate Philo Dev entry. Check the app that started `pnpm tauri dev`, like Warp, Ghostty, or Terminal, or open /Applications/Philo.app and grant Philo there.",
        );
    }

    message
}

#[cfg(not(target_os = "macos"))]
fn microphone_permission_error_message() -> String {
    "Microphone access is required to record meetings. Allow the app in System Settings > Privacy & Security > Microphone.".to_string()
}

#[cfg(target_os = "macos")]
fn microphone_permission_pending_message() -> String {
    let mut message =
        "Microphone permission request did not finish. Try recording again and allow access when prompted."
            .to_string();

    if cfg!(debug_assertions) && !is_running_inside_app_bundle() {
        message.push_str(
            " If no prompt appears, macOS may be treating this as the launcher app instead of Philo Dev. Check the terminal app that started `pnpm tauri dev`, or try the installed /Applications/Philo.app.",
        );
    }

    message
}

#[cfg(not(target_os = "macos"))]
fn microphone_permission_pending_message() -> String {
    "Microphone permission request did not finish. Try recording again and allow access when prompted.".to_string()
}

#[cfg(target_os = "macos")]
fn is_running_inside_app_bundle() -> bool {
    env::current_exe().ok().is_some_and(|path| {
        path.ancestors()
            .any(|ancestor| ancestor.extension().and_then(|ext| ext.to_str()) == Some("app"))
    })
}

#[tauri::command]
fn ensure_widget_git_history_baseline(
    app: AppHandle,
    input: EnsureWidgetGitBaselineInput,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    widget_git::ensure_widget_git_history_baseline(&app_data_dir, input)
}

#[tauri::command]
fn record_widget_git_revision(
    app: AppHandle,
    input: RecordWidgetGitRevisionInput,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    widget_git::record_widget_git_revision(&app_data_dir, input)
}

#[tauri::command]
fn list_widget_git_history(
    app: AppHandle,
    input: WidgetGitHistoryInput,
) -> Result<Vec<WidgetGitHistoryEntry>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    widget_git::list_widget_git_history(&app_data_dir, input)
}

#[tauri::command]
fn get_widget_git_diff(app: AppHandle, input: WidgetGitDiffInput) -> Result<WidgetGitDiff, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    widget_git::get_widget_git_diff(&app_data_dir, input)
}

#[tauri::command]
fn restore_widget_git_revision(
    app: AppHandle,
    input: RestoreWidgetGitRevisionInput,
) -> Result<WidgetGitRestoreResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    widget_git::restore_widget_git_revision(&app_data_dir, input)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_settings::init())
        .plugin(tauri_plugin_listener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .manage(GoogleOAuthState::default())
        .manage(HttpStreamState::default())
        .invoke_handler(tauri::generate_handler![
            extend_fs_scope,
            ensure_widget_git_history_baseline,
            record_widget_git_revision,
            list_widget_git_history,
            get_widget_git_diff,
            restore_widget_git_revision,
            find_obsidian_vaults,
            detect_obsidian_settings,
            bootstrap_obsidian_vault,
            post_json,
            stream_http,
            cancel_http_stream,
            read_markdown_file,
            write_markdown_file,
            start_google_oauth_callback,
            wait_for_google_oauth_callback,
            cancel_google_oauth_callback,
            complete_google_oauth,
            ensure_google_access_token,
            clear_google_oauth_session,
            list_google_oauth_session_accounts,
            open_in_apple_mail,
            open_in_apple_calendar,
            show_path_in_folder,
            ensure_microphone_permission,
            run_ai_tool,
            build_unified_diff,
            set_window_opacity,
            get_native_current_position,
            search_markdown_files,
            create_shared_component,
            list_shared_components,
            get_shared_component,
            update_shared_component,
            delete_shared_component,
            cleanup_legacy_library_state,
            run_shared_component_query,
            run_shared_component_mutation,
            ensure_widget_storage,
            run_widget_storage_query,
            run_widget_storage_mutation
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |_| {
                focus_main_window(&app_handle);
            });

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = offset_macos_traffic_lights(&window, 2.0);
            }

            let app_name = if cfg!(debug_assertions) {
                "Philo Dev"
            } else {
                "Philo"
            };
            let about_title = if cfg!(debug_assertions) {
                "About Philo Dev"
            } else {
                "About Philo"
            };
            #[cfg(target_os = "macos")]
            if cfg!(debug_assertions) {
                set_macos_process_name(app_name);
            }

            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let settings = MenuItemBuilder::with_id("settings", "Settings...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let library = MenuItemBuilder::with_id("library", "Widget Library")
                .accelerator("CmdOrCtrl+P")
                .build(app)?;

            let global_search = MenuItemBuilder::with_id("global-search", "Global Search")
                .accelerator("CmdOrCtrl+F")
                .build(app)?;

            let check_updates =
                MenuItemBuilder::with_id("check-updates", "Check for Updates...").build(app)?;

            let app_menu = SubmenuBuilder::new(app, app_name)
                .item(&PredefinedMenuItem::about(app, Some(about_title), None)?)
                .item(&check_updates)
                .separator()
                .item(&settings)
                .item(&library)
                .item(&global_search)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .close_window()
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(move |app_handle, event| {
                if event.id() == "settings" {
                    let _ = app_handle.emit("open-settings", ());
                } else if event.id() == "library" {
                    let _ = app_handle.emit("toggle-library", ());
                } else if event.id() == "global-search" {
                    let _ = app_handle.emit("open-global-search", ());
                } else if event.id() == "check-updates" {
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        match handle.updater() {
                            Ok(updater) => match updater.check().await {
                                Ok(Some(_)) => {
                                    let _ = handle.emit("update-available", ());
                                }
                                Ok(None) => {
                                    handle
                                        .dialog()
                                        .message("You're running the latest version.")
                                        .title("No Updates Available")
                                        .kind(MessageDialogKind::Info)
                                        .blocking_show();
                                }
                                Err(e) => {
                                    handle
                                        .dialog()
                                        .message(format!("Could not check for updates: {}", e))
                                        .title("Update Error")
                                        .kind(MessageDialogKind::Error)
                                        .blocking_show();
                                }
                            },
                            Err(e) => {
                                handle
                                    .dialog()
                                    .message(format!("Updater not available: {}", e))
                                    .title("Update Error")
                                    .kind(MessageDialogKind::Error)
                                    .blocking_show();
                            }
                        }
                    });
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn sample_storage_schema() -> SharedStorageSchema {
        SharedStorageSchema {
            tables: vec![SharedStorageTable {
                name: "items".to_string(),
                columns: vec![
                    SharedStorageColumn {
                        name: "id".to_string(),
                        kind: "integer".to_string(),
                        not_null: true,
                        primary_key: true,
                    },
                    SharedStorageColumn {
                        name: "title".to_string(),
                        kind: "text".to_string(),
                        not_null: true,
                        primary_key: false,
                    },
                    SharedStorageColumn {
                        name: "done".to_string(),
                        kind: "integer".to_string(),
                        not_null: true,
                        primary_key: false,
                    },
                ],
                indexes: Some(vec![SharedStorageIndex {
                    name: "idx_items_title".to_string(),
                    columns: vec!["title".to_string()],
                    unique: false,
                }]),
            }],
            named_queries: vec![
                SharedStorageQuery {
                    name: "listItems".to_string(),
                    table: "items".to_string(),
                    columns: vec!["*".to_string()],
                    filters: vec![],
                    order_by: Some("id".to_string()),
                    order_desc: false,
                    limit: Some(50),
                },
                SharedStorageQuery {
                    name: "findItem".to_string(),
                    table: "items".to_string(),
                    columns: vec!["id".to_string(), "title".to_string(), "done".to_string()],
                    filters: vec![SharedStorageFilter {
                        column: "id".to_string(),
                        operator: "eq".to_string(),
                        parameter: "id".to_string(),
                    }],
                    order_by: None,
                    order_desc: false,
                    limit: Some(1),
                },
            ],
            named_mutations: vec![
                SharedStorageMutation {
                    name: "insertItem".to_string(),
                    table: "items".to_string(),
                    kind: "insert".to_string(),
                    set_columns: vec!["id".to_string(), "title".to_string(), "done".to_string()],
                    filters: vec![],
                },
                SharedStorageMutation {
                    name: "updateTitle".to_string(),
                    table: "items".to_string(),
                    kind: "update".to_string(),
                    set_columns: vec!["title".to_string()],
                    filters: vec![SharedStorageFilter {
                        column: "id".to_string(),
                        operator: "eq".to_string(),
                        parameter: "id".to_string(),
                    }],
                },
                SharedStorageMutation {
                    name: "deleteItem".to_string(),
                    table: "items".to_string(),
                    kind: "delete".to_string(),
                    set_columns: vec![],
                    filters: vec![SharedStorageFilter {
                        column: "id".to_string(),
                        operator: "eq".to_string(),
                        parameter: "id".to_string(),
                    }],
                },
            ],
        }
    }

    fn sample_manifest(component_id: &str) -> SharedComponentManifest {
        SharedComponentManifest {
            id: component_id.to_string(),
            title: "Shared Items".to_string(),
            description: "A shared item tracker".to_string(),
            prompt: "Build a shared item tracker".to_string(),
            favorite: false,
            created_at: "2026-03-12T00:00:00.000Z".to_string(),
            updated_at: "2026-03-12T00:00:00.000Z".to_string(),
            ui_spec: json!({
                "root": "card",
                "elements": {
                    "card": {
                        "type": "Card",
                        "props": { "title": "Items" },
                        "children": []
                    }
                }
            }),
            storage_kind: "sqlite".to_string(),
            storage_schema: sample_storage_schema(),
            schema_version: SHARED_SCHEMA_VERSION,
        }
    }

    fn temp_library_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("philo-{label}-{suffix}"))
    }

    #[test]
    fn validate_storage_schema_rejects_unknown_query_column() {
        let mut schema = sample_storage_schema();
        schema.named_queries[0].columns = vec!["missing".to_string()];

        let error = validate_storage_schema(&schema).unwrap_err();
        assert!(error.contains("unknown column"));
    }

    #[test]
    fn validate_storage_schema_allows_empty_schema() {
        let schema = SharedStorageSchema {
            tables: vec![],
            named_queries: vec![],
            named_mutations: vec![],
        };

        assert!(validate_storage_schema(&schema).is_ok());
    }

    #[test]
    fn shared_component_db_supports_named_queries_and_mutations() {
        let library_dir = temp_library_dir("shared-db");
        let component_id = "component-shared";
        let component_dir = library_dir.join(component_id);
        fs::create_dir_all(&component_dir).unwrap();

        let manifest = sample_manifest(component_id);
        let manifest_path = component_dir.join("manifest.json");
        let db_path = component_dir.join("component.sqlite3");

        write_manifest(&manifest_path, &manifest).unwrap();
        initialize_component_db(&db_path, &manifest).unwrap();

        let insert_result = run_shared_component_mutation(SharedMutationInput {
            library_dir: library_dir.to_string_lossy().to_string(),
            component_id: component_id.to_string(),
            mutation_name: "insertItem".to_string(),
            params: json!({
                "id": 1,
                "title": "First item",
                "done": 0
            }),
        })
        .unwrap();
        assert_eq!(insert_result.changed_rows, 1);

        let list_result = run_shared_component_query(SharedQueryInput {
            library_dir: library_dir.to_string_lossy().to_string(),
            component_id: component_id.to_string(),
            query_name: "listItems".to_string(),
            params: json!({}),
        })
        .unwrap();
        assert_eq!(list_result.rows.len(), 1);
        assert_eq!(list_result.rows[0]["title"], json!("First item"));

        let update_result = run_shared_component_mutation(SharedMutationInput {
            library_dir: library_dir.to_string_lossy().to_string(),
            component_id: component_id.to_string(),
            mutation_name: "updateTitle".to_string(),
            params: json!({
                "id": 1,
                "title": "Updated item"
            }),
        })
        .unwrap();
        assert_eq!(update_result.changed_rows, 1);

        let find_result = run_shared_component_query(SharedQueryInput {
            library_dir: library_dir.to_string_lossy().to_string(),
            component_id: component_id.to_string(),
            query_name: "findItem".to_string(),
            params: json!({
                "id": 1
            }),
        })
        .unwrap();
        assert_eq!(find_result.rows.len(), 1);
        assert_eq!(find_result.rows[0]["title"], json!("Updated item"));

        let delete_result = run_shared_component_mutation(SharedMutationInput {
            library_dir: library_dir.to_string_lossy().to_string(),
            component_id: component_id.to_string(),
            mutation_name: "deleteItem".to_string(),
            params: json!({
                "id": 1
            }),
        })
        .unwrap();
        assert_eq!(delete_result.changed_rows, 1);

        let empty_result = run_shared_component_query(SharedQueryInput {
            library_dir: library_dir.to_string_lossy().to_string(),
            component_id: component_id.to_string(),
            query_name: "listItems".to_string(),
            params: json!({}),
        })
        .unwrap();
        assert!(empty_result.rows.is_empty());

        let _ = fs::remove_dir_all(&library_dir);
    }

    #[test]
    fn widget_storage_db_supports_named_queries_and_mutations() {
        let widgets_dir = temp_library_dir("widget-db");
        fs::create_dir_all(&widgets_dir).unwrap();
        let widget_path = widgets_dir.join("tracker.widget.md");
        fs::write(&widget_path, "---\n---\n").unwrap();

        let storage_input = WidgetStorageInput {
            widget_path: widget_path.to_string_lossy().to_string(),
            widget_id: "widget-instance".to_string(),
            storage_schema: sample_storage_schema(),
            schema_version: WIDGET_STORAGE_SCHEMA_VERSION,
        };
        ensure_widget_storage(storage_input).unwrap();

        let insert_result = run_widget_storage_mutation(WidgetMutationInput {
            widget_path: widget_path.to_string_lossy().to_string(),
            widget_id: "widget-instance".to_string(),
            storage_schema: sample_storage_schema(),
            schema_version: WIDGET_STORAGE_SCHEMA_VERSION,
            mutation_name: "insertItem".to_string(),
            params: json!({
                "id": 1,
                "title": "First widget item",
                "done": 0
            }),
        })
        .unwrap();
        assert_eq!(insert_result.changed_rows, 1);

        let list_result = run_widget_storage_query(WidgetQueryInput {
            widget_path: widget_path.to_string_lossy().to_string(),
            widget_id: "widget-instance".to_string(),
            storage_schema: sample_storage_schema(),
            schema_version: WIDGET_STORAGE_SCHEMA_VERSION,
            query_name: "listItems".to_string(),
            params: json!({}),
        })
        .unwrap();
        assert_eq!(list_result.rows.len(), 1);
        assert_eq!(list_result.rows[0]["title"], json!("First widget item"));

        let _ = fs::remove_dir_all(&widgets_dir);
    }
}
