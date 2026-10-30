# sf-docs-agent

[![npm](https://img.shields.io/npm/v/sf-docs-agent)](https://www.npmjs.com/package/sf-docs-agent)

A Claude Code subagent that answers Salesforce questions from the official docs and hands back quotes, not pages.

It reads developer.salesforce.com, architect.salesforce.com, help.salesforce.com, admin.salesforce.com and
lightningdesignsystem.com. The model picks the lines and a script copies them from the cached page,
each with the official URL it came from, so you can check any quote with one grep.

I built this because every docs lookup was dumping whole pages into my session. I only wanted the lines that answer my question.

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
check it with one `grep`.

## 84% less in your context, 63% fewer tokens overall

On 10 questions against Salesforce's own platform-docs-get skill, the agent
added 84% fewer tokens to your context and used 63% fewer tokens over the whole session, with the right answer on
10 of 10.

Below are the measurements, each read as platform-docs-get → sf-docs.

| Question | Site | Tokens added to context | Saved | Session token usage | Saved |
|---|---|---|---|---|---|
| 1. Scratch org editions | developer | 2,178 → **289** | **86.7%** | 338,852 → **119,355** | **64.8%** |
| 2. Platform event allocation | developer | 4,107 → **490** | **88.1%** | 387,598 → **120,396** | **68.9%** |
| 3. QueryLocator batch limits | developer | 2,568 → **581** | **77.4%** | 406,878 → **113,611** | **72.1%** |
| 4. Integration patterns | architect | 1,104 → **484** | **56.2%** | 154,068 → **125,540** | **18.5%** |
| 5. Salesforce Connect editions | help | 1,948 → **322** | **83.5%** | 382,751 → **157,746** | **58.8%** |
| 6. Flow version limits | help | 4,578 → **290** | **93.7%** | 339,464 → **164,888** | **51.4%** |
| 7. Headless 360 | admin | 3,772 → **380** | **89.9%** | 427,542 → **117,258** | **72.6%** |
| 8. SLDS tooltips | lightningdesignsystem | 3,876 → **414** | **89.3%** | 340,914 → **112,252** | **67.1%** |
| 9. Bulk API batch size | developer | 2,134 → **411** | **80.7%** | 506,340 → **125,870** | **75.1%** |
| 10. Pub/Sub fetch limit | developer | 1,199 → **716** | **40.3%** | 236,766 → **130,110** | **45.0%** |
| **All** | | 28,379 → **4,556** | **83.9%** | 3,473,702 → **1,298,680** | **62.6%** |

<details>
<summary>The 10 questions</summary>

1. What are the valid values for edition in a scratch org definition file?
2. What is the hourly platform event publishing allocation for Enterprise Edition and for Developer Edition?
3. With a QueryLocator start method, what is the maximum batch scope, and how many records can the QueryLocator return?
4. Which integration patterns does the architect Integration Patterns guide list?
5. Which editions include the Salesforce Connect cross-org adapter?
6. How many versions can a flow have, and how many active flows per flow type in Enterprise vs Professional?
7. What three technologies is Salesforce Headless 360 built on, and does it replace the Lightning UI?
8. Should you put an SLDS tooltip on a non-interactive element?
9. How many records fit in one Bulk API batch, and in one sObject Collections create request?
10. How many events can a Pub/Sub API client request across all FetchRequests in one Subscribe call?

</details>

## How sf-docs-agent reads each site

The agent reads the `.md` copy of a page where the site publishes one. Not every Salesforce docs site does yet.

Give the script an `.html` or bare URL for a new developer docs, architect or LDS page and it fetches the `.md` copy
instead. The same goes for an atlas URL that now redirects to the new docs.

The agent finds pages through the site's `llms.txt` index or its sitemaps.

| Site | How | Where it finds pages |
|---|---|---|
| developer.salesforce.com, new docs | the `.md` copy Salesforce publishes | `/docs/llms.txt` and one index per product |
| developer.salesforce.com, atlas docs (Apex, Apex Reference, Metadata API, Object Reference) | renders the page, code samples included | `/docs/llms-product-docs.txt` |
| developer.salesforce.com, API reference pages (`?meta=<operation>`) | renders the page | the product's index |
| architect.salesforce.com | the `.md` copy | `/llms.txt` |
| help.salesforce.com, articles and knowledge articles | renders the page | links in other docs and articles, and Help's product sitemaps |
| admin.salesforce.com | renders the page | `/sitemap_index.xml` and its post sitemaps |
| lightningdesignsystem.com (SLDS 2) | the `.md` copy | the home page's link list |
| v1.lightningdesignsystem.com (SLDS 1) | renders the page | the home page's link list |

## Use

Ask Claude to read the Salesforce docs in your own words. You can name the agent in the prompt, or just give it a
Salesforce docs link and ask. It picks up the intent either way.

```
Go scan the developer.salesforce.com docs on the current release's governors and limits
```

Name the site or product if you know it, and say what you want to know.

The sample prompt is broad on purpose: I wanted to see the agent decide what "governors and limits" covers, and whether it could find everything in a broad question.

Here are the results of that prompt, one run each on Opus 5.5 and Sonnet 5.5 at effort high. Each session called the sf-docs agent, which returned quotes with their
official URLs, and the session turned them into the answer.

<details>
<summary><b>Sonnet 5.5, effort high, through the agent</b>: 86 seconds, 34k agent tokens</summary>
<br>

> The `sf-docs` agent finished scanning the Apex governors and limits pages. All limit values below are quoted from the cached concept page, `apex_gov_limits.htm`. The release version is an inference, not a stated fact.
>
> ## Which release
> - The cached pages are the unversioned "current" docs, and they don't name a release.
> - The version dropdown lists **Summer '26 (API 67.0, path `262.0`)** as the newest versioned link.
> - The page's own sidebar links point to `264.0` paths. That is most likely **Winter '27 (API 68.0)**.
> - The agent did not fetch the 262 or 264 versioned pages to confirm.
>
> ## Per-transaction Apex limits
> Limits are listed as synchronous / asynchronous.
>
> | Limit | Sync | Async |
> |---|---|---|
> | SOQL queries | 100 | 200 |
> | SOQL rows retrieved | 50,000 | 50,000 |
> | DML statements | 150 | 150 |
> | DML rows | 10,000 | 10,000 |
> | Callouts | 100 | 100 |
> | `@future` methods per invocation | 50 | 0 in batch and future contexts, 50 in queueable |
> | `System.enqueueJob` | 50 | 1 |
> | Heap | 10 MB | 25 MB |
> | CPU time | 10,000 ms | 60,000 ms |
> | Execution time | 10 minutes | 10 minutes |
>
> - **Enforcement:** "the Apex runtime engine strictly enforces limits", and exceeding a limit raises a runtime exception "that can't be handled."
> - **Reset and scope:** For Batch Apex, limits reset for each `execute` call. Synchronous limits apply to scheduled Apex. Bulk API transactions get the higher of the sync and async limits.
> - **Heap:** Exceeding it gives an uncatchable `System.LimitException`. Email services get a 50 MB heap.
>
> ## Certified managed packages
> - Each certified namespace gets its own per-transaction limits.
> - The cumulative limit across namespaces is 11 times the per-namespace limit. That gives 1,100 SOQL queries and 1,650 DML statements.
> - Heap, CPU, execution time and the unique-namespace count are not counted separately per package.
>
> ## Platform, static and size limits
> - **Async executions per 24 hours:** 250,000, or licenses × 200, whichever is greater.
> - **Concurrent long-running transactions (over 5 seconds):** one per 100 licenses.
> - **Scheduled classes:** 100 (5 in Developer Edition).
> - **Batch jobs queued or active:** 5.
> - **Callout timeout:** 10 seconds by default.
> - **Callout request or response size:** 6 MB synchronous, 12 MB asynchronous.
> - **Apex code per org:** 6 MB.
> - **Method size:** 65,535 bytecode instructions.
> - **Single email:** 5,000 external addresses per day per org (GMT).
> - **Push notifications:** 20,000 iOS and 10,000 Android per hour.
> - **Governor limit email warnings:** The default threshold is 50% of allocated limits, and only per-request limits are checked.
>
> ## Gaps
> - **Not fetched:** The agent did not read the "Elastic Limits for Asynchronous Apex Jobs (Beta)" page or `apex_limits_tips.htm`.
> - **Not quoted:** Several rows on the same page weren't quoted:
>   - push notification calls per transaction
>   - Apex cursor limits
>   - inbound email limits
>   - the 450,000 `MAX_DML_ROWS` limit in tests
> - **"Lightweight limits":** This isn't a section name in the docs.
>
> ## Sources
> - https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm
> - https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits_emails.htm
>
> The pages are cached locally, so you can check any quote with `grep -c -F '<quote>' <cache path>`. The cache is under `~/.claude/sf-docs/cache/developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/`.
>
> I can have the agent fetch the 262 and 264 versioned pages to pin down the release, or cover the elastic limits page.

</details>

<details>
<summary><b>Opus 5.5, effort high, through the agent</b>: 89 seconds, 39k agent tokens</summary>
<br>

> I read the Apex Developer Guide page **Execution Governors and Limits**. I spot-checked several of the quotes against the cached copy of the page and they match.
>
> **Which release:** the page doesn't name its release. Its links point to the 264.0 doc set, and its list of older versions starts at Summer '26 (API 67.0). So this is most likely **Winter '27 (API 68.0)**, but that's my inference, not something the page says. The page also doesn't mark any limit as new or changed in this release.
>
> ### Per-transaction Apex limits (synchronous / asynchronous)
> | Limit | Sync | Async |
> |---|---|---|
> | SOQL queries | 100 | 200 |
> | SOQL rows retrieved | 50,000 | 50,000 |
> | `Database.getQueryLocator` rows | 10,000 | 10,000 |
> | SOSL queries / rows per query | 20 / 2,000 | 20 / 2,000 |
> | DML statements / rows | 150 / 10,000 | 150 / 10,000 |
> | Trigger recursion stack depth | 16 | 16 |
> | Callouts / cumulative callout timeout | 100 / 120 s | 100 / 120 s |
> | `@future` calls | 50 | 0 in batch and future; 50 in queueable |
> | `System.enqueueJob` | 50 | 1 |
> | `sendEmail` calls | 10 | 10 |
> | Heap | 10 MB | 25 MB |
> | CPU time | 10,000 ms | 60,000 ms |
> | Maximum execution time | 10 min | 10 min |
> | `EventBus.publish` calls (publish immediately) | 150 | 150 |
> | Apex cursor rows / `Cursor.fetch` calls | 50M / 100 | 50M / 100 |
> | Pagination cursors: rows / instances / rows per page | 100,000 / 50 / 2,000 | same |
>
> **Notes that change how these apply:**
> - **Scheduled Apex** runs under the synchronous limits.
> - **Bulk API** transactions get the higher of the sync and async values.
> - **Parent-child subqueries** each count as an extra query.
> - **Custom metadata queries** don't count toward the SOQL limit.
> - **Email services** get a 50 MB heap.
> - **CPU time** leaves out time spent waiting on the database and on callouts.
> - **Batch Apex** limits reset for each `execute` chunk.
>
> ### Org-wide Platform limits
> - **Async executions per 24 hours:** 250,000 or 200 × licenses, whichever is greater. Batch Apex checks up front that the whole job fits under this limit before it starts.
> - **Elastic async executions (beta)** can add up to 2 million more per day.
> - **Cursors per 24 hours:** 10,000 cursor instances, 100M cursor rows, and 200,000 pagination cursors.
> - **Long-running synchronous transactions (over 5 s):** 1 per 100 licenses, minimum 10 and maximum 50.
> - **Scheduled classes:** 100 (5 in Developer Edition).
> - **Batch Apex:**
>   - Flex queue jobs in Holding status: 100
>   - Jobs queued or active: 5
>   - Concurrent `start` methods: 1
> - **Test classes queued per 24 hours:** the greater of 500 or 10× your test classes in production (20× in sandbox and Developer Edition).
>
> ### Static and size limits
> - **Callouts:** 10 s default timeout; request or response up to 6 MB sync or 12 MB async, and this counts toward heap.
> - **SOQL run time:** 120 s.
> - **Deployments:** 7,500 code units each.
> - **Trigger batch size:** 200, or 2,000 for platform events and Change Data Capture.
> - **`QueryLocator`:** 50M records.
> - **Code size:**
>   - 1M characters per class or trigger.
>   - 6 MB of Apex per org (10 MB in scratch orgs). Support can raise it, and managed-package and `@isTest` code don't count.
>   - 65,535 bytecode instructions per method.
>
> ### Certified managed packages
> - Each certified namespace gets its own copy of the per-transaction limits.
> - The total across namespaces is capped at 11× the per-namespace limit: for example, 1,100 SOQL queries or 1,650 DML statements.
> - Heap, CPU time, execution time and the number of namespaces are shared across the whole transaction.
> - Code in non-certified packages counts against your org's own limits.
>
> ### Other limits on the page
> - **Single email:** 5,000 external addresses per day and 150 recipients per message.
> - **Push notifications:** 20,000 iOS and 10,000 Android per hour per org.
> - **Tests:** 450,000 DML rows per synchronous test run.
> - **ConnectApi:** each write costs one DML statement.
> - **Data.com Clean:** 200 SOQL queries and 10 future calls per batch.
>
> **Not covered:** I didn't read the Asynchronous Callout Limits page or the Winter '27 release notes. If you need to know what changed since Summer '26, the release notes are the next place to look.
>
> **Source:** https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm

</details>

## Install

Needs Node 22+ and Claude Code. The installer is on npm as
[`sf-docs-agent`](https://www.npmjs.com/package/sf-docs-agent).

```
npx sf-docs-agent            # for all your projects
npx sf-docs-agent --project  # for the project in the current folder only
```

The installer adds `playwright-core` (13 MB) and asks before it downloads headless Chromium (about 200 MB). Pass
`--yes` to skip the question in scripts. If you say no, it prints the command to run before first use. On Linux, also
run `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sf-docs/node_modules/playwright-core/cli.js" install-deps chromium` once
for the system libraries. It asks for your password itself.

Then start a new Claude Code session. The agent is listed as `sf-docs`.

**Update:** `npx sf-docs-agent@latest`. Without `@latest`, npx runs any copy already installed globally or in the
current project.

**Remove:** delete `~/.claude/agents/sf-docs.md` (or `.claude/agents/sf-docs.md` in the project). The script and cache
live in `~/.claude/sf-docs/` for every scope, so delete that folder last, once no project uses the agent. If
`CLAUDE_CONFIG_DIR` is set, the installer uses that instead of `~/.claude`.

**Cache:** pages stay cached for 24 hours, so a follow-up question does not fetch them again. To change that, set
`SF_DOCS_CACHE_HOURS` in your Claude Code `settings.json` (`0` fetches every time):

```json
{ "env": { "SF_DOCS_CACHE_HOURS": "72" } }
```

## Limitations

- On help, admin, SLDS 1, API reference pages and the atlas guides, the agent finds the article text by where it sits on
  the page. If Salesforce changes a layout, it reads the largest block of text instead, which can be one section of the
  article, and an article under 1,500 characters can't be read. A daily check in this repo flags the change.
- A rendered page can take up to 80 seconds before the agent gives up on it (45 s to load, 20 s for content, 15 s for the
  `.md` copy of a page it redirected to).
- No Help search. Help's `robots.txt` disallows it. Help's sitemaps list article ids but not titles.
- It reads the current docs, which don't always name their release.
- It follows at most one link from a page it read. An answer that sits further away comes back as a gap.
- On a long list or table, the agent now and then stops a row early, for example five of six integration patterns.
  Every quote it gives is still right; the missing row is the problem. The script can print a list to its end
  (`--section`), but the model does not always use it.
- If a site starts blocking headless browsers, the agent stops and reports it. It does not try to get around the block.
- What leaves your machine: the pages the agent fetches from those sites (and each site's `robots.txt`, which raw
  fetches load first). No telemetry. Installing downloads `playwright-core` from npm and, if you agree, Chromium from
  Playwright's servers.
- The agent has Bash. Its brief limits it to the script and the cache, but that is an instruction to the model, not a
  sandbox.

## Develop

```
git clone https://github.com/drsaavedra/sf-docs-agent && cd sf-docs-agent && npm install
mkdir -p "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents"
sed "s|/path/to/sf-docs-agent|$PWD|g" agents/sf-docs.md > "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents/sf-docs.md"
npm test
```

`agents/sf-docs.md` names its script and cache as `/path/to/sf-docs-agent`. The `sed` line writes your copy with your
clone's path; the installer does the same for everyone else. Run it again after you edit the agent.

## License

MIT
