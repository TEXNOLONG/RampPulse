//! Shared, allocation-conscious RampPulse domain primitives.
//!
//! This crate intentionally contains no UI, network runtime, or database code. It is the
//! stable boundary that the desktop app and the VPS service can share while the existing
//! Python/Go implementations are migrated in stages.

use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fmt;

pub const REALTIME_PROTOCOL_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    ConnectionReady,
    HeartbeatAck,
    ResyncRequired,
    StateSnapshot,
    StateDelta,
    PresenceChanged,
    ShiftStarted,
    ShiftEnded,
    RegistrationSubmitted,
    RegistrationApproved,
    RegistrationRejected,
    RequestCreated,
    RequestAssigned,
    RequestStatusChanged,
    RequestEscalated,
    RequestCompleted,
    AircraftArrived,
    AircraftDeparted,
    StandChanged,
    RouteBlocked,
    RouteCleared,
    ChatMessageCreated,
    ChatMessageDelivered,
    ChatMessageRead,
    ChatMessageEdited,
    ChatMessageDeleted,
    ChatTyping,
    CallInvited,
    CallRinging,
    CallAccepted,
    CallRejected,
    CallEnded,
    CallParticipantChanged,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ActorRef {
    pub user_id: i64,
    pub role: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EntityRef {
    pub kind: String,
    pub id: String,
    /// Monotonically increasing version for conflict detection and client resync.
    pub version: u64,
}

/// Versioned envelope for the new WebSocket protocol.
/// `sequence` is monotonic in the server event stream; `event_id` is globally unique.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RealtimeEvent<T> {
    pub protocol: u16,
    pub event_id: String,
    pub sequence: u64,
    /// Unix timestamp in milliseconds, UTC.
    pub occurred_at_ms: u64,
    pub kind: EventKind,
    pub actor: Option<ActorRef>,
    pub entity: Option<EntityRef>,
    pub payload: T,
}

impl<T> RealtimeEvent<T> {
    pub fn new(
        event_id: impl Into<String>,
        sequence: u64,
        occurred_at_ms: u64,
        kind: EventKind,
        actor: Option<ActorRef>,
        entity: Option<EntityRef>,
        payload: T,
    ) -> Self {
        Self {
            protocol: REALTIME_PROTOCOL_VERSION,
            event_id: event_id.into(),
            sequence,
            occurred_at_ms,
            kind,
            actor,
            entity,
            payload,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    Waiting,
    Assigned,
    Enroute,
    Arrived,
    Working,
    Completed,
    Cancelled,
}

impl RequestStatus {
    /// Enforce the request lifecycle at the shared domain boundary, not in UI handlers.
    pub fn can_transition_to(self, next: Self) -> bool {
        use RequestStatus::*;
        matches!(
            (self, next),
            (Waiting, Assigned | Cancelled)
                | (Assigned, Enroute | Cancelled)
                | (Enroute, Arrived | Cancelled)
                | (Arrived, Working | Cancelled)
                | (Working, Completed | Cancelled)
        )
    }
}

pub type NodeId = String;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: NodeId,
    pub position: MapPoint,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GraphEdge {
    pub from: NodeId,
    pub to: NodeId,
    pub id: String,
    /// Fixed-point graph cost keeps route comparisons deterministic across platforms.
    pub cost: u64,
    pub blocked: bool,
    pub bidirectional: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Route {
    pub nodes: Vec<NodeId>,
    pub cost: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Journey {
    pub nodes: Vec<String>,
    pub distance_m: f64,
    pub eta_seconds: f64,
    pub mode: &'static str,
}

#[derive(Clone, Debug)]
pub struct AirportGraph {
    nodes: Vec<GraphNode>,
    index_by_id: HashMap<NodeId, usize>,
    outgoing: Vec<Vec<IndexedEdge>>,
    road_speeds: HashMap<String, (bool, bool, u8)>,
    warehouses: HashSet<String>,
}

#[derive(Clone, Debug)]
struct IndexedEdge {
    id: String,
    to: usize,
    cost: u64,
    blocked: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GraphError {
    DuplicateNode(NodeId),
    MissingEndpoint(NodeId),
    ZeroLengthEdge(NodeId, NodeId),
    InvalidPosition(NodeId),
    InvalidDocument(String),
}

impl fmt::Display for GraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateNode(id) => write!(f, "duplicate airport graph node {id}"),
            Self::MissingEndpoint(id) => {
                write!(f, "airport graph edge references missing node {id}")
            }
            Self::ZeroLengthEdge(from, to) => {
                write!(f, "airport graph edge {from}->{to} has zero length")
            }
            Self::InvalidPosition(id) => {
                write!(f, "airport graph node {id} has a non-finite position")
            }
            Self::InvalidDocument(message) => write!(f, "invalid airport graph: {message}"),
        }
    }
}

impl std::error::Error for GraphError {}

impl AirportGraph {
    /// Read the existing RampPulse airport JSON shape (`nodes` and `edges`) without converting
    /// the map ids. Edge costs are stored in fixed-point map-coordinate units.
    pub fn from_airport_json(data: &str) -> Result<Self, GraphError> {
        #[derive(serde::Deserialize)]
        struct AirportDocument {
            nodes: Vec<AirportNode>,
            #[serde(default)]
            edges: Vec<AirportLink>,
            #[serde(default)]
            warehouses: HashSet<String>,
        }
        #[derive(serde::Deserialize)]
        struct AirportNode {
            id: String,
            x: f64,
            y: f64,
        }
        #[derive(serde::Deserialize)]
        struct AirportLink {
            #[serde(default)]
            id: String,
            a: String,
            b: String,
            #[serde(default = "default_bidirectional")]
            bidirectional: bool,
            #[serde(default)]
            kind: String,
            vehicle_kmh: Option<u8>,
            walk_allowed: Option<bool>,
            vehicle_allowed: Option<bool>,
            #[serde(default)]
            blocked: bool,
        }
        fn default_bidirectional() -> bool {
            true
        }

        let document: AirportDocument = serde_json::from_str(data)
            .map_err(|error| GraphError::InvalidDocument(error.to_string()))?;
        let nodes: Vec<GraphNode> = document
            .nodes
            .into_iter()
            .map(|node| GraphNode {
                id: node.id,
                position: MapPoint {
                    x: node.x,
                    y: node.y,
                },
            })
            .collect();
        let positions: HashMap<&str, MapPoint> = nodes
            .iter()
            .map(|node| (node.id.as_str(), node.position))
            .collect();
        let mut edges = Vec::with_capacity(document.edges.len());
        let mut speeds = HashMap::new();
        for (index, link) in document.edges.into_iter().enumerate() {
            let Some(start) = positions.get(link.a.as_str()) else {
                return Err(GraphError::MissingEndpoint(link.a));
            };
            let Some(end) = positions.get(link.b.as_str()) else {
                return Err(GraphError::MissingEndpoint(link.b));
            };
            let distance = (end.x - start.x).hypot(end.y - start.y);
            let cost = (distance * 1_000.0).round().max(1.0) as u64;
            let id = if link.id.is_empty() { format!("edge-{index}") } else { link.id };
            let speed = link.vehicle_kmh.unwrap_or(match link.kind.as_str() { "stand" | "service_zone" => 5, "terminal" => 8, "apron" => 10, _ => 20 });
            if !matches!(speed, 5 | 8 | 10 | 20) { return Err(GraphError::InvalidDocument(format!("invalid speed on {id}"))); }
            speeds.insert(id.clone(), (link.walk_allowed.unwrap_or(link.kind != "runway"), link.vehicle_allowed.unwrap_or(!matches!(link.kind.as_str(), "runway" | "pedestrian")), speed));
            edges.push(GraphEdge {
                from: link.a,
                to: link.b,
                id,
                cost,
                blocked: link.blocked,
                bidirectional: link.bidirectional,
            });
        }
        let mut graph = Self::new(nodes, edges)?;
        graph.road_speeds = speeds;
        graph.warehouses = document.warehouses;
        Ok(graph)
    }

    pub fn new(nodes: Vec<GraphNode>, edges: Vec<GraphEdge>) -> Result<Self, GraphError> {
        let mut index_by_id = HashMap::with_capacity(nodes.len());
        for (index, node) in nodes.iter().enumerate() {
            if !node.position.x.is_finite() || !node.position.y.is_finite() {
                return Err(GraphError::InvalidPosition(node.id.clone()));
            }
            if index_by_id.insert(node.id.clone(), index).is_some() {
                return Err(GraphError::DuplicateNode(node.id.clone()));
            }
        }

        let mut outgoing = vec![Vec::new(); nodes.len()];
        for edge in edges {
            let Some(&from) = index_by_id.get(&edge.from) else {
                return Err(GraphError::MissingEndpoint(edge.from));
            };
            let Some(&to) = index_by_id.get(&edge.to) else {
                return Err(GraphError::MissingEndpoint(edge.to));
            };
            if edge.cost == 0 {
                return Err(GraphError::ZeroLengthEdge(edge.from, edge.to));
            }
            outgoing[from].push(IndexedEdge {
                id: edge.id.clone(),
                to,
                cost: edge.cost,
                blocked: edge.blocked,
            });
            if edge.bidirectional {
                outgoing[to].push(IndexedEdge {
                    id: edge.id,
                    to: from,
                    cost: edge.cost,
                    blocked: edge.blocked,
                });
            }
        }
        for edges in &mut outgoing {
            edges.sort_unstable_by(|left, right| {
                (left.to, left.cost, &left.id).cmp(&(right.to, right.cost, &right.id))
            });
        }

        Ok(Self {
            nodes,
            index_by_id,
            outgoing,
            road_speeds: HashMap::new(),
            warehouses: HashSet::new(),
        })
    }

    pub fn node(&self, id: &str) -> Option<&GraphNode> {
        self.index_by_id.get(id).map(|index| &self.nodes[*index])
    }

    /// Fastest legal walk or vehicle journey through ordered service stops.
    pub fn journey(&self, start: &str, via: &[String], goal: &str, blocked: &HashSet<String>, vehicle_available: bool) -> Option<Journey> {
        let mut best = None;
        for vehicle in [false, true] {
            if vehicle && !vehicle_available { continue; }
            let mut nodes = vec![start.to_owned()];
            let mut from = start;
            let mut ms = if vehicle { 20_000 } else { 0 };
            for stop in via.iter().map(String::as_str).chain(std::iter::once(goal)) {
                let Some(leg) = self.find_path(from, stop, blocked, Some(vehicle)) else { nodes.clear(); break };
                ms += leg.cost;
                nodes.extend(leg.nodes.into_iter().skip(1));
                from = stop;
            }
            if nodes.is_empty() { continue; }
            ms += via.iter().filter(|id| self.warehouses.contains(id.as_str())).count() as u64 * 30_000;
            let distance_m = nodes.windows(2).map(|pair| {
                let a = self.node(&pair[0]).unwrap().position;
                let b = self.node(&pair[1]).unwrap().position;
                (a.x-b.x).hypot(a.y-b.y)
            }).sum();
            let trip = Journey { nodes, distance_m, eta_seconds: ms as f64 / 1000.0, mode: if vehicle { "vehicle" } else { "walk" } };
            if best.as_ref().is_none_or(|old: &Journey| trip.eta_seconds < old.eta_seconds) { best = Some(trip); }
        }
        best
    }
    /// Dijkstra shortest path over bidirectional airport links. Integer costs and indexed
    /// adjacency keep work bounded and deterministic even when the airport graph grows.
    pub fn shortest_path(
        &self,
        start: &str,
        goal: &str,
        blocked_edges: &HashSet<String>,
    ) -> Option<Route> {
        self.find_path(start, goal, blocked_edges, None)
    }

    fn find_path(&self, start: &str, goal: &str, blocked_edges: &HashSet<String>, vehicle: Option<bool>) -> Option<Route> {
        let &start_index = self.index_by_id.get(start)?;
        let &goal_index = self.index_by_id.get(goal)?;
        if start_index == goal_index {
            return Some(Route {
                nodes: vec![start.to_owned()],
                cost: 0,
            });
        }

        let mut distance = vec![u64::MAX; self.nodes.len()];
        let mut previous = vec![None; self.nodes.len()];
        let mut queue = BinaryHeap::new();
        distance[start_index] = 0;
        queue.push(Reverse((0_u64, start_index)));

        while let Some(Reverse((cost, current))) = queue.pop() {
            if cost != distance[current] {
                continue;
            }
            if current == goal_index {
                break;
            }
            for edge in &self.outgoing[current] {
                if edge.blocked || blocked_edges.contains(&edge.id) {
                    continue;
                }
                let weight = if let Some(driving) = vehicle {
                    let (walk, drive, speed) = self.road_speeds.get(&edge.id).copied().unwrap_or((true, true, 20));
                    if (driving && !drive) || (!driving && !walk) { continue; }
                    (edge.cost as f64 * 3.6 / if driving { speed as f64 } else { 5.0 }).round().max(1.0) as u64
                } else { edge.cost };
                let Some(candidate) = cost.checked_add(weight) else {
                    continue;
                };
                if candidate < distance[edge.to] {
                    distance[edge.to] = candidate;
                    previous[edge.to] = Some(current);
                    queue.push(Reverse((candidate, edge.to)));
                }
            }
        }

        let total = distance[goal_index];
        if total == u64::MAX {
            return None;
        }
        let mut indices = vec![goal_index];
        let mut cursor = goal_index;
        while cursor != start_index {
            cursor = previous[cursor]?;
            indices.push(cursor);
        }
        indices.reverse();
        let nodes = indices
            .into_iter()
            .map(|index| self.nodes[index].id.clone())
            .collect();
        Some(Route { nodes, cost: total })
    }
}
