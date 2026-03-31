/**
 * scrape-label.js — scrape any Testim label page (no API needed)
 *
 * Uses session.json + Playwright to load the filtered test list, scroll through
 * the virtual list, extract test data, then download Playwright code + screenshots.
 *
 * Usage:
 *   node scrape-label.js --url "https://app.testim.io/#/project/.../automate/tests?label=sbmtls_exp&..." --out sbmtls_exp
 *   node scrape-label.js --url "..." --out sbmtls_exp --skip-screenshots
 *   node scrape-label.js --url "..." --out sbmtls_exp --force
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SESSION = path.join(__dirname, 'session.json');
const BASE    = __dirname;

const args = process.argv.slice(2);
function getArg(flag) { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; }

const URL_ARG      = getArg('--url');
const OUT_NAME     = getArg('--out');
const SKIP_SHOTS   = args.includes('--skip-screenshots');
const FORCE        = args.includes('--force');

if (!URL_ARG || !OUT_NAME) {
  console.error('Usage: node scrape-label.js --url "<testim-url>" --out <folderName> [--skip-screenshots] [--force]');
  process.exit(1);
}

if (!fs.existsSync(SESSION)) { console.error('session.json not found'); process.exit(1); }

// Parse project ID and branch from URL
const urlMatch    = URL_ARG.match(/project\/([^/]+)\/branch\/([^/]+)\//);
const PROJECT_ID  = urlMatch ? urlMatch[1] : '';
const BRANCH      = urlMatch ? urlMatch[2] : 'master';

// Parse label from query string
const labelMatch  = URL_ARG.match(/[?&]label=([^&]+)/);
const LABEL_NAME  = labelMatch ? decodeURIComponent(labelMatch[1]) : OUT_NAME;

const OUT_DIR      = path.join(BASE, OUT_NAME);
const TESTS_DIR    = path.join(OUT_DIR, 'tests');
const STEPS_DIR    = path.join(OUT_DIR, 'tests_with_steps');
const SHOTS_DIR    = path.join(OUT_DIR, 'Steps_Screenshots');

for (const d of [OUT_DIR, TESTS_DIR, STEPS_DIR, SHOTS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toFilename(name) {
  return name.replace(/[^a-zA-Z0-9 \-_]/g, '').replace(/\s+/g, '_').trim().substring(0, 120);
}

// ── Step 1: Scrape test list ──────────────────────────────────────────────────
async function scrapeTestList(page) {
  console.log(`\n[1/3] Loading test list from URL…`);
  await page.goto(URL_ARG, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('[class*="TestListRow_row"]', { timeout: 20000 })
    .catch(() => console.log('  (row selector timed out — continuing)'));
  await sleep(2000);

  const totalRows = await page.evaluate(() => {
    const c = document.querySelector('[role="rowgroup"]');
    return c ? Math.round((parseInt(c.style.height) || c.scrollHeight) / 60) : 0;
  });
  console.log(`  Virtual list reports ~${totalRows} total tests`);

  const seen  = new Set();
  const tests = [];
  const steps = Math.ceil(totalRows / 10) + 5;

  for (let step = 0; step <= steps; step++) {
    const scrollTo = step * 60 * 10;
    await page.evaluate(y => {
      const el = document.querySelector('[class*="ReactVirtualized__Grid"], [class*="ListView_viewport"]');
      if (el) { el.scrollTop = y; return; }
      const row = document.querySelector('[class*="TestListRow_row"]');
      let p = row?.parentElement;
      while (p) { if (p.scrollHeight > p.clientHeight + 50) { p.scrollTop = y; return; } p = p.parentElement; }
    }, scrollTo);
    await sleep(500);

    const batch = await page.evaluate(seenIds => {
      const results = [];
      document.querySelectorAll('[class*="TestListRow_row"]').forEach(row => {
        const link = row.querySelector('a[href*="testId="]');
        if (!link) return;
        const m = (link.getAttribute('href') || '').match(/testId=([a-zA-Z0-9_-]+)/);
        if (!m || seenIds.includes(m[1])) return;

        const multiCol = row.querySelector('[class*="multiRowColumn"]');
        if (!multiCol) return;
        const spans = multiCol.querySelectorAll('span');
        const name  = spans[0]?.textContent.trim() || '';
        const desc  = spans.length > 1 ? spans[1].textContent.trim() : '';
        if (!name) return;

        // Labels from CollapsibleLabels
        const labels = [];
        row.querySelectorAll('[class*="CollapsibleLabels_list"] li span, [class*="CollapsibleLabels"] li span')
          .forEach(el => { const t = el.textContent.trim(); if (t && !t.includes('×')) labels.push(t); });

        results.push({ id: m[1], name, description: desc, labels });
      });
      return results;
    }, [...seen]);

    batch.forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); tests.push(t); } });
    if (step % 5 === 0 && tests.length > 0) process.stdout.write(`\r  Scraped ${tests.length} tests…`);
    if (totalRows > 0 && tests.length >= totalRows) break;
  }

  console.log(`\n  Found ${tests.length} tests`);
  return tests;
}

// ── Step 2: Save metadata JSON files ─────────────────────────────────────────
function saveMetadata(tests) {
  console.log(`\n[2/3] Saving metadata for ${tests.length} tests…`);
  const metas = [];
  for (const t of tests) {
    const fname = toFilename(t.name);
    const out   = path.join(STEPS_DIR, fname + '.json');

    if (!FORCE && fs.existsSync(out)) {
      metas.push(JSON.parse(fs.readFileSync(out, 'utf8')));
      continue;
    }

    const baseURL = `https://app.testim.io/#/project/${PROJECT_ID}/branch/${BRANCH}/test/${t.id}`;
    // Ensure LABEL_NAME is in labels
    const labels = t.labels.length ? t.labels : [LABEL_NAME];
    if (!labels.includes(LABEL_NAME)) labels.unshift(LABEL_NAME);

    const meta = {
      id:                  t.id,
      name:                t.name,
      labels,
      status:              'active',
      description:         t.description || '',
      owner:               '',
      createdAt:           null,
      updatedAt:           null,
      testimURL:           baseURL,
      playwrightExportURL: baseURL + '?embedMode=true&exportPlaywright=true',
      lastResult:          null,
      steps:               [],
    };

    fs.writeFileSync(out, JSON.stringify(meta, null, 2));
    metas.push(meta);
    console.log(`  SAVED  ${t.name}`);
  }
  return metas;
}

// ── Step 3: Download Playwright code + screenshots ────────────────────────────
async function downloadAll(metas, page) {
  console.log(`\n[3/3] Downloading Playwright code${SKIP_SHOTS ? '' : ' + screenshots'}…`);
  let ok = 0, warn = 0, skip = 0, err = 0;

  for (let i = 0; i < metas.length; i++) {
    const meta  = metas[i];
    const fname = toFilename(meta.name);
    const tsFile  = path.join(TESTS_DIR, fname + '.ts');
    const pngFile = path.join(SHOTS_DIR, fname + '.png');
    const lbl     = `[${String(i + 1).padStart(3)}/${metas.length}]`;

    const needCode = FORCE || !fs.existsSync(tsFile);
    const needShot = !SKIP_SHOTS && (FORCE || !fs.existsSync(pngFile));

    if (!needCode && !needShot) { process.stdout.write(`${lbl} SKIP  ${meta.name}\n`); skip++; continue; }

    try {
      if (needCode && meta.playwrightExportURL) {
        await page.goto('about:blank');
        await page.goto(meta.playwrightExportURL, { waitUntil: 'load', timeout: 20000 });
        await page.waitForFunction(
          () => { const t = document.querySelector('textarea.inputarea'); return t && t.value.length > 50; },
          { timeout: 10000 }
        ).catch(() => {});
        const code = await page.evaluate(() => window.monaco?.editor?.getModels()[0]?.getValue() || null);

        if (code && code.length > 50) {
          fs.writeFileSync(tsFile,
            `// ${meta.name}\n// ID: ${meta.id}\n// Labels: ${meta.labels.join(', ')}\n\n${code}\n`);
          process.stdout.write(`${lbl} CODE  ${meta.name}\n`);
          ok++;
        } else {
          fs.writeFileSync(tsFile,
            `// ${meta.name}\n// ID: ${meta.id}\n// Source: ${meta.playwrightExportURL}\n// NOTE: Could not extract code.\n`);
          process.stdout.write(`${lbl} WARN  ${meta.name}\n`);
          warn++;
        }
      }

      if (needShot && meta.testimURL) {
        await page.goto('about:blank');
        await page.goto(meta.testimURL, { waitUntil: 'load', timeout: 20000 });
        await page.waitForTimeout(2500);
        await page.screenshot({ path: pngFile, fullPage: false });
        if (!needCode) process.stdout.write(`${lbl} SHOT  ${meta.name}\n`);
      }
    } catch (e) {
      process.stdout.write(`${lbl} ERR   ${meta.name} — ${e.message}\n`);
      err++;
    }
  }

  console.log(`\nCode — OK: ${ok}  Warn: ${warn}  Skip: ${skip}  Err: ${err}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== Scrape label: ${LABEL_NAME} → ${OUT_NAME}/ ===`);
  console.log(`    Project: ${PROJECT_ID}  Branch: ${BRANCH}`);

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ storageState: SESSION, viewport: { width: 1440, height: 900 } });
  const page    = await ctx.newPage();

  const rawTests = await scrapeTestList(page);
  if (!rawTests.length) {
    console.log('No tests found — check the URL and session.json.');
    await browser.close(); process.exit(1);
  }

  const metas = saveMetadata(rawTests);
  await downloadAll(metas, page);
  await browser.close();

  console.log(`\nDone! Now run: node generate-viewer.js`);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
