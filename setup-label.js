/**
 * setup-label.js — full pipeline for any Testim label
 *
 * Fetches tests, exports metadata, downloads Playwright code, takes screenshots.
 * Creates a self-contained folder:  ./<LabelName>/
 *
 * Usage:
 *   node setup-label.js Meetings_Regressions
 *   node setup-label.js Correspondence_Regression
 *   node setup-label.js Meetings_Regressions --skip-screenshots
 *   node setup-label.js Meetings_Regressions --force          (re-download everything)
 */

const { chromium } = require('playwright');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const API_KEY    = process.env.TESTIM_API_KEY || '';
const PROJECT_ID = 'ZjFhC0Egb1SW3sAcn5HE';
const BRANCH     = 'master';
const BASE       = __dirname;
const SESSION    = path.join(BASE, 'session.json');

const LABEL          = process.argv[2];
const SKIP_SHOTS     = process.argv.includes('--skip-screenshots');
const FORCE          = process.argv.includes('--force');

if (!LABEL) {
  console.error('Usage: node setup-label.js <LabelName>');
  process.exit(1);
}

const DIR       = path.join(BASE, LABEL);
const STEPS_DIR = path.join(DIR, 'tests_with_steps');
const TESTS_DIR = path.join(DIR, 'tests');
const SHOTS_DIR = path.join(DIR, 'Steps_Screenshots');

for (const d of [DIR, STEPS_DIR, TESTS_DIR, SHOTS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toFilename(name) {
  return name.replace(/[^a-zA-Z0-9 \-_]/g, '').replace(/\s+/g, '_').trim().substring(0, 120);
}

function apiGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.testim.io',
      path: urlPath,
      method: 'GET',
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error (${urlPath}): ${body.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Step 1: Fetch test list for this label ────────────────────────────────────
async function fetchTestList() {
  console.log(`\n[1/3] Fetching tests with label "${LABEL}" from Testim API…`);

  // API returns all tests in one shot (ignores pagination params)
  const data  = await apiGet(`/tests?project=${PROJECT_ID}&branch=${BRANCH}`);
  const items = Array.isArray(data) ? data : (data.tests || data.data || []);

  // Normalise id: API returns _id
  const normalised = items.map(t => ({ ...t, id: t.id || t._id }));

  // Case-insensitive label match (user may type Meetings_Regressions vs Meetings_Regression)
  const matching = normalised.filter(t =>
    (t.labels || []).some(l => l.toLowerCase() === LABEL.toLowerCase())
  );

  // If exact match fails, try prefix match (e.g. Meetings_Regressions → Meetings_Regression)
  if (!matching.length) {
    const loose = normalised.filter(t =>
      (t.labels || []).some(l =>
        l.toLowerCase().startsWith(LABEL.toLowerCase().replace(/s$/, ''))
      )
    );
    if (loose.length) {
      console.log(`  (no exact match; using prefix match — ${loose.length} tests)`);
      return loose;
    }
  }

  return matching;
}

// ── Step 2: Export metadata for each test ─────────────────────────────────────
async function exportMetadata(tests) {
  console.log(`\n[2/3] Exporting metadata for ${tests.length} tests…`);
  const list = [];

  for (let i = 0; i < tests.length; i++) {
    const t     = tests[i];
    const label = `[${String(i + 1).padStart(3)}/${tests.length}]`;
    const fname = toFilename(t.name);
    const out   = path.join(STEPS_DIR, fname + '.json');

    if (!FORCE && fs.existsSync(out)) {
      process.stdout.write(`${label} SKIP  ${t.name}\n`);
      list.push(JSON.parse(fs.readFileSync(out)));
      continue;
    }

    try {
      const tid = t.id || t._id;
      process.stdout.write(`${label} META  ${t.name}`);
      const detail = await apiGet(`/tests/${tid}?branch=${BRANCH}`);
      await sleep(250);

      const meta = {
        id:   tid,
        name: t.name,
        labels: t.labels || [],
        status:      detail.status,
        description: detail.description || '',
        owner:       detail.owner || '',
        createdAt:   detail.createdAt,
        updatedAt:   detail.updatedAt,
        testimURL:            detail.testimTestURL ||
          `https://app.testim.io/#/project/${PROJECT_ID}/branch/${BRANCH}/test/${tid}`,
        playwrightExportURL:  (detail.testimTestURL ||
          `https://app.testim.io/#/project/${PROJECT_ID}/branch/${BRANCH}/test/${tid}`) +
          '?embedMode=true&exportPlaywright=true',
        lastResult: detail.latestTestResult?.[0] || null,
        steps: [],
      };

      // Try to get steps from last run
      const resultId = detail.latestTestResult?.[0]?.resultId;
      if (resultId) {
        try {
          const run = await apiGet(`/runs/tests/${resultId}?stepsResults=true`);
          await sleep(250);
          meta.steps = (run.testResult?.stepsResults || []).map(s => ({
            name: s.name, type: s.type, status: s.status,
            duration: s.duration, sharedStep: s.sharedStep,
          }));
          process.stdout.write(` (${meta.steps.length} steps)\n`);
        } catch { process.stdout.write(` (no steps)\n`); }
      } else {
        process.stdout.write('\n');
      }

      fs.writeFileSync(out, JSON.stringify(meta, null, 2));
      list.push(meta);
    } catch (e) {
      process.stdout.write(` ERR: ${e.message}\n`);
    }

    await sleep(200);
  }

  return list;
}

// ── Step 3: Download Playwright code + screenshots ────────────────────────────
async function downloadAll(metas) {
  console.log(`\n[3/3] Downloading Playwright code${SKIP_SHOTS ? '' : ' + screenshots'}…`);
  if (!fs.existsSync(SESSION)) {
    console.error('ERROR: session.json not found — run the main login first.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({
    storageState: SESSION,
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  let ok = 0, warn = 0, skip = 0, err = 0;

  for (let i = 0; i < metas.length; i++) {
    const meta  = metas[i];
    const fname = toFilename(meta.name);
    const tsFile  = path.join(TESTS_DIR, fname + '.ts');
    const pngFile = path.join(SHOTS_DIR, fname + '.png');
    const label   = `[${String(i + 1).padStart(3)}/${metas.length}]`;

    const needCode = FORCE || !fs.existsSync(tsFile);
    const needShot = !SKIP_SHOTS && (FORCE || !fs.existsSync(pngFile));

    if (!needCode && !needShot) {
      process.stdout.write(`${label} SKIP  ${meta.name}\n`);
      skip++; continue;
    }

    try {
      // Playwright code
      if (needCode && meta.playwrightExportURL) {
        await page.goto('about:blank');
        await page.goto(meta.playwrightExportURL, { waitUntil: 'load', timeout: 15000 });
        await page.waitForFunction(
          () => { const t = document.querySelector('textarea.inputarea'); return t && t.value.length > 50; },
          { timeout: 8000 }
        ).catch(() => {});
        const code = await page.evaluate(() => window.monaco?.editor?.getModels()[0]?.getValue() || null);

        if (code && code.length > 50) {
          fs.writeFileSync(tsFile,
            `// ${meta.name}\n// ID: ${meta.id}\n// Labels: ${(meta.labels||[]).join(', ')}\n\n${code}\n`);
          process.stdout.write(`${label} CODE  ${meta.name}\n`);
          ok++;
        } else {
          fs.writeFileSync(tsFile,
            `// ${meta.name}\n// ID: ${meta.id}\n// Source: ${meta.playwrightExportURL}\n// NOTE: Could not extract code — open URL manually.\n`);
          process.stdout.write(`${label} WARN  ${meta.name} (no code)\n`);
          warn++;
        }
      }

      // Screenshot
      if (needShot && meta.testimURL) {
        await page.goto('about:blank');
        await page.goto(meta.testimURL, { waitUntil: 'load', timeout: 15000 });
        await page.waitForTimeout(2500);
        await page.screenshot({ path: pngFile, fullPage: false });
        if (!needCode) process.stdout.write(`${label} SHOT  ${meta.name}\n`);
      }

    } catch (e) {
      process.stdout.write(`${label} ERR   ${meta.name} — ${e.message}\n`);
      err++;
    }
  }

  await browser.close();
  console.log(`\nCode — OK: ${ok}  Warn: ${warn}  Skip: ${skip}  Err: ${err}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== Setup label: ${LABEL} ===`);
  console.log(`Output: ${DIR}/`);

  const rawTests = await fetchTestList();
  console.log(`Found ${rawTests.length} tests with label "${LABEL}"`);

  if (!rawTests.length) {
    console.log('No tests found. Check the label name (case-sensitive) and API key.');
    process.exit(0);
  }

  const metas = await exportMetadata(rawTests);
  await downloadAll(metas);

  console.log(`\nDone! Now run: node generate-viewer.js`);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
