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

    // ── <defs>: gradients, filters, patterns ──
    const defs = svgEl('defs', {});

    // Background aurora gradient
    const auroraId = 'aurora-bg';
    const aurora = svgEl('radialGradient', {id: auroraId, cx: '20%', cy: '0%', r: '120%'});
    aurora.appendChild(svgEl('stop', {offset: '0%', 'stop-color': '#1e3a8a', 'stop-opacity': 0.45}));
    aurora.appendChild(svgEl('stop', {offset: '40%', 'stop-color': '#0f1c3a', 'stop-opacity': 0.6}));
    aurora.appendChild(svgEl('stop', {offset: '100%', 'stop-color': '#050a1a', 'stop-opacity': 1}));
    defs.appendChild(aurora);

    // Per-section radial gradient — soft inner glow toward center
    state.areas.forEach((area) => {
      const stops = [
        {offset: '0%',  color: 'white',                opacity: 0.25},
        {offset: '60%', color: area.outline_color || '#94a3b8', opacity: 0.35},
        {offset: '100%', color: area.outline_color || '#94a3b8', opacity: 0.05},
      ];
      const grad = svgEl('radialGradient', {
        id: 'grad-' + area.section_id, cx: '50%', cy: '50%', r: '60%',
      });
      stops.forEach(s => grad.appendChild(svgEl('stop', {
        offset: s.offset, 'stop-color': s.color, 'stop-opacity': s.opacity,
      })));
      defs.appendChild(grad);
    });

    // Glow filter
    const glow = svgEl('filter', {id: 'glow', x: '-30%', y: '-30%', width: '160%', height: '160%'});
    glow.appendChild(svgEl('feGaussianBlur', {stdDeviation: '4', result: 'b'}));
    const merge = svgEl('feMerge', {});
    merge.appendChild(svgEl('feMergeNode', {in: 'b'}));
    merge.appendChild(svgEl('feMergeNode', {in: 'SourceGraphic'}));
    glow.appendChild(merge);
    defs.appendChild(glow);

    // Soft outer glow (stronger)
    const glowOuter = svgEl('filter', {id: 'glow-outer', x: '-40%', y: '-40%', width: '180%', height: '180%'});
    glowOuter.appendChild(svgEl('feGaussianBlur', {stdDeviation: '10', result: 'b'}));
    const m2 = svgEl('feMerge', {});
    m2.appendChild(svgEl('feMergeNode', {in: 'b'}));
    m2.appendChild(svgEl('feMergeNode', {in: 'SourceGraphic'}));
    glowOuter.appendChild(m2);
    defs.appendChild(glowOuter);

    svg.appendChild(defs);

    // Soft aurora background (very subtle now)
    svg.appendChild(svgEl('rect', {
      x: 0, y: 0, width: W, height: H,
      fill: `url(#${auroraId})`, 'fill-opacity': 0.45,
    }));

    // Minimal dot grid for depth — barely visible
    const grid = svgEl('g', {opacity: 0.4});
    for (let x = 100; x < W; x += 100) {
      for (let y = 100; y < H; y += 100) {
        grid.appendChild(svgEl('circle', {cx: x, cy: y, r: 0.8, fill: '#1e293b'}));
      }
    }
    svg.appendChild(grid);

    // North arrow only — title lives in the toolbar above
    if (state.canvas.north_arrow) {
      const na = state.canvas.north_arrow;
      const g = svgEl('g', {transform: `translate(${na.x},${na.y})`, opacity: 0.55});
      g.appendChild(svgEl('circle', {r: 22, fill: 'none', stroke: '#475569', 'stroke-width': 1}));
      g.appendChild(svgEl('polygon', {points: '0,-18 -5,4 0,1 5,4', fill: '#94a3b8'}));
      g.appendChild(svgEl('text', {y: -28, 'text-anchor': 'middle', fill: '#64748b',
                                     'font-size': 9, 'font-weight': 500,
                                     'letter-spacing': '0.1em'}, 'N'));
      svg.appendChild(g);
    }

    // Path of travel — fine dashed connector
    if (state.pathOfTravel && state.pathOfTravel.length > 1) {
      const d = state.pathOfTravel.map((p, i) =>
        (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ');
      svg.appendChild(svgEl('path', {
        d: d, stroke: '#475569', 'stroke-width': 1.5, fill: 'none',
        'stroke-dasharray': '6 8', 'stroke-linecap': 'round',
        'stroke-opacity': 0.55,
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

    // 1) Subtle backdrop — flat dark fill, no gradient
    svg.appendChild(svgEl('polygon', {
      points: points,
      fill: '#0f172a',
      'fill-opacity': area.interactive ? 0.6 : 0.4,
      stroke: 'none',
      'pointer-events': 'none',
    }));

    // 2) Status fill polygon (the interactive one — receives hover/click)
    const poly = svgEl('polygon', {
      points: points,
      fill: c.fill,
      'fill-opacity': area.interactive ? 0.13 : 0.06,
      stroke: c.stroke,
      'stroke-width': 1.2,
      'stroke-opacity': 0.9,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
      'data-section': area.section_id,
    });
    if (!area.interactive) poly.classList.add('fnd-readonly');
    // Pulse animation on attention-needing sections
    if (area.interactive) {
      if (indicator.indexOf('NEEDS') >= 0) poly.classList.add('fnd-pulse-rose');
      else if (indicator.indexOf('MONITORING') >= 0 || indicator.indexOf('TEMP OK') >= 0) {
        poly.classList.add('fnd-pulse-amber');
      }
      poly.addEventListener('mousemove', (e) => showTooltip(e, area));
      poly.addEventListener('mouseleave', hideTooltip);
      poly.addEventListener('click', () => openPanel(area.section_id));
    }
    svg.appendChild(poly);

    // 3) Subtle outline accent in the original sequence color
    svg.appendChild(svgEl('polygon', {
      points: points,
      fill: 'none',
      stroke: area.outline_color || c.stroke,
      'stroke-width': 1,
      'stroke-opacity': area.interactive ? 0.4 : 0.25,
      'stroke-linejoin': 'round',
      'stroke-dasharray': area.interactive ? '0' : '4 6',
      'pointer-events': 'none',
    }));

    // 4) Centroid label — refined, lower-weight, no shouty stroke
    const cx = area.polygon.reduce((s, p) => s + p[0], 0) / area.polygon.length;
    const cy = area.polygon.reduce((s, p) => s + p[1], 0) / area.polygon.length;
    const off = area.label_offset || [0, 0];
    let labelText = area.section_id;
    let labelSize = 32;
    let labelWeight = 600;
    if (area.section_id === '4') { labelText = 'Zone 4'; labelSize = 24; }
    if (!area.interactive) { labelSize = 20; labelWeight = 500; }
    // Section ID — subtle, refined
    svg.appendChild(svgEl('text', {
      x: cx + off[0],
      y: cy + off[1],
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      fill: area.interactive ? '#f8fafc' : '#94a3b8',
      'font-size': labelSize,
      'font-weight': labelWeight,
      'font-family': '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", system-ui, sans-serif',
      'letter-spacing': '-0.015em',
      'pointer-events': 'none',
      opacity: area.interactive ? 0.95 : 0.7,
    }, labelText));

    // Label sub-text — even smaller, muted
    if (area.label && area.interactive && area.label !== area.section_id) {
      svg.appendChild(svgEl('text', {
        x: cx + off[0],
        y: cy + off[1] + 22,
        'text-anchor': 'middle',
        fill: '#64748b',
        'font-size': 11,
        'font-weight': 400,
        'letter-spacing': '0.02em',
        'pointer-events': 'none',
      }, area.label));
    }
    if (area.annotation) {
      svg.appendChild(svgEl('text', {
        x: cx + off[0],
        y: cy + off[1] + (area.label && area.interactive ? 40 : 22),
        'text-anchor': 'middle',
        fill: area.interactive ? '#86efac' : '#64748b',
        'font-size': 10,
        'font-weight': 400,
        'letter-spacing': '0.04em',
        'text-transform': 'uppercase',
        'pointer-events': 'none',
        opacity: 0.85,
      }, area.annotation));
    }

    // 5) Phase markers — minimal text, no pills
    if (area.phases) {
      area.phases.forEach((p) => {
        svg.appendChild(svgEl('text', {
          x: p.anchor[0],
          y: p.anchor[1],
          'text-anchor': 'middle',
          'dominant-baseline': 'middle',
          fill: '#94a3b8',
          'font-size': 10,
          'font-weight': 500,
          'letter-spacing': '0.06em',
          'pointer-events': 'none',
          opacity: 0.7,
        }, p.id.replace(/^Phase\s+/i, '').toUpperCase()));
      });
    }
  }

  function drawLegend(svg, x, y) {
    const items = [
      ['#22c55e', 'Ready'],
      ['#f59e0b', 'Monitoring'],
      ['#ef4444', 'Needs Date'],
      ['#64748b', 'Already Poured'],
    ];
    const g = svgEl('g', {transform: `translate(${x},${y})`});
    items.forEach((it, i) => {
      const yy = i * 22;
      g.appendChild(svgEl('circle', {
        cx: 6, cy: yy, r: 4,
        fill: it[0], 'fill-opacity': 0.95,
      }));
      g.appendChild(svgEl('text', {
        x: 18, y: yy + 4, fill: '#94a3b8',
        'font-size': 11, 'font-weight': 400,
        'letter-spacing': '0.02em',
      }, it[1]));
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
