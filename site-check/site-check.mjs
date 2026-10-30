#!/usr/bin/env node
// Site check: fetch one page of each kind on a cold cache and compare each result line with baseline.json.
// Usage: node site-check/site-check.mjs [--update]   (exit 1 on drift; the report is markdown on stdout)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'fetch-docs.mjs'), BASE = join(here, 'baseline.json');
// One URL per site and page type, the shells and redirects included: those must keep failing the same way.
const URLS = [
  'https://developer.salesforce.com/docs/llms.txt',
  'https://developer.salesforce.com/docs/platform/lwc/guide/create-light-dom.md',
  'https://architect.salesforce.com/docs/architect/well-architected/guide/trust.md',
  'https://help.salesforce.com/apex/Help_SiteMapIndexExternal?producttype=ai',
  'https://admin.salesforce.com/sitemap_index.xml',
  'https://www.lightningdesignsystem.com/2e1ef8501/p/216f79-toast.md',
  'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getBasket',
  'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
  'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm',
  'https://developer.salesforce.com/docs/atlas.en-us.apexref.meta/apexref/apex_methods_system_string.htm',
  'https://developer.salesforce.com/docs/atlas.en-us.life_sciences_dev_guide.meta/life_sciences_dev_guide/sforce_api_objects_mergerequest.htm',
  'https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_rparobotmaintwindow.htm',
  'https://developer.salesforce.com/docs/atlas.en-us.mobile_sdk.meta/mobile_sdk/android_unauthenticated_rest_requests.htm',
  'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_no_such_topic_xyz.htm',
  'https://developer.salesforce.com/docs/apis',
  'https://help.salesforce.com/s/articleView?id=platform.flow_ref_elements_transform.htm&type=5',
  'https://help.salesforce.com/s/articleView?id=001096524&type=1',
  'https://help.salesforce.com/s/articleView?id=sf.ev_relay_intro.htm&type=5',
  'https://help.salesforce.com/s/articleView?id=platform.no_such_article_xyz.htm&type=5',
  'https://admin.salesforce.com/blog/2025/get-ready-for-changes-to-connected-app-usage-restrictions',
  'https://www.lightningdesignsystem.com/',
  'https://v1.lightningdesignsystem.com/components/toast/',
];
// The pages that must keep being refused: any other unsaved result is an outage, not a reference.
const SHELLS = new Set(['https://developer.salesforce.com/docs/apis',
  'https://help.salesforce.com/s/articleView?id=platform.no_such_article_xyz.htm&type=5']);
// Interim band until two sweeps a day apart measure real wording churn: a lost article or a nav-only read moves chars
// past it, an edited paragraph does not. A refused shell's length varies by visitor, so only saved pages are banded.
const BAND = [0.5, 2];

// One cold run: a fresh --out dir, so nothing comes from cache. Raw lines print the path only, rendered lines the
// full URL, and the order is not the input order, so each line is matched back to its URL.
let broke = ''; // why fetch-docs did not finish, for the report as well as the log
const run = urls => {
  const out = mkdtempSync(join(tmpdir(), 'sf-docs-site-check-'));
  try {
    // The budget only stops new pages starting: the kill ends a hung one (Playwright traps SIGTERM), and three runs plus
    // the two retry waits still fit the job's 70 minutes. A page started at 899 s can take about 90 s more.
    const r = spawnSync(process.execPath, [SCRIPT, '--out', out, '--budget', '900', ...urls], { encoding: 'utf8', timeout: 1100 * 1000, killSignal: 'SIGKILL' });
    // A cold run prints nothing on stderr unless something broke, so any of it goes to the log with the exit code.
    if (r.error || r.stderr) console.error(`fetch-docs exit ${r.status ?? r.signal}${r.error ? `: ${r.error.message}` : ''}\n${r.stderr ?? ''}`);
    // Name the cause: a BLOCKED or Error line, else the last line, since warnings can come before a crash.
    const errs = (r.error?.message || r.stderr || '').trim().split('\n');
    if (r.error || r.status !== 0) broke ||= `fetch-docs exit ${r.status ?? r.signal}: ${errs.find(l => /^(BLOCKED|\w*Error)/.test(l)) ?? errs.at(-1)}`;
    return parse(urls, r.stdout ?? '', out);
  } finally { rmSync(out, { recursive: true, force: true }); }
};
// A raw line names the path it fetched: the URL's own, or the .md copy fetched in its place (never for a ?query URL,
// as in fetch-docs' twinOf).
const rawOf = (u, p) => { const x = new URL(u); return p === x.pathname + x.search || (!x.search && p === `${x.pathname.replace(/\.html$|\/$/, '')}.md`); };
// With the run's out dir, a saved Help article also counts the article links in its sidecar: 0 is how a broken link
// filter showed before 0.1.1, when every Help sidecar held only nav links.
const HELP_ARTICLE = /^https:\/\/help\.salesforce\.com\/s\/articleView\?/;
export const parse = (urls, stdout, out) => {
  const got = {};
  for (const line of stdout.split('\n')) {
    const m = /^(\d+) (\d+) (\S+)(.*)$/.exec(line);
    const url = m && (urls.find(u => u === m[3]) || (m[3].startsWith('/') && urls.find(u => rawOf(u, m[3]))));
    if (!url) continue;
    const kinds = [...m[4].matchAll(/\[([^\]\s]+(?: failed:)?)/g)].map(k => k[1]).join(' ');
    const file = / -> (\S+)/.exec(m[4])?.[1];
    got[url] = { status: +m[1], chars: +m[2], kinds, saved: !!file };
    if (out && file && HELP_ARTICLE.test(url)) {
      let links = '';
      try { links = readFileSync(join(out, `${file}.links.txt`), 'utf8'); } catch { /* no sidecar: no links */ }
      got[url].links = links.split('\n').filter(l => l.startsWith('/s/articleView?id=')).length;
    }
  }
  return got;
};
const show = (r, none) => r ? `${r.status} ${r.chars} ${r.kinds || '(raw)'} ${r.saved ? 'saved' : 'not saved'}${r.links === 0 ? ', 0 article links' : ''}` : none;
export const drifted = (was, now) => !was || !now || now.status !== was.status || now.kinds !== was.kinds || now.saved !== was.saved
  || now.kinds.includes('fallback') || now.links === 0
  || (was.saved && was.chars > 0 && (now.chars < was.chars * BAND[0] || now.chars > was.chars * BAND[1]));

// An outage page or a fallback read must never become the reference every later run is measured against.
export const unfit = (r, u) => r.status === 0 || r.kinds.includes('fallback') || r.links === 0 || (!r.saved && !SHELLS.has(u));

// Help serves a short outage page for minutes at a time (one outlasted a 60 s retry): refetch what drifted at 1 and
// then 3 more minutes. A URL with no result line keeps its earlier read, so it stays drifted.
export const retry = async (base, now, urls, refetch, sleep, waits = [60000, 180000]) => {
  let bad = urls.filter(u => drifted(base[u], now[u]));
  for (const wait of waits) {
    if (!bad.length) break;
    await sleep(wait);
    now = { ...now, ...(await refetch(bad)) }; // awaited, so an async refetch is merged, not its Promise
    bad = bad.filter(u => drifted(base[u], now[u]));
  }
  return { now, bad };
};

// Run only as a script: the tests import drifted without fetching anything. import.meta.url has symlinks resolved.
const entry = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ''; } })(); // no file: imported
if (import.meta.url === entry) {
if (process.argv.includes('--update')) {
  const got = run(URLS);
  const missing = URLS.filter(u => !got[u]), bad = URLS.filter(u => got[u] && unfit(got[u], u));
  if (missing.length) { console.error(`no result for:\n${missing.join('\n')}`); process.exit(1); }
  if (bad.length) { console.error(`not written, rerun later:\n${bad.map(u => `${u}: ${show(got[u])}`).join('\n')}`); process.exit(1); }
  writeFileSync(BASE, JSON.stringify(got, null, 2) + '\n');
  console.log(`baseline written: ${URLS.length} URLs`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASE, 'utf8'));
const first = run(URLS);
// broke is reset so each retry is judged on its own fetch.
const { now, bad } = await retry(base, first, URLS,
  urls => { broke = ''; return run(urls); }, ms => new Promise(r => setTimeout(r, ms)));
console.log(bad.length
  ? [`## ${bad.length} of ${URLS.length} doc pages changed`, '', ...(broke ? [`The fetch itself failed, so a site change is not certain: ${broke}`, ''] : []), ...bad.flatMap(u => [`- ${u}`, `  - was: \`${show(base[u], 'not in baseline.json: run --update')}\``, `  - now: \`${show(now[u], 'no result line')}\``])].join('\n')
  : `All ${URLS.length} doc pages read as in the baseline.`);
process.exit(bad.length ? 1 : 0);
}
