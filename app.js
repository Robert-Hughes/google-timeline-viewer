const map = L.map("map", { preferCanvas: true }).setView([54.5, -3], 6);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const canvasRenderer = L.canvas({ padding: 0.1 });
const HOVER_RADIUS_PX = 10;
const HOVER_GRID_SIZE_PX = 64;

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
  status: document.getElementById("status"),
  perfLog: document.getElementById("perf-log")
};

const state = {
  timelinePaths: [],
  rawPoints: [],
  minTime: null,
  maxTime: null,
  pathLayer: null,
  rawLayer: null,
  visibleBounds: null,
  visibleSegments: [],
  hoverGrid: new Map(),
  hoverGridFrame: null,
  hoverGridTimer: null,
  hoverTooltip: null,
  hoverFrame: null,
  pendingMouseEvent: null,
  contextMenu: null,
  contextLatLng: null
};

function parseLatLng(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*°?\s*,\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*°?/);
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

const perfState = {
  entries: [],
  sequence: 0
};

function formatPerfMs(durationMs) {
  return `${durationMs.toFixed(1).padStart(7)} ms`;
}

function appendPerfEntry(label, durationMs, detail = "") {
  const entry = {
    id: ++perfState.sequence,
    label,
    durationMs,
    detail
  };

  perfState.entries.push(entry);
  if (perfState.entries.length > 24) {
    perfState.entries.splice(0, perfState.entries.length - 24);
  }

  const line = `[perf] ${label}: ${durationMs.toFixed(1)} ms${detail ? ` (${detail})` : ""}`;
  console.log(line);

  if (ui.perfLog) {
    ui.perfLog.textContent = perfState.entries
      .map(item => `${formatPerfMs(item.durationMs)}  ${item.label}${item.detail ? `  ${item.detail}` : ""}`)
      .join("\n");
  }

  return durationMs;
}

function recordPerf(label, startedAt, detail = "") {
  return appendPerfEntry(label, performance.now() - startedAt, detail);
}

if ("PerformanceObserver" in window) {
  try {
    const longTaskObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        appendPerfEntry(
          "browser long task",
          entry.duration,
          `started +${entry.startTime.toFixed(1)} ms`
        );
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch (error) {
    console.warn("Long-task performance logging unavailable:", error);
  }
}

function schedulePaintMeasurement(label, startedAt) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      recordPerf(label, startedAt);
    });
  });
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

    current.push(point);
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
      traces.push(visible);
    } else if (visible.length === 1) {
      singletonPoints.push(visible[0]);
    }
  }

  return { traces, singletonPoints, visibleCount };
}

function pointsToLatLngs(traces) {
  return traces.map(trace => trace.map(point => point.latLng));
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
  const latLngTraces = pointsToLatLngs(traces);

  if (latLngTraces.length) {
    L.polyline(latLngTraces, {
      renderer: canvasRenderer,
      weight: 3,
      opacity: 0.75
    }).addTo(group);
  }

  for (const point of singletonPoints) {
    L.circleMarker(point.latLng, {
      renderer: canvasRenderer,
      radius: 2,
      weight: 0,
      fillOpacity: 0.7
    }).addTo(group);
  }

  return group;
}

function createRawLayer(traces) {
  return L.polyline(pointsToLatLngs(traces), {
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

function appendTraceSegments(target, traces, source) {
  for (const trace of traces) {
    for (let i = 1; i < trace.length; i += 1) {
      target.push({
        a: trace[i - 1],
        b: trace[i],
        source
      });
    }
  }
}

function hoverGridKey(x, y) {
  return `${x},${y}`;
}

function rebuildHoverGrid() {
  const startedAt = performance.now();
  const zoom = map.getZoom();
  state.hoverGrid.clear();

  for (const segment of state.visibleSegments) {
    const a = map.project(segment.a.latLng, zoom);
    const b = map.project(segment.b.latLng, zoom);
    segment.screenA = a;
    segment.screenB = b;

    const minX = Math.floor((Math.min(a.x, b.x) - HOVER_RADIUS_PX) / HOVER_GRID_SIZE_PX);
    const maxX = Math.floor((Math.max(a.x, b.x) + HOVER_RADIUS_PX) / HOVER_GRID_SIZE_PX);
    const minY = Math.floor((Math.min(a.y, b.y) - HOVER_RADIUS_PX) / HOVER_GRID_SIZE_PX);
    const maxY = Math.floor((Math.max(a.y, b.y) + HOVER_RADIUS_PX) / HOVER_GRID_SIZE_PX);

    for (let gx = minX; gx <= maxX; gx += 1) {
      for (let gy = minY; gy <= maxY; gy += 1) {
        const key = hoverGridKey(gx, gy);
        const bucket = state.hoverGrid.get(key);
        if (bucket) {
          bucket.push(segment);
        } else {
          state.hoverGrid.set(key, [segment]);
        }
      }
    }
  }

  recordPerf(
    "hover grid",
    startedAt,
    `${state.visibleSegments.length.toLocaleString()} segments, ${state.hoverGrid.size.toLocaleString()} cells, z${zoom}`
  );
}

function cancelScheduledHoverGridRebuild() {
  if (state.hoverGridFrame !== null) {
    cancelAnimationFrame(state.hoverGridFrame);
    state.hoverGridFrame = null;
  }

  if (state.hoverGridTimer !== null) {
    clearTimeout(state.hoverGridTimer);
    state.hoverGridTimer = null;
  }
}

function scheduleHoverGridRebuild() {
  cancelScheduledHoverGridRebuild();
  state.hoverGrid.clear();

  state.hoverGridFrame = requestAnimationFrame(() => {
    state.hoverGridFrame = requestAnimationFrame(() => {
      state.hoverGridFrame = null;
      state.hoverGridTimer = setTimeout(() => {
        state.hoverGridTimer = null;
        rebuildHoverGrid();
      }, 0);
    });
  });
}

function nearestPointOnSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  let ratio = 0;
  if (lengthSquared > 0) {
    ratio = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    ratio = Math.max(0, Math.min(1, ratio));
  }

  const x = a.x + ratio * dx;
  const y = a.y + ratio * dy;
  const distanceSquared = (point.x - x) ** 2 + (point.y - y) ** 2;

  return { ratio, x, y, distanceSquared };
}

function findNearestTracePoint(containerPoint) {
  const zoom = map.getZoom();
  const worldPoint = map.project(map.containerPointToLatLng(containerPoint), zoom);
  const gx = Math.floor(worldPoint.x / HOVER_GRID_SIZE_PX);
  const gy = Math.floor(worldPoint.y / HOVER_GRID_SIZE_PX);
  const candidates = new Set();

  for (let x = gx - 1; x <= gx + 1; x += 1) {
    for (let y = gy - 1; y <= gy + 1; y += 1) {
      for (const segment of state.hoverGrid.get(hoverGridKey(x, y)) ?? []) {
        candidates.add(segment);
      }
    }
  }

  let best = null;
  const maxDistanceSquared = HOVER_RADIUS_PX ** 2;

  for (const segment of candidates) {
    const nearest = nearestPointOnSegment(worldPoint, segment.screenA, segment.screenB);
    if (nearest.distanceSquared > maxDistanceSquared) continue;
    if (best && nearest.distanceSquared >= best.distanceSquared) continue;

    const latLng = map.unproject(L.point(nearest.x, nearest.y), zoom);
    const time = segment.a.time + nearest.ratio * (segment.b.time - segment.a.time);
    best = {
      distanceSquared: nearest.distanceSquared,
      latLng,
      time,
      source: segment.source
    };
  }

  return best;
}

function ensureHoverTooltip() {
  if (!state.hoverTooltip) {
    state.hoverTooltip = L.tooltip({
      direction: "top",
      offset: [0, -8],
      opacity: 0.95,
      className: "trace-hover-tooltip"
    });
  }
  return state.hoverTooltip;
}

function hideHoverTooltip() {
  if (state.hoverTooltip && map.hasLayer(state.hoverTooltip)) {
    map.removeLayer(state.hoverTooltip);
  }
}

function formatCoordinates(latLng) {
  return `${latLng.lat.toFixed(6)}, ${latLng.lng.toFixed(6)}`;
}

function updateHoverTooltip(event) {
  const nearest = findNearestTracePoint(event.containerPoint);
  if (!nearest) {
    hideHoverTooltip();
    return;
  }

  const tooltip = ensureHoverTooltip();
  const sourceLabel = nearest.source === "raw" ? "Raw position trace" : "Timeline path";
  tooltip
    .setLatLng(nearest.latLng)
    .setContent(
      `<strong>${formatCoordinates(nearest.latLng)}</strong><br>` +
      `${new Date(nearest.time).toLocaleString()}<br>` +
      `<span class="trace-tooltip-source">${sourceLabel}</span>`
    );

  if (!map.hasLayer(tooltip)) {
    tooltip.addTo(map);
  }
}

function scheduleHover(event) {
  state.pendingMouseEvent = event;
  if (state.hoverFrame !== null) return;

  state.hoverFrame = requestAnimationFrame(() => {
    state.hoverFrame = null;
    const pending = state.pendingMouseEvent;
    state.pendingMouseEvent = null;
    if (pending) updateHoverTooltip(pending);
  });
}

function ensureContextMenu() {
  if (state.contextMenu) return state.contextMenu;

  const menu = document.createElement("div");
  menu.className = "map-context-menu";
  menu.hidden = true;

  const coords = document.createElement("div");
  coords.className = "map-context-coords";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "Copy GPS coordinates";
  copyButton.addEventListener("click", async () => {
    if (!state.contextLatLng) return;
    const text = formatCoordinates(state.contextLatLng);

    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = "Copied";
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "");
      input.style.position = "absolute";
      input.style.left = "-9999px";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      copyButton.textContent = "Copied";
    }

    setTimeout(hideContextMenu, 500);
  });

  menu.append(coords, copyButton);
  map.getContainer().appendChild(menu);
  L.DomEvent.disableClickPropagation(menu);
  L.DomEvent.disableScrollPropagation(menu);

  state.contextMenu = menu;
  return menu;
}

function showContextMenu(event) {
  hideHoverTooltip();
  const menu = ensureContextMenu();
  state.contextLatLng = event.latlng;

  menu.querySelector(".map-context-coords").textContent = formatCoordinates(event.latlng);
  const copyButton = menu.querySelector("button");
  copyButton.textContent = "Copy GPS coordinates";
  menu.hidden = false;

  const container = map.getContainer();
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  const x = Math.min(event.containerPoint.x, container.clientWidth - menuWidth - 8);
  const y = Math.min(event.containerPoint.y, container.clientHeight - menuHeight - 8);

  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
}

function hideContextMenu() {
  if (state.contextMenu) {
    state.contextMenu.hidden = true;
  }
}

function render() {
  if (state.minTime === null) return;

  const renderStartedAt = performance.now();
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

  let stageStartedAt = performance.now();
  removeLayers();
  hideHoverTooltip();
  hideContextMenu();
  recordPerf("remove old layers", stageStartedAt);

  stageStartedAt = performance.now();
  const pathResult = filteredTimelinePaths(start, end);
  recordPerf("filter timeline paths", stageStartedAt, `${pathResult.visibleCount.toLocaleString()} points`);

  stageStartedAt = performance.now();
  const rawResult = buildRawTraces(state.rawPoints, start, end);
  recordPerf("build raw traces", stageStartedAt, `${rawResult.visibleCount.toLocaleString()} points`);

  const bounds = L.latLngBounds([]);
  state.visibleSegments = [];

  if (ui.showPaths.checked) {
    stageStartedAt = performance.now();
    state.pathLayer = createPathLayer(pathResult.traces, pathResult.singletonPoints).addTo(map);
    recordPerf("create timeline Leaflet layer", stageStartedAt, `${pathResult.traces.length.toLocaleString()} traces`);

    stageStartedAt = performance.now();
    const pathLatLngs = pointsToLatLngs(pathResult.traces);
    addBounds(bounds, pathLatLngs);
    addBounds(bounds, pathResult.singletonPoints.map(point => point.latLng));
    appendTraceSegments(state.visibleSegments, pathResult.traces, "timeline");
    recordPerf("prepare timeline bounds + hover segments", stageStartedAt);
  }

  if (ui.showRaw.checked && rawResult.traces.length) {
    stageStartedAt = performance.now();
    state.rawLayer = createRawLayer(rawResult.traces).addTo(map);
    recordPerf("create raw Leaflet layer", stageStartedAt, `${rawResult.traces.length.toLocaleString()} traces`);

    stageStartedAt = performance.now();
    addBounds(bounds, pointsToLatLngs(rawResult.traces));
    appendTraceSegments(state.visibleSegments, rawResult.traces, "raw");
    recordPerf("prepare raw bounds + hover segments", stageStartedAt);
  }

  scheduleHoverGridRebuild();

  state.visibleBounds = bounds.isValid() ? bounds : null;
  ui.visibleCount.textContent =
    (pathResult.visibleCount + rawResult.visibleCount).toLocaleString();

  const fromText = new Date(start).toLocaleString();
  const toText = new Date(end).toLocaleString();
  updateStatus(`Showing ${fromText} – ${toText}.`);

  recordPerf(
    "render total (sync)",
    renderStartedAt,
    `${state.visibleSegments.length.toLocaleString()} hover segments`
  );
  schedulePaintMeasurement("render to 2nd animation frame", renderStartedAt);
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

  const extractStartedAt = performance.now();
  const extracted = extractTimeline(data);
  recordPerf(
    "extract Timeline data",
    extractStartedAt,
    `${extracted.timelinePaths.length.toLocaleString()} paths, ${extracted.rawPoints.length.toLocaleString()} raw points`
  );

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

  const fitStartedAt = performance.now();
  fitVisible();
  recordPerf("fit visible traces", fitStartedAt);

  updateStatus(
    `Loaded ${label}. Data range: ${new Date(state.minTime).toLocaleString()} – ${new Date(state.maxTime).toLocaleString()}.`
  );
}

async function loadDefaultData() {
  try {
    updateStatus("Loading data/Timeline.json…");

    let startedAt = performance.now();
    const response = await fetch("data/Timeline.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    recordPerf("fetch Timeline JSON", startedAt, `${(text.length / 1_000_000).toFixed(1)} MB text`);

    updateStatus("Parsing data/Timeline.json…");
    startedAt = performance.now();
    const data = JSON.parse(text);
    recordPerf("JSON.parse", startedAt);

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

    let startedAt = performance.now();
    const text = await file.text();
    recordPerf("read selected Timeline JSON", startedAt, `${(text.length / 1_000_000).toFixed(1)} MB text`);

    startedAt = performance.now();
    const data = JSON.parse(text);
    recordPerf("JSON.parse", startedAt);

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

map.on("mousemove", scheduleHover);
map.on("mouseout", hideHoverTooltip);
map.on("contextmenu", showContextMenu);
map.on("click", hideContextMenu);
map.on("movestart", () => {
  hideHoverTooltip();
  hideContextMenu();
});
map.on("zoomstart", () => {
  cancelScheduledHoverGridRebuild();
  state.hoverGrid.clear();
});
map.on("zoomend", scheduleHoverGridRebuild);

loadDefaultData();
