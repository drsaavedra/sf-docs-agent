// The site check's drift rule, offline: importing the module fetches nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELP_CHILD, HELP_INDEX, URLS, drifted, moved, parse, retry, unfit } from '../site-check/site-check.mjs';
import { tempDir } from './harness.mjs';

const page = { status: 200, chars: 5000, kinds: '.slds-text-longform', saved: true };

test('the same read is not drift, and a length inside the band is not either', () => {
  assert.equal(drifted(page, { ...page }), false);
  assert.equal(drifted(page, { ...page, chars: 6000 }), false);
});

test('a new container, status or saved state is drift, and so is any fallback read', () => {
  assert.equal(drifted(page, { ...page, kinds: 'main' }), true);
  assert.equal(drifted(page, { ...page, status: 0 }), true);
  assert.equal(drifted(page, { ...page, saved: false }), true);
  const fb = { ...page, kinds: 'fallback' };
  assert.equal(drifted(fb, { ...fb }), true); // even against a baseline that recorded one
  assert.equal(drifted(page, undefined), true);
});

test('a saved page outside the length band is drift; a refused shell of any length is not', () => {
  assert.equal(drifted(page, { ...page, chars: 2000 }), true);
  const shell = { status: 200, chars: 412, kinds: 'body', saved: false };
  assert.equal(drifted(shell, { ...shell, chars: 55 }), false);
});

test('a URL the baseline does not hold is drift, not a crash', () => {
  assert.equal(drifted(undefined, page), true);
});

test('a fallback read, a failed fetch or an unsaved article is no baseline; a page meant to be refused is', () => {
  const u = 'https://help.salesforce.com/s/articleView?id=001096524&type=1';
  assert.equal(unfit(page, u), false);
  assert.equal(unfit({ ...page, kinds: 'fallback' }, u), true);
  assert.equal(unfit({ status: 0, chars: 30, kinds: '', saved: false }, u), true);
  const shell = { status: 200, chars: 600, kinds: 'body', saved: false };
  assert.equal(unfit(shell, u), true); // Help's outage page in place of a real article
  assert.equal(unfit(shell, 'https://developer.salesforce.com/docs/apis'), false);
  // a missing atlas topic now answers 404 and is not saved, which is the result it must keep giving
  const missing = { status: 404, chars: 38, kinds: 'body redirected twin failed:', saved: false };
  assert.equal(unfit(missing, 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_no_such_topic_xyz.htm'), false);
});

test('a raw line is matched back to its URL, including the .md copy fetched in its place', () => {
  const urls = ['https://help.salesforce.com/apex/Help_SiteMapIndexExternal?producttype=ai',
    'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getBasket',
    'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
    'https://v1.lightningdesignsystem.com/components/toast/'];
  const got = parse(urls, [
    '200 3137 /apex/Help_SiteMapIndexExternal?producttype=ai -> help.salesforce.com/x.txt',
    '200 9000 /docs/commerce/commerce-api/references/shopper-baskets.md -> developer.salesforce.com/x.md',
    '200 14820 https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getBasket [doc-amf-reference] -> developer.salesforce.com/y.txt',
    '200 5779 https://v1.lightningdesignsystem.com/components/toast/ [main] -> v1.lightningdesignsystem.com/x.txt',
  ].join('\n'));
  assert.deepEqual(Object.keys(got).sort(), [...urls].sort());
  assert.equal(got[urls[2]].chars, 9000); // the bare page's .md copy, not its ?meta= sibling
  assert.equal(got[urls[3]].kinds, 'main');
});

test('a page still on the outage page after 1 minute is fetched again 3 minutes later', async () => {
  const outage = { status: 200, chars: 249, kinds: 'body', saved: false }, waits = [], reads = [outage, page];
  const { bad } = await retry({ a: page }, { a: outage }, ['a'], () => ({ a: reads.shift() }), ms => waits.push(ms));
  assert.deepEqual(waits, [60000, 180000]);
  assert.deepEqual(bad, []);
});

test('a retry stops once nothing drifts, and a URL with no result line stays drifted', async () => {
  const outage = { status: 200, chars: 249, kinds: 'body', saved: false }, waits = [];
  const fixed = await retry({ a: page }, { a: outage }, ['a'], () => ({ a: page }), ms => waits.push(ms));
  assert.deepEqual([waits, fixed.bad], [[60000], []]);
  const lost = await retry({ a: page }, { a: outage }, ['a'], () => ({}), () => {});
  assert.deepEqual(lost.bad, ['a']);
});

test('a saved Help article whose sidecar holds no article links is drift, and never a baseline', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-check-test-')), u = 'https://help.salesforce.com/s/articleView?id=a.htm&type=5';
  mkdirSync(join(out, 'help.salesforce.com/s'), { recursive: true });
  const line = '200 5000 https://help.salesforce.com/s/articleView?id=a.htm&type=5 [.slds-text-longform] -> help.salesforce.com/s/a.txt';
  writeFileSync(join(out, 'help.salesforce.com/s/a.txt.links.txt'), '/s/articleView?id=b.htm&language=en_US&type=5 B\n/s/articleView?language=en_US&id=c.htm&type=5 C\n/s/login Log in\n');
  const good = parse([u], line, out)[u];
  assert.equal(good.links, 2); // the id first or after language
  assert.equal(drifted(page, good), false);
  writeFileSync(join(out, 'help.salesforce.com/s/a.txt.links.txt'), '/s/login Log in\n/s/products Products\n');
  const navOnly = parse([u], line, out)[u];
  assert.deepEqual([navOnly.links, drifted(page, navOnly), unfit(navOnly, u)], [0, true, true]);
  assert.equal(parse([u], line, join(out, 'missing'))[u].links, 0); // no sidecar at all
  assert.equal(parse([u], line)[u].links, undefined); // no out dir: the parse tests above are unchanged
  rmSync(out, { recursive: true, force: true });
});

test('an async refetch is merged by its result, not its Promise', async () => {
  const outage = { status: 200, chars: 249, kinds: 'body', saved: false };
  const { bad } = await retry({ a: page }, { a: outage }, ['a'], async () => ({ a: page }), () => {});
  assert.deepEqual(bad, []);
});

test('a sidecar that cannot be read is an error, not 0 article links', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-check-test-')), u = 'https://help.salesforce.com/s/articleView?id=a.htm&type=5';
  mkdirSync(join(out, 'help.salesforce.com/s/a.txt.links.txt'), { recursive: true }); // a directory: EISDIR on read
  const line = '200 5000 https://help.salesforce.com/s/articleView?id=a.htm&type=5 [.slds-text-longform] -> help.salesforce.com/s/a.txt';
  try { assert.throws(() => parse([u], line, out), { code: 'EISDIR' }); }
  finally { rmSync(out, { recursive: true, force: true }); }
});

// A copy of the check beside a fake fetch-docs, which writes one Help page's sidecar and its result line, and fails while a 'fail' file exists.
const FAKE = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[process.argv.indexOf('--out') + 1], url = process.argv.at(-1);
if (existsSync(new URL('fail', import.meta.url))) { console.error('BLOCKED: no browser'); process.exit(3); }
mkdirSync(join(out, 'help'), { recursive: true });
writeFileSync(join(out, 'help/a.txt.links.txt'), '/s/articleView?id=b.htm&type=5 B\\n');
console.log('200 5000 ' + url + ' [.slds-text-longform] -> help/a.txt');`;
const copy = async () => {
  const dir = tempDir('sf-docs-check-');
  mkdirSync(join(dir, 'site-check'));
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '../site-check/site-check.mjs'), join(dir, 'site-check/site-check.mjs'));
  writeFileSync(join(dir, 'fetch-docs.mjs'), FAKE);
  return { dir, ...await import(pathToFileURL(join(dir, 'site-check/site-check.mjs')).href) };
};
const HELP = 'https://help.salesforce.com/s/articleView?id=a.htm&type=5';

test('a run hands parse its out dir, so a Help page counts its article links', async () => {
  const { run } = await copy();
  assert.equal(run([HELP])[HELP].links, 1);
});

test('a later run that fetches cleanly drops the failure the first one recorded', async t => {
  const { dir, run, failure } = await copy();
  t.mock.method(console, 'error', () => {});
  writeFileSync(join(dir, 'fail'), '');
  run([HELP]);
  assert.match(failure(), /BLOCKED: no browser/);
  rmSync(join(dir, 'fail'));
  run([HELP]);
  assert.equal(failure(), '');
});

test('a redirect that lands on a different page is drift, though kinds and size match', () => {
  const u = 'https://developer.salesforce.com/docs/atlas.en-us.x.meta/x/topic.htm';
  const at = to => parse([u], `200 1203 ${u} [twin /docs/p/${to}.md] [redirected https://developer.salesforce.com/docs/p/${to}.html] -> a.txt`)[u];
  const was = at('object-topic');
  assert.equal(was.to, 'https://developer.salesforce.com/docs/p/object-topic.html');
  assert.equal(drifted(was, at('object-topic')), false);
  assert.equal(drifted(was, at('sforce-api-objects-list')), true);
  assert.equal(parse([u], `200 5000 ${u} [div.body] -> a.txt`)[u].to, undefined); // no redirect, no field
  // Help can add a language or a fragment to the same article: only host, path and ?id= name the page, as fetch-docs' sameDoc reads it.
  const help = to => ({ ...was, to });
  assert.equal(drifted(help('https://help.salesforce.com/s/articleView?id=a.htm&type=5'), help('https://help.salesforce.com/s/articleView?id=a.htm&type=5&language=en_US#top')), false);
  assert.equal(drifted(help('https://help.salesforce.com/s/articleView?id=a.htm&type=5'), help('https://help.salesforce.com/s/articleView?id=b.htm&type=5')), true);
  // A trailing slash or the scheme does not move a page, and a bad URL is drift, not a crash.
  assert.equal(drifted(help('https://developer.salesforce.com/docs/p/x.html'), help('http://developer.salesforce.com/docs/p/x.html/')), false);
  assert.equal(drifted(help('not a url'), help('https://developer.salesforce.com/docs/p/x.html')), true);
});

test('the set of per-product indexes in llms.txt is pinned, its descriptions are not', () => {
  const out = tempDir('site-check-test-'), u = 'https://developer.salesforce.com/docs/llms.txt';
  mkdirSync(join(out, 'developer.salesforce.com/docs'), { recursive: true });
  const read = text => { writeFileSync(join(out, 'developer.salesforce.com/docs/llms.txt'), text);
    return parse([u], '200 16755 /docs/llms.txt -> developer.salesforce.com/docs/llms.txt', out)[u]; };
  const was = read('- [Apex](https://developer.salesforce.com/docs/llms-apex.txt): Apex\n- [LWC](/docs/llms-lwc.txt): LWC\n');
  assert.deepEqual(was.indexes, ['/docs/llms-apex.txt', '/docs/llms-lwc.txt']);
  assert.equal(drifted(was, read('- [LWC](/docs/llms-lwc.txt): Lightning Web Components\n- [Apex](https://developer.salesforce.com/docs/llms-apex.txt): The Apex guide\n')), false);
  assert.equal(drifted(was, read('- [Apex](/docs/llms-apex.txt)\n- [LWC](/docs/llms-lwc.txt)\n- [Obj](/docs/llms-platform-obj.txt)\n')), true);
  assert.equal(drifted(was, read('- [Apex](/docs/llms-apex.txt)\n')), true);
  assert.equal(moved(was, read('- [Apex](/docs/llms-apex.txt)\n- [Obj](/docs/llms-platform-obj.txt)\n')), '+/docs/llms-platform-obj.txt -/docs/llms-lwc.txt');
  const none = read('# Salesforce Developers\n');
  assert.deepEqual([none.indexes, unfit(none, u)], [[], true]); // an index list gone empty is never a baseline
  // A nested or other-host index counts too, each under its own name.
  assert.deepEqual(read('[a](/docs/platform/lwc/llms-lwc.txt) [b](https://architect.salesforce.com/llms-arch.txt)').indexes,
    ['/docs/platform/lwc/llms-lwc.txt', 'https://architect.salesforce.com/llms-arch.txt']);
  // Only developer llms.txt lists indexes; a missing saved copy is a local failure, not 54 removed indexes.
  assert.equal(parse(['https://architect.salesforce.com/llms.txt'], '200 900 /llms.txt -> architect.salesforce.com/llms.txt', out)['https://architect.salesforce.com/llms.txt'].indexes, undefined);
  const gone = parse([u], '200 16755 /docs/llms.txt -> developer.salesforce.com/docs/gone.txt', out)[u];
  assert.deepEqual([gone.indexes, drifted(was, gone), unfit(gone, u), moved(was, gone)], [null, true, true, '']); // drift, never 54 removals
  assert.deepEqual(read('[a](http://developer.salesforce.com/docs/llms-apex.txt) [b](/docs/llms-lwc.txt)').indexes, was.indexes); // one index, any scheme
});

test('every llms index the agent prompt names by path is in the site check', async () => {
  const { readFileSync } = await import('node:fs');
  const prompt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../agents/sf-docs.md'), 'utf8');
  const named = [...new Set(prompt.match(/(?:developer|architect)\.salesforce\.com\/[\w./-]*llms[\w-]*\.txt/g))];
  assert.ok(named.length >= 8, `only ${named.length} index paths found in the prompt`); // the regex still matches
  assert.deepEqual(named.filter(p => !URLS.includes(`https://${p}`)), []);
});

test('the Help sitemap index must keep listing the child sitemap the check fetches', () => {
  const out = tempDir('site-check-test-'), u = HELP_INDEX, raw = new URL(u).pathname + new URL(u).search;
  const file = 'help.salesforce.com/apex/Help_SiteMapIndexExternal_producttype_ai.txt';
  mkdirSync(join(out, 'help.salesforce.com/apex'), { recursive: true });
  const as = f => { const x = new URL(HELP_CHILD); f(x); return x.href; }, enc = (s, e = '&#38;') => s.replaceAll('&', e);
  const loc = n => `<loc>${enc(as(x => x.searchParams.set('page', n)))}\n    </loc>`, child = `<loc>${enc(HELP_CHILD)}\n    </loc>`;
  const read = text => { writeFileSync(join(out, file), text);
    return parse([u], `200 3137 ${raw} -> ${file}`, out)[u]; };
  const was = read(`${child}\n${loc(2)}\n`);
  assert.equal(was.lists, true);
  // Read as fetch-docs reads a <loc>: either entity, whitespace inside the tag; the scheme and query order do not count.
  assert.equal(read(`<loc>\n  ${enc(HELP_CHILD, '&amp;')}</loc>`).lists, true);
  const swapped = as(x => { x.protocol = 'http:'; x.search = new URLSearchParams([...x.searchParams].reverse()).toString(); });
  assert.equal(read(`<loc>${enc(swapped)}</loc>`).lists, true);
  assert.equal(read(`${loc(10)}\n`).lists, false); // another page (a near miss) is not the child
  assert.equal(read(`<loc>bulk</loc>\n${loc(2)}`).lists, false); // a junk <loc> is not the child, and no crash
  assert.equal(drifted(was, read(`${child}\n${loc(2)}\n${loc(3)}\n`)), false); // a new page is growth, not drift
  const renamed = read(`<loc>${enc(as(x => { x.pathname += 'V2'; }))}</loc>\n`.repeat(2));
  assert.deepEqual([renamed.lists, drifted(was, renamed), unfit(renamed, u)], [false, true, true]);
  const outage = read('<html>Help is down for maintenance</html>'); // no <loc> at all: an outage, not a rename
  assert.deepEqual([outage.lists, drifted(was, outage), unfit(outage, u)], [null, true, true]);
  const gone = parse([u], `200 3137 ${raw} -> help.salesforce.com/gone.txt`, out)[u];
  assert.deepEqual([gone.lists, drifted(was, gone), unfit(gone, u)], [null, true, true]);
});
