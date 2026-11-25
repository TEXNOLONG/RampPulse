use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    env,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const DEFAULT_LAT: f64 = 55.8330053;
const DEFAULT_LON: f64 = 37.628713;
const DEFAULT_CACHE_SECONDS: u64 = 600;
const DEFAULT_REFRESH_COOLDOWN_SECONDS: u64 = 60;

#[derive(Clone)]
pub struct WeatherService(Arc<Inner>);

struct Inner {
    client: Client,
    default_latitude: f64,
    default_longitude: f64,
    cache_seconds: u64,
    refresh_cooldown_seconds: u64,
    wind_warning_mps: f64,
    cache: Mutex<HashMap<String, CacheEntry>>,
    last_provider_request: Mutex<Option<Instant>>,
}

#[derive(Clone)]
struct CacheEntry {
    fetched_at: Instant,
    last_attempt: Instant,
    data: CurrentWeather,
}

#[derive(Default, Clone, Serialize)]
pub struct CurrentWeather {
    pub provider: &'static str,
    pub enabled: bool,
    pub latitude: f64,
    pub longitude: f64,
    pub fetched_at_ms: Option<u64>,
    pub observed_at_ms: Option<u64>,
    pub cache_seconds: u64,
    pub temperature_c: Option<i32>,
    pub feels_like_c: Option<i32>,
    pub condition: Option<String>,
    pub icon: Option<String>,
    pub wind_speed_mps: Option<f64>,
    pub wind_gust_mps: Option<f64>,
    pub wind_direction: Option<String>,
    pub humidity_percent: Option<u8>,
    pub pressure_mm: Option<u16>,
    pub pressure_hpa: Option<u16>,
    pub cloud_cover_percent: Option<u8>,
    pub precipitation_mm: Option<f64>,
    pub precipitation_type: Option<u8>,
    pub precipitation_strength: Option<f64>,
    pub precipitation_probability_percent: Option<u8>,
    pub visibility_m: Option<u32>,
    pub sunrise: Option<String>,
    pub sunset: Option<String>,
    pub uv_index: Option<f64>,
    pub dew_point_c: Option<f64>,
    pub timezone: Option<String>,
    pub is_thunder: Option<bool>,
    pub phenomenon: Option<String>,
    pub alerts: Vec<WeatherAlert>,
    pub error: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct WeatherAlert {
    pub code: String,
    pub severity: String,
    pub title: String,
    pub message: String,
}

impl WeatherService {
    pub fn from_env() -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .user_agent(concat!(
                "RampPulse/",
                env!("CARGO_PKG_VERSION"),
                " (+https://github.com/TEXNOLONG/RampPulse)"
            ))
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self(Arc::new(Inner {
            client,
            default_latitude: env_number("WEATHER_LAT", DEFAULT_LAT).clamp(-90.0, 90.0),
            default_longitude: env_number("WEATHER_LON", DEFAULT_LON).clamp(-180.0, 180.0),
            cache_seconds: env_u64("WEATHER_CACHE_SECONDS", DEFAULT_CACHE_SECONDS)
                .clamp(60, 86_400),
            refresh_cooldown_seconds: env_u64(
                "WEATHER_REFRESH_COOLDOWN_SECONDS",
                DEFAULT_REFRESH_COOLDOWN_SECONDS,
            )
            .clamp(30, 3_600),
            wind_warning_mps: env_number("WEATHER_WIND_WARNING_MPS", 15.0).clamp(1.0, 100.0),
            cache: Mutex::new(HashMap::new()),
            last_provider_request: Mutex::new(None),
        })))
    }

    pub async fn current(
        &self,
        latitude: Option<f64>,
        longitude: Option<f64>,
        force: bool,
    ) -> CurrentWeather {
        let latitude = latitude.unwrap_or(self.0.default_latitude);
        let longitude = longitude.unwrap_or(self.0.default_longitude);
        let key = format!("{latitude:.2}:{longitude:.2}");
        let mut cache = self.0.cache.lock().await;
        if let Some(entry) = cache.get(&key) {
            if !force && entry.fetched_at.elapsed() < Duration::from_secs(self.0.cache_seconds) {
                return entry.data.clone();
            }
            if force
                && entry.last_attempt.elapsed()
                    < Duration::from_secs(self.0.refresh_cooldown_seconds)
            {
                let mut data = entry.data.clone();
                data.error = Some(format!(
                    "Manual refresh is limited to once every {} seconds.",
                    self.0.refresh_cooldown_seconds
                ));
                data.error_code = Some("RATE_LIMITED".into());
                return data;
            }
        }
        {
            let mut last = self.0.last_provider_request.lock().await;
            if last.is_some_and(|time| {
                time.elapsed() < Duration::from_secs(self.0.refresh_cooldown_seconds)
            }) {
                let mut data = cache
                    .get(&key)
                    .map(|entry| entry.data.clone())
                    .unwrap_or_else(|| self.snapshot(latitude, longitude));
                data.error = Some(format!(
                    "Weather requests are limited to one every {} seconds.",
                    self.0.refresh_cooldown_seconds
                ));
                data.error_code = Some("RATE_LIMITED".into());
                return data;
            }
            *last = Some(Instant::now());
        }
        if let Some(entry) = cache.get_mut(&key) {
            entry.last_attempt = Instant::now();
        }
        let result = self.0.client.get("https://api.open-meteo.com/v1/forecast")
            .query(&[("latitude", latitude.to_string()), ("longitude", longitude.to_string()),
                ("current", "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,dew_point_2m,uv_index".to_owned()),
                ("hourly", "precipitation_probability".to_owned()), ("daily", "sunrise,sunset".to_owned()),
                ("forecast_days", "1".to_owned()), ("timezone", "auto".to_owned()), ("timeformat", "unixtime".to_owned()), ("wind_speed_unit", "ms".to_owned())])
            .send().await;
        match result {
            Ok(response) if response.status().is_success() => {
                match response.json::<Value>().await {
                    Ok(body) => {
                        let Some(current) = body.get("current") else {
                            return self.failed(
                                &mut cache,
                                &key,
                                latitude,
                                longitude,
                                "Open-Meteo returned no current conditions.",
                                "INVALID_RESPONSE",
                            );
                        };
                        let now = number(current, "time")
                            .map(|value| value as u64)
                            .unwrap_or_else(now_seconds);
                        let fetched = now_millis();
                        let mut data = self.snapshot(latitude, longitude);
                        data.fetched_at_ms = Some(fetched);
                        data.observed_at_ms = Some(now.saturating_mul(1000));
                        data.temperature_c =
                            number(current, "temperature_2m").map(|v| v.round() as i32);
                        data.feels_like_c =
                            number(current, "apparent_temperature").map(|v| v.round() as i32);
                        let code = number(current, "weather_code").unwrap_or(0.0) as u16;
                        data.condition = Some(condition(code).into());
                        data.icon = None;
                        data.wind_speed_mps = number(current, "wind_speed_10m");
                        data.wind_gust_mps = number(current, "wind_gusts_10m");
                        data.wind_direction = number(current, "wind_direction_10m").map(compass);
                        data.humidity_percent = number(current, "relative_humidity_2m")
                            .map(|v| v.clamp(0.0, 100.0).round() as u8);
                        data.pressure_hpa =
                            number(current, "surface_pressure").map(|v| v.round() as u16);
                        data.pressure_mm = number(current, "surface_pressure")
                            .map(|v| (v * 0.750_061_683).round() as u16);
                        data.cloud_cover_percent = number(current, "cloud_cover")
                            .map(|v| v.clamp(0.0, 100.0).round() as u8);
                        data.precipitation_mm = number(current, "precipitation");
                        data.precipitation_type =
                            if number(current, "snowfall").unwrap_or(0.0) > 0.0 {
                                Some(3)
                            } else if number(current, "rain").unwrap_or(0.0) > 0.0 {
                                Some(1)
                            } else {
                                Some(0)
                            };
                        data.precipitation_strength =
                            data.precipitation_mm
                                .map(|v| if v >= 0.75 { 0.75 } else { v / 0.75 });
                        data.visibility_m =
                            number(current, "visibility").map(|v| v.max(0.0) as u32);
                        data.uv_index = number(current, "uv_index");
                        data.dew_point_c = number(current, "dew_point_2m");
                        data.is_thunder = Some(code >= 95);
                        data.phenomenon = Some(condition(code).into());
                        data.timezone = body
                            .get("timezone")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        data.precipitation_probability_percent = probability(&body, now);
                        data.sunrise = daily_time(&body, "sunrise");
                        data.sunset = daily_time(&body, "sunset");
                        data.alerts = self.build_alerts(&data);
                        if cache.len() >= 32 && !cache.contains_key(&key) {
                            if let Some(old) = cache
                                .iter()
                                .min_by_key(|(_, e)| e.fetched_at)
                                .map(|(k, _)| k.clone())
                            {
                                cache.remove(&old);
                            }
                        }
                        cache.insert(
                            key,
                            CacheEntry {
                                fetched_at: Instant::now(),
                                last_attempt: Instant::now(),
                                data: data.clone(),
                            },
                        );
                        data
                    }
                    Err(_) => self.failed(
                        &mut cache,
                        &key,
                        latitude,
                        longitude,
                        "Open-Meteo returned an invalid response.",
                        "INVALID_RESPONSE",
                    ),
                }
            }
            Ok(response) => {
                let (message, code) = match response.status().as_u16() {
                    400 => (
                        "Open-Meteo rejected the coordinates or request.",
                        "INVALID_LOCATION",
                    ),
                    429 => ("Open-Meteo request limit was reached.", "RATE_LIMITED"),
                    _ => ("Open-Meteo returned an error.", "PROVIDER_ERROR"),
                };
                self.failed(&mut cache, &key, latitude, longitude, message, code)
            }
            Err(_) => self.failed(
                &mut cache,
                &key,
                latitude,
                longitude,
                "Open-Meteo is unreachable or timed out.",
                "OFFLINE",
            ),
        }
    }

    fn failed(
        &self,
        cache: &mut HashMap<String, CacheEntry>,
        key: &str,
        lat: f64,
        lon: f64,
        message: &str,
        code: &str,
    ) -> CurrentWeather {
        if let Some(entry) = cache.get_mut(key) {
            entry.last_attempt = Instant::now();
            let mut data = entry.data.clone();
            data.error = Some(message.into());
            data.error_code = Some(code.into());
            return data;
        }
        self.empty_snapshot(lat, lon, message, code)
    }
    fn empty_snapshot(&self, lat: f64, lon: f64, message: &str, code: &str) -> CurrentWeather {
        let mut data = self.snapshot(lat, lon);
        data.error = Some(message.into());
        data.error_code = Some(code.into());
        data
    }
    fn snapshot(&self, lat: f64, lon: f64) -> CurrentWeather {
        CurrentWeather {
            provider: "Open-Meteo",
            enabled: true,
            latitude: lat,
            longitude: lon,
            cache_seconds: self.0.cache_seconds,
            ..CurrentWeather::default()
        }
    }
    fn build_alerts(&self, data: &CurrentWeather) -> Vec<WeatherAlert> {
        let mut alerts = Vec::new();
        if data
            .wind_speed_mps
            .is_some_and(|v| v >= self.0.wind_warning_mps)
        {
            alerts.push(alert(
                "WIND",
                "warning",
                "Wind",
                format!(
                    "Wind speed is at or above {:.0} m/s.",
                    self.0.wind_warning_mps
                ),
            ));
        }
        if data.is_thunder == Some(true) {
            alerts.push(alert(
                "THUNDERSTORM",
                "danger",
                "Thunderstorm",
                "Thunderstorm conditions reported by Open-Meteo.".into(),
            ));
        }
        if data.precipitation_mm.is_some_and(|v| v >= 2.0) {
            alerts.push(alert(
                "HEAVY_PRECIPITATION",
                "warning",
                "Precipitation",
                "Heavy precipitation reported by Open-Meteo.".into(),
            ));
        }
        if data.precipitation_type == Some(3) {
            alerts.push(alert(
                "SNOW",
                "info",
                "Snow",
                "Snow conditions reported by Open-Meteo.".into(),
            ));
        }
        if data.condition.as_deref() == Some("fog") {
            alerts.push(alert(
                "FOG",
                "warning",
                "Fog",
                "Fog reported by Open-Meteo.".into(),
            ));
        }
        alerts
    }
}

fn alert(code: &str, severity: &str, title: &str, message: String) -> WeatherAlert {
    WeatherAlert {
        code: code.into(),
        severity: severity.into(),
        title: title.into(),
        message,
    }
}
fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key)?.as_f64().filter(|v| v.is_finite())
}
fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn compass(degrees: f64) -> String {
    ["n", "ne", "e", "se", "s", "sw", "w", "nw"]
        [((degrees.rem_euclid(360.0) / 45.0).round() as usize) % 8]
        .into()
}
fn daily_time(body: &Value, key: &str) -> Option<String> {
    let offset = body
        .get("utc_offset_seconds")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    body.get("daily")?.get(key)?.get(0)?.as_u64().map(|ts| {
        let secs = (ts as i64 + offset).rem_euclid(86_400) as u32;
        format!("{:02}:{:02}", secs / 3600, (secs % 3600) / 60)
    })
}
fn probability(body: &Value, now: u64) -> Option<u8> {
    let times = body.get("hourly")?.get("time")?.as_array()?;
    let values = body
        .get("hourly")?
        .get("precipitation_probability")?
        .as_array()?;
    let idx = times
        .iter()
        .enumerate()
        .filter_map(|(i, v)| v.as_u64().map(|t| (i, t.abs_diff(now))))
        .min_by_key(|(_, d)| *d)?
        .0;
    values.get(idx)?.as_u64().map(|v| v.min(100) as u8)
}
fn condition(code: u16) -> &'static str {
    match code {
        0 => "clear",
        1 => "partly-cloudy",
        2 => "cloudy",
        3 => "overcast",
        45 | 48 => "fog",
        51 | 53 | 55 => "drizzle",
        56 | 57 => "wet-snow",
        61 => "light-rain",
        63 => "moderate-rain",
        65 | 80 | 81 | 82 => "heavy-rain",
        66 | 67 => "wet-snow",
        71 => "light-snow",
        73 | 75 | 77 | 85 | 86 => "snow",
        95 => "thunderstorm",
        96 | 99 => "thunderstorm-with-hail",
        _ => "cloudy",
    }
}
fn env_number(name: &str, fallback: f64) -> f64 {
    env::var(name)
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(fallback)
}
fn env_u64(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}
