use super::*;

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Fix {
    pub kind: String,
    pub agent_id: String,
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy: f64,
    pub observed_ms: i64,
}

fn now_ms() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

fn validate(fix: &Fix, now: i64) -> bool {
    matches!(fix.kind.as_str(), "engineer" | "vehicle" | "aircraft")
        && !fix.agent_id.trim().is_empty()
        && fix.agent_id.len() <= 64
        && !fix.agent_id.chars().any(char::is_control)
        && (-90.0..=90.0).contains(&fix.latitude)
        && (-180.0..=180.0).contains(&fix.longitude)
        && (0.0..=100_000.0).contains(&fix.accuracy)
        && fix.observed_ms > 0
        && fix.observed_ms <= now + 5_000
}

pub(super) async fn ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(fix): Json<Fix>,
) -> Result<Json<Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    if user.role != "dispatcher"
        && !(user.role == "engineer"
            && user.on_shift
            && fix.kind == "engineer"
            && user.tech_id.map(|n| n.to_string()) == Some(fix.agent_id.clone()))
    {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "Position source is not authorized",
        ));
    }
    if !validate(&fix, now_ms()) {
        return Err(HttpError(StatusCode::BAD_REQUEST, "Invalid position"));
    }
    let changed = state.store.record_fix(&fix).map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Position storage unavailable",
        )
    })?;
    if changed {
        apply_fix(&state, &fix, &user)?;
    }
    Ok(Json(json!({"accepted":changed})))
}

pub(super) async fn positions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, HttpError> {
    let user = authenticated_user(&state, &headers).await?;
    require_dispatcher(&user)?;
    let mut items = state.store.field_positions().map_err(|_| {
        HttpError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Position storage unavailable",
        )
    })?;
    let now = now_ms();
    for item in &mut items {
        item["stale"] = json!(now - item["observed_ms"].as_i64().unwrap_or(0) > 45_000);
    }
    Ok(Json(json!(items)))
}

pub(super) fn apply_fix(
    state: &AppState,
    fix: &Fix,
    user: &store::PublicUser,
) -> Result<(), HttpError> {
    if fix.kind != "engineer" || now_ms() - fix.observed_ms > 30_000 || fix.accuracy > 30.0 {
        return Ok(());
    }
    let Ok(tech) = fix.agent_id.parse::<i64>() else {
        return Ok(());
    };
    let map = &state.airport_data;
    let t = &map["geo_transform"];
    let (Some(lat), Some(lon), Some(sy), Some(sx)) = (
        t["origin_latitude"].as_f64(),
        t["origin_longitude"].as_f64(),
        t["meters_per_degree_latitude"].as_f64(),
        t["meters_per_degree_longitude"].as_f64(),
    ) else {
        return Ok(());
    };
    let (x, y) = ((fix.longitude - lon) * sx, (lat - fix.latitude) * sy);
    if !(0.0..=map["width"].as_f64().unwrap_or(0.0)).contains(&x)
        || !(0.0..=map["height"].as_f64().unwrap_or(0.0)).contains(&y)
    {
        return Ok(());
    }
    let _ = state.engine.move_tech(tech, x, y);
    let radius = map["arrival_radius_m"].as_f64().unwrap_or(35.0);
    let requests = state
        .store
        .requests_for(user)
        .map_err(|_| HttpError(StatusCode::INTERNAL_SERVER_ERROR, "Cannot read assignments"))?;
    for req in requests
        .iter()
        .filter(|r| r.status == "enroute" && r.tech_id == Some(tech))
    {
        let node = map["stands"]
            .as_array()
            .and_then(|stands| stands.iter().find(|s| s["id"] == req.stand))
            .and_then(|s| s["node"].as_str());
        let point = node.and_then(|id| map["nodes"].as_array()?.iter().find(|p| p["id"] == id));
        let Some((px, py)) = point.and_then(|p| Some((p["x"].as_f64()?, p["y"].as_f64()?))) else {
            continue;
        };
        if (x - px).hypot(y - py) + fix.accuracy > radius {
            continue;
        }
        // Only the linked engineer can commit automatic arrival; dispatcher telemetry is observational.
        if user.role != "engineer" {
            continue;
        }
        if let Ok(arrived) = state.store.transition_request(req.id, "arrived", user) {
            let entity = Some(EntityRef {
                kind: "request".into(),
                id: req.id.to_string(),
                version: arrived.version as u64,
            });
            for target in [Audience::User(user.id), Audience::Role("dispatcher".into())] {
                state.realtime.publish(
                    EventKind::RequestStatusChanged,
                    target,
                    None,
                    entity.clone(),
                    json!({"id":req.id,"status":"arrived","source":"gps"}),
                );
            }
        }
    }
    Ok(())
}

pub(super) async fn warnings(state: AppState) {
    let mut timer = tokio::time::interval(std::time::Duration::from_secs(5));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        timer.tick().await;
        let store = state.store.clone();
        if let Ok(Ok(rows)) = task::spawn_blocking(move || store.due_arrival_warnings()).await {
            for (id, user) in rows {
                let body =
                    format!("До норматива прибытия по заявке №{id} осталось не более пяти минут.");
                let msg = json!({"request_id":id,"message":body,"kind":"arrival_warning"});
                state.realtime.publish(
                    EventKind::RequestEscalated,
                    Audience::User(user),
                    None,
                    None,
                    msg.clone(),
                );
                push_user(&state, user, "Срок прибытия", &body, msg);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_future_and_invalid_fixes() {
        let mut f = Fix {
            kind: "engineer".into(),
            agent_id: "1".into(),
            latitude: 55.0,
            longitude: 37.0,
            accuracy: 5.0,
            observed_ms: 1000,
        };
        assert!(validate(&f, 1000));
        f.observed_ms = 9000;
        assert!(!validate(&f, 1000));
        f.observed_ms = 1000;
        f.latitude = 91.0;
        assert!(!validate(&f, 1000));
    }
}
