// viewer-client.js — embedded by generate-viewer.js at build time
// Receives: TESTS (injected before this script)

'use strict';

// ── Syntax highlighter ──────────────────────────────────────────────────────
const KW = new Set([
  'const','let','var','function','async','await','return',
  'if','else','for','while','do','break','continue','new','this',
  'typeof','instanceof','try','catch','finally','throw',
  'import','export','from','default','class','extends','super',
  'static','of','in','true','false','null','undefined','void','delete','use strict',
]);
const BUILTIN = new Set([
  'page','browser','context','test','expect','require',
  'module','exports','console','process','Promise','Array','Object','JSON',
  'String','Number','Boolean','Math','Date','RegExp','Error','Map','Set',
  'parseInt','parseFloat','setTimeout','clearTimeout','setInterval','clearInterval',
  'chromium','webkit','firefox',
]);

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function highlightCode(code) {
  const out = [];
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];

    // Line comment
    if (ch === '/' && code[i+1] === '/') {
      let j = i + 2;
      while (j < n && code[j] !== '\n') j++;
      out.push('<span class="ck">' + esc(code.slice(i,j)) + '</span>');
      i = j; continue;
    }
    // Block comment
    if (ch === '/' && code[i+1] === '*') {
      let j = i + 2;
      while (j < n - 1 && !(code[j] === '*' && code[j+1] === '/')) j++;
      j += 2;
      out.push('<span class="ck">' + esc(code.slice(i,j)) + '</span>');
      i = j; continue;
    }
    // Template literal
    if (ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '`') { j++; break; }
        j++;
      }
      out.push('<span class="cs">' + esc(code.slice(i,j)) + '</span>');
      i = j; continue;
    }
    // String
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === ch || code[j] === '\n') { j++; break; }
        j++;
      }
      out.push('<span class="cs">' + esc(code.slice(i,j)) + '</span>');
      i = j; continue;
    }
    // Number
    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < n && (
        (code[j] >= '0' && code[j] <= '9') ||
        code[j] === '.' || code[j] === 'x' || code[j] === 'X' ||
        (code[j] >= 'a' && code[j] <= 'f') || (code[j] >= 'A' && code[j] <= 'F')
      )) j++;
      out.push('<span class="cn">' + esc(code.slice(i,j)) + '</span>');
      i = j; continue;
    }
    // Identifier / keyword / function
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') {
      let j = i + 1;
      while (j < n && (
        (code[j] >= 'a' && code[j] <= 'z') || (code[j] >= 'A' && code[j] <= 'Z') ||
        (code[j] >= '0' && code[j] <= '9') || code[j] === '_' || code[j] === '$'
      )) j++;
      const word = code.slice(i, j);
      // Look ahead past whitespace for '('
      let k = j;
      while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
      if (KW.has(word)) {
        out.push('<span class="cw">' + esc(word) + '</span>');
      } else if (BUILTIN.has(word)) {
        out.push('<span class="cb">' + esc(word) + '</span>');
      } else if (code[k] === '(') {
        out.push('<span class="cf">' + esc(word) + '</span>');
      } else {
        out.push(esc(word));
      }
      i = j; continue;
    }
    // Everything else
    out.push(esc(ch));
    i++;
  }
  return out.join('');
}

// ── State ───────────────────────────────────────────────────────────────────
let activeProject = 'autodesk-build';
let filtered = [...TESTS];
let activeLabel  = null;
let activeModule = null;
let activeIdx    = null;

// Project-specific derived data (rebuilt when project switches)
let projectTests  = TESTS.filter(t => t.project === activeProject);
let labelCounts   = {};
let allLabels     = [];
let moduleCounts  = {};
let allModules    = [];

function rebuildProjectData() {
  projectTests = TESTS.filter(t => t.project === activeProject);
  labelCounts  = {};
  projectTests.forEach(t => t.labels.forEach(l => { labelCounts[l] = (labelCounts[l] || 0) + 1; }));
  allLabels    = Object.keys(labelCounts).sort();
  moduleCounts = {};
  projectTests.forEach(t => { const m = t.module || 'Other'; moduleCounts[m] = (moduleCounts[m] || 0) + 1; });
  allModules   = Object.keys(moduleCounts).sort();
}
rebuildProjectData();

function updateClearBtn() {
  const hasFilter = activeModule || activeLabel;
  document.getElementById('clear-filters-btn').style.display = hasFilter ? 'flex' : 'none';
}

function clearAllFilters() {
  activeModule = null;
  activeLabel  = null;
  document.getElementById('search').value = '';
  document.getElementById('label-filter-text').textContent = 'Filter by label';
  document.getElementById('label-filter-btn').classList.remove('active');
  document.getElementById('module-filter-text').textContent = 'Module';
  document.getElementById('module-filter-btn').classList.remove('active');
  document.getElementById('label-menu').classList.remove('open');
  document.getElementById('module-menu').classList.remove('open');
  renderModuleMenu();
  renderLabelMenu();
  updateClearBtn();
  renderList();
}

// expose for HTML onclick
window.toggleProjectMenu = toggleProjectMenu;
window.toggleModuleMenu  = toggleModuleMenu;
window.toggleLabelMenu   = toggleLabelMenu;
window.clearAllFilters   = clearAllFilters;


// ── Module colors ────────────────────────────────────────────────────────────
const MODULE_COLORS = {
  RFIs:            '#f97316',
  Meetings:        '#7c3aed',
  Correspondence:  '#0ea5e9',
  Schedule:        '#10b981',
  Submittals:      '#06b6d4',
  Other:           '#6b7280',
};

// ── Module dropdown ──────────────────────────────────────────────────────────
function renderModuleMenu() {
  document.getElementById('module-list').innerHTML = allModules.map(m => {
    const color = MODULE_COLORS[m] || '#6b7280';
    return `<div class="module-option${activeModule === m ? ' selected' : ''}" data-module="${m}">
      <span class="module-option-left">
        <span class="mpip" style="background:${color};"></span>
        <span style="color:${color};font-weight:600;">${m}</span>
      </span>
      <span class="mcount">${moduleCounts[m]}</span>
    </div>`;
  }).join('');
  document.querySelectorAll('.module-option').forEach(el => {
    el.addEventListener('click', () => {
      activeModule = activeModule === el.dataset.module ? null : el.dataset.module;
      const txt = document.getElementById('module-filter-text');
      txt.textContent = activeModule || 'Module';
      document.getElementById('module-filter-btn').classList.toggle('active', !!activeModule);
      if (activeModule) {
        activeLabel = null;
        document.getElementById('label-filter-text').textContent = 'Filter by label';
        document.getElementById('label-filter-btn').classList.remove('active');
        document.getElementById('label-menu').classList.remove('open');
      }
      toggleModuleMenu();
      renderModuleMenu();
      renderLabelMenu();
      updateClearBtn();
      renderList();
    });
  });
}
renderModuleMenu();

function toggleModuleMenu() {
  document.getElementById('module-menu').classList.toggle('open');
  document.getElementById('label-menu').classList.remove('open');
}

// ── Label dropdown ───────────────────────────────────────────────────────────
function renderLabelMenu(q = '') {
  const lq = q.toLowerCase();
  // Scope labels to active module (or all project tests if no module selected)
  const scopeTests = activeModule
    ? projectTests.filter(t => t.module === activeModule)
    : projectTests;
  const scopedCounts = {};
  scopeTests.forEach(t => t.labels.forEach(l => { scopedCounts[l] = (scopedCounts[l] || 0) + 1; }));
  const items = Object.keys(scopedCounts).sort()
    .filter(l => !lq || l.toLowerCase().includes(lq));

  document.getElementById('label-list').innerHTML = items.map(l =>
    `<div class="label-option${activeLabel===l?' selected':''}" data-label="${l}">
      <span>${l}</span><span class="lcount">${scopedCounts[l]}</span>
    </div>`
  ).join('');
  document.querySelectorAll('.label-option').forEach(el => {
    el.addEventListener('click', () => {
      activeLabel = activeLabel === el.dataset.label ? null : el.dataset.label;
      document.getElementById('label-filter-text').textContent = activeLabel || 'Filter by label';
      document.getElementById('label-filter-btn').classList.toggle('active', !!activeLabel);
      if (activeLabel) {
        document.getElementById('module-menu').classList.remove('open');
      }
      toggleLabelMenu();
      renderLabelMenu();
      updateClearBtn();
      renderList();
    });
  });
}
renderLabelMenu();

document.getElementById('label-search').addEventListener('input', e => renderLabelMenu(e.target.value));

function toggleLabelMenu() {
  document.getElementById('label-menu').classList.toggle('open');
  document.getElementById('module-menu').classList.remove('open');
}

document.addEventListener('click', e => {
  if (!document.getElementById('label-filter-wrap').contains(e.target))
    document.getElementById('label-menu').classList.remove('open');
  if (!document.getElementById('module-filter-wrap').contains(e.target))
    document.getElementById('module-menu').classList.remove('open');
  if (!document.getElementById('project-wrap').contains(e.target))
    document.getElementById('project-menu').classList.remove('open');
});

// ── Project switcher ─────────────────────────────────────────────────────────
const PROJECT_COLORS = { 'autodesk-build': '#f97316', 'web-platform': '#3b82f6' };

function renderProjectMenu() {
  const counts = {};
  PROJECTS.forEach(p => { counts[p.id] = TESTS.filter(t => t.project === p.id).length; });

  document.getElementById('project-list').innerHTML = PROJECTS.map(p => {
    const color   = PROJECT_COLORS[p.id] || '#6b7280';
    const isActive = activeProject === p.id;
    return `<div class="project-option${isActive ? ' active' : ''}" data-project="${p.id}">
      <span class="po-dot" style="background:${color};"></span>
      <span class="po-name">${p.name}</span>
      <span class="po-count">${counts[p.id] || 0} tests</span>
      ${isActive ? '<svg class="po-check" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
    </div>`;
  }).join('');

  document.querySelectorAll('.project-option').forEach(el => {
    el.addEventListener('click', () => {
      activeProject = el.dataset.project;
      const proj = PROJECTS.find(p => p.id === activeProject);
      document.getElementById('project-btn-text').textContent = proj ? proj.name : activeProject;
      document.getElementById('project-btn').querySelector('.pb-dot').style.background =
        PROJECT_COLORS[activeProject] || '#6b7280';
      activeLabel  = null;
      activeModule = null;
      document.getElementById('search').value = '';
      rebuildProjectData();
      renderModuleMenu();
      renderLabelMenu();
      updateClearBtn();
      toggleProjectMenu();
      renderProjectMenu();
      activeIdx = null;
      document.getElementById('detail').style.display = 'none';
      document.getElementById('empty-state').style.display = '';
      renderList();
    });
  });
}
renderProjectMenu();

function toggleProjectMenu() {
  document.getElementById('project-menu').classList.toggle('open');
}

// ── Render list ──────────────────────────────────────────────────────────────
function renderList() {
  const q = document.getElementById('search').value.toLowerCase();
  filtered = projectTests.filter(t => {
    if (!(!q || t.name.toLowerCase().includes(q) || t.labels.join(' ').toLowerCase().includes(q))) return false;
    if (activeModule && t.module !== activeModule) return false;
    if (activeLabel  && !t.labels.includes(activeLabel)) return false;
    return true;
  });

  document.getElementById('stats').textContent = '';
  document.getElementById('stats-pill').textContent = '';

  const inner = document.getElementById('list-inner');
  inner.innerHTML = filtered.map((t, i) => {
    const modColor = MODULE_COLORS[t.module] || '#9ca3af';
    const desc = t.description ? `<div class="tdesc">${t.description}</div>` : '';
    return `<div class="test-item" data-idx="${i}">
      <div class="module-dot" style="background:${modColor}" title="${t.module || 'Other'}"></div>
      <div class="info"><div class="tname">${t.name}</div>${desc}</div>
      <div class="arrow">›</div>
    </div>`;
  }).join('');

  inner.querySelectorAll('.test-item').forEach(el => {
    el.addEventListener('click', () => selectTest(+el.dataset.idx));
  });
}

// ── Select test ──────────────────────────────────────────────────────────────
function selectTest(idx) {
  activeIdx = idx;
  const t = filtered[idx];

  document.querySelectorAll('.test-item').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
  });

  document.getElementById('empty-state').style.display = 'none';
  const detail = document.getElementById('detail');
  detail.style.display = 'flex';

  document.getElementById('detail-name').textContent = t.name;
  document.getElementById('detail-testim-link').href = t.testimURL || '#';
  document.getElementById('detail-desc').textContent = t.description || '';

  // Screenshot
  const sc = document.getElementById('screenshot-content');
  if (t.screenshot) {
    sc.innerHTML = `<img src="${t.screenshot}" alt="Test screenshot">`;
  } else {
    sc.innerHTML = '<div class="no-screenshot">No screenshot captured yet.</div>';
  }

  // Code with syntax highlighting
  const pre = document.getElementById('code-content');
  pre.innerHTML = highlightCode(t.code);

  // BDD
  document.getElementById('bdd-content').innerHTML = renderBDD(t);
}

// ── Copy code ────────────────────────────────────────────────────────────────
function copyCode() {
  const t = activeIdx !== null ? filtered[activeIdx] : null;
  if (!t) return;
  navigator.clipboard.writeText(t.code).then(() => {
    const btn = document.getElementById('copy-code-btn');
    if (btn) {
      const orig = btn.innerHTML;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
  });
}

// ── BDD renderer ─────────────────────────────────────────────────────────────
const COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
const AI_ICON   = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
const KEY_ICON  = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><circle cx="8" cy="15" r="5"/><path d="M21 3l-9.4 9.4M16 8l2 2"/></svg>';

function bddActionBar() {
  return '<div class="bdd-actions">' +
    '<button class="bdd-copy" onclick="copyBDD()">' + COPY_ICON + ' Copy Gherkin</button>' +
    '<button class="bdd-ai-btn" id="reanalyze-btn" onclick="reanalyzeBDD()">' + AI_ICON + ' Reanalyze with AI</button>' +
    '</div>';
}

function renderBDD(t) {
  const noSteps = !t.bddRows || !t.bddRows.length;
  const body = noSteps
    ? '<div style="color:var(--muted);font-size:14px;margin-bottom:24px;">No step functions detected in this test\'s Playwright code.</div>'
    : (t.bddIsAI ? '<div class="bdd-ai-badge">✨ AI-generated</div>' : '') +
      bddStepsHtml(t.name, t.description, t.bddRows);

  if (!noSteps) window._currentGherkin = t.bddGherkin || '';
  return body + bddActionBar();
}

function bddStepsHtml(name, description, rows) {
  const stepsHtml = rows.map(r =>
    '<div class="bdd-step"><span class="bdd-kw ' + r.kwClass + '">' + r.kw + '</span>' +
    '<span class="bdd-text">' + r.text + '</span></div>'
  ).join('');
  return '<div class="bdd-feature">Feature</div>' +
    '<div class="bdd-title">' + name + '</div>' +
    (description ? '<div class="bdd-desc">' + description + '</div>' : '') +
    '<div class="bdd-scenario">Scenario: ' + name + '</div>' +
    '<div class="bdd-steps">' + stepsHtml + '</div>';
}

function copyBDD() {
  navigator.clipboard.writeText(window._currentGherkin || '').then(() => {
    const btn = document.querySelector('.bdd-copy');
    if (btn) { const o = btn.innerHTML; btn.textContent = 'Copied!'; setTimeout(() => { btn.innerHTML = o; }, 1500); }
  });
}

// ── AI Reanalyze — calls local bdd-server.js, no API key needed ──────────────
const BDD_SERVER = 'http://localhost:3458/analyze';

async function reanalyzeBDD() {
  const t = activeIdx !== null ? filtered[activeIdx] : null;
  if (!t) return;

  document.getElementById('bdd-content').innerHTML =
    '<div class="bdd-loading"><div class="bdd-spinner"></div><span>Claude is reading your Playwright code…</span></div>' +
    bddActionBar();
  document.getElementById('reanalyze-btn').disabled = true;
  document.getElementById('reanalyze-btn').textContent = 'Generating…';

  try {
    const res = await fetch(BDD_SERVER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: t.name, description: t.description, code: t.code }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Server error ' + res.status }));
      throw new Error(err.error || 'Server error');
    }

    const { gherkin } = await res.json();
    window._currentGherkin = gherkin;
    renderParsedGherkin(t, gherkin);

  } catch (err) {
    const isOffline = err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('net::');
    document.getElementById('bdd-content').innerHTML =
      '<div style="color:var(--red);padding:16px 0;font-size:14px;">' +
      (isOffline
        ? '<b>BDD server is not running.</b><br><br>Open a terminal in the project folder and run:<br><br>' +
          '<code style="background:#fff0f0;padding:6px 10px;border-radius:6px;font-size:13px;display:inline-block;">' +
          'node bdd-server.js</code><br><br>Then click Reanalyze again.'
        : 'Error: ' + err.message) +
      '</div>' + bddActionBar();
  }
}

function renderParsedGherkin(t, gherkin) {
  const KW_CLASS = { Given:'given', When:'when', Then:'then', And:'and', But:'and' };
  const rows = [];
  let featureName = '', scenarioName = t.name;

  for (const raw of gherkin.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('Feature:')) { featureName = line.slice(8).trim(); continue; }
    if (line.startsWith('Scenario:')) { scenarioName = line.slice(9).trim(); continue; }
    for (const kw of ['Given','When','Then','And','But']) {
      if (line.startsWith(kw + ' ') || line === kw) {
        rows.push({ kw, kwClass: KW_CLASS[kw], text: line.slice(kw.length).trim() });
        break;
      }
    }
  }

  const name = featureName || t.name;
  const stepsEl = rows.length
    ? bddStepsHtml(name, t.description, rows)
    : '<div style="color:var(--muted);padding:16px 0;">' + gherkin + '</div>';

  document.getElementById('bdd-content').innerHTML =
    '<div class="bdd-ai-badge">✨ AI-generated</div>' +
    stepsEl +
    bddActionBar();
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    document.getElementById('tab-screenshot').classList.toggle('visible', name === 'screenshot');
    document.getElementById('tab-code').classList.toggle('visible', name === 'code');
    document.getElementById('tab-bdd').classList.toggle('visible', name === 'bdd');
  });
});

// ── Search & filters ─────────────────────────────────────────────────────────
document.getElementById('search').addEventListener('input', renderList);

// ── Keyboard nav ─────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (!filtered.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); selectTest(Math.min((activeIdx ?? -1) + 1, filtered.length - 1)); }
  if (e.key === 'ArrowUp')   { e.preventDefault(); selectTest(Math.max((activeIdx ?? 1) - 1, 0)); }
});

// ── Init ─────────────────────────────────────────────────────────────────────
renderList();
