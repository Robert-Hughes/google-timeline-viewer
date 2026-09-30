const fs = require("fs");
const path = require("path");
const https = require("https");

const root = __dirname;
const outputPath = path.join(root, "google-timeline-viewer-offline.html");
const leafletBase = "https://unpkg.com/leaflet@1.9.4/dist/";
const leafletCssUrl = leafletBase + "leaflet.css";
const leafletJsUrl = leafletBase + "leaflet.js";

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(fetchBuffer(new URL(response.headers.location, url).href));
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        response.resume();
        return;
      }
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

function mimeForUrl(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return ({
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  })[ext] || "application/octet-stream";
}

async function inlineLeafletCssAssets(css) {
  const matches = [...css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)];
  const replacements = new Map();
  for (const match of matches) {
    const asset = match[2];
    if (/^(?:data:|https?:|#)/i.test(asset)) continue;
    const assetUrl = new URL(asset, leafletCssUrl).href;
    if (!replacements.has(asset)) {
      const bytes = await fetchBuffer(assetUrl);
      replacements.set(asset, `data:${mimeForUrl(assetUrl)};base64,${bytes.toString("base64")}`);
    }
  }
  for (const [asset, dataUri] of replacements) {
    css = css.split(asset).join(dataUri);
  }
  return css;
}

async function main() {
  let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const localCss = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  let appJs = fs.readFileSync(path.join(root, "app.js"), "utf8");
  let leafletCss = (await fetchBuffer(leafletCssUrl)).toString("utf8");
  const leafletJs = (await fetchBuffer(leafletJsUrl)).toString("utf8");

  leafletCss = await inlineLeafletCssAssets(leafletCss);

  html = html.replace(
    /\s*<link rel="stylesheet" href="https:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.css"[\s\S]*?crossorigin="">/,
    "\n  <style>\n" + leafletCss + "\n" + localCss + "\n  </style>"
  );
  html = html.replace(/\s*<link rel="stylesheet" href="styles\.css">/, "");
  html = html.replace(
    '<button id="load-default" type="button">Load local data/Timeline.json</button>',
    '<button id="load-default" type="button" hidden>Load local data/Timeline.json</button>'
  );
  html = html.replace(
    "Loading local Timeline export…",
    "Choose a Timeline JSON file above."
  );

  appJs = appJs.replace(
    /\nloadDefaultData\(\);\s*$/,
    '\nupdateStatus("Choose a Timeline JSON file above.");\n'
  );

  const safeLeafletJs = leafletJs.replace(/<\/script/gi, "<\\/script");
  const safeAppJs = appJs.replace(/<\/script/gi, "<\\/script");
  html = html.replace(
    /\s*<script src="https:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.js"[\s\S]*?crossorigin=""><\/script>\s*<script src="app\.js"><\/script>/,
    "\n  <script>\n" + safeLeafletJs + "\n  </script>\n  <script>\n" + safeAppJs + "\n  </script>"
  );

  fs.writeFileSync(outputPath, html);
  console.log(`Wrote ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KiB)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
