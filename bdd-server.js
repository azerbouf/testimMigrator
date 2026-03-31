/**
 * bdd-server.js — local proxy so the viewer's "Reanalyze with AI" button
 * can call Claude via the CLI without needing an Anthropic API key in the browser.
 *
 * Usage: node bdd-server.js
 * Then open viewer.html — the Reanalyze button will work automatically.
 */

const http         = require('http');
const { spawnSync } = require('child_process');

const PORT = 3458;

function callClaude(prompt) {
  const result = spawnSync('claude', ['-p', '--model', 'haiku', prompt], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 90000,
  });
  if (result.error) throw new Error('claude CLI error: ' + result.error.message);
  if (result.status !== 0) throw new Error((result.stderr || 'claude exited ' + result.status).trim());
  return result.stdout.trim();
}

function buildPrompt(name, description, code) {
  const snippet = code.length > 12000 ? code.slice(0, 12000) + '\n// [truncated]' : code;
  return `You are a QA engineer writing BDD specs. Given this Playwright test code, produce a clean Gherkin scenario.

Test name: ${name}
${description ? 'Description: ' + description : ''}

\`\`\`typescript
${snippet}
\`\`\`

Rules:
- Output ONLY the Gherkin text, no explanations, no markdown fences
- Feature name should describe the capability being tested
- Scenario name = the test name exactly
- Steps must be plain English — no selectors, no variable names, no code
- Given = preconditions / login / navigation
- When = user actions
- Then = expected outcomes / assertions
- Use And to continue the same keyword
- Keep each step concise (max ~12 words)
- Max 18 steps total`;
}

const server = http.createServer((req, res) => {
  // CORS — allow the viewer served on any localhost port
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/analyze') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400); res.end('Bad JSON'); return;
      }

      const { name, description, code } = payload;
      console.log(`[BDD] Generating: ${name}`);

      try {
        const gherkin = callClaude(buildPrompt(name || '', description || '', code || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ gherkin }));
        console.log(`[BDD] Done:       ${name}`);
      } catch (e) {
        console.error(`[BDD] Error:      ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`BDD server running at http://localhost:${PORT}`);
  console.log('Keep this terminal open, then use the Reanalyze button in the viewer.\n');
});
