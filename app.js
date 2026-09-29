const map = L.map("map", { preferCanvas: true }).setView([54.5, -3], 6);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const canvasRenderer = L.canvas({ padding: 0.1 });
const HOVER_RADIUS_PX = 10;
const HOVER_WORLD_GRID_SIZE = 0.25; // zoom-0 projected pixels; fixed across all zoom levels
const GREAT_CIRCLE_THRESHOLD_KM = 100;
const GREAT_CIRCLE_MAX_CHORD_KM = 100;

const ui = {
  fileInput: document.getElementById("file-input"),
  loadDefault: document.getElementById("load-default"),
  startTime: document.getElementById("start-time"),
  startTimeParsed: document.getElementById("start-time-parsed"),
  endTime: document.getElementById("end-time"),
  endTimeParsed: document.getElementById("end-time-parsed"),
  applyFilter: document.getElementById("apply-filter"),
  fullRange: document.getElementById("full-range"),
  fitTraces: document.getElementById("fit-traces"),
  showPaths: document.getElementById("show-paths"),
  showRaw: document.getElementById("show-raw"),
  overlayOpacity: document.getElementById("overlay-opacity"),
  overlayOpacityValue: document.getElementById("overlay-opacity-value"),
  anomalyMode: document.getElementById("anomaly-mode"),
  anomalyCount: document.getElementById("anomaly-count"),
  stitchMode: document.getElementById("stitch-mode"),
  stitchCount: document.getElementById("stitch-count"),
  pathCount: document.getElementById("path-count"),
  rawCount: document.getElementById("raw-count"),
  visibleCount: document.getElementById("visible-count"),
  status: document.getElementById("status"),
  perfLog: document.getElementById("perf-log")
};

const state = {
  timelinePaths: [],
  rawPoints: [],
  inferredStitches: [],
  anomalyCases: [],
  anomalyLegCount: 0,
  minTime: null,
  maxTime: null,
  pathLayer: null,
  rawLayer: null,
  traceRenderer: null,
  visibleBounds: null,
  visibleSegments: [],
  renderSegments: [],
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

function formatFilterInput(timestamp) {
  const date = new Date(timestamp);
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseFilterDateTime(value, endOfDay = false) {
  let text = String(value ?? "").trim();
  if (!text) return null;

  const monthNames = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11
  };

  function fullYear(year) {
    if (year >= 100) return year;
    return year < 70 ? 2000 + year : 1900 + year;
  }

  function parseClock(raw, useEndOfDayDefault = endOfDay) {
    let clockText = String(raw ?? "").trim().toLowerCase();
    if (!clockText) {
      return useEndOfDayDefault
        ? { hour: 23, minute: 59, second: 59, millisecond: 999 }
        : { hour: 0, minute: 0, second: 0, millisecond: 0 };
    }

    clockText = clockText
      .replace(/\b(?:at|time)\b/g, " ")
      .replace(/(?:hours?|hrs?)\b/g, "")
      .replace(/a\.m\./g, "am")
      .replace(/p\.m\./g, "pm")
      .replace(/\s+/g, " ")
      .trim();

    if (clockText === "noon") {
      return { hour: 12, minute: 0, second: 0, millisecond: 0 };
    }
    if (clockText === "midnight") {
      return { hour: 0, minute: 0, second: 0, millisecond: 0 };
    }

    const spacedClock = clockText.match(/^(\d{1,2})\s+(\d{2})(?:\s+(\d{2}))?\s*(am|pm)?$/);
    if (spacedClock) {
      clockText = `${spacedClock[1]}:${spacedClock[2]}` +
        (spacedClock[3] ? `:${spacedClock[3]}` : "") +
        (spacedClock[4] ?? "");
    }

    const compact = clockText.match(/^(\d{2})(\d{2})(\d{2})?$/);
    if (compact) {
      const hour = Number(compact[1]);
      const minute = Number(compact[2]);
      const second = Number(compact[3] ?? 0);
      if (hour <= 23 && minute <= 59 && second <= 59) {
        return { hour, minute, second, millisecond: 0 };
      }
      return null;
    }

    const match = clockText.match(
      /^(\d{1,2})(?:(?::|\.|h|\s+)(\d{1,2}))?(?:(?::|\.|h|\s+)(\d{1,2}))?(?:\.(\d{1,3}))?\s*(am|pm)?$/
    );
    if (!match) return null;

    let hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    const second = Number(match[3] ?? 0);
    const millisecond = Number((match[4] ?? "0").padEnd(3, "0"));
    const meridiem = match[5];

    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      if (hour === 12) hour = 0;
      if (meridiem === "pm") hour += 12;
    }

    if (hour > 23 || minute > 59 || second > 59) return null;
    return { hour, minute, second, millisecond };
  }

  function makeLocal(year, month, day, clockText, defaultEnd = endOfDay) {
    const resolvedYear = fullYear(Number(year));
    const clock = parseClock(clockText, defaultEnd);
    if (!clock || month < 0 || month > 11 || day < 1 || day > 31) return null;

    const date = new Date(
      resolvedYear,
      month,
      Number(day),
      clock.hour,
      clock.minute,
      clock.second,
      clock.millisecond
    );

    if (date.getFullYear() !== resolvedYear ||
        date.getMonth() !== month ||
        date.getDate() !== Number(day)) {
      return null;
    }
    return date.getTime();
  }

  function leftoverClock(match) {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    return (before + " " + after)
      .replace(/^[\s,;@-]+|[\s,;@-]+$/g, "")
      .replace(/^t\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (/^now$/i.test(text)) return Date.now();

  // Preserve ISO/RFC strings with an explicit timezone exactly as written.
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const explicitZone = Date.parse(text);
    if (Number.isFinite(explicitZone)) return explicitZone;
  }

  text = text
    .replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1")
    .replace(/\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b,?/gi, " ")
    .replace(/\b(?:on)\b/gi, " ")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const relative = text.match(/\b(today|yesterday|tomorrow)\b/i);
  if (relative) {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const name = relative[1].toLowerCase();
    if (name === "yesterday") base.setDate(base.getDate() - 1);
    if (name === "tomorrow") base.setDate(base.getDate() + 1);

    const clockText = leftoverClock(relative);
    const clock = parseClock(clockText, endOfDay);
    if (!clock) return null;
    base.setHours(clock.hour, clock.minute, clock.second, clock.millisecond);
    return base.getTime();
  }

  const datePatterns = [
    {
      re: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/i,
      parts: match => [match[1], Number(match[2]) - 1, match[3]]
    },
    {
      re: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/i,
      parts: match => [match[3], Number(match[2]) - 1, match[1]]
    },
    {
      re: /\b(\d{1,2})(?:\s*[-/]\s*|\s+)([a-z]+)(?:\s*[-/]\s*|\s+)(\d{2,4})\b/i,
      parts: match => {
        const month = monthNames[match[2].toLowerCase()];
        return month === undefined ? null : [match[3], month, match[1]];
      }
    },
    {
      re: /\b([a-z]+)(?:\s*[-/]\s*|\s+)(\d{1,2})(?:\s*[-/]\s*|\s+)(\d{2,4})\b/i,
      parts: match => {
        const month = monthNames[match[1].toLowerCase()];
        return month === undefined ? null : [match[3], month, match[2]];
      }
    },
    {
      re: /\b(\d{4})(?:\s*[-/]\s*|\s+)([a-z]+)(?:\s*[-/]\s*|\s+)(\d{1,2})\b/i,
      parts: match => {
        const month = monthNames[match[2].toLowerCase()];
        return month === undefined ? null : [match[1], month, match[3]];
      }
    }
  ];

  for (const pattern of datePatterns) {
    let searchStart = 0;
    while (searchStart < text.length) {
      const match = pattern.re.exec(text.slice(searchStart));
      if (!match) break;
      match.index += searchStart;

      const parts = pattern.parts(match);
      if (parts) {
        const clockText = leftoverClock(match);
        return makeLocal(parts[0], parts[1], parts[2], clockText);
      }

      // A word fit the date shape but was not actually a month (for example
      // the "pm" in "10 30 pm 14 Oct 2017"). Keep scanning for the real date.
      searchStart = match.index + 1;
    }
  }

  // Month/year shorthand: "Oct 2017", "2017-10".
  let monthYear = text.match(/^([a-z]+)\s+(\d{4})$/i);
  if (monthYear) {
    const month = monthNames[monthYear[1].toLowerCase()];
    if (month !== undefined) {
      const day = endOfDay ? new Date(Number(monthYear[2]), month + 1, 0).getDate() : 1;
      return makeLocal(monthYear[2], month, day, "", endOfDay);
    }
  }
  monthYear = text.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (monthYear) {
    const month = Number(monthYear[2]) - 1;
    if (month >= 0 && month <= 11) {
      const day = endOfDay ? new Date(Number(monthYear[1]), month + 1, 0).getDate() : 1;
      return makeLocal(monthYear[1], month, day, "", endOfDay);
    }
  }

  // Four bare digits are ambiguous. Treat plausible contemporary years as
  // years; otherwise prefer HHMM when it forms a valid time (e.g. "2200").
  if (/^\d{4}$/.test(text)) {
    const number = Number(text);
    const latestLikelyYear = new Date().getFullYear() + 10;
    if (number >= 1900 && number <= latestLikelyYear) {
      return makeLocal(text, endOfDay ? 11 : 0, endOfDay ? 31 : 1, "", endOfDay);
    }
  }

  // A bare time is interpreted as today.
  const clockOnly = parseClock(text, false);
  if (clockOnly) {
    const today = new Date();
    today.setHours(clockOnly.hour, clockOnly.minute, clockOnly.second, clockOnly.millisecond);
    return today.getTime();
  }

  // Last-resort browser parsing for other unambiguous textual formats.
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatParsedDateTime(timestamp) {
  return new Date(timestamp).toLocaleString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  });
}

function updateDateTimeParseFeedback(input, output, endOfDay) {
  const parsed = parseFilterDateTime(input.value, endOfDay);
  const valid = parsed !== null;

  input.classList.toggle("parse-invalid", !valid);
  input.setAttribute("aria-invalid", valid ? "false" : "true");
  output.classList.toggle("parse-error", !valid);
  output.textContent = valid
    ? `Parsed: ${formatParsedDateTime(parsed)}`
    : "Could not parse this date/time";

  return parsed;
}

function updateAllDateTimeParseFeedback() {
  return {
    start: updateDateTimeParseFeedback(ui.startTime, ui.startTimeParsed, false),
    end: updateDateTimeParseFeedback(ui.endTime, ui.endTimeParsed, true)
  };
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
      opacity: String(Number(ui.overlayOpacity?.value ?? 90) / 100),
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
    this.heatmapProgram = this.createHeatmapProgram();
    this.densityTexture = gl.createTexture();
    this.densityFramebuffer = gl.createFramebuffer();
    this.densityWidth = 0;
    this.densityHeight = 0;
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
      stitch: this.createDataBuffer(),
      raw: this.createDataBuffer(),
      points: this.createDataBuffer()
    };

    this.drawQueued = false;
    this.drawFrame = null;
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
  createHeatmapProgram() {
    const gl = this.gl;
    const program = this.createProgram(
      `#version 300 es
      out vec2 v_uv;

      void main() {
        vec2 positions[3] = vec2[3](
          vec2(-1.0, -1.0),
          vec2(3.0, -1.0),
          vec2(-1.0, 3.0)
        );
        vec2 position = positions[gl_VertexID];
        v_uv = position * 0.5 + 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
      }`,
      `#version 300 es
      precision highp float;
      uniform sampler2D u_density;
      in vec2 v_uv;
      out vec4 out_color;

      vec3 heatColour(float density) {
        float heat = clamp(log2(max(density, 1.0)) / 6.0, 0.0, 1.0);
        vec3 blue = vec3(0.08, 0.38, 1.0);
        vec3 red = vec3(0.96, 0.10, 0.05);
        vec3 yellow = vec3(1.0, 0.90, 0.05);

        if (heat < 0.5) {
          return mix(blue, red, heat * 2.0);
        }
        return mix(red, yellow, (heat - 0.5) * 2.0);
      }

      void main() {
        float density = texture(u_density, v_uv).r * 64.0;
        if (density < 0.5) {
          discard;
        }
        out_color = vec4(heatColour(density), 0.90);
      }`
    );

    return {
      program,
      density: gl.getUniformLocation(program, "u_density")
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
    const counts = { timeline: 0, anomaly: 0, stitch: 0, raw: 0 };
    for (const segment of segments) {
      counts[segment.source] += 1;
    }

    const arrays = {
      timeline: new Float32Array(counts.timeline * 4),
      anomaly: new Float32Array(counts.anomaly * 4),
      stitch: new Float32Array(counts.stitch * 4),
      raw: new Float32Array(counts.raw * 4)
    };
    const offsets = { timeline: 0, anomaly: 0, stitch: 0, raw: 0 };

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
    this.uploadBuffer(this.buffers.stitch, arrays.stitch, 4);
    this.uploadBuffer(this.buffers.raw, arrays.raw, 4);
    this.uploadBuffer(this.buffers.points, points, 2);
    this.requestDraw();

    recordPerf(
      "upload WebGL trace buffers",
      startedAt,
      `${segments.length.toLocaleString()} segments, ${counts.anomaly.toLocaleString()} anomalous, ` +
        `${counts.stitch.toLocaleString()} highlighted stitches`
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
  resizeDensityTarget() {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width === this.densityWidth && height === this.densityHeight) return;

    this.densityWidth = width;
    this.densityHeight = height;

    gl.bindTexture(gl.TEXTURE_2D, this.densityTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.densityFramebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.densityTexture,
      0
    );

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Density framebuffer is incomplete (0x${status.toString(16)}).`);
    }
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

  drawHeatmap() {
    const gl = this.gl;
    const info = this.heatmapProgram;
    gl.useProgram(info.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.densityTexture);
    gl.uniform1i(info.density, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  draw() {
    this.drawQueued = false;
    if (this.map._animatingZoom) return;

    const gl = this.gl;
    this.canvas.style.transform = "";
    this.resizeCanvas();
    this.resizeDensityTarget();

    this.drawZoom = this.map.getZoom();
    this.drawCenter = this.map.getCenter();
    this.drawPixelMin = this.map.getPixelBounds().min.clone();

    // Pass 1: accumulate Timeline coverage into the red channel of an
    // off-screen 8-bit texture. One traversal contributes 1/64, so the
    // useful density range is 1..64+ without requiring float render targets.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.densityFramebuffer);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.colorMask(true, false, false, false);
    this.drawSegments(
      this.buffers.timeline,
      3,
      new Float32Array([1 / 64, 0, 0, 0])
    );
    gl.colorMask(true, true, true, true);

    // Pass 2: map accumulated density to blue -> red -> yellow, then draw
    // diagnostic/auxiliary layers normally on top.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA
    );
    this.drawHeatmap();
    this.drawSegments(
      this.buffers.anomaly,
      4,
      new Float32Array([0.9, 0.25, 0.15, 0.95])
    );
    this.drawSegments(
      this.buffers.stitch,
      3,
      new Float32Array([1.0, 0.1, 0.65, 0.95]),
      10
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
    if (this.drawFrame !== null) {
      cancelAnimationFrame(this.drawFrame);
      this.drawFrame = null;
      this.drawQueued = false;
    }
    if (this.drawZoom === undefined || !this.drawPixelMin) return;

    const scale = this.map.getZoomScale(event.zoom, this.drawZoom);
    const mapPanePosition = L.DomUtil.getPosition(this.map._mapPane) || L.point(0, 0);
    const targetPixelMin = this.map._getNewPixelOrigin(event.center, event.zoom)
      .subtract(mapPanePosition);
    const offset = this.drawPixelMin.multiplyBy(scale).subtract(targetPixelMin);
    L.DomUtil.setTransform(this.canvas, offset, scale);
  }

  handleZoomEnd() {
    this.canvas.style.transform = "";

    if (this.drawFrame !== null) {
      cancelAnimationFrame(this.drawFrame);
    }
    this.drawQueued = true;

    const drawAfterZoom = () => {
      if (this.map._animatingZoom) {
        this.drawFrame = requestAnimationFrame(drawAfterZoom);
        return;
      }

      this.drawFrame = null;
      this.drawQueued = false;
      this.draw();
    };

    this.drawFrame = requestAnimationFrame(drawAfterZoom);
  }

  requestDraw() {
    if (this.map._animatingZoom || this.drawQueued) return;
    this.drawQueued = true;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = null;
      this.drawQueued = false;
      if (this.map._animatingZoom) return;
      this.draw();
    });
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
      for (let order = 0; order < points.length; order += 1) {
        points[order].observationKind = "timeline";
        points[order].timelinePathId = segmentIndex;
        points[order].timelinePathOrder = order;
      }
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
  for (let order = 0; order < rawPoints.length; order += 1) {
    rawPoints[order].observationKind = "raw";
    rawPoints[order].rawOrder = order;
  }

  const inferredStitches = buildInferredStitches(timelinePaths, rawPoints);

  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
    throw new Error("No timestamped coordinates were found in this Timeline export.");
  }

  return {
    timelinePaths,
    rawPoints,
    inferredStitches,
    anomalyCases,
    anomalyLegCount,
    minTime,
    maxTime
  };
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
function interpolateGreatCircle(a, b, fraction) {
  const toRad = value => value * Math.PI / 180;
  const toDeg = value => value * 180 / Math.PI;
  const lat1 = toRad(a[0]);
  const lng1 = toRad(a[1]);
  const lat2 = toRad(b[0]);
  const lng2 = toRad(b[1]);
  const centralAngle = distanceKm(a, b) / 6371;

  if (centralAngle < 1e-12) return [a[0], a[1]];

  const sinAngle = Math.sin(centralAngle);
  if (Math.abs(sinAngle) < 1e-12) {
    const lngDelta = ((b[1] - a[1] + 540) % 360) - 180;
    return [
      a[0] + (b[0] - a[0]) * fraction,
      a[1] + lngDelta * fraction
    ];
  }

  const startWeight = Math.sin((1 - fraction) * centralAngle) / sinAngle;
  const endWeight = Math.sin(fraction * centralAngle) / sinAngle;

  const x = startWeight * Math.cos(lat1) * Math.cos(lng1) +
    endWeight * Math.cos(lat2) * Math.cos(lng2);
  const y = startWeight * Math.cos(lat1) * Math.sin(lng1) +
    endWeight * Math.cos(lat2) * Math.sin(lng2);
  const z = startWeight * Math.sin(lat1) + endWeight * Math.sin(lat2);

  return [
    toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    toDeg(Math.atan2(y, x))
  ];
}

function expandSegmentForRendering(segment) {
  const segmentDistanceKm = distanceKm(segment.a.latLng, segment.b.latLng);
  if (segmentDistanceKm <= GREAT_CIRCLE_THRESHOLD_KM) return [segment];

  const pieceCount = Math.ceil(segmentDistanceKm / GREAT_CIRCLE_MAX_CHORD_KM);
  const pieces = [];
  for (let index = 0; index < pieceCount; index += 1) {
    const startFraction = index / pieceCount;
    const endFraction = (index + 1) / pieceCount;
    const startLatLng = startFraction === 0
      ? segment.a.latLng
      : interpolateGreatCircle(segment.a.latLng, segment.b.latLng, startFraction);
    const endLatLng = endFraction === 1
      ? segment.b.latLng
      : interpolateGreatCircle(segment.a.latLng, segment.b.latLng, endFraction);

    pieces.push({
      ...segment,
      a: {
        ...segment.a,
        latLng: startLatLng,
        time: segment.a.time + (segment.b.time - segment.a.time) * startFraction
      },
      b: {
        ...segment.b,
        latLng: endLatLng,
        time: segment.a.time + (segment.b.time - segment.a.time) * endFraction
      }
    });
  }
  return pieces;
}

function expandSegmentsForRendering(segments) {
  const expanded = [];
  for (const segment of segments) {
    expanded.push(...expandSegmentForRendering(segment));
  }
  return expanded;
}

function buildInferredStitches(timelinePaths, rawPoints) {
  const MAX_STITCH_GAP_MS = 24 * 60 * 60_000;
  const observations = [];

  for (const path of timelinePaths) {
    observations.push(...path);
  }
  observations.push(...rawPoints);
  observations.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.observationKind !== b.observationKind) {
      return a.observationKind === "raw" ? -1 : 1;
    }
    return 0;
  });

  function explicitlyConnected(a, b) {
    if (a.observationKind === "timeline" &&
        b.observationKind === "timeline" &&
        a.timelinePathId === b.timelinePathId &&
        Math.abs(a.timelinePathOrder - b.timelinePathOrder) === 1) {
      return true;
    }

    if (a.observationKind === "raw" &&
        b.observationKind === "raw" &&
        Math.abs(a.rawOrder - b.rawOrder) === 1) {
      const gapMs = Math.abs(b.time - a.time);
      const jumpKm = distanceKm(a.latLng, b.latLng);
      return gapMs <= 30 * 60_000 && jumpKm <= 50;
    }

    return false;
  }

  const stitches = [];
  for (let index = 1; index < observations.length; index += 1) {
    const a = observations[index - 1];
    const b = observations[index];
    const gapMs = b.time - a.time;

    if (gapMs <= 0 || gapMs > MAX_STITCH_GAP_MS) continue;
    if (explicitlyConnected(a, b)) continue;

    const stitchDistanceKm = distanceKm(a.latLng, b.latLng);
    if (stitchDistanceKm < 0.005) continue;

    stitches.push({
      a,
      b,
      gapMs,
      distanceKm: stitchDistanceKm,
      sourceKinds: `${a.observationKind} → ${b.observationKind}`
    });
  }

  return stitches;
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

      const treatAsNormal = isAnomaly && anomalyMode === "normal";
      target.push({
        a: trace[i - 1],
        b: trace[i],
        source: isAnomaly && !treatAsNormal ? "anomaly" : source,
        anomaly: isAnomaly && !treatAsNormal ? anomalies[0] : null,
        detectedAnomaly: isAnomaly
      });
    }
  }
}

function appendStitchSegments(target, stitches, stitchMode) {
  if (stitchMode === "hide") return 0;

  const treatAsNormal = stitchMode === "normal";
  let count = 0;

  for (const stitch of stitches) {
    target.push({
      a: stitch.a,
      b: stitch.b,
      source: treatAsNormal ? "timeline" : "stitch",
      anomaly: null,
      stitch: treatAsNormal ? null : stitch,
      detectedAnomaly: false,
      detectedStitch: true
    });
    count += 1;
  }

  return count;
}

function hoverGridKey(x, y) {
  return `${x},${y}`;
}

function rebuildHoverGrid() {
  const startedAt = performance.now();
  state.hoverGrid.clear();

  let insertions = 0;
  let maxCellsPerSegment = 0;

  function addToCell(gx, gy, segment) {
    const key = hoverGridKey(gx, gy);
    const bucket = state.hoverGrid.get(key);
    if (bucket) {
      bucket.push(segment);
    } else {
      state.hoverGrid.set(key, [segment]);
    }
    insertions += 1;
  }

  for (const segment of state.renderSegments) {
    const a = map.project(segment.a.latLng, 0);
    const b = map.project(segment.b.latLng, 0);
    segment.hoverA = a;
    segment.hoverB = b;

    let gx = Math.floor(a.x / HOVER_WORLD_GRID_SIZE);
    let gy = Math.floor(a.y / HOVER_WORLD_GRID_SIZE);
    const endGx = Math.floor(b.x / HOVER_WORLD_GRID_SIZE);
    const endGy = Math.floor(b.y / HOVER_WORLD_GRID_SIZE);

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    const tDeltaX = dx === 0 ? Infinity : HOVER_WORLD_GRID_SIZE / Math.abs(dx);
    const tDeltaY = dy === 0 ? Infinity : HOVER_WORLD_GRID_SIZE / Math.abs(dy);

    let tMaxX = dx === 0
      ? Infinity
      : (((stepX > 0 ? gx + 1 : gx) * HOVER_WORLD_GRID_SIZE) - a.x) / dx;
    let tMaxY = dy === 0
      ? Infinity
      : (((stepY > 0 ? gy + 1 : gy) * HOVER_WORLD_GRID_SIZE) - a.y) / dy;

    let cellsForSegment = 0;
    while (true) {
      addToCell(gx, gy, segment);
      cellsForSegment += 1;

      if (gx === endGx && gy === endGy) break;

      if (tMaxX < tMaxY) {
        gx += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY < tMaxX) {
        gy += stepY;
        tMaxY += tDeltaY;
      } else {
        gx += stepX;
        gy += stepY;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
      }
    }

    maxCellsPerSegment = Math.max(maxCellsPerSegment, cellsForSegment);
  }

  recordPerf(
    "hover world index",
    startedAt,
    `${state.renderSegments.length.toLocaleString()} render segments, ` +
      `${insertions.toLocaleString()} insertions, ` +
      `${state.hoverGrid.size.toLocaleString()} cells, max ${maxCellsPerSegment}/segment`
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
  const worldPoint = map.project(map.containerPointToLatLng(containerPoint), 0);
  const gx = Math.floor(worldPoint.x / HOVER_WORLD_GRID_SIZE);
  const gy = Math.floor(worldPoint.y / HOVER_WORLD_GRID_SIZE);
  const hoverRadiusWorld = HOVER_RADIUS_PX / Math.pow(2, zoom);
  const cellRadius = Math.ceil(hoverRadiusWorld / HOVER_WORLD_GRID_SIZE) + 1;
  const candidates = new Set();

  for (let x = gx - cellRadius; x <= gx + cellRadius; x += 1) {
    for (let y = gy - cellRadius; y <= gy + cellRadius; y += 1) {
      for (const segment of state.hoverGrid.get(hoverGridKey(x, y)) ?? []) {
        candidates.add(segment);
      }
    }
  }

  let best = null;
  const maxDistanceSquared = hoverRadiusWorld ** 2;

  for (const segment of candidates) {
    const nearest = nearestPointOnSegment(worldPoint, segment.hoverA, segment.hoverB);
    if (nearest.distanceSquared > maxDistanceSquared) continue;
    if (best && nearest.distanceSquared >= best.distanceSquared) continue;

    const latLng = map.unproject(L.point(nearest.x, nearest.y), 0);
    const time = segment.a.time + nearest.ratio * (segment.b.time - segment.a.time);
    best = {
      distanceSquared: nearest.distanceSquared,
      latLng,
      time,
      source: segment.source,
      anomaly: segment.anomaly,
      stitch: segment.stitch
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
      : nearest.source === "stitch"
        ? "Inferred stitch"
        : "Timeline path";
  const anomalyDetail = nearest.anomaly
    ? `<br><span class="trace-tooltip-source">${nearest.anomaly.reason}</span>`
    : "";
  const stitchDetail = nearest.stitch
    ? `<br><span class="trace-tooltip-source">${nearest.stitch.sourceKinds}, ${(nearest.stitch.gapMs / 60_000).toFixed(1)} min gap, ${nearest.stitch.distanceKm.toFixed(1)} km straight-line</span>`
    : "";
  tooltip
    .setLatLng(nearest.latLng)
    .setContent(
      `<strong>${formatCoordinates(nearest.latLng)}</strong><br>` +
      `${new Date(nearest.time).toLocaleString()}<br>` +
      `<span class="trace-tooltip-source">${sourceLabel}</span>${anomalyDetail}${stitchDetail}`
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

function applyOverlayOpacity() {
  const opacity = Number(ui.overlayOpacity.value) / 100;
  ui.overlayOpacityValue.textContent = `${ui.overlayOpacity.value}%`;

  if (state.traceRenderer) {
    state.traceRenderer.canvas.style.opacity = String(opacity);
  } else if (state.pathLayer) {
    state.pathLayer.eachLayer(layer => {
      if (typeof layer.setStyle === "function") {
        layer.setStyle({ opacity, fillOpacity: opacity });
      }
    });
  }
}

function render() {
  if (state.minTime === null) return;

  const renderStartedAt = performance.now();
  const parsedRange = updateAllDateTimeParseFeedback();
  const start = parsedRange.start;
  const end = parsedRange.end;
  const anomalyMode = ui.anomalyMode.value;
  const stitchMode = ui.stitchMode.value;

  if (start === null || end === null) {
    updateStatus("Could not parse the start or end date/time.");
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

  const anomalyOnly = anomalyMode === "only";
  const stitchOnly = stitchMode === "only";
  const visibleStitches = state.inferredStitches.filter(
    stitch => stitch.a.time >= start && stitch.b.time <= end
  );

  if (ui.showPaths.checked && (!stitchOnly || anomalyOnly)) {
    stageStartedAt = performance.now();
    appendTraceSegments(state.visibleSegments, pathResult.traces, "timeline", anomalyMode);
    recordPerf("prepare timeline hover segments", stageStartedAt);
  }

  if (!anomalyOnly && !stitchOnly && ui.showRaw.checked && rawResult.traces.length) {
    stageStartedAt = performance.now();
    appendTraceSegments(state.visibleSegments, rawResult.traces, "raw");
    recordPerf("prepare raw hover segments", stageStartedAt);
  }

  if (stitchMode !== "hide" && (!anomalyOnly || stitchOnly)) {
    stageStartedAt = performance.now();
    appendStitchSegments(state.visibleSegments, visibleStitches, stitchMode);
    recordPerf(
      "prepare inferred stitches",
      stageStartedAt,
      `${visibleStitches.length.toLocaleString()} stitches`
    );
  }

  stageStartedAt = performance.now();
  state.renderSegments = expandSegmentsForRendering(state.visibleSegments);
  recordPerf(
    "prepare great-circle render geometry",
    stageStartedAt,
    `${state.visibleSegments.length.toLocaleString()} logical → ${state.renderSegments.length.toLocaleString()} render segments`
  );

  for (const segment of state.renderSegments) {
    bounds.extend(segment.a.latLng);
    bounds.extend(segment.b.latLng);
  }

  const visibleSingletonPoints =
    ui.showPaths.checked && !anomalyOnly && !stitchOnly
      ? pathResult.singletonPoints
      : [];
  for (const point of visibleSingletonPoints) {
    bounds.extend(point.latLng);
  }

  const traceRenderer = getTraceRenderer();
  if (traceRenderer) {
    traceRenderer.setData(state.renderSegments, visibleSingletonPoints);
  } else {
    const group = L.layerGroup();
    const normalPairs = state.renderSegments
      .filter(segment => segment.source === "timeline")
      .map(segment => [segment.a.latLng, segment.b.latLng]);
    const anomalyPairs = state.renderSegments
      .filter(segment => segment.source === "anomaly")
      .map(segment => [segment.a.latLng, segment.b.latLng]);
    const stitchPairs = state.renderSegments
      .filter(segment => segment.source === "stitch")
      .map(segment => [segment.a.latLng, segment.b.latLng]);
    const rawPairs = state.renderSegments
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
    if (stitchPairs.length) {
      L.polyline(stitchPairs, {
        renderer: canvasRenderer,
        weight: 3,
        opacity: 0.95,
        color: "#ff1aa6",
        dashArray: "6 4"
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

  applyOverlayOpacity();

  scheduleHoverGridRebuild();

  state.visibleBounds = bounds.isValid() ? bounds : null;

  const visibleAnomalyLegs = state.visibleSegments
    .filter(segment => segment.detectedAnomaly).length;
  const visibleStitchLegs = state.visibleSegments
    .filter(segment => segment.detectedStitch).length;

  let visiblePointCount = 0;
  if (!anomalyOnly && !stitchOnly) {
    if (ui.showPaths.checked) visiblePointCount += pathResult.visibleCount;
    if (ui.showRaw.checked) visiblePointCount += rawResult.visibleCount;
  } else {
    visiblePointCount = 2 * (visibleAnomalyLegs + visibleStitchLegs);
  }
  ui.visibleCount.textContent = visiblePointCount.toLocaleString();

  const fromText = new Date(start).toLocaleString();
  const toText = new Date(end).toLocaleString();
  updateStatus(
    `Showing ${fromText} – ${toText}. ` +
    `${visibleAnomalyLegs.toLocaleString()} potentially anomalous legs and ` +
    `${visibleStitchLegs.toLocaleString()} inferred stitches visible.`
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
  ui.startTime.value = formatFilterInput(state.minTime);
  ui.endTime.value = formatFilterInput(state.maxTime);
  updateAllDateTimeParseFeedback();
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
  state.inferredStitches = extracted.inferredStitches;
  state.anomalyCases = extracted.anomalyCases;
  state.anomalyLegCount = extracted.anomalyLegCount;
  state.minTime = extracted.minTime;
  state.maxTime = extracted.maxTime;

  ui.pathCount.textContent = state.timelinePaths.length.toLocaleString();
  ui.rawCount.textContent = state.rawPoints.length.toLocaleString();
  ui.anomalyCount.textContent =
    `${state.anomalyCases.length.toLocaleString()} cases / ${state.anomalyLegCount.toLocaleString()} legs`;
  ui.stitchCount.textContent = state.inferredStitches.length.toLocaleString();
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
    `${state.anomalyCases.length} potential anomaly cases (${state.anomalyLegCount} legs) and ` +
    `${state.inferredStitches.length.toLocaleString()} inferred stitches; both hidden by default.`
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
for (const [input, output, endOfDay] of [
  [ui.startTime, ui.startTimeParsed, false],
  [ui.endTime, ui.endTimeParsed, true]
]) {
  input.addEventListener("input", () => {
    updateDateTimeParseFeedback(input, output, endOfDay);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") render();
  });
}
ui.fullRange.addEventListener("click", () => setFullRange(true));
ui.overlayOpacity.addEventListener("input", applyOverlayOpacity);
ui.fitTraces.addEventListener("click", fitVisible);
ui.showPaths.addEventListener("change", render);
ui.showRaw.addEventListener("change", render);
ui.anomalyMode.addEventListener("change", render);
ui.stitchMode.addEventListener("change", render);

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

loadDefaultData();
