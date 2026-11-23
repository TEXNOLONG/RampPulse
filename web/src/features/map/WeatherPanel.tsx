import { useEffect, useRef } from 'react';
import { AlertTriangle, Clock3, Cloud, CloudDrizzle, CloudLightning, CloudSnow, Droplets, Eye, Gauge, LoaderCircle, RefreshCw, Sun, Thermometer, Wind, X } from 'lucide-react';

export interface WeatherAlert { code: string; severity: string; title: string; message: string }
export interface WeatherData {
  provider: string; enabled: boolean; latitude: number; longitude: number; fetched_at_ms: number | null; observed_at_ms: number | null; cache_seconds: number;
  temperature_c: number | null; feels_like_c: number | null; condition: string | null; icon: string | null;
  wind_speed_mps: number | null; wind_gust_mps: number | null; wind_direction: string | null; humidity_percent: number | null;
  pressure_mm: number | null; pressure_hpa: number | null; cloud_cover_percent: number | null; precipitation_mm: number | null;
  precipitation_type: number | null; precipitation_strength: number | null; precipitation_probability_percent: number | null;
  visibility_m: number | null; sunrise: string | null; sunset: string | null; uv_index: number | null; dew_point_c: number | null;
  timezone: string | null; is_thunder: boolean | null; phenomenon: string | null; alerts: WeatherAlert[]; error: string | null; error_code: string | null;
}

export type WeatherStatus = 'CONNECTING' | 'LIVE' | 'UPDATING' | 'STALE' | 'OFFLINE' | 'ERROR';
export type WeatherLocationMode = 'airport' | 'map' | 'my';

interface Props {
  id: string;
  closing?: boolean;
  weather: WeatherData | null;
  status: WeatherStatus;
  error: string | null;
  locationName: string;
  icao: string | null;
  latitude: number;
  longitude: number;
  locationMode: WeatherLocationMode;
  gpsAvailable: boolean;
  refreshing: boolean;
  onLocationMode(mode: WeatherLocationMode): void;
  onRefresh(): void;
  onClose(): void;
}

const statusCopy: Record<WeatherStatus, string> = {
  CONNECTING: 'Подключаемся', LIVE: 'Актуальные данные', UPDATING: 'Обновляем данные', STALE: 'Последний снимок · устарел', OFFLINE: 'Нет соединения', ERROR: 'Ошибка погоды',
};
const conditions: Record<string, string> = {
  clear: 'Ясно', 'partly-cloudy': 'Малооблачно', cloudy: 'Облачно', overcast: 'Пасмурно', drizzle: 'Морось', 'light-rain': 'Небольшой дождь', rain: 'Дождь', 'moderate-rain': 'Умеренный дождь', 'heavy-rain': 'Сильный дождь', 'continuous-heavy-rain': 'Продолжительный сильный дождь', showers: 'Ливень', 'wet-snow': 'Мокрый снег', 'light-snow': 'Небольшой снег', snow: 'Снег', 'snow-showers': 'Снегопад', hail: 'Град', thunderstorm: 'Гроза', 'thunderstorm-with-rain': 'Гроза с дождём', 'thunderstorm-with-hail': 'Гроза с градом',
};
const value = (item: number | null | undefined, suffix: string, digits = 0) => item == null ? 'N/A' : `${item.toFixed(digits)}${suffix}`;
const windDirection: Record<string, string> = { n: 'С', ne: 'СВ', e: 'В', se: 'ЮВ', s: 'Ю', sw: 'ЮЗ', w: 'З', nw: 'СЗ', c: 'штиль' };

function conditionIcon(icon: string | null, condition: string | null) {
  if (condition?.includes('thunderstorm')) return CloudLightning;
  if (condition?.includes('snow')) return CloudSnow;
  if (condition?.includes('rain') || condition === 'showers' || condition === 'drizzle') return CloudDrizzle;
  if (condition === 'clear') return Sun;
  if (icon?.startsWith('ovc') || icon?.startsWith('bkn')) return Cloud;
  return Cloud;
}

export function WeatherPanel({ id, closing = false, weather, status, error, locationName, icao, latitude, longitude, locationMode, gpsAvailable, refreshing, onLocationMode, onRefresh, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  const WeatherIcon = conditionIcon(weather?.icon ?? null, weather?.condition ?? null);
  const weatherError = error || weather?.error;
  const condition = weather?.condition ? conditions[weather.condition] ?? weather.condition.replaceAll('-', ' ') : 'Данные пока не получены';
  const windKmh = weather?.wind_speed_mps == null ? null : weather.wind_speed_mps * 3.6;
  const gustKmh = weather?.wind_gust_mps == null ? null : weather.wind_gust_mps * 3.6;
  const updated = weather?.fetched_at_ms ? new Date(weather.fetched_at_ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
  const metrics = [
    { label: 'ОЩУЩАЕТСЯ', icon: Thermometer, value: value(weather?.feels_like_c, '°C') },
    { label: 'ВЕТЕР', icon: Wind, value: windKmh == null ? 'N/A' : `${windKmh.toFixed(0)} km/h${weather?.wind_direction ? ` · ${windDirection[weather.wind_direction] ?? weather.wind_direction.toUpperCase()}` : ''}` },
    { label: 'ПОРЫВЫ', icon: Wind, value: value(gustKmh, ' km/h') },
    { label: 'ВЛАЖНОСТЬ', icon: Droplets, value: value(weather?.humidity_percent, '%') },
    { label: 'ДАВЛЕНИЕ', icon: Gauge, value: value(weather?.pressure_hpa, ' hPa') },
    { label: 'ОБЛАЧНОСТЬ', icon: Cloud, value: value(weather?.cloud_cover_percent, '%') },
    { label: 'ОСАДКИ · ЧАС', icon: CloudDrizzle, value: value(weather?.precipitation_mm, ' mm', 1) },
    { label: 'ВЕРОЯТНОСТЬ', icon: Droplets, value: value(weather?.precipitation_probability_percent, '%') },
    { label: 'ВИДИМОСТЬ', icon: Eye, value: weather?.visibility_m == null ? 'N/A' : `${(weather.visibility_m / 1000).toFixed(1)} km` },
    { label: 'УФ-ИНДЕКС', icon: Sun, value: value(weather?.uv_index, '') },
    { label: 'ТОЧКА РОСЫ', icon: Thermometer, value: value(weather?.dew_point_c, '°C') },
  ];

  return <aside id={id} className={`geo-weather-panel glass${closing ? ' closing' : ''}`} role="dialog" aria-modal="false" aria-label="Погодные условия аэропорта" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <header className="geo-weather-head">
      <div><span className="eyebrow">RAMP OPERATIONS · WEATHER</span><h2>Погода</h2></div>
      <div className="geo-weather-actions">
        <button className="geo-weather-action" onClick={onRefresh} disabled={refreshing} aria-label="Обновить погоду" title="Обновить погоду">{refreshing ? <LoaderCircle size={16} className="weather-spin" /> : <RefreshCw size={16} />}</button>
        <button ref={closeRef} className="geo-weather-action" onClick={onClose} aria-label="Закрыть погоду"><X size={17} /></button>
      </div>
    </header>
    <div className="geo-weather-scroll">
      <div className={`geo-weather-status ${status.toLowerCase()}`}><i />{statusCopy[status]}{updated && <time>· {updated}</time>}</div>
      {weatherError && <div className="geo-weather-error" role="status"><AlertTriangle size={15} /><span>{weatherError}</span></div>}
      <div className="geo-weather-location">
        <div><span className="eyebrow">{locationMode === 'my' ? 'MY LOCATION' : locationMode === 'map' ? 'MAP LOCATION' : 'AIRPORT LOCATION'}</span><b>{locationName}</b>{icao && <small>{icao}</small>}</div>
        <small>{latitude.toFixed(4)}, {longitude.toFixed(4)}{weather?.timezone ? ` · ${weather.timezone}` : ''}</small>
      </div>
      <div className="geo-weather-sources" aria-label="Источник погодных координат">
        <button className={locationMode === 'airport' ? 'on' : ''} onClick={() => onLocationMode('airport')}>Аэропорт</button>
        <button className={locationMode === 'map' ? 'on' : ''} onClick={() => onLocationMode('map')}>Центр карты</button>
        <button className={locationMode === 'my' ? 'on' : ''} disabled={!gpsAvailable} onClick={() => onLocationMode('my')}>Моё место</button>
      </div>
      <section className="geo-weather-current">
        <WeatherIcon size={34} strokeWidth={1.6} />
        <div><strong>{value(weather?.temperature_c, '°C')}</strong><span>{condition}</span></div>
      </section>
      <div className="geo-weather-metrics">
        {metrics.map(metric => <div className="geo-weather-metric" key={metric.label}><span><metric.icon size={13} />{metric.label}</span><b>{metric.value}</b></div>)}
        <div className="geo-weather-metric"><span><Sun size={13} />ВОСХОД</span><b>{weather?.sunrise ?? 'N/A'}</b></div>
        <div className="geo-weather-metric"><span><Sun size={13} />ЗАКАТ</span><b>{weather?.sunset ?? 'N/A'}</b></div>
      </div>
      {!!weather?.alerts?.length && <section className="geo-weather-alerts"><span className="eyebrow">SYSTEM WEATHER ALERTS · НЕ ОФИЦИАЛЬНЫЕ METAR/TAF</span>{weather.alerts.map(alert => <article className={`geo-weather-alert ${alert.severity}`} key={alert.code}><b>{alert.title}</b><span>{alert.message}</span></article>)}</section>}
      <footer className="geo-weather-footer"><Clock3 size={13} />{updated ? `Обновлено ${updated}` : 'Нет успешного обновления'}<span>Weather data by Open-Meteo · CC BY 4.0</span></footer>
    </div>
  </aside>;
}
