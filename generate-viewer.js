/**
 * Generates viewer.html — combined viewer for all test labels.
 * Embeds test code and base64 screenshots directly so no server is needed.
 *
 * Usage: node generate-viewer.js
 * Then open: viewer.html in any browser
 */

const fs   = require('fs');
const path = require('path');

const OUT_FILE    = path.join(__dirname, 'viewer.html');
const CLIENT_JS   = fs.readFileSync(path.join(__dirname, 'viewer-client.js'), 'utf8');

// ── Project definitions ───────────────────────────────────────────────────────
const PROJECTS = [
  { id: 'autodesk-build', name: 'Autodesk Build' },
  { id: 'web-platform',   name: 'Web Platform'   },
];

// ── Label → module mapping per project ───────────────────────────────────────
const LABEL_MODULE_AB = {
  RFIs_Signoff:                  'RFIs',
  RFIs_Notifications:            'RFIs',
  Meetings_Regression:           'Meetings',
  Meetings_Regressions:          'Meetings',
  Correspondence_Regression:     'Correspondence',
  Schedule_Regression:           'Schedule',
  Schedule_WorkPlan_Regression:  'Schedule',
  Schedule_Notifications:        'Schedule',
  Schedule_WorkPlan_Sanity:      'Schedule',
};

function moduleFromLabels(labels, projectId) {
  if (projectId === 'web-platform') {
    // Web Platform module detection — extend as needed
    for (const l of (labels || [])) {
      if (/^docs/i.test(l))        return 'Docs';
      if (/^sheets/i.test(l))      return 'Sheets';
      if (/^model/i.test(l))       return 'Model';
      if (/^cost/i.test(l))        return 'Cost';
      if (/^field/i.test(l))       return 'Field';
      if (/^admin/i.test(l))       return 'Admin';
    }
    return 'Other';
  }
  for (const l of (labels || [])) {
    if (LABEL_MODULE_AB[l]) return LABEL_MODULE_AB[l];
    if (/^meetings/i.test(l))       return 'Meetings';
    if (/^correspondence/i.test(l)) return 'Correspondence';
    if (/^schedule/i.test(l))       return 'Schedule';
    if (/^rfi/i.test(l))            return 'RFIs';
  }
  return 'Other';
}

function sourceDir(label, projectId = 'autodesk-build', baseDir = __dirname) {
  return {
    projectId,
    testsDir:       path.join(baseDir, label, 'tests'),
    screenshotsDir: path.join(baseDir, label, 'Steps_Screenshots'),
    stepsDir:       path.join(baseDir, label, 'tests_with_steps'),
  };
}

// ── Autodesk Build sources ────────────────────────────────────────────────────
const AB_SOURCES = [
  {
    projectId:      'autodesk-build',
    testsDir:       path.join(__dirname, 'tests'),
    screenshotsDir: path.join(__dirname, 'Steps_Screenshots'),
    stepsDir:       path.join(__dirname, 'tests_with_steps'),
  },
  sourceDir('RFIs_Notifications',           'autodesk-build'),
  sourceDir('Meetings_Regressions',         'autodesk-build'),
  sourceDir('Correspondence_Regression',    'autodesk-build'),
  sourceDir('Schedule_Regression',          'autodesk-build'),
  sourceDir('Schedule_WorkPlan_Regression', 'autodesk-build'),
  sourceDir('Schedule_Notifications',       'autodesk-build'),
  sourceDir('Schedule_WorkPlan_Sanity',     'autodesk-build'),
].filter(s => fs.existsSync(s.testsDir));

// ── Web Platform sources (label subdirs under WebPlatform/) ──────────────────
const WP_BASE = path.join(__dirname, 'WebPlatform');
const WP_SOURCES = fs.existsSync(WP_BASE)
  ? fs.readdirSync(WP_BASE)
      .filter(d => fs.existsSync(path.join(WP_BASE, d, 'tests')))
      .map(d => sourceDir(d, 'web-platform', WP_BASE))
  : [];

const SOURCES = [...AB_SOURCES, ...WP_SOURCES];

// ── BDD generation (Node.js, build time) ──────────────────────────────────────

const BUILTIN_FNS = /^(page|expect|test|browser|context|frame|locator|element|describe|it|before|after|console|Promise|Object|Array|JSON|waitForText|scrollOnElement|isVisible|getText|sleep|delay)/i;

function extractPageName(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    // e.g. /build/rfis/projects/xxx → "RFI project page"
    if (parts.includes('rfis')) return 'the RFI project page';
    if (parts.includes('issues')) return 'the Issues page';
    if (parts.includes('submittals')) return 'the Submittals page';
    return 'the application';
  } catch { return 'the application'; }
}

function fnToReadable(fn, rawArgs) {
  // Strip common Testim prefixes and trailing _1 _2 suffixes
  let s = fn
    .replace(/^RFIs_+/i, '')
    .replace(/^RFI_+/i, '')
    .replace(/_+\d+$/, '')
    .replace(/_+/g, ' ')
    .trim();

  // PascalCase → words
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  s = s.replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2');
  s = s.trim().toLowerCase();

  // Restore known acronyms
  s = s.replace(/\brfi\b/g, 'RFI').replace(/\bor\b/g, 'OR').replace(/\bwfa\b/g, 'WFA');

  // Extract numbers from argument variable names (e.g. long5000Value → 5000)
  const numMatch = rawArgs && rawArgs.match(/(\d{3,})/);
  if (numMatch) s += ` with ${numMatch[1]} characters`;

  // Add "I" prefix for action steps — skip if it already starts with I/a modal verb
  if (!/^(I |the |a |an )/i.test(s)) s = 'I ' + s;

  // Capitalise first letter
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function categorizeBDDFn(fn) {
  const l = fn.toLowerCase();
  if (/^(login|log_in|signin|sign_in|navigate|open_|go_to|start_|init_|setup_|launch|access|visit|enter_as|as_a|as_an|user_is|logged_in|authenticate)/.test(l)) return 'given';
  if (/^(validate|verify|check|assert|confirm|ensure|should|expect|see_|view_|inspect|observe|review|make_sure)/.test(l)) return 'then';
  if (/(validate|verify|check|assert|confirm|ensure|_is_valid|_exists|_visible|_shown|_displayed)$/.test(l)) return 'then';
  return 'when';
}

function buildBDD(testName, description, code) {
  const steps = [];
  const mainLines = [];

  // Only parse the "main" IIFE body — stop at the first standalone async function definition
  const iife = code.match(/\(async\s*\(\)\s*=>\s*\{([\s\S]*?)\}\)\(\)/);
  const body = iife ? iife[1] : code;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    // page.goto(url) → Given
    const gotoM = line.match(/^await page\.goto\(["'`]([^"'`]+)/);
    if (gotoM) {
      steps.push({ cat: 'given', text: `I open ${extractPageName(gotoM[1])}` });
      continue;
    }

    // waitForText(page, selector, 'expectedText') → Then
    // The selector may itself contain commas, so match last quoted string arg
    const wftM = line.match(/^await waitForText\(/) &&
      line.match(/,\s*["'`]([^"'`]{1,120})["'`]\s*\)\s*;?\s*$/);
    if (wftM) {
      let txt = wftM[1].trim();
      if (txt.length > 60) txt = txt.slice(0, 57) + '...';
      steps.push({ cat: 'then', text: txt });
      continue;
    }

    // Named function call
    const fnM = line.match(/^(?:(?:const|let|var)\s+\w+\s*=\s*)?await\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/);
    if (fnM) {
      const fn = fnM[1], rawArgs = fnM[2];
      if (BUILTIN_FNS.test(fn)) continue;
      steps.push({ cat: categorizeBDDFn(fn), text: fnToReadable(fn, rawArgs) });
    }
  }

  if (!steps.length) return null;

  // Assign Given/When/Then/And keywords
  const rows = [];
  let lastCat = null;
  for (const s of steps) {
    const isRepeat = s.cat === lastCat;
    const kw = isRepeat ? 'And' : (s.cat === 'given' ? 'Given' : s.cat === 'when' ? 'When' : 'Then');
    rows.push({ kw, kwClass: isRepeat ? 'and' : s.cat, text: s.text });
    lastCat = s.cat;
  }

  const gherkin = [
    `Feature: ${testName}`,
    description ? `  # ${description}` : null,
    '',
    `  Scenario: ${testName}`,
    ...rows.map(r => `    ${r.kw} ${r.text}`),
  ].filter(l => l !== null).join('\n');

  return { rows, gherkin };
}

// ──────────────────────────────────────────────────────────────────────────────

function loadFromSource(src) {
  return fs.readdirSync(src.testsDir).filter(f => f.endsWith('.ts')).map(fname => {
    const code     = fs.readFileSync(path.join(src.testsDir, fname), 'utf8');
    const pngPath  = path.join(src.screenshotsDir, fname.replace('.ts', '.png'));
    const jsonPath = path.join(src.stepsDir, fname.replace('.ts', '.json'));
    const meta     = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath)) : {};
    // Screenshots are served as separate files (screenshots/<fname>.png)
    const screenshot = fs.existsSync(pngPath) ? `screenshots/${fname.replace('.ts','.png')}` : null;
    const isStub  = code.includes('open URL manually') || code.includes('implement based on steps');
    const hasCode = code.includes('use strict') || code.includes("import { test");

    // Prefer AI-generated BDD from bdd/ folder, fall back to regex-parsed
    const bddDir = src.projectId === 'web-platform'
      ? path.join(WP_BASE, 'bdd') : path.join(__dirname, 'bdd');
    const aiBddPath = path.join(bddDir, fname.replace('.ts', '.json'));
    let bddRows, bddGherkin, bddIsAI = false;
    if (fs.existsSync(aiBddPath)) {
      const ai = JSON.parse(fs.readFileSync(aiBddPath));
      bddRows    = ai.rows;
      bddGherkin = ai.gherkin;
      bddIsAI    = true;
    } else {
      const bdd  = buildBDD(meta.name || fname.replace(/_/g,' ').replace('.ts',''), meta.description || '', code);
      bddRows    = bdd ? bdd.rows : null;
      bddGherkin = bdd ? bdd.gherkin : null;
    }

    const labels = meta.labels || [];
    return {
      id:          meta.id || '',
      name:        meta.name || fname.replace(/_/g,' ').replace('.ts',''),
      labels,
      project:     src.projectId || 'autodesk-build',
      module:      moduleFromLabels(labels, src.projectId),
      description: meta.description || '',
      owner:       meta.owner || '',
      lastResult:  meta.lastResult || null,
      testimURL:   meta.testimURL || '',
      playwrightExportURL: meta.playwrightExportURL || '',
      fname, code, screenshot, isStub, hasCode,
      bddRows, bddGherkin, bddIsAI,
    };
  });
}

// Merge and deduplicate by test id (keep first occurrence)
const seen = new Set();
const tests = SOURCES.flatMap(loadFromSource)
  .filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; })
  .sort((a, b) => a.name.localeCompare(b.name));

const testsJson    = JSON.stringify(tests);
const projectsJson = JSON.stringify(PROJECTS);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Testim Migrator — Playwright Bridge</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:       #f3f4f6;
    --white:    #ffffff;
    --border:   #e5e7eb;
    --orange:   #f97316;
    --orange2:  #ea6c0a;
    --green:    #22c55e;
    --red:      #ef4444;
    --yellow:   #f59e0b;
    --text:     #111827;
    --muted:    #6b7280;
    --muted2:   #9ca3af;
    --sidebar:  440px;
    --header:   60px;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg); color: var(--text);
    height: 100vh; display: flex; flex-direction: column; overflow: hidden; font-size: 14px;
  }

  /* ── TOP HEADER ── */
  #topbar {
    height: var(--header); min-height: var(--header);
    background: var(--white); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; padding: 0 24px; gap: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.06);
  }
  #logo {
    width: 38px; height: 38px; background: var(--orange); border-radius: 10px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  #logo svg { width: 20px; height: 20px; fill: white; }
  #brand { display: flex; flex-direction: column; }
  #brand-name { font-size: 16px; font-weight: 700; color: var(--text); line-height: 1.2; }
  #brand-sub  { font-size: 10px; font-weight: 600; letter-spacing: .08em; color: var(--muted); text-transform: uppercase; }
  #topbar-right { margin-left: auto; display: flex; align-items: center; gap: 12px; }
  .top-btn {
    display: flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--white); font-size: 13px; font-weight: 500;
    color: var(--text); cursor: pointer; transition: background .15s;
  }
  .top-btn:hover { background: var(--bg); }
  .top-btn svg { width: 14px; height: 14px; stroke: var(--muted); fill: none; }
  #stats-pill { font-size: 13px; color: var(--muted); }

  /* Project switcher */
  #project-wrap { position: relative; }
  #project-btn {
    display: flex; align-items: center; gap: 8px; padding: 7px 14px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--white); cursor: pointer;
    font-size: 14px; font-weight: 600; color: var(--text); transition: border-color .15s;
    white-space: nowrap;
  }
  #project-btn:hover { border-color: var(--orange); }
  #project-btn .pb-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--orange); flex-shrink: 0; }
  #project-btn .pb-chevron { width: 14px; height: 14px; stroke: var(--muted2); fill: none; margin-left: 2px; }
  #project-menu {
    display: none; position: absolute; top: calc(100% + 8px); right: 0; z-index: 200;
    background: var(--white); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.12); min-width: 240px; overflow: hidden;
  }
  #project-menu.open { display: block; }
  #project-menu-header {
    padding: 10px 14px 6px; font-size: 10px; font-weight: 700; letter-spacing: .08em;
    color: var(--muted2); text-transform: uppercase;
  }
  .project-option {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer;
    font-size: 14px; font-weight: 500; color: var(--text); transition: background .1s;
    white-space: nowrap;
  }
  .project-option:hover { background: var(--bg); }
  .project-option.active { background: #fff7ed; }
  .project-option .po-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .project-option .po-name { flex: 1; }
  .project-option .po-count { font-size: 12px; color: var(--muted2); }
  .project-option .po-check { width: 15px; height: 15px; stroke: var(--orange); fill: none; }

  /* ── BODY ── */
  #body { flex: 1; display: flex; overflow: hidden; padding: 20px; gap: 16px; }

  /* ── SIDEBAR CARD ── */
  #sidebar {
    width: var(--sidebar); min-width: var(--sidebar);
    background: var(--white); border-radius: 14px; border: 1px solid var(--border);
    display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,.06);
  }
  #explorer-header {
    padding: 14px 16px 10px; display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid var(--border);
  }
  #explorer-title { font-size: 11px; font-weight: 700; letter-spacing: .08em; color: var(--muted); text-transform: uppercase; }
  #select-all { font-size: 13px; font-weight: 600; color: var(--orange); cursor: pointer; }
  #select-all:hover { color: var(--orange2); }

  #search-wrap { padding: 10px 12px; border-bottom: 1px solid var(--border); position: relative; }
  #search-icon { position: absolute; left: 22px; top: 50%; transform: translateY(-50%); width: 15px; height: 15px; stroke: var(--muted2); fill: none; }
  #search {
    width: 100%; border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 10px 8px 34px; font-size: 15px; color: var(--text);
    background: var(--bg); outline: none; transition: border-color .15s;
  }
  #search:focus { border-color: var(--orange); background: var(--white); }
  #search::placeholder { color: var(--muted2); }

  #filter-bar { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; align-items: center; }
  .filter-chip {
    font-size: 13px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--bg); color: var(--muted); cursor: pointer; font-weight: 500; transition: all .15s;
    display: flex; align-items: center; gap: 5px;
  }
  .filter-chip svg { width: 13px; height: 13px; stroke: currentColor; fill: none; flex-shrink: 0; }
  .filter-chip:hover { border-color: var(--orange); color: var(--orange); }
  .filter-chip.active { background: #fff7ed; border-color: var(--orange); color: var(--orange); }
  #clear-filters-btn:hover { background: #fee2e2 !important; border-color: #dc2626 !important; }

  #stats { display: none; }

  #list { overflow-y: auto; flex: 1; }
  .test-item {
    padding: 12px 14px; border-bottom: 1px solid var(--border);
    cursor: pointer; transition: background .1s; display: flex; align-items: flex-start; gap: 10px;
  }
  .test-item:hover  { background: #fafafa; }
  .test-item.active { background: #fff7ed; border-left: 3px solid var(--orange); }
  .test-item .info  { flex: 1; min-width: 0; }
  .test-item .tname { font-size: 15px; font-weight: 500; line-height: 1.4; color: var(--text); }
  .test-item .tdesc { font-size: 12px; color: var(--muted2); margin-top: 2px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 340px; }
  .test-item .tags  { margin-top: 5px; display: flex; gap: 4px; flex-wrap: wrap; }
  .test-item .arrow { color: var(--muted2); font-size: 16px; padding-top: 2px; flex-shrink: 0; }
  .module-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 6px; }
  .label-tag {
    font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 5px;
    background: #f3f4f6; color: #374151; border: 1px solid #e5e7eb;
    cursor: pointer; text-transform: uppercase; letter-spacing: .03em; transition: all .15s;
  }
  .label-tag:hover { background: #fff7ed; border-color: var(--orange); color: var(--orange); }

  /* ── MAIN CARD ── */
  #main {
    flex: 1; background: var(--white); border-radius: 14px; border: 1px solid var(--border);
    display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,.06);
  }

  /* ── EMPTY STATE ── */
  #empty-state {
    flex: 1; display: flex; align-items: center; justify-content: center;
    flex-direction: column; gap: 14px; color: var(--muted);
  }
  #empty-icon {
    width: 64px; height: 64px; background: #f3f4f6; border-radius: 16px;
    display: flex; align-items: center; justify-content: center;
  }
  #empty-icon svg { width: 32px; height: 32px; stroke: var(--muted2); fill: none; }
  #empty-state h3 { font-size: 20px; font-weight: 700; color: var(--text); }
  #empty-state p  { font-size: 14px; color: var(--muted); text-align: center; max-width: 280px; line-height: 1.6; }

  /* ── DETAIL ── */
  #main-header {
    padding: 16px 20px; border-bottom: 1px solid var(--border);
    display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap;
  }
  #main-header h2 { font-size: 17px; font-weight: 700; flex: 1; line-height: 1.4; }
  #main-header a  { font-size: 13px; color: var(--orange); text-decoration: none; font-weight: 500; white-space: nowrap; }
  #main-header a:hover { text-decoration: underline; }
  #detail-badges { display: flex; gap: 6px; flex-wrap: wrap; }

  #detail-meta {
    padding: 10px 20px; font-size: 13px; color: var(--muted);
    border-bottom: 1px solid var(--border); display: flex; gap: 20px; flex-wrap: wrap;
    background: #fafafa;
  }

  #tabs { display: flex; border-bottom: 1px solid var(--border); }
  .tab {
    padding: 11px 22px; font-size: 14px; font-weight: 500; cursor: pointer;
    border-bottom: 2px solid transparent; color: var(--muted); transition: all .15s;
  }
  .tab:hover  { color: var(--text); }
  .tab.active { color: var(--orange); border-bottom-color: var(--orange); }

  #content { flex: 1; overflow: hidden; display: flex; }

  #tab-screenshot { flex: 1; overflow: auto; padding: 20px; display: none; }
  #tab-screenshot.visible { display: block; }
  #tab-screenshot img { max-width: 100%; border-radius: 10px; border: 1px solid var(--border); box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  .no-screenshot { color: var(--muted); font-size: 14px; padding: 40px; text-align: center; }

  #tab-code { flex: 1; overflow: auto; display: none; background: #1e1e2e; border-radius: 0 0 14px 0; position: relative; }
  #tab-code.visible { display: block; }
  #tab-code pre {
    padding: 24px 24px 24px 24px; font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
    font-size: 13.5px; line-height: 1.7; color: #cdd6f4; white-space: pre-wrap; word-break: break-word;
    margin: 0;
  }
  #copy-code-btn {
    position: sticky; top: 12px; float: right; margin: 12px 12px 0 0;
    display: flex; align-items: center; gap: 5px;
    padding: 5px 12px; border-radius: 7px; border: 1px solid #45475a;
    background: #313244; color: #cdd6f4; font-size: 12px; font-weight: 500;
    cursor: pointer; transition: all .15s; font-family: inherit;
  }
  #copy-code-btn:hover { background: #45475a; border-color: #6c7086; }
  #copy-code-btn svg { width: 13px; height: 13px; stroke: #cdd6f4; fill: none; flex-shrink: 0; }

  /* Syntax highlight tokens */
  .ck { color: #6a9955; }          /* comments   — green  */
  .cs { color: #ce9178; }          /* strings    — orange */
  .cn { color: #b5cea8; }          /* numbers    — sage   */
  .cw { color: #569cd6; }          /* keywords   — blue   */
  .cb { color: #4ec9b0; }          /* builtins   — teal   */
  .cf { color: #dcdcaa; }          /* functions  — yellow */

  #tab-bdd { flex: 1; overflow: auto; display: none; padding: 28px 32px; }
  #tab-bdd.visible { display: block; }
  .bdd-feature   { font-size: 13px; color: var(--muted); margin-bottom: 4px; font-weight: 500; }
  .bdd-title     { font-size: 20px; font-weight: 700; color: var(--text); margin-bottom: 16px; }
  .bdd-desc      { font-size: 13px; color: var(--muted); margin-bottom: 24px; line-height: 1.6; }
  .bdd-scenario  { font-size: 15px; font-weight: 700; color: var(--text); margin-bottom: 14px; }
  .bdd-steps     { display: flex; flex-direction: column; gap: 8px; }
  .bdd-step      { display: flex; align-items: flex-start; gap: 10px; font-size: 14px; line-height: 1.5; }
  .bdd-kw        { font-weight: 700; min-width: 52px; text-align: right; flex-shrink: 0; }
  .bdd-kw.given  { color: #7c3aed; }
  .bdd-kw.when   { color: var(--orange); }
  .bdd-kw.then   { color: #16a34a; }
  .bdd-kw.and    { color: var(--muted); }
  .bdd-text      { color: var(--text); }
  .bdd-actions { display: flex; gap: 8px; margin-top: 24px; align-items: center; flex-wrap: wrap; }
  .bdd-copy, .bdd-ai-btn, .bdd-key-btn {
    padding: 7px 14px; border-radius: 7px; border: 1px solid var(--border);
    background: var(--bg); font-size: 13px; font-weight: 500; color: var(--muted);
    cursor: pointer; transition: all .15s; display: inline-flex; align-items: center; gap: 6px;
    font-family: inherit;
  }
  .bdd-copy:hover   { border-color: var(--orange); color: var(--orange); }
  .bdd-ai-btn       { border-color: #7c3aed; color: #7c3aed; background: #faf5ff; }
  .bdd-ai-btn:hover { background: #ede9fe; }
  .bdd-ai-btn:disabled { opacity: .5; cursor: not-allowed; }
  .bdd-ai-badge {
    display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700;
    color: #7c3aed; background: #faf5ff; border: 1px solid #ede9fe;
    border-radius: 6px; padding: 3px 9px; margin-bottom: 14px; letter-spacing: .03em;
  }
  .bdd-loading {
    display: flex; align-items: center; gap: 12px; padding: 32px 0;
    font-size: 14px; color: var(--muted);
  }
  .bdd-spinner {
    width: 18px; height: 18px; border: 2px solid var(--border);
    border-top-color: #7c3aed; border-radius: 50%;
    animation: spin .7s linear infinite; flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #api-key-row { align-items: center; gap: 0; }

  .badge {
    font-size: 12px; padding: 3px 9px; border-radius: 6px; font-weight: 600;
    display: inline-block; white-space: nowrap;
  }
  .badge-ok   { background: #dcfce7; color: #16a34a; }
  .badge-warn { background: #fef9c3; color: #ca8a04; }
  .badge-pass { background: #dcfce7; color: #16a34a; }
  .badge-fail { background: #fee2e2; color: #dc2626; }

  #label-filter-wrap { position: relative; }
  #label-menu {
    display: none; position: absolute; top: calc(100% + 6px); left: 0; z-index: 100;
    background: var(--white); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.13); width: 260px; overflow: hidden;
  }
  #label-menu.open { display: block; }
  #module-filter-wrap { position: relative; }
  #module-menu {
    display: none; position: absolute; top: calc(100% + 6px); left: 0; z-index: 100;
    background: var(--white); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.13); width: 220px; overflow: hidden;
  }
  #module-menu.open { display: block; }
  .module-option {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; cursor: pointer; font-size: 14px; color: var(--text);
    transition: background .1s; justify-content: space-between;
  }
  .module-option:hover { background: var(--bg); }
  .module-option.selected { background: #fff7ed; }
  .module-option-left { display: flex; align-items: center; gap: 8px; }
  .mpip { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .mcount { font-size: 12px; color: var(--muted2); }

  #label-search-wrap {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--white);
  }
  #label-search-wrap svg { flex-shrink: 0; }
  #label-search {
    flex: 1; border: none; outline: none; background: transparent;
    font-size: 15px; color: var(--text); font-weight: 400;
  }
  #label-search::placeholder { color: var(--muted); opacity: 1; }
  #label-list { max-height: 260px; overflow-y: auto; }
  .label-option {
    padding: 10px 14px; font-size: 14px; cursor: pointer; color: var(--text);
    transition: background .1s; display: flex; align-items: center; justify-content: space-between;
  }
  .label-option:hover { background: #fff7ed; color: var(--orange); }
  .label-option.selected { background: #fff7ed; color: var(--orange); font-weight: 600; }
  .label-option .lcount { font-size: 12px; color: var(--muted2); min-width: 24px; text-align: right; }

  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }

  /* ── LOGIN OVERLAY ── */
  #login-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: #0f172a;
    display: flex; align-items: center; justify-content: center;
  }
  #login-card {
    background: #1e293b; border-radius: 20px; padding: 48px 44px;
    width: 380px; box-shadow: 0 24px 60px rgba(0,0,0,.5);
    display: flex; flex-direction: column; align-items: center; gap: 28px;
  }
  #login-logo {
    width: 56px; height: 56px; background: var(--orange); border-radius: 16px;
    display: flex; align-items: center; justify-content: center;
  }
  #login-logo svg { width: 28px; height: 28px; fill: white; }
  #login-title { font-size: 22px; font-weight: 700; color: #f1f5f9; text-align: center; line-height: 1.3; }
  #login-sub { font-size: 14px; color: #64748b; text-align: center; margin-top: 4px; }
  #login-form { width: 100%; display: flex; flex-direction: column; gap: 12px; }
  .login-field {
    width: 100%; padding: 12px 16px; border-radius: 10px;
    border: 1.5px solid #334155; background: #0f172a;
    font-size: 15px; color: #f1f5f9; outline: none; transition: border-color .15s;
  }
  .login-field::placeholder { color: #475569; }
  .login-field:focus { border-color: var(--orange); }
  #login-btn {
    width: 100%; padding: 13px; border-radius: 10px; border: none;
    background: var(--orange); color: white; font-size: 15px; font-weight: 700;
    cursor: pointer; transition: background .15s; margin-top: 4px;
  }
  #login-btn:hover { background: var(--orange2); }
  #login-error {
    font-size: 13px; color: #f87171; text-align: center;
    background: rgba(239,68,68,.1); border-radius: 8px; padding: 10px 14px;
    display: none;
  }
</style>
</head>
<body>

<!-- TOP HEADER -->
<div id="topbar">
  <div id="logo">
    <svg viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21"/></svg>
  </div>
  <div id="brand">
    <div id="brand-name">Testim Migrator</div>
    <div id="brand-sub">Playwright Bridge</div>
  </div>
  <div id="topbar-right">
    <div id="stats-pill"></div>
    <div id="project-wrap">
      <button id="project-btn" onclick="toggleProjectMenu()">
        <span class="pb-dot"></span>
        <span id="project-btn-text">Autodesk Build</span>
        <svg class="pb-chevron" viewBox="0 0 24 24" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div id="project-menu">
        <div id="project-menu-header">Switch project</div>
        <div id="project-list"></div>
      </div>
    </div>
  </div>
</div>

<!-- BODY -->
<div id="body">

  <!-- SIDEBAR -->
  <div id="sidebar">
    <div id="explorer-header">
      <span id="explorer-title">Test Explorer</span>
    </div>
    <div id="search-wrap">
      <svg id="search-icon" viewBox="0 0 24 24" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input id="search" type="text" placeholder="Search tests..." autocomplete="off">
    </div>
    <!-- Filters -->
    <div id="filter-bar">
      <!-- Module dropdown -->
      <div id="module-filter-wrap">
        <button id="module-filter-btn" class="filter-chip" onclick="toggleModuleMenu()">
          <svg viewBox="0 0 24 24" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          <span id="module-filter-text">Module</span>
        </button>
        <div id="module-menu"><div id="module-list"></div></div>
      </div>
      <!-- Label dropdown -->
      <div id="label-filter-wrap">
        <button id="label-filter-btn" class="filter-chip" onclick="toggleLabelMenu()">
          <svg viewBox="0 0 24 24" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          <span id="label-filter-text">Filter by label</span>
        </button>
        <div id="label-menu">
          <div id="label-search-wrap">
            <svg viewBox="0 0 24 24" stroke-width="2" style="width:17px;height:17px;stroke:#6b7280;fill:none;flex-shrink:0;"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input id="label-search" placeholder="Search labels..." autocomplete="off">
          </div>
          <div id="label-list"></div>
        </div>
      </div>
      <!-- Clear -->
      <button id="clear-filters-btn" class="filter-chip" style="display:none;border-color:#dc2626;color:#dc2626;" onclick="clearAllFilters()">
        <svg viewBox="0 0 24 24" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        Clear
      </button>
    </div>
    <div id="stats"></div>
    <div id="list"></div>
  </div>

  <!-- MAIN -->
  <div id="main">
    <div id="empty-state">
      <div id="empty-icon">
        <svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
      </div>
      <h3>Select a test to view details</h3>
      <p>Choose a test from the sidebar to see its steps and generate Playwright code snippets.</p>
    </div>

    <div id="detail" style="display:none; flex:1; flex-direction:column; overflow:hidden;">
      <div id="main-header">
        <div style="flex:1; min-width:0;">
          <h2 id="detail-name"></h2>
          <div id="detail-desc" style="margin-top:6px; font-size:13px; color:var(--muted); line-height:1.5;"></div>
        </div>
        <a id="detail-testim-link" href="#" target="_blank">Open in Testim ↗</a>
      </div>
      <div id="tabs">
        <div class="tab active" data-tab="screenshot">Screenshot</div>
        <div class="tab" data-tab="code">Playwright Code</div>
        <div class="tab" data-tab="bdd">BDD Spec</div>
      </div>
      <div id="content">
        <div id="tab-screenshot" class="visible"><div id="screenshot-content"></div></div>
        <div id="tab-code">
          <button id="copy-code-btn" onclick="copyCode()">
            <svg viewBox="0 0 24 24" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            Copy code
          </button>
          <pre id="code-content"></pre>
        </div>
        <div id="tab-bdd"><div id="bdd-content"></div></div>
      </div>
    </div>
  </div>

</div>

<script>
// ── Auth ─────────────────────────────────────────────────────────────────────
// The overlay is the last element in <body> so it naturally covers everything.
// Just hide it if already authenticated.
if (sessionStorage.getItem('tm_auth') === '1') {
  document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('login-overlay').style.display = 'none';
  });
}

function doLogin(e) {
  e.preventDefault();
  const u = document.getElementById('login-user').value.trim();
  const p = document.getElementById('login-pass').value;
  if (u === 'adsk' && p === 'makeanything') {
    sessionStorage.setItem('tm_auth', '1');
    document.getElementById('login-overlay').style.display = 'none';
  } else {
    document.getElementById('login-error').style.display = 'block';
    document.getElementById('login-pass').value = '';
    document.getElementById('login-pass').focus();
  }
  return false;
}
</script>
<script>
const TESTS    = ${testsJson};
const PROJECTS = ${projectsJson};
${CLIENT_JS}
</script>

<!-- LOGIN OVERLAY — last in DOM so it paints on top of everything -->
<div id="login-overlay">
  <div id="login-card">
    <div id="login-logo">
      <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
    </div>
    <div>
      <div id="login-title">Testim Migrator</div>
      <div id="login-sub">Playwright Bridge</div>
    </div>
    <form id="login-form" onsubmit="return doLogin(event)">
      <input class="login-field" id="login-user" type="text" placeholder="Username" autocomplete="username" autofocus>
      <input class="login-field" id="login-pass" type="password" placeholder="Password" autocomplete="current-password">
      <div id="login-error">Incorrect username or password.</div>
      <button id="login-btn" type="submit">Sign in</button>
    </form>
  </div>
</div>
</body>
</html>`;

fs.writeFileSync(OUT_FILE, html, 'utf8');
const sizeKB = Math.round(fs.statSync(OUT_FILE).size / 1024);
console.log(`viewer.html generated (${sizeKB} KB) — open in browser`);
console.log(`Tests: ${tests.length} | With screenshots: ${tests.filter(t => t.screenshot).length} | With code: ${tests.filter(t => t.hasCode && !t.isStub).length}`);
