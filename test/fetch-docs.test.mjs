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

test('a quote with an apostrophe matches whether the term or the cached line has it curly', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/page.md': '# Page\n\nThe org\u2019s limit is 100.\n\nThe user\'s limit is 5.' });
  const curlyTerm = run(out, '--search', 'user\u2019s');
  assert.match(curlyTerm.out, /The user's limit is 5\./);
  const straightTerm = run(out, '--search', "org's");
  assert.match(straightTerm.out, /The org\u2019s limit is 100\./); // a page cached with curly quotes
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

test('--quote with no :line, or a line part it cannot read, names the form, not a chopped file name', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/page.md': '# Page\n\nThe limit is 100.' });
  const f = 'developer.salesforce.com/docs/a/b/c/page.md';
  for (const spec of [f, `${f}:4-5`, `${f}:4,`, 'C:\\cache\\page.md']) {
    const r = run(out, '--quote', spec);
    assert.equal(r.code, 1, spec);
    assert.ok(r.err.includes(`not <cache file>:<line>[,<line>...]: ${spec}\n`), `${spec}:\n${r.err}`);
  }
});

test('an http:// URL for a cached page is served without a [redirected] note', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/page.md': '# Page\n\nhello' });
  const r = run(out, 'http://developer.salesforce.com/docs/a/b/c/page.md');
  assert.match(r.out, /\(cached\)/, r.out);
  assert.doesNotMatch(r.out, /redirected/, r.out);
});

test('http:// and https:// for one page in one call are fetched once', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/page.md': '# Page\n\nhello' });
  const r = run(out, 'https://developer.salesforce.com/docs/a/b/c/page.md', 'http://developer.salesforce.com/docs/a/b/c/page.md').out;
  assert.equal(r.split('\n').filter(l => l.includes('(cached)')).length, 1, r);
  assert.doesNotMatch(r, /duplicate-of|redirected/, r);
});

test('a page 0.1.2 cached with an http:// Source line is not reported as redirected', () => {
  const out = cache({});
  mkdirSync(join(out, 'developer.salesforce.com/docs/a/b/c'), { recursive: true });
  writeFileSync(join(out, 'developer.salesforce.com/docs/a/b/c/page.md'), 'Source: http://developer.salesforce.com/docs/a/b/c/page.html\n# Page\n\nhello');
  const r = run(out, 'https://developer.salesforce.com/docs/a/b/c/page.html').out;
  assert.match(r, /\(cached\)/, r);
  assert.doesNotMatch(r, /redirected/, r);
});

test('a refused http:// URL is echoed as given', () => {
  assert.match(run(cache({}), 'http://example.com/x').out, /^refused http:\/\/example\.com\/x: not an official doc site$/m);
});

// A list or table a --terms match lands in is printed whole, so the caller never picks a reading window.
const shown = r => r.split('\n').filter(l => /^\d+: /.test(l));
const page = parts => parts.flat().join('\n');

test('--terms prints a whole markdown table when a match lands in its header, past the match cap', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/table.md': page([lines(30, i => `filler ${i}`), '', '## Editions', '',
    '| Edition | Limit |', '| --- | --- |', lines(30, i => `| Name ${i} | ${i} |`), '', '## Next', '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'edition', '/docs/a/b/c/table.md').out;
  assert.match(r, /^66: \| Name 30 \| 30 \|$/m, r);
  assert.doesNotMatch(r, /after \d/, r);
});

test('--terms prints a whole rendered table, spilled cells included, and stops before the next table', () => {
  const rows = lines(25, i => i === 5 ? 'format\t\n\nOptional. Values are:\n\njson\nxml\n' : `p${i}\tdesc ${i}`);
  const out = cache({ 'help.salesforce.com/s/articleView_id_t.htm_type_5.txt': page([lines(30, i => `filler ${i}`),
    'PARAMETER\tDESCRIPTION', rows, 'Other Limits', 'Intro line.', 'NAME\tVALUE', lines(5, i => `other${i}\tv${i}`)]) });
  const r = run(out, '--terms', 'parameter', 'https://help.salesforce.com/s/articleView?id=t.htm&type=5').out;
  assert.ok(shown(r).some(l => l.endsWith(': p25\tdesc 25')), r);
  assert.ok(shown(r).some(l => l.endsWith(': json')), r);
  assert.doesNotMatch(r, /other\d\tv/, r);
});

test('--terms prints a whole list of bold terms when a match lands in one definition', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/terms.md': page([lines(30, i => `filler ${i}`), '', '## Glossary', '',
    lines(8, i => `**Term ${i}**\n\nDefinition ${i}.\n`), '## Next', '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'definition 3', '/docs/a/b/c/terms.md').out;
  assert.ok(shown(r).some(l => l.endsWith(': **Term 8**')), r);
  assert.ok(shown(r).some(l => l.endsWith(': Definition 1.')), r);
  assert.doesNotMatch(r, /after \d/, r);
});

test('Q50: --terms prints the sixth pattern row although the match cap falls before the table', () => {
  const rows = ['Request and Reply', 'Fire and Forget', 'Batch Data Synchronization', 'Remote Call-In', 'UI Update Based on Data Changes', 'Data Virtualization']
    .map((t, i) => `[${t}](https://architect.salesforce.com/docs/architect/fundamentals/guide/integration-patterns.html#p${i})\n\nWhat ${t} does.\n`);
  const out = cache({ 'architect.salesforce.com/docs/architect/fundamentals/guide/integration-patterns.md': page([
    lines(25, i => `pattern prose ${i}\n`), '**List of Patterns**', '', 'Patterns', '', 'Scenario', '', rows,
    '**Pattern Approach**', '', 'Three categories follow.', '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'pattern', 'https://architect.salesforce.com/docs/architect/fundamentals/guide/integration-patterns.md').out;
  assert.ok(shown(r).some(l => l.includes('[Data Virtualization]')), r);
  assert.ok(shown(r).some(l => l.endsWith(': What Data Virtualization does.')), r);
  assert.match(r, /^\(list or table, lines 52-\d+, shown whole\)\n52: \*\*List of Patterns\*\*$/m, r); // its bold caption leads in
});

test('a list too long to print is named by its line range instead', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/long-list.md': page([lines(30, i => `filler ${i}`), '', '## Values', '',
    lines(120, i => `- value ${i}`), '', '## Next', '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'values', '/docs/a/b/c/long-list.md').out;
  assert.match(r, /^\(list or table, lines 33-154, 122 lines: too long to show; Read 33-154\)$/m, r);
  assert.doesNotMatch(r, /value 120/, r);
  assert.match(r, /^33: ## Values$/m, r); // a match inside a block too long to print still prints
});

test('a match on the plain caption above a rendered table prints the table', () => {
  const out = cache({ 'help.salesforce.com/s/articleView_id_c.htm_type_5.txt': page([lines(30, i => `filler ${i}`),
    'Request Parameters', 'NAME\tDESCRIPTION', lines(25, i => `p${i}\tdesc ${i}`), lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'request parameters', 'https://help.salesforce.com/s/articleView?id=c.htm&type=5').out;
  assert.ok(shown(r).some(l => l.endsWith(': p25\tdesc 25')), r);
});

test('an llms.txt index is never printed or named as a block', () => {
  const out = cache({ 'developer.salesforce.com/docs/llms-x.txt': lines(200, i => `- [Topic ${i}](https://developer.salesforce.com/docs/t${i}.md)${i === 150 ? ' scratch org' : ''}`) });
  const r = run(out, '--terms', 'scratch org', 'https://developer.salesforce.com/docs/llms-x.txt').out;
  assert.match(r, /^151: - \[Topic 150\]/m, r);
  assert.doesNotMatch(r, /list or table/, r);
  const many = run(out, '--terms', 'topic', 'https://developer.salesforce.com/docs/llms-x.txt').out;
  assert.equal(shown(many).length, 20, many); // the page cap, not the 10 of a links sidecar
});

test('a page prints only the block with the most matches', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/two.md': page([lines(30, i => `filler ${i}`), '', '## Small', '',
    lines(4, i => `- small item ${i}${i === 1 ? ' tooltip' : ''}`), '', '## Big', '', lines(6, i => `- tooltip row ${i}`), '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'tooltip', '/docs/a/b/c/two.md').out;
  assert.equal(r.split('\n').filter(l => l.startsWith('(list or table')).length, 1, r);
  assert.ok(shown(r).some(l => l.endsWith(': - tooltip row 6')), r);
  assert.ok(shown(r).some(l => l.endsWith(': - small item 1 tooltip')), r); // still shown as a matching line
});

test('a block past 200 lines is neither printed nor named, only its matching lines', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/huge.md': page([lines(30, i => `filler ${i}`), '', '## Values', '',
    lines(300, i => `- value ${i}${i === 250 ? ' edition' : ''}`), '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'edition', '/docs/a/b/c/huge.md').out;
  assert.match(r, /^284: - value 250 edition$/m, r);
  assert.doesNotMatch(r, /list or table/, r);
});

test('a block holding a rare term outranks one holding more matches of a common term', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/rare.md': page([lines(20, i => `common words ${i}`), '', '**List of Rows**', '',
    lines(5, i => `- row ${i}`), '', '**Approach**', '', 'The common words are classified:', '', lines(3, i => `- kind ${i}${i === 1 ? ' common words' : ''}`), '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'common words,list of rows', '/docs/a/b/c/rare.md').out;
  assert.ok(shown(r).some(l => l.endsWith(': - row 5')), r);
});

test('a bold caption on its own line does not hide the first row of the list under it', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/caption.md': page([lines(30, i => `filler ${i}`), '', '**List of Rows**', '',
    lines(5, i => `- row ${i}`), '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'list of rows', '/docs/a/b/c/caption.md').out;
  assert.match(r, /^\(list or table, lines 33-39, shown whole\)$/m, r);
});

test('lines inside a code fence are never rows, so a doc comment cannot take the list\'s block', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/fence.md': page([lines(30, i => `filler ${i}`), '', '## Items', '',
    lines(7, i => `- item ${i}${i === 1 ? ' tooltip' : ''}`), '', '```apex', '/**', ' * Sets the tooltip text.', ' * @param tooltip the text',
    ' * @return the tooltip', ' */', '```', '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'tooltip', '/docs/a/b/c/fence.md').out;
  assert.ok(shown(r).some(l => l.endsWith(': - item 7')), r);
});

test('a table right after a list keeps its header row', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/after.md': page([lines(30, i => `filler ${i}`), '', '- one', '- two', '- three', '',
    '| Edition | Limit |', '| --- | --- |', lines(5, i => `| Name ${i} | ${i} |`), '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'edition', '/docs/a/b/c/after.md').out;
  assert.ok(shown(r).some(l => l.endsWith(': | Name 5 | 5 |')), r);
});

test('two bullet lists with a sentence between them are two blocks', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/two-lists.md': page([lines(30, i => `filler ${i}`), '', lines(3, i => `- apple ${i}`), '',
    'Oranges are next and unrelated.', '', lines(3, i => `- orange ${i}`), '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'apple 2', '/docs/a/b/c/two-lists.md').out;
  assert.ok(shown(r).some(l => l.endsWith(': - apple 3')), r);
  assert.doesNotMatch(r, /orange/, r);
});

test('a flattened table with a two-paragraph cell prints every row', () => {
  const rows = lines(6, i => `[Row ${i}](https://architect.salesforce.com/x.html#r${i})\n\nWhat row ${i} does.${i === 4 ? '\n\nA second paragraph.' : ''}\n`);
  const out = cache({ 'architect.salesforce.com/docs/architect/x.md': page([lines(30, i => `filler ${i}`), '', '**List of Rows**', '', rows, '**Next**', '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'list of rows', 'https://architect.salesforce.com/docs/architect/x.md').out;
  assert.ok(shown(r).some(l => l.includes('[Row 6]')), r);
});

test('a rendered row whose first cell spills over lines before its tabs stays in the table', () => {
  const out = cache({ 'help.salesforce.com/s/articleView_id_spill.htm_type_5.txt': page([lines(30, i => `filler ${i}`),
    'PER-ORG LIMIT\tESSENTIALS\tENTERPRISE', lines(4, i => `limit ${i}\t${i}\t${i}`), '', 'Combined total of these automations.', '', 'Resume events', 'Time triggers',
    '\t20,000\t20,000', lines(3, i => `last ${i}\t${i}\t${i}`), lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'per-org limit', 'https://help.salesforce.com/s/articleView?id=spill.htm&type=5').out;
  assert.ok(shown(r).some(l => l.endsWith(': last 3\t3\t3')), r);
});

test('two rendered tables with a caption between them are two blocks', () => {
  const out = cache({ 'help.salesforce.com/s/articleView_id_two.htm_type_5.txt': page([lines(30, i => `filler ${i}`),
    'NAME\tVALUE', lines(4, i => `first${i}\tv${i}`), 'Table 2. Other', 'KEY\tVALUE', lines(4, i => `second${i}\tw${i}`), lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'first2', 'https://help.salesforce.com/s/articleView?id=two.htm&type=5').out;
  assert.ok(shown(r).some(l => l.endsWith(': first4\tv4')), r);
  assert.doesNotMatch(r, /second\d/, r);
});

test('a block leads in with at most two lines above its first row', () => {
  const out = cache({ 'help.salesforce.com/s/articleView_id_lead.htm_type_5.txt': page([lines(30, i => `filler ${i}`),
    'Limits', 'NAME\tVALUE', lines(5, i => `row${i}\tv${i}`), lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'limits', 'https://help.salesforce.com/s/articleView?id=lead.htm&type=5').out;
  assert.match(r, /^\(list or table, lines 31-38, shown whole\)$/m, r);
});

test('lines outside the block rank by how rare their term is on the whole page', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/rarity.md': page([lines(30, i => `filler ${i}`), '', '## Items', '',
    lines(30, i => `- common item ${i}`), '', 'one more common line', '', lines(25, i => `rare line ${i}\n`), lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'common,rare', '/docs/a/b/c/rarity.md').out;
  assert.equal(shown(r).filter(l => / rare line \d+$/.test(l)).length, 20, r); // 'common' is on 31 lines, 'rare' on 25
  assert.doesNotMatch(r, /one more common line/, r);
});

test('a block line longer than 300 chars prints clipped, as a matching line does', () => {
  const out = cache({ 'help.salesforce.com/s/articleView_id_long.htm_type_5.txt': page([lines(30, i => `filler ${i}`),
    'NAME\tDESCRIPTION', 'a\tshort', `b\t${'x'.repeat(5000)}`, 'c\tshort', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'description', 'https://help.salesforce.com/s/articleView?id=long.htm&type=5').out;
  assert.ok(r.length < 2000, `${r.length} chars`);
  assert.ok(shown(r).some(l => l.endsWith(': c\tshort')), r);
});

test('a doc page whose name starts with llms is a page, not an llms.txt index', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/llms-overview.html.txt': page([lines(30, i => `filler ${i}`), '', '## Steps', '',
    lines(25, i => `- step ${i}`), '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'steps', 'https://developer.salesforce.com/docs/a/b/c/llms-overview.html').out;
  assert.ok(shown(r).some(l => l.endsWith(': - step 25')), r);
});

test('a list item holding a tab is still a list row', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/tabbed.md': page([lines(30, i => `filler ${i}`), '', '## Keys', '',
    lines(5, i => i === 3 ? '- key 3\twith a tab' : `- key ${i}`), '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'keys', '/docs/a/b/c/tabbed.md').out;
  assert.ok(shown(r).some(l => l.endsWith(': - key 5')), r);
});

test('a match in a nested item prints the whole list it sits in', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/nested.md': page([lines(30, i => `filler ${i}`), '',
    '- a', '  - a1 target', '- b', '- c', '- d', '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'target', '/docs/a/b/c/nested.md').out;
  assert.ok(shown(r).some(l => l.endsWith(': - d')), r);
});

test('two items are not a block', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/pair.md': page([lines(30, i => `filler ${i}`), '', '- x1 target', '- x2', '', lines(30, i => `after ${i}`)]) });
  assert.doesNotMatch(run(out, '--terms', 'target', '/docs/a/b/c/pair.md').out, /list or table/);
});

test('between blocks scoring the same, the denser one prints', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/dense.md': page([lines(30, i => `filler ${i}`), '',
    lines(8, i => `- big ${i}${i === 1 ? ' target' : ''}`), '', 'Between.', '', lines(3, i => `- small ${i}${i === 1 ? ' target' : ''}`), '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'target', '/docs/a/b/c/dense.md').out;
  assert.ok(shown(r).some(l => l.endsWith(': - small 3')), r);
});

test('a row of another kind ends a run, so a table after link rows keeps its header', () => {
  const rows = lines(3, i => `[Row ${i}](https://architect.salesforce.com/x.html#r${i})\n\nWhat row ${i} does.\n`);
  const out = cache({ 'architect.salesforce.com/docs/architect/y.md': page([lines(30, i => `filler ${i}`), '', rows,
    '| Edition | Limit |', '| --- | --- |', lines(5, i => `| Name ${i} | ${i} |`), '', lines(30, i => `after ${i}`)]) });
  const r = run(out, '--terms', 'edition', 'https://architect.salesforce.com/docs/architect/y.md').out;
  assert.ok(shown(r).some(l => l.endsWith(': | Name 5 | 5 |')), r);
});

test('a block never leads in with the code fence above it', () => {
  const out = cache({ 'developer.salesforce.com/docs/a/b/c/code-then-list.md': page([lines(30, i => `filler ${i}`), '',
    '```js', 'call(target)', '```', '- a', '- b', '- c', '', lines(30, i => `after ${i}`)]) });
  assert.doesNotMatch(run(out, '--terms', 'target', '/docs/a/b/c/code-then-list.md').out, /list or table/);
});
