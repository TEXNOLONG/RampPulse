# Offline airport map

The Sheremetyevo geographic view is drawn locally from `data/airport_sheremetyevo.json`. The separate IT2026 view uses the supplied VDNH-area GeoJSON files in `web/src/features/map/data/it2026/` and shares the dark visual style of the operations map. Leaflet is only the local pan/zoom renderer; neither view requests raster tiles, requires a map API key, or depends on a map service.

The bundled geodata covers the selected airport or IT2026 area, not the whole country. Live aircraft, weather, and engineer locations still use their configured data services; both map backgrounds are offline.
