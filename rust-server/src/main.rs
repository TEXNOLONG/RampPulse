mod airport_engine;
mod realtime;
mod store;

use axum::RequestExt;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path, Query, Request, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE},
    Engine as _,
};
use hmac::{Hmac, Mac};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, env, fs, net::SocketAddr, path::PathBuf, sync::Arc};
use subtle::ConstantTimeEq;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::io::AsyncWriteExt;
use tokio::task;
use uuid::Uuid;

use airport_engine::AirportEngine;
use futures_util::StreamExt;
use ramppulse_core::{
    ActorRef, AirportGraph, EntityRef, EventKind, RealtimeEvent, REALTIME_PROTOCOL_VERSION,
};
use realtime::{Audience, RealtimeHub};
use store::{AccountStore, NewEngineer, NewRequest, ShiftFailure};

const COOKIE_NAME: &str = "oto_session";
const SESSION_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
const PBKDF2_ITERATIONS: u32 = 210_000;

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
}

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
    email: String,
    password: String,
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
    from: String,
    to: String,
    #[serde(default)]
    blocked_edges: HashSet<String>,
}

#[derive(Deserialize)]
struct CreateRequestBody {
    stand: String,
    description: String,
    qual: String,
    #[serde(default)]
    extra: String,
    #[serde(default = "default_priority")]
    priority: String,
}

#[derive(Deserialize)]
struct RequestStatusBody {
    status: String,
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
struct SimulationBody {
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

fn default_priority() -> String {
    "normal".into()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db_path = env::var("DB_FILE").unwrap_or_else(|_| "./ramppulse.db".into());
    let store = AccountStore::open(&db_path)?;
    let demo_mode = env_flag("DEMO_MODE");
    if demo_mode {
        store.seed_demo()?;
    }

    let airport_file =
        env::var("AIRPORT_FILE").unwrap_or_else(|_| "data/airport_sheremetyevo.json".into());
    let airport_text = fs::read_to_string(&airport_file)?;
    let airport_data: serde_json::Value = serde_json::from_str(&airport_text)?;
    let airport_name = airport_data
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("Шереметьево (SVO · UUEE)")
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
    };

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
        .route("/api/airport", get(airport))
        .route("/api/state", get(state_snapshot))
        .route("/api/routes/preview", post(route_preview))
        .route("/api/requests", get(list_requests).post(create_request))
        .route("/api/requests/{id}/status", post(change_request_status))
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
            post(upload_chat_attachment).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
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
        .with_state(state);

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(1));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut persist_counter = 0_u8;
        loop {
            ticker.tick().await;
            if let Ok(Some(payload)) = tick_engine.tick(1.0) {
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
        "/login" => "auth.html",
        "/engineer" => "engineer.html",
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
    let path = match tokio::fs::canonicalize(&candidate).await {
        Ok(path) if path.starts_with(&root) && path.is_file() => path,
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
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    let mut response = Response::new(axum::body::Body::from(contents));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
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
        "features": { "server_chat": true, "versioned_events": true, "airport_state_v1": true },
        "demo": { "enabled": state.demo_mode },
        "airport": { "name": state.airport_name, "source": "SVO / Шереметьево" },
        "quals": ["Планер", "Двигатель", "Авионика"],
        "types": ["A320", "A330", "A350", "B737", "B777", "B787", "SSJ-100", "MC-21"],
        "bases": bases,
    });
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
    Json((*state.airport_data).clone())
}

async fn state_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
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
    snapshot["me"] = serde_json::to_value(&user).unwrap_or(serde_json::Value::Null);
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
        .set_sim(body.speed, body.running)
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
            "Не удалось сбросить симуляцию",
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
    let mut blocked_edges = body.blocked_edges;
    blocked_edges.extend(state.engine.blocked_edges().map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось прочитать состояние маршрутов",
        )
    })?);
    let route = state
        .airport_graph
        .shortest_path(&body.from, &body.to, &blocked_edges)
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
        "cost": route.cost,
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
    let read_store = state.store.clone();
    let engineers = task::spawn_blocking(move || read_store.active_engineers())
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось загрузить инженеров",
            )
        })?;
    let ranked_technicians =
        state
            .engine
            .rank_technicians(body.stand.trim(), body.qual.trim(), &engineers);
    let store = state.store.clone();
    let request = task::spawn_blocking(move || {
        store.create_request(
            NewRequest {
                stand: body.stand.trim().to_owned(),
                description: body.description.trim().to_owned(),
                qual: body.qual.trim().to_owned(),
                extra: body.extra.trim().to_owned(),
                priority: body.priority,
            },
            &ranked_technicians,
        )
    })
    .await
    .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
    .map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось создать заявку",
        )
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
    Ok(Json(
        serde_json::json!({ "id": request.id, "status": request.status, "request": request }),
    ))
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
    let request =
        task::spawn_blocking(move || store.transition_request(id, &next_status, &operation_actor))
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
    let contacts = task::spawn_blocking(move || store.chat_contacts(&user))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| {
            HttpError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось загрузить сотрудников",
            )
        })?;
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
        if byte_size > 15 * 1024 * 1024 {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary_path).await;
            return Err(HttpError(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Файл должен быть меньше 15 МБ",
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
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "webm" => "audio/webm",
        "ogg" | "oga" => "audio/ogg",
        "mp3" => "audio/mpeg",
        "m4a" | "mp4" => "audio/mp4",
        "wav" => "audio/wav",
        _ => "",
    };
    let media = if matches!(
        supplied.as_str(),
        "image/jpeg"
            | "image/png"
            | "image/webp"
            | "image/gif"
            | "application/pdf"
            | "text/plain"
            | "application/zip"
            | "application/msword"
            | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            | "application/vnd.ms-excel"
            | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            | "application/vnd.ms-powerpoint"
            | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            | "audio/webm"
            | "audio/ogg"
            | "audio/mpeg"
            | "audio/mp4"
            | "audio/wav"
    ) {
        supplied.as_str()
    } else {
        inferred
    };
    if media.is_empty() {
        None
    } else {
        Some(media.to_owned())
    }
}

fn extension_for_media(media_type: &str) -> &'static str {
    match media_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "application/zip" => "zip",
        "application/msword" => "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.ms-powerpoint" => "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/wav" => "wav",
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
    state.realtime.publish(
        kind,
        Audience::User(body.recipient_id),
        Some(ActorRef {
            user_id: actor.id,
            role: actor.role,
        }),
        None,
        serde_json::Value::Object(payload),
    );
    Ok(Json(serde_json::json!({"ok":true})))
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

async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginBody>,
) -> Result<Response, HttpError> {
    let store = state.store.clone();
    let email = body.email.trim().to_lowercase();
    let password = body.password;
    let (user, token) =
        task::spawn_blocking(move || store.authenticate_and_create_session(&email, &password))
            .await
            .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
            .map_err(|error| match error {
                store::AuthFailure::InvalidCredentials => {
                    HttpError(StatusCode::UNAUTHORIZED, "Неверный email или пароль")
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

    let max_age = SESSION_TTL_SECONDS;
    let secure = if state.cookie_secure { "; Secure" } else { "" };
    let cookie =
        format!("{COOKIE_NAME}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}");
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
    Ok((
        headers,
        Json(serde_json::json!({ "user": user, "redirect": redirect })),
    )
        .into_response())
}

async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, HttpError> {
    let token = session_from_headers(&headers).ok_or(HttpError(
        StatusCode::UNAUTHORIZED,
        "Требуется вход в систему",
    ))?;
    let store = state.store.clone();
    let user = task::spawn_blocking(move || store.user_for_token(&token))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::UNAUTHORIZED, "Требуется вход в систему"))?;
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
    let secure = if state.cookie_secure { "; Secure" } else { "" };
    let cookie = format!("{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{secure}");
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

async fn authenticated_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<store::PublicUser, HttpError> {
    let token = session_from_headers(headers).ok_or(HttpError(
        StatusCode::UNAUTHORIZED,
        "Требуется вход в систему",
    ))?;
    let store = state.store.clone();
    task::spawn_blocking(move || store.user_for_token(&token))
        .await
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера"))?
        .map_err(|_| HttpError(StatusCode::UNAUTHORIZED, "Требуется вход в систему"))
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
    Ok(ws
        .read_buffer_size(8 * 1024)
        .write_buffer_size(8 * 1024)
        .max_message_size(64 * 1024)
        .max_frame_size(16 * 1024)
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

async fn websocket_session(mut socket: WebSocket, user: store::PublicUser, hub: RealtimeHub) {
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
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned)
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
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}
