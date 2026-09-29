const map = L.map("map", { preferCanvas: true }).setView([54.5, -3], 6);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const canvasRenderer = L.canvas({ padding: 0.5 });

const ui = {
  fileInput: document.getElementById("file-input"),
  loadDefault: document.getElementById("load-default"),
  startTime: document.getElementById("start-time"),
  endTime: document.getElementById("end-time"),
  applyFilter: document.getElementById("apply-filter"),
  fullRange: document.getElementById("full-range"),
  fitTraces: document.getElementById("fit-traces"),
  showPaths: document.getElementById("show-paths"),
  showRaw: document.getElementById("show-raw"),
  pathCount: document.getElementById("path-count"),
  rawCount: document.getElementById("raw-count"),
  visibleCount: document.getElementById("visible-count"),
  status: document.getElementById("status")
};

const state = {
  timelinePaths: [],
  rawPoints: [],
  minTime: null,
  maxTime: null,
  pathLayer: null,
  rawLayer: null,
  visibleBounds: null
};

function parseLatLng(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/(-?\d+(?:\.\d+)?)\D+?,\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;

  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return [lat, lng];
}

function parseTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function localInputValue(timestamp) {
  const date = new Date(timestamp);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - offsetMs).toISOString().slice(0, 19);
}

function updateStatus(message) {
  ui.status.textContent = message;
}

function extractTimeline(data) {
  const timelinePaths = [];
  const rawPoints = [];
  let minTime = Infinity;
  let maxTime = -Infinity;

  for (const segment of data.semanticSegments ?? []) {
    if (!Array.isArray(segment.timelinePath)) continue;

    const points = [];
    for (const item of segment.timelinePath) {
      const latLng = parseLatLng(item.point);
      const time = parseTime(item.time);
      if (!latLng || time === null) continue;

      points.push({ latLng, time });
      minTime = Math.min(minTime, time);
      maxTime = Math.max(maxTime, time);
    }

    if (points.length) {
      points.sort((a, b) => a.time - b.time);
      timelinePaths.push(points);
    }
  }

  for (const signal of data.rawSignals ?? []) {
    const position = signal.position;
    if (!position) continue;

    const latLng = parseLatLng(position.LatLng ?? position.latLng);
    const time = parseTime(position.timestamp);
    if (!latLng || time === null) continue;

    rawPoints.push({
      latLng,
      time,
      accuracyMeters: Number(position.accuracyMeters) || null,
      source: position.source ?? null
    });

    minTime = Math.min(minTime, time);
    maxTime = Math.max(maxTime, time);
  }

  rawPoints.sort((a, b) => a.time - b.time);

  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
    throw new Error("No timestamped coordinates were found in this Timeline export.");
  }

  return { timelinePaths, rawPoints, minTime, maxTime };
}

function distanceKm(a, b) {
  const toRad = value => value * Math.PI / 180;
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLat = lat2 - lat1;
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function buildRawTraces(points, start, end) {
  const visible = points.filter(point => point.time >= start && point.time <= end);
  const traces = [];
  let current = [];
  let previous = null;

  for (const point of visible) {
    const gapMs = previous ? point.time - previous.time : 0;
    const jumpKm = previous ? distanceKm(previous.latLng, point.latLng) : 0;

    if (previous && (gapMs > 30 * 60_000 || jumpKm > 50)) {
      if (current.length >= 2) traces.push(current);
      current = [];
    }

    current.push(point.latLng);
    previous = point;
  }

  if (current.length >= 2) traces.push(current);
  return { traces, visibleCount: visible.length };
}

function filteredTimelinePaths(start, end) {
  const traces = [];
  const singletonPoints = [];
  let visibleCount = 0;

  for (const path of state.timelinePaths) {
    const visible = path.filter(point => point.time >= start && point.time <= end);
    visibleCount += visible.length;

    if (visible.length >= 2) {
      traces.push(visible.map(point => point.latLng));
    } else if (visible.length === 1) {
      singletonPoints.push(visible[0].latLng);
    }
  }

  return { traces, singletonPoints, visibleCount };
}

function removeLayers() {
  if (state.pathLayer) {
    state.pathLayer.remove();
    state.pathLayer = null;
  }
  if (state.rawLayer) {
    state.rawLayer.remove();
    state.rawLayer = null;
  }
}

function createPathLayer(traces, singletonPoints) {
  const group = L.layerGroup();

  if (traces.length) {
    L.polyline(traces, {
      renderer: canvasRenderer,
      weight: 3,
      opacity: 0.75
    }).addTo(group);
  }

  for (const latLng of singletonPoints) {
    L.circleMarker(latLng, {
      renderer: canvasRenderer,
      radius: 2,
      weight: 0,
      fillOpacity: 0.7
    }).addTo(group);
  }

  return group;
}

function createRawLayer(traces) {
  return L.polyline(traces, {
    renderer: canvasRenderer,
    weight: 2,
    opacity: 0.55,
    dashArray: "4 4"
  });
}

function addBounds(bounds, latLngs) {
  for (const item of latLngs) {
    if (Array.isArray(item[0])) {
      addBounds(bounds, item);
    } else {
      bounds.extend(item);
    }
  }
}

function render() {
  if (state.minTime === null) return;

  const start = new Date(ui.startTime.value).getTime();
  const end = new Date(ui.endTime.value).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    updateStatus("Choose a valid start and end date/time.");
    return;
  }
  if (start > end) {
    updateStatus("The start date/time must be before the end date/time.");
    return;
  }

  removeLayers();

  const pathResult = filteredTimelinePaths(start, end);
  const rawResult = buildRawTraces(state.rawPoints, start, end);
  const bounds = L.latLngBounds([]);

  if (ui.showPaths.checked) {
    state.pathLayer = createPathLayer(pathResult.traces, pathResult.singletonPoints).addTo(map);
    addBounds(bounds, pathResult.traces);
    addBounds(bounds, pathResult.singletonPoints);
  }

  if (ui.showRaw.checked && rawResult.traces.length) {
    state.rawLayer = createRawLayer(rawResult.traces).addTo(map);
    addBounds(bounds, rawResult.traces);
  }

  state.visibleBounds = bounds.isValid() ? bounds : null;
  ui.visibleCount.textContent =
    (pathResult.visibleCount + rawResult.visibleCount).toLocaleString();

  const fromText = new Date(start).toLocaleString();
  const toText = new Date(end).toLocaleString();
  updateStatus(`Showing ${fromText} – ${toText}.`);
}

function fitVisible() {
  if (state.visibleBounds) {
    map.fitBounds(state.visibleBounds, { padding: [24, 24], maxZoom: 16 });
  }
}

function setFullRange(renderNow = true) {
  ui.startTime.value = localInputValue(state.minTime);
  ui.endTime.value = localInputValue(state.maxTime);
  if (renderNow) {
    render();
    fitVisible();
  }
}

async function loadData(data, label) {
  updateStatus(`Parsing ${label}…`);
  await new Promise(resolve => setTimeout(resolve, 0));

  const extracted = extractTimeline(data);
  state.timelinePaths = extracted.timelinePaths;
  state.rawPoints = extracted.rawPoints;
  state.minTime = extracted.minTime;
  state.maxTime = extracted.maxTime;

  ui.pathCount.textContent = state.timelinePaths.length.toLocaleString();
  ui.rawCount.textContent = state.rawPoints.length.toLocaleString();
  ui.applyFilter.disabled = false;
  ui.fullRange.disabled = false;
  ui.fitTraces.disabled = false;

  setFullRange(false);
  render();
  fitVisible();

  updateStatus(
    `Loaded ${label}. Data range: ${new Date(state.minTime).toLocaleString()} – ${new Date(state.maxTime).toLocaleString()}.`
  );
}

async function loadDefaultData() {
  try {
    updateStatus("Loading data/Timeline.json…");
    const response = await fetch("data/Timeline.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    updateStatus("Parsing data/Timeline.json…");
    const data = JSON.parse(text);
    await loadData(data, "data/Timeline.json");
  } catch (error) {
    updateStatus(
      `Could not load data/Timeline.json (${error.message}). Choose a Timeline JSON file above instead.`
    );
  }
}

ui.fileInput.addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    updateStatus(`Reading ${file.name}…`);
    const data = JSON.parse(await file.text());
    await loadData(data, file.name);
  } catch (error) {
    updateStatus(`Failed to load ${file.name}: ${error.message}`);
  }
});

ui.loadDefault.addEventListener("click", loadDefaultData);
ui.applyFilter.addEventListener("click", render);
ui.fullRange.addEventListener("click", () => setFullRange(true));
ui.fitTraces.addEventListener("click", fitVisible);
ui.showPaths.addEventListener("change", render);
ui.showRaw.addEventListener("change", render);

loadDefaultData();
