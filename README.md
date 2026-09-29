# Google Timeline Viewer

A small local web viewer for the current Google Maps Timeline JSON export format.

It displays timestamped Timeline path data and raw location positions over OpenStreetMap tiles using Leaflet, with filtering by start/end date and time.

## Run

The repository intentionally does not commit personal Timeline data.

1. Put an export at `data/Timeline.json` (already done in this local checkout), or use the file picker in the UI.
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

- `semanticSegments[].timelinePath`: rendered as Timeline traces; overlapping trace pixels accumulate into a WebGL density map (blue for one traversal, red around four, yellow around sixteen, cream around thirty-two, and white around sixty-four or more). Single-point path segments are shown as small points.
- `rawSignals[].position`: sorted by timestamp and joined into dashed traces when consecutive records are no more than 30 minutes and 50 km apart. Raw traces are drawn separately and do not contribute to Timeline density.
- Activity start/end coordinates are deliberately not connected because some records span long periods or long-distance travel and would create misleading straight lines.

## Filtering

Use the **From** and **To** date/time controls and press **Apply filter**. **Full range** restores the complete range found in the loaded export.

Date/time inputs are interpreted in the browser's local timezone. Timeline timestamps themselves are parsed from the offsets stored in the Google export.
