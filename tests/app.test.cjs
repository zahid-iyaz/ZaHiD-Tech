const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { File } = require("node:buffer");
const { randomUUID } = require("node:crypto");

const app = readFileSync(require("node:path").join(__dirname, "../app.js"), "utf8");
const pins = [
  { number: 7, lat: 51.5074123456789, lng: -0.1278123456789 },
  { number: 9, lat: -33.8651432789123, lng: 151.209900123456 }
];
const near = "51.5074123456789,-0.1278123456789";
const far = "-33.8651432789123,151.209900123456";

function element() {
  return {
    dataset: {},
    children: [],
    classList: { toggle() {} },
    setAttribute() {},
    removeAttribute(attribute) { delete this[attribute]; },
    addEventListener(type, handler) { this[type] = handler; },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    showModal() { this.open = true; },
    close() { this.open = false; }
  };
}

function openApp(clipboard, { storage = { data: { pins, nextNumber: 10 } }, confirmReset = () => true, share } = {}) {
  const elements = new Map();
  function get(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }
  const providers = ["google", "waze", "apple"].map(provider => ({
    ...element(),
    dataset: { provider }
  }));
  get("providers").querySelectorAll = () => providers;
  let onPosition;
  vm.runInNewContext(app, {
    document: {
      getElementById: get,
      createElement: element,
      visibilityState: "visible",
      addEventListener() {},
      querySelectorAll: () => []
    },
    window: { addEventListener() {} },
    navigator: {
      userAgent: "iPhone",
      clipboard,
      share,
      canShare: () => Boolean(share),
      geolocation: { watchPosition(onFix) { onPosition = onFix; return 1; } }
    },
    localStorage: {
      getItem(key) {
        assert.equal(key, "zahid-tech-pins-v1");
        return JSON.stringify(storage.data);
      },
      setItem(key, value) {
        assert.equal(key, "zahid-tech-pins-v1");
        storage.data = JSON.parse(value);
      }
    },
    confirm: confirmReset,
    File,
    crypto: { randomUUID },
    clearTimeout() {},
    setTimeout() {}
  });

  return {
    get,
    moveTo(pin) {
      onPosition({ coords: { latitude: pin.lat, longitude: pin.lng, accuracy: 10 }, timestamp: Date.now() });
    },
    chooseProvider(provider) {
      providers.find(button => button.dataset.provider === provider).onclick();
    }
  };
}

function assertProviderLinks(app, point) {
  const escaped = encodeURIComponent(point);
  const urls = {
    google: `https://www.google.com/maps/dir/?api=1&destination=${escaped}&travelmode=driving`,
    waze: `https://www.waze.com/ul?ll=${escaped}&navigate=yes`,
    apple: `https://maps.apple.com/?daddr=${escaped}&dirflg=d`
  };
  for (const [provider, url] of Object.entries(urls)) {
    app.chooseProvider(provider);
    assert.equal(app.get("navigate").href, url, provider);
  }
}

test("all three anchor URLs use the current automatic nearest pin", () => {
  const app = openApp();
  assert.equal(app.get("navigate").href, undefined);
  assert.equal(app.get("copyDestination").hidden, true);
  app.moveTo(pins[0]);
  assertProviderLinks(app, near);
  app.moveTo(pins[1]);
  assertProviderLinks(app, far);
});

test("manual selection is the destination even when GPS moves", async () => {
  let copied;
  const app = openApp({ async writeText(text) { copied = text; } });
  app.moveTo(pins[1]);
  app.get("choose").onclick();
  app.get("pinList").children[0].children[0].onclick();
  app.moveTo(pins[1]);
  assertProviderLinks(app, near);

  const copy = app.get("copyDestination");
  assert.equal(copy.hidden, false);
  await copy.onclick({ currentTarget: copy });
  assert.equal(copied, near);
});

test("when clipboard access fails, exact destination coordinates are shown for manual copying", async () => {
  const app = openApp({ async writeText() { throw new Error("Clipboard denied"); } });
  app.moveTo(pins[1]);
  const copy = app.get("copyDestination");
  await copy.onclick({ currentTarget: copy });
  assert.equal(app.get("message").textContent, `Select and copy these coordinates: ${far}`);
});

const numberedPins = [
  { number: 1, lat: 51.5, lng: -0.1, name: "Street" },
  { number: 3, lat: 51.6, lng: -0.2 }
];

test("cancelling reset keeps the existing high-water numbering", async () => {
  const storage = { data: { pins: numberedPins, nextNumber: 8 } };
  const app = openApp(undefined, {
    storage,
    confirmReset(text) {
      assert.match(text, /Existing pins will not be deleted or renumbered/);
      return false;
    }
  });

  app.get("resetNumbering").onclick();
  assert.deepEqual(storage.data, { pins: numberedPins, nextNumber: 8 });
  app.moveTo(pins[0]);
  await app.get("saveBtn").click();
  assert.deepEqual(storage.data.pins.map(pin => pin.number), [1, 3, 8]);
});

test("confirmed reset preserves pins and saves at the next free number across reloads", async () => {
  const storage = { data: { pins: numberedPins, nextNumber: 8 } };
  const app = openApp(undefined, { storage });
  app.get("resetNumbering").onclick();
  assert.deepEqual(storage.data, { pins: numberedPins, nextNumber: 1, numberingReset: true });

  for (const number of [2, 4]) {
    const reopened = openApp(undefined, { storage });
    reopened.moveTo(pins[0]);
    await reopened.get("saveBtn").click();
    assert.deepEqual(storage.data.pins.at(-1), { number, lat: pins[0].lat, lng: pins[0].lng });
    assert.equal(storage.data.nextNumber, number + 1);
  }

  assert.deepEqual(storage.data.pins.slice(0, 2), numberedPins);
  assert.deepEqual(storage.data.pins.map(pin => pin.number), [1, 3, 2, 4]);
});

test("reset starts at Pin 1 when that number is available", async () => {
  const storage = { data: { pins: [numberedPins[1]], nextNumber: 8 } };
  const app = openApp(undefined, { storage });
  app.get("resetNumbering").onclick();
  app.moveTo(pins[0]);
  await app.get("saveBtn").click();
  assert.deepEqual(storage.data.pins.map(pin => pin.number), [3, 1]);
});

const backupData = {
  format: "zahid-tech-saved-locations",
  version: 1,
  pins: numberedPins,
  nextNumber: 2,
  numberingReset: true
};

async function importBackup(app, text) {
  const input = app.get("restoreFile");
  input.files = [new File([text], "backup.json")];
  await input.onchange({ currentTarget: input });
}

test("each backup creates a unique dated JSON file and leaves storage unchanged", async () => {
  const original = { pins: numberedPins, nextNumber: 2, numberingReset: true };
  const storage = { data: original };
  const files = [];
  const app = openApp(undefined, { storage, share: async ({ files: [file] }) => files.push(file) });

  await app.get("backupLocations").onclick();
  await app.get("backupLocations").onclick();

  assert.equal(files.length, 2);
  assert.notEqual(files[0].name, files[1].name);
  for (const file of files) {
    assert.match(file.name, /^ZaHiD-Tech-backup-\d{4}-\d{2}-\d{2}T.*\.json$/);
    assert.deepEqual(JSON.parse(await file.text()), backupData);
  }
  assert.equal(storage.data, original);
});

test("restore confirms replacement, persists names and numbering, and can save after reopening", async () => {
  const storage = { data: { pins, nextNumber: 10 } };
  const app = openApp(undefined, {
    storage,
    confirmReset(text) {
      assert.match(text, /replace all currently saved pins and numbering settings/);
      return true;
    }
  });
  await importBackup(app, JSON.stringify(backupData));
  assert.deepEqual(storage.data, { pins: numberedPins, nextNumber: 2, numberingReset: true });

  const reopened = openApp(undefined, { storage });
  reopened.moveTo(pins[0]);
  await reopened.get("saveBtn").click();
  assert.equal(storage.data.pins.at(-1).number, 2);
  assert.deepEqual(storage.data.pins.slice(0, 2), numberedPins);
});

test("invalid backups never prompt or write any saved locations", async () => {
  const original = { pins, nextNumber: 10 };
  const storage = { data: original };
  let confirmations = 0;
  const app = openApp(undefined, { storage, confirmReset: () => ++confirmations });

  for (const invalid of [
    "{",
    JSON.stringify({ ...backupData, version: 2 }),
    JSON.stringify({ ...backupData, pins: [numberedPins[0], numberedPins[0]] }),
    JSON.stringify({ ...backupData, pins: [{ ...numberedPins[0], lat: 91 }] }),
    JSON.stringify({ ...backupData, pins: [{ ...numberedPins[0], name: 42 }] }),
    JSON.stringify({ ...backupData, nextNumber: 0 }),
    JSON.stringify({ ...backupData, numberingReset: undefined })
  ]) {
    await importBackup(app, invalid);
    assert.match(app.get("backupRestoreStatus").textContent, /Could not read/);
  }
  assert.equal(confirmations, 0);
  assert.equal(storage.data, original);
});

test("cancelling a valid restore leaves saved locations and numbering intact", async () => {
  const original = { pins, nextNumber: 10 };
  const storage = { data: original };
  const app = openApp(undefined, { storage, confirmReset: () => false });

  await importBackup(app, JSON.stringify(backupData));

  assert.equal(app.get("backupRestoreStatus").textContent, "Restore cancelled.");
  assert.equal(storage.data, original);
});

const shareUrl = "https://zahid-iyaz.github.io/ZaHiD-Tech/";

test("Share App invokes native sharing during the tap with the app details", async () => {
  let shared;
  const app = openApp({ writeText: () => assert.fail("Unexpected clipboard write") }, {
    async share(data) { shared = { ...data }; }
  });

  const sharing = app.get("shareApp").onclick();
  assert.deepEqual(shared, {
    title: "ZaHiD Tech — Pin & Find",
    text: "Save your favourite locations and navigate back easily with ZaHiD Tech!",
    url: shareUrl
  });
  await sharing;
  assert.equal(app.get("shareStatus").textContent, "");
  assert.equal(app.get("shareDialog").open, undefined);
});

test("cancelling Share App leaves no status and skips both fallbacks", async () => {
  let copied = false;
  const app = openApp({ async writeText() { copied = true; } }, {
    async share() { throw new DOMException("Cancelled", "AbortError"); }
  });

  await app.get("shareApp").onclick();
  assert.equal(copied, false);
  assert.equal(app.get("shareStatus").textContent, "");
  assert.equal(app.get("shareDialog").open, undefined);
});

test("Share App copies the URL and confirms it when native sharing is unavailable", async () => {
  let copied;
  const app = openApp({ async writeText(text) { copied = text; } });

  await app.get("shareApp").onclick();
  assert.equal(copied, shareUrl);
  assert.equal(app.get("shareStatus").textContent, "App link copied.");
  assert.equal(app.get("shareDialog").open, undefined);
});

test("Share App falls back to copying when the native share request fails", async () => {
  let copied;
  const app = openApp({ async writeText(text) { copied = text; } }, {
    async share() { throw new DOMException("Sharing unavailable", "NotAllowedError"); }
  });

  await app.get("shareApp").onclick();
  assert.equal(copied, shareUrl);
  assert.equal(app.get("shareStatus").textContent, "App link copied.");
});

test("Share App offers a selectable URL when clipboard access is missing or denied", async () => {
  for (const clipboard of [undefined, { async writeText() { throw new Error("Clipboard denied"); } }]) {
    const app = openApp(clipboard);
    const field = app.get("shareUrl");
    let selected = false;
    field.select = () => { selected = true; };

    await app.get("shareApp").onclick();
    assert.equal(app.get("shareDialog").open, true);
    assert.equal(field.value, shareUrl);
    assert.equal(app.get("shareStatus").textContent, "");
    field.onclick({ currentTarget: field });
    assert.equal(selected, true);
  }
});
