mod airport_engine;
mod field;
mod push;
mod realtime;
mod store;
mod weather;

use axum::http::Method;
use axum::RequestExt;
use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path, Query, Request, State,
    },
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine as _,
};
use hmac::{Hmac, Mac};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, env, fs, net::SocketAddr, path::PathBuf, sync::Arc};
use subtle::ConstantTimeEq;
use time::OffsetDateTime;
use tokio::io::AsyncWriteExt;
use tokio::task;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};
use uuid::Uuid;

use airport_engine::AirportEngine;
use futures_util::StreamExt;
use push::PushService;
use ramppulse_core::{
    ActorRef, AirportGraph, EntityRef, EventKind, RealtimeEvent, REALTIME_PROTOCOL_VERSION,
};
use realtime::{Audience, RealtimeHub};
use store::{AccountStore, NewEngineer, NewRequest, ShiftFailure};
use weather::WeatherService;

const COOKIE_NAME: &str = "oto_session";
const SESSION_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
const PBKDF2_ITERATIONS: u32 = 210_000;
const CHAT_ATTACHMENT_LIMIT: u64 = 100 * 1024 * 1024;

#[derive(Clone)]
struct AppState {
    store: AccountStore,
    cookie_secure: bool,
    demo_mode: bool,
    realtime: RealtimeHub,
    airport_graph: Arc<AirportGraph>,
    airport_data: Arc<serde_json::Value>,
    engine: AirportEngine,
    airport_name: String,
    frontend_dir: PathBuf,
    attachments_dir: PathBuf,
    stun_urls: Vec<String>,
    turn_urls: Vec<String>,
    turn_shared_secret: Option<String>,
    livekit_url: Option<String>,
    livekit_api_key: Option<String>,
    livekit_api_secret: Option<String>,
    push: Option<PushService>,
    weather: WeatherService,
    engineer_locations: Arc<
        std::sync::Mutex<std::collections::HashMap<i64, (EngineerLocation, std::time::Instant)>>,
    >,
    login_guard: Arc<std::sync::Mutex<std::collections::HashMap<String, LoginAttempts>>>,
}

#[derive(Clone, Copy, Debug)]
struct LoginAttempts {
    failures: u32,
    window_start: std::time::Instant,
    locked_until: Option<std::time::Instant>,
}

const LOGIN_MAX_FAILURES: u32 = 5;
const LOGIN_WINDOW: std::time::Duration = std::time::Duration::from_secs(600);
const LOGIN_LOCK: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Serialize)]
struct ApiError {
    detail: String,
}

#[derive(Debug)]
struct HttpError(StatusCode, &'static str);

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(ApiError {
                detail: self.1.to_owned(),
            }),
        )
            .into_response()
    }
}

#[derive(Deserialize)]
struct LoginBody {
    #[serde(default)]
    device_id: Option<Uuid>,
    email: String,
    password: String,
    #[serde(default)]
    native_client: bool,
}

#[derive(Deserialize)]
struct RegisterBody {
    email: String,
    username: String,
    name: String,
    password: String,
    qual: String,
    #[serde(default)]
    types: Vec<String>,
    base: String,
}

#[derive(Deserialize)]
struct RoutePreviewBody {
    #[serde(default)]
    via: Vec<String>,
    #[serde(default)]
    vehicle_available: bool,
    from: String,
    to: String,
    #[serde(default)]
    blocked_edges: HashSet<String>,
}

#[derive(Deserialize)]
struct CreateRequestBody {
    #[serde(default)]
    via: Vec<String>,
    stand: String,
    description: String,
    qual: String,
    #[serde(default)]
    extra: String,
    #[serde(default)]
    tech_id: Option<i64>,
    #[serde(default = "default_priority")]
    priority: String,
}

#[derive(Deserialize)]
struct DeclineRequestBody {
    reason: String,
}

#[derive(Deserialize)]
struct RequestStatusBody {
    status: String,
    #[serde(default)]
    confirm_shift_lead: bool,
}

#[derive(Deserialize)]
struct RequestAssignBody {
    tech_id: i64,
    #[serde(default)]
    confirm_reassignment: bool,
}

#[derive(Deserialize)]
struct ShiftBody {
    on_shift: bool,
}

#[derive(Deserialize)]
struct DirectRoomBody {
    peer_id: i64,
}
#[derive(Deserialize)]
struct ChatMessageBody {
    kind: String,
    content: String,
    #[serde(default)]
    attachment_id: Option<String>,
    #[serde(default)]
    duration: Option<i64>,
}
#[derive(Deserialize)]
struct ChatReadBody {
    message_id: i64,
}
#[derive(Deserialize)]
struct MessageQuery {
    limit: Option<i64>,
}
#[derive(Deserialize)]
struct CallRelayBody {
    recipient_id: i64,
    signal: serde_json::Value,
}
#[derive(Deserialize)]
struct PushDeviceBody {
    token: String,
}

#[derive(Deserialize)]
struct SimulationBody {
    #[serde(default)]
    spawn_at_terminal: bool,
    speed: Option<i64>,
    running: Option<bool>,
}

#[derive(Deserialize)]
struct EdgeBlockBody {
    blocked: bool,
}

#[derive(Deserialize)]
struct TechPositionBody {
    x: f64,
    y: f64,
}
#[derive(Deserialize)]
struct TechProfileBody {
    qual: String,
    #[serde(default)]
    types: Vec<String>,
}
#[derive(Deserialize)]
struct EngineerLocationBody {
    observed_ms: Option<i64>,
    enabled: bool,
    latitude: Option<f64>,
    longitude: Option<f64>,
    accuracy: Option<f64>,
    heading: Option<f64>,
    speed: Option<f64>,
}
#[derive(Clone, Serialize)]
struct EngineerLocation {
    tech_id: i64,
    user_id: i64,
    name: String,
    latitude: f64,
    longitude: f64,
    accuracy: f64,
    heading: Option<f64>,
    speed: Option<f64>,
    updated_at_ms: u64,
    track: Vec<[f64; 2]>,
}
fn default_priority() -> String {
    "normal".into()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();
    let db_path = env::var("DB_FILE").unwrap_or_else(|_| "./ramppulse.db".into());
    let store = AccountStore::open(&db_path)?;
    let demo_mode = env_flag("DEMO_MODE");
    if demo_mode {
        store.seed_demo()?;
    }

    let airport_text = include_str!("../../data/airport_vdnh.json");
    let airport_data: serde_json::Value = serde_json::from_str(&airport_text)?;
    let airport_name = airport_data
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("ВДНХ · IT2026 Aero GeoData")
        .to_owned();
    let airport_graph = AirportGraph::from_airport_json(&airport_text)?;
    let tech_seed = fs::read_to_string("data/technicians.json").unwrap_or_else(|_| "[]".into());
    let engine = AirportEngine::new(&airport_data, &tech_seed)?;
    for (tech_id, x, y) in store.technician_positions()? {
        engine.move_tech(tech_id, x, y)?;
    }
    let frontend_dir =
        PathBuf::from(env::var("FRONTEND_DIR").unwrap_or_else(|_| "frontend".into()));
    let attachments_dir = PathBuf::from(
        env::var("CHAT_STORAGE_DIR").unwrap_or_else(|_| "./data/chat-attachments".into()),
    );
    fs::create_dir_all(&attachments_dir)?;

    let state = AppState {
        store,
        cookie_secure: env_flag("COOKIE_SECURE"),
        demo_mode,
        realtime: RealtimeHub::new(),
        airport_graph: Arc::new(airport_graph),
        airport_data: Arc::new(airport_data),
        engine,
        airport_name,
        frontend_dir,
        attachments_dir,
        stun_urls: env_urls("STUN_URLS", &["stun:stun.l.google.com:19302"]),
        turn_urls: env_urls("TURN_URLS", &[]),
        turn_shared_secret: env::var("TURN_SHARED_SECRET")
            .ok()
            .filter(|value| !value.is_empty()),
        livekit_url: env::var("LIVEKIT_URL")
            .ok()
            .filter(|value| !value.is_empty()),
        livekit_api_key: env::var("LIVEKIT_API_KEY")
            .ok()
            .filter(|value| !value.is_empty()),
        livekit_api_secret: env::var("LIVEKIT_API_SECRET")
            .ok()
            .filter(|value| !value.is_empty()),
        push: PushService::from_env(),
        weather: WeatherService::from_env()?,
        engineer_locations: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        login_guard: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    };

    tokio::spawn(field::warnings(state.clone()));
    let tick_engine = state.engine.clone();
    let tick_hub = state.realtime.clone();
    let tick_store = state.store.clone();
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/meta", get(meta))
        .route("/api/auth/login", post(login))
        .route("/api/auth/me", get(me))
        .route("/api/auth/register", post(register))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/logout-others", post(logout_others))
        .route("/api/profile", get(profile).post(update_profile))
        .route(
            "/api/profile/media/{user_id}/{kind}",
            get(get_profile_media)
                .post(upload_profile_media)
                .delete(delete_profile_media)
                .layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/api/profile/password", post(change_password))
        .route("/api/presence", get(presence))
        .route("/api/push/register", post(register_push_device))
        .route("/api/push/status", get(push_status))
        .route("/api/calls/pending", get(pending_call_invites))
        .route("/api/calls/livekit-token", post(livekit_token))
        .route("/api/push/unregister", post(unregister_push_device))
        .route("/api/chat/rooms/{id}/typing", post(chat_typing))
        .route("/api/airport", get(airport))
        .route("/api/weather/current", get(current_weather))
        .route(
            "/api/agents/positions",
            get(field::positions).post(field::ingest),
        )
        .route("/api/engineer/location", post(update_engineer_location))
        .route("/api/engineers/locations", get(engineer_locations))
        .route("/api/state", get(state_snapshot))
        .route("/api/routes/preview", post(route_preview))
        .route("/api/requests", get(list_requests).post(create_request))
        .route("/api/requests/{id}/status", post(change_request_status))
        .route("/api/security", get(security_status).post(security_change))
        .route("/api/journal", get(request_journal))
        .route("/api/requests/{id}/assign", post(assign_request))
        .route("/api/engineer/requests/{id}/decline", post(engineer_request_decline))
        .route("/api/requests/{id}/arrive", post(dispatcher_request_arrive))
        .route("/api/requests/{id}/start", post(dispatcher_request_start))
        .route(
            "/api/requests/{id}/resolve",
            post(dispatcher_request_resolve),
        )
        .route("/api/requests/{id}/cancel", post(dispatcher_request_cancel))
        .route(
            "/api/engineer/requests/{id}/arrive",
            post(engineer_request_arrive),
        )
        .route(
            "/api/engineer/requests/{id}/start",
            post(engineer_request_start),
        )
        .route(
            "/api/engineer/requests/{id}/resolve",
            post(engineer_request_resolve),
        )
        .route("/api/shift", post(set_shift))
        .route("/api/engineer/shift/start", post(engineer_shift_start))
        .route("/api/engineer/shift/end", post(engineer_shift_end))
        .route("/api/sim", post(update_simulation))
        .route("/api/edges/{id}/block", post(set_edge_blocked))
        .route("/api/techs/{id}/position", post(move_technician))
        .route("/api/techs/{id}/profile", post(update_technician_profile))
        .route("/api/aircraft/spawn", post(spawn_aircraft))
        .route("/api/aircraft/{id}/depart", post(depart_aircraft))
        .route("/api/reset", post(reset_simulation))
        .route("/api/chat/contacts", get(chat_contacts))
        .route("/api/chat/rooms", get(chat_rooms))
        .route("/api/chat/rooms/direct", post(create_direct_room))
        .route(
            "/api/chat/rooms/{id}/messages",
            get(chat_messages).post(send_chat_message),
        )
        .route("/api/chat/rooms/{id}/read", post(mark_chat_read))
        .route(
            "/api/chat/rooms/{id}/attachments",
            post(upload_chat_attachment)
                .layer(DefaultBodyLimit::max(CHAT_ATTACHMENT_LIMIT as usize)),
        )
        .route("/api/chat/attachments/{id}", get(download_chat_attachment))
        .route("/api/calls/relay", post(relay_call_signal))
        .route("/api/calls/config", get(call_config))
        .route("/api/registrations", get(pending_registrations))
        .route(
            "/api/registrations/{id}/approve",
            post(approve_registration),
        )
        .route("/api/registrations/{id}/reject", post(reject_registration))
        .route("/ws", get(websocket))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .fallback(get(frontend_asset))
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::predicate(|origin, _| {
                    let origin = origin.to_str().unwrap_or_default();
                    let dynamic_loopback_origin = ["http://127.0.0.1:", "http://localhost:"]
                        .iter()
                        .any(|prefix| origin.strip_prefix(prefix).is_some_and(|port| {
                            !port.is_empty() && port.parse::<u16>().is_ok_and(|port| port != 0)
                        }));
                    dynamic_loopback_origin
                        || ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"].contains(&origin)
                }))
                .allow_credentials(true)
                .allow_methods(AllowMethods::list([
                    Method::GET,
                    Method::POST,
                    Method::DELETE,
                    Method::OPTIONS,
                ]))
                .allow_headers(AllowHeaders::list([
                    header::ACCEPT,
                    header::AUTHORIZATION,
                    header::CONTENT_TYPE,
                    HeaderName::from_static("x-chat-kind"),
                    HeaderName::from_static("x-chat-duration"),
                    HeaderName::from_static("x-chat-file-name"),
                ])),
        )
        .with_state(state);

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(1));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut persist_counter = 0_u8;
        let mut aircraft_statuses = std::collections::HashMap::<i64, String>::new();
        loop {
            ticker.tick().await;
            if let Ok(Some(payload)) = tick_engine.tick(1.0) {
                for tech in payload["techs"].as_array().into_iter().flatten().filter(|t|t["arrived"]==true) {
                    let (Some(tech_id),Some(request_id))=(tech["id"].as_i64(),tech["request_id"].as_i64()) else { continue };
                    let store=tick_store.clone();
                    let scale=payload["sim_speed"].as_f64().unwrap_or(1.0);
                    match task::spawn_blocking(move ||store.automatic_arrival_and_start(request_id,tech_id,"simulation",scale)).await {
                        Ok(Ok(Some(request))) => {
                            tick_engine.stop_request_route(tech_id,request_id);
                            for role in ["dispatcher","engineer"] {
                                tick_hub.publish(EventKind::RequestStatusChanged,Audience::Role(role.into()),None,
                                    Some(EntityRef{kind:"request".into(),id:request_id.to_string(),version:request.version as u64}),
                                    json!({"id":request_id,"status":"working","source":"simulation","automatic":true}));
                            }
                        }
                        Ok(Err(error))=>eprintln!("Could not record simulated arrival for request {request_id}: {error}"),
                        Err(error)=>eprintln!("Arrival task failed: {error}"),
                        _=>{}
                    }
                }

                for aircraft in payload["aircraft"].as_array().into_iter().flatten() {
                    let Some(id) = aircraft["id"].as_i64() else { continue };
                    let status = aircraft["status"].as_str().unwrap_or_default().to_owned();
                    if aircraft_statuses.get(&id) != Some(&status) {
                        let event = if status == "parked" && aircraft_statuses.contains_key(&id) {
                            "aircraft_arrived"
                        } else { "aircraft_state" };
                        let key = format!("aircraft:{id}:{}", now_rfc3339());
                        if let Err(error) = tick_store.append_audit(&key, None, event,
                            &json!({"aircraft":aircraft,"sim_time":payload["sim_time"]})) {
                            eprintln!("Could not persist aircraft audit: {error}");
                        } else { aircraft_statuses.insert(id, status); }
                    }
                }
                persist_counter = persist_counter.wrapping_add(1);
                if persist_counter >= 5 {
                    persist_counter = 0;
                    let positions = payload["techs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|tech| {
                            Some((
                                tech["id"].as_i64()?,
                                tech["x"].as_f64()?,
                                tech["y"].as_f64()?,
                            ))
                        })
                        .collect::<Vec<_>>();
                    if !positions.is_empty() {
                        let store = tick_store.clone();
                        if let Err(error) = task::spawn_blocking(move || {
                            store.save_technician_positions(&positions)
                        })
                        .await
                        .unwrap_or_else(|_| Err(rusqlite::Error::InvalidQuery))
                        {
                            eprintln!("Could not persist technician positions: {error}");
                        }
                    }
                }
                for role in ["dispatcher", "engineer"] {
                    tick_hub.publish(
                        EventKind::StateDelta,
                        Audience::Role(role.into()),
                        None,
                        Some(EntityRef {
                            kind: "simulation".into(),
                            id: "airport".into(),
                            version: 1,
                        }),
                        payload.clone(),
                    );
                }
            }
        }
    });

    let address: SocketAddr = format!(
        "{}:{}",
        env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into()),
        env::var("PORT").unwrap_or_else(|_| "8001".into())
    )
    .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("RampPulse Rust service listening on {address}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn env_flag(name: &str) -> bool {
    env::var(name)
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

fn env_urls(name: &str, fallback: &[&str]) -> Vec<String> {
    let configured = env::var(name).unwrap_or_default();
    let valid_prefixes: &[&str] = if name == "TURN_URLS" {
        &["turn:", "turns:"]
    } else {
        &["stun:", "stuns:"]
    };
    let urls = configured
        .split(',')
        .map(str::trim)
        .filter(|url| valid_prefixes.iter().any(|prefix| url.starts_with(prefix)))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if urls.is_empty() {
        fallback.iter().map(|url| (*url).to_owned()).collect()
    } else {
        urls
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("register SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn healthz(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "service": "ramppulse-rust",
        "protocol": ramppulse_core::REALTIME_PROTOCOL_VERSION,
        "demo_mode": state.demo_mode,
        "airport": state.airport_name,
    }))
}

async fn frontend_asset(State(state): State<AppState>, uri: axum::http::Uri) -> Response {
    use std::path::Component;

    let route = match uri.path() {
        "/" => "index.html",
        "/login" | "/engineer" if !state.frontend_dir.join("assets").is_dir() => {
            if uri.path() == "/login" {
                "auth.html"
            } else {
                "engineer.html"
            }
        }
        path if path.starts_with("/static/") => path.trim_start_matches("/static/"),
        path => path.trim_start_matches('/'),
    };
    let relative = PathBuf::from(route);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let root = match tokio::fs::canonicalize(&state.frontend_dir).await {
        Ok(path) => path,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let candidate = root.join(&relative);
    let mut relative = relative;
    let path = match tokio::fs::canonicalize(&candidate).await {
        Ok(path) if path.starts_with(&root) && path.is_file() => path,
        // SPA fallback: unknown extension-less routes (e.g. /engineer/chat) render the app shell.
        _ if relative.extension().is_none() && !uri.path().starts_with("/api/") => {
            relative = PathBuf::from("index.html");
            match tokio::fs::canonicalize(root.join("index.html")).await {
                Ok(path) => path,
                Err(_) => return StatusCode::NOT_FOUND.into_response(),
            }
        }
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let contents = match tokio::fs::read(path).await {
        Ok(contents) => contents,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let content_type = match relative
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "webmanifest" => "application/manifest+json",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    let mut response = Response::new(axum::body::Body::from(contents));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        // Vite emits content-hashed files under /assets: safe to cache forever.
        HeaderValue::from_static(if relative.starts_with("assets") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    response
}

async fn meta(State(state): State<AppState>) -> Json<serde_json::Value> {
    let bases = state
        .airport_data
        .get("bases")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let mut value = serde_json::json!({
        "protocol": ramppulse_core::REALTIME_PROTOCOL_VERSION,
        "features": { "server_chat": true, "versioned_events": true, "airport_state_v1": true, "native_client_token_auth": true, "open_meteo_weather": true, "engineer_live_location": true, "local_geojson_map": true },
        "maps": { "provider": "LOCAL_GEOJSON", "configured": true, "offline": true },
        "demo": { "enabled": state.demo_mode },
        "airport": { "name": state.airport_name, "source": state.airport_data.get("source").and_then(serde_json::Value::as_str).unwrap_or("RampPulse") },
        "quals": ["Планер", "Двигатель", "Авионика"],
        "types": ["A320", "A330", "A350", "B737", "B777", "B787", "SSJ-100", "MC-21"],
        "bases": bases,
    });
    let store = state.store.clone();
    if let Ok(Ok(quals)) = task::spawn_blocking(move || store.qualifications()).await {
        value["quals"] = json!(quals);
    }
    // Credentials are returned only for an explicitly enabled local/contest demo, never in
    // a normal server configuration. Production clients must not discover account secrets.
    if state.demo_mode {
        value["demo"].as_object_mut().unwrap().extend([
            ("dispatcher_email".into(), "dispatcher@oto.ru".into()),
            ("dispatcher_password".into(), "Dispatcher2026!".into()),
            ("engineer_email".into(), "tech1@oto.ru".into()),
            ("engineer_password".into(), "Engineer2026!".into()),
        ]);
    }
    Json(value)
}

async fn airport(State(state): State<AppState>) -> Json<serde_json::Value> {
    let mut data = (*state.airport_data).clone();
    if let Some(object) = data.as_object_mut() {
        object.entry("geo").or_insert_with(|| {
            json!({
                "iata": "VDN", "icao": "VDNH", "latitude": 55.8330053, "longitude": 37.628713,
                "elevation_m": 0, "coordinate_source": "IT2026 VDNH GeoJSON"
            })
        });
    }
    Json(data)
}

#[derive(Deserialize)]
struct WeatherQuery {
    lat: Option<f64>,
    lon: Option<f64>,
    refresh: Option<bool>,
}

async fn current_weather(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<WeatherQuery>,
) -> Result<Json<weather::CurrentWeather>, HttpError> {
    authenticated_user(&state, &headers).await?;
    let (lat, lon) = match (query.lat, query.lon) {
        (Some(lat), Some(lon))
            if lat.is_finite()
                && (-90.0..=90.0).contains(&lat)
                && lon.is_finite()
                && (-180.0..=180.0).contains(&lon) =>
        {
            (Some(lat), Some(lon))
        }
        (None, None) => (None, None),
        _ => {
            return Err(HttpError(
                StatusCode::BAD_REQUEST,
                "Weather coordinates are invalid.",
            ))
        }
    };
    Ok(Json(
        state
            .weather
            .current(lat, lon, query.refresh.unwrap_or(false))
            .await,
    ))
}

async fn update_engineer_location(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EngineerLocationBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    if user.role != "engineer" || user.tech_id.is_none() {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Live location sharing is for linked engineer accounts.",
        ));
    }
    let tech_id = user.tech_id.unwrap();
    let key = tech_id;
    if !body.enabled {
        state.store.delete_field_position(tech_id).map_err(|_| {
            HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Cannot stop location sharing",
            )
        })?;
        state
            .engineer_locations
            .lock()
            .map_err(|_| {
                HttpError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Location service unavailable.",
                )
            })?
            .remove(&key);
        state.realtime.publish(
            EventKind::StateDelta,
            Audience::Role("dispatcher".into()),
            Some(ActorRef {
                user_id: user.id,
                role: user.role,
            }),
            Some(EntityRef {
                kind: "technician_location".into(),
                id: tech_id.to_string(),
                version: 1,
            }),
            json!({"removed":true,"tech_id":tech_id}),
        );
        return Ok(Json(json!({"ok":true,"sharing":false})));
    }
    if !user.on_shift {
        return Err(HttpError(
            StatusCode::CONFLICT,
            "Start your shift before sharing live location.",
        ));
    }
    let (Some(latitude), Some(longitude)) = (body.latitude, body.longitude) else {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "A GPS fix is required to share your location.",
        ));
    };
    let accuracy = body.accuracy.unwrap_or(1000.0);
    if !latitude.is_finite()
        || !(-90.0..=90.0).contains(&latitude)
        || !longitude.is_finite()
        || !(-180.0..=180.0).contains(&longitude)
        || !accuracy.is_finite()
        || !(0.0..=100_000.0).contains(&accuracy)
        || body.heading.is_some_and(|v| !v.is_finite())
        || body.speed.is_some_and(|v| !v.is_finite())
    {
        return Err(HttpError(StatusCode::BAD_REQUEST, "GPS fix is invalid."));
    }
    let mut locations = state.engineer_locations.lock().map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Location service unavailable.",
        )
    })?;
    let now = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
    let fix = field::Fix {
        kind: "engineer".into(),
        agent_id: tech_id.to_string(),
        latitude,
        longitude,
        accuracy,
        observed_ms: body.observed_ms.unwrap_or(now),
    };
    if !(now - 30_000..=now + 5_000).contains(&fix.observed_ms) {
        state.store.append_audit(&format!("gps-error:{tech_id}:{now}"), None, "data_reception_error",
            &json!({"tech_id":tech_id,"observed_ms":fix.observed_ms,"reason":"timestamp_out_of_range"}))
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка записи аудита"))?;

        return Err(HttpError(StatusCode::BAD_REQUEST, "Stale GPS fix"));
    }
    if !state
        .store
        .record_fix(&fix)
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "GPS storage unavailable"))?
    {
        return Ok(Json(json!({"ok":true,"accepted":false})));
    }
    field::apply_fix(&state, &fix, &user)?;
    let mut track = locations
        .get(&key)
        .map(|(last, _)| last.track.clone())
        .unwrap_or_default();
    if track.last().map_or(true, |last| {
        coordinate_distance_m(*last, [latitude, longitude]) >= 2.0
    }) {
        track.push([latitude, longitude]);
        if track.len() > 120 {
            let excess = track.len() - 120;
            track.drain(..excess);
        }
    }
    let position = EngineerLocation {
        tech_id,
        user_id: user.id,
        name: user.name.clone(),
        latitude,
        longitude,
        accuracy,
        heading: body.heading.filter(|v| *v >= 0.0 && *v <= 360.0),
        speed: body.speed.filter(|v| *v >= 0.0 && *v <= 1000.0),
        updated_at_ms: (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as u64,
        track,
    };
    locations.insert(key, (position.clone(), std::time::Instant::now()));
    drop(locations);
    state.realtime.publish(
        EventKind::StateDelta,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: user.id,
            role: user.role,
        }),
        Some(EntityRef {
            kind: "technician_location".into(),
            id: tech_id.to_string(),
            version: 1,
        }),
        serde_json::to_value(&position).unwrap_or(Value::Null),
    );
    Ok(Json(
        json!({"ok":true,"sharing":true,"updated_at_ms":position.updated_at_ms}),
    ))
}

fn coordinate_distance_m(a: [f64; 2], b: [f64; 2]) -> f64 {
    let radians = |value: f64| value.to_radians();
    let dlat = radians(b[0] - a[0]);
    let dlon = radians(b[1] - a[1]);
    let lat1 = radians(a[0]);
    let lat2 = radians(b[0]);
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    6_371_000.0 * 2.0 * h.sqrt().atan2((1.0 - h).sqrt())
}

async fn engineer_locations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<EngineerLocation>>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    let mut locations = state.engineer_locations.lock().map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Location service unavailable.",
        )
    })?;
    locations.retain(|_, (_, updated)| updated.elapsed() < std::time::Duration::from_secs(45));
    Ok(Json(
        locations
            .values()
            .map(|(position, _)| position.clone())
            .collect(),
    ))
}

async fn state_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = session_user(&state, &headers).await?;
    if user.role == "security" {
        return Ok(Json(json!({"me":user})));
    }
    let store = state.store.clone();
    let query_user = user.clone();
    let (requests, engineers, registrations) = task::spawn_blocking(move || {
        Ok::<_, rusqlite::Error>((
            store.requests_for(&query_user)?,
            store.active_engineers()?,
            store.pending_engineers()?,
        ))
    })
    .await
    .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
    .map_err(|error| {
        eprintln!("failed to read airport operation state: {error}");
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось собрать состояние смены",
        )
    })?;
    let mut snapshot = state.engine.snapshot(&requests, &engineers, Some(&user));
    if snapshot["sim_running"] == false {
        if let Ok(locations) = state.engineer_locations.lock() {
            for tech in snapshot["techs"].as_array_mut().into_iter().flatten() {
                if let Some((location, received)) = tech["id"].as_i64().and_then(|id| locations.get(&id)) {
                    if received.elapsed().as_secs() < 30 {
                        tech["speed_kmh"] = location.speed.filter(|s| s.is_finite() && *s >= 0.0).map_or(Value::Null, |s| json!(s * 3.6));
                        tech["speed_source"] = json!("gps");
                    }
                }
            }
        }
    }

    if user.role == "dispatcher" {
        let audit_store = state.store.clone();
        let audit_requests = snapshot["active"].as_array().cloned().unwrap_or_default();
        task::spawn_blocking(move || -> rusqlite::Result<()> {
            for request in audit_requests {
                let Some(id) = request["id"].as_i64() else { continue };
                let version = request["version"].as_i64().unwrap_or(0);
                if request["status"] == "waiting" {
                    audit_store.append_audit(&format!("candidates:{id}:{version}"), Some(id), "candidates_formed",
                        &json!({"candidates":request["candidates"],"duration_ms":request["candidate_generation_ms"],"stand":request["stand"],"qualification":request["qual"],"rejected":request["rejected_candidates"]}))?;
                }
                if request["status"] == "enroute" || request["status"] == "assigned" {
                    audit_store.append_audit(&format!("route:{id}:{version}"), Some(id), "route_built",
                        &json!({"tech_id":request["tech_id"],"eta_seconds":request["eta"],"mode":request["travel_mode"],"via":request["via"],"available":request["route_available"]}))?;
                }
            }
            Ok(())
        }).await.map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка записи аудита"))?
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка записи аудита"))?;
    }
    snapshot["me"] = serde_json::to_value(&user).unwrap_or(serde_json::Value::Null);
    snapshot["carpet"] = json!(state
        .store
        .carpet_active()
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка режима доступа"))?);
    snapshot["registrations"] =
        serde_json::to_value(registrations).unwrap_or_else(|_| serde_json::json!([]));
    Ok(Json(snapshot))
}

async fn update_simulation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SimulationBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    let result = state
        .engine
        .set_sim(body.speed, body.running, body.spawn_at_terminal)
        .map_err(|_| HttpError(StatusCode::BAD_REQUEST, "Недопустимая скорость симуляции"))?;
    state.realtime.publish(
        EventKind::StateDelta,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: user.id,
            role: user.role.clone(),
        }),
        Some(EntityRef {
            kind: "simulation".into(),
            id: "airport".into(),
            version: 1,
        }),
        result.clone(),
    );
    Ok(Json(
        serde_json::json!({ "ok": true, "simulation": result }),
    ))
}

async fn set_edge_blocked(
    State(state): State<AppState>,
    Path(edge_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<EdgeBlockBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    state
        .engine
        .set_edge_blocked(&edge_id, body.blocked)
        .map_err(|_| HttpError(StatusCode::NOT_FOUND, "Ребро карты не найдено"))?;
    let kind = if body.blocked {
        EventKind::RouteBlocked
    } else {
        EventKind::RouteCleared
    };
    state.store.append_audit(&format!("edge:{}:{}", edge_id, now_rfc3339()), None, "route_recalculated",
        &json!({"edge_id":edge_id,"blocked":body.blocked,"actor_id":user.id}))
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка записи аудита"))?;
    state.realtime.publish(
        kind,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: user.id,
            role: user.role.clone(),
        }),
        Some(EntityRef {
            kind: "edge".into(),
            id: edge_id.clone(),
            version: 1,
        }),
        serde_json::json!({ "edge_id": edge_id, "blocked": body.blocked }),
    );
    state.realtime.publish(
        kind,
        Audience::Role("engineer".into()),
        Some(ActorRef {
            user_id: user.id,
            role: user.role,
        }),
        Some(EntityRef {
            kind: "edge".into(),
            id: edge_id.clone(),
            version: 1,
        }),
        serde_json::json!({ "edge_id": edge_id, "blocked": body.blocked }),
    );
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn move_technician(
    State(state): State<AppState>,
    Path(tech_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<TechPositionBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    if !body.x.is_finite()
        || !body.y.is_finite()
        || body.x.abs() > 100_000.0
        || body.y.abs() > 100_000.0
    {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Некорректные координаты специалиста",
        ));
    }
    let store_for_lookup = state.store.clone();
    let exists = task::spawn_blocking(move || store_for_lookup.engineer_user_id(tech_id))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .is_some();
    if !exists && !state.engine.has_tech(tech_id) {
        return Err(HttpError(StatusCode::NOT_FOUND, "Специалист не найден"));
    }
    let x = body.x;
    let y = body.y;
    let store = state.store.clone();
    task::spawn_blocking(move || store.save_technician_positions(&[(tech_id, x, y)]))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось сохранить положение специалиста",
            )
        })?;
    let position = state.engine.move_tech(tech_id, x, y).map_err(|_| {
        HttpError(
            StatusCode::BAD_REQUEST,
            "Не удалось переместить специалиста",
        )
    })?;
    state.realtime.publish(
        EventKind::StateDelta,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: user.id,
            role: user.role.clone(),
        }),
        Some(EntityRef {
            kind: "technician".into(),
            id: tech_id.to_string(),
            version: 1,
        }),
        position.clone(),
    );
    state.realtime.publish(
        EventKind::StateDelta,
        Audience::Role("engineer".into()),
        None,
        Some(EntityRef {
            kind: "technician".into(),
            id: tech_id.to_string(),
            version: 1,
        }),
        position.clone(),
    );
    Ok(Json(position))
}

async fn update_technician_profile(
    State(state): State<AppState>,
    Path(tech_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<TechProfileBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    if !["Планер", "Двигатель", "Авионика"].contains(&body.qual.as_str()) || body.types.len() > 32
    {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Проверьте квалификацию и список типов бортов",
        ));
    }
    let store = state.store.clone();
    let types = body.types.clone();
    let qual = body.qual.clone();
    let update =
        task::spawn_blocking(move || store.update_engineer_tech_profile(tech_id, &qual, &types))
            .await
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
            .map_err(|_| {
                HttpError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Не удалось сохранить квалификацию",
                )
            })?;
    if update.is_none() && !state.engine.has_tech(tech_id) {
        return Err(HttpError(StatusCode::NOT_FOUND, "Специалист не найден"));
    }
    let profile = state
        .engine
        .update_tech_profile(tech_id, &body.qual, &body.types)
        .map_err(|_| {
            HttpError(
                StatusCode::BAD_REQUEST,
                "Не удалось обновить профиль специалиста",
            )
        })?;
    state.realtime.publish(
        EventKind::StateDelta,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: user.id,
            role: user.role.clone(),
        }),
        Some(EntityRef {
            kind: "technician".into(),
            id: tech_id.to_string(),
            version: 2,
        }),
        profile.clone(),
    );
    Ok(Json(profile))
}

async fn spawn_aircraft(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    let aircraft = state
        .engine
        .spawn_aircraft()
        .map_err(|_| HttpError(StatusCode::CONFLICT, "Нет свободных стоянок"))?;
    let id = aircraft
        .get("id")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or_default();
    state.realtime.publish(
        EventKind::AircraftArrived,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: user.id,
            role: user.role,
        }),
        Some(EntityRef {
            kind: "aircraft".into(),
            id: id.to_string(),
            version: 1,
        }),
        aircraft.clone(),
    );
    Ok(Json(aircraft))
}

async fn depart_aircraft(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    state
        .engine
        .depart_aircraft(id)
        .map_err(|_| HttpError(StatusCode::NOT_FOUND, "Борт не найден"))?;
    state.realtime.publish(
        EventKind::AircraftDeparted,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: user.id,
            role: user.role,
        }),
        Some(EntityRef {
            kind: "aircraft".into(),
            id: id.to_string(),
            version: 2,
        }),
        serde_json::json!({ "id": id }),
    );
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn reset_simulation(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    state.engine.reset().map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "?? ??????? ???????? ?????????",
        )
    })?;
    state.realtime.publish(
        EventKind::StateSnapshot,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: user.id,
            role: user.role,
        }),
        Some(EntityRef {
            kind: "simulation".into(),
            id: "airport".into(),
            version: 1,
        }),
        serde_json::json!({ "reset": true }),
    );
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn route_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RoutePreviewBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let _user = authenticated_user(&state, &headers).await?;
    if state
        .store
        .carpet_active()
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка режима доступа"))?
    {
        return Err(HttpError(
            StatusCode::LOCKED,
            "План Ковёр: движение закрыто",
        ));
    }
    let mut blocked_edges = body.blocked_edges;
    blocked_edges.extend(state.engine.blocked_edges().map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось прочитать состояние маршрутов",
        )
    })?);
    if body.via.len() > 32 {
        return Err(HttpError(StatusCode::BAD_REQUEST, "Не более 32 остановок"));
    }
    let route = state
        .airport_graph
        .journey(
            &body.from,
            &body.via,
            &body.to,
            &blocked_edges,
            body.vehicle_available,
        )
        .ok_or(HttpError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Маршрут не найден",
        ))?;
    let points: Vec<serde_json::Value> = route
        .nodes
        .iter()
        .filter_map(|id| {
            state.airport_graph.node(id).map(|node| {
                serde_json::json!({ "id": node.id, "x": node.position.x, "y": node.position.y })
            })
        })
        .collect();
    Ok(Json(serde_json::json!({
        "nodes": route.nodes,
        "points": points,
        "cost": (route.distance_m * 1000.0).round() as u64,
        "distance_m": route.distance_m, "eta_seconds": route.eta_seconds, "mode": route.mode,
    })))
}

async fn list_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let store = state.store.clone();
    let requests = task::spawn_blocking(move || store.requests_for(&user))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось загрузить заявки",
            )
        })?;
    Ok(Json(serde_json::json!({ "requests": requests })))
}

async fn create_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateRequestBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let actor = authenticated_user(&state, &headers).await?;
    require_dispatcher(&actor)?;
    if body.stand.trim().is_empty() || body.description.trim().is_empty() {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Укажите стоянку и описание неисправности",
        ));
    }
    if !matches!(
        body.priority.as_str(),
        "low" | "normal" | "high" | "critical" | "emergency"
    ) {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Некорректный приоритет заявки",
        ));
    }
    // ТЗ: квалификация определяется по описанию неисправности, если диспетчер её не задал.
    let mut body = body;
    if body.via.len() > 32
        || body
            .via
            .iter()
            .any(|node| state.airport_graph.node(node).is_none())
    {
        return Err(HttpError(StatusCode::BAD_REQUEST, "Недопустимая остановка"));
    }
    if body.qual.trim().is_empty() || body.qual.trim().eq_ignore_ascii_case("auto") {
        body.qual =
            classify_qualification(&format!("{} {}", body.description, body.extra)).to_owned();
    }
    if body.tech_id.is_some() {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Сначала создайте заявку, затем назначьте инженера",
        ));
    }
    let store = state.store.clone();
    let requested_tech_id = body.tech_id;
    let request_actor = actor.clone();
    let request = task::spawn_blocking(move || {
        store.create_request(
            NewRequest {
                via: body.via,
                actor_id: request_actor.id,
                actor_role: request_actor.role,
                stand: body.stand.trim().to_owned(),
                description: body.description.trim().to_owned(),
                qual: body.qual.trim().to_owned(),
                extra: body.extra.trim().to_owned(),
                priority: body.priority,
            },
            0,
        )
    })
    .await
    .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
    .map_err(|_| {
        if requested_tech_id.is_some() {
            HttpError(
                StatusCode::CONFLICT,
                "Engineer became unavailable; refresh and retry",
            )
        } else {
            HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Request creation failed")
        }
    })?;
    let payload = serde_json::to_value(&request).unwrap_or(serde_json::Value::Null);
    state.realtime.publish(
        EventKind::RequestCreated,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: actor.id,
            role: actor.role,
        }),
        Some(EntityRef {
            kind: "request".into(),
            id: request.id.to_string(),
            version: request.version as u64,
        }),
        payload.clone(),
    );
    let engineer_audience = if let Some(tech_id) = request.tech_id {
        let store = state.store.clone();
        task::spawn_blocking(move || store.engineer_user_id(tech_id))
            .await
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
            .map(Audience::User)
            .unwrap_or_else(|| Audience::Role("engineer".into()))
    } else {
        Audience::Role("engineer".into())
    };
    state.realtime.publish(
        if request.tech_id.is_some() {
            EventKind::RequestAssigned
        } else {
            EventKind::RequestCreated
        },
        engineer_audience,
        None,
        Some(EntityRef {
            kind: "request".into(),
            id: request.id.to_string(),
            version: request.version as u64,
        }),
        payload,
    );
    if let Some(tech_id) = request.tech_id {
        let store = state.store.clone();
        let recipient = task::spawn_blocking(move || store.engineer_user_id(tech_id))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten();
        if let Some(recipient) = recipient {
            push_user(
                &state,
                recipient,
                "Новая заявка RampPulse",
                &format!("{} · {}", request.stand, request.description),
                json!({"kind":"request","request_id":request.id}),
            );
        }
    }
    Ok(Json(
        serde_json::json!({ "id": request.id, "status": request.status, "request": request }),
    ))
}

#[derive(Deserialize)]
struct SecurityChange {
    device: Option<String>,
    enabled: bool,
}

async fn security_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = session_user(&state, &headers).await?;
    if user.role != "security" {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Доступ только службе безопасности",
        ));
    }
    let store = state.store.clone();
    let data = task::spawn_blocking(move || store.security_status())
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка базы"))?;
    Ok(Json(data))
}

async fn security_change(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SecurityChange>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = session_user(&state, &headers).await?;
    if user.role != "security" {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Доступ только службе безопасности",
        ));
    }
    let token = session_from_headers(&headers)
        .ok_or(HttpError(StatusCode::UNAUTHORIZED, "Требуется вход"))?;
    let store = state.store.clone();
    task::spawn_blocking(move || store.security_change(user.id, body.device, body.enabled, &token))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::CONFLICT, "Изменение запрещено"))?;
    Ok(Json(json!({"ok":true})))
}

async fn request_journal(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_dispatcher(&authenticated_user(&state, &headers).await?)?;
    let store = state.store.clone();
    let rows = task::spawn_blocking(move || store.journal())
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка журнала"))?;
    Ok(Json(
        json!({"columns":["Время UTC","Заявка","Пользователь","Роль","Событие","Из статуса","В статус","Детали"],"rows":rows}),
    ))
}

async fn assign_request(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<RequestAssignBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let actor = authenticated_user(&state, &headers).await?;
    require_dispatcher(&actor)?;
    let store = state.store.clone();
    let assignment_actor = actor.clone();
    let request = task::spawn_blocking(move || {
        store.assign_request(id, body.tech_id, &assignment_actor, body.confirm_reassignment)
    })
    .await
    .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "server error"))?
    .map_err(|_| {
        HttpError(
            StatusCode::CONFLICT,
            "Engineer unavailable or request cannot be reassigned",
        )
    })?;
    let payload = serde_json::to_value(&request).unwrap_or(Value::Null);
    let entity = Some(EntityRef {
        kind: "request".into(),
        id: request.id.to_string(),
        version: request.version as u64,
    });
    let announcement_store = state.store.clone();
    let announcement_actor = actor.clone();
    let announcement_body = format!("Назначение заявки №{}: {} → {}. {}", request.id, request.tech_name, request.stand, request.description);
    let announcement = task::spawn_blocking(move || {
        let room = announcement_store.chat_rooms(&announcement_actor)?.into_iter().find(|room| room.kind == "shift")
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let message = announcement_store.chat_messages(room.id, &announcement_actor, 100)?.into_iter()
            .rev().find(|message| message.body == announcement_body && message.sender_id == announcement_actor.id)
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let recipients = announcement_store.chat_recipients(room.id, announcement_actor.id)?;
        Ok::<_, rusqlite::Error>((message, recipients))
    }).await;
    if let Ok(Ok((message, recipients))) = announcement {
        for recipient in recipients {
            state.realtime.publish(EventKind::ChatMessageCreated, Audience::User(recipient),
                Some(ActorRef { user_id: actor.id, role: actor.role.clone() }),
                Some(EntityRef { kind: "chat_message".into(), id: message.id.to_string(), version: 1 }),
                serde_json::to_value(&message).unwrap_or(Value::Null));
        }
    }
    let event_actor = Some(ActorRef { user_id: actor.id, role: actor.role });
    state.realtime.publish(
        EventKind::RequestAssigned, Audience::Role("dispatcher".into()),
        event_actor.clone(), entity.clone(), payload.clone(),
    );
    let store = state.store.clone();
    let tech_id = request.tech_id.unwrap_or(body.tech_id);
    if let Ok(Ok(Some(user_id))) = task::spawn_blocking(move || store.engineer_user_id(tech_id)).await {
        state.realtime.publish(
            EventKind::RequestAssigned, Audience::User(user_id),
            event_actor, entity, payload,
        );
        push_user(&state, user_id, "У вас новая заявка",
            &format!("Заявка №{} · {}", request.id, request.stand),
            json!({"kind":"request","request_id":request.id}));
    }
    Ok(Json(serde_json::json!({"request": request})))
}

async fn change_request_status(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<RequestStatusBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let actor = authenticated_user(&state, &headers).await?;
    let store = state.store.clone();
    let operation_actor = actor.clone();
    let next_status = body.status;
    let confirmed = body.confirm_shift_lead;
    let request = task::spawn_blocking(move || {
        store.transition_request_with_confirmation(id, &next_status, &operation_actor, confirmed)
    })
    .await
    .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => HttpError(
            StatusCode::NOT_FOUND,
            "Заявка не найдена или назначена другому инженеру",
        ),
        _ => HttpError(StatusCode::CONFLICT, "Недопустимый переход статуса заявки"),
    })?;
    let kind = if request.status == "done" {
        EventKind::RequestCompleted
    } else {
        EventKind::RequestStatusChanged
    };
    let payload = serde_json::to_value(&request).unwrap_or(serde_json::Value::Null);
    state.realtime.publish(
        kind,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: actor.id,
            role: actor.role.clone(),
        }),
        Some(EntityRef {
            kind: "request".into(),
            id: request.id.to_string(),
            version: request.version as u64,
        }),
        payload.clone(),
    );
    let engineer_audience = if let Some(tech_id) = request.tech_id {
        let store = state.store.clone();
        task::spawn_blocking(move || store.engineer_user_id(tech_id))
            .await
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
            .map(Audience::User)
            .unwrap_or_else(|| Audience::Role("engineer".into()))
    } else {
        Audience::Role("engineer".into())
    };
    state.realtime.publish(
        kind,
        engineer_audience,
        Some(ActorRef {
            user_id: actor.id,
            role: actor.role,
        }),
        Some(EntityRef {
            kind: "request".into(),
            id: request.id.to_string(),
            version: request.version as u64,
        }),
        payload,
    );
    Ok(Json(serde_json::json!({ "ok": true, "request": request })))
}

async fn set_shift(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ShiftBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let actor = authenticated_user(&state, &headers).await?;
    if actor.role != "engineer" {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Выход на смену доступен инженеру",
        ));
    }
    let store = state.store.clone();
    let actor_id = actor.id;
    let is_on_shift = body.on_shift;
    let result = task::spawn_blocking(move || store.set_shift(actor_id, is_on_shift))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|failure| match failure {
            ShiftFailure::ActiveRequest => HttpError(
                StatusCode::CONFLICT,
                "Завершите активную заявку перед уходом со смены",
            ),
            ShiftFailure::NotEngineer => {
                HttpError(StatusCode::FORBIDDEN, "Активный профиль инженера не найден")
            }
            ShiftFailure::Storage => HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось обновить смену",
            ),
        })?;
    state.realtime.publish(
        if is_on_shift {
            EventKind::ShiftStarted
        } else {
            EventKind::ShiftEnded
        },
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: actor.id,
            role: actor.role.clone(),
        }),
        Some(EntityRef {
            kind: "user".into(),
            id: actor.id.to_string(),
            version: 1,
        }),
        serde_json::json!({ "user_id": actor.id, "on_shift": is_on_shift }),
    );
    Ok(Json(
        serde_json::json!({ "ok": true, "on_shift": result.on_shift, "user": result }),
    ))
}

async fn legacy_request_status(
    state: AppState,
    headers: HeaderMap,
    id: i64,
    status: &'static str,
    role: &'static str,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    if user.role != role {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Недостаточно прав для изменения заявки",
        ));
    }
    change_request_status(
        State(state),
        Path(id),
        headers,
        Json(RequestStatusBody {
            status: status.into(),
            confirm_shift_lead: false,
        }),
    )
    .await
}

async fn dispatcher_request_arrive(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    legacy_request_status(state, headers, id, "arrived", "dispatcher").await
}
async fn dispatcher_request_start(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    legacy_request_status(state, headers, id, "working", "dispatcher").await
}
async fn dispatcher_request_resolve(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    legacy_request_status(state, headers, id, "done", "dispatcher").await
}
async fn dispatcher_request_cancel(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    legacy_request_status(state, headers, id, "cancelled", "dispatcher").await
}
async fn engineer_request_decline(
    State(state): State<AppState>, Path(id): Path<i64>, headers: HeaderMap,
    Json(body): Json<DeclineRequestBody>,
) -> Result<Json<Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    if user.role != "engineer" { return Err(HttpError(StatusCode::FORBIDDEN,"Отказ доступен только инженеру")); }
    let reason = body.reason.trim().to_owned();
    if !(3..=1000).contains(&reason.chars().count()) {
        return Err(HttpError(StatusCode::BAD_REQUEST,"Укажите причину отказа: от 3 до 1000 символов"));
    }
    let store = state.store.clone(); let actor = user.clone(); let decline_reason = reason.clone();
    let request = task::spawn_blocking(move || store.decline_request(id,&decline_reason,&actor)).await
        .map_err(|_|HttpError(StatusCode::INTERNAL_SERVER_ERROR,"Ошибка сервера"))?
        .map_err(|_|HttpError(StatusCode::CONFLICT,"Отказ невозможен: заявка уже изменена, назначена другому инженеру или работа начата"))?;
    if let Some(tech_id)=user.tech_id { state.engine.stop_request_route(tech_id,id); }
    let payload=json!({"id":id,"status":"waiting","event":"declined","reason":reason,"engineer":user.name});
    let entity=Some(EntityRef{kind:"request".into(),id:id.to_string(),version:request.version as u64});
    let actor=Some(ActorRef{user_id:user.id,role:user.role.clone()});
    for audience in [Audience::Role("dispatcher".into()),Audience::User(user.id)] {
        state.realtime.publish(EventKind::RequestStatusChanged,audience,actor.clone(),entity.clone(),payload.clone());
    }
    // The announcement is committed with the refusal; publish the saved message to chat clients.
    let store=state.store.clone();let chat_actor=user.clone();
    if let Ok(Ok(messages))=task::spawn_blocking(move || {
        let room=store.chat_rooms(&chat_actor)?.into_iter().find(|r|r.kind=="shift").ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let message=store.chat_messages(room.id,&chat_actor,100)?.into_iter().rev()
            .find(|m|m.sender_id==chat_actor.id && m.body.starts_with(&format!("Отказ от заявки №{} ·",id)))
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        Ok::<_,rusqlite::Error>((message,store.chat_recipients(room.id,chat_actor.id)?))
    }).await {
        let (message,recipients)=messages;
        for recipient in recipients {
            state.realtime.publish(EventKind::ChatMessageCreated,Audience::User(recipient),actor.clone(),
                Some(EntityRef{kind:"chat_message".into(),id:message.id.to_string(),version:1}),serde_json::to_value(&message).unwrap_or(Value::Null));
        }
    }
    Ok(Json(json!({"ok":true,"request":request})))
}

async fn engineer_request_arrive(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    legacy_request_status(state, headers, id, "arrived", "engineer").await
}
async fn engineer_request_start(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    legacy_request_status(state, headers, id, "working", "engineer").await
}
async fn engineer_request_resolve(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    legacy_request_status(state, headers, id, "done", "engineer").await
}

async fn engineer_shift_start(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    set_shift(State(state), headers, Json(ShiftBody { on_shift: true })).await
}
async fn engineer_shift_end(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    set_shift(State(state), headers, Json(ShiftBody { on_shift: false })).await
}

async fn chat_rooms(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let store = state.store.clone();
    let rooms = task::spawn_blocking(move || store.chat_rooms(&user))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось загрузить чаты",
            )
        })?;
    Ok(Json(serde_json::json!({"rooms":rooms})))
}

async fn chat_contacts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let store = state.store.clone();
    let online: HashSet<i64> = state.realtime.online_users().into_iter().collect();
    let contacts = task::spawn_blocking(move || store.chat_contacts(&user))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось загрузить сотрудников",
            )
        })?;
    let contacts: Vec<_> = contacts
        .into_iter()
        .map(|mut contact| {
            contact.online = online.contains(&contact.id);
            contact
        })
        .collect();
    Ok(Json(serde_json::json!({"contacts":contacts})))
}

async fn create_direct_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<DirectRoomBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let store = state.store.clone();
    let room = task::spawn_blocking(move || store.direct_room(user.id, body.peer_id))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::BAD_REQUEST,
                "Личный чат доступен только между диспетчером и активным инженером",
            )
        })?;
    Ok(Json(serde_json::json!({"room":room})))
}

async fn chat_messages(
    State(state): State<AppState>,
    Path(room_id): Path<i64>,
    Query(query): Query<MessageQuery>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let store = state.store.clone();
    let messages = task::spawn_blocking(move || {
        store.chat_messages(room_id, &user, query.limit.unwrap_or(50))
    })
    .await
    .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
    .map_err(|_| HttpError(StatusCode::FORBIDDEN, "Нет доступа к этому чату"))?;
    Ok(Json(serde_json::json!({"messages":messages})))
}

async fn send_chat_message(
    State(state): State<AppState>,
    Path(room_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<ChatMessageBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let kind = body.kind.trim().to_lowercase();
    let content = body.content.trim().to_owned();
    if (kind == "text" && (content.is_empty() || content.len() > 2000))
        || (!matches!(kind.as_str(), "text" | "sticker" | "file" | "voice"))
        || (matches!(kind.as_str(), "file" | "voice") && body.attachment_id.is_none())
    {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Некорректное содержимое сообщения",
        ));
    }
    let allowed_stickers = [
        "accepted", "enroute", "delay", "ready", "help", "tools", "engine", "power", "check",
        "radio", "fuel", "tow", "warning", "medical", "done", "stand",
    ];
    if kind == "sticker" && !allowed_stickers.contains(&content.as_str()) {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Неизвестный тип сообщения или стикер",
        ));
    }
    let store = state.store.clone();
    let operation_user = user.clone();
    let actor_role = user.role.clone();
    let attachment_id = body.attachment_id;
    let duration = body.duration;
    let (message, recipients) = task::spawn_blocking(move || {
        store.send_chat_message(
            room_id,
            &operation_user,
            &kind,
            &content,
            attachment_id.as_deref(),
            duration,
        )
    })
    .await
    .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
    .map_err(|_| HttpError(StatusCode::FORBIDDEN, "Нет доступа к этому чату"))?;
    let payload = serde_json::to_value(&message).unwrap_or(serde_json::Value::Null);
    for recipient in recipients {
        state.realtime.publish(
            EventKind::ChatMessageCreated,
            Audience::User(recipient),
            Some(ActorRef {
                user_id: message.sender_id,
                role: actor_role.clone(),
            }),
            Some(EntityRef {
                kind: "chat_message".into(),
                id: message.id.to_string(),
                version: 1,
            }),
            payload.clone(),
        );
        push_user(
            &state,
            recipient,
            if message.kind == "voice" {
                "Голосовое сообщение RampPulse"
            } else {
                "Сообщение RampPulse"
            },
            if message.kind == "text" {
                &message.body
            } else {
                &message.content
            },
            json!({"kind":"chat","room_id":room_id,"message_id":message.id}),
        );
    }
    Ok(Json(serde_json::json!({"message":message})))
}

async fn upload_chat_attachment(
    State(state): State<AppState>,
    Path(room_id): Path<i64>,
    request: Request,
) -> Result<Json<serde_json::Value>, HttpError> {
    let (parts, body) = request.with_limited_body().into_parts();
    let headers = parts.headers;
    let user = authenticated_user(&state, &headers).await?;
    let access_store = state.store.clone();
    let user_id = user.id;
    task::spawn_blocking(move || access_store.chat_room_access(room_id, user_id))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::FORBIDDEN, "Нет доступа к этому чату"))?;

    let kind = headers
        .get("x-chat-kind")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("file")
        .to_owned();
    let duration = headers
        .get("x-chat-duration")
        .and_then(|value| value.to_str().ok())
        .map(str::parse::<i64>)
        .transpose()
        .map_err(|_| HttpError(StatusCode::BAD_REQUEST, "Некорректная длительность"))?;
    let original_name = headers
        .get("x-chat-file-name")
        .and_then(|value| value.to_str().ok())
        .and_then(percent_decode)
        .unwrap_or_else(|| "Вложение".into());
    let supplied_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream");
    let media_type = normalized_upload_type(&supplied_type, &original_name).ok_or(HttpError(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "Этот формат файла не поддерживается",
    ))?;
    if kind != "file" && kind != "voice" {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Неизвестный тип вложения",
        ));
    }
    if kind == "voice"
        && (!media_type.starts_with("audio/") || !duration.is_some_and(|s| (1..=600).contains(&s)))
    {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Голосовое сообщение должно длиться от 1 до 600 секунд",
        ));
    }
    if kind == "file" && duration.is_some() {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Для файла не задаётся длительность",
        ));
    }
    let file_name = safe_upload_name(&original_name);
    let extension = extension_for_media(&media_type);
    let id = Uuid::new_v4().to_string();
    let storage_name = format!("{id}.{extension}");
    let path = state.attachments_dir.join(&storage_name);
    let temporary_path = state.attachments_dir.join(format!(".{id}.part"));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .await
        .map_err(|_| {
            HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось сохранить файл",
            )
        })?;
    let mut stream = body.into_data_stream();
    let mut byte_size = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                drop(file);
                let _ = tokio::fs::remove_file(&temporary_path).await;
                return Err(HttpError(StatusCode::BAD_REQUEST, "Повреждённый файл"));
            }
        };
        byte_size = byte_size.saturating_add(chunk.len() as u64);
        if byte_size > CHAT_ATTACHMENT_LIMIT {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary_path).await;
            return Err(HttpError(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Файл должен быть меньше 100 МБ",
            ));
        }
        if file.write_all(&chunk).await.is_err() {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary_path).await;
            return Err(HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось сохранить файл",
            ));
        }
    }
    if byte_size == 0 {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(HttpError(StatusCode::BAD_REQUEST, "Файл пуст"));
    }
    if file.flush().await.is_err() {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось сохранить файл",
        ));
    }
    drop(file);
    if tokio::fs::rename(&temporary_path, &path).await.is_err() {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось сохранить файл",
        ));
    }

    let store = state.store.clone();
    let attachment_id = id.clone();
    let saved_name = file_name.clone();
    let stored_type = media_type.clone();
    let byte_size = byte_size as i64;
    let saved_storage_name = storage_name.clone();
    let created = task::spawn_blocking(move || {
        store.create_chat_attachment(
            &attachment_id,
            room_id,
            user_id,
            &saved_name,
            &stored_type,
            byte_size,
            &saved_storage_name,
        )
    })
    .await;
    let created = match created {
        Ok(Ok(())) => Ok(()),
        _ => Err(HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось зарегистрировать вложение",
        )),
    };
    if let Err(error) = created {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }

    let store = state.store.clone();
    let operation_user = user.clone();
    let kind_for_db = kind.clone();
    let actor_role = user.role.clone();
    let content = file_name.clone();
    let attachment_id_for_db = id.clone();
    let result = task::spawn_blocking(move || {
        store.send_chat_message(
            room_id,
            &operation_user,
            &kind_for_db,
            &content,
            Some(&attachment_id_for_db),
            duration,
        )
    })
    .await;
    let result = match result {
        Ok(Ok(result)) => Ok(result),
        _ => Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Не удалось отправить вложение",
        )),
    };
    let (message, recipients) = match result {
        Ok(result) => result,
        Err(error) => {
            let store = state.store.clone();
            let attachment_id = id.clone();
            let _ =
                task::spawn_blocking(move || store.delete_unlinked_chat_attachment(&attachment_id))
                    .await;
            let _ = tokio::fs::remove_file(&path).await;
            return Err(error);
        }
    };
    let payload = serde_json::to_value(&message).unwrap_or(serde_json::Value::Null);
    for recipient in recipients {
        state.realtime.publish(
            EventKind::ChatMessageCreated,
            Audience::User(recipient),
            Some(ActorRef {
                user_id: message.sender_id,
                role: actor_role.clone(),
            }),
            Some(EntityRef {
                kind: "chat_message".into(),
                id: message.id.to_string(),
                version: 1,
            }),
            payload.clone(),
        );
        push_user(
            &state,
            recipient,
            if message.kind == "voice" {
                "Голосовое сообщение RampPulse"
            } else {
                "Вложение RampPulse"
            },
            &message.content,
            json!({"kind":"chat","room_id":room_id,"message_id":message.id}),
        );
    }
    Ok(Json(serde_json::json!({"message":message})))
}

async fn download_chat_attachment(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let store = state.store.clone();
    let attachment = task::spawn_blocking(move || store.chat_attachment_for_user(&id, user.id))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::NOT_FOUND, "Вложение не найдено"))?;
    let path = state.attachments_dir.join(&attachment.storage_name);
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| HttpError(StatusCode::NOT_FOUND, "Файл вложения не найден"))?;
    let inline =
        attachment.media_type.starts_with("image/") || attachment.media_type.starts_with("audio/");
    let disposition = if inline { "inline" } else { "attachment" };
    let safe_name = attachment.file_name.replace(['\r', '\n', '"', '\\'], "_");
    let mut response = Response::new(axum::body::Body::from(bytes));
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&attachment.media_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    response_headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("{disposition}; filename=\"{safe_name}\""))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=\"download\"")),
    );
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response_headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

fn safe_upload_name(name: &str) -> String {
    let base = std::path::Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Вложение");
    let cleaned = base
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect::<String>();
    if cleaned.trim().is_empty() {
        "Вложение".into()
    } else {
        cleaned
    }
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn normalized_upload_type(supplied: &str, file_name: &str) -> Option<String> {
    let supplied = supplied
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let extension = std::path::Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let inferred = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "tar" => "application/x-tar",
        "gz" => "application/gzip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "odt" => "application/vnd.oasis.opendocument.text",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odp" => "application/vnd.oasis.opendocument.presentation",
        "webm" => "audio/webm",
        "ogg" | "oga" => "audio/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "mpg" | "mpeg" => "video/mpeg",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp4" => "video/mp4",
        _ => "",
    };
    let allowed = matches!(
        supplied.as_str(),
        "image/jpeg"
            | "image/png"
            | "image/webp"
            | "image/gif"
            | "image/bmp"
            | "image/tiff"
            | "application/pdf"
            | "text/plain"
            | "text/markdown"
            | "text/csv"
            | "application/json"
            | "application/xml"
            | "text/xml"
            | "application/zip"
            | "application/x-7z-compressed"
            | "application/vnd.rar"
            | "application/x-rar-compressed"
            | "application/x-tar"
            | "application/gzip"
            | "application/x-gzip"
            | "application/msword"
            | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            | "application/vnd.oasis.opendocument.text"
            | "application/vnd.ms-excel"
            | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            | "application/vnd.oasis.opendocument.spreadsheet"
            | "application/vnd.ms-powerpoint"
            | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            | "application/vnd.oasis.opendocument.presentation"
            | "audio/webm"
            | "audio/ogg"
            | "audio/mpeg"
            | "audio/mp4"
            | "audio/wav"
            | "audio/aac"
            | "audio/flac"
            | "video/mpeg"
            | "video/quicktime"
            | "video/x-matroska"
            | "video/x-msvideo"
            | "video/webm"
            | "video/mp4"
    );
    let media = if allowed { supplied.as_str() } else { inferred };
    (!media.is_empty()).then(|| media.to_owned())
}

fn extension_for_media(media_type: &str) -> &'static str {
    match media_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "text/csv" => "csv",
        "application/json" => "json",
        "application/xml" | "text/xml" => "xml",
        "application/zip" => "zip",
        "application/x-7z-compressed" => "7z",
        "application/vnd.rar" | "application/x-rar-compressed" => "rar",
        "application/x-tar" => "tar",
        "application/gzip" | "application/x-gzip" => "gz",
        "application/msword" => "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.oasis.opendocument.text" => "odt",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.oasis.opendocument.spreadsheet" => "ods",
        "application/vnd.ms-powerpoint" => "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "application/vnd.oasis.opendocument.presentation" => "odp",
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/wav" => "wav",
        "audio/aac" => "aac",
        "audio/flac" => "flac",
        "video/mpeg" => "mpeg",
        "video/quicktime" => "mov",
        "video/x-matroska" => "mkv",
        "video/x-msvideo" => "avi",
        "video/webm" => "webm",
        "video/mp4" => "mp4",
        _ => "bin",
    }
}

async fn mark_chat_read(
    State(state): State<AppState>,
    Path(room_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<ChatReadBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let store = state.store.clone();
    let reader_id = user.id;
    task::spawn_blocking(move || store.mark_chat_read(room_id, reader_id, body.message_id))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::FORBIDDEN, "Нет доступа к этому чату"))?;
    let store = state.store.clone();
    let recipients = task::spawn_blocking(move || store.chat_recipients(room_id, reader_id))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::FORBIDDEN, "Нет доступа к этому чату"))?;
    for recipient in recipients {
        state.realtime.publish(
            EventKind::ChatMessageRead,
            Audience::User(recipient),
            Some(ActorRef { user_id: reader_id, role: user.role.clone() }),
            Some(EntityRef { kind: "chat_room".into(), id: room_id.to_string(), version: body.message_id as u64 }),
            serde_json::json!({ "room_id": room_id, "user_id": reader_id, "message_id": body.message_id }),
        );
    }
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn relay_call_signal(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CallRelayBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let actor = authenticated_user(&state, &headers).await?;
    if body.recipient_id == actor.id
        || !state
            .store
            .can_call(actor.id, body.recipient_id)
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
    {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Звонок доступен только между активным диспетчером и инженером",
        ));
    }
    let signal_kind = body
        .signal
        .get("type")
        .and_then(|v| v.as_str())
        .or_else(|| body.signal.get("kind").and_then(|v| v.as_str()))
        .unwrap_or("");
    let kind = match signal_kind {
        "invite" | "ring" => EventKind::CallInvited,
        "answer" => EventKind::CallAccepted,
        "reject" | "decline" => EventKind::CallRejected,
        "hangup" => EventKind::CallEnded,
        "offer" | "ice" | "busy" => EventKind::CallParticipantChanged,
        _ => {
            return Err(HttpError(
                StatusCode::BAD_REQUEST,
                "Неизвестный тип сигнала звонка",
            ))
        }
    };
    let client_kind = match signal_kind {
        "invite" => "ring",
        "answer" => "answer",
        "reject" => "decline",
        "decline" => "decline",
        "ring" => "ring",
        "hangup" => "hangup",
        "busy" => "busy",
        other => other,
    };
    let mut payload = body.signal.as_object().cloned().unwrap_or_default();
    payload.insert("from_user_id".into(), serde_json::json!(actor.id));
    payload.insert("from_name".into(), serde_json::json!(actor.name));
    payload.insert("kind".into(), serde_json::json!(client_kind));
    if !payload.contains_key("call_id") {
        payload.insert("call_id".into(), serde_json::json!(""));
    }
    let call_id = payload
        .get("call_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    if signal_kind == "invite" && !call_id.is_empty() {
        let store = state.store.clone();
        let data = serde_json::Value::Object(payload.clone());
        let caller = actor.id;
        let recipient = body.recipient_id;
        let save_id = call_id.clone();
        task::spawn_blocking(move || store.save_call_invite(&save_id, caller, recipient, &data))
            .await
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
            .map_err(|_| {
                HttpError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Не удалось сохранить вызов",
                )
            })?;
    } else if matches!(
        signal_kind,
        "answer" | "reject" | "decline" | "hangup" | "busy"
    ) && !call_id.is_empty()
    {
        let store = state.store.clone();
        let clear_id = call_id.clone();
        let _ = task::spawn_blocking(move || store.clear_call_invite(&clear_id)).await;
    }
    state.realtime.publish(
        kind,
        Audience::User(body.recipient_id),
        Some(ActorRef {
            user_id: actor.id,
            role: actor.role.clone(),
        }),
        None,
        serde_json::Value::Object(payload),
    );
    if signal_kind == "invite" {
        push_user(
            &state,
            body.recipient_id,
            "Входящий вызов RampPulse",
            &actor.name,
            json!({"kind":"call","call_id":call_id,"from_user_id":actor.id,"from_name":actor.name}),
        );
    }
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn register_push_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PushDeviceBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let token = body.token.trim().to_owned();
    if token.len() < 32 || token.len() > 4096 || token.chars().any(char::is_whitespace) {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Некорректный токен устройства",
        ));
    }
    let store = state.store.clone();
    task::spawn_blocking(move || store.register_push_device(user.id, &token))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось зарегистрировать устройство",
            )
        })?;
    Ok(Json(json!({"ok":true,"push_enabled":state.push.is_some()})))
}

async fn push_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let _user = authenticated_user(&state, &headers).await?;
    Ok(Json(json!({"enabled": state.push.is_some()})))
}

async fn unregister_push_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PushDeviceBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let token = body.token;
    let store = state.store.clone();
    task::spawn_blocking(move || store.unregister_push_device(user.id, &token))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?;
    Ok(Json(json!({"ok":true})))
}

async fn pending_call_invites(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let store = state.store.clone();
    let invites = task::spawn_blocking(move || store.pending_call_invites(user.id))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось загрузить вызовы",
            )
        })?;
    Ok(Json(json!({"invites":invites})))
}

fn push_user(state: &AppState, user_id: i64, title: &str, body: &str, data: serde_json::Value) {
    let Some(push) = state.push.clone() else {
        return;
    };
    let store = state.store.clone();
    let cleanup_store = state.store.clone();
    let title = title.to_owned();
    let body = body.to_owned();
    tokio::spawn(async move {
        let Ok(Ok(tokens)) = task::spawn_blocking(move || store.push_tokens(user_id)).await else {
            return;
        };
        for token in tokens {
            let push = push.clone();
            let title = title.clone();
            let body = body.clone();
            let data = data.clone();
            let cleanup = cleanup_store.clone();
            tokio::spawn(async move {
                if let Err(e) = push.send(&token, &title, &body, data).await {
                    if e.contains("UNREGISTERED") || e.contains("NOT_FOUND") {
                        let _ =
                            task::spawn_blocking(move || cleanup.remove_push_device(&token)).await;
                    } else {
                        eprintln!("RampPulse push delivery failed: {e}");
                    }
                }
            });
        }
    });
}

async fn call_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let actor = authenticated_user(&state, &headers).await?;
    let mut ice_servers = Vec::new();
    if !state.stun_urls.is_empty() {
        ice_servers.push(serde_json::json!({"urls":state.stun_urls}));
    }
    if !state.turn_urls.is_empty() {
        if let Some(secret) = &state.turn_shared_secret {
            let expires = OffsetDateTime::now_utc().unix_timestamp() + 6 * 60 * 60;
            let username = format!("{expires}:{}", actor.id);
            let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).map_err(|_| {
                HttpError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Ошибка конфигурации связи",
                )
            })?;
            mac.update(username.as_bytes());
            let credential = STANDARD.encode(mac.finalize().into_bytes());
            ice_servers.push(serde_json::json!({
                "urls":state.turn_urls,
                "username":username,
                "credential":credential
            }));
        }
    }
    Ok(Json(serde_json::json!({"ice_servers":ice_servers})))
}

#[derive(Deserialize)]
struct LiveKitTokenBody {
    call_id: String,
}

async fn livekit_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LiveKitTokenBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let actor = authenticated_user(&state, &headers).await?;
    let call_id = Uuid::parse_str(body.call_id.trim())
        .map_err(|_| HttpError(StatusCode::BAD_REQUEST, "Некорректный идентификатор звонка"))?;
    let (Some(url), Some(api_key), Some(api_secret)) = (
        state.livekit_url.as_deref(),
        state.livekit_api_key.as_deref(),
        state.livekit_api_secret.as_deref(),
    ) else {
        return Err(HttpError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Сервис голосовой связи не настроен",
        ));
    };
    let room = format!("rp-{}", call_id.simple());
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let claims = json!({
        "iss": api_key,
        "sub": actor.id.to_string(),
        "name": actor.name,
        "nbf": now - 5,
        "iat": now,
        "exp": now + 600,
        "video": {
            "roomJoin": true,
            "room": room,
            "canPublish": true,
            "canSubscribe": true,
            "canPublishData": true
        }
    });
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось подготовить токен связи",
        )
    })?);
    let signing_input = format!("{header}.{payload}");
    let mut mac = Hmac::<Sha256>::new_from_slice(api_secret.as_bytes()).map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Ошибка конфигурации связи",
        )
    })?;
    mac.update(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    let token = format!("{signing_input}.{signature}");
    Ok(Json(json!({"url": url, "token": token, "room": room})))
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginBody>,
) -> Result<Response, HttpError> {
    let native_client = body.native_client;
    let store = state.store.clone();
    let email = body.email.trim().to_lowercase();
    let password = body.password;
    let guard_key = email.clone();
    {
        let guard = state.login_guard.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(locked) = guard.get(&guard_key).and_then(|a| a.locked_until) {
            if locked > std::time::Instant::now() {
                return Err(HttpError(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Слишком много неудачных попыток. Повторите через минуту",
                ));
            }
        }
    }
    let result = task::spawn_blocking(move || {
        store.authenticate_and_create_session(
            &email,
            &password,
            body.device_id.map(|id| id.to_string()),
        )
    })
    .await
    .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?;
    {
        let mut guard = state.login_guard.lock().unwrap_or_else(|e| e.into_inner());
        let now = std::time::Instant::now();
        if matches!(result, Err(store::AuthFailure::InvalidCredentials)) {
            let entry = guard.entry(guard_key.clone()).or_insert(LoginAttempts {
                failures: 0,
                window_start: now,
                locked_until: None,
            });
            if now.duration_since(entry.window_start) > LOGIN_WINDOW {
                *entry = LoginAttempts {
                    failures: 0,
                    window_start: now,
                    locked_until: None,
                };
            }
            entry.failures += 1;
            if entry.failures >= LOGIN_MAX_FAILURES {
                entry.locked_until = Some(now + LOGIN_LOCK);
                entry.failures = 0;
                entry.window_start = now;
            }
        } else if result.is_ok() {
            guard.remove(&guard_key);
        }
        if guard.len() > 10_000 {
            guard.retain(|_, a| now.duration_since(a.window_start) < LOGIN_WINDOW);
        }
    }
    let (mut user, token) = result.map_err(|error| match error {
        store::AuthFailure::InvalidCredentials => {
            HttpError(StatusCode::UNAUTHORIZED, "Неверный логин или пароль")
        }
        store::AuthFailure::Pending => HttpError(
            StatusCode::FORBIDDEN,
            "Заявка на регистрацию ещё не подтверждена диспетчером",
        ),
        store::AuthFailure::Closed => HttpError(
            StatusCode::FORBIDDEN,
            "Доступ к аккаунту закрыт. Обратитесь к диспетчеру",
        ),
        store::AuthFailure::Storage => {
            HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера")
        }
    })?;

    apply_security_role(&mut user);
    let max_age = SESSION_TTL_SECONDS;
    let (same_site, secure) = if state.cookie_secure {
        ("None", "; Secure")
    } else {
        ("Lax", "")
    };
    let cookie = format!(
        "{COOKIE_NAME}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite={same_site}{secure}"
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie)
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?,
    );
    let redirect = if user.role == "engineer" {
        "/engineer"
    } else {
        "/"
    };
    let response = if native_client {
        serde_json::json!({ "user": user, "redirect": redirect, "token": token })
    } else {
        serde_json::json!({ "user": user, "redirect": redirect })
    };
    Ok((headers, Json(response)).into_response())
}

async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = session_user(&state, &headers).await?;
    Ok(Json(serde_json::json!({ "user": user })))
}

async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    if body.password.len() < 8 || body.password.len() > 200 {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Пароль должен содержать от 8 до 200 символов",
        ));
    }
    if !body.email.contains('@') || body.username.len() < 3 || body.name.trim().is_empty() {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Проверьте имя, email и имя пользователя",
        ));
    }
    let store = state.store.clone();
    let new = NewEngineer {
        email: body.email.trim().to_lowercase(),
        username: body.username.trim().to_lowercase(),
        name: body.name.trim().to_owned(),
        password: body.password,
        qual: body.qual,
        types: body.types,
        base: body.base,
    };
    let result = task::spawn_blocking(move || store.register_engineer(new))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::CONFLICT,
                "Не удалось создать заявку. Проверьте email и имя пользователя.",
            )
        })?;
    state.realtime.publish(
        EventKind::RegistrationSubmitted,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: result.id,
            role: "engineer".into(),
        }),
        Some(EntityRef {
            kind: "registration".into(),
            id: result.id.to_string(),
            version: 1,
        }),
        serde_json::json!({ "user": result.clone() }),
    );
    Ok(Json(serde_json::json!({
        "status": "pending",
        "user": result,
        "message": "Заявка отправлена. Диспетчер подтвердит допуск к смене."
    })))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, HttpError> {
    if let Some(token) = session_from_headers(&headers) {
        let store = state.store.clone();
        task::spawn_blocking(move || store.delete_session(&token))
            .await
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?;
    }
    let (same_site, secure) = if state.cookie_secure {
        ("None", "; Secure")
    } else {
        ("Lax", "")
    };
    let cookie =
        format!("{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite={same_site}{secure}");
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie)
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?,
    );
    Ok((headers, Json(serde_json::json!({ "ok": true }))).into_response())
}

async fn pending_registrations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    let store = state.store.clone();
    let registrations = task::spawn_blocking(move || store.pending_engineers())
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось загрузить заявки",
            )
        })?;
    Ok(Json(serde_json::json!({ "registrations": registrations })))
}

async fn approve_registration(
    State(state): State<AppState>,
    Path(user_id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    let store = state.store.clone();
    let engineer = task::spawn_blocking(move || store.approve_engineer(user_id))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::CONFLICT,
                "Заявку уже обработали или она не найдена",
            )
        })?;
    state.realtime.publish(
        EventKind::RegistrationApproved,
        Audience::Role("dispatcher".into()),
        Some(ActorRef { user_id: user.id, role: user.role.clone() }),
        Some(EntityRef { kind: "registration".into(), id: user_id.to_string(), version: 2 }),
        serde_json::json!({ "user_id": engineer.id, "tech_id": engineer.tech_id, "status": "active" }),
    );
    state.realtime.publish(
        EventKind::RegistrationApproved,
        Audience::User(engineer.id),
        None,
        Some(EntityRef {
            kind: "registration".into(),
            id: user_id.to_string(),
            version: 2,
        }),
        serde_json::json!({ "status": "active" }),
    );
    Ok(Json(serde_json::json!({ "ok": true, "user": engineer })))
}

async fn reject_registration(
    State(state): State<AppState>,
    Path(user_id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    let store = state.store.clone();
    task::spawn_blocking(move || store.reject_engineer(user_id))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::CONFLICT,
                "Заявку уже обработали или она не найдена",
            )
        })?;
    state.realtime.publish(
        EventKind::RegistrationRejected,
        Audience::Role("dispatcher".into()),
        Some(ActorRef {
            user_id: user.id,
            role: user.role.clone(),
        }),
        Some(EntityRef {
            kind: "registration".into(),
            id: user_id.to_string(),
            version: 2,
        }),
        serde_json::json!({ "user_id": user_id, "status": "rejected" }),
    );
    state.realtime.publish(
        EventKind::RegistrationRejected,
        Audience::User(user_id),
        None,
        Some(EntityRef {
            kind: "registration".into(),
            id: user_id.to_string(),
            version: 2,
        }),
        serde_json::json!({ "status": "rejected" }),
    );
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn apply_security_role(user: &mut store::PublicUser) {
    // Only a pre-provisioned active shift-lead account may be assigned this separate role.
    if user.role == "dispatcher"
        && std::env::var("RAMPPULSE_SECURITY_USER_IDS")
            .unwrap_or_default()
            .split(',')
            .any(|v| v.trim().parse::<i64>() == Ok(user.id))
    {
        user.role = "security".to_owned();
    }
}

async fn authenticated_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<store::PublicUser, HttpError> {
    let user = session_user(state, headers).await?;
    if user.role == "security" {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Используйте панель безопасности",
        ));
    }
    Ok(user)
}

async fn session_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<store::PublicUser, HttpError> {
    let token = session_from_headers(headers).ok_or(HttpError(
        StatusCode::UNAUTHORIZED,
        "Требуется вход в систему",
    ))?;
    let store = state.store.clone();
    let mut user = task::spawn_blocking(move || store.user_for_token(&token))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::UNAUTHORIZED, "Требуется вход в систему"))?;
    apply_security_role(&mut user);
    Ok(user)
}

fn require_dispatcher(user: &store::PublicUser) -> Result<(), HttpError> {
    if user.role == "dispatcher" {
        Ok(())
    } else {
        Err(HttpError(
            StatusCode::FORBIDDEN,
            "Действие доступно только диспетчеру",
        ))
    }
}

async fn websocket(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    if !origin_is_same_site(&headers) {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Источник WebSocket не разрешён",
        ));
    }
    let hub = state.realtime.clone();
    let offered_auth_protocol = headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .split(',')
                .map(str::trim)
                .find(|protocol| protocol.starts_with("rp-auth."))
        })
        .map(str::to_owned);
    let mut upgrade = ws
        .read_buffer_size(8 * 1024)
        .write_buffer_size(8 * 1024)
        .max_message_size(64 * 1024)
        .max_frame_size(16 * 1024);
    if let Some(protocol) = offered_auth_protocol {
        upgrade = upgrade.protocols([protocol]);
    }
    Ok(upgrade
        .on_upgrade(move |socket| websocket_session(socket, user, hub))
        .into_response())
}

fn origin_is_same_site(headers: &HeaderMap) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        // Native clients without browser Origin may authenticate with an explicit bearer token.
        return headers.get(header::AUTHORIZATION).is_some();
    };
    if matches!(
        origin,
        "http://tauri.localhost"
            | "https://tauri.localhost"
            | "tauri://localhost"
            | "http://localhost:5173"
            | "http://127.0.0.1:5173"
    ) {
        return true;
    }
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Ok(origin_uri) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    let Some(authority) = origin_uri.authority() else {
        return false;
    };
    // The desktop app serves its UI on an OS-assigned loopback port.
    if matches!(authority.host(), "127.0.0.1" | "localhost")
        && origin_uri.scheme_str() == Some("http")
        && authority.port_u16().is_some()
    {
        return true;
    }
    if !authority.as_str().eq_ignore_ascii_case(host) {
        return false;
    }
    let forwarded = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok());
    if let (Some(expected), Some(actual)) = (forwarded, origin_uri.scheme_str()) {
        return expected.eq_ignore_ascii_case(actual);
    }
    matches!(origin_uri.scheme_str(), Some("http" | "https"))
}

async fn websocket_session(socket: WebSocket, user: store::PublicUser, hub: RealtimeHub) {
    let user_id = user.id;
    let role = user.role.clone();
    if hub.connect(user_id) {
        publish_presence(&hub, user_id, &role, true);
    }
    websocket_loop(socket, user, hub.clone()).await;
    if hub.disconnect(user_id) {
        publish_presence(&hub, user_id, &role, false);
    }
}

fn publish_presence(hub: &RealtimeHub, user_id: i64, role: &str, online: bool) {
    hub.publish(
        EventKind::PresenceChanged,
        Audience::All,
        Some(ActorRef {
            user_id,
            role: role.into(),
        }),
        Some(EntityRef {
            kind: "user".into(),
            id: user_id.to_string(),
            version: 1,
        }),
        serde_json::json!({ "user_id": user_id, "online": online }),
    );
}

async fn websocket_loop(mut socket: WebSocket, user: store::PublicUser, hub: RealtimeHub) {
    let mut events = hub.subscribe();
    let mut last_seen = 0_u64;
    let ready = RealtimeEvent {
        protocol: REALTIME_PROTOCOL_VERSION,
        event_id: Uuid::new_v4().to_string(),
        sequence: last_seen,
        occurred_at_ms: OffsetDateTime::now_utc()
            .unix_timestamp_nanos()
            .div_euclid(1_000_000) as u64,
        kind: EventKind::ConnectionReady,
        actor: Some(ActorRef {
            user_id: user.id,
            role: user.role.clone(),
        }),
        entity: None,
        payload: serde_json::json!({
            "user_id": user.id,
            "role": user.role,
            "protocol": REALTIME_PROTOCOL_VERSION,
            "snapshot_required": true,
        }),
    };
    if send_event(&mut socket, &ready).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(Message::Ping(data))) => {
                    if socket.send(Message::Pong(data)).await.is_err() { break; }
                }
                Some(Ok(Message::Text(text))) => {
                    // Client messages are intentionally limited to transport heartbeat. Domain
                    // mutations use authenticated HTTP commands and are published by the core.
                    if text.as_str() == "heartbeat" {
                        let heartbeat = RealtimeEvent {
                            protocol: REALTIME_PROTOCOL_VERSION,
                            event_id: Uuid::new_v4().to_string(),
                            sequence: last_seen,
                            occurred_at_ms: OffsetDateTime::now_utc().unix_timestamp_nanos().div_euclid(1_000_000) as u64,
                            kind: EventKind::HeartbeatAck,
                            actor: Some(ActorRef { user_id: user.id, role: user.role.clone() }),
                            entity: None,
                            payload: serde_json::json!({ "kind": "heartbeat" }),
                        };
                        if send_event(&mut socket, &heartbeat).await.is_err() { break; }
                    }
                }
                Some(Ok(Message::Binary(_))) => {
                    // Audio is not accepted on this socket; calls use negotiated media transport.
                }
                Some(Ok(Message::Pong(_))) => {}
            },
            event = events.recv() => match event {
                Ok(published) => {
                    if !published.audience.permits(user.id, &user.role) { continue; }
                    last_seen = last_seen.saturating_add(1);
                    let mut event = published.event;
                    event.sequence = last_seen;
                    if send_event(&mut socket, &event).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let resync = hub.resync_required(last_seen.saturating_add(1), last_seen);
                    if send_event(&mut socket, &resync).await.is_err() { break; }
                    last_seen = last_seen.saturating_add(1);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }
}

async fn send_event(
    socket: &mut WebSocket,
    event: &RealtimeEvent<serde_json::Value>,
) -> Result<(), axum::Error> {
    let json = serde_json::to_string(event).map_err(|error| axum::Error::new(error))?;
    socket.send(Message::Text(json.into())).await
}

fn session_from_headers(headers: &HeaderMap) -> Option<String> {
    // Prefer the explicit app token over ambient cookies. Embedded webviews can
    // retain a stale cross-site cookie while the current native session is valid.
    if let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    {
        return Some(token.to_owned());
    }
    if let Some(token) = headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .and_then(|protocols| {
            protocols
                .split(',')
                .map(str::trim)
                .find_map(|protocol| protocol.strip_prefix("rp-auth."))
        })
    {
        return Some(token.to_owned());
    }
    if let Some(value) = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(token) = value
            .split(';')
            .find_map(|part| part.trim().strip_prefix(&format!("{COOKIE_NAME}=")))
        {
            if !token.is_empty() {
                return Some(token.to_owned());
            }
        }
    }
    None
}

pub(crate) fn hash_password(password: &str, salt: &[u8], iterations: u32) -> String {
    let mut output = [0_u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut output);
    format!(
        "pbkdf2_sha256${iterations}${salt}${digest}",
        salt = URL_SAFE.encode(salt),
        digest = URL_SAFE.encode(output),
    )
}

pub(crate) fn verify_password(password: &str, encoded: &str) -> bool {
    let mut parts = encoded.split('$');
    if parts.next() != Some("pbkdf2_sha256") {
        return false;
    }
    let Ok(iterations) = parts.next().unwrap_or_default().parse::<u32>() else {
        return false;
    };
    if !(10_000..=2_000_000).contains(&iterations) {
        return false;
    }
    let Ok(salt) = URL_SAFE.decode(parts.next().unwrap_or_default()) else {
        return false;
    };
    let Ok(expected) = URL_SAFE.decode(parts.next().unwrap_or_default()) else {
        return false;
    };
    if parts.next().is_some() || expected.len() != 32 {
        return false;
    }
    let mut actual = [0_u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut actual);
    bool::from(actual.ct_eq(expected.as_slice()))
}

fn random_session_token() -> String {
    Uuid::new_v4().simple().to_string()
        + &rand::rng()
            .sample_iter(&rand::distr::Alphanumeric)
            .take(32)
            .map(char::from)
            .collect::<String>()
}

pub(crate) fn hash_session_token(token: &str) -> String {
    URL_SAFE.encode(Sha256::digest(token.as_bytes()))
}

pub(crate) fn now_rfc3339() -> String {
    let format = time::format_description::parse_borrowed::<2>("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z")
        .expect("valid audit timestamp format");
    OffsetDateTime::now_utc().format(&format).unwrap_or_default()
}

#[derive(Deserialize)]
struct ProfileBody {
    name: String,
    username: String,
    #[serde(default)]
    bio: String,
    #[serde(default)]
    avatar_color: String,
}

#[derive(Deserialize)]
struct PasswordBody {
    current_password: String,
    new_password: String,
}

async fn profile(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let store = state.store.clone();
    let user_id = user.id;
    let sessions = task::spawn_blocking(move || store.session_count(user_id))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .unwrap_or(1);
    Ok(Json(
        serde_json::json!({ "user": user, "sessions": sessions }),
    ))
}

fn valid_username(value: &str) -> bool {
    (3..=32).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn valid_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

async fn update_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ProfileBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let name = body.name.trim().to_owned();
    let username = body.username.trim().trim_start_matches('@').to_lowercase();
    let bio = body.bio.trim().to_owned();
    let color = if body.avatar_color.is_empty() {
        user.avatar_color.clone()
    } else {
        body.avatar_color.clone()
    };
    if name.chars().count() < 2 || name.chars().count() > 64 {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Имя должно содержать от 2 до 64 символов",
        ));
    }
    if !valid_username(&username) {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Логин: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание",
        ));
    }
    if bio.chars().count() > 160 {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Описание не длиннее 160 символов",
        ));
    }
    if !valid_color(&color) {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Некорректный цвет аватара",
        ));
    }
    let store = state.store.clone();
    let user_id = user.id;
    let updated =
        task::spawn_blocking(move || store.update_profile(user_id, &name, &username, &bio, &color))
            .await
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
            .map_err(|_| {
                HttpError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Не удалось сохранить профиль",
                )
            })?
            .ok_or(HttpError(StatusCode::CONFLICT, "Этот логин уже занят"))?;
    state.realtime.publish(
        EventKind::PresenceChanged,
        Audience::All,
        Some(ActorRef { user_id, role: updated.role.clone() }),
        Some(EntityRef { kind: "user".into(), id: user_id.to_string(), version: 2 }),
        serde_json::json!({
            "user_id": user_id,
            "online": true,
            "profile": { "name": updated.name, "username": updated.username, "bio": updated.bio, "avatar_color": updated.avatar_color },
        }),
    );
    Ok(Json(serde_json::json!({ "user": updated })))
}

fn profile_media_dir(state: &AppState) -> PathBuf {
    state.attachments_dir.join("profile-media")
}

fn image_extension(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("png", "image/png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("gif", "image/gif"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else {
        None
    }
}

async fn upload_profile_media(
    State(state): State<AppState>,
    Path((user_id, kind)): Path<(i64, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, HttpError> {
    let actor = authenticated_user(&state, &headers).await?;
    if actor.id != user_id {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Можно изменять только собственный профиль",
        ));
    }
    if !matches!(kind.as_str(), "avatar" | "banner")
        || body.is_empty()
        || body.len() > 5 * 1024 * 1024
    {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Изображение должно быть не больше 5 МБ",
        ));
    }
    let Some((extension, _)) = image_extension(&body) else {
        return Err(HttpError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Поддерживаются PNG, JPEG, GIF и WebP",
        ));
    };
    let dir = profile_media_dir(&state);
    let prefix = format!("{user_id}-{kind}.");
    let url = format!("/api/profile/media/{user_id}/{kind}");
    task::spawn_blocking(move || {
        fs::create_dir_all(&dir)?;
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = fs::remove_file(entry.path());
            }
        }
        let destination = dir.join(format!("{user_id}-{kind}.{extension}"));
        fs::write(destination, &body)
    })
    .await
    .map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Ошибка сохранения изображения",
        )
    })?
    .map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Ошибка сохранения изображения",
        )
    })?;
    Ok(Json(json!({ "url": url })))
}

async fn delete_profile_media(
    State(state): State<AppState>,
    Path((user_id, kind)): Path<(i64, String)>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let actor = authenticated_user(&state, &headers).await?;
    if actor.id != user_id {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Можно изменять только собственный профиль",
        ));
    }
    if !matches!(kind.as_str(), "avatar" | "banner") {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Неизвестный тип изображения",
        ));
    }
    let dir = profile_media_dir(&state);
    let prefix = format!("{user_id}-{kind}.");
    task::spawn_blocking(move || {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(&prefix) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    })
    .await
    .map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Ошибка удаления изображения",
        )
    })?;
    Ok(Json(json!({ "removed": true })))
}

async fn get_profile_media(
    State(state): State<AppState>,
    Path((user_id, kind)): Path<(i64, String)>,
) -> Result<Response, HttpError> {
    if user_id <= 0 || !matches!(kind.as_str(), "avatar" | "banner") {
        return Err(HttpError(StatusCode::NOT_FOUND, "Изображение не найдено"));
    }
    let dir = profile_media_dir(&state);
    let prefix = format!("{user_id}-{kind}.");
    let file = task::spawn_blocking(move || -> Option<PathBuf> {
        fs::read_dir(dir)
            .ok()?
            .flatten()
            .find(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
            .map(|entry| entry.path())
    })
    .await
    .map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Ошибка чтения изображения",
        )
    })?
    .ok_or(HttpError(StatusCode::NOT_FOUND, "Изображение не найдено"))?;
    let bytes = tokio::fs::read(file)
        .await
        .map_err(|_| HttpError(StatusCode::NOT_FOUND, "Изображение не найдено"))?;
    let mime = image_extension(&bytes)
        .map(|(_, mime)| mime)
        .unwrap_or("application/octet-stream");
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes,
    )
        .into_response())
}

async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PasswordBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    if body.new_password.chars().count() < 8 {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Новый пароль — минимум 8 символов",
        ));
    }
    if body.new_password == body.current_password {
        return Err(HttpError(
            StatusCode::BAD_REQUEST,
            "Новый пароль совпадает с текущим",
        ));
    }
    let store = state.store.clone();
    let token = session_from_headers(&headers).unwrap_or_default();
    let user_id = user.id;
    let changed = task::spawn_blocking(move || {
        let changed = store.change_password(user_id, &body.current_password, &body.new_password)?;
        if changed {
            store.delete_other_sessions(user_id, &token)?;
        }
        Ok::<bool, rusqlite::Error>(changed)
    })
    .await
    .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
    .map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось сменить пароль",
        )
    })?;
    if !changed {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Текущий пароль указан неверно",
        ));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn logout_others(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let token = session_from_headers(&headers).unwrap_or_default();
    let store = state.store.clone();
    let removed = task::spawn_blocking(move || store.delete_other_sessions(user.id, &token))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?;
    Ok(Json(serde_json::json!({ "ok": true, "removed": removed })))
}

async fn presence(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    authenticated_user(&state, &headers).await?;
    Ok(Json(
        serde_json::json!({ "online": state.realtime.online_users() }),
    ))
}

async fn chat_typing(
    State(state): State<AppState>,
    Path(room_id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    let store = state.store.clone();
    let user_id = user.id;
    let recipients = task::spawn_blocking(move || store.chat_recipients(room_id, user_id))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::FORBIDDEN, "Нет доступа к этому чату"))?;
    for recipient in recipients {
        state.realtime.publish(
            EventKind::ChatTyping,
            Audience::User(recipient),
            Some(ActorRef {
                user_id,
                role: user.role.clone(),
            }),
            Some(EntityRef {
                kind: "chat_room".into(),
                id: room_id.to_string(),
                version: 1,
            }),
            serde_json::json!({ "room_id": room_id, "user_id": user_id, "name": user.name }),
        );
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Keyword classifier for the required engineer qualification (Планер / Двигатель / Авионика).
fn classify_qualification(text: &str) -> &'static str {
    let t = text.to_lowercase();
    let score = |words: &[&str]| words.iter().filter(|w| t.contains(*w)).count();
    let engine = score(&[
        "двигател",
        "всу",
        "apu",
        "запуск",
        "масл",
        "турбин",
        "лопат",
        "тяг",
        "реверс",
        "топлив",
        "компрессор",
        "форсаж",
        "помпаж",
        "обороты",
    ]);
    let avionics = score(&[
        "авионик",
        "радио",
        "vhf",
        "навиг",
        "связ",
        "датчик",
        "индикац",
        "экран",
        "дисплей",
        "автопилот",
        "транспондер",
        "fms",
        "ошибк",
        "блок",
        "проводк",
        "электр",
        "компьютер",
        "пилотаж",
    ]);
    let airframe = score(&[
        "планер",
        "обшивк",
        "шасси",
        "гидравл",
        "стойк",
        "тормоз",
        "колес",
        "колёс",
        "дверь",
        "люк",
        "крыл",
        "закрылк",
        "фюзеляж",
        "трещин",
        "вмятин",
        "течь",
        "утечк",
    ]);
    if engine > avionics && engine >= airframe && engine > 0 {
        "Двигатель"
    } else if avionics > engine && avionics >= airframe && avionics > 0 {
        "Авионика"
    } else {
        "Планер"
    }
}
