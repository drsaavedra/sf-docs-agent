# How it works

[Back to the README](../README.md)

## Why an agent, not a skill

A skill pulls every page it reads into your main session. The agent reads them in its own context and returns only
the lines you asked for.

Salesforce's own [sf-skills](https://github.com/forcedotcom/sf-skills) library already has a skill for the same job,
[`platform-docs-get`](https://github.com/forcedotcom/sf-skills/tree/main/skills/platform-docs-get). In its own words,
it is an "official Salesforce documentation retrieval skill" for the same five sites, "especially when pages are
JS-heavy, shell-rendered, or hard to extract with naive fetching."

Here is how the two compare:

| | platform-docs-get | sf-docs-agent |
|---|---|---|
| Runtime | Python, `playwright`, `playwright-stealth` | Node, `playwright-core` |
| Bot checks | spoofs a desktop user agent, optional stealth | neither |
| developer, architect and LDS pages | renders and scrapes the HTML | reads the `.md` copy where one exists |
| Finding pages | you give the URL | `llms.txt` indexes, sitemaps and link lists |
| What lands in your context | every page | a report of quotes |
| Checking an answer | re-read the page | `grep` one line |

The trade-off: your main session trusts the subagent. That is why the model only picks line numbers and the script
copies the lines. Every quote is copied word for word from the page, not written from the model's memory, and you can
check it with one `grep` against the cached copy, which saves curly quotes as straight ones and drops image links and
the padding in table rows.

## How sf-docs-agent reads each site

The agent reads the `.md` copy of a page where the site publishes one. Not every Salesforce docs site does yet.

Give the script an `.html` or bare URL for a new developer docs, architect or LDS page and it fetches the `.md` copy
instead. The same goes for an atlas URL that now redirects to the new docs.

The agent finds pages through the site's `llms.txt` index or its sitemaps.

| Site | How | Where it finds pages |
|---|---|---|
| developer.salesforce.com, new docs | the `.md` copy Salesforce publishes | `/docs/llms.txt` and one index per product |
| developer.salesforce.com, Apex Developer Guide and Apex Reference | the `.md` copy (atlas URLs redirect to the new docs, by 31 October 2026) | `/docs/llms-product-docs.txt` |
| developer.salesforce.com, atlas docs (Metadata API, Object Reference) | renders the page, code samples included | `/docs/llms-product-docs.txt` |
| developer.salesforce.com, API reference pages (`?meta=<operation>`) | renders the page | the product's index |
| architect.salesforce.com | the `.md` copy | `/llms.txt` |
| help.salesforce.com, articles and knowledge articles | renders the page | links in other docs and articles, and Help's product sitemaps |
| admin.salesforce.com | renders the page | `/sitemap_index.xml` and its post sitemaps |
| lightningdesignsystem.com (SLDS 2) | the `.md` copy | the home page's link list |
| v1.lightningdesignsystem.com (SLDS 1) | renders the page | the home page's link list |

## Limitations

- On help, admin, SLDS 1, API reference pages and the atlas guides that still render (Metadata API, Object Reference and
  more), the agent finds the article text by where it sits on the page. If Salesforce changes a layout, it reads the
  largest block of text instead, which can be one section of the article, and an article under 1,500 characters can't
  be read. A daily check in this repo flags the change.
- A rendered page can take up to 80 seconds before the agent gives up on it (45 s to load, 20 s for content, 15 s for the
  `.md` copy of a page it redirected to).
- No Help search. Help's `robots.txt` disallows it. Help's sitemaps list article ids but not titles.
- It reads the current docs, which don't always name their release.
- From a page it found, it follows at most two more links in a row, and only toward a missing part of the answer. An
  answer that sits further away comes back as a gap.
- When a `--terms` match lands in a list or table, the script prints the whole block: markdown tables and lists,
  rendered table rows, and tables flattened to one paragraph a cell. It prints one block a page, the one whose matches
  hold the rarest terms. Up to 60 lines and 6,000 characters it prints the block; up to 200 lines it names the
  block's line range; past that it prints only the matching lines. A list on a rendered page has no markers, so the script cannot see
  it, and there the agent can still stop a row early. On the five-of-six integration patterns case, all six came back
  in 27 of 27 runs (2026-11-03, three builds).
- If a site starts blocking headless browsers, the agent stops and reports it. It does not try to get around the block.
- What leaves your machine: the pages the agent fetches from those sites (and each site's `robots.txt`, which raw
  fetches load first). No telemetry. Installing downloads `playwright-core` from npm and, if you agree, Chromium from
  Playwright's servers.
- A `PreToolUse` hook (`guard.mjs`, named in the agent file) limits the agent's Bash to the script and to `grep` on
  absolute paths in the install folder, with commands joined only by `&&`. The hook limits Read to the same
  folder. It stops all other commands, and it stops each command that it cannot parse. The hook runs only
  for this agent, not for your main session. It checks the text of each command before the command runs, so it is
  not an operating system sandbox. On the 20-question regression, the hook ran on each of 103 Bash and Read calls,
  stopped none of them, and the result stayed at 20 of 20 (2026-11-03).
