const DB_KEY = "zahid-tech-pins-v1";
const GPS_OPTIONS = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 };
const $ = id => document.getElementById(id);
const coordinates = point => [point.lat, point.lng];
const fromPosition = ({ coords }) => ({ lat: coords.latitude, lng: coords.longitude });

let saved = { pins: [], nextNumber: 1 };
let map, gpsDot, accuracyRing, here, watchId, activeNumber, noticeTimer;
let live = true;
let centeredOnFirstFix = false;
let watchGeneration = 0;
let manualNumber = null;
let announcedNearest;
let provider = "google";
const markers = new Map();

function message(text) {
  $("message").textContent = text;
}

function readSaved() {
  const value = JSON.parse(localStorage.getItem(DB_KEY) ?? "null");
  if (value === null) return { pins: [], nextNumber: 1 };
  if (!Array.isArray(value.pins)) throw new Error("Invalid pin data.");

  const pins = value.pins
    .map(record => ({ lat: record?.lat, lng: record?.lng, number: record?.number }))
    .filter(({ lat, lng, number }) => Number.isFinite(lat) && Math.abs(lat) <= 90 &&
      Number.isFinite(lng) && Math.abs(lng) <= 180 && Number.isSafeInteger(number) && number > 0);
  const minimumNext = pins.reduce((next, pin) => Math.max(next, pin.number + 1), 1);
  return { pins, nextNumber: Math.max(minimumNext, Number.isSafeInteger(value.nextNumber) ? value.nextNumber : 1) };
}

function refreshSaved() {
  try {
    saved = readSaved();
    if (!saved.pins.some(pin => pin.number === manualNumber)) manualNumber = null;
    syncMarkers();
    render();
    if ($("savedDialog").open) renderList();
  } catch {
    message("Saved pins could not be read from this device.");
  }
}

function writeSaved(next) {
  localStorage.setItem(DB_KEY, JSON.stringify(next));
  saved = next;
  if (!saved.pins.some(pin => pin.number === manualNumber)) manualNumber = null;
  syncMarkers();
  render();
  if ($("savedDialog").open) renderList();
}

function distance(a, b) {
  const rad = degrees => degrees * Math.PI / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function nearestPin(pins, point) {
  let nearest = null;
  let meters = Infinity;
  for (const pin of pins) {
    const candidate = distance(point, pin);
    if (candidate < meters) {
      nearest = pin;
      meters = candidate;
    }
  }
  return nearest;
}

function navigationUrl(pin, app) {
  const point = encodeURIComponent(coordinates(pin).join(","));
  switch (app) {
    case "waze": return `https://www.waze.com/ul?ll=${point}&navigate=yes`;
    case "apple": return `https://maps.apple.com/?daddr=${point}&dirflg=d`;
    default: return `https://www.google.com/maps/dir/?api=1&destination=${point}&travelmode=driving&dir_action=navigate`;
  }
}

function notifyNearest(pin) {
  clearTimeout(noticeTimer);
  $("notice").classList.toggle("visible", Boolean(pin));
  $("notice").textContent = pin ? `Pin ${pin.number} is now\nyour nearest location` : "";
  if (pin) noticeTimer = setTimeout(() => {
    $("notice").classList.remove("visible");
    $("notice").textContent = "";
  }, 6500);
}

function render() {
  const manual = saved.pins.find(pin => pin.number === manualNumber);
  const nearest = !manual && here ? nearestPin(saved.pins, here) : null;
  const destination = manual || nearest;
  const number = destination?.number;

  if (number !== activeNumber) {
    markers.get(activeNumber)?.getElement()?.classList.remove("is-active");
    markers.get(activeNumber)?.setZIndexOffset(0);
    markers.get(number)?.getElement()?.classList.add("is-active");
    markers.get(number)?.setZIndexOffset(500);
    activeNumber = number;
  }
  if (nearest?.number !== announcedNearest) {
    announcedNearest = nearest?.number;
    notifyNearest(nearest);
  }

  $("cardTitle").textContent = manual ? "Selected Saved Location" : "Nearest Saved Location";
  $("liveBadge").hidden = !saved.pins.length && !here;
  $("liveBadge").textContent = here ? "LIVE" : live ? "WAITING" : "PAUSED";
  $("liveBadge").classList.toggle("is-paused", !here);
  $("pinName").classList.toggle("is-empty", !destination);
  $("pinName").textContent = destination ? `Pin ${number}` : saved.pins.length ? "Pins saved" : "No pins yet";
  const meters = destination && here ? distance(here, destination) : null;
  $("distance").textContent = meters !== null ? `${(meters / 1609.344).toFixed(1)} miles away`
    : !saved.pins.length ? "Save your location" : destination ? "Distance unavailable" : live ? "Waiting for GPS" : "Location paused";
  $("metric").textContent = meters !== null ? `≈ ${(meters / 1000).toFixed(1)} km`
    : !saved.pins.length ? "Tap the save button" : live ? "Live Location is on" : "Turn on Live Location";
  $("navigateLabel").textContent = destination ? `Navigate to Pin ${number}` : "Navigate to Nearest Pin";
  $("navigate").setAttribute("aria-disabled", String(!destination));
  if (destination) $("navigate").href = navigationUrl(destination, provider);
  else $("navigate").removeAttribute("href");
}

function fitPins() {
  if (!map || !saved.pins.length) return;
  map.fitBounds(saved.pins.map(coordinates), { paddingTopLeft: [32, 145], paddingBottomRight: [65, 40], maxZoom: 16 });
}

function initMap() {
  if (!window.L) {
    $("mapStatus").hidden = false;
    $("mapStatus").textContent = "Map unavailable. Reload when online.";
    for (const id of ["zoomIn", "zoomOut", "recenter"]) $(id).disabled = true;
    return;
  }
  map = L.map("map", { zoomControl: false }).setView([51.535, -0.29], 12);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com/">Leaflet</a>');
  L.tileLayer("https://tile.openstreetmap.de/{z}/{x}/{y}.png", {
    maxNativeZoom: 18,
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · <a href="https://tile.openstreetmap.de/">FOSSGIS</a>'
  }).on("tileerror", () => {
    $("mapStatus").hidden = false;
    $("mapStatus").textContent = "Map tiles unavailable.";
  }).on("tileload", () => { $("mapStatus").hidden = true; }).addTo(map);
}

function syncMarkers() {
  if (!map) return;
  const remaining = new Set(saved.pins.map(pin => pin.number));
  for (const [number, marker] of markers) {
    if (remaining.has(number)) continue;
    marker.remove();
    markers.delete(number);
  }
  for (const pin of saved.pins) {
    const label = `Pin ${pin.number}`;
    const existing = markers.get(pin.number);
    if (existing) {
      existing.setLatLng(coordinates(pin));
      continue;
    }
    const icon = L.divIcon({
      className: pin.number === activeNumber ? "pin-icon is-active" : "pin-icon",
      html: `<div class="map-pin"><span>${pin.number}</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 36]
    });
    const marker = L.marker(coordinates(pin), { icon, title: label, alt: label, zIndexOffset: pin.number === activeNumber ? 500 : 0 })
      .addTo(map).on("click", () => selectPin(pin.number));
    markers.set(pin.number, marker);
  }
}

function selectPin(number) {
  manualNumber = number;
  render();
  const pin = saved.pins.find(item => item.number === number);
  if (map && pin) map.setView(coordinates(pin), Math.max(map.getZoom(), 14));
}

function updateGPS(position) {
  here = fromPosition(position);
  $("liveDetail").textContent = "Red dot follows you";
  if ($("message").textContent === "Finding your location…") message("");
  $("liveLabel").textContent = "Live Location: ON";
  if (map) {
    const point = coordinates(here);
    const accuracy = Math.max(0, position.coords.accuracy || 0);
    if (!gpsDot) {
      accuracyRing = L.circle(point, { radius: accuracy, color: "#e32b37", weight: 1, opacity: .35, fillOpacity: .17, interactive: false }).addTo(map);
      gpsDot = L.circleMarker(point, { radius: 9, color: "white", weight: 3, fillColor: "#ed141f", fillOpacity: 1, interactive: false }).addTo(map);
    } else {
      accuracyRing.setLatLng(point).setRadius(accuracy);
      gpsDot.setLatLng(point);
    }
    if (!centeredOnFirstFix) {
      map.setView(point, 16);
      centeredOnFirstFix = true;
    }
  }
  render();
}

function clearGPS() {
  here = null;
  gpsDot?.remove();
  accuracyRing?.remove();
  gpsDot = accuracyRing = null;
}

function gpsError(error) {
  if (error?.code === 1) return "Location access denied";
  if (error?.code === 2) return "Location unavailable";
  if (error?.code === 3) return "GPS timed out";
  return "GPS unavailable";
}

function setLive(enabled) {
  const generation = ++watchGeneration;
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  watchId = undefined;
  live = enabled;
  clearGPS();
  $("liveToggle").setAttribute("aria-checked", String(live));
  $("liveLabel").textContent = `Live Location: ${live ? "ON" : "OFF"}`;
  $("liveDetail").textContent = live ? "Acquiring GPS…" : "GPS tracking paused";
  render();
  if (!live) return;
  const failed = error => {
    if (generation !== watchGeneration) return;
    clearGPS();
    if (error?.code === 1 || !navigator.geolocation) {
      setLive(false);
    }
    $("liveDetail").textContent = gpsError(error);
    if ($("message").textContent === "Finding your location…") message(gpsError(error));
    render();
  };
  try {
    watchId = navigator.geolocation.watchPosition(position => {
      if (generation === watchGeneration) updateGPS(position);
    }, failed, GPS_OPTIONS);
  } catch (error) {
    failed(error);
  }
}

function currentPosition() {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, GPS_OPTIONS));
}

$("saveBtn").addEventListener("click", async () => {
  $("saveBtn").disabled = true;
  message("Getting your GPS location…");
  try {
    let position;
    try {
      position = await currentPosition();
    } catch (error) {
      message(`${gpsError(error)}. Check location permissions or try again.`);
      return;
    }
    try {
      const { pins, nextNumber } = readSaved();
      const pin = { ...fromPosition(position), number: nextNumber };
      writeSaved({ pins: [...pins, pin], nextNumber: nextNumber + 1 });
      if (live) updateGPS(position);
      if (map) map.setView(coordinates(pin), 16);
      message(`Saved as Pin ${pin.number}.`);
    } catch {
      message("Could not save the pin. Check device storage and try again.");
    }
  } finally {
    $("saveBtn").disabled = false;
  }
});

function renderList() {
  $("pinList").replaceChildren();
  $("empty").hidden = saved.pins.length > 0;
  $("fit").disabled = !map || !saved.pins.length;
  $("auto").disabled = manualNumber === null;
  for (const pin of saved.pins) {
    const label = `Pin ${pin.number}`;
    const row = document.createElement("li");
    row.className = "pin-row";
    const choose = document.createElement("button");
    choose.className = "pin-choice";
    choose.setAttribute("aria-pressed", String(pin.number === activeNumber));
    const details = document.createElement("small");
    details.textContent = coordinates(pin).map(value => value.toFixed(6)).join(", ");
    choose.append(label, details);
    choose.onclick = () => {
      $("savedDialog").close();
      selectPin(pin.number);
    };
    const remove = document.createElement("button");
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete ${label}`);
    remove.onclick = () => {
      if (!confirm(`Delete ${label}?`)) return;
      try {
        const latest = readSaved();
        writeSaved({ ...latest, pins: latest.pins.filter(item => item.number !== pin.number) });
        $("savedDialog").querySelector("[data-close]").focus();
        message(`${label} deleted.`);
      } catch {
        message("Could not delete the pin. Check device storage and try again.");
        $("savedDialog").close();
      }
    };
    row.append(choose, remove);
    $("pinList").append(row);
  }
}

function openSaved() {
  renderList();
  $("savedDialog").showModal();
}

$("liveToggle").onclick = () => setLive(!live);
$("zoomIn").onclick = () => map?.zoomIn(1, { animate: false });
$("zoomOut").onclick = () => map?.zoomOut(1, { animate: false });
$("recenter").onclick = () => {
  if (here) map?.setView(coordinates(here), Math.max(map.getZoom(), 15));
  else {
    setLive(true);
    message("Finding your location…");
  }
};
$("choose").onclick = openSaved;
$("settings").onclick = () => $("settingsDialog").showModal();
$("manage").onclick = () => {
  $("settingsDialog").close();
  openSaved();
};
$("auto").onclick = () => {
  manualNumber = null;
  render();
  $("savedDialog").close();
};
$("fit").onclick = () => {
  $("savedDialog").close();
  fitPins();
};
document.querySelectorAll("[data-close]").forEach(button => {
  button.onclick = () => $(button.dataset.close).close();
});
const appChoices = [...$("providers").querySelectorAll("button")];
for (const button of appChoices) {
  button.onclick = () => {
    provider = button.dataset.provider;
    for (const choice of appChoices) choice.setAttribute("aria-pressed", String(choice === button));
    render();
  };
}
window.addEventListener("storage", event => {
  if (event.key === DB_KEY || event.key === null) refreshSaved();
});

initMap();
refreshSaved();
fitPins();
setLive(true);

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./sw.js").catch(error => console.warn("Offline setup failed", error));
}
