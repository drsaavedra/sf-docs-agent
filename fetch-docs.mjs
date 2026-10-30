#!/usr/bin/env node
// Fetch Salesforce doc pages through headless Chromium and write each unique body to disk.
// .md/.txt/.xml URLs, Help sitemaps and the .md twins of new docs, architect and LDS pages are fetched raw; any other
// URL is rendered and its main content extracted as text.
// Usage: node fetch-docs.mjs [--out <dir>] [--budget <s>] [--terms a,b] <url | /docs/path.md> ...   (default out: ./cache here)
//        node fetch-docs.mjs --search a,b [--site <host>]   (ranked matching lines across the cached pages)
//        node fetch-docs.mjs --quote <cache file>:<line>[,<line>...] ...   (prints Evidence and Sources verbatim)
//        node fetch-docs.mjs --section <cache file>:<line> ...   (a list or table, numbered, to the next heading)
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// First selector with real text wins, so a wrapper of several topics (atlas nested0 or nested1, Help KB blocks)
// ranks above one topic; doc-amf-reference and doc-content serve pages whose text is all in shadow DOM.
const CONTENT = ['.slds-text-longform', 'div.container:has(.article-content)', '.post.entry', 'div.nested0',
  'div.container:has(> div.nested1)', 'div.body', 'doc-amf-reference', 'doc-content', 'article', 'main'];

const args = process.argv.slice(2);
let out = join(dirname(fileURLToPath(import.meta.url)), 'cache');
const oi = args.indexOf('--out');
if (oi >= 0) out = args.splice(oi, 2)[1];
// No page starts after the budget: each one left is printed 'not fetched (time limit)', so the caller can rerun it.
const bi = args.indexOf('--budget');
const deadline = bi >= 0 ? Date.now() + Number(args.splice(bi, 2)[1]) * 1000 : Infinity;
// --terms a,b: after the fetch, print each saved page's lines that hold a term, so the caller needs no grep.
const termsOf = v => (v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ti = args.indexOf('--terms');
const terms = ti >= 0 ? termsOf(args.splice(ti, 2)[1]) : [];
if (!args.length || !out || Number.isNaN(deadline) || (ti >= 0 && !terms.length)) { console.error('usage: node fetch-docs.mjs [--out dir] [--budget seconds] [--terms a,b] <url | /docs/path.md> ...\n       node fetch-docs.mjs [--out dir] --search a,b [--site <host>]\n       node fetch-docs.mjs [--out dir] --quote <cache file>:<line>[,<line>...] ...\n       node fetch-docs.mjs [--out dir] --section <cache file>:<line> ...'); process.exit(2); }
const fileFor = u => join(out, u.host, (u.pathname + u.search.replace(/[^\w.-]+/g, '_')).replace(/\/$/, '/index') + (/\.(md|txt|xml)$/.test(u.pathname) ? '' : '.txt'));
// Cache window: SF_DOCS_CACHE_HOURS (default 24; 0 means always fetch). An empty value counts as unset.
const hours = Number(process.env.SF_DOCS_CACHE_HOURS || 24);
const MAX_AGE = (Number.isFinite(hours) && hours >= 0 ? hours : 24) * 3600 * 1000;
// Never delete a page younger than 10 minutes: a short window would otherwise remove pages another run, or this
// agent's own previous step, fetched moments ago. Serving still follows MAX_AGE.
const PRUNE_AGE = Math.max(MAX_AGE, 10 * 60 * 1000);
// A raw fetch that hangs (Help sitemaps do) would otherwise stall the whole call past the caller's tool timeout.
const RAW_TIMEOUT_MS = 30000;
// A file from before the Source: line existed is stale, so --quote can always name the official page. Only the first
// 8 bytes are read, once per URL per run: indexes run to megabytes.
const fresh = new Map();
const isFresh = u => {
  if (!fresh.has(u.href)) {
    let ok = false;
    try {
      if (Date.now() - statSync(fileFor(u)).mtimeMs < MAX_AGE) {
        const fd = openSync(fileFor(u), 'r'), b = Buffer.alloc(8);
        try { readSync(fd, b, 0, 8, 0); } finally { closeSync(fd); }
        // A fallback read may be one section or a sidebar of a slow page: refetch it rather than trust it for a day.
        ok = b.toString() === 'Source: ' && !statSync(`${fileFor(u)}.fallback`, { throwIfNoEntry: false });
      }
    } catch { /* missing or unreadable: not fresh */ }
    fresh.set(u.href, ok);
  }
  return fresh.get(u.href);
};
// A twin that answered 404 or a shell leaves an empty <file>.missing, so later runs render without asking again;
// a transient failure (status 0, 5xx) leaves none and the twin is retried.
const noTwin = t => { try { return Date.now() - statSync(`${fileFor(t)}.missing`).mtimeMs < MAX_AGE; } catch { return false; } };
// Failing to write a marker only costs a retry later, so it is reported and the run goes on.
const markMissing = t => {
  const f = `${fileFor(t)}.missing`;
  try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, ''); }
  catch (e) { console.error(`could not record missing twin ${slash(f)}: ${e.message}`); }
};
// The page a person would open: developer serves .md twins at .html, architect at the bare path.
const official = u => !u.pathname.endsWith('.md') ? u.href
  : u.href.replace(/\.md$/, u.host === 'developer.salesforce.com' ? '.html' : '');
const SOURCE = /^Source: [^\n]*\n/;
// An HTML app shell where text was expected (a .md path with no twin answers 200 with one).
const isShell = b => /^\s*<(!doctype|html)/i.test(b);
// A twin is missing (render instead, and remember it) on a 404, or a 200 whose body is an HTML shell or empty.
const missingTwin = (status, body) => status === 404 || (status === 200 && (isShell(body) || !body.trim()));
// One page, whatever the #anchor or trailing slash; a Help article is told apart by its ?id=.
const sameDoc = (a, b) => a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '')
  && a.searchParams.get('id') === b.searchParams.get('id');
// Paths the agent will paste into Git Bash on Windows: forward slashes, which Node accepts too.
const slash = p => p.split(sep).join('/');

// --terms and --search: lines holding a term, numbered as --quote counts them; past a cap the rarest-term lines win, in
// page order. Caps set on a clean 20-question sample (looser caps printed twice the old grep's 2k chars a call).
const MAX_HITS = 20, MAX_LINKS = 10, SHORT_LINES = 40, SHORT_CHARS = 4000, PER_FILE = 3;
const matches = (name, text, t) => text.split('\n').flatMap((line, i, ls) => {
  const low = i || !ls[0].startsWith('Source: ') ? line.toLowerCase() : '', hit = t.filter(s => low.includes(s)); // a page's line 1 is its Source line; a sidecar has none
  return hit.length ? [{ name, n: i + 1, line, hit, at: Math.min(...hit.map(s => low.indexOf(s))) }] : [];
});
const rank = (ms, max = MAX_HITS) => {
  if (ms.length <= max) return ms;
  const df = Object.create(null); // a term like 'constructor' must not read Object.prototype
  for (const m of ms) for (const s of m.hit) df[s] = (df[s] || 0) + 1;
  const score = m => m.hit.reduce((a, s) => a + 1 / df[s], 0);
  return ms.map((m, k) => [score(m), k, m]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, max)
    .sort((a, b) => a[1] - b[1]).map(x => x[2]);
};
const show = m => `${m.n}: ${m.line.length > 300 ? `...${m.line.slice(Math.max(0, m.at - 100), m.at + 200)}...` : m.line}`;
const more = (all, top) => all.length > top.length ? [`(${all.length - top.length} more lower-ranked lines: add a term to narrow. For a list or table, print it whole with --section <file>:<line>)`] : [];
// A page this short is printed whole: its answer can sit on a line no term matches (a Help page's "95%" line).
// Index files by shape (Help's /apex/Help_*SiteMap* pages, *sitemap*.xml), on the path under the cache dir: a doc
// page about sitemaps, or an --out dir named for them, is neither.
const indexKind = rel => /(^|\/)apex\/Help_\w*SiteMapIndex|sitemap_index[^/]*\.xml$/i.test(rel) ? 'index'
  : /(^|\/)apex\/Help_\w*SiteMap|[^/]*sitemap[^/]*\.xml$/i.test(rel) ? 'map' : '';
const grep = (file, t) => {
  const text = readFileSync(file, 'utf8'), lines = text.split('\n'), kind = indexKind(slash(relative(out, file)));
  if (!file.endsWith('.links.txt') && lines.length <= SHORT_LINES && text.length <= SHORT_CHARS)
    return ['(short page, shown whole)', ...lines.slice(1, text.endsWith('\n') ? -1 : undefined).map((l, i) => `${i + 2}: ${l}`)]; // line 1 is the Source line
  // A sitemap index names page sitemaps, not topics, so no term can pick among them: print every <loc> line.
  if (kind === 'index') return matches(null, text, ['<loc>']).map(show);
  // A sitemap lists each article twice (<loc> and its alternates): keep the <loc> line and show 40 articles.
  const map = kind === 'map', all = matches(null, text, t).filter(m => !map || m.line.includes('<loc>'));
  const top = rank(all, map ? 40 : file.endsWith('.links.txt') ? MAX_LINKS : MAX_HITS);
  return [...top.map(show), ...more(all, top)];
};

// <cache file>:<lines> for --quote and --section: only cached official pages, inside the cache dir and starting with
// their Source: line.
const cached = spec => {
  const at = spec.lastIndexOf(':');
  const file = isAbsolute(spec.slice(0, at)) ? spec.slice(0, at) : join(out, spec.slice(0, at));
  const inside = relative(out, file);
  let lines;
  try { lines = inside.startsWith('..') || isAbsolute(inside) ? [] : readFileSync(file, 'utf8').split('\n'); }
  catch { lines = []; }
  if (!lines[0]?.startsWith('Source: ')) { console.error(`not a cached page: ${slash(file)}`); return null; }
  return { file, lines, nums: spec.slice(at + 1).split(',').map(Number) };
};

// --section: a list or table from a line to the next heading, so the end of a list is found by the script, not by a
// guessed Read window. A heading in the first 5 lines is the list's own title; at most 60 lines print.
const HEADING = /^(#{1,6} |\*\*[^*]+\*\*\s*$)/, SECTION_MAX = 60;
if (args[0] === '--section') {
  let shown = 0;
  for (const spec of args.slice(1)) {
    const c = cached(spec), n = c?.nums[0];
    if (!c) continue;
    if (!(n > 1 && n <= c.lines.length)) { console.error(`skipped ${slash(relative(out, c.file))}:${n}: out of range or the Source line`); continue; }
    const rows = [];
    let i = n;
    for (; i <= c.lines.length && rows.length < SECTION_MAX; i++) {
      if (i > n + 4 && HEADING.test(c.lines[i - 1])) break;
      if (c.lines[i - 1].trim()) rows.push(`${i}: ${c.lines[i - 1]}`);
    }
    const tail = i <= c.lines.length && rows.length >= SECTION_MAX ? [`(more before the next heading: --section from line ${i})`] : [];
    console.log([`== ${slash(relative(out, c.file))}`, ...rows, ...tail].join('\n'));
    shown++;
  }
  process.exit(shown ? 0 : 1);
}

// --quote: the agent picks line numbers, the script copies the lines, so quotes are verbatim by construction.
if (args[0] === '--quote') {
  const files = [], ev = [];
  for (const spec of args.slice(1)) {
    const c = cached(spec);
    if (!c) continue;
    const { file, lines } = c;
    if (!files.includes(file)) files.push(file);
    for (const n of c.nums) {
      const text = (lines[n - 1] || '').trim();
      if (text && n > 1) ev.push(`- "${text}" [${files.indexOf(file) + 1}:${n}]`);
      else console.error(`skipped ${slash(relative(out, file))}:${n}: empty, out of range or the Source line`);
    }
  }
  console.log(['Evidence:', ...ev, 'Sources:', ...files.map((f, i) => {
    const src = (readFileSync(f, 'utf8').match(SOURCE) || ['Source: (unknown) '])[0].slice(8).trim();
    return `[${i + 1}] ${src}\n    cache: ${slash(f)}`;
  })].join('\n'));
  process.exit(ev.length ? 0 : 1);
}

// The official doc sites: the only hosts fetched, saved or pruned, so every cached page and quote is Salesforce's own.
const SITES = ['developer.salesforce.com', 'architect.salesforce.com', 'help.salesforce.com', 'admin.salesforce.com',
  'www.lightningdesignsystem.com', 'v1.lightningdesignsystem.com'];
// Every file under the given site folders, sorted. A missing folder is a site not cached yet; any other error is printed.
const cacheFiles = (sites, label) => sites.flatMap(s => {
  try { return readdirSync(join(out, s), { recursive: true }).sort().map(rel => join(out, s, rel)); }
  catch (e) { if (e.code !== 'ENOENT') console.error(`${label}: ${e.message}`); return []; }
});

// --search: ranked lines across the cache, at most PER_FILE a file. It does not fetch, so it can see expired pages:
// fetch first in a run, which clears them.
if (args[0] === '--search') {
  const t = termsOf(args[1]?.startsWith('-') ? '' : args[1]);
  const si = args.indexOf('--site'), site = (si >= 0 ? args[si + 1] || '' : '').replace(/^lightningdesignsystem\.com$/, 'www.$&');
  // --site with no value is an error, not a search of every site.
  if (!t.length || (si >= 0 && !SITES.includes(site))) { console.error(`usage: --search a,b [--site <one of ${SITES.join(', ')}>]`); process.exit(2); }
  const all = [];
  let total = 0;
  for (const f of cacheFiles(site ? [site] : SITES, 'search')) {
    const rel = slash(relative(out, f));
    // Sidecars and markers are not pages; a file another run pruned mid-walk is skipped.
    if (/\.(links\.txt|missing|tmp|fallback)$/.test(rel) || !statSync(f, { throwIfNoEntry: false })?.isFile()) continue;
    if (/(^|\/)llms[^/]*\.txt$/i.test(rel) || indexKind(rel)) continue; // indexes: --terms on the index already shows them
    // At most PER_FILE lines a file, so ties across files cannot all come from the one that sorts first.
    try { const ms = matches(rel, readFileSync(f, 'utf8'), t); total += ms.length; all.push(...rank(ms, PER_FILE)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const top = rank(all), rest = total - top.length;
  console.log([...top.map(m => `${m.name}:${show(m)}`), ...(rest ? [`(${rest} more lower-ranked lines: add a term or --site to narrow)`] : [])].join('\n') || `no match in ${site || 'the cache'}`);
  process.exit(0);
}
// A scheme-less host would resolve as a developer.salesforce.com path; sitemap <loc> lines write & as &#38; or &amp;.
// Anything that is not an http(s) URL (a stray flag, 'https://', ftp:) is refused rather than crashing the call.
const parse = a => {
  const s = a.replace(/&(#38|amp);/g, '&'), v = /^([\w-]+\.)*(salesforce|lightningdesignsystem)\.com([/?]|$)/i.test(s) ? `https://${s}` : s;
  if (s.startsWith('-') || !URL.canParse(v, 'https://developer.salesforce.com')) return null;
  const u = new URL(v, 'https://developer.salesforce.com');
  // lightningdesignsystem.com serves the same site as www., which the twin route and the cache prune expect.
  if (u.hostname === 'lightningdesignsystem.com') u.hostname = 'www.lightningdesignsystem.com';
  return /^https?:$/.test(u.protocol) ? u : null;
};
// One pass over the arguments: a URL on a doc site is fetched, anything else is refused with its reason.
const given = [], refused = [];
for (const a of args) {
  const u = parse(a);
  if (u && SITES.includes(u.host)) given.push(u);
  else refused.push(u ? `${u.href}: not an official doc site` : `${a}: not a URL`);
}
// New developer docs, architect and LDS pages have a .md twin: fetch it raw rather than render the HTML page.
const twinOf = u => {
  const p = u.pathname.replace(/\.html$/, '').replace(/\/$/, '');
  const has = !u.search && !/\.(md|txt|xml|htm)$/.test(p) && (
    u.host === 'developer.salesforce.com' ? /^\/docs\/(?!atlas\.|component-library\/)[^/]+\/[^/]+\/[^/]+\/./.test(p)
      : u.host === 'architect.salesforce.com' ? /^\/docs\/architect\/./.test(p)
        : u.host === 'www.lightningdesignsystem.com' && /^\/\w+\/(v\/\d+\/)?p\/./.test(p));
  return has ? new URL(`${u.origin}${p}.md`) : null;
};
const asked = new Map(); // twin href -> URL as given, rendered instead when the twin is missing
// foo.html and foo are one page (one twin): fetch it once, and print 'same <arg> as <first arg>' for the others.
const urls = [], sameAs = [], first = new Map();
for (const u of given) {
  const t = twinOf(u), k = t ? t.href : u.href;
  // A .md given before its page: this page becomes the fallback (or is rendered now, if the twin is known missing).
  const mdFirst = t && !asked.has(t.href) && urls.some(x => x.href === t.href);
  if (mdFirst && noTwin(t)) { urls.push(u); continue; }
  if (mdFirst) asked.set(t.href, u);
  if (first.has(k)) { sameAs.push([u.href, first.get(k)]); continue; }
  if (!t || (!isFresh(t) && noTwin(t))) urls.push(u);
  else { asked.set(t.href, u); urls.push(t); }
  first.set(k, urls.at(-1).href); // the key whose result line the 'same' line points to
}

function extract([sels, fallback]) {
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  // Same-site links (nav and TOC included) so pages without an llms.txt index can still be discovered.
  const links = new Set();
  // Path and query: every Help article sits at /s/articleView and differs only by ?id=, and it links itself with
  // &language= added, so a link is the page itself when its id matches.
  const self = u => u.pathname + (new URLSearchParams(u.search).get('id') ?? u.search), here = self(location);
  for (const r of roots) for (const a of r.querySelectorAll('a[href]')) {
    if (a.host === location.host && self(a) !== here) links.add(`${a.pathname}${a.search} ${(a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  const page = t => `# ${document.title}\n\n${t}\n`;
  const list = [...links].join('\n');
  // innerText stops at shadow roots (code samples, API references), so walk them in rendered order: hosts, then slots.
  // Like innerText: hidden elements skipped, cells tab-separated; code whitespace held as no-break spaces until the end.
  const SKIP = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE']);
  const deep = (n, pre) => [...(n.shadowRoot ? n.shadowRoot.childNodes : n.tagName === 'SLOT' ? n.assignedNodes({ flatten: true })
    : n.childNodes)].map(c => {
    if (c.nodeType === 3) return pre ? c.textContent.replace(/ /g, '\u00a0') : c.textContent.replace(/\s+/g, ' ');
    if (c.nodeType !== 1 || SKIP.has(c.tagName)) return '';
    if (c.tagName === 'BR') return '\n';
    const st = getComputedStyle(c);
    if (st.display === 'none' || st.visibility === 'hidden') return '';
    const t = deep(c, pre || st.whiteSpace.startsWith('pre'));
    return /^(inline|contents)/.test(st.display) ? t : st.display === 'table-cell' ? `${t}\t` : `\n${t}\n`;
  }).join('');
  const hosts = roots.slice(1).map(r => r.host);
  // contains() stops at a shadow boundary, so climb each host's roots to see whether it sits anywhere under el.
  const under = (el, h) => { for (let n = h; n; n = n.getRootNode().host) if (el.contains(n)) return true; return false; };
  const text = el => !hosts.some(h => el.contains(h)) ? el.innerText || ''
    : deep(el).replace(/ +/g, ' ').replace(/ ?\t ?/g, '\t').replace(/^ | $|\t+$/gm, '').replace(/\n{2,}/g, '\n')
      .replace(/\u00a0/g, ' ').trim();
  for (const s of sels) for (const r of roots) for (const el of r.querySelectorAll(s)) {
    // Landmarks hold the site's nav components too, so their shadow trees stay out.
    const mark = s === 'main' || s === 'article';
    const t = mark ? el.innerText || '' : text(el);
    // 200 chars skips footer cards that also match div.body; doc-content holds only the topic, and some are one line.
    // pending: components inside it (code samples) not rendered yet. An API reference keeps empty hosts for good, so
    // it holds instead until an api-* documentation component exists.
    const amf = s === 'doc-amf-reference';
    if (t.length > (s === 'doc-content' ? 20 : 200)) return { sel: s, text: page(t), links: list,
      pending: mark || amf ? 0 : hosts.filter(h => under(el, h) && !h.shadowRoot.childElementCount).length,
      hold: amf && !hosts.some(h => h.tagName.startsWith('API-') && under(el, h)) };
  }
  // No known container (a layout change): take the block whose paragraphs hold the most text, outside nav and footers.
  // ponytail: 1,500-char floor keeps shells out (missing pages, Help's outage page: 400 to 1,200); a shorter article still fails.
  if (fallback) {
    const BLOCKS = 'p, li, pre, td, dd, h1, h2, h3', score = new Map(), up = n => n.parentElement || n.getRootNode().host;
    // closest() stops at a shadow root, so climb each host too: a nav component's own template may have no <nav>.
    const inNav = el => { for (let n = el; n; n = n.getRootNode().host) if (n.closest('nav, header, footer, [role=navigation]')) return true; return false; };
    for (const r of roots) for (const el of r.querySelectorAll(BLOCKS)) {
      if (inNav(el) || !el.checkVisibility()) continue; // a hidden block's innerText is its whole textContent
      // Its own visible text: nested blocks score on their own, so a nested list counts once and a step keeps its prose.
      const kids = [...el.querySelectorAll(BLOCKS)].filter(c => c.parentElement?.closest(BLOCKS) === el);
      const len = e => (e.innerText || '').trim().length, n = Math.max(0, len(el) - kids.reduce((a, c) => a + len(c), 0));
      const p = up(el), g = p && up(p);
      if (p) score.set(p, (score.get(p) || 0) + n);
      if (g) score.set(g, (score.get(g) || 0) + n / 2);
    }
    const best = [...score].sort((a, b) => b[1] - a[1])[0]?.[0], t = best ? text(best) : '';
    if (t.length >= 1500) return { sel: 'fallback', text: page(t), links: list };
  }
  return { sel: 'body', text: page(document.body.innerText), links: list };
}

// Delete expired pages first, so a grep or Read over the cache afterwards only sees fresh ones.
// Not in --quote mode: with a 0-hour window it would delete the pages this run just fetched.
// Only the site folders: --out may point anywhere, and nothing else in it is ours to delete.
let pruned = 0;
for (const f of cacheFiles(SITES, 'cache cleanup')) {
  try {
    const st = statSync(f);
    if (st.isFile() && Date.now() - st.mtimeMs >= PRUNE_AGE) { rmSync(f); pruned++; }
  } catch (e) { if (e.code !== 'ENOENT') console.error(`cache cleanup: ${e.message}`); } // ENOENT: another run removed it
}
if (pruned) console.error(`removed ${pruned} expired cache files`);

// A stored Source unlike the URL asked for means the page redirected: say so again, as the first run did. A file that
// vanished or lost its Source line since the freshness check returns null and is fetched again.
const fromCache = u => {
  let t;
  try { t = readFileSync(fileFor(u), 'utf8'); } catch { return null; }
  const m = t.match(SOURCE);
  if (!m) return null;
  const src = m[0].slice(8).trim();
  return { p: u.origin + u.pathname + u.search, status: 200, body: t.slice(m[0].length), key: u.href, cached: true,
    note: ` (cached)${URL.canParse(src) && !sameDoc(new URL(src), new URL(official(u))) ? ` [redirected ${src}]` : ''}` };
};
// A reader never sees half a file: write a temp copy, then rename it into place. The pid in its name keeps two runs
// saving one page from renaming each other's copy.
const put = (f, data) => { const t = `${f}.${process.pid}.tmp`; mkdirSync(dirname(f), { recursive: true }); writeFileSync(t, data); renameSync(t, f); };
for (const r of refused) console.log(`refused ${r}`);
const results = [], seen = new Map(), saved = new Set(); // saved: files --terms prints matches from
let ok = 0;
// A saved page drops what is not doc text: image URLs (LDS signs S3 URLs of about 450 chars; the alt text stays) and
// the padding in markdown table rows. Code blocks and wording are untouched.
const lean = text => {
  let code = ''; // the open fence: closed only by the same character, at least as long (CommonMark)
  return text.split('\n').map(l => {
    const f = /^\s*(`{3,}|~{3,})/.exec(l)?.[1];
    if (f && !code) { code = f; return l; }
    if (f && f[0] === code[0] && f.length >= code.length) { code = ''; return l; }
    if (code) return l;
    l = l.replace(/!\[([^\]]*)\]\(https?:\/\/[^)\s]+\)/g, '![$1]');
    return /^\s*\|/.test(l) ? l.replace(/ {2,}/g, ' ') : l;
  }).join('\n');
};
// Curly quotes are saved straight: a model that retypes a quote writes ' and ", and the grep check must still match.
const plain = text => text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
// Each page is saved and printed as it lands, so a call stopped part way keeps every page before the stop.
const emit = r => {
  results.push(r);
  const { p, status, links, key, src, note, cached, shell, offsite } = r;
  // Markdown only (a .md URL, or a twin read as r.md): rendered text has no code fences, so lean could reach a code
  // sample. Cached pages are lean already.
  const md = r.md || /\.md$/.test(new URL(key).pathname);
  const body = status === 200 && !cached ? plain(md ? lean(r.body) : r.body) : r.body;
  const h = createHash('sha1').update(body).digest('hex').slice(0, 12);
  const u = new URL(key);
  const file = fileFor(u);
  let tail = '';
  if (status === 0) tail = ` ${body}`;
  else if (offsite) tail = ' not saved: left the doc sites'; // a redirect to a login page or another domain
  else if (shell) tail = ' not saved: shell, login or missing page';
  else if (status === 200) {
    ok++;
    // Duplicates are written too, so a later run for that URL finds it; written whole (temp then rename), and one
    // unwritable page only loses its own line. Links go to a sidecar so a Read of the page costs only its content.
    let werr = '';
    if (!cached) {
      try { // a fallback marker goes on before its page and comes off only after a full read is on disk, so a failed
        // write never leaves a fallback page that reads as full
        if (r.fallback) put(`${file}.fallback`, '');
        put(file, `Source: ${src || official(u)}\n${body}`); // first line names the official page
      }
      catch (e) { werr = ` not saved: ${e.code || e.message}`; ok--; }
      // The page is saved either way; a marker left behind only means it is fetched again next time.
      try { if (!r.fallback && !werr) rmSync(`${file}.fallback`, { force: true }); }
      catch (e) { console.error(`fallback marker not removed for ${p}: ${e.code || e.message}`); }
      try { if (links && !werr) put(`${file}.links.txt`, `${links}\n`); }
      catch (e) { console.error(`links not saved for ${p}: ${e.code || e.message}`); }
    }
    const rel = slash(relative(out, file));
    if (!werr && !seen.has(h)) saved.add(file); // a duplicate's matches are the first copy's
    tail = werr || (seen.has(h) ? ` duplicate-of ${seen.get(h)} -> ${rel}` : ` -> ${rel}`);
    if (!werr && !seen.has(h)) seen.set(h, p); // an unsaved body can never be the copy others point to
  }
  console.log(`${status} ${body.length} ${p}${note}${tail}`);
};
// The URL as given, so the caller reruns the page it asked for rather than its .md twin.
const skippedAs = new Map(); // key -> the URL its time-limit line printed, for the same lines
const skip = key => { skippedAs.set(key, asked.get(key)?.href ?? key); console.log(`not fetched (time limit) ${skippedAs.get(key)}`); };
for (const u of urls.filter(isFresh)) { const r = fromCache(u); if (r) emit(r); else fresh.set(u.href, false); }

let browser = { newPage() {}, close() {} };
if (!urls.every(isFresh) && Date.now() < deadline) { // a spent budget skips every page, so no browser
  try { browser = await chromium.launch({ headless: true }); }
  catch (e) {
    console.error(`BLOCKED: headless Chromium did not start: ${e.message.split('\n')[0]}`);
    // The exact command, not "reinstall": a reinstall without a terminal skips the browser again.
    const cli = slash(join(dirname(fileURLToPath(import.meta.url)), 'node_modules/playwright-core/cli.js'));
    console.error(`Install the browser with: node "${cli}" install --only-shell chromium`);
    console.error(`On Linux, also run once: node "${cli}" install-deps chromium`);
    process.exit(3);
  }
}
try {
  // Cached: a page written in the last 24 h is read from disk, so later agents and sessions skip the fetch.
  const todo = urls.filter(u => !isFresh(u));
  // Help serves its sitemaps (and the KB ones, Help_DocSiteMap...) from extensionless /apex/ URLs; others end .xml.
  const raw = todo.filter(u => /\.(md|txt|xml)$/.test(u.pathname) || /^\/apex\/Help_\w*SiteMap/i.test(u.pathname));
  const rendered = todo.filter(u => !raw.includes(u));
  // A twin that failed (some API reference pages have none) falls back to the URL as given, rendered at the end.
  const settle = r => {
    if (!asked.has(r.key) || (r.status === 200 && !r.shell)) return emit(r);
    if (missingTwin(r.status, r.body)) markMissing(new URL(r.key));
    const u = asked.get(r.key);
    const c = isFresh(u) && fromCache(u);
    if (c) emit(c); else rendered.push(u);
  };

  // Raw: one same-origin page per host, then in-page fetch() so requests carry the browser's own session.
  for (const origin of new Set(raw.map(u => u.origin))) {
    const paths = raw.filter(u => u.origin === origin).map(u => u.pathname + u.search);
    if (Date.now() >= deadline) { paths.forEach(p => skip(origin + p)); continue; }
    const page = await browser.newPage();
    // light same-origin page; every doc site serves one. A dead host fails its own URLs, not the run.
    const err = await page.goto(`${origin}/robots.txt`).then(() => null, e => e.message.split('\n')[0]);
    if (err) {
      paths.forEach(p => settle({ p, status: 0, body: `error: ${err}`, key: origin + p, note: '' }));
      await page.close();
      continue;
    }
    // Five fetches in flight; a slot takes the next path as soon as it frees, so one slow URL holds only its slot.
    const got = await page.evaluate(async ([ps, TO, DL]) => {
      const res = []; let next = 0;
      await Promise.all(Array.from({ length: 5 }, async () => {
        while (next < ps.length) {
          const k = next++, p = ps[k];
          if (Date.now() >= DL) { res[k] = { p, late: true }; continue; }
          try { const r = await fetch(p, { signal: AbortSignal.timeout(TO) }); res[k] = { p, status: r.status, body: await r.text() }; }
          catch (e) { res[k] = { p, status: 0, body: `error: ${e.message}` }; }
        }
      }));
      return res;
    }, [paths, RAW_TIMEOUT_MS, deadline]);
    // A .md path with no twin (all atlas.en-us.* pages) answers 200 with the HTML app shell: never cache that.
    for (const b of got) {
      if (b.late) skip(origin + b.p);
      else settle({ ...b, key: origin + b.p, note: '', shell: isShell(b.body) || !b.body.trim() });
    }
    await page.close();
  }

  // Rendered: load, give client-side content up to 20 s to appear, then take the first matching container.
  for (const u of rendered) {
    if (Date.now() >= deadline) { skip(u.href); continue; }
    const page = await browser.newPage();
    let navErr = '';
    const nav = await page.goto(u.href, { waitUntil: 'load', timeout: 45000 }).catch(e => { navErr = e.message.split('\n')[0]; return null; });
    if (navErr) { emit({ p: u.href, status: 0, body: `error: ${navErr}`, key: u.href, note: '' }); await page.close(); continue; }
    // Poll from Node: waitForFunction needs string eval, which some sites' CSP refuses (zeroheight does).
    let got = { sel: 'body', text: '' }, mainAt = 0, matchAt = 0, last = '', same = 0;
    const peak = {};
    for (const end = Date.now() + 20000; Date.now() < end; await page.waitForTimeout(500)) {
      got = await page.evaluate(extract, [CONTENT, false]).catch(e => ({ sel: 'body', text: `extract failed: ${e.message}` }));
      // `main` can be only the site nav while the article still renders (LDS): give a better match 5 s to appear.
      if (got.sel === 'main' && Date.now() - (mainAt ||= Date.now()) < 5000) continue;
      // A container can appear before it is filled (API reference nav first, code samples last): wait for 1 s
      // unchanged with nothing pending, 4 s if a component never renders, 8 s after it last grew if it never settles.
      same = `${got.text.length}/${got.pending}` === last ? same + 1 : 0;
      last = `${got.text.length}/${got.pending}`;
      // The cap restarts only when a container passes its own peak: body text is ignored, and flips do not restart it.
      if (got.sel !== 'body' && got.text.length > (peak[got.sel] || 0)) { peak[got.sel] = got.text.length; matchAt = Date.now(); }
      if (got.sel !== 'body' && !got.hold && (same >= (got.pending ? 8 : 2) || Date.now() - matchAt > 8000)) break;
    }
    // Only after the wait: inside it, the fallback would win before the real container rendered.
    if (got.sel === 'body') got = await page.evaluate(extract, [CONTENT, true])
      .catch(e => { console.error(`fallback failed on ${u.href}: ${e.message.split('\n')[0]}`); return got; });
    const { sel, text, links, hold } = got;
    // A redirect is shown and cited: a mistyped atlas topic lands on its guide's landing page with status 200, and a
    // Help article can move to another ?id= on the same path.
    const to = new URL(page.url()), hop = sameDoc(to, u) ? '' : ` [redirected ${to.href}]`;
    // Old atlas URLs (and the LDS home) redirect to pages that have a .md twin: keep the rendered links, read the twin.
    const moved = hop && twinOf(to);
    const tryTwin = moved && !noTwin(moved);
    // Any failure (late navigation, body error, 15 s hang) keeps the rendered text, and the output line says why.
    // 15 s, not RAW_TIMEOUT_MS: this runs after a full render, so it counts against a rendered page's budget.
    const tw = tryTwin ? await page.evaluate(p => fetch(p, { signal: AbortSignal.timeout(15000) })
      .then(async r => ({ status: r.status, body: await r.text() })).catch(e => ({ why: e.name })), moved.pathname)
      .catch(e => ({ why: e.message.split('\n')[0] })) : {};
    const gone = !tw.why && missingTwin(tw.status, tw.body);
    const md = !tw.why && !gone && tw.status === 200 ? tw.body : '';
    const why = tw.why || (gone ? (tw.status === 404 ? 'status 404' : isShell(tw.body) ? 'shell' : 'empty') : `status ${tw.status}`);
    if (tryTwin && gone) markMissing(moved);
    const failed = tryTwin && !md ? ` [twin failed: ${why}]` : '';
    if (md) {
      emit({ p: u.href, status: 200, body: md, md: true, links, key: u.href, src: official(moved), note: ` [twin ${moved.pathname}] [redirected ${official(moved)}]` });
      await page.close();
      continue;
    }
    // A shell (no container, extract failed, or API docs still not loaded at 20 s) is reported but never cached.
    emit({ p: u.origin + u.pathname + u.search, status: nav?.status() ?? 0, body: text, links, key: u.href,
      src: hop && to.href, note: ` [${sel}]${hold ? ' [api docs did not load]' : ''}${hop}${failed}`, offsite: !SITES.includes(to.host), shell: sel === 'body' || hold, fallback: sel === 'fallback' });
    await page.close();
  }

  // Name the line actually printed for the first argument: a twin that fell back prints under the page it rendered.
  const shown = new Map(results.map(r => [r.key, r.p]));
  for (const [g, k] of sameAs) console.log(`same ${g} as ${shown.get(k) ?? shown.get(asked.get(k)?.href) ?? skippedAs.get(k) ?? skippedAs.get(asked.get(k)?.href) ?? k}`);
  const late = skippedAs.size;
  console.log(`fetched ${urls.length - late}, 200 ${ok}, unique bodies ${seen.size}${refused.length ? `, refused ${refused.length}` : ''}${late ? `, not fetched ${late} (time limit)` : ''}, out ${slash(out)}`);
  if (!urls.length && refused.length) process.exitCode = 1; // nothing on a doc site was asked for
  for (const f of terms.length ? saved : []) {
    console.log(`\n== ${slash(relative(out, f))}\n${grep(f, terms).join('\n') || 'no match'}`);
    const links = statSync(`${f}.links.txt`, { throwIfNoEntry: false }) ? grep(`${f}.links.txt`, terms) : [];
    if (links.length) console.log(`== ${slash(relative(out, f))}.links.txt\n${links.join('\n')}`);
  }
} finally {
  await browser.close();
}
