const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

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

function openApp(clipboard, { storage = { data: { pins, nextNumber: 10 } }, confirmReset = () => true } = {}) {
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
