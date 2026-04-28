// LACC Foundation Forecast — Apps Script backend
// Acts as the backend for the GitHub Pages frontend. Deploy as a Web App.
//
// Setup:
//   1. Open script.google.com → New Project, name it "LACC Foundation Backend".
//   2. Replace Code.gs contents with this file.
//   3. In Project Settings → Script Properties:
//        SPREADSHEET_ID = 1WvoAMqUGnrsa1q7Ck6PZhwx5j0DD6inIKaYZZk0etCU
//        MINIMAX_API_KEY = sk-...
//        MINIMAX_MODEL   = MiniMax-M2.7   (optional; defaults to this)
//   4. Deploy → New Deployment → Type: Web App
//        Execute as: Me
//        Who has access: Anyone (or "Anyone with Google Account" — your call)
//   5. Authorize when prompted. Copy the /exec URL.
//   6. Paste the URL into config.json on the GitHub Pages repo, push.

const FORECAST_SHEET = 'Forecast';
const FORECAST_HEADERS = [
  'section_id', 'element_type', 'mix',
  'pour_date', 'pour_time',
  'design_ambient_F', 'latest_concrete_F', 'latest_ambient_F',
  'hours_since_pour', 'current_delta_F',
  'k_per_hr', 'T_peak_F', 't_peak_hrs',
  'predicted_t_pull_hrs', 'predicted_pull_datetime',
  'hours_remaining', 'indicator', 'notes',
];
// Map editable field → A1 column letter (must match the Forecast tab layout)
const EDITABLE_COLS = {
  element_type: 'B', mix: 'C',
  pour_date: 'D', pour_time: 'E',
  design_ambient_F: 'F',
  latest_concrete_F: 'G', latest_ambient_F: 'H',
  notes: 'R',
};

// ── HTTP entry points ──────────────────────────────────────────────────────

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'metrics';
  if (action === 'metrics') return _json(handleMetrics_());
  if (action === 'areas')   return _json({ok: true, hint: 'foundation_areas.json is served by GitHub Pages'});
  return _json({error: 'unknown action: ' + action});
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents || '{}');
  const action = body.action || '';
  try {
    if (action === 'update') return _json(handleUpdate_(body));
    if (action === 'alfred') return _json(handleAlfred_(body));
    if (action === 'metrics') return _json(handleMetrics_());
    return _json({error: 'unknown action: ' + action});
  } catch (err) {
    return _json({error: String(err && err.message || err)});
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────

function handleMetrics_() {
  const ss = _ss_();
  const sheet = ss.getSheetByName(FORECAST_SHEET);
  if (!sheet) return {error: 'Forecast sheet not found', by_section: {}};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {by_section: {}, columns: FORECAST_HEADERS};

  // FORMATTED_VALUE so dates/times are human-readable strings
  const values = sheet.getRange(2, 1, lastRow - 1, FORECAST_HEADERS.length)
                       .getDisplayValues();
  const bySection = {};
  values.forEach(function (row) {
    const sid = String(row[0] || '').trim();
    if (!sid) return;
    const obj = {};
    FORECAST_HEADERS.forEach(function (h, i) { obj[h] = row[i]; });
    bySection[sid] = obj;
  });
  return {by_section: bySection, columns: FORECAST_HEADERS};
}

function handleUpdate_(body) {
  const sectionId = String(body.section_id || '').trim();
  const fields = body.fields || {};
  if (!sectionId) return {error: 'section_id required'};
  const badKeys = Object.keys(fields).filter(function (k) { return !(k in EDITABLE_COLS); });
  if (badKeys.length) return {error: 'non-editable fields: ' + badKeys.join(',')};

  const ss = _ss_();
  const sheet = ss.getSheetByName(FORECAST_SHEET);
  if (!sheet) return {error: 'Forecast sheet not found'};

  // Find the row by section_id (column A)
  const lastRow = sheet.getLastRow();
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let rowIdx = -1;
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === sectionId) { rowIdx = i + 2; break; }
  }
  if (rowIdx < 0) return {error: 'section_id not found: ' + sectionId};

  // Apply each field
  Object.keys(fields).forEach(function (key) {
    const col = EDITABLE_COLS[key];
    const val = fields[key];
    sheet.getRange(col + rowIdx).setValue(val === '' ? '' : val);
  });
  SpreadsheetApp.flush();

  // Return refreshed row
  const row = sheet.getRange(rowIdx, 1, 1, FORECAST_HEADERS.length).getDisplayValues()[0];
  const rowObj = {};
  FORECAST_HEADERS.forEach(function (h, i) { rowObj[h] = row[i]; });
  return {ok: true, section_id: sectionId, row: rowIdx, row_data: rowObj};
}

function handleAlfred_(body) {
  const userMessage = String(body.message || '').trim();
  if (!userMessage) return {error: 'message required'};
  const apiKey = PropertiesService.getScriptProperties().getProperty('MINIMAX_API_KEY');
  if (!apiKey) return {error: 'MINIMAX_API_KEY not set in Script Properties'};
  const model = PropertiesService.getScriptProperties().getProperty('MINIMAX_MODEL')
                || 'MiniMax-M2.7';

  // Build a context line so MiniMax can answer questions about specific
  // sections without needing tool calls. The Pages frontend ships the latest
  // metrics in the request body so we don't have to refetch.
  const sections = body.sections || {};
  const selected = body.selected_section || '';
  const summaryLines = Object.keys(sections).sort().map(function (sid) {
    const r = sections[sid] || {};
    return '- ' + sid +
           ': status=' + (r.indicator || '') +
           '; pour=' + (r.pour_date || 'TBD') + ' ' + (r.pour_time || '') +
           '; predicted_pull=' + (r.predicted_pull_datetime || 'TBD') +
           '; hours_remaining=' + (r.hours_remaining || '');
  });

  const systemPrompt =
    'You are Alfred, a concise concrete-curing assistant. Use the live ' +
    'foundation forecast state below to answer questions about LACC pours. ' +
    'Be direct: state the date or duration plainly, no preamble. The user is ' +
    'currently looking at the Foundation Map page' +
    (selected ? ' and has section ' + selected + ' selected.' : '.') + '\n\n' +
    'Live state:\n' + summaryLines.join('\n');

  const payload = {
    model: model,
    messages: [
      {role: 'system', content: systemPrompt},
      {role: 'user',   content: userMessage},
    ],
    max_tokens: 600,
  };

  const resp = UrlFetchApp.fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
    method: 'post',
    contentType: 'application/json',
    headers: {Authorization: 'Bearer ' + apiKey},
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const status = resp.getResponseCode();
  const text = resp.getContentText();
  if (status >= 400) return {error: 'MiniMax error ' + status + ': ' + text.substring(0, 500)};
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return {error: 'bad JSON from MiniMax'}; }
  const reply = (parsed.choices && parsed.choices[0] && parsed.choices[0].message
                  && parsed.choices[0].message.content) || '';
  return {reply: reply, model: model};
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID not set in Script Properties');
  return SpreadsheetApp.openById(id);
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
