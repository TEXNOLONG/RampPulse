use ramppulse_core::{AirportGraph, MapPoint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, RwLock};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::store::{PublicUser, RequestRecord};

#[derive(Clone)]
pub struct AirportEngine {
    airport_name: String,
    graph: Arc<AirportGraph>,
    nodes: Arc<HashMap<String, MapPoint>>,
    edge_ids: Arc<HashSet<String>>,
    stands: Arc<Vec<Stand>>,
    bases: Arc<HashMap<String, Base>>,
    state: Arc<RwLock<EngineState>>,
}

#[derive(Clone, Deserialize)]
struct Stand {
    id: String,
    node: String,
    #[serde(default)]
    heading: f64,
}

#[derive(Clone, Deserialize)]
struct Base {
    id: String,
    node: String,
}

#[derive(Clone, Deserialize)]
struct TechSeed {
    name: String,
    #[serde(default)]
    qual: String,
    #[serde(default)]
    speed: f64,
    #[serde(default)]
    types: Vec<String>,
    #[serde(default)]
    base: String,
}

#[derive(Clone, Serialize)]
struct Tech {
    id: i64,
    name: String,
    qual: String,
    speed: f64,
    types: Vec<String>,
    on_shift: bool,
    status: String,
    request_id: Option<i64>,
    base: String,
    x: f64,
    y: f64,
    route: Vec<[f64; 2]>,
    route_available: bool,
    vehicle_id: Option<i64>,
}

#[derive(Clone, Serialize)]
struct Aircraft {
    id: i64,
    flight: String,
    stand: String,
    model: String,
    status: String,
    status_ru: String,
    turnaround_progress: f64,
    x: f64,
    y: f64,
    heading: f64,
    route: Vec<[f64; 2]>,
    eta_left: Option<f64>,
    parked_left: Option<f64>,
    brief: Value,
    services: Vec<Value>,
    services_progress: i64,
    sched_arr_sim: f64,
    actual_arr_sim: f64,
    sched_dep_sim: f64,
    actual_dep_sim: f64,
    delay_arr_sec: f64,
}

struct EngineState {
    sim_time: f64,
    sim_speed: f64,
    sim_running: bool,
    aircraft: Vec<Aircraft>,
    base_techs: Vec<Tech>,
    blocked: HashSet<String>,
    events: VecDeque<Value>,
    tech_positions: HashMap<i64, MapPoint>,
    tech_routes: HashMap<i64, TechRoute>,
    tech_profiles: HashMap<i64, (String, Vec<String>)>,
    next_aircraft_id: i64,
}

struct TechRoute {
    request_id: i64,
    goal_node: String,
    points: Vec<MapPoint>,
    next_point: usize,
    published_next_point: usize,
    speed: f64,
    unreachable: bool,
}

impl AirportEngine {
    pub fn new(airport: &Value, tech_seed_json: &str) -> Result<Self, String> {
        let graph = AirportGraph::from_airport_json(&airport.to_string())
            .map_err(|error| format!("не удалось построить схему рулёжных дорожек: {error}"))?;
        let airport_name = airport
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("RampPulse · аэропорт")
            .to_owned();
        let nodes: HashMap<String, MapPoint> = airport
            .get("nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|node| {
                Some((
                    node.get("id")?.as_str()?.to_owned(),
                    MapPoint {
                        x: node.get("x")?.as_f64()?,
                        y: node.get("y")?.as_f64()?,
                    },
                ))
            })
            .collect();
        let stands: Vec<Stand> =
            serde_json::from_value(airport.get("stands").cloned().unwrap_or_else(|| json!([])))
                .map_err(|error| format!("не удалось загрузить стоянки: {error}"))?;
        let base_list: Vec<Base> =
            serde_json::from_value(airport.get("bases").cloned().unwrap_or_else(|| json!([])))
                .map_err(|error| format!("не удалось загрузить базы инженеров: {error}"))?;
        let edge_ids: HashSet<String> = airport
            .get("edges")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|edge| edge.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect();
        let bases: HashMap<String, Base> = base_list
            .into_iter()
            .map(|base| (base.id.clone(), base))
            .collect();
        let seeds: Vec<TechSeed> = serde_json::from_str(tech_seed_json)
            .map_err(|error| format!("не удалось загрузить список инженеров: {error}"))?;
        let base_techs = seeds
            .into_iter()
            .enumerate()
            .map(|(index, seed)| {
                let position = bases
                    .get(&seed.base)
                    .and_then(|base| nodes.get(&base.node))
                    .copied()
                    .unwrap_or(MapPoint {
                        x: 400.0,
                        y: 1060.0,
                    });
                Tech {
                    id: index as i64 + 1,
                    name: seed.name,
                    qual: seed.qual,
                    speed: if seed.speed > 0.0 { seed.speed } else { 4.0 },
                    types: seed.types,
                    on_shift: true,
                    status: "free".into(),
                    request_id: None,
                    base: seed.base,
                    x: position.x,
                    y: position.y,
                    route: Vec::new(),
                    route_available: true,
                    vehicle_id: None,
                }
            })
            .collect();

        let mut state = EngineState {
            sim_time: 0.0,
            sim_speed: 10.0,
            sim_running: true,
            aircraft: Vec::new(),
            base_techs,
            blocked: HashSet::new(),
            events: VecDeque::new(),
            tech_positions: HashMap::new(),
            tech_routes: HashMap::new(),
            tech_profiles: HashMap::new(),
            next_aircraft_id: 1,
        };
        for stand in stands.iter().take(4) {
            let aircraft = build_aircraft(state.next_aircraft_id, stand, &nodes, &airport_name);
            state.aircraft.push(aircraft);
            state.next_aircraft_id += 1;
        }

        Ok(Self {
            airport_name,
            graph: Arc::new(graph),
            nodes: Arc::new(nodes),
            edge_ids: Arc::new(edge_ids),
            stands: Arc::new(stands),
            bases: Arc::new(bases),
            state: Arc::new(RwLock::new(state)),
        })
    }

    pub fn snapshot(
        &self,
        requests: &[RequestRecord],
        users: &[PublicUser],
        current_user: Option<&PublicUser>,
    ) -> Value {
        let mut state = self.state.write().expect("airport engine lock poisoned");
        let mut techs = state.base_techs.clone();
        for user in users.iter().filter(|user| user.role == "engineer") {
            let Some(tech_id) = user.tech_id else {
                continue;
            };
            let position = self
                .bases
                .get(user.base.as_deref().unwrap_or_default())
                .and_then(|base| self.nodes.get(&base.node))
                .copied()
                .unwrap_or(MapPoint {
                    x: 400.0,
                    y: 1060.0,
                });
            state.tech_positions.entry(tech_id).or_insert(position);
            let index = if let Some(index) = techs.iter().position(|tech| tech.id == tech_id) {
                index
            } else {
                techs.push(Tech {
                    id: tech_id,
                    name: user.name.clone(),
                    qual: user.qual.clone().unwrap_or_default(),
                    speed: 4.0,
                    types: user.types.clone(),
                    on_shift: user.on_shift,
                    status: "free".into(),
                    request_id: None,
                    base: user.base.clone().unwrap_or_default(),
                    x: position.x,
                    y: position.y,
                    route: Vec::new(),
                    route_available: true,
                    vehicle_id: None,
                });
                techs.len() - 1
            };
            let tech = &mut techs[index];
            tech.name = user.name.clone();
            tech.qual = user.qual.clone().unwrap_or_default();
            tech.types = user.types.clone();
            tech.base = user.base.clone().unwrap_or_default();
            tech.on_shift = user.on_shift;
            if tech.x == 0.0 && tech.y == 0.0 {
                tech.x = position.x;
                tech.y = position.y;
            }
            if let Some(position) = state.tech_positions.get(&tech_id) {
                tech.x = position.x;
                tech.y = position.y;
            }
            if let Some((qual, types)) = state.tech_profiles.get(&tech_id) {
                tech.qual = qual.clone();
                tech.types = types.clone();
            }
        }

        let mut active = Vec::new();
        let mut history = Vec::new();
        let mut waiting = 0;
        for request in requests {
            let mut value = serde_json::to_value(request).unwrap_or(Value::Null);
            add_legacy_request_fields(
                &mut value,
                request,
                state.sim_time,
                state.sim_speed,
                state.sim_running,
            );
            if let Some(aircraft) = state
                .aircraft
                .iter()
                .find(|aircraft| aircraft.stand == request.stand)
            {
                value["aircraft_id"] = json!(aircraft.id);
                value["flight"] = json!(aircraft.flight);
            } else {
                value["aircraft_id"] = Value::Null;
                value["flight"] = Value::Null;
            }
            if let (Some(tech_id), Some(stand)) = (
                request.tech_id,
                self.stands
                    .iter()
                    .find(|stand| stand.id == request.stand)
                    .filter(|_| matches!(request.status.as_str(), "assigned" | "enroute")),
            ) {
                if let (Some(tech), Some(_goal)) = (
                    techs.iter_mut().find(|tech| tech.id == tech_id),
                    self.nodes.get(&stand.node),
                ) {
                    if let Some(start_id) = self
                        .nodes
                        .iter()
                        .min_by(|(_, left), (_, right)| {
                            distance(tech.x, tech.y, left.x, left.y)
                                .total_cmp(&distance(tech.x, tech.y, right.x, right.y))
                        })
                        .map(|(id, _)| id.as_str())
                    {
                        let route_changed = state
                            .tech_routes
                            .get(&tech_id)
                            .is_none_or(|route| route.request_id != request.id);
                        if route_changed {
                            let blocked = state.blocked.clone();
                            if let Some(path) =
                                self.graph.shortest_path(start_id, &stand.node, &blocked)
                            {
                                let mut points = vec![MapPoint {
                                    x: tech.x,
                                    y: tech.y,
                                }];
                                points.extend(
                                    path.nodes
                                        .iter()
                                        .filter_map(|id| self.nodes.get(id).copied()),
                                );
                                state.tech_routes.insert(
                                    tech_id,
                                    TechRoute {
                                        request_id: request.id,
                                        goal_node: stand.node.clone(),
                                        points,
                                        next_point: 1,
                                        published_next_point: 1,
                                        speed: tech.speed.max(0.1),
                                        unreachable: false,
                                    },
                                );
                            } else {
                                state.tech_routes.insert(
                                    tech_id,
                                    TechRoute {
                                        request_id: request.id,
                                        goal_node: stand.node.clone(),
                                        points: vec![MapPoint {
                                            x: tech.x,
                                            y: tech.y,
                                        }],
                                        next_point: 1,
                                        published_next_point: 1,
                                        speed: tech.speed.max(0.1),
                                        unreachable: true,
                                    },
                                );
                            }
                        }
                        if let Some(route) = state.tech_routes.get(&tech_id) {
                            tech.route_available = !route.unreachable;
                            tech.route = std::iter::once([tech.x, tech.y])
                                .chain(
                                    route
                                        .points
                                        .iter()
                                        .skip(route.next_point)
                                        .map(|p| [p.x, p.y]),
                                )
                                .collect();
                            let route_distance = std::iter::once(MapPoint {
                                x: tech.x,
                                y: tech.y,
                            })
                            .chain(route.points.iter().skip(route.next_point).copied())
                            .zip(
                                std::iter::once(MapPoint {
                                    x: tech.x,
                                    y: tech.y,
                                })
                                .chain(route.points.iter().skip(route.next_point).copied())
                                .skip(1),
                            )
                            .map(|(a, b)| distance(a.x, a.y, b.x, b.y))
                            .sum::<f64>();
                            let eta = (!route.unreachable).then_some(route_distance / route.speed);
                            value["eta_left"] = json!(eta);
                            value["eta"] = json!(eta);
                            value["route_available"] = json!(!route.unreachable);
                            value["violation"] = json!(eta.is_some_and(|eta| eta > 900.0));
                            value["travel_mode"] = json!("walk");
                            value["candidates"] = json!([{
                                "tech_id": tech.id,
                                "name": tech.name.clone(),
                                "dist": if route.unreachable { Value::Null } else { json!(route_distance.round() as i64) },
                                "eta": eta,
                                "mode": "walk",
                                "reason": if route.unreachable { "маршрут перекрыт · требуется объезд" } else { "назначен системой · маршрут по открытым РД" }
                            }]);
                        }
                    }
                }
            }
            if matches!(request.status.as_str(), "done" | "cancelled") {
                history.push(value);
            } else {
                waiting += i64::from(request.status == "waiting");
                active.push(value);
            }
            if let Some(tech_id) = request.tech_id {
                if !matches!(request.status.as_str(), "done" | "cancelled") {
                    if let Some(tech) = techs.iter_mut().find(|tech| tech.id == tech_id) {
                        tech.status = "busy".into();
                        tech.request_id = Some(request.id);
                    }
                }
            }
        }

        state.tech_routes.retain(|tech_id, route| {
            requests.iter().any(|request| {
                request.id == route.request_id
                    && request.tech_id == Some(*tech_id)
                    && matches!(request.status.as_str(), "assigned" | "enroute")
            })
        });

        let dispatch_snapshot = current_user.is_none_or(|user| user.role == "dispatcher");
        let filtered_requests: Vec<Value> = if dispatch_snapshot {
            active.clone()
        } else {
            active
                .iter()
                .filter(|request| {
                    request.get("tech_id").and_then(Value::as_i64)
                        == current_user.and_then(|user| user.tech_id)
                })
                .cloned()
                .collect()
        };
        let filtered_history: Vec<Value> = if dispatch_snapshot {
            history.clone()
        } else {
            history
                .iter()
                .filter(|request| {
                    request.get("tech_id").and_then(Value::as_i64)
                        == current_user.and_then(|user| user.tech_id)
                })
                .cloned()
                .collect()
        };
        let mut filtered_map = serde_json::Map::new();
        for request in filtered_requests.iter().chain(filtered_history.iter()) {
            if let Some(id) = request.get("id").and_then(Value::as_i64) {
                filtered_map.insert(id.to_string(), request.clone());
            }
        }
        let my_request = current_user.and_then(|user| {
            active
                .iter()
                .find(|request| request.get("tech_id").and_then(Value::as_i64) == user.tech_id)
        });
        let free_techs = techs
            .iter()
            .filter(|tech| tech.on_shift && tech.status == "free")
            .count();
        let parked = state
            .aircraft
            .iter()
            .filter(|aircraft| aircraft.status == "parked")
            .count();
        let stats = json!({
            "techs_total":techs.len(),"techs_free":free_techs,"active":filtered_requests.len(),
            "waiting":waiting,"done":filtered_history.len(),"avg_response":Value::Null,"norm_pct":100,
            "aircraft_total":state.aircraft.len(),"aircraft_parked":parked,"aircraft_inbound":0,
            "aircraft_departing":state.aircraft.len().saturating_sub(parked),"gse_total":0,"gse_busy":0
        });
        let mut result = json!({
            "sim_time":state.sim_time,"sim_speed":state.sim_speed,"sim_running":state.sim_running,
            "norm":900,"aircraft":state.aircraft,"techs":techs,"vehicles":[],"gse":[],"vehicle_speed":10.0,
            "gse_types":gse_types(),"requests":filtered_map,"active":filtered_requests,"history":filtered_history,
            "blocked":state.blocked,"events":state.events,"stats":stats,"airport_name":self.airport_name,
            "llm":{"mode":"builtin","model":"встроенный"}
        });
        if let Some(user) = current_user {
            result["account"] = serde_json::to_value(user).unwrap_or(Value::Null);
            if user.role == "engineer" {
                result["me"] = techs
                    .iter()
                    .find(|tech| Some(tech.id) == user.tech_id)
                    .and_then(|tech| serde_json::to_value(tech).ok())
                    .unwrap_or(Value::Null);
                result["my_request"] = my_request.cloned().unwrap_or(Value::Null);
            }
        }
        result
    }

    pub fn set_sim(&self, speed: Option<i64>, running: Option<bool>) -> Result<Value, String> {
        let mut state = self
            .state
            .write()
            .map_err(|_| "Состояние аэропорта недоступно".to_owned())?;
        if let Some(speed) = speed {
            if ![1, 2, 5, 10, 20, 50].contains(&speed) {
                return Err("Скорость симуляции должна быть 1, 2, 5, 10, 20 или 50".into());
            }
            state.sim_speed = speed as f64;
        }
        if let Some(running) = running {
            state.sim_running = running;
        }
        Ok(json!({"sim_speed":state.sim_speed,"sim_running":state.sim_running}))
    }

    pub fn rank_technicians(
        &self,
        stand_id: &str,
        qualification: &str,
        users: &[PublicUser],
    ) -> Vec<(i64, f64)> {
        let Some(stand) = self.stands.iter().find(|stand| stand.id == stand_id) else {
            return Vec::new();
        };
        if !self.nodes.contains_key(&stand.node) {
            return Vec::new();
        }
        let Ok(state) = self.state.read() else {
            return Vec::new();
        };
        let mut ranked = users
            .iter()
            .filter(|user| {
                user.role == "engineer"
                    && user.status == "active"
                    && user.on_shift
                    && user.tech_id.is_some()
                    && (qualification == "auto" || user.qual.as_deref() == Some(qualification))
            })
            .filter_map(|user| {
                let tech_id = user.tech_id?;
                let base = self.bases.get(user.base.as_deref().unwrap_or_default())?;
                let base_point = self.nodes.get(&base.node)?;
                let origin = state
                    .tech_positions
                    .get(&tech_id)
                    .copied()
                    .unwrap_or(*base_point);
                let start_id = self
                    .nodes
                    .iter()
                    .min_by(|(_, left), (_, right)| {
                        distance(origin.x, origin.y, left.x, left.y)
                            .total_cmp(&distance(origin.x, origin.y, right.x, right.y))
                    })
                    .map(|(id, _)| id.as_str())?;
                let route = self
                    .graph
                    .shortest_path(start_id, &stand.node, &state.blocked)?;
                let route_distance = distance(
                    origin.x,
                    origin.y,
                    self.nodes.get(start_id)?.x,
                    self.nodes.get(start_id)?.y,
                ) + route.cost as f64 / 1_000.0;
                let speed = state
                    .base_techs
                    .iter()
                    .find(|tech| tech.id == tech_id)
                    .map(|tech| tech.speed)
                    .unwrap_or(4.0)
                    .max(0.1);
                Some((tech_id, route_distance / speed))
            })
            .collect::<Vec<_>>();
        ranked.sort_by(|left, right| left.1.total_cmp(&right.1).then(left.0.cmp(&right.0)));
        ranked
    }

    pub fn set_edge_blocked(&self, edge_id: &str, blocked: bool) -> Result<(), String> {
        let mut state = self
            .state
            .write()
            .map_err(|_| "Состояние аэропорта недоступно".to_owned())?;
        if !self.edge_ids.contains(edge_id) {
            return Err("Ребро карты не найдено".into());
        }
        if blocked {
            state.blocked.insert(edge_id.into());
        } else {
            state.blocked.remove(edge_id);
        }
        let assignments = state
            .tech_routes
            .iter()
            .map(|(tech_id, route)| {
                (
                    *tech_id,
                    route.request_id,
                    route.goal_node.clone(),
                    route.speed,
                )
            })
            .collect::<Vec<_>>();
        for (tech_id, request_id, goal_node, speed) in assignments {
            let position = state.tech_positions.get(&tech_id).copied().or_else(|| {
                state
                    .base_techs
                    .iter()
                    .find(|tech| tech.id == tech_id)
                    .map(|tech| MapPoint {
                        x: tech.x,
                        y: tech.y,
                    })
            });
            let Some(position) = position else { continue };
            let start_id = self
                .nodes
                .iter()
                .min_by(|(_, left), (_, right)| {
                    distance(position.x, position.y, left.x, left.y)
                        .total_cmp(&distance(position.x, position.y, right.x, right.y))
                })
                .map(|(id, _)| id.as_str());
            let replacement = start_id
                .and_then(|start| {
                    self.graph
                        .shortest_path(start, &goal_node, &state.blocked)
                        .map(|path| {
                            let mut points = vec![position];
                            points.extend(
                                path.nodes
                                    .iter()
                                    .filter_map(|id| self.nodes.get(id).copied()),
                            );
                            TechRoute {
                                request_id,
                                goal_node: goal_node.clone(),
                                points,
                                next_point: 1,
                                published_next_point: 1,
                                speed,
                                unreachable: false,
                            }
                        })
                })
                .unwrap_or_else(|| TechRoute {
                    request_id,
                    goal_node: goal_node.clone(),
                    points: vec![position],
                    next_point: 1,
                    published_next_point: 1,
                    speed,
                    unreachable: true,
                });
            state.tech_routes.insert(tech_id, replacement);
        }
        push_event(
            &mut state,
            format!(
                "Ребро {edge_id} {}",
                if blocked {
                    "перекрыто"
                } else {
                    "открыто"
                }
            ),
            "warn",
        );
        Ok(())
    }

    pub fn blocked_edges(&self) -> Result<HashSet<String>, String> {
        self.state
            .read()
            .map(|state| state.blocked.clone())
            .map_err(|_| "Состояние аэропорта недоступно".into())
    }

    pub fn tick(&self, elapsed_seconds: f64) -> Result<Option<Value>, String> {
        let mut state = self
            .state
            .write()
            .map_err(|_| "Состояние аэропорта недоступно".to_owned())?;
        if !state.sim_running {
            return Ok(None);
        }
        let elapsed = elapsed_seconds.clamp(0.0, 2.0) * state.sim_speed;
        state.sim_time += elapsed;
        let mut completed = Vec::new();
        for aircraft in &mut state.aircraft {
            if aircraft.status == "servicing" {
                aircraft.turnaround_progress =
                    (aircraft.turnaround_progress + elapsed * 0.25).min(100.0);
                if aircraft.turnaround_progress >= 100.0 {
                    aircraft.status = "parked".into();
                    aircraft.status_ru = "Готов к вылету".into();
                    completed.push(aircraft.flight.clone());
                }
            }
        }
        for flight in completed {
            push_event(
                &mut state,
                format!("Обслуживание борта {flight} завершено"),
                "info",
            );
        }
        let mut tech_deltas = Vec::new();
        {
            let EngineState {
                tech_routes,
                tech_positions,
                base_techs,
                ..
            } = &mut *state;
            let tech_ids = tech_routes.keys().copied().collect::<Vec<_>>();
            for tech_id in tech_ids {
                let Some(position) = tech_positions.get(&tech_id).copied().or_else(|| {
                    base_techs
                        .iter()
                        .find(|tech| tech.id == tech_id)
                        .map(|tech| MapPoint {
                            x: tech.x,
                            y: tech.y,
                        })
                }) else {
                    continue;
                };
                let Some(route) = tech_routes.get_mut(&tech_id) else {
                    continue;
                };
                let mut current = position;
                let mut budget = route.speed * elapsed;
                while route.next_point < route.points.len() && budget > 0.0 {
                    let target = route.points[route.next_point];
                    let remaining = distance(current.x, current.y, target.x, target.y);
                    if remaining <= 0.001 {
                        current = target;
                        route.next_point += 1;
                    } else if budget >= remaining {
                        current = target;
                        budget -= remaining;
                        route.next_point += 1;
                    } else {
                        let ratio = budget / remaining;
                        current.x += (target.x - current.x) * ratio;
                        current.y += (target.y - current.y) * ratio;
                        budget = 0.0;
                    }
                }
                tech_positions.insert(tech_id, current);
                let remaining_distance = std::iter::once(current)
                    .chain(route.points.iter().skip(route.next_point).copied())
                    .zip(
                        std::iter::once(current)
                            .chain(route.points.iter().skip(route.next_point).copied())
                            .skip(1),
                    )
                    .map(|(a, b)| distance(a.x, a.y, b.x, b.y))
                    .sum::<f64>();
                let mut delta = json!({
                    "id": tech_id, "request_id": route.request_id,
                    "x": current.x, "y": current.y,
                    "eta_left": if route.unreachable { Value::Null } else { json!(remaining_distance / route.speed) },
                    "route_available": !route.unreachable
                });
                if route.next_point != route.published_next_point {
                    delta["route"] = json!(std::iter::once([current.x, current.y])
                        .chain(
                            route
                                .points
                                .iter()
                                .skip(route.next_point)
                                .map(|p| [p.x, p.y])
                        )
                        .collect::<Vec<_>>());
                    route.published_next_point = route.next_point;
                }
                tech_deltas.push(delta);
            }
        }
        let aircraft = state
            .aircraft
            .iter()
            .map(|aircraft| {
                json!({
                    "id": aircraft.id,
                    "status": aircraft.status,
                    "status_ru": aircraft.status_ru,
                    "turnaround_progress": aircraft.turnaround_progress,
                    "services_progress": aircraft.services_progress,
                })
            })
            .collect::<Vec<_>>();
        Ok(Some(
            json!({"sim_time":state.sim_time,"sim_speed":state.sim_speed,"sim_running":state.sim_running,"aircraft":aircraft,"techs":tech_deltas}),
        ))
    }

    pub fn move_tech(&self, tech_id: i64, x: f64, y: f64) -> Result<Value, String> {
        if !x.is_finite() || !y.is_finite() {
            return Err("Некорректные координаты специалиста".into());
        }
        let mut state = self
            .state
            .write()
            .map_err(|_| "Состояние аэропорта недоступно".to_owned())?;
        state.tech_positions.insert(tech_id, MapPoint { x, y });
        state.tech_routes.remove(&tech_id);
        Ok(json!({"id":tech_id,"x":x,"y":y}))
    }

    pub fn has_tech(&self, tech_id: i64) -> bool {
        self.state
            .read()
            .map(|state| {
                state.base_techs.iter().any(|tech| tech.id == tech_id)
                    || state.tech_positions.contains_key(&tech_id)
                    || state.tech_profiles.contains_key(&tech_id)
            })
            .unwrap_or(false)
    }

    pub fn update_tech_profile(
        &self,
        tech_id: i64,
        qual: &str,
        types: &[String],
    ) -> Result<Value, String> {
        if qual.trim().is_empty() {
            return Err("Укажите квалификацию".into());
        }
        let mut state = self
            .state
            .write()
            .map_err(|_| "Состояние аэропорта недоступно".to_owned())?;
        state
            .tech_profiles
            .insert(tech_id, (qual.trim().to_owned(), types.to_vec()));
        Ok(json!({"id":tech_id,"qual":qual.trim(),"types":types}))
    }

    pub fn spawn_aircraft(&self) -> Result<Value, String> {
        let mut state = self
            .state
            .write()
            .map_err(|_| "Состояние аэропорта недоступно".to_owned())?;
        let occupied: HashSet<&str> = state
            .aircraft
            .iter()
            .map(|aircraft| aircraft.stand.as_str())
            .collect();
        let Some(stand) = self
            .stands
            .iter()
            .find(|stand| !occupied.contains(stand.id.as_str()))
        else {
            return Err("Все стоянки заняты".into());
        };
        let aircraft = build_aircraft(
            state.next_aircraft_id,
            stand,
            &self.nodes,
            &self.airport_name,
        );
        state.next_aircraft_id += 1;
        push_event(
            &mut state,
            format!(
                "Прибыл борт {} на стоянку {}",
                aircraft.flight, aircraft.stand
            ),
            "info",
        );
        let response = json!({"id":aircraft.id,"flight":aircraft.flight});
        state.aircraft.push(aircraft);
        Ok(response)
    }

    pub fn depart_aircraft(&self, id: i64) -> Result<(), String> {
        let mut state = self
            .state
            .write()
            .map_err(|_| "Состояние аэропорта недоступно".to_owned())?;
        let Some(index) = state.aircraft.iter().position(|aircraft| aircraft.id == id) else {
            return Err("Борт не найден".into());
        };
        let aircraft = state.aircraft.remove(index);
        push_event(
            &mut state,
            format!(
                "Борт {} отправлен со стоянки {}",
                aircraft.flight, aircraft.stand
            ),
            "info",
        );
        Ok(())
    }

    pub fn reset(&self) -> Result<(), String> {
        let mut state = self
            .state
            .write()
            .map_err(|_| "Состояние аэропорта недоступно".to_owned())?;
        state.aircraft.clear();
        state.next_aircraft_id = 1;
        for stand in self.stands.iter().take(4) {
            let id = state.next_aircraft_id;
            state
                .aircraft
                .push(build_aircraft(id, stand, &self.nodes, &self.airport_name));
            state.next_aircraft_id += 1;
        }
        state.blocked.clear();
        state.tech_routes.clear();
        state.events.clear();
        state.sim_time = 0.0;
        Ok(())
    }
}

fn distance(x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    (x2 - x1).hypot(y2 - y1)
}

fn timestamp_seconds(value: Option<&str>) -> Option<i64> {
    value
        .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
        .map(|value| value.unix_timestamp())
}

fn add_legacy_request_fields(
    value: &mut Value,
    request: &RequestRecord,
    sim_time: f64,
    sim_speed: f64,
    sim_running: bool,
) {
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let scale = if sim_running { sim_speed.max(0.0) } else { 0.0 };
    let created_at = timestamp_seconds(Some(&request.created_at)).unwrap_or(now);
    let created_elapsed = (now - created_at).max(0) as f64 * scale;
    let created_sim = sim_time - created_elapsed;
    let arrived_at = timestamp_seconds(request.arrived_at.as_deref());
    let resolved_at = timestamp_seconds(request.resolved_at.as_deref());
    let arrived_sim = arrived_at.map(|at| sim_time - (now - at).max(0) as f64 * scale);
    let done_sim = resolved_at.map(|at| sim_time - (now - at).max(0) as f64 * scale);
    let frozen_elapsed = arrived_at
        .map(|at| (at - created_at).max(0) as f64 * scale)
        .unwrap_or(created_elapsed);

    value["created_sim"] = json!(created_sim);
    value["arrived_sim"] = arrived_sim.map_or(Value::Null, |time| json!(time));
    value["done_sim"] = done_sim.map_or(Value::Null, |time| json!(time));
    value["elapsed"] = json!(frozen_elapsed);
    value["eta"] = Value::Null;
    value["eta_left"] = Value::Null;
    value["violation"] = json!(false);
    value["note"] = json!("");
    value["candidates"] = json!([]);
    value["vehicle_id"] = Value::Null;
    value["travel_mode"] = json!("walk");
    if request.status == "assigned" {
        value["status"] = json!("enroute");
        value["status_ru"] = json!("В пути");
    }
}

fn build_aircraft(
    id: i64,
    stand: &Stand,
    nodes: &HashMap<String, MapPoint>,
    airport_name: &str,
) -> Aircraft {
    let pos = nodes.get(&stand.node).copied().unwrap_or(MapPoint {
        x: 500.0 + id as f64 * 120.0,
        y: 600.0,
    });
    let models = ["A320", "B737", "SSJ-100", "A321", "B777"];
    let flight = 1000 + ((id * 7919) % 8999);
    Aircraft {
        id,
        flight: format!("SU{flight}"),
        stand: stand.id.clone(),
        model: models[(id as usize - 1) % models.len()].into(),
        status: "parked".into(),
        status_ru: "На стоянке".into(),
        turnaround_progress: 100.0,
        x: pos.x,
        y: pos.y,
        heading: if stand.heading == 0.0 {
            180.0
        } else {
            stand.heading
        },
        route: Vec::new(),
        eta_left: None,
        parked_left: None,
        brief: json!({"airline":"Аэрофлот","registration":format!("RA-{:05}",73000+id*37),"origin":{"iata":"LED","name":"Пулково (Санкт-Петербург)"},"destination":{"iata":"SVO","name":airport_name},"gate":format!("{}",1+(id%18))}),
        services: Vec::new(),
        services_progress: 100,
        sched_arr_sim: -2700.0,
        actual_arr_sim: -2580.0,
        sched_dep_sim: 5400.0 + id as f64 * 600.0,
        actual_dep_sim: 5400.0 + id as f64 * 600.0,
        delay_arr_sec: 120.0,
    }
}

fn push_event(state: &mut EngineState, text: String, kind: &str) {
    state.events.push_back(json!({"ts":time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),"text":text,"request_id":0,"kind":kind}));
    while state.events.len() > 50 {
        state.events.pop_front();
    }
}

fn gse_types() -> Value {
    json!({
        "fuel":{"label":"Топливозаправщик","color":"#E5A93C","short":"ТЗП","lane":1},
        "catering":{"label":"Кейтеринг","color":"#7699C2","short":"КТР","lane":2},
        "baggage":{"label":"Багажный тягач","color":"#A391C2","short":"БАГ","lane":1},
        "cleaning":{"label":"Клининг","color":"#67A985","short":"КЛН","lane":2},
        "tow":{"label":"Буксировщик","color":"#D99A42","short":"ТЯГ","lane":0},
        "deicing":{"label":"Противообледенитель","color":"#58B5C2","short":"ПОЖ","lane":0},
        "ground_pwr":{"label":"УКП (питание)","color":"#C476A8","short":"УКП","lane":1}
    })
}
