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
  anomalyMode: document.getElementById("anomaly-mode"),
  anomalyCount: document.getElementById("anomaly-count"),
  pathCount: document.getElementById("path-count"),
  rawCount: document.getElementById("raw-count"),
  visibleCount: document.getElementById("visible-count"),
  status: document.getElementById("status"),
  perfLog: document.getElementById("perf-log")
};

const state = {
  timelinePaths: [],
  rawPoints: [],
  anomalyCases: [],
  anomalyLegCount: 0,
  minTime: null,
  maxTime: null,
  pathLayer: null,
  rawLayer: null,
  traceRenderer: null,
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
  if (perfState.entries.length > 100) {
    perfState.entries.splice(0, perfState.entries.length - 100);
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

let previousAnimationFrameTime = null;
let dragStartedAt = null;
let dragEndedAt = null;

function monitorFrameGaps(frameTime) {
  if (previousAnimationFrameTime !== null) {
    const gapMs = frameTime - previousAnimationFrameTime;
    if (gapMs >= 80) {
      const traceCanvas = state.traceRenderer?.canvas ?? canvasRenderer._container;
      appendPerfEntry(
        "frame gap",
        gapMs,
        `z${map.getZoom()}, surface ${traceCanvas?.width ?? "?"}×${traceCanvas?.height ?? "?"}`
      );
    }
  }

  previousAnimationFrameTime = frameTime;
  requestAnimationFrame(monitorFrameGaps);
}

requestAnimationFrame(monitorFrameGaps);

if ("PerformanceObserver" in window &&
    PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) {
  try {
    const longAnimationFrameObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const scriptDuration = (entry.scripts ?? [])
          .reduce((total, script) => total + (script.duration ?? 0), 0);
        appendPerfEntry(
          "long animation frame",
          entry.duration,
          `scripts ${scriptDuration.toFixed(1)} ms, z${map.getZoom()}`
        );
      }
    });
    longAnimationFrameObserver.observe({ type: "long-animation-frame", buffered: false });
  } catch (error) {
    console.warn("Long-animation-frame logging unavailable:", error);
  }
}

function schedulePaintMeasurement(label, startedAt) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      recordPerf(label, startedAt);
    });
  });
}

class WebGLTraceRenderer {
  constructor(mapInstance) {
    this.map = mapInstance;
    this.pane = this.map.getPane("tracePane") || this.map.createPane("tracePane");
    this.pane.style.zIndex = "450";
    this.pane.style.pointerEvents = "none";

    this.canvas = document.createElement("canvas");
    this.canvas.className = "trace-webgl-layer leaflet-zoom-animated";
    Object.assign(this.canvas.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      transformOrigin: "0 0"
    });
    this.pane.appendChild(this.canvas);

    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true
    });
    if (!gl) {
      this.canvas.remove();
      throw new Error("WebGL2 is unavailable.");
    }

    this.gl = gl;
    this.segmentProgram = this.createSegmentProgram();
    this.pointProgram = this.createPointProgram();
    this.cornerBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        0, -1,
        1, -1,
        1, 1,
        0, -1,
        1, 1,
        0, 1
      ]),
      gl.STATIC_DRAW
    );

    this.buffers = {
      timeline: this.createDataBuffer(),
      anomaly: this.createDataBuffer(),
      raw: this.createDataBuffer(),
      points: this.createDataBuffer()
    };

    this.drawQueued = false;
    this.requestDraw = this.requestDraw.bind(this);
    this.handleZoomAnimation = this.handleZoomAnimation.bind(this);
    this.handleZoomEnd = this.handleZoomEnd.bind(this);
    this.map.on("move resize", this.requestDraw);
    this.map.on("zoomanim", this.handleZoomAnimation);
    this.map.on("zoomend", this.handleZoomEnd);

    this.canvas.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      updateStatus("WebGL context lost; refresh the page to restore trace rendering.");
    });

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "WebGL shader compilation failed.");
    }
    return shader;
  }

  createProgram(vertexSource, fragmentSource) {
    const gl = this.gl;
    const program = gl.createProgram();
    gl.attachShader(program, this.createShader(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, this.createShader(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "WebGL program linking failed.");
    }
    return program;
  }

  createSegmentProgram() {
    const gl = this.gl;
    const program = this.createProgram(
      `#version 300 es
      in vec4 a_segment;
      in vec2 a_corner;
      uniform float u_world_size;
      uniform vec2 u_pixel_min;
      uniform vec2 u_view_size;
      uniform float u_half_width;
      out float v_distance_px;

      void main() {
        vec2 p0 = a_segment.xy * u_world_size - u_pixel_min;
        vec2 p1 = a_segment.zw * u_world_size - u_pixel_min;
        vec2 delta = p1 - p0;
        float segment_length = max(length(delta), 0.0001);
        vec2 normal = vec2(-delta.y, delta.x) / segment_length;
        vec2 point = mix(p0, p1, a_corner.x) + normal * a_corner.y * u_half_width;
        vec2 clip = vec2(
          point.x / u_view_size.x * 2.0 - 1.0,
          1.0 - point.y / u_view_size.y * 2.0
        );
        gl_Position = vec4(clip, 0.0, 1.0);
        v_distance_px = a_corner.x * segment_length;
      }`,
      `#version 300 es
      precision mediump float;
      uniform vec4 u_color;
      uniform float u_dash_period;
      in float v_distance_px;
      out vec4 out_color;

      void main() {
        if (u_dash_period > 0.0 &&
            mod(v_distance_px, u_dash_period) >= u_dash_period * 0.5) {
          discard;
        }
        out_color = u_color;
      }`
    );

    return {
      program,
      segment: gl.getAttribLocation(program, "a_segment"),
      corner: gl.getAttribLocation(program, "a_corner"),
      worldSize: gl.getUniformLocation(program, "u_world_size"),
      pixelMin: gl.getUniformLocation(program, "u_pixel_min"),
      viewSize: gl.getUniformLocation(program, "u_view_size"),
      halfWidth: gl.getUniformLocation(program, "u_half_width"),
      color: gl.getUniformLocation(program, "u_color"),
      dashPeriod: gl.getUniformLocation(program, "u_dash_period")
    };
  }

  createPointProgram() {
    const gl = this.gl;
    const program = this.createProgram(
      `#version 300 es
      in vec2 a_world;
      uniform float u_world_size;
      uniform vec2 u_pixel_min;
      uniform vec2 u_view_size;
      uniform float u_point_size;

      void main() {
        vec2 point = a_world * u_world_size - u_pixel_min;
        vec2 clip = vec2(
          point.x / u_view_size.x * 2.0 - 1.0,
          1.0 - point.y / u_view_size.y * 2.0
        );
        gl_Position = vec4(clip, 0.0, 1.0);
        gl_PointSize = u_point_size;
      }`,
      `#version 300 es
      precision mediump float;
      uniform vec4 u_color;
      out vec4 out_color;

      void main() {
        vec2 centered = gl_PointCoord * 2.0 - 1.0;
        if (dot(centered, centered) > 1.0) {
          discard;
        }
        out_color = u_color;
      }`
    );

    return {
      program,
      world: gl.getAttribLocation(program, "a_world"),
      worldSize: gl.getUniformLocation(program, "u_world_size"),
      pixelMin: gl.getUniformLocation(program, "u_pixel_min"),
      viewSize: gl.getUniformLocation(program, "u_view_size"),
      pointSize: gl.getUniformLocation(program, "u_point_size"),
      color: gl.getUniformLocation(program, "u_color")
    };
  }

  createDataBuffer() {
    return {
      buffer: this.gl.createBuffer(),
      count: 0
    };
  }

  latLngToWorld(latLng) {
    const lat = Array.isArray(latLng) ? latLng[0] : latLng.lat;
    const lng = Array.isArray(latLng) ? latLng[1] : latLng.lng;
    const limitedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sinLat = Math.sin(limitedLat * Math.PI / 180);
    return [
      (lng + 180) / 360,
      0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)
    ];
  }

  uploadBuffer(target, values, componentsPerVertex) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, target.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
    target.count = values.length / componentsPerVertex;
  }

  setData(segments, singletonPoints) {
    const startedAt = performance.now();
    const counts = { timeline: 0, anomaly: 0, raw: 0 };
    for (const segment of segments) {
      counts[segment.source] += 1;
    }

    const arrays = {
      timeline: new Float32Array(counts.timeline * 4),
      anomaly: new Float32Array(counts.anomaly * 4),
      raw: new Float32Array(counts.raw * 4)
    };
    const offsets = { timeline: 0, anomaly: 0, raw: 0 };

    for (const segment of segments) {
      const start = this.latLngToWorld(segment.a.latLng);
      const end = this.latLngToWorld(segment.b.latLng);
      const target = arrays[segment.source];
      const offset = offsets[segment.source];
      target[offset] = start[0];
      target[offset + 1] = start[1];
      target[offset + 2] = end[0];
      target[offset + 3] = end[1];
      offsets[segment.source] += 4;
    }

    const points = new Float32Array(singletonPoints.length * 2);
    for (let index = 0; index < singletonPoints.length; index += 1) {
      const world = this.latLngToWorld(singletonPoints[index].latLng);
      points[index * 2] = world[0];
      points[index * 2 + 1] = world[1];
    }

    this.uploadBuffer(this.buffers.timeline, arrays.timeline, 4);
    this.uploadBuffer(this.buffers.anomaly, arrays.anomaly, 4);
    this.uploadBuffer(this.buffers.raw, arrays.raw, 4);
    this.uploadBuffer(this.buffers.points, points, 2);
    this.requestDraw();

    recordPerf(
      "upload WebGL trace buffers",
      startedAt,
      `${segments.length.toLocaleString()} segments, ${counts.anomaly.toLocaleString()} anomalous`
    );
  }

  resizeCanvas() {
    const size = this.map.getSize();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(size.x * dpr));
    const height = Math.max(1, Math.round(size.y * dpr));
    const mapPanePosition = L.DomUtil.getPosition(this.map._mapPane) || L.point(0, 0);

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.canvas.style.left = `${-mapPanePosition.x}px`;
    this.canvas.style.top = `${-mapPanePosition.y}px`;

    return { size, dpr };
  }

  setCommonUniforms(programInfo, size) {
    const gl = this.gl;
    const zoom = this.map.getZoom();
    const pixelBounds = this.map.getPixelBounds();
    gl.uniform1f(programInfo.worldSize, 256 * Math.pow(2, zoom));
    gl.uniform2f(programInfo.pixelMin, pixelBounds.min.x, pixelBounds.min.y);
    gl.uniform2f(programInfo.viewSize, size.x, size.y);
  }

  drawSegments(bufferInfo, width, color, dashPeriod = 0) {
    if (!bufferInfo.count) return;

    const gl = this.gl;
    const info = this.segmentProgram;
    gl.useProgram(info.program);
    this.setCommonUniforms(info, this.map.getSize());

    gl.bindBuffer(gl.ARRAY_BUFFER, bufferInfo.buffer);
    gl.enableVertexAttribArray(info.segment);
    gl.vertexAttribPointer(info.segment, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(info.segment, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.enableVertexAttribArray(info.corner);
    gl.vertexAttribPointer(info.corner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(info.corner, 0);

    gl.uniform1f(info.halfWidth, width / 2);
    gl.uniform4fv(info.color, color);
    gl.uniform1f(info.dashPeriod, dashPeriod);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, bufferInfo.count);
  }

  drawPoints(bufferInfo) {
    if (!bufferInfo.count) return;

    const gl = this.gl;
    const info = this.pointProgram;
    gl.useProgram(info.program);
    this.setCommonUniforms(info, this.map.getSize());

    gl.bindBuffer(gl.ARRAY_BUFFER, bufferInfo.buffer);
    gl.enableVertexAttribArray(info.world);
    gl.vertexAttribPointer(info.world, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(info.world, 0);

    gl.uniform1f(info.pointSize, 4);
    gl.uniform4fv(info.color, new Float32Array([0.2, 0.533, 1.0, 0.75]));
    gl.drawArrays(gl.POINTS, 0, bufferInfo.count);
  }

  draw() {
    this.drawQueued = false;
    const gl = this.gl;
    this.canvas.style.transform = "";
    this.resizeCanvas();

    this.drawZoom = this.map.getZoom();
    this.drawCenter = this.map.getCenter();

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.drawSegments(
      this.buffers.timeline,
      3,
      new Float32Array([0.2, 0.533, 1.0, 0.75])
    );
    this.drawSegments(
      this.buffers.anomaly,
      4,
      new Float32Array([0.9, 0.25, 0.15, 0.95])
    );
    this.drawSegments(
      this.buffers.raw,
      2,
      new Float32Array([0.2, 0.533, 1.0, 0.55]),
      8
    );
    this.drawPoints(this.buffers.points);
  }

  handleZoomAnimation(event) {
    if (this.drawZoom === undefined || !this.drawCenter) return;

    const scale = this.map.getZoomScale(event.zoom, this.drawZoom);
    const halfSize = this.map.getSize().multiplyBy(0.5);
    const projectedCenter = this.map.project(this.drawCenter, event.zoom);
    const newPixelOrigin = this.map._getNewPixelOrigin(event.center, event.zoom);
    const offset = halfSize.multiplyBy(-scale)
      .add(projectedCenter)
      .subtract(newPixelOrigin);
    L.DomUtil.setTransform(this.canvas, offset, scale);
  }

  handleZoomEnd() {
    this.canvas.style.transform = "";
    this.requestDraw();
  }

  requestDraw() {
    if (this.map._animatingZoom || this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => this.draw());
  }
}

function getTraceRenderer() {
  if (state.traceRenderer === null) {
    try {
      state.traceRenderer = new WebGLTraceRenderer(map);
    } catch (error) {
      console.warn("WebGL trace renderer unavailable; falling back to Leaflet Canvas.", error);
      state.traceRenderer = false;
    }
  }
  return state.traceRenderer;
}

function extractTimeline(data) {
  const timelinePaths = [];
  const rawPoints = [];
  const visits = [];
  let minTime = Infinity;
  let maxTime = -Infinity;

  for (let segmentIndex = 0; segmentIndex < (data.semanticSegments ?? []).length; segmentIndex += 1) {
    const segment = data.semanticSegments[segmentIndex];
    const visit = segment.visit;
    const visitLocation = parseLatLng(visit?.topCandidate?.placeLocation?.latLng);
    const visitStart = parseTime(segment.startTime);
    const visitEnd = parseTime(segment.endTime);

    if (visit && visitLocation && visitStart !== null && visitEnd !== null) {
      visits.push({
        segmentIndex,
        start: visitStart,
        end: visitEnd,
        latLng: visitLocation,
        probability: Number(visit.probability) || 0,
        candidateProbability: Number(visit.topCandidate?.probability) || 0,
        semanticType: visit.topCandidate?.semanticType ?? "UNKNOWN"
      });
    }

    if (!Array.isArray(segment.timelinePath)) continue;

    const points = [];
    for (let pointIndex = 0; pointIndex < segment.timelinePath.length; pointIndex += 1) {
      const item = segment.timelinePath[pointIndex];
      const latLng = parseLatLng(item.point);
      const time = parseTime(item.time);
      if (!latLng || time === null) continue;

      points.push({
        latLng,
        time,
        semanticSegmentIndex: segmentIndex,
        pathPointIndex: pointIndex,
        anomaliesFromPrevious: []
      });
      minTime = Math.min(minTime, time);
      maxTime = Math.max(maxTime, time);
    }

    if (points.length) {
      points.sort((a, b) => a.time - b.time);
      timelinePaths.push(points);
    }
  }

  visits.sort((a, b) => a.start - b.start);
  const anomalyCases = detectTimelineAnomalies(timelinePaths, visits);
  const anomalyLegCount = timelinePaths.reduce(
    (count, path) => count + path.filter(point => point.anomaliesFromPrevious.length > 0).length,
    0
  );

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

  return { timelinePaths, rawPoints, anomalyCases, anomalyLegCount, minTime, maxTime };
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

function detectTimelineAnomalies(timelinePaths, visits) {
  const anomalyCases = [];
  let nextCaseId = 1;

  function overlappingVisits(time) {
    let low = 0;
    let high = visits.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (visits[middle].start <= time) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    const matches = [];
    for (let index = low - 1; index >= 0; index -= 1) {
      const visit = visits[index];
      if (time - visit.start > 72 * 60 * 60_000 && visit.end < time) break;
      if (visit.start <= time && visit.end >= time) {
        matches.push(visit);
      }
    }
    return matches;
  }

  function strongVisitConflict(point) {
    for (const visit of overlappingVisits(point.time)) {
      const minutesFromStart = (point.time - visit.start) / 60_000;
      const minutesToEnd = (visit.end - point.time) / 60_000;
      const distanceFromVisitKm = distanceKm(point.latLng, visit.latLng);

      if (visit.probability >= 0.65 &&
          visit.candidateProbability >= 0.80 &&
          minutesFromStart >= 5 &&
          minutesToEnd >= 5 &&
          distanceFromVisitKm >= 30) {
        return {
          visit,
          distanceFromVisitKm
        };
      }
    }
    return null;
  }

  function markLeg(destinationPoint, anomalyCase) {
    destinationPoint.anomaliesFromPrevious.push({
      caseId: anomalyCase.id,
      rule: anomalyCase.rule,
      reason: anomalyCase.reason
    });
  }

  for (const path of timelinePaths) {
    for (let index = 1; index + 1 < path.length; index += 1) {
      const before = path[index - 1];
      const point = path[index];
      const after = path[index + 1];
      const distanceInKm = distanceKm(before.latLng, point.latLng);
      const distanceOutKm = distanceKm(point.latLng, after.latLng);
      const bypassDistanceKm = distanceKm(before.latLng, after.latLng);
      const elapsedMinutes = (after.time - before.time) / 60_000;

      if (distanceInKm >= 50 &&
          distanceOutKm >= 50 &&
          bypassDistanceKm <= 10 &&
          elapsedMinutes > 0 &&
          elapsedMinutes <= 30) {
        const anomalyCase = {
          id: nextCaseId++,
          rule: "isolated-spatial-spike",
          reason: "Isolated spatial spike: " + distanceInKm.toFixed(1) + " km out, " +
            distanceOutKm.toFixed(1) + " km back, while surrounding points are " +
            bypassDistanceKm.toFixed(1) + " km apart.",
          semanticSegmentIndex: point.semanticSegmentIndex,
          time: point.time,
          latLng: point.latLng
        };
        anomalyCases.push(anomalyCase);
        markLeg(point, anomalyCase);
        markLeg(after, anomalyCase);
      }
    }

    for (let index = 1; index < path.length; index += 1) {
      const startPoint = path[index - 1];
      const endPoint = path[index];
      const legDistanceKm = distanceKm(startPoint.latLng, endPoint.latLng);
      const elapsedHours = (endPoint.time - startPoint.time) / 3_600_000;
      if (elapsedHours <= 0) continue;

      const speedKmh = legDistanceKm / elapsedHours;
      if (legDistanceKm < 30 || speedKmh < 180) continue;

      const startConflict = strongVisitConflict(startPoint);
      const endConflict = strongVisitConflict(endPoint);
      const conflict = startConflict ?? endConflict;
      if (!conflict) continue;

      const conflictingPoint = startConflict ? startPoint : endPoint;
      const anomalyCase = {
        id: nextCaseId++,
        rule: "implausible-leg-with-visit-conflict",
        reason: "Implausible leg: " + legDistanceKm.toFixed(1) + " km in " +
          ((endPoint.time - startPoint.time) / 60_000).toFixed(1) + " min (" +
          speedKmh.toFixed(0) + " km/h), while an overlapping high-confidence " +
          conflict.visit.semanticType.toLowerCase() + " visit is " +
          conflict.distanceFromVisitKm.toFixed(1) + " km from the conflicting endpoint.",
        semanticSegmentIndex: startPoint.semanticSegmentIndex,
        time: conflictingPoint.time,
        latLng: conflictingPoint.latLng
      };
      anomalyCases.push(anomalyCase);
      markLeg(endPoint, anomalyCase);
    }
  }

  return anomalyCases;
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

function appendTraceSegments(target, traces, source, anomalyMode = "show") {
  for (const trace of traces) {
    for (let i = 1; i < trace.length; i += 1) {
      const anomalies = source === "timeline"
        ? (trace[i].anomaliesFromPrevious ?? [])
        : [];
      const isAnomaly = anomalies.length > 0;

      if (source === "timeline" && anomalyMode === "hide" && isAnomaly) continue;
      if (source === "timeline" && anomalyMode === "only" && !isAnomaly) continue;

      target.push({
        a: trace[i - 1],
        b: trace[i],
        source: isAnomaly ? "anomaly" : source,
        anomaly: isAnomaly ? anomalies[0] : null
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
      source: segment.source,
      anomaly: segment.anomaly
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
  const sourceLabel = nearest.source === "raw"
    ? "Raw position trace"
    : nearest.source === "anomaly"
      ? "Potentially anomalous Timeline leg"
      : "Timeline path";
  const anomalyDetail = nearest.anomaly
    ? `<br><span class="trace-tooltip-source">${nearest.anomaly.reason}</span>`
    : "";
  tooltip
    .setLatLng(nearest.latLng)
    .setContent(
      `<strong>${formatCoordinates(nearest.latLng)}</strong><br>` +
      `${new Date(nearest.time).toLocaleString()}<br>` +
      `<span class="trace-tooltip-source">${sourceLabel}</span>${anomalyDetail}`
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
  const anomalyMode = ui.anomalyMode.value;

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
    appendTraceSegments(state.visibleSegments, pathResult.traces, "timeline", anomalyMode);
    recordPerf("prepare timeline hover segments", stageStartedAt);
  }

  if (anomalyMode !== "only" && ui.showRaw.checked && rawResult.traces.length) {
    stageStartedAt = performance.now();
    appendTraceSegments(state.visibleSegments, rawResult.traces, "raw");
    recordPerf("prepare raw hover segments", stageStartedAt);
  }

  for (const segment of state.visibleSegments) {
    bounds.extend(segment.a.latLng);
    bounds.extend(segment.b.latLng);
  }

  const visibleSingletonPoints =
    ui.showPaths.checked && anomalyMode !== "only"
      ? pathResult.singletonPoints
      : [];
  for (const point of visibleSingletonPoints) {
    bounds.extend(point.latLng);
  }

  const traceRenderer = getTraceRenderer();
  if (traceRenderer) {
    traceRenderer.setData(state.visibleSegments, visibleSingletonPoints);
  } else {
    const group = L.layerGroup();
    const normalPairs = state.visibleSegments
      .filter(segment => segment.source === "timeline")
      .map(segment => [segment.a.latLng, segment.b.latLng]);
    const anomalyPairs = state.visibleSegments
      .filter(segment => segment.source === "anomaly")
      .map(segment => [segment.a.latLng, segment.b.latLng]);
    const rawPairs = state.visibleSegments
      .filter(segment => segment.source === "raw")
      .map(segment => [segment.a.latLng, segment.b.latLng]);

    if (normalPairs.length) {
      L.polyline(normalPairs, { renderer: canvasRenderer, weight: 3, opacity: 0.75 }).addTo(group);
    }
    if (anomalyPairs.length) {
      L.polyline(anomalyPairs, {
        renderer: canvasRenderer,
        weight: 4,
        opacity: 0.95,
        color: "#e64026"
      }).addTo(group);
    }
    if (rawPairs.length) {
      L.polyline(rawPairs, {
        renderer: canvasRenderer,
        weight: 2,
        opacity: 0.55,
        dashArray: "4 4"
      }).addTo(group);
    }
    state.pathLayer = group.addTo(map);
  }

  scheduleHoverGridRebuild();

  state.visibleBounds = bounds.isValid() ? bounds : null;
  ui.visibleCount.textContent =
    (pathResult.visibleCount + (anomalyMode === "only" ? 0 : rawResult.visibleCount)).toLocaleString();

  const visibleAnomalyLegs = state.visibleSegments
    .filter(segment => segment.source === "anomaly").length;
  const fromText = new Date(start).toLocaleString();
  const toText = new Date(end).toLocaleString();
  updateStatus(
    `Showing ${fromText} – ${toText}. ` +
    `${visibleAnomalyLegs.toLocaleString()} potentially anomalous legs visible.`
  );

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
  state.anomalyCases = extracted.anomalyCases;
  state.anomalyLegCount = extracted.anomalyLegCount;
  state.minTime = extracted.minTime;
  state.maxTime = extracted.maxTime;

  ui.pathCount.textContent = state.timelinePaths.length.toLocaleString();
  ui.rawCount.textContent = state.rawPoints.length.toLocaleString();
  ui.anomalyCount.textContent =
    `${state.anomalyCases.length.toLocaleString()} cases / ${state.anomalyLegCount.toLocaleString()} legs`;
  ui.applyFilter.disabled = false;
  ui.fullRange.disabled = false;
  ui.fitTraces.disabled = false;

  setFullRange(false);
  render();

  const fitStartedAt = performance.now();
  fitVisible();
  recordPerf("fit visible traces", fitStartedAt);

  updateStatus(
    `Loaded ${label}. Data range: ${new Date(state.minTime).toLocaleString()} – ` +
    `${new Date(state.maxTime).toLocaleString()}. Detected ` +
    `${state.anomalyCases.length} potential anomaly cases (${state.anomalyLegCount} legs); hidden by default.`
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
ui.anomalyMode.addEventListener("change", render);

map.on("mousemove", scheduleHover);
map.on("mouseout", hideHoverTooltip);
map.on("contextmenu", showContextMenu);
map.on("click", hideContextMenu);
map.on("dragstart", () => {
  dragStartedAt = performance.now();
});

map.on("dragend", () => {
  const now = performance.now();
  if (dragStartedAt !== null) {
    appendPerfEntry("drag gesture", now - dragStartedAt, `z${map.getZoom()}`);
  }
  dragEndedAt = now;

  requestAnimationFrame(() => {
    appendPerfEntry("dragend to next frame", performance.now() - now, `z${map.getZoom()}`);
  });
  schedulePaintMeasurement("dragend to 2nd animation frame", now);
});

map.on("moveend", () => {
  if (dragEndedAt !== null) {
    appendPerfEntry("dragend to moveend", performance.now() - dragEndedAt, `z${map.getZoom()}`);
    dragEndedAt = null;
  }
});

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
