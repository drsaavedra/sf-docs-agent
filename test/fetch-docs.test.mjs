// Offline tests: each seeds a temp cache with fresh pages, which the script serves from disk without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fetch-docs.mjs');

// files: { '<host>/<path>': '<body without the Source line>' }; each is saved as the script saves a page.
function cache(files) {
  const out = mkdtempSync(join(tmpdir(), 'sf-docs-test-'));
  for (const [rel, body] of Object.entries(files)) {
    const f = join(out, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `Source: https://${rel.replace(/\.md$/, '.html')}\n${body}`);
  }
  return out;
}
const run = (out, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--out', out, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');

test('a cached page is served from disk', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/page.md': '# Page\n\nhello' });
  const r = run(out, '/docs/a/b/c/page.md');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^200 \d+ .*page\.md \(cached\) -> developer\.salesforce\.com\/docs\/a\/b\/c\/page\.md$/m);
});

test('--quote copies the chosen lines and names the official page', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/page.md': '# Page\n\nThe limit is 100.' });
  const r = run(out, '--quote', 'developer.salesforce.com/docs/a/b/c/page.md:4');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /- "The limit is 100\." \[1:4\]/);
  assert.match(r.out, /\[1\] https:\/\/developer\.salesforce\.com\/docs\/a\/b\/c\/page\.html/);
});

test('a host that is not a doc site is refused', () => {
  const out = cache({});
  const r = run(out, 'https://example.com/x');
  assert.match(r.out, /^refused https:\/\/example\.com\/x: not an official doc site$/m);
});

test('--terms prints a long page\'s matching lines with their numbers', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/long.md': lines(80, i => i === 50 ? 'governor limit here' : `filler ${i}`) });
  const r = run(out, '--terms', 'governor', '/docs/a/b/c/long.md');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^51: governor limit here$/m); // line 1 is the Source line
});

test('--terms with no value prints the usage line, not a stack trace', () => {
  const r = run(cache({}), '/docs/a/b/c/page.md', '--terms');
  assert.equal(r.code, 2);
  assert.match(r.err, /^usage:/);
});

test('a malformed URL, a non-http scheme or a stray flag is refused, not fetched or crashed on', () => {
  const r = run(cache({}), 'https://', 'ftp://developer.salesforce.com/x', '--bogus');
  assert.doesNotMatch(r.err, /TypeError/);
  for (const a of ['https://', 'ftp://developer.salesforce.com/x', '--bogus']) assert.ok(r.out.includes(`refused ${a}: not a URL`), `${a} not refused as not a URL:\n${r.out}`);
});

test('--search and --terms never return line 1, the Source line --quote refuses', () => {
  const out = cache({ 'developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/p.htm.txt': lines(80, i => `filler ${i}`) });
  assert.match(run(out, '--search', 'apexcode').out, /^no match in the cache$/m);
  assert.doesNotMatch(run(out, '--terms', 'apexcode', 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/p.htm').out, /^1: Source:/m);
});

test('--terms matches the first line of a .links.txt sidecar, which has no Source line', () => {
  const out = cache({ 'help.salesforce.com/s/articleView_id_x.htm_type_5.txt': lines(50, i => `filler ${i}`) });
  writeFileSync(join(out, 'help.salesforce.com/s/articleView_id_x.htm_type_5.txt.links.txt'), `/s/articleView?id=toast_first.htm Toast first\n${lines(50, i => `/s/x${i} other`)}\n`);
  const r = run(out, '--terms', 'toast', 'https://help.salesforce.com/s/articleView?id=x.htm&type=5').out;
  assert.match(r, /^1: \/s\/articleView\?id=toast_first\.htm Toast first$/m, r);
});

test('a term named like an Object property (constructor) still ranks its rare line first', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/apex.md': lines(80, i => i === 70 ? 'the constructor runs once' : `method ${i}`) });
  assert.match(run(out, '--terms', 'constructor,method', '/docs/a/b/c/apex.md').out, /^71: the constructor runs once$/m);
});

test('--search shows lines from more than the file that sorts first', () => {
  const out = cache({
    'developer.salesforce.com/docs/a/a/a/first.md': lines(50, i => `soql queries row ${i}`),
    'developer.salesforce.com/docs/z/z/z/answer.md': lines(50, i => i === 9 ? 'the soql queries limit is 100' : `other ${i}`),
  });
  assert.match(run(out, '--search', 'soql,queries').out, /answer\.md:10: the soql queries limit is 100/);
});

test('--search skips index files (llms*.txt, sitemaps), which --terms on the index already shows', () => {
  const out = cache({
    'developer.salesforce.com/docs/llms-platform.txt': lines(50, i => `- [Bulk API ${i}](https://developer.salesforce.com/docs/x${i}.md)`),
    'help.salesforce.com/apex/Help_SiteMapExternal_page_1.txt': lines(50, i => `<loc>bulk api ${i}</loc>`),
    'developer.salesforce.com/docs/a/b/c/bulk.md': lines(50, i => i === 5 ? 'Bulk API limits apply' : `x ${i}`),
  });
  const r = run(out, '--search', 'bulk api').out;
  assert.match(r, /bulk\.md:6: Bulk API limits apply/);
  assert.doesNotMatch(r, /llms-platform|SiteMap/);
});

test('--search --site takes lightningdesignsystem.com, and a missing term is a usage error', () => {
  const out = cache({ 'www.lightningdesignsystem.com/2e1ef8501/p/toast.md': lines(50, i => i === 3 ? 'toast variants' : `x ${i}`) });
  assert.match(run(out, '--search', 'toast', '--site', 'lightningdesignsystem.com').out, /toast\.md:4: toast variants/);
  const r = run(out, '--search', '--site', 'help.salesforce.com');
  assert.equal(r.code, 2);
  assert.match(r.err, /^usage:/);
});

test('--search --site with no value or an unknown host is a usage error, not a search of everything', () => {
  const out = cache({ 'www.lightningdesignsystem.com/2e1ef8501/p/toast.md': lines(50, i => i === 3 ? 'toast variants' : `x ${i}`) });
  for (const args of [['--search', 'toast', '--site'], ['--search', 'toast', '--site', 'example.com']]) {
    const r = run(out, ...args);
    assert.equal(r.code, 2, `${args.join(' ')}:\n${r.out}`);
    assert.match(r.err, /^usage:/);
  }
});

test('--search reports a site folder it cannot read instead of saying no match', () => {
  const out = cache({ 'help.salesforce.com/s/a.txt': lines(50, i => `x ${i}`) });
  chmodSync(join(out, 'help.salesforce.com'), 0o000);
  try {
    assert.match(run(out, '--search', 'anything').err, /search: .*EACCES|search: .*permission denied/i);
  } finally { chmodSync(join(out, 'help.salesforce.com'), 0o755); }
});

test('--terms on a Help sitemap lists up to 40 articles by their <loc> line only', () => {
  const body = lines(60, i => `<loc>https://help.salesforce.com/s/articleView?id=platform.flow_${i}.htm&amp;type=5</loc>\n<lastmod>x</lastmod><xhtml:link href="https://help.salesforce.com/s/articleView?id=platform.flow_${i}.htm&amp;language=de"/>`);
  const out = cache({ 'help.salesforce.com/apex/Help_SiteMapExternal_page_1_producttype_platform.txt': body });
  const r = run(out, '--terms', 'flow', 'https://help.salesforce.com/apex/Help_SiteMapExternal?page=1&producttype=platform').out;
  const shown = r.split('\n').filter(l => /^\d+: /.test(l));
  assert.equal(shown.length, 40, r);
  assert.ok(shown.every(l => l.includes('<loc>')), 'only <loc> lines');
});

test('--terms on a sitemap index prints every <loc> line, whatever the terms, past the 40 cap', () => {
  const body = lines(50, i => `<loc>https://help.salesforce.com/apex/Help_SiteMapExternal?page=${i}&#38;producttype=platform</loc>\n<lastmod>x</lastmod>`);
  const out = cache({ 'help.salesforce.com/apex/Help_SiteMapIndexExternal_producttype_platform.txt': body });
  const r = run(out, '--terms', 'salesforce_connect_xorg', 'https://help.salesforce.com/apex/Help_SiteMapIndexExternal?producttype=platform').out;
  const shown = r.split('\n').filter(l => /^\d+: /.test(l));
  assert.equal(shown.length, 50, r);
  assert.ok(shown.every(l => l.includes('<loc>')), 'only <loc> lines');
});

test('a short page prints whole from line 2, without the Source line or a trailing empty line', () => {
  const out = cache({ 'help.salesforce.com/s/articleView_id_short.htm_type_5.txt': '# Short\n\nThe limit is 95%.\n' });
  const r = run(out, '--terms', 'nothing_here', 'https://help.salesforce.com/s/articleView?id=short.htm&type=5').out;
  assert.match(r, /\(short page, shown whole\)/);
  assert.doesNotMatch(r, /^1: /m, r);
  assert.deepEqual(r.split('\n').filter(l => /^\d+: /.test(l)), ['2: # Short', '3: ', '4: The limit is 95%.'], r);
});

test('a doc page about sitemaps is a page, not a sitemap, for --terms and --search', () => {
  const out = cache({ 'help.salesforce.com/s/articleView_id_sf.networks_seo_sitemap.htm_type_5.txt': lines(60, i => i === 30 ? 'The sitemap regenerates every 24 hours.' : `x ${i}`) });
  assert.match(run(out, '--terms', 'regenerates', 'https://help.salesforce.com/s/articleView?id=sf.networks_seo_sitemap.htm&type=5').out, /^31: The sitemap regenerates/m);
  assert.match(run(out, '--search', 'regenerates').out, /sitemap\.htm_type_5\.txt:31: The sitemap regenerates/);
});

test('--terms prints a duplicate page\'s matches once', () => {
  const body = lines(50, i => i === 7 ? 'shared sentence' : `x ${i}`);
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/one.md': body, 'developer.salesforce.com/docs/a/b/c/two.md': body });
  const r = run(out, '--terms', 'shared', '/docs/a/b/c/one.md', '/docs/a/b/c/two.md').out;
  assert.match(r, /duplicate-of/);
  assert.equal(r.split('\n').filter(l => l === '8: shared sentence').length, 1, r);
});

test('the summary does not count budget-skipped pages as fetched', () => {
  const r = run(cache({}), '--budget', '0', '/docs/a/b/c/uncached.md');
  assert.match(r.out, /^not fetched \(time limit\) /m);
  assert.match(r.out, /^fetched 0, .*not fetched 1 \(time limit\)/m);
});

test('a page the fallback read is fetched again, never served from cache', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/page.md': '# Page\n\none section' });
  writeFileSync(join(out, 'developer.salesforce.com/docs/a/b/c/page.md.fallback'), '');
  const r = run(out, '--budget', '0', '/docs/a/b/c/page.md');
  assert.doesNotMatch(r.out, /\(cached\)/);
  assert.match(r.out, /^not fetched \(time limit\) /m);
});

test('a spent budget skips pages without starting the browser', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--out', cache({}), '--budget', '0', '/docs/a/b/c/uncached.md'],
    { encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(tmpdir(), 'no-browser-here') } });
  assert.doesNotMatch(r.stderr, /BLOCKED/);
  assert.match(r.stdout, /^not fetched \(time limit\) /m);
});

test('a call whose every URL is refused exits 1, so a chained command stops', () => {
  assert.equal(run(cache({}), 'https://example.com/x', 'https://trailhead.salesforce.com/y').code, 1);
  assert.equal(run(cache({ 'developer.salesforce.com/docs/a/b/c/page.md': 'ok' }), 'https://example.com/x', '/docs/a/b/c/page.md').code, 0);
});

test('a same line names the URL the time-limit line printed, not an internal .md twin', () => {
  const r = run(cache({}), '--budget', '0', 'https://developer.salesforce.com/docs/a/b/c/page.html', 'https://developer.salesforce.com/docs/a/b/c/page').out;
  assert.match(r, /^not fetched \(time limit\) https:\/\/developer\.salesforce\.com\/docs\/a\/b\/c\/page\.html$/m);
  assert.match(r, /^same https:\/\/developer\.salesforce\.com\/docs\/a\/b\/c\/page as https:\/\/developer\.salesforce\.com\/docs\/a\/b\/c\/page\.html$/m);
});
