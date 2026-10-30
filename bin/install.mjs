#!/usr/bin/env node
// npx sf-docs-agent [--project] [--yes]: install the sf-docs subagent for Claude Code.
// The runtime (script, playwright-core, cache home) is always user-level; only the agent file follows the scope.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const project = process.argv.includes('--project');
const runtime = join(config, 'sf-docs');
const agents = project ? resolve('.claude', 'agents') : join(config, 'agents');

mkdirSync(runtime, { recursive: true });
cpSync(join(pkg, 'fetch-docs.mjs'), join(runtime, 'fetch-docs.mjs'));
// A devDependency: npx would otherwise download playwright-core once for the installer and again for the runtime.
const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).devDependencies['playwright-core'];
writeFileSync(join(runtime, 'package.json'),
  JSON.stringify({ private: true, type: 'module', dependencies: { 'playwright-core': version } }, null, 2) + '\n');
console.log(`Installing playwright-core ${version} in ${runtime}`);
// A shell command string: on Windows npm is npm.cmd, which Node only spawns through a shell (CVE-2024-27980),
// and args alongside shell: true are deprecated (DEP0190). The args are constants, so nothing needs quoting.
try {
  execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: runtime, stdio: 'inherit' });
} catch {
  // npm has already printed why; the agent is not installed yet, so a rerun starts clean.
  console.error('\nnpm install failed (see above). The agent was not installed. Run the same command again once npm works.');
  process.exit(1);
}
// The browser is the one large download, so it is never fetched without consent: ask at a terminal, take --yes in
// scripts, and otherwise print the command. If Chromium is missing at first use, the agent reports BLOCKED.
const cli = join(runtime, 'node_modules/playwright-core/cli.js');
let present = false;
try {
  const { chromium } = await import(pathToFileURL(join(runtime, 'node_modules/playwright-core/index.mjs')).href);
  await (await chromium.launch({ headless: true })).close();
  present = true;
} catch { /* launch failing is the signal that the browser is missing */ }
const ask = async q => {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q).catch(() => ''); // Ctrl+D or closed input means no
  rl.close();
  return /^y(es)?$/i.test(a.trim());
};
if (present) console.log('Headless Chromium is already installed.');
else if (process.argv.includes('--yes') || await ask('Download headless Chromium (about 180 MB)? [y/N] ')) {
  try { execFileSync(process.execPath, [cli, 'install', '--only-shell', 'chromium'], { stdio: 'inherit' }); }
  catch { console.error(`\nBrowser download failed (see above). Retry later with:\n  node "${cli}" install --only-shell chromium`); }
} else console.log(`Skipped the browser download. Before first use, run:\n  node "${cli}" install --only-shell chromium`);

// Point the agent at the installed script. rm first: a symlinked agent file would otherwise be written through.
// The source names its own checkout dir (script and cache); swap every occurrence for the runtime dir.
const source = readFileSync(join(pkg, 'agents/sf-docs.md'), 'utf8');
const devDir = source.match(/node "([^"]+)\/fetch-docs\.mjs"/)[1];
// Forward slashes: the agent runs these paths in Git Bash on Windows, where a backslash is an escape. A function
// replacement, so a $ in the path is taken literally.
const agent = source.replaceAll(devDir, () => runtime.replaceAll('\\', '/'));
mkdirSync(agents, { recursive: true });
rmSync(join(agents, 'sf-docs.md'), { force: true });
writeFileSync(join(agents, 'sf-docs.md'), agent);
console.log(`Installed agent: ${join(agents, 'sf-docs.md')}\nUse subagent_type "sf-docs". If it is not listed yet, start a new Claude Code session.`);
