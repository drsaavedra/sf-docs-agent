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
copies the lines. Every quote comes word for word from the page, not from the model's memory. The model then writes
the script's lines into its report, and in one of 136 quotes on 4 November 2026 it dropped one folder from a link in
a long table row. The hook now checks each quote in the report against the cached page before the agent hands the
report back, and it sends a quote that differs back to the agent with the line as it is on the page. You can also
check each quote with one `grep` against the cached copy, which saves curly quotes as straight ones and drops image
links and the padding in table rows.

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
- `--terms` and `--search` match `_` or `-` between letters or digits as a space, so `delete_components` finds "delete
  components". A term like `__c` matches as written, and the line prints as the page has it. On 100 questions this cut searches that found nothing from 34 and 35 to 30 (5 November
  2026); right answers stayed within the run-to-run spread.
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
- A `PreToolUse` hook (`guard.mjs`, named in the agent file) limits Read to the install folder. It limits Bash to the
  script and to `grep` on absolute paths in that folder. grep can use only short options, a command can have no
  unquoted wildcards or `#`, and commands can join only with `&&`. The only redirect it allows is `2>&1`. The hook
  stops all other commands, and each command that it cannot parse. It runs only for this agent and checks the command
  text before the command runs, so it is not an operating system sandbox.
- On the 20-question regression, the hook ran on 103 Bash and Read calls and stopped 3: a pipe, a `;` and a redirect.
  The agent changed those 3 calls, and the result stayed at 20 of 20. The guard at commit `8e12e06` stops the same 3
  calls when the 103 calls are replayed through it (2026-11-03).
- The same hook checks the agent's report before the agent hands it back. Each Evidence line must be the cited line
  of the cached page, and each Sources URL the page's own URL, so a quote or URL that the model typed wrong goes back to
  the agent with the text as it is on the page. Outside those two blocks, a `[n:line]` reference must name a line in
  Evidence, and a quote right before it must be on that line; a `[n]` source or a cache path there is sent back.
  Other text, quoted or not, is prose, and the hook cannot check it. Over 398 saved reports, these rules send back 8,
  each a report that changed the `--quote` output.
  On the 10 benchmark questions, 3 rounds, the hook sent no quote back in 30 runs and all 30 answers were right. The
  report with the wrong quote from 4 November is sent back when it is replayed through the hook (2026-11-04).
- The hook reads the cached page when the agent hands its report back. If another session fetches the same page
  again in that time and the page changed, a correct quote can be sent back. The check runs only when Claude Code
  gives the agent its hand-back tool (`SubagentHandback`); without that tool, the report comes back unchecked.
- For a `--project` install, Claude Code runs the hook only in a folder that you trust. In a folder that you did
  not trust, for example under `claude -p`, the agent runs without the hook (measured 2026-11-03). A user install,
  the default, runs the hook in every folder.
