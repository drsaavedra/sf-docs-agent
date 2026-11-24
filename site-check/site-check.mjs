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
// One URL per site and page type, the shells and redirects included: those must keep failing the same way. The
// exceptions are the llms indexes and the Help child sitemap below.
// On 2026-11-24, after UI API moved, Connect REST API was the only live atlas guide of 15 tried still rendering (div.body).
// When it moves to a twin its URL drifts: replace it with another rendered guide if one is left.
// Every llms index the prompt names (a test holds this) and one Help child sitemap: a 404 or an emptied file is drift,
// which the llms.txt pin cannot see. Every other index the baseline's llms.txt lists is fetched too (see products).
export const HELP_INDEX = 'https://help.salesforce.com/apex/Help_SiteMapIndexExternal?producttype=ai';
export const HELP_CHILD = 'https://help.salesforce.com/apex/Help_SiteMapExternal?page=1&producttype=ai';
export const URLS = [
  'https://developer.salesforce.com/docs/llms.txt',
  'https://developer.salesforce.com/docs/llms-product-docs.txt',
  'https://developer.salesforce.com/docs/llms-platform.txt',
  'https://developer.salesforce.com/docs/llms-salesforcedx.txt',
  'https://developer.salesforce.com/docs/llms-platform-obj-meta-tool.txt',
  'https://developer.salesforce.com/docs/llms-platform-apex.txt',
  'https://developer.salesforce.com/docs/llms-platform-field-ref.txt',
  'https://architect.salesforce.com/llms.txt',
  'https://developer.salesforce.com/docs/platform/lwc/guide/create-light-dom.md',
  'https://architect.salesforce.com/docs/architect/well-architected/guide/trust.md',
  HELP_INDEX,
  HELP_CHILD,
  'https://admin.salesforce.com/sitemap_index.xml',
  'https://www.lightningdesignsystem.com/2e1ef8501/p/216f79-toast.md',
  'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getBasket',
  'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
  // An OpenAPI reference (no .md, one page per API, #tag/.../operation/... names a part): where atlas API references go.
  'https://developer.salesforce.com/docs/platform/user-interface/references/user-interface',
  // A component reference tab reads the .md that holds every tab.
  'https://developer.salesforce.com/docs/platform/lightning-component-reference/guide/lightning-button.html?type=Specification',
  'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm',
  'https://developer.salesforce.com/docs/atlas.en-us.apexref.meta/apexref/apex_methods_system_string.htm',
  'https://developer.salesforce.com/docs/atlas.en-us.life_sciences_dev_guide.meta/life_sciences_dev_guide/sforce_api_objects_mergerequest.htm',
  'https://developer.salesforce.com/docs/atlas.en-us.chatterapi.meta/chatterapi/connect_resources_files_information.htm',
  'https://developer.salesforce.com/docs/atlas.en-us.mobile_sdk.meta/mobile_sdk/android_unauthenticated_rest_requests.htm',
  'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_no_such_topic_xyz.htm',
  'https://developer.salesforce.com/docs/apis',
  'https://help.salesforce.com/s/articleView?id=platform.flow_ref_elements_transform.htm&type=5',
  'https://help.salesforce.com/s/articleView?id=001096524&type=1',
  'https://help.salesforce.com/s/articleView?id=sf.ev_relay_intro.htm&type=5',
  'https://help.salesforce.com/s/articleView?id=platform.no_such_article_xyz.htm&type=5',
  'https://admin.salesforce.com/blog/2025/get-ready-for-changes-to-connected-app-usage-restrictions',
  'https://admin.salesforce.com/automation', // a listing of article cards, read whole
  'https://architect.salesforce.com/diagrams', // an architect section page, read as its .md
  // Redirects that must keep being refused: an old architect URL lands on the home page, and every Integration
  // Patterns topic lands on one architect page under another name.
  'https://architect.salesforce.com/well-architected/trusted/secure',
  'https://developer.salesforce.com/docs/atlas.en-us.integration_patterns_and_practices.meta/integration_patterns_and_practices/integ_pat_intro_overview.htm',
  'https://www.lightningdesignsystem.com/',
  'https://v1.lightningdesignsystem.com/components/toast/',
];
// The pages that must keep being refused: any other unsaved result is an outage, not a reference.
const SHELLS = new Set(['https://developer.salesforce.com/docs/apis',
  'https://architect.salesforce.com/well-architected/trusted/secure',
  'https://developer.salesforce.com/docs/atlas.en-us.integration_patterns_and_practices.meta/integration_patterns_and_practices/integ_pat_intro_overview.htm',
  'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_no_such_topic_xyz.htm',
  'https://help.salesforce.com/s/articleView?id=platform.no_such_article_xyz.htm&type=5']);
// Interim band until two sweeps a day apart measure real wording churn: a lost article or a nav-only read moves chars
// past it, an edited paragraph does not. A refused shell's length varies by visitor, so only saved pages are banded.
const BAND = [0.5, 2];

// One cold run: a fresh --out dir, so nothing comes from cache. Raw lines print the path only, rendered lines the
// full URL, and the order is not the input order, so each line is matched back to its URL.
let broke = ''; // why fetch-docs did not finish, for the report as well as the log
export const failure = () => broke;
// Each run is judged on its own fetch, so a clean retry drops an earlier failure.
export const run = urls => {
  broke = '';
  const out = mkdtempSync(join(tmpdir(), 'sf-docs-site-check-'));
  try {
    // The budget only stops new pages starting: the kill ends a hung one (Playwright traps SIGTERM), and three runs plus
    // the two retry waits still fit the job's 70 minutes. A page started at 899 s can take about 90 s more.
    const r = spawnSync(process.execPath, [SCRIPT, '--out', out, '--budget', '900', ...urls], { encoding: 'utf8', timeout: 1100 * 1000, killSignal: 'SIGKILL' });
    // A cold run prints nothing on stderr unless something broke, so any of it goes to the log with the exit code.
    if (r.error || r.stderr) console.error(`fetch-docs exit ${r.status ?? r.signal}${r.error ? `: ${r.error.message}` : ''}\n${r.stderr ?? ''}`);
    // Name the cause: a BLOCKED or Error line, else the last line, since warnings can come before a crash.
    const errs = (r.error?.message || r.stderr || '').trim().split('\n');
    if (r.error || r.status !== 0) broke = `fetch-docs exit ${r.status ?? r.signal}: ${errs.find(l => /^(BLOCKED|\w*Error)/.test(l)) ?? errs.at(-1)}`;
    return parse(urls, r.stdout ?? '', out);
  } finally { rmSync(out, { recursive: true, force: true }); }
};
// A raw line names the path it fetched: the URL's own, or the .md copy fetched in its place (never for a ?query URL
// but a component reference's ?type= tab, as in fetch-docs' twinOf).
const rawOf = (u, p) => { const x = new URL(u);
  const tab = x.pathname.startsWith('/docs/platform/lightning-component-reference/') && [...x.searchParams.keys()].every(k => k === 'type');
  return p === x.pathname + x.search || ((!x.search || tab) && p === `${x.pathname.replace(/\.html$|\/$/, '')}.md`); };
// With the run's out dir, a saved Help article also counts the article links in its sidecar: 0 is how a broken link
// filter showed before this check existed, when every Help sidecar held only nav links.
const HELP_ARTICLE = /^https:\/\/help\.salesforce\.com\/s\/articleView\?/;
const LLMS = 'https://developer.salesforce.com/docs/llms.txt'; // the one index file that lists the per-product ones
// The per-product indexes an llms.txt read lists, as URLs, less those URLS names: a guide moves without a sampled page.
export const products = r => (r?.indexes ?? []).map(p => p.startsWith('/') ? `https://developer.salesforce.com${p}` : p)
  .filter(u => !URLS.includes(u));
// The guides an index links to: /docs/atlas.<guide>.meta, else up to three folders under /docs (platform/lwc/guide;
// mytrust-api has one). A guide moved in or out changes the set; an edited or added page does not.
const guidesOf = text => [...new Set([...text.matchAll(/\]\(https?:\/\/developer\.salesforce\.com(\/docs\/[^\s)#?]+)/g)]
  .map(([, p]) => { const s = p.split('/'); return s.slice(0, Math.min(p.startsWith('/docs/atlas.') ? 3 : 5, s.length - 1)).join('/'); }))].sort();
const norm = s => { const x = new URL(s); x.protocol = 'https:'; x.searchParams.sort(); return x.href; };
const CHILD_NORM = norm(HELP_CHILD), isChild = s => URL.canParse(s) && norm(s) === CHILD_NORM;
export const parse = (urls, stdout, out) => {
  const got = {};
  for (const line of stdout.split('\n')) {
    const m = /^(\d+) (\d+) (\S+)(.*)$/.exec(line);
    const url = m && (urls.find(u => u === m[3]) || (m[3].startsWith('/') && urls.find(u => rawOf(u, m[3]))));
    if (!url) continue;
    const kinds = [...m[4].matchAll(/\[([^\]\s]+(?: failed:)?)/g)].map(k => k[1]).join(' ');
    const file = / -> (\S+)/.exec(m[4])?.[1], to = /\[redirected ([^\]\s]+)\]/.exec(m[4])?.[1];
    // Where a redirect lands: a move to another page of about the same size changes nothing else in the line.
    got[url] = { status: +m[1], chars: +m[2], kinds, saved: !!file, ...(to && { to }) };
    // The per-product indexes developer llms.txt lists: one added or dropped barely moves its size. Any path or host
    // counts. A missing saved copy is null: drift that says so, not every index gone.
    if (out && file && url === LLMS) {
      try { got[url].indexes = [...new Set((readFileSync(join(out, file), 'utf8').match(/(?:https?:\/\/[\w.-]+)?\/[\w./-]*llms-[\w.-]+\.txt/g) ?? [])
        .map(x => x.replace(/^https?:\/\/developer\.salesforce\.com/, '')))].sort(); }
      catch (e) { if (e.code !== 'ENOENT') throw e; got[url].indexes = null; }
    }
    if (out && file && url !== LLMS && /\/llms-[\w.-]+\.txt$/.test(new URL(url).pathname)) {
      try { got[url].guides = guidesOf(readFileSync(join(out, file), 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; got[url].guides = null; }
    }
    // The index must still list the child fetched above, or a renamed child route passes while the old URL answers.
    // Each <loc> is read with fetch-docs' expand regex and entity decode; the scheme and the query order do not count.
    if (out && file && url === HELP_INDEX) {
      try { const locs = [...readFileSync(join(out, file), 'utf8').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)];
        got[url].lists = locs.length ? locs.some(l => isChild(l[1].replace(/&(#38|amp);/g, '&'))) : 0; }
      catch (e) { if (e.code !== 'ENOENT') throw e; got[url].lists = null; }
    }
    if (out && file && HELP_ARTICLE.test(url)) {
      let links = '';
      try { links = readFileSync(join(out, `${file}.links.txt`), 'utf8'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; } // only a missing sidecar means no links
      // An article link has an id anywhere in its query, as fetch-docs matches it, not only first.
      got[url].links = links.split('\n').filter(l => { const [path, q = ''] = l.split(' ')[0].split('?');
        return path === '/s/articleView' && new URLSearchParams(q).has('id'); }).length;
    }
  }
  return got;
};
const show = (r, none) => r ? `${r.status} ${r.chars} ${r.kinds || '(raw)'} ${r.saved ? 'saved' : 'not saved'}${r.links === 0 ? ', 0 article links' : ''}`
  + `${r.to ? ` to ${r.to}` : ''}${r.indexes === null ? ', saved llms.txt missing' : r.indexes ? `, ${r.indexes.length} indexes` : ''}`
  + `${r.guides === null ? ', saved index missing' : r.guides ? `, ${r.guides.length} guides` : ''}`
  + `${r.lists === false ? ', HELP_CHILD not listed: if Help renamed it, change HELP_CHILD, not a rerun' : r.lists === 0 ? ', index lists no sitemaps (an outage page?)' : r.lists === null ? ', saved index missing' : ''}` : none;
// Which indexes or guides came or went, since a count alone does not say.
export const moved = (was, now) => ['indexes', 'guides'].flatMap(k => { if (!was?.[k] || !now?.[k]) return [];
  const a = new Set(was[k]), b = new Set(now[k]);
  return [...[...b].filter(x => !a.has(x)).map(x => `+${x}`), ...[...a].filter(x => !b.has(x)).map(x => `-${x}`)]; }).join(' ');
// The page a landing URL names, as fetch-docs' sameDoc reads it (only a change there prints [redirected]): host, path
// without a trailing slash, and ?id=. A value that is not a URL compares as text.
const page = to => { const x = to && URL.canParse(to) && new URL(to); return x ? `${x.host}${x.pathname.replace(/\/$/, '')}?id=${x.searchParams.get('id') ?? ''}` : to ?? ''; };
export const drifted = (was, now) => !was || !now || now.status !== was.status || now.kinds !== was.kinds || now.saved !== was.saved
  || now.kinds.includes('fallback') || now.links === 0 || page(now.to) !== page(was.to) || String(now.indexes) !== String(was.indexes) || String(now.guides) !== String(was.guides)
  || now.lists !== was.lists || (was.saved && was.chars > 0 && (now.chars < was.chars * BAND[0] || now.chars > was.chars * BAND[1]));

// An outage page or a fallback read must never become the reference every later run is measured against.
export const unfit = (r, u) => r.status === 0 || r.kinds.includes('fallback') || r.kinds.includes('nospec') || r.links === 0 || r.indexes === null || r.indexes?.length === 0
  || r.guides === null || r.guides?.length === 0
  || r.lists === false || r.lists === 0 || r.lists === null || (!r.saved && !SHELLS.has(u));

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

// Run only as a script: the tests import its functions without fetching anything. import.meta.url has symlinks resolved.
const entry = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ''; } })(); // no file: imported
if (import.meta.url === entry) {
if (process.argv.includes('--update')) {
  const got = run(URLS), all = [...URLS, ...products(got[LLMS])];
  Object.assign(got, run(all.slice(URLS.length))); // the indexes today's llms.txt lists
  const missing = all.filter(u => !got[u]), bad = all.filter(u => got[u] && unfit(got[u], u));
  if (missing.length) { console.error(`no result for:\n${missing.join('\n')}`); process.exit(1); }
  if (bad.length) { console.error(`not written, rerun later unless a line names a fix:\n${bad.map(u => `${u}: ${show(got[u])}`).join('\n')}`); process.exit(1); }
  writeFileSync(BASE, JSON.stringify(got, null, 2) + '\n');
  console.log(`baseline written: ${all.length} URLs`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASE, 'utf8'));
// The baseline's index list, not today's: an index added or dropped is already llms.txt's drift.
const urls = [...URLS, ...products(base[LLMS])];
const first = run(urls);
const { now, bad } = await retry(base, first, urls, run, ms => new Promise(r => setTimeout(r, ms)));
console.log(bad.length
  ? [`## ${bad.length} of ${urls.length} doc pages changed`, '', ...(broke ? [`The fetch itself failed, so a site change is not certain: ${broke}`, ''] : []), ...bad.flatMap(u => { const d = moved(base[u], now[u]);
    return [`- ${u}`, `  - was: \`${show(base[u], 'not in baseline.json: run --update')}\``, `  - now: \`${show(now[u], 'no result line')}\``, ...(d ? [`  - indexes: \`${d}\``] : [])]; })].join('\n')
  : `All ${urls.length} doc pages read as in the baseline.`);
process.exit(bad.length ? 1 : 0);
}
