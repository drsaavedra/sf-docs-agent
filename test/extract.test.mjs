// The in-page extract in real headless Chromium, on fixture HTML: no network, since the stub answers every request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCRIPT, withStub } from './harness.mjs';

const REAL = pathToFileURL(join(dirname(SCRIPT), 'node_modules/playwright-core/index.mjs')).href;
// The real browser with every request answered from HTML, and waits that advance the clock, so the 20 s render wait costs nothing.
const STUB = `import { chromium as real } from ${JSON.stringify(REAL)};
const html = JSON.parse(process.env.HTML), now = Date.now;
let skew = 0;
Date.now = () => now() + skew;
export const chromium = { launch: async o => { const b = await real.launch(o); return { close: () => b.close(), newPage: async () => {
  const p = await b.newPage();
  await p.route('**/*', r => r.fulfill({ contentType: 'text/html', body: html[r.request().url()] ?? '<html></html>' }));
  p.waitForTimeout = async ms => { skew += ms; };
  return p;
} }; } };`;
const fetched = (url, html) => {
  const r = withStub(STUB, { HTML: JSON.stringify({ [url]: html }) }, null, url), file = r.out.match(/ -> (\S+)/)?.[1];
  return { ...r, file: file && join(r.cache, file), text: file ? readFileSync(join(r.cache, file), 'utf8') : '' };
};
const para = (n, word) => Array.from({ length: n }, () => `<p>${`${word} `.repeat(20)}</p>`).join('');
const BLOG = 'https://admin.salesforce.com/blog/2025/a-post';

test('a Help page links itself with &language= added: that link is left out, another article stays', () => {
  const url = 'https://help.salesforce.com/s/articleView?id=sf.x.htm&type=5';
  const r = fetched(url, `<title>X</title><div class="slds-text-longform">${para(3, 'article')}
    <a href="/s/articleView?id=sf.x.htm&type=5&language=en_US">This page</a><a href="/s/articleView?id=sf.y.htm&type=5">Other</a></div>`);
  assert.ok(r.file, r.out + r.err);
  const links = readFileSync(`${r.file}.links.txt`, 'utf8');
  assert.match(links, /id=sf\.y\.htm/, r.out + r.err);
  assert.doesNotMatch(links, /id=sf\.x\.htm/);
});

test('with no known container the fallback takes the block with the most text, outside nav', () => {
  const r = fetched(BLOG, `<title>Post</title><script>
    customElements.define('site-menu', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(para(30, 'menuitem'))}; } });
    </script><nav>${para(30, 'navlink')}<site-menu></site-menu></nav><div hidden>${para(30, 'hiddenword')}</div><div>${para(2, 'sidebar')}</div><div>${para(13, 'prose')}</div>`);
  assert.match(r.out, /\[fallback\]/, r.out + r.err);
  assert.match(r.text, /prose/);
  assert.doesNotMatch(r.text, /navlink|menuitem|hiddenword|sidebar/);
  assert.equal(existsSync(`${r.file}.fallback`), true);
});

test('a block under the 1,500 character floor is a shell, not a page', () => {
  const r = fetched(BLOG, `<title>Post</title><div>${para(12, 'prose')}</div>`);
  assert.match(r.out, /not saved: shell, login or missing page/, r.out + r.err);
});

test('text in a shadow root is read, in order, and a hidden element is not', () => {
  const r = fetched('https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/real.htm', `<title>T</title><script>
    customElements.define('doc-content', class extends HTMLElement { connectedCallback() {
      this.attachShadow({ mode: 'open' }).innerHTML = '<p>First shadow line</p><p style="display:none">Hidden line</p><pre>  indented code</pre>'; } });
    </script><doc-content></doc-content>`);
  assert.match(r.out, /\[doc-content\]/, r.out + r.err);
  assert.match(r.text, /First shadow line[\s\S]*  indented code/);
  assert.doesNotMatch(r.text, /Hidden line/);
});
