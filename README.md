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
- Potential anomalies include implausible legs, short-lived within-path spatial spikes, and isolated observations that are far from both temporal neighbours while the neighbours agree geographically and a strong overlapping visit contradicts the isolated point. Isolated anomalous observations are excluded from inferred-stitch adjacency.
- **Inferred stitches** connect consecutive known Timeline/raw observations when no existing trace already connects them and the gap is no more than 24 hours. They are hidden by default. The selector can highlight them, treat them exactly like normal Timeline traces (including density accumulation), or isolate only the inferred stitches.
- Any displayed leg longer than 100 km (Google Timeline or inferred stitch) is rendered along the shortest great-circle route, tessellated into chords of at most roughly 100 km. This is derived display/hover geometry only; the source observations and logical leg counts are unchanged.
- Activity start/end coordinates are deliberately not connected because some records span long periods or long-distance travel and would create misleading direct connections.
- The **Overlay opacity** slider changes the opacity of the Timeline/Raw/stitch WebGL overlay without rebuilding trace geometry.

## Filtering

Enter **From** and **To** as ordinary text and press **Apply filter** (or Enter). The parser accepts flexible ordering and many common forms, including `10pm Sat 14 Oct 2017`, `Sat 14 Oct 2017 10pm`, `2200 Sat 14 Oct 2017`, `22:00 Sat 14 Oct 2017`, ISO-style dates, UK numeric dates such as `14/10/2017 22:00`, month-name dates, `today`, `yesterday`, `tomorrow`, `now`, `noon`, and `midnight`. Weekday names and ordinal suffixes are tolerated, compact HHMM times are accepted, and a bare time is interpreted as today. A date without a time means the start of that day for **From** and the end of that day for **To**. The parsed interpretation is displayed underneath each input; failed parsing is shown with a red outline. **Full range** restores the complete range found in the loaded export.

Dates without an explicit timezone are interpreted in the browser's local timezone. Timeline timestamps themselves are parsed from the offsets stored in the Google export.