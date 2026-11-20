# ZaHiD Tech

ZaHiD Tech is a mobile-first PWA for saving GPS coordinates and navigating
back to saved places. It embeds Leaflet with an OpenStreetMap basemap served by FOSSGIS.

- Tap **+ SAVE LOCATION** at the bottom of the map to save your location.
  Pins are numbered automatically and keep their numbers after deletion.
- Live Location starts on and requests a fresh fix whenever the app returns to
  the foreground. A red dot shows your position and the nearest pin updates
  as you move. Distances are straight-line estimates.
- Choose Another Pin opens the saved-locations sheet. Select a pin to
  switch to manual mode, or choose Use nearest automatically to return.
- Select Google Maps, Waze, or Apple Maps, then tap Navigate to open directions.

Pins are stored in this browser under the localStorage key
`zahid-tech-pins-v1`. Clearing website data removes saved pins.

## Run locally

Serve the project with `python3 -m http.server 8000` and open
`http://localhost:8000`. No build or dependency install is needed.
HTTPS or localhost is required for geolocation and service workers.

GitHub Pages can serve the project from its repository root at
`/ZaHiD-Tech/`. On iPhone, open the HTTPS page in Safari, tap Share, and
choose Add to Home Screen. Launch the app and grant location access.
The service worker caches the app shell and Leaflet. OpenStreetMap tiles
and external navigation services require connectivity.
