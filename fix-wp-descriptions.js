/**
 * fix-wp-descriptions.js
 * Re-scrapes the WP test list to pick up the second <span> in multiRowColumn
 * (the description/subtitle) and updates all metadata JSON files.
 *
 * Usage: node fix-wp-descriptions.js
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const PROJECT_ID = 'F1xuQHB9ELMNdkBRhxrZ';
const BRANCH     = 'master';
const SESSION    = path.join(__dirname, 'session.json');
const WP_DIR     = path.join(__dirname, 'WebPlatform');
const TESTS_LIST_URL = `https://app.testim.io/#/project/${PROJECT_ID}/branch/${BRANCH}/automate/tests?testStatus=draft%3Bactive`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Scrape the full test list extracting id → description
async function scrapeDescriptions(page) {
  console.log('Loading test list…');
  await page.goto(TESTS_LIST_URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('[class*="TestListRow_row"]', { timeout: 20000 });
  await sleep(2000);

  const totalRows = await page.evaluate(() => {
    const c = document.querySelector('[role="rowgroup"]');
    return c ? Math.round((parseInt(c.style.height) || c.scrollHeight) / 60) : 0;
  });
  console.log(`~${totalRows} total tests`);

  const descMap = {}; // testId → description
  const seen    = new Set();
  const steps   = Math.ceil(totalRows / 10) + 5;

  for (let step = 0; step <= steps; step++) {
    const scrollTo = step * 60 * 10;
    await page.evaluate(y => {
      const el = document.querySelector('[class*="ReactVirtualized__Grid"], [class*="ListView_viewport"]');
      if (el) el.scrollTop = y;
      else {
        const row = document.querySelector('[class*="TestListRow_row"]');
        let p = row?.parentElement;
        while (p) { if (p.scrollHeight > p.clientHeight + 50) { p.scrollTop = y; return; } p = p.parentElement; }
      }
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
        // First span = name, second span = description/subtitle
        const desc = spans.length > 1 ? spans[1].textContent.trim() : '';
        results.push({ id: m[1], description: desc });
      });
      return results;
    }, [...seen]);

    batch.forEach(({ id, description }) => {
      if (!seen.has(id)) { seen.add(id); descMap[id] = description; }
    });

    if (step % 5 === 0) process.stdout.write(`\r  Scraped ${seen.size} tests…`);
    if (totalRows > 0 && seen.size >= totalRows) break;
  }

  console.log(`\nScraped ${seen.size} tests`);
  return descMap;
}

// Update all WP metadata JSON files with descriptions
function applyDescriptions(descMap) {
  let updated = 0, skipped = 0;
  for (const label of fs.readdirSync(WP_DIR)) {
    const stepsDir = path.join(WP_DIR, label, 'tests_with_steps');
    if (!fs.existsSync(stepsDir)) continue;
    for (const f of fs.readdirSync(stepsDir).filter(f => f.endsWith('.json'))) {
      const fpath = path.join(stepsDir, f);
      const meta  = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      const desc  = descMap[meta.id];
      if (desc !== undefined && desc !== meta.description) {
        meta.description = desc;
        fs.writeFileSync(fpath, JSON.stringify(meta, null, 2));
        if (desc) { console.log(`  UPDATED ${meta.name} → "${desc}"`); updated++; }
        else skipped++;
      }
    }
  }
  console.log(`\nUpdated: ${updated}, no description: ${skipped}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ storageState: SESSION, viewport: { width: 1440, height: 900 } });
  const page    = await ctx.newPage();

  const descMap = await scrapeDescriptions(page);
  await browser.close();

  applyDescriptions(descMap);
  console.log('\nDone! Now run: node generate-viewer.js');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
