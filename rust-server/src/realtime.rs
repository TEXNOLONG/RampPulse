use ramppulse_core::{ActorRef, EntityRef, EventKind, RealtimeEvent, REALTIME_PROTOCOL_VERSION};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use time::OffsetDateTime;
use tokio::sync::broadcast;
use uuid::Uuid;

const EVENT_BUFFER_CAPACITY: usize = 512;

#[derive(Clone, Debug)]
pub enum Audience {
    All,
    Role(String),
    User(i64),
}

impl Audience {
    pub fn permits(&self, user_id: i64, role: &str) -> bool {
        match self {
            Self::All => true,
            Self::Role(target) => target == role,
            Self::User(target) => *target == user_id,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PublishedEvent {
    pub audience: Audience,
    pub event: RealtimeEvent<Value>,
}

#[derive(Clone)]
pub struct RealtimeHub {
    inner: Arc<HubInner>,
}

struct HubInner {
    next_sequence: AtomicU64,
    sender: broadcast::Sender<PublishedEvent>,
    /// Open realtime connections per user id (several devices / windows per user).
    online: Mutex<HashMap<i64, usize>>,
}

impl RealtimeHub {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(EVENT_BUFFER_CAPACITY);
        Self {
            inner: Arc::new(HubInner {
                next_sequence: AtomicU64::new(1),
                sender,
                online: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Registers a connection; returns true when the user just came online.
    pub fn connect(&self, user_id: i64) -> bool {
        let mut online = self.inner.online.lock().unwrap_or_else(|e| e.into_inner());
        let count = online.entry(user_id).or_insert(0);
        *count += 1;
        *count == 1
    }

    /// Unregisters a connection; returns true when the user went offline.
    pub fn disconnect(&self, user_id: i64) -> bool {
        let mut online = self.inner.online.lock().unwrap_or_else(|e| e.into_inner());
        match online.get_mut(&user_id) {
            Some(count) if *count > 1 => {
                *count -= 1;
                false
            }
            Some(_) => {
                online.remove(&user_id);
                true
            }
            None => false,
        }
    }

    pub fn online_users(&self) -> Vec<i64> {
        let online = self.inner.online.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<i64> = online.keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PublishedEvent> {
        self.inner.sender.subscribe()
    }

    pub fn publish(
        &self,
        kind: EventKind,
        audience: Audience,
        actor: Option<ActorRef>,
        entity: Option<EntityRef>,
        payload: Value,
    ) -> u64 {
        let sequence = self.inner.next_sequence.fetch_add(1, Ordering::AcqRel);
        let occurred_at_ms = OffsetDateTime::now_utc()
            .unix_timestamp_nanos()
            .div_euclid(1_000_000) as u64;
        let event = RealtimeEvent {
            protocol: REALTIME_PROTOCOL_VERSION,
            event_id: Uuid::new_v4().to_string(),
            sequence,
            occurred_at_ms,
            kind,
            actor,
            entity,
            payload,
        };
        let _ = self.inner.sender.send(PublishedEvent { audience, event });
        sequence
    }

    pub fn resync_required(&self, sequence: u64, last_seen: u64) -> RealtimeEvent<Value> {
        RealtimeEvent {
            protocol: REALTIME_PROTOCOL_VERSION,
            event_id: Uuid::new_v4().to_string(),
            sequence,
            occurred_at_ms: OffsetDateTime::now_utc()
                .unix_timestamp_nanos()
                .div_euclid(1_000_000) as u64,
            kind: EventKind::ResyncRequired,
            actor: None,
            entity: None,
            payload: serde_json::json!({
                "last_seen_sequence": last_seen,
                "action": "fetch_snapshot",
            }),
        }
    }
}
