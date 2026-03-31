/**
 * enrich-wp-descriptions.js
 * Visits each Web Platform test page and fills in the missing description.
 *
 * Usage: node enrich-wp-descriptions.js
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SESSION = path.join(__dirname, 'session.json');
const WP_DIR  = path.join(__dirname, 'WebPlatform');

if (!fs.existsSync(SESSION)) { console.error('session.json not found'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Collect all metadata files that have an empty description
function collectMetas() {
  const metas = [];
  for (const label of fs.readdirSync(WP_DIR)) {
    const stepsDir = path.join(WP_DIR, label, 'tests_with_steps');
    if (!fs.existsSync(stepsDir)) continue;
    for (const f of fs.readdirSync(stepsDir).filter(f => f.endsWith('.json'))) {
      const fpath = path.join(stepsDir, f);
      const meta  = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      if (!meta.description && meta.testimURL) {
        metas.push({ fpath, meta });
      }
    }
  }
  return metas;
}

(async () => {
  const metas = collectMetas();
  console.log(`Found ${metas.length} WP tests with no description. Fetching…\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ storageState: SESSION, viewport: { width: 1440, height: 900 } });
  const page    = await ctx.newPage();

  let filled = 0, empty = 0;

  for (let i = 0; i < metas.length; i++) {
    const { fpath, meta } = metas[i];
    const lbl = `[${String(i + 1).padStart(3)}/${metas.length}]`;

    try {
      await page.goto(meta.testimURL, { waitUntil: 'load', timeout: 20000 });
      await sleep(1500);

      const desc = await page.evaluate(() => {
        // Try common description selectors on the test detail page
        const selectors = [
          '[class*="description"] input',
          '[class*="description"] textarea',
          '[placeholder*="description" i]',
          '[placeholder*="Description" i]',
          '[class*="TestDescription"]',
          '[class*="test-description"]',
          '[data-testid*="description"]',
          '[class*="descriptionInput"]',
          '[class*="description_input"]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const val = el.value || el.textContent || el.getAttribute('value') || '';
            if (val.trim()) return val.trim();
          }
        }

        // Fallback: look for any element whose text looks like a description
        // (non-empty, not the test name, short paragraph)
        const candidates = document.querySelectorAll(
          '[class*="description"], [class*="subtitle"], [class*="desc"]:not([class*="label"])'
        );
        for (const el of candidates) {
          const txt = el.textContent.trim();
          if (txt && txt.length > 5 && txt.length < 300) return txt;
        }
        return '';
      });

      if (desc) {
        meta.description = desc;
        fs.writeFileSync(fpath, JSON.stringify(meta, null, 2));
        process.stdout.write(`${lbl} OK    ${meta.name} → "${desc.slice(0, 60)}…"\n`);
        filled++;
      } else {
        process.stdout.write(`${lbl} EMPTY ${meta.name}\n`);
        empty++;
      }
    } catch (e) {
      process.stdout.write(`${lbl} ERR   ${meta.name} — ${e.message}\n`);
      empty++;
    }

    await sleep(300);
  }

  await browser.close();
  console.log(`\nDone — filled: ${filled}, still empty: ${empty}`);
  if (filled > 0) console.log('Now run: node generate-viewer.js');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
