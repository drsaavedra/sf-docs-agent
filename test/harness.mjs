// Runs a temp copy of fetch-docs.mjs beside a stub playwright-core, which resolves first.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fetch-docs.mjs');
const dirs = [];
process.on('exit', () => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));
export const tempDir = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

// prepare gets the cache dir before the run. The timeout bounds a wedged browser, and a run it kills throws, so it cannot read as a pass.
export const withStub = (source, env, prepare, ...args) => {
  const dir = tempDir('sf-docs-stub-'), mod = join(dir, 'node_modules/playwright-core'), out = join(dir, 'cache');
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, 'package.json'), '{"name":"playwright-core","type":"module","main":"index.mjs"}');
  writeFileSync(join(mod, 'index.mjs'), source);
  copyFileSync(SCRIPT, join(dir, 'fetch-docs.mjs'));
  prepare?.(out);
  const r = spawnSync(process.execPath, [join(dir, 'fetch-docs.mjs'), '--out', out, ...args],
    { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', env: { ...process.env, SF_DOCS_CACHE_HOURS: '', ...env } });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr, cache: out };
};

// The real script with no browser to find: a cached test that stops hitting the cache fails at once, not on a live site.
export const NO_BROWSER = { SF_DOCS_CACHE_HOURS: '', PLAYWRIGHT_BROWSERS_PATH: join(tmpdir(), 'no-browser-here') };
