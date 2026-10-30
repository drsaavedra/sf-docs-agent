// The site check's drift rule, offline: importing the module fetches nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drifted, parse, unfit } from '../site-check/site-check.mjs';

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
