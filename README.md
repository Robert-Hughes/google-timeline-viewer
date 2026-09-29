# Google Timeline Viewer

A small local web viewer for the current Google Maps Timeline JSON export format.

It displays timestamped Timeline path data and raw location positions over OpenStreetMap tiles using Leaflet, with filtering by start/end date and time.

## Run

The repository intentionally does not commit personal Timeline data.

1. Put an export at `data/Timeline.json`, or use the file picker in the UI.
2. Run:

   ```powershell
   npm start
   ```

3. Open <http://localhost:8080>.

The app automatically tries to load `data/Timeline.json`. If it is absent, use the Timeline JSON file picker.

## Data handling

All Timeline parsing and filtering happens in the browser. The included server only serves local static files. The app does not upload Timeline data anywhere.

The map background uses OpenStreetMap tiles, so viewing the map requires network access to OpenStreetMap. Leaflet is loaded from unpkg.

## What is rendered

- `semanticSegments[].timelinePath`: rendered as Timeline traces; overlapping trace pixels accumulate into a WebGL density map using a logarithmic blue → red → yellow scale stretched across roughly one to sixty-four traversals. Single-point path segments are shown as small points.
- `rawSignals[].position`: sorted by timestamp and joined into dashed traces when consecutive records are no more than 30 minutes and 50 km apart. Raw traces are drawn separately and do not contribute to Timeline density.
- Activity start/end coordinates are deliberately not connected because some records span long periods or long-distance travel and would create misleading straight lines.
- The **Overlay opacity** slider changes the opacity of the Timeline/Raw WebGL overlay without rebuilding trace geometry.

## Filtering

Enter **From** and **To** as ordinary text and press **Apply filter** (or Enter). Accepted forms include ISO-style dates, UK numeric dates such as `29/09/2026 14:30`, month names such as `29 Sep 2026 2:30pm`, and `today`, `yesterday`, `tomorrow`, or `now`. A date without a time means the start of that day for **From** and the end of that day for **To**. **Full range** restores the complete range found in the loaded export.

Dates without an explicit timezone are interpreted in the browser's local timezone. Timeline timestamps themselves are parsed from the offsets stored in the Google export.