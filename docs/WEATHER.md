# RampPulse Weather

Weather is fetched server-side from the Open-Meteo Forecast API. No API key or user setup is required. The authenticated endpoint remains `GET /api/weather/current`; optional `lat` and `lon` select a location, and `refresh=true` requests a refresh subject to the cooldown.

## Configuration

The `.env.example` values set the default airport location and request cache. The Rust server loads `.env` with `dotenvy`; a deployment can set the same variables in its service environment.

- `WEATHER_LAT` and `WEATHER_LON`: default airport point (Sheremetyevo).
- `WEATHER_CACHE_SECONDS`: successful response cache; default 600 seconds.
- `WEATHER_REFRESH_COOLDOWN_SECONDS`: minimum time between upstream requests; default 60 seconds.
- `WEATHER_WIND_WARNING_MPS`: system wind alert threshold; default 15 m/s.

## Data and behavior

The weather panel overlays the existing map and supports the airport, map center, or GPS location. Open-Meteo current and hourly data are normalized into RampPulse's weather format. The panel shows temperature, feels-like temperature, WMO condition, wind/gust/direction, humidity, pressure, cloud cover, precipitation and probability, visibility, UV, dew point, sunrise/sunset, timezone, and fetch time when those fields are available. Weather icons are rendered locally. The panel attributes Open-Meteo and links to its CC BY 4.0 license.

Responses are cached for 10 minutes by rounded coordinate, bounded to 32 locations, and upstream calls are limited by the cooldown. A failed refresh returns the previous successful snapshot with an error so the interface can label it stale. System alerts are derived from provider data and are not METAR, TAF or NOTAM.

## VPS rollout

The VPS must run the updated Rust server for the new provider response and engineer GPS endpoints to be available to desktop and Android clients. No weather secret needs to be provisioned.

Open-Meteo's free API is for non-commercial use, with request limits and no uptime guarantee. RampPulse deployments used commercially must use a suitable Open-Meteo commercial plan/license.
