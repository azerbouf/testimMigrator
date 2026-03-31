/**
 * scrape-web-platform.js — scrape Web Platform tests from Testim UI (no API needed)
 *
 * Uses session.json + Playwright to:
 *   1. Load the tests list page in the browser
 *   2. Scrape all test names, IDs, labels
 *   3. Download Playwright code + screenshots
 *   4. Save metadata JSON files
 *
 * Output: WebPlatform/<LabelName>/tests/           ← .ts files
 *         WebPlatform/<LabelName>/tests_with_steps/ ← .json metadata
 *         WebPlatform/<LabelName>/Steps_Screenshots/ ← .png files
 *
 * Usage:
 *   node scrape-web-platform.js
 *   node scrape-web-platform.js --skip-screenshots
 *   node scrape-web-platform.js --force
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const PROJECT_ID = 'F1xuQHB9ELMNdkBRhxrZ';
const BRANCH     = 'master';
const BASE       = __dirname;
const SESSION    = path.join(BASE, 'session.json');
const OUT_DIR    = path.join(BASE, 'WebPlatform');

const SKIP_SHOTS = process.argv.includes('--skip-screenshots');
const FORCE      = process.argv.includes('--force');

const TESTS_LIST_URL = `https://app.testim.io/#/project/${PROJECT_ID}/branch/${BRANCH}/automate/tests?testStatus=draft%3Bactive`;

if (!fs.existsSync(SESSION)) {
  console.error('ERROR: session.json not found.');
  process.exit(1);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toFilename(name) {
  return name.replace(/[^a-zA-Z0-9 \-_]/g, '').replace(/\s+/g, '_').trim().substring(0, 120);
}

// ── Extract visible rows from current DOM state ───────────────────────────────
async function extractVisibleRows(page, seen) {
  return page.evaluate((seenIds) => {
    const results = [];

    // Each row has class containing "TestListRow_row"
    const rows = document.querySelectorAll('[class*="TestListRow_row"]');

    rows.forEach(row => {
      // Test ID from the runs link: href="...runs/tests?testId=XXX"
      const link = row.querySelector('a[href*="testId="]');
      if (!link) return;
      const href  = link.getAttribute('href') || '';
      const match = href.match(/testId=([a-zA-Z0-9_-]+)/);
      if (!match) return;
      const testId = match[1];
      if (seenIds.includes(testId)) return;

      // Name: inside multiRowColumn span
      const nameEl = row.querySelector('[class*="multiRowColumn"] span, [class*="multiRowColumn"]');
      const name   = nameEl ? nameEl.textContent.trim() : '';
      if (!name) return;

      // Labels: CollapsibleLabels list items
      const labels = [];
      row.querySelectorAll('[class*="CollapsibleLabels_list"] li span, [class*="CollapsibleLabels"] li span').forEach(el => {
        const txt = el.textContent.trim();
        if (txt && !txt.includes('×')) labels.push(txt);
      });

      // Description: look for a secondary text row inside multiRowColumn
      let description = '';
      const descEl = row.querySelector('[class*="multiRowColumn"] [class*="desc"], [class*="multiRowColumn"] [class*="sub"], [class*="description"]');
      if (descEl) description = descEl.textContent.trim();

      results.push({ id: testId, name, labels, description });
    });

    return results;
  }, [...seen]);
}

// ── Step 1: Scrape test list from Testim UI ───────────────────────────────────
async function scrapeTestList(page) {
  console.log('\n[1/3] Loading Testim test list…');
  await page.goto(TESTS_LIST_URL, { waitUntil: 'load', timeout: 30000 });

  // Wait for the virtual list to render first rows
  await page.waitForSelector('[class*="TestListRow_row"]', { timeout: 20000 })
    .catch(() => console.log('  (waiting for rows timed out — continuing anyway)'));
  await sleep(2000);

  // Get total row count from virtual scroll container height
  const totalRows = await page.evaluate(() => {
    const container = document.querySelector('[role="rowgroup"]');
    if (!container) return 0;
    const h = parseInt(container.style.height) || container.scrollHeight;
    return Math.round(h / 60); // each row is 60px tall
  });
  console.log(`  Virtual list reports ~${totalRows} total tests`);

  // Find the scrollable viewport
  const scrollable = await page.evaluate(() => {
    // Walk up from a row to find the scrollable ancestor
    const row = document.querySelector('[class*="TestListRow_row"]');
    if (!row) return null;
    let el = row.parentElement;
    while (el) {
      const style = window.getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' || el.scrollHeight > el.clientHeight + 50) {
        return el.className.split(' ')[0]; // return first class to identify it
      }
      el = el.parentElement;
    }
    return null;
  });
  console.log(`  Scroll container class prefix: ${scrollable || '(none found, using window)'}`);

  // Scroll through virtual list capturing rows at each step
  const seen   = new Set();
  const tests  = [];
  const rowHeight = 60;
  const steps  = Math.ceil(totalRows / 10) + 5; // scroll in ~10-row increments

  for (let step = 0; step <= steps; step++) {
    const scrollTo = step * rowHeight * 10;

    await page.evaluate((y) => {
      // Try all likely scroll containers
      const selectors = [
        '[class*="ListView_viewport"]',
        '[class*="ListView_scroll"]',
        '[class*="virtual-scroll"]',
        '[class*="AutoSizer"]',
        '[class*="ListView"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight) {
          el.scrollTop = y;
          return;
        }
      }
      // Fallback: scroll the deepest scrollable ancestor of the rows
      const row = document.querySelector('[class*="TestListRow_row"]');
      if (row) {
        let el = row.parentElement;
        while (el) {
          if (el.scrollHeight > el.clientHeight + 50) { el.scrollTop = y; return; }
          el = el.parentElement;
        }
      }
      window.scrollTo(0, y);
    }, scrollTo);

    await sleep(600);

    const batch = await extractVisibleRows(page, [...seen]);
    batch.forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); tests.push(t); } });

    if (step % 5 === 0 && tests.length > 0) {
      process.stdout.write(`\r  Scraped ${tests.length} tests…`);
    }

    // Stop if we have all tests
    if (totalRows > 0 && tests.length >= totalRows) break;
  }

  console.log(`\n  Found ${tests.length} tests in DOM`);

  if (tests.length === 0) {
    console.log('\n  DOM extraction found 0 tests. Dumping page source for debugging…');
    const html = await page.content();
    fs.writeFileSync(path.join(BASE, 'debug-testim-page.html'), html);
    console.log('  Saved to debug-testim-page.html');
  }

  return tests;
}

// ── Step 2: Save metadata JSON files ─────────────────────────────────────────
function saveMetadata(tests) {
  console.log(`\n[2/3] Saving metadata for ${tests.length} tests…`);
  const metas = [];

  for (const t of tests) {
    const label = (t.labels && t.labels[0]) || 'Unlabeled';
    const stepsDir = path.join(OUT_DIR, label, 'tests_with_steps');
    const testsDir = path.join(OUT_DIR, label, 'tests');
    const shotsDir = path.join(OUT_DIR, label, 'Steps_Screenshots');
    for (const d of [stepsDir, testsDir, shotsDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    const fname = toFilename(t.name);
    const out   = path.join(stepsDir, fname + '.json');

    if (!FORCE && fs.existsSync(out)) {
      metas.push({ ...JSON.parse(fs.readFileSync(out, 'utf8')), _label: label });
      continue;
    }

    const baseURL = `https://app.testim.io/#/project/${PROJECT_ID}/branch/${BRANCH}/test/${t.id}`;
    const meta = {
      id:                 t.id,
      name:               t.name,
      labels:             t.labels || [],
      status:             'active',
      description:        t.description || '',
      owner:              '',
      createdAt:          null,
      updatedAt:          null,
      testimURL:          baseURL,
      playwrightExportURL: baseURL + '?embedMode=true&exportPlaywright=true',
      lastResult:         null,
      steps:              [],
    };

    fs.writeFileSync(out, JSON.stringify(meta, null, 2));
    metas.push({ ...meta, _label: label });
    console.log(`  SAVED  ${t.name} [${label}]`);
  }

  return metas;
}

// ── Step 3: Download Playwright code + screenshots ────────────────────────────
async function downloadAll(metas, page) {
  console.log(`\n[3/3] Downloading Playwright code${SKIP_SHOTS ? '' : ' + screenshots'}…`);

  let ok = 0, warn = 0, skip = 0, err = 0;

  for (let i = 0; i < metas.length; i++) {
    const meta  = metas[i];
    const label = meta._label;
    const fname = toFilename(meta.name);
    const tsFile  = path.join(OUT_DIR, label, 'tests', fname + '.ts');
    const pngFile = path.join(OUT_DIR, label, 'Steps_Screenshots', fname + '.png');
    const lbl     = `[${String(i + 1).padStart(3)}/${metas.length}]`;

    const needCode = FORCE || !fs.existsSync(tsFile);
    const needShot = !SKIP_SHOTS && (FORCE || !fs.existsSync(pngFile));

    if (!needCode && !needShot) {
      process.stdout.write(`${lbl} SKIP  ${meta.name}\n`);
      skip++; continue;
    }

    try {
      // Playwright code
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
            `// ${meta.name}\n// ID: ${meta.id}\n// Labels: ${(meta.labels || []).join(', ')}\n\n${code}\n`);
          process.stdout.write(`${lbl} CODE  ${meta.name}\n`);
          ok++;
        } else {
          fs.writeFileSync(tsFile,
            `// ${meta.name}\n// ID: ${meta.id}\n// Source: ${meta.playwrightExportURL}\n// NOTE: Could not extract code.\n`);
          process.stdout.write(`${lbl} WARN  ${meta.name}\n`);
          warn++;
        }
      }

      // Screenshot
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
  console.log(`\n=== Scrape Web Platform: ${PROJECT_ID} ===`);

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ storageState: SESSION, viewport: { width: 1440, height: 900 } });
  const page    = await ctx.newPage();

  const rawTests = await scrapeTestList(page);

  if (rawTests.length === 0) {
    console.log('\nNo tests found — check debug-testim-page.html to see the DOM structure.');
    await browser.close();
    process.exit(1);
  }

  const metas = saveMetadata(rawTests);
  await downloadAll(metas, page);

  await browser.close();
  console.log('\nDone! Now run: node generate-viewer.js');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
