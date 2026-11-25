use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    env,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const DEFAULT_LAT: f64 = 55.8330053;
const DEFAULT_LON: f64 = 37.628713;
const DEFAULT_RADIUS_NM: u16 = 50;
const DEFAULT_POLL_SECONDS: u64 = 180;

#[derive(Clone)]
pub struct AviationService(Arc<Inner>);

struct Inner {
    client: Client,
    base_url: String,
    api_key: Option<String>,
    enabled: bool,
    latitude: f64,
    longitude: f64,
    radius_nm: u16,
    poll_seconds: u64,
    cache: Mutex<std::collections::HashMap<String, Cache>>,
}

#[derive(Default)]
struct Cache {
    center: [f64; 2],
    fetched_at: Option<Instant>,
    attempted_at: Option<Instant>,
    retry_not_before: Option<Instant>,
    fetched_at_ms: Option<i64>,
    aircraft: Vec<RealAircraft>,
    last_error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct RealAircraft {
    pub source_type: &'static str,
    pub icao24: String,
    pub callsign: Option<String>,
    pub registration: Option<String>,
    pub aircraft_type: Option<String>,
    pub description: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    pub altitude_m: Option<f64>,
    pub altitude_geom_m: Option<f64>,
    pub ground_speed_mps: Option<f64>,
    pub heading_deg: Option<f64>,
    pub vertical_rate_mps: Option<f64>,
    pub squawk: Option<String>,
    pub on_ground: Option<bool>,
    pub last_seen_ms: Option<i64>,
    pub freshness_s: Option<f64>,
    pub data_source: &'static str,
}

#[derive(Serialize)]
pub struct LiveAircraftSnapshot {
    pub provider: &'static str,
    pub license: &'static str,
    pub status: &'static str,
    pub enabled: bool,
    pub airport: String,
    pub center: [f64; 2],
    pub radius_nm: u16,
    pub fetched_at_ms: Option<i64>,
    pub age_s: Option<u64>,
    pub poll_interval_s: u64,
    pub aircraft: Vec<RealAircraft>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct AdsbResponse {
    now: Option<i64>,
    ac: Option<Vec<AdsbRecord>>,
}

#[derive(Deserialize)]
struct AdsbRecord {
    hex: Option<String>,
    flight: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
    alt_baro: Option<Value>,
    alt_geom: Option<Value>,
    gs: Option<f64>,
    track: Option<f64>,
    baro_rate: Option<f64>,
    squawk: Option<String>,
    seen_pos: Option<f64>,
    r: Option<String>,
    t: Option<String>,
    desc: Option<String>,
}

impl AviationService {
    pub fn from_env() -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .user_agent(concat!(
                "RampPulse/",
                env!("CARGO_PKG_VERSION"),
                " (+https://github.com/TEXNOLONG/RampPulse)"
            ))
            .timeout(Duration::from_secs(12))
            .build()?;
        let enabled = env_bool("AIRCRAFT_ENABLED", true);
        let latitude = env_number("AIRCRAFT_CENTER_LAT", DEFAULT_LAT).clamp(-90.0, 90.0);
        let longitude = env_number("AIRCRAFT_CENTER_LON", DEFAULT_LON).clamp(-180.0, 180.0);
        Ok(Self(Arc::new(Inner {
            client,
            base_url: env::var("AIRCRAFT_API_BASE")
                .unwrap_or_else(|_| "https://api.adsb.lol".into())
                .trim_end_matches('/')
                .to_owned(),
            api_key: env::var("AIRCRAFT_API_KEY")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            enabled,
            latitude,
            longitude,
            radius_nm: env_number("AIRCRAFT_MAX_RADIUS", DEFAULT_RADIUS_NM as f64)
                .round()
                .clamp(1.0, 250.0) as u16,
            poll_seconds: env_number("AIRCRAFT_POLL_INTERVAL", DEFAULT_POLL_SECONDS as f64)
                .round()
                .clamp(DEFAULT_POLL_SECONDS as f64, 86_400.0) as u64,
            cache: Mutex::new(std::collections::HashMap::new()),
        })))
    }

    pub async fn snapshot(&self) -> LiveAircraftSnapshot {
        self.snapshot_at(self.0.latitude, self.0.longitude).await
    }

    pub async fn snapshot_at(&self, latitude: f64, longitude: f64) -> LiveAircraftSnapshot {
        let now = Instant::now();
        let key = format!("{:.2}:{:.2}", latitude, longitude);
        let mut caches = self.0.cache.lock().await;
        if caches.len() >= 8 && !caches.contains_key(&key) {
            if let Some(oldest) = caches
                .iter()
                .min_by_key(|(_, cache)| cache.fetched_at)
                .map(|(key, _)| key.clone())
            {
                caches.remove(&oldest);
            }
        }
        let cache = caches.entry(key).or_default();
        cache.center = [latitude, longitude];
        let age = cache
            .fetched_at
            .map(|at| now.saturating_duration_since(at).as_secs());
        if !self.0.enabled {
            return self.response(
                &cache,
                "OFFLINE",
                age,
                Some("Live aircraft feed is disabled by AIRCRAFT_ENABLED.".into()),
            );
        }
        if cache
            .retry_not_before
            .is_some_and(|deadline| now < deadline)
        {
            let status = if cache.fetched_at.is_some() {
                "STALE"
            } else {
                "OFFLINE"
            };
            return self.response(&cache, status, age, cache.last_error.clone());
        }
        if cache
            .attempted_at
            .is_some_and(|at| now.saturating_duration_since(at).as_secs() < self.0.poll_seconds)
        {
            let status = if cache.last_error.is_some() && cache.fetched_at.is_some() {
                "STALE"
            } else if cache.fetched_at.is_some() {
                "LIVE"
            } else {
                "OFFLINE"
            };
            let error = cache.last_error.clone();
            return self.response(&cache, status, age, error);
        }

        cache.attempted_at = Some(now);
        let url = format!(
            "{}/v2/lat/{}/lon/{}/dist/{}",
            self.0.base_url, latitude, longitude, self.0.radius_nm
        );
        let mut request = self
            .0
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(key) = &self.0.api_key {
            request = request.header("x-api-key", key);
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => {
                match response.json::<AdsbResponse>().await {
                    Ok(data) => {
                        let now_ms = data.now.unwrap_or_else(unix_ms);
                        let mut seen = HashSet::new();
                        cache.aircraft = data
                            .ac
                            .unwrap_or_default()
                            .into_iter()
                            .filter_map(|record| map_record(record, now_ms))
                            .filter(|record| seen.insert(record.icao24.clone()))
                            .collect();
                        cache.fetched_at = Some(Instant::now());
                        cache.retry_not_before = None;
                        cache.fetched_at_ms = Some(now_ms);
                        cache.last_error = None;
                        self.response(&cache, "LIVE", Some(0), None)
                    }
                    Err(_) => self.failed(cache, "The aircraft provider returned invalid JSON."),
                }
            }
            Ok(response) => {
                let status = response.status();
                let retry_after = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let message = if status.as_u16() == 429 {
                    if let Some(seconds) = retry_after
                        .as_deref()
                        .and_then(|value| value.parse::<u64>().ok())
                    {
                        cache.retry_not_before =
                            Some(Instant::now() + Duration::from_secs(seconds.min(86_400)));
                    }
                    format!(
                        "Aircraft provider rate limit reached{}.",
                        retry_after
                            .map(|value| format!("; retry after {value}s"))
                            .unwrap_or_default()
                    )
                } else {
                    format!("Aircraft provider returned HTTP {status}.")
                };
                self.failed(cache, &message)
            }
            Err(_) => self.failed(cache, "Aircraft provider is unreachable or timed out."),
        }
    }

    fn failed(&self, cache: &mut Cache, message: &str) -> LiveAircraftSnapshot {
        cache.last_error = Some(message.to_owned());
        let age = cache
            .fetched_at
            .map(|at| Instant::now().saturating_duration_since(at).as_secs());
        let status = if cache.fetched_at.is_some() {
            "STALE"
        } else {
            "OFFLINE"
        };
        self.response(cache, status, age, Some(message.to_owned()))
    }

    fn response(
        &self,
        cache: &Cache,
        status: &'static str,
        age_s: Option<u64>,
        error: Option<String>,
    ) -> LiveAircraftSnapshot {
        LiveAircraftSnapshot {
            provider: "adsb.lol",
            license: "ODbL-1.0",
            status,
            enabled: self.0.enabled,
            airport: if (cache.center[0] - self.0.latitude).abs() < 0.01
                && (cache.center[1] - self.0.longitude).abs() < 0.01
            {
                "VDNH / VDN".into()
            } else {
                "Custom map center".into()
            },
            center: cache.center,
            radius_nm: self.0.radius_nm,
            fetched_at_ms: cache.fetched_at_ms,
            age_s,
            poll_interval_s: self.0.poll_seconds,
            aircraft: cache.aircraft.clone(),
            error,
        }
    }
}

fn map_record(record: AdsbRecord, now_ms: i64) -> Option<RealAircraft> {
    let latitude = record.lat?;
    let longitude = record.lon?;
    let icao24 = record.hex?.trim().to_ascii_lowercase();
    if icao24.is_empty()
        || !(-90.0..=90.0).contains(&latitude)
        || !(-180.0..=180.0).contains(&longitude)
    {
        return None;
    }
    let freshness = record
        .seen_pos
        .filter(|value| value.is_finite() && *value >= 0.0);
    Some(RealAircraft {
        source_type: "REAL",
        icao24,
        callsign: record
            .flight
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
        registration: record.r,
        aircraft_type: record.t,
        description: record.desc,
        latitude,
        longitude,
        altitude_m: number(&record.alt_baro).map(|feet| feet * 0.3048),
        altitude_geom_m: number(&record.alt_geom).map(|feet| feet * 0.3048),
        ground_speed_mps: record
            .gs
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|knots| knots * 0.514_444),
        heading_deg: record
            .track
            .filter(|value| value.is_finite())
            .map(|degrees| degrees.rem_euclid(360.0)),
        vertical_rate_mps: record
            .baro_rate
            .filter(|value| value.is_finite())
            .map(|fpm| fpm * 0.00508),
        squawk: record.squawk,
        on_ground: record
            .alt_baro
            .as_ref()
            .map(|value| value.as_str() == Some("ground")),
        last_seen_ms: freshness.map(|seconds| now_ms - (seconds * 1_000.0) as i64),
        freshness_s: freshness,
        data_source: "adsb.lol",
    })
}

fn number(value: &Option<Value>) -> Option<f64> {
    match value.as_ref()? {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        _ => None,
    }
}

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn env_number(name: &str, default: f64) -> f64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(default)
}

fn env_bool(name: &str, default: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_real_aircraft_units_and_freshness() {
        let record: AdsbRecord = serde_json::from_value(serde_json::json!({
            "hex":"ABC123", "flight":"RP123  ", "lat":55.5, "lon":37.5,
            "alt_baro":10000, "gs":100, "track":370, "baro_rate":1000,
            "seen_pos":2.5, "r":"RA-00001", "t":"A320", "type":"adsb_icao"
        }))
        .unwrap();
        let aircraft = map_record(record, 10_000).unwrap();
        assert_eq!(aircraft.source_type, "REAL");
        assert_eq!(aircraft.icao24, "abc123");
        assert_eq!(aircraft.callsign.as_deref(), Some("RP123"));
        assert!((aircraft.altitude_m.unwrap() - 3048.0).abs() < 0.001);
        assert!((aircraft.ground_speed_mps.unwrap() - 51.4444).abs() < 0.001);
        assert_eq!(aircraft.heading_deg, Some(10.0));
        assert_eq!(aircraft.last_seen_ms, Some(7_500));
    }

    #[test]
    fn filters_records_without_coordinates_or_with_invalid_coordinates() {
        let missing: AdsbRecord =
            serde_json::from_value(serde_json::json!({"hex":"abc123","lat":55})).unwrap();
        assert!(map_record(missing, 0).is_none());
        let invalid: AdsbRecord =
            serde_json::from_value(serde_json::json!({"hex":"abc123","lat":100,"lon":37})).unwrap();
        assert!(map_record(invalid, 0).is_none());
    }
}
