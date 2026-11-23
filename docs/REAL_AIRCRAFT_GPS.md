# RampPulse live aircraft and GPS

## Aircraft provider

RampPulse uses the public regional endpoint from [adsb.lol](https://www.adsb.lol/docs/open-data/api) through the Rust server. Its published anonymous allowance is 500 requests per day per IP; a free adhoc key can raise that to 1,000/day after its request and review. Responses are published under ODbL 1.0, so the map credits adsb.lol and links the source. The service is best-effort and does not provide an availability guarantee.

The server calls one airport-radius endpoint, caches the latest snapshot in memory, and enforces a minimum three-minute polling interval. The default SVO search radius is 50 nautical miles. The client never calls the aviation provider directly and never receives an API key. Provider registration/type/altitude fields are optional; missing fields stay missing. `seen_pos` drives per-aircraft freshness, and cache/provider errors surface as `STALE` or `OFFLINE` while the operation simulator keeps running.

OpenSky was reviewed but is not enabled: its current terms limit REST use to non-profit research/education and require written authorization for any operational API integration. ADS-B Exchange's current enterprise API is subscription-based; its community API is for personal/non-commercial use. AirLabs docs require an API key, and this implementation does not assume an undocumented free quota. This makes adsb.lol the selected live source for the current integration; it does not certify aviation data for operational safety.

## Server configuration

```dotenv
AIRCRAFT_ENABLED=true
AIRCRAFT_API_BASE=https://api.adsb.lol
AIRCRAFT_API_KEY=
AIRCRAFT_POLL_INTERVAL=180
AIRCRAFT_MAX_RADIUS=50
AIRCRAFT_CENTER_LAT=55.97278
AIRCRAFT_CENTER_LON=37.41472
```

`AIRCRAFT_API_KEY` is optional. The no-key limit is the reason for the 180-second minimum. `AIRCRAFT_MAX_RADIUS` is in nautical miles and is clamped to 250. The center defaults to Sheremetyevo and can be changed per server configuration. `AIRCRAFT_ENABLED=false` disables the feed without affecting simulation.

## Geographic map and airport transform

The `GEO` view is separate from the existing operations schematic. Its Sheremetyevo background uses the same detailed local airport graph as the dark operations map, from `data/airport_sheremetyevo.json`. The separate IT2026 view uses the supplied VDNH-area GeoJSON and keeps those coordinates. Neither view requests OSM, 2GIS, or other map tiles; Leaflet is used only for local interaction and positioning. The airport converter stores a local-metres-to-WGS84 transform; shared taxiway nodes were compared with a map conversion when the transform was added, leaving a 15.4 m RMS difference. This is a map-data alignment estimate, not a GPS accuracy claim.

The REAL layer contains provider ADS-B positions. The SIMULATION layer maps the existing simulated aircraft from the airport-local coordinate system into WGS84. The flight trails are only positions observed during the current app session; no historical API track is fabricated or persisted. Replay is not enabled because no provider history is currently wired in.

## GPS and privacy

GPS is opt-in and starts only when the user presses **Start GPS**. RampPulse uses `navigator.geolocation.watchPosition` with high accuracy, no cached fixes, and a 20-second acquisition timeout. The untouched browser coordinates and reported accuracy remain RAW; a separate weighted filtered coordinate is used to smooth the map marker. The accuracy circle is drawn from the actual reported accuracy. Accuracy is never inferred from decimal precision. Impossible jumps are flagged and are excluded only from the filtered marker, not erased from the RAW fix.

GPS runs in the client only. Coordinates are not posted to the RampPulse server, saved to local storage, logged, or used to choose the ADS-B query radius. Turning GPS off, leaving the GEO map, or closing the session stops the watch. Device/browser permission, Windows Location Services, secure-context rules, and hardware availability control whether a fix is available.

## Data fields

The provider currently supplies ICAO24, callsign, latitude/longitude, barometric/geometric altitude where present, speed, track/heading, barometric vertical rate, squawk, registration/type where present, and position age. Values are normalized to metres, metres per second, degrees, and Unix-millisecond timestamps. ADS-B does not supply verified technical incidents, airport schedules, or guaranteed complete registration/type data; none are inferred.
