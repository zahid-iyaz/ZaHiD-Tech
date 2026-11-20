const DB_KEY = "zahid-tech-pins-v1";
const BACKUP_VERSION = 1;
const GPS_OPTIONS = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 };
const SAVE_MAX_AGE = 3000;
const SAVE_MAX_ACCURACY = 30;
const $ = id => document.getElementById(id);
const coordinates = point => [point.lat, point.lng];
const fromPosition = ({ coords }) => ({ lat: coords.latitude, lng: coords.longitude });

let saved = { pins: [], nextNumber: 1 };
let latestLiveFix;
let map, gpsDot, accuracyRing, here, watchId, activeNumber, noticeTimer;
let live = true;
let recenterOnFix = true;
let pageHidden = false;
let foregroundVisit = 0;
let watchGeneration = 0;
let manualNumber = null;
let announcedNearest;
let provider = "google";
const markers = new Map();

function message(text) {
  $("message").textContent = text;
}

function isValidPin({ lat, lng, number }) {
  return Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    Number.isFinite(lng) && Math.abs(lng) <= 180 && Number.isSafeInteger(number) && number > 0;
}

function readSaved() {
  const value = JSON.parse(localStorage.getItem(DB_KEY) ?? "null");
  if (value === null) return { pins: [], nextNumber: 1 };
  if (!Array.isArray(value.pins)) throw new Error("Invalid pin data.");

  const pins = value.pins
    .map(record => {
      const pin = { lat: record?.lat, lng: record?.lng, number: record?.number };
      if (typeof record?.name === "string" && record.name.trim()) pin.name = record.name.trim();
      return pin;
    })
    .filter(isValidPin);
  if (value.numberingReset === true) {
    const nextNumber = Number.isSafeInteger(value.nextNumber) && value.nextNumber > 0 ? value.nextNumber : 1;
    return { pins, nextNumber, numberingReset: true };
  }
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

function writeSaved(next, resetSelection = false) {
  localStorage.setItem(DB_KEY, JSON.stringify(next));
  saved = next;
  if (resetSelection || !saved.pins.some(pin => pin.number === manualNumber)) manualNumber = null;
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

function navigationUrl(point, app) {
  const encoded = encodeURIComponent(point);
  switch (app) {
    case "waze":
      return `https://www.waze.com/ul?ll=${encoded}&navigate=yes`;
    case "apple":
      return `https://maps.apple.com/?daddr=${encoded}&dirflg=d`;
    default:
      return `https://www.google.com/maps/dir/?api=1&destination=${encoded}&travelmode=driving`;
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
  const paused = !live || !isForeground();
  $("liveBadge").textContent = here ? "LIVE" : paused ? "PAUSED" : "WAITING";
  $("liveBadge").classList.toggle("is-paused", !here);
  $("pinName").classList.toggle("is-empty", !destination);
  $("pinName").textContent = destination ? `Pin ${number}` : saved.pins.length ? "Pins saved" : "No pins yet";
  const meters = destination && here ? distance(here, destination) : null;
  $("distance").textContent = meters !== null ? `${(meters / 1609.344).toFixed(1)} miles away`
    : !saved.pins.length ? "Save your location" : paused ? "Location paused" : "Locating…";
  $("metric").textContent = meters !== null ? `≈ ${(meters / 1000).toFixed(1)} km`
    : !saved.pins.length ? "Tap the save button" : paused ? "Turn on Live Location" : "Waiting for fresh GPS";
  $("navigateLabel").textContent = destination ? `Navigate to Pin ${number}` : "Navigate to Nearest Pin";
  $("navigate").setAttribute("aria-disabled", String(!destination));
  const navigate = $("navigate");
  const copy = $("copyDestination");
  copy.hidden = !destination;
  if (destination) {
    const point = coordinates(destination).join(",");
    navigate.href = navigationUrl(point, provider);
    copy.dataset.coordinates = point;
  } else {
    navigate.removeAttribute("href");
    delete copy.dataset.coordinates;
  }
}

function fitPins() {
  if (!map || !saved.pins.length) return;
  map.fitBounds(saved.pins.map(coordinates), { paddingTopLeft: [32, 145], paddingBottomRight: [65, 83], maxZoom: 16 });
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
  latestLiveFix = position;
  here = fromPosition(position);
  $("liveDetail").textContent = "Red dot follows you";
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
    if (recenterOnFix) map.setView(point, 16, { animate: false });
  }
  recenterOnFix = false;
  render();
}

function clearGPS() {
  latestLiveFix = undefined;
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

function isForeground() {
  return !pageHidden && document.visibilityState === "visible";
}

function stopTracking() {
  watchGeneration++;
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  watchId = undefined;
  clearGPS();
}

function startTracking() {
  if (!live || !isForeground() || watchId !== undefined) return;
  const generation = ++watchGeneration;
  let lastTimestamp = Date.now();
  $("liveDetail").textContent = "Locating…";
  render();

  const failed = error => {
    if (generation !== watchGeneration || !isForeground()) return;
    clearGPS();
    if (error?.code === 1 || !navigator.geolocation) setLive(false);
    $("liveDetail").textContent = gpsError(error);
    render();
  };

  try {
    watchId = navigator.geolocation.watchPosition(position => {
      if (generation !== watchGeneration || !isForeground() ||
          !Number.isFinite(position.timestamp) || position.timestamp < lastTimestamp) return;
      lastTimestamp = position.timestamp;
      updateGPS(position);
    }, failed, GPS_OPTIONS);
  } catch (error) {
    failed(error);
  }
}

function setLive(enabled) {
  live = enabled;
  $("liveToggle").setAttribute("aria-checked", String(live));
  $("liveLabel").textContent = `Live Location: ${live ? "ON" : "OFF"}`;
  if (live) startTracking();
  else {
    stopTracking();
    $("liveDetail").textContent = "GPS tracking paused";
  }
  render();
}

function suspendTracking() {
  foregroundVisit++;
  recenterOnFix = true;
  stopTracking();
  if (live) $("liveDetail").textContent = "GPS tracking paused";
  if ($("saveBtn").disabled) message("");
  render();
}

document.addEventListener("visibilitychange", () => {
  if (isForeground()) startTracking();
  else suspendTracking();
});
window.addEventListener("pagehide", () => {
  pageHidden = true;
  suspendTracking();
});
window.addEventListener("pageshow", event => {
  pageHidden = false;
  if (event.persisted) {
    manualNumber = null;
    refreshSaved();
  }
  startTracking();
});

function canSavePosition(position) {
  if (!Number.isFinite(position?.timestamp)) return false;
  const age = Date.now() - position.timestamp;
  const { accuracy } = position.coords;
  return age >= 0 && age <= SAVE_MAX_AGE &&
    Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= SAVE_MAX_ACCURACY;
}

function currentPosition() {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, GPS_OPTIONS));
}

$("saveBtn").addEventListener("click", async () => {
  const visit = foregroundVisit;
  const button = $("saveBtn");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";
  message("Saving your location…");
  try {
    let position = latestLiveFix;
    const reuseLiveFix = canSavePosition(position);
    try {
      if (!reuseLiveFix) {
        message("Getting your GPS location…");
        position = await currentPosition();
      }
    } catch (error) {
      if (visit === foregroundVisit && isForeground()) {
        message(`${gpsError(error)}. Check location permissions or try again.`);
      }
      return;
    }
    if (visit !== foregroundVisit || !isForeground()) return;
    if (!reuseLiveFix && !canSavePosition(position)) {
      message("GPS fix was too old or inaccurate. Wait for a stronger signal and try again.");
      return;
    }
    try {
      const latest = readSaved();
      const usedNumbers = new Set(latest.pins.map(pin => pin.number));
      let number = latest.nextNumber;
      while (usedNumbers.has(number)) number++;
      if (!Number.isSafeInteger(number)) throw new Error("No pin numbers available");

      const pin = { ...fromPosition(position), number };
      writeSaved({ ...latest, pins: [...latest.pins, pin], nextNumber: number + 1 });
      if (map) map.setView(coordinates(pin), 16);
      message(`Saved as Pin ${pin.number}.`);
    } catch {
      message("Could not save the pin. Check device storage and try again.");
    }
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
});

function editPinName(pin) {
  const dialog = $("editNameDialog");
  const input = $("pinNameInput");
  const error = $("editNameError");
  const label = `Pin ${pin.number}`;
  $("editNameTitle").textContent = `Edit name for ${label}`;
  input.value = pin.name ?? "";
  input.placeholder = label;
  error.textContent = "";

  $("editNameForm").onsubmit = event => {
    event.preventDefault();
    try {
      const latest = readSaved();
      const current = latest.pins.find(item => item.number === pin.number);
      if (!current) {
        error.textContent = `${label} was deleted.`;
        return;
      }

      const name = input.value.trim();
      if (name) current.name = name;
      else delete current.name;

      writeSaved(latest);
      dialog.close();
      $("savedDialog").querySelector(`[data-edit-pin="${pin.number}"]`)?.focus();
    } catch {
      error.textContent = "Could not save the name. Check device storage and try again.";
    }
  };
  dialog.showModal();
}

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
    const name = document.createElement("span");
    name.className = "pin-label";
    name.textContent = pin.name ?? label;
    choose.append(name);
    if (pin.name) {
      const number = document.createElement("small");
      number.textContent = label;
      choose.append(number);
    }
    choose.append(details);
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
    const edit = document.createElement("button");
    edit.textContent = "Edit Name";
    edit.dataset.editPin = pin.number;
    edit.setAttribute("aria-label", `Edit Name for ${label}`);
    edit.onclick = () => editPinName(pin);
    row.append(choose, edit, remove);
    $("pinList").append(row);
  }
}

$("resetNumbering").onclick = () => {
  if (!confirm("Reset pin numbering from Pin 1? Existing pins will not be deleted or renumbered. New pins will skip numbers already in use.")) return;

  const status = $("resetNumberingStatus");
  try {
    writeSaved({ ...readSaved(), nextNumber: 1, numberingReset: true });
    status.textContent = "Pin numbering reset. New pins will skip numbers in use.";
  } catch {
    status.textContent = "Could not reset numbering. Check device storage and try again.";
  }
};

function parseBackup(text) {
  const backup = JSON.parse(text);
  if (backup?.format !== "zahid-tech-saved-locations" || backup.version !== BACKUP_VERSION) {
    throw new Error("Unsupported backup format.");
  }
  const { pins, nextNumber, numberingReset } = backup;
  if (!Array.isArray(pins) || !Number.isSafeInteger(nextNumber) || nextNumber < 1 ||
      (numberingReset !== undefined && numberingReset !== true)) {
    throw new Error("Invalid backup settings.");
  }

  const numbers = new Set();
  const restored = pins.map(pin => {
    if (!pin || !isValidPin(pin) || numbers.has(pin.number) ||
        (!numberingReset && pin.number >= nextNumber) ||
        (pin.name !== undefined && (typeof pin.name !== "string" || !pin.name.trim()))) {
      throw new Error("Invalid backup pin.");
    }

    const { lat, lng, number, name } = pin;
    numbers.add(number);
    return name === undefined ? { lat, lng, number } : { lat, lng, number, name };
  });
  return numberingReset ? { pins: restored, nextNumber, numberingReset } : { pins: restored, nextNumber };
}

$("backupLocations").onclick = async () => {
  const status = $("backupRestoreStatus");
  try {
    const backup = { format: "zahid-tech-saved-locations", version: BACKUP_VERSION, ...readSaved() };
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `ZaHiD-Tech-backup-${timestamp}-${crypto.randomUUID()}.json`;
    const file = new File([JSON.stringify(backup, null, 2)], filename, { type: "application/json" });

    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        status.textContent = "Backup shared.";
        return;
      } catch (error) {
        if (error.name === "AbortError") {
          status.textContent = "Backup cancelled.";
          return;
        }
      }
    }

    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    try {
      link.click();
      status.textContent = "Backup download started.";
    } finally {
      link.remove();
      // Give Safari time to read the file before releasing its URL.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch {
    status.textContent = "Could not create a backup.";
  }
};

$("restoreLocations").onclick = () => $("restoreFile").click();
$("restoreFile").onchange = async event => {
  const input = event.currentTarget;
  const file = input.files[0];
  input.value = "";
  if (!file) return;

  const button = $("restoreLocations");
  const status = $("backupRestoreStatus");
  button.disabled = true;
  status.textContent = "Checking backup…";
  try {
    let restored;
    try {
      restored = parseBackup(await file.text());
    } catch {
      status.textContent = "Could not read this ZaHiD Tech backup. Choose a valid backup JSON file.";
      return;
    }

    const count = restored.pins.length;
    if (!confirm(`Restore ${count} saved ${count === 1 ? "location" : "locations"}? This will replace all currently saved pins and numbering settings.`)) {
      status.textContent = "Restore cancelled.";
      return;
    }

    writeSaved(restored, true);
    status.textContent = `Restored ${count} saved ${count === 1 ? "location" : "locations"}.`;
  } catch {
    status.textContent = "Could not restore the backup. Check device storage and try again.";
  } finally {
    button.disabled = false;
  }
};

function openSaved() {
  $("resetNumberingStatus").textContent = "";
  $("backupRestoreStatus").textContent = "";
  renderList();
  $("savedDialog").showModal();
}

$("liveToggle").onclick = () => setLive(!live);
$("zoomIn").onclick = () => map?.zoomIn(1, { animate: false });
$("zoomOut").onclick = () => map?.zoomOut(1, { animate: false });
$("recenter").onclick = () => {
  if (here) map?.setView(coordinates(here), Math.max(map.getZoom(), 15));
  else {
    recenterOnFix = true;
    setLive(true);
  }
};
$("copyDestination").onclick = async event => {
  const point = event.currentTarget.dataset.coordinates;
  if (!point) return;

  try {
    await navigator.clipboard.writeText(point);
    message(`Copied destination: ${point}`);
  } catch {
    message(`Select and copy these coordinates: ${point}`);
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
