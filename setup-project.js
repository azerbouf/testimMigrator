/**
 * setup-project.js — download ALL Active + Draft tests from a Testim project
 *
 * Organises tests under:  ./<outputDir>/<LabelName>/tests/
 *                         ./<outputDir>/<LabelName>/tests_with_steps/
 *                         ./<outputDir>/<LabelName>/Steps_Screenshots/
 *
 * Usage:
 *   node setup-project.js --project F1xuQHB9ELMNdkBRhxrZ --out WebPlatform
 *   node setup-project.js --project F1xuQHB9ELMNdkBRhxrZ --out WebPlatform --skip-screenshots
 *   node setup-project.js --project F1xuQHB9ELMNdkBRhxrZ --out WebPlatform --force
 */

const { chromium } = require('playwright');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const API_KEY = process.env.TESTIM_API_KEY || '';
const BRANCH  = 'master';
const BASE    = __dirname;
const SESSION = path.join(BASE, 'session.json');

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const PROJECT_ID    = getArg('--project');
const OUT_DIR_NAME  = getArg('--out') || 'WebPlatform';
const SKIP_SHOTS    = args.includes('--skip-screenshots');
const FORCE         = args.includes('--force');

if (!PROJECT_ID) {
  console.error('Usage: node setup-project.js --project <projectId> --out <outputDir>');
  process.exit(1);
}

const OUT_DIR = path.join(BASE, OUT_DIR_NAME);
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toFilename(name) {
  return name.replace(/[^a-zA-Z0-9 \-_]/g, '').replace(/\s+/g, '_').trim().substring(0, 120);
}

function apiGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.testim.io', path: urlPath, method: 'GET',
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Step 1: Fetch all Active + Draft tests ────────────────────────────────────
async function fetchTests() {
  console.log(`\n[1/3] Fetching Active/Draft tests from project ${PROJECT_ID}…`);
  const data  = await apiGet(`/tests?project=${PROJECT_ID}&branch=${BRANCH}`);
  const items = Array.isArray(data) ? data : (data.tests || data.data || []);

  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

  const normalised = items.map(t => ({ ...t, id: t.id || t._id }));
  const active = normalised.filter(t =>
    ['active', 'draft'].includes((t.status || '').toLowerCase())
  );
  console.log(`  Found ${normalised.length} total, ${active.length} Active/Draft`);
  return active;
}

// ── Step 2: Export metadata grouped by label ──────────────────────────────────
async function exportMetadata(tests) {
  console.log(`\n[2/3] Exporting metadata for ${tests.length} tests…`);

  // Group by first label (or 'Unlabeled')
  const byLabel = {};
  tests.forEach(t => {
    const label = (t.labels && t.labels[0]) || 'Unlabeled';
    if (!byLabel[label]) byLabel[label] = [];
    byLabel[label].push(t);
  });

  const allMetas = [];
  let i = 0;

  for (const [label, group] of Object.entries(byLabel)) {
    const stepsDir = path.join(OUT_DIR, label, 'tests_with_steps');
    const testsDir = path.join(OUT_DIR, label, 'tests');
    const shotsDir = path.join(OUT_DIR, label, 'Steps_Screenshots');
    for (const d of [stepsDir, testsDir, shotsDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    for (const t of group) {
      i++;
      const lbl   = `[${String(i).padStart(3)}/${tests.length}]`;
      const fname = toFilename(t.name);
      const out   = path.join(stepsDir, fname + '.json');

      if (!FORCE && fs.existsSync(out)) {
        process.stdout.write(`${lbl} SKIP  ${t.name}\n`);
        allMetas.push({ ...JSON.parse(fs.readFileSync(out)), _label: label });
        continue;
      }

      try {
        const tid = t.id;
        process.stdout.write(`${lbl} META  ${t.name}`);
        const detail = await apiGet(`/tests/${tid}?branch=${BRANCH}`);
        await sleep(250);

        const baseURL = detail.testimTestURL ||
          `https://app.testim.io/#/project/${PROJECT_ID}/branch/${BRANCH}/test/${tid}`;

        const meta = {
          id: tid, name: t.name, labels: t.labels || [],
          status: detail.status, description: detail.description || '',
          owner: detail.owner || '', createdAt: detail.createdAt, updatedAt: detail.updatedAt,
          testimURL: baseURL,
          playwrightExportURL: baseURL + '?embedMode=true&exportPlaywright=true',
          lastResult: detail.latestTestResult?.[0] || null,
          steps: [],
        };

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
        allMetas.push({ ...meta, _label: label });
      } catch (e) {
        process.stdout.write(` ERR: ${e.message}\n`);
      }
      await sleep(200);
    }
  }
  return allMetas;
}

// ── Step 3: Download Playwright code + screenshots ────────────────────────────
async function downloadAll(metas) {
  console.log(`\n[3/3] Downloading Playwright code${SKIP_SHOTS ? '' : ' + screenshots'}…`);
  if (!fs.existsSync(SESSION)) {
    console.error('ERROR: session.json not found.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ storageState: SESSION, viewport: { width: 1440, height: 900 } });
  const page    = await ctx.newPage();

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
            `// ${meta.name}\n// ID: ${meta.id}\n// Labels: ${(meta.labels||[]).join(', ')}\n\n${code}\n`);
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

  await browser.close();
  console.log(`\nCode — OK: ${ok}  Warn: ${warn}  Skip: ${skip}  Err: ${err}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== Import project: ${PROJECT_ID} → ${OUT_DIR_NAME}/ ===`);

  const tests = await fetchTests();
  if (!tests.length) {
    console.log('No Active/Draft tests found. Check project ID and API key.');
    process.exit(0);
  }

  const metas = await exportMetadata(tests);
  await downloadAll(metas);

  console.log(`\nDone! Now run: node generate-viewer.js`);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
