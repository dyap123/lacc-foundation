// foundation.js — GitHub Pages version. Backend is a Google Apps Script Web
// App that reads/writes the Forecast tab and proxies MiniMax for Alfred.
//
// Configure: edit config.json with your Apps Script Web App URL.
//
//   { "backend": "https://script.google.com/macros/s/.../exec",
//     "spreadsheet_id": "1Wvo..." }

(function () {
  'use strict';

  const STATUS_COLOR = {
    'READY':                {fill: '#22c55e', stroke: '#15803d'},
    'PREDICTED READY':      {fill: '#22c55e', stroke: '#15803d'},
    'MONITORING':           {fill: '#f59e0b', stroke: '#b45309'},
    'TEMP OK — UNDER 72H FROM PEAK': {fill: '#f59e0b', stroke: '#b45309'},
    'TEMP OK — NO CALIBRATION':      {fill: '#f59e0b', stroke: '#b45309'},
    'MONITORING (concrete still hot)': {fill: '#f59e0b', stroke: '#b45309'},
    'MONITORING (no live data)':       {fill: '#f59e0b', stroke: '#b45309'},
    'NEEDS POUR DATE':      {fill: '#ef4444', stroke: '#b91c1c'},
    'NEEDS POUR DATETIME':  {fill: '#ef4444', stroke: '#b91c1c'},
  };
  const READONLY_FILL = '#64748b';
  const POLL_MS = 60_000;

  const state = {
    config: null,
    canvas: null,
    grid: null,
    areas: [],
    pathOfTravel: [],
    metricsBySection: {},
    selectedSection: null,
    pollTimer: null,
    alfBuffer: '',
  };

  const $ = (id) => document.getElementById(id);

  function statusColors(indicator) {
    if (!indicator) return STATUS_COLOR['NEEDS POUR DATE'];
    return STATUS_COLOR[indicator] || STATUS_COLOR['MONITORING'];
  }
  function indicatorBadgeStyle(indicator) {
    const c = statusColors(indicator);
    return `background:${c.fill}22;color:${c.stroke};border:1px solid ${c.fill}55`;
  }

  // ── Backend helpers ────────────────────────────────────────────────────
  async function backendGet(action) {
    if (!state.config || !state.config.backend) {
      throw new Error('Backend not configured');
    }
    const url = state.config.backend + '?action=' + encodeURIComponent(action);
    const r = await fetch(url, {method: 'GET'});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function backendPost(action, payload) {
    if (!state.config || !state.config.backend) {
      throw new Error('Backend not configured');
    }
    // Apps Script Web Apps require POST as text/plain to avoid the CORS preflight.
    const r = await fetch(state.config.backend, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify({action, ...payload}),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ── Init / loading ─────────────────────────────────────────────────────
  async function init() {
    try {
      const [config, areasResp] = await Promise.all([
        fetch('config.json').then(r => r.json()).catch(() => ({})),
        fetch('foundation_areas.json').then(r => r.json()),
      ]);
      state.config = config;
      state.canvas = areasResp._canvas || {width: 1600, height: 1400, background: '#0b1220'};
      state.grid = areasResp._grid || null;
      state.areas = areasResp.areas || [];
      state.pathOfTravel = areasResp._path_of_travel || [];
      // Hide the legacy <img> tag — we render a fully synthesized site plan.
      const img = $('fndImage');
      if (img) img.style.display = 'none';
      renderSitePlan();

      if (!state.config || !state.config.backend ||
          state.config.backend.indexOf('PASTE_YOUR_APPS_SCRIPT_URL') !== -1) {
        $('fndConfigBanner').style.display = 'block';
        return;
      }
      await refresh(true);
      startPolling();
    } catch (err) {
      console.error('foundation init failed', err);
      $('fndCanvasWrap').classList.add('fnd-error');
      $('fndCanvasWrap').textContent = 'Failed to load foundation map: ' + err;
    }
  }

  // ── SVG site plan ──────────────────────────────────────────────────────
  // Builds a clean, schematic top-down site plan from foundation_areas.json
  // (no PDF screenshot). Each interactive sequence is a polygon whose fill
  // reflects the current status; outline preserves the source-drawing color.
  function renderSitePlan() {
    const svg = $('fndOverlay');
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const W = state.canvas.width;
    const H = state.canvas.height;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.width = '100%';
    svg.style.height = '100%';
    // Make the SVG occupy the canvas cleanly (no <img> behind it).
    const wrap = $('fndCanvas');
    if (wrap) {
      wrap.style.width = '100%';
      wrap.style.height = '100%';
      wrap.style.minHeight = '0';
    }

    // Background
    const bg = svgEl('rect', {x: 0, y: 0, width: W, height: H, fill: state.canvas.background});
    svg.appendChild(bg);

    // Subtle dot grid
    const grid = svgEl('g', {});
    for (let x = 100; x < W; x += 100) {
      for (let y = 100; y < H; y += 100) {
        const d = svgEl('circle', {cx: x, cy: y, r: 1.2, fill: '#1e293b'});
        grid.appendChild(d);
      }
    }
    svg.appendChild(grid);

    // Title
    if (state.canvas.title) {
      svg.appendChild(svgEl('text', {
        x: 60, y: 32, fill: '#e2e8f0', 'font-size': 22, 'font-weight': 700,
      }, state.canvas.title));
    }

    // North arrow (top-right)
    if (state.canvas.north_arrow) {
      const na = state.canvas.north_arrow;
      const g = svgEl('g', {transform: `translate(${na.x},${na.y})`});
      g.appendChild(svgEl('circle', {r: 28, fill: 'none', stroke: '#475569', 'stroke-width': 1.5}));
      g.appendChild(svgEl('polygon', {points: '0,-26 -8,8 0,2 8,8', fill: '#cbd5e1'}));
      g.appendChild(svgEl('text', {y: -32, 'text-anchor': 'middle', fill: '#94a3b8',
                                     'font-size': 11, 'font-weight': 600}, 'N'));
      svg.appendChild(g);
    }

    // Path of travel (dashed connector)
    if (state.pathOfTravel && state.pathOfTravel.length > 1) {
      const d = state.pathOfTravel.map((p, i) =>
        (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ');
      svg.appendChild(svgEl('path', {
        d: d, stroke: '#334155', 'stroke-width': 6, fill: 'none',
        'stroke-dasharray': '14 10', 'stroke-linecap': 'round',
      }));
    }

    // Areas — drawn in order; non-interactive (already-poured) first
    const sorted = state.areas.slice().sort((a, b) =>
      (a.interactive ? 1 : 0) - (b.interactive ? 1 : 0));
    sorted.forEach((area) => drawArea(svg, area));

    // Legend bottom-left
    drawLegend(svg, 60, H - 110);
  }

  function svgEl(name, attrs, text) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, attrs[k]));
    if (text != null) el.textContent = text;
    return el;
  }

  function drawArea(svg, area) {
    const points = area.polygon.map(p => p.join(',')).join(' ');
    const indicator = (state.metricsBySection[area.section_id] || {}).indicator
                       || 'NEEDS POUR DATE';
    const c = area.interactive
      ? statusColors(indicator)
      : {fill: READONLY_FILL, stroke: area.outline_color || READONLY_FILL};

    // Translucent fill polygon (interactive)
    const poly = svgEl('polygon', {
      points: points,
      fill: c.fill,
      'fill-opacity': area.interactive ? 0.22 : 0.10,
      stroke: area.outline_color || c.stroke,
      'stroke-width': 3,
      'stroke-linejoin': 'round',
      'data-section': area.section_id,
    });
    if (!area.interactive) poly.classList.add('fnd-readonly');
    if (area.interactive) {
      poly.addEventListener('mousemove', (e) => showTooltip(e, area));
      poly.addEventListener('mouseleave', hideTooltip);
      poly.addEventListener('click', () => openPanel(area.section_id));
    }
    svg.appendChild(poly);

    // Centroid label (section_id, large)
    const cx = area.polygon.reduce((s, p) => s + p[0], 0) / area.polygon.length;
    const cy = area.polygon.reduce((s, p) => s + p[1], 0) / area.polygon.length;
    const off = area.label_offset || [0, 0];
    const labelText = (area.section_id === '0' || area.section_id === '4')
      ? 'Zone ' + area.section_id : area.section_id;
    svg.appendChild(svgEl('text', {
      x: cx + off[0],
      y: cy + off[1],
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      fill: area.interactive ? '#f8fafc' : '#94a3b8',
      stroke: '#0b1220', 'stroke-width': 5, 'paint-order': 'stroke',
      'font-size': area.interactive ? 64 : 38,
      'font-weight': 800,
      'font-family': 'system-ui, sans-serif',
      'pointer-events': 'none',
    }, labelText));

    // Section label below the section_id (small italic)
    if (area.label && area.interactive) {
      svg.appendChild(svgEl('text', {
        x: cx + off[0],
        y: cy + off[1] + 50,
        'text-anchor': 'middle',
        fill: '#94a3b8',
        'font-size': 14,
        'font-weight': 500,
        'pointer-events': 'none',
      }, area.label));
    }
    if (area.annotation) {
      svg.appendChild(svgEl('text', {
        x: cx + off[0],
        y: cy + off[1] + 50,
        'text-anchor': 'middle',
        fill: '#86efac',
        'font-size': 14,
        'font-style': 'italic',
        'pointer-events': 'none',
      }, area.annotation));
    }

    // Phase markers
    if (area.phases) {
      area.phases.forEach((p) => {
        svg.appendChild(svgEl('text', {
          x: p.anchor[0],
          y: p.anchor[1],
          'text-anchor': 'middle',
          fill: '#cbd5e1',
          stroke: '#0b1220', 'stroke-width': 3, 'paint-order': 'stroke',
          'font-size': 18,
          'font-weight': 600,
          'pointer-events': 'none',
        }, p.id));
      });
    }
  }

  function drawLegend(svg, x, y) {
    const items = [
      ['#22c55e', 'READY'],
      ['#f59e0b', 'MONITORING'],
      ['#ef4444', 'NEEDS POUR DATE'],
      ['#64748b', 'ALREADY POURED'],
    ];
    const g = svgEl('g', {transform: `translate(${x},${y})`});
    g.appendChild(svgEl('rect', {x: -10, y: -22, width: 290, height: 100,
      rx: 8, fill: '#0f172a', 'fill-opacity': 0.7,
      stroke: '#1e293b', 'stroke-width': 1}));
    g.appendChild(svgEl('text', {x: 0, y: -2, fill: '#cbd5e1',
      'font-size': 11, 'font-weight': 700, 'letter-spacing': 1.2}, 'LEGEND'));
    items.forEach((it, i) => {
      const yy = 18 + i * 18;
      g.appendChild(svgEl('rect', {x: 0, y: yy - 8, width: 16, height: 10, rx: 2,
        fill: it[0], 'fill-opacity': 0.65, stroke: it[0], 'stroke-width': 1}));
      g.appendChild(svgEl('text', {x: 24, y: yy, fill: '#e2e8f0',
        'font-size': 11}, it[1]));
    });
    svg.appendChild(g);
  }

  function recolorAreas() {
    document.querySelectorAll('#fndOverlay polygon[data-section]').forEach((poly) => {
      const sid = poly.getAttribute('data-section');
      const area = state.areas.find(a => a.section_id === sid);
      if (!area) return;
      const indicator = (state.metricsBySection[sid] || {}).indicator
                         || 'NEEDS POUR DATE';
      const c = area.interactive
        ? statusColors(indicator)
        : {fill: READONLY_FILL, stroke: area.outline_color || READONLY_FILL};
      poly.setAttribute('fill', c.fill);
      poly.setAttribute('stroke', area.outline_color || c.stroke);
    });
  }

  function updateStats() {
    let tot = 0, ready = 0, mon = 0, need = 0;
    state.areas.forEach((a) => {
      if (!a.interactive) return;
      tot++;
      const ind = (state.metricsBySection[a.section_id] || {}).indicator || 'NEEDS POUR DATE';
      if (ind.includes('READY')) ready++;
      else if (ind.includes('NEEDS')) need++;
      else mon++;
    });
    $('fndStatTot').textContent = tot;
    $('fndStatReady').textContent = ready;
    $('fndStatMon').textContent = mon;
    $('fndStatNeed').textContent = need;
  }

  // ── Tooltip ────────────────────────────────────────────────────────────
  function showTooltip(evt, area) {
    const tt = $('fndTooltip');
    const row = state.metricsBySection[area.section_id] || {};
    const indicator = row.indicator || 'NEEDS POUR DATE';
    const pour = row.pour_date ? `${row.pour_date} ${row.pour_time || ''}`.trim() : 'TBD';
    const pull = row.predicted_pull_datetime || 'TBD';
    const remaining = row.hours_remaining
      ? `${(parseFloat(row.hours_remaining) / 24).toFixed(1)} d` : 'TBD';
    const delta = (row.current_delta_F !== '' && row.current_delta_F != null)
      ? `${row.current_delta_F} °F` : '—';
    tt.innerHTML = `
      <h4>${area.section_id} · ${area.label || ''}</h4>
      <div><span class="fnd-pill" style="${indicatorBadgeStyle(indicator)}">${indicator}</span></div>
      <div class="fnd-row"><span>Pour</span><span>${pour}</span></div>
      <div class="fnd-row"><span>Predicted pull</span><span>${pull}</span></div>
      <div class="fnd-row"><span>Days remaining</span><span>${remaining}</span></div>
      <div class="fnd-row"><span>Current Δ</span><span>${delta}</span></div>`;
    tt.style.display = 'block';
    const x = Math.min(evt.clientX + 16, window.innerWidth - 300);
    const y = Math.min(evt.clientY + 16, window.innerHeight - 180);
    tt.style.left = x + 'px';
    tt.style.top = y + 'px';
  }
  function hideTooltip() { $('fndTooltip').style.display = 'none'; }

  // ── Side panel ─────────────────────────────────────────────────────────
  function openPanel(sectionId) {
    state.selectedSection = sectionId;
    const row = state.metricsBySection[sectionId] || {};
    const area = state.areas.find(a => a.section_id === sectionId);
    if (!area) return;
    $('fndPanelTitle').textContent = `${sectionId} · ${area.label || ''}`;
    const indicator = row.indicator || 'NEEDS POUR DATE';
    const status = $('fndPanelStatus');
    status.textContent = indicator;
    status.style.cssText = indicatorBadgeStyle(indicator);

    const editable = ['element_type', 'mix', 'pour_date', 'pour_time',
                       'design_ambient_F', 'latest_concrete_F',
                       'latest_ambient_F', 'notes'];
    const readout = ['hours_since_pour', 'current_delta_F', 'k_per_hr',
                      'T_peak_F', 't_peak_hrs', 'predicted_t_pull_hrs',
                      'predicted_pull_datetime', 'hours_remaining'];
    const elemOptions = ['Deep Foundation', 'Pile Cap', 'Grade Beam',
                          'Slab on Grade', 'Wall', 'Column', 'Footing'];

    const html = [];
    html.push('<div class="fnd-section">');
    html.push('<div class="fnd-section-title">User inputs (editable)</div>');
    editable.forEach((key) => {
      const val = (row[key] != null ? row[key] : '');
      let inputHtml;
      if (key === 'element_type') {
        inputHtml = `<select id="fnd_${key}">${
          elemOptions.map(o => `<option value="${o}"${o === val ? ' selected' : ''}>${o}</option>`).join('')
        }</select>`;
      } else if (key === 'pour_date') {
        inputHtml = `<input id="fnd_${key}" type="date" value="${normalizeDate(val)}">`;
      } else if (key === 'pour_time') {
        inputHtml = `<input id="fnd_${key}" type="time" value="${normalizeTime(val)}">`;
      } else if (key.endsWith('_F')) {
        inputHtml = `<input id="fnd_${key}" type="number" step="0.1" value="${val}">`;
      } else {
        inputHtml = `<input id="fnd_${key}" type="text" value="${escapeHtml(val)}">`;
      }
      html.push(`<div class="fnd-field"><label>${prettyLabel(key)}</label>${inputHtml}</div>`);
    });
    html.push('</div>');

    html.push('<div class="fnd-section">');
    html.push('<div class="fnd-section-title">Computed (read-only)</div>');
    readout.forEach((key) => {
      const val = (row[key] != null && row[key] !== '' ? row[key] : '—');
      html.push(`<div class="fnd-readout"><span>${prettyLabel(key)}</span><span>${escapeHtml(String(val))}</span></div>`);
    });
    html.push('</div>');

    $('fndPanelBody').innerHTML = html.join('');
    $('fndPanel').classList.add('fnd-open');
    document.querySelectorAll('#fndOverlay polygon').forEach((p) => {
      p.classList.toggle('fnd-selected', p.getAttribute('data-section') === sectionId);
    });
  }

  function closePanel() {
    state.selectedSection = null;
    $('fndPanel').classList.remove('fnd-open');
    document.querySelectorAll('#fndOverlay polygon').forEach((p) => {
      p.classList.remove('fnd-selected');
    });
  }

  function prettyLabel(key) {
    return key.replace(/_/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase());
  }
  function normalizeDate(v) {
    if (!v) return '';
    const m = String(v).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const m2 = String(v).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m2) return `${m2[3]}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
    return '';
  }
  function normalizeTime(v) {
    if (!v) return '';
    const s = String(v).trim();
    const m = s.match(/(\d{1,2}):(\d{2})(:\d{2})?\s*(AM|PM)?/i);
    if (!m) return '';
    let h = parseInt(m[1], 10);
    const mm = m[2];
    const ampm = (m[4] || '').toUpperCase();
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + mm;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Save ───────────────────────────────────────────────────────────────
  async function save() {
    if (!state.selectedSection) return;
    const fields = {};
    ['element_type', 'mix', 'pour_date', 'pour_time',
     'design_ambient_F', 'latest_concrete_F',
     'latest_ambient_F', 'notes'].forEach((k) => {
      const el = $('fnd_' + k);
      if (!el) return;
      let v = el.value;
      if (el.type === 'number' && v === '') v = '';
      fields[k] = v;
    });
    const btn = $('fndSaveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const j = await backendPost('update', {section_id: state.selectedSection, fields});
      if (j.error) throw new Error(j.error);
      if (j.row_data) state.metricsBySection[state.selectedSection] = j.row_data;
      else await refresh(true);
      recolorAreas(); updateStats(); openPanel(state.selectedSection);
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1200);
    } catch (err) {
      console.error('save failed', err);
      btn.textContent = 'Save failed';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 2000);
    }
  }

  // ── Polling ────────────────────────────────────────────────────────────
  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => refresh(false), POLL_MS);
  }
  async function refresh(force) {
    try {
      const j = await backendGet('metrics');
      state.metricsBySection = (j && j.by_section) || {};
      recolorAreas(); updateStats();
      if (state.selectedSection && force) openPanel(state.selectedSection);
    } catch (err) {
      console.warn('refresh failed', err);
    }
  }

  // ── Alfred chat (HTTP, not WebSocket) ──────────────────────────────────
  function toggleAlfred(force) {
    const panel = $('fndAlfPanel');
    const open = (force === undefined) ? !panel.classList.contains('fnd-open') : !!force;
    panel.classList.toggle('fnd-open', open);
    if (open) setTimeout(() => $('fndAlfText') && $('fndAlfText').focus(), 80);
  }
  function alfAppend(role, text) {
    const box = $('fndAlfMsgs');
    const el = document.createElement('div');
    el.className = 'fnd-alf-msg ' + role;
    el.textContent = text;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }
  async function alfSend() {
    const inp = $('fndAlfText');
    const text = (inp.value || '').trim();
    if (!text) return;
    inp.value = '';
    alfAppend('user', text);
    const pending = alfAppend('bot', '…');
    try {
      const j = await backendPost('alfred', {
        message: text,
        selected_section: state.selectedSection,
        sections: state.metricsBySection,
      });
      pending.textContent = j.reply || j.error || '[no reply]';
    } catch (err) {
      pending.textContent = '[error] ' + err;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const inp = document.getElementById('fndAlfText');
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); alfSend(); }
      });
    }
    init();
  });

  window.foundation = { init, refresh, openPanel, closePanel, save, toggleAlfred, alfSend };
})();
