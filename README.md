# LACC Foundation Forecast

Interactive blanket-pull forecast viewer for the LACC project — the foundation
sequence drawing as the centerpiece, with hover/click for live status, editable
inputs, and an Alfred chat backed by MiniMax.

**Live**: https://dyap123.github.io/lacc-foundation/

## How it works

- **Frontend** (this repo) is static HTML/CSS/JS served by GitHub Pages.
- **Backend** is a single Google Apps Script Web App bound to the same Google
  Sheet that powers the blanket-pull forecast formulas. It:
  - reads the `Forecast` tab and returns a JSON object per section,
  - writes back the editable cells (element_type, mix, pour_date, pour_time,
    design_ambient_F, latest_concrete_F, latest_ambient_F, notes),
  - proxies MiniMax for the Alfred chat (key never leaves Google).

The single `config.json` in this repo points the frontend at the Apps Script
deployment URL.

## One-time setup (~5 min)

### 1. Deploy the Apps Script Web App

1. Open [script.google.com](https://script.google.com) → **New Project** →
   name it "LACC Foundation Backend".
2. Replace the default `Code.gs` with the contents of
   [`apps-script/Code.gs`](apps-script/Code.gs) in this repo.
3. **Project Settings → Script Properties** (gear icon → bottom of left rail):
   - `SPREADSHEET_ID` = `1WvoAMqUGnrsa1q7Ck6PZhwx5j0DD6inIKaYZZk0etCU`
   - `MINIMAX_API_KEY` = your MiniMax API key
   - `MINIMAX_MODEL` = `MiniMax-M2.7` (optional)
4. **Deploy → New Deployment**:
   - Type: **Web app**
   - Description: anything
   - Execute as: **Me**
   - Who has access: **Anyone**  *(or "Anyone with Google account" if you want
     a soft access wall — your call)*
5. Click **Deploy**, authorize when prompted (it will ask for Sheets +
   external-fetch permission). Copy the deployment URL — looks like
   `https://script.google.com/macros/s/AKfy.../exec`.

### 2. Wire the URL into the frontend

Edit [`config.json`](config.json):

```json
{
  "backend": "https://script.google.com/macros/s/AKfy.../exec",
  "spreadsheet_id": "1WvoAMqUGnrsa1q7Ck6PZhwx5j0DD6inIKaYZZk0etCU"
}
```

Commit + push. GitHub Pages picks it up within ~30 seconds.

### 3. (Re-)deploys

When you change `Code.gs`, you must **Deploy → Manage deployments → pencil icon
→ Version: New version → Deploy** for the new code to take effect. Apps Script
does NOT auto-deploy.

## Using it

- Hover any colored region → tooltip with status, pour date, predicted pull
  date, days remaining.
- Click a region → side panel slides in.
  - **Editable**: element_type (dropdown), mix, pour_date (date picker),
    pour_time (time picker), design_ambient_F, latest_concrete_F,
    latest_ambient_F, notes. **Save** writes back to the sheet.
  - **Read-only**: all formula columns (k, T_peak, t_peak, predicted pull
    datetime, hours remaining, etc.).
- Floating chat button (bottom-right) opens Alfred. The page injects the live
  state of every section into each prompt so MiniMax can answer questions like
  "is 1A ready?" or "which section is closest to ready?" without needing
  server-side tool calls.
- The data refreshes every 60 seconds in the background.

## Refining the polygon shapes

The shapes in `foundation_areas.json` are rectangle bounding boxes for v1.
Edit the `polygon` arrays (image-pixel coordinates, image is 3278 × 3541) to
match the irregular outlines of each sequence area. Commit + push, no Apps
Script redeploy needed.

## Files

| Path | Purpose |
|---|---|
| `index.html` | Page shell (toolbar, canvas, side panel, Alfred panel) |
| `foundation.css` | Dark Stripe-style minimal palette |
| `foundation.js` | Loads polygons, draws SVG overlay, handles hover/click/save/Alfred |
| `foundation_sequence.png` | Pre-rendered foundation drawing (3278 × 3541) |
| `foundation_areas.json` | Polygon coordinates per section_id |
| `config.json` | Apps Script deployment URL — fill in after deploy |
| `apps-script/Code.gs` | Backend: paste into a new Apps Script project |

## Re-rendering the drawing

The `foundation_sequence.png` was rendered once from the source PDF using
PyMuPDF. If the source drawing updates, re-run the render script in the
sister repo `~/const-agent/`:

```
cd ~/const-agent
.venv/bin/python -m scripts.render_foundation_image \
    --pdf "/path/to/new.pdf" \
    --out ~/lacc-foundation/foundation_sequence.png \
    --dpi 100
```

Then commit + push the new PNG.

## Source spreadsheet

[LACC Blanket-Pull Forecast](https://docs.google.com/spreadsheets/d/1WvoAMqUGnrsa1q7Ck6PZhwx5j0DD6inIKaYZZk0etCU/edit)

Tabs:
- **Forecast** — the data this page edits.
- **Calibration** — Newton's-cooling parameters per (element_type, mix).
- **Methodology** — equation derivation + chart.
- **Area Charts** — per-section concrete-cooling forecasts.
- **CUP Area A — Reference** — observed-vs-fit for the calibration sensor.
- **Sequence Map** — section ID → sequence/area lookup.
