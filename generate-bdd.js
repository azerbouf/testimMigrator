/**
 * generate-bdd.js — AI BDD generation for all tests
 *
 * Uses the local `claude` CLI (Claude Code) — no API key required.
 * Saves one JSON file per test to ./bdd/<filename>.json
 * Then run `node generate-viewer.js` to bake them into viewer.html.
 *
 * Usage:
 *   node generate-bdd.js           # generate all missing
 *   node generate-bdd.js --force   # regenerate even if already done
 *   node generate-bdd.js --limit 5 # only do first N (for testing)
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const BDD_DIR  = path.join(__dirname, 'bdd');
const FORCE    = process.argv.includes('--force');
const LIMIT_I  = process.argv.indexOf('--limit');
const LIMIT    = LIMIT_I !== -1 ? parseInt(process.argv[LIMIT_I + 1], 10) : Infinity;

if (!fs.existsSync(BDD_DIR)) fs.mkdirSync(BDD_DIR);

// ── Load all tests (same sources as generate-viewer.js) ─────────────────────
function src(label) {
  return { testsDir: path.join(__dirname, label, 'tests'), stepsDir: path.join(__dirname, label, 'tests_with_steps') };
}

const SOURCES = [
  { testsDir: path.join(__dirname, 'tests'), stepsDir: path.join(__dirname, 'tests_with_steps') },
  src('RFIs_Notifications'),
  src('Meetings_Regressions'),
  src('Correspondence_Regression'),
  src('Schedule_Regression'),
  src('Schedule_WorkPlan_Regression'),
  src('Schedule_Notifications'),
  src('Schedule_WorkPlan_Sanity'),
].filter(s => fs.existsSync(s.testsDir));

const seen = new Set();
const allTests = SOURCES.flatMap(src =>
  fs.readdirSync(src.testsDir).filter(f => f.endsWith('.ts')).map(fname => {
    const code    = fs.readFileSync(path.join(src.testsDir, fname), 'utf8');
    const jsonP   = path.join(src.stepsDir, fname.replace('.ts', '.json'));
    const meta    = fs.existsSync(jsonP) ? JSON.parse(fs.readFileSync(jsonP)) : {};
    const isStub  = code.includes('open URL manually') || code.includes('implement based on steps');
    return { fname, code, meta, isStub, id: meta.id || fname };
  })
).filter(t => {
  if (seen.has(t.id)) return false;
  seen.add(t.id);
  return true;
}).sort((a, b) => (a.meta.name || '').localeCompare(b.meta.name || ''));

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(t) {
  const name = t.meta.name || t.fname.replace(/_/g,' ').replace('.ts','');
  const desc = t.meta.description || '';
  const code = t.code.length > 12000 ? t.code.slice(0, 12000) + '\n// [truncated]' : t.code;

  return `You are a QA engineer writing BDD specs. Given this Playwright test code, produce a clean Gherkin scenario.

Test name: ${name}
${desc ? 'Description: ' + desc : ''}

\`\`\`typescript
${code}
\`\`\`

Rules:
- Output ONLY the Gherkin text, no explanations, no markdown fences
- Feature name should describe the capability being tested (not just the test name)
- Scenario name = the test name exactly
- Steps must be plain English, no selectors, no variable names, no code
- Given = preconditions / login / navigation
- When = user actions
- Then = expected outcomes / assertions
- Use And to continue the same keyword
- Keep each step concise (max ~12 words)
- Max 18 steps total

Example format:
Feature: RFI Activity Card Validation

  Scenario: Verify special characters and long text
    Given I am logged in as Manager
    When I open the RFI project page
    And I create a new RFI
    Then the RFI is created successfully`;
}

// ── Parse Gherkin → rows ──────────────────────────────────────────────────────
function parseGherkin(text) {
  const KW_CLASS = { Given:'given', When:'when', Then:'then', And:'and', But:'and' };
  const rows = [];
  let featureName = '', scenarioName = '';

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('Feature:'))   { featureName  = line.slice(8).trim();  continue; }
    if (line.startsWith('Scenario:'))  { scenarioName = line.slice(9).trim();  continue; }
    if (line.startsWith('Scenario Outline:')) { scenarioName = line.slice(17).trim(); continue; }
    for (const kw of ['Given','When','Then','And','But']) {
      if (line.startsWith(kw + ' ') || line === kw) {
        rows.push({ kw, kwClass: KW_CLASS[kw], text: line.slice(kw.length).trim() });
        break;
      }
    }
  }
  return { featureName, scenarioName, rows };
}

// ── Call claude CLI ───────────────────────────────────────────────────────────
function callClaude(prompt) {
  const result = spawnSync('claude', ['-p', '--model', 'haiku', prompt], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 60000,
  });
  if (result.error) throw new Error('claude CLI error: ' + result.error.message);
  if (result.status !== 0) throw new Error((result.stderr || 'claude exited with code ' + result.status).trim());
  return result.stdout.trim();
}

// ── Main loop ─────────────────────────────────────────────────────────────────
const total = Math.min(allTests.length, LIMIT);
let ok = 0, skip = 0, err = 0;

console.log(`Generating AI BDD for ${total} tests → ${BDD_DIR}/\n`);

for (let i = 0; i < total; i++) {
  const t     = allTests[i];
  const name  = t.meta.name || t.fname.replace(/_/g,' ').replace('.ts','');
  const label = `[${String(i + 1).padStart(3)}/${total}]`;
  const out   = path.join(BDD_DIR, t.fname.replace('.ts', '.json'));

  if (!FORCE && fs.existsSync(out)) {
    console.log(`${label} SKIP  ${name}`);
    skip++;
    continue;
  }

  if (t.isStub) {
    console.log(`${label} STUB  ${name} (no code, skipping)`);
    skip++;
    continue;
  }

  try {
    const gherkin = callClaude(buildPrompt(t));
    const parsed  = parseGherkin(gherkin);

    if (!parsed.rows.length) {
      console.log(`${label} WARN  ${name} — no steps parsed from output`);
      err++;
      continue;
    }

    fs.writeFileSync(out, JSON.stringify({
      fname:       t.fname,
      name,
      gherkin,
      featureName: parsed.featureName,
      scenarioName: parsed.scenarioName || name,
      rows:        parsed.rows,
      generatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');

    console.log(`${label} OK    ${name}  (${parsed.rows.length} steps)`);
    ok++;
  } catch (e) {
    console.log(`${label} ERR   ${name} — ${e.message}`);
    err++;
  }
}

console.log(`\nDone — OK: ${ok}  Skipped: ${skip}  Errors: ${err}`);
console.log('\nNow run:  node generate-viewer.js');
