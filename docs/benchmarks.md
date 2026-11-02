# Benchmarks

[Back to the README](../README.md)

These numbers were measured from 2026-10-30 to 2026-10-31, when the agent followed at most one link from a page. The
two-link rule was checked against that agent on 20 questions with no change in right answers or median tokens; the
tables below were not rerun.

## 84% less in your context, 38% fewer tokens than platform-docs-get

On 10 questions against Salesforce's own platform-docs-get skill, the agent
added 84% fewer tokens to your context and used 38% fewer tokens over the whole session, with the right answer on
39 of 40 runs for each. In the second of four rounds, platform-docs-get missed question 5 and sf-docs-agent missed
question 4.

Below are the medians of those four rounds, each read as platform-docs-get → sf-docs-agent.

| Question | Site | Tokens added to context | Saved | Session token usage | Saved |
|---|---|---|---|---|---|
| 1. Scratch org editions | developer | 2,178 → **289** | **86.7%** | 186,768 → **119,355** | **36.1%** |
| 2. Platform event allocation | developer | 4,107 → **490** | **88.1%** | 245,482 → **120,396** | **51.0%** |
| 3. QueryLocator batch limits | developer | 2,568 → **581** | **77.4%** | 217,691 → **113,611** | **47.8%** |
| 4. Integration patterns | architect | 1,104 → **484** | **56.2%** | 127,043 → **125,540** | **1.2%** |
| 5. Salesforce Connect editions | help | 1,948 → **322** | **83.5%** | 201,770 → **157,746** | **21.8%** |
| 6. Flow version limits | help | 4,578 → **290** | **93.7%** | 217,138 → **164,888** | **24.1%** |
| 7. Headless 360 | admin | 3,772 → **380** | **89.9%** | 250,200 → **105,388** | **57.9%** |
| 8. SLDS tooltips | lightningdesignsystem | 3,876 → **414** | **89.3%** | 201,906 → **112,252** | **44.4%** |
| 9. Bulk API batch size | developer | 2,134 → **411** | **80.7%** | 255,340 → **125,870** | **50.7%** |
| 10. Pub/Sub fetch limit | developer | 1,199 → **716** | **40.3%** | 141,826 → **130,110** | **8.3%** |
| **All** | | 27,464 → **4,377** | **84.1%** | 2,045,164 → **1,275,156** | **37.7%** |

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

## Compared with Salesforce Docs MCP

Aside from the platform-docs-get skill, Salesforce also has
[salesforce-docs-mcp](https://labs.agentforce.com/docs/salesforce-docs-mcp), a closed-source public MCP server that
searches an index of Help articles, developer guides and release notes. I ran the same 10 questions through it in two
setups:

a. MCP in main session: the main agent calls the MCP tools directly

b. MCP in a subagent: a subagent whose only tools are the MCP's, with the same report format as sf-docs-agent

Three rounds each, medians, same model.

| | sf-docs-agent | a. MCP in main session | b. MCP in a subagent |
|---|---|---|---|
| Tokens added to context | **4,470** | 45,636 | 5,327 |
| Session token usage | 1,291,504 | 1,052,673 | **937,229** |
| Seconds, all 10 | 433 | 239 | **218** |
| Right answers, of 30 | **30** | 28 | 24 |
| Quotes that match the text the tools returned, all runs | **113 of 113** | 173 of 188 | 172 of 177 |
| Quotes on today's page, checked with sf-docs-agent's fetcher, all runs | **113 of 113** | 159 of 188 | 135 of 177 |

The MCP in a subagent is faster and uses 27% fewer session tokens than sf-docs-agent, and a. MCP in main session uses
18% fewer. Its results come back as markdown excerpts, so I suspect Salesforce keeps a `.md` snapshot of the docs taken
at some point. Because the index is closed, you can't see what it holds or when it was taken, and that has some costs:

- **Coverage.** Across 91 searches it returned no admin.salesforce.com page and no SLDS 2 content page. The
  subagent answered "not found" or wrong on Headless 360 and SLDS tooltips in all three rounds, and those two
  questions hold all 8 wrong MCP answers. In the main session, the model also reached for web search or fetch on 27
  of 30 runs and skipped the MCP on 4; its Headless 360 answers came from admin.salesforce.com through web fetch, not
  the index.
- **Freshness.** Results carry no date, and some come from the old atlas copy of a page. On question 2 the quotes were
  exact, but the source URL now opens a page without them. On question 1 the wording is older than today's page, with
  the same values. On both questions the values matched the answer key in every MCP run.
- **Open vs closed.** The index has no published source or refresh schedule. sf-docs-agent reads the live page every time,
  and every quote can be checked with one `grep`.

Most of the speed gap is page rendering. Of sf-docs-agent's 30 runs, the 18 that read at least one `.md` page took a
median 26.5 seconds, against 20.5 for the MCP subagent on the same questions and rounds. Help, admin and the
Apex Developer Guide had no `.md` copy, so sf-docs-agent rendered them in a headless browser, and the 12 runs that
rendered every page took a median 68.5 seconds, against 20 for the MCP subagent. The Apex Developer Guide and Apex
Reference had `.md` copies by 2026-10-31, after these runs; Help, admin, Metadata API and Object Reference still have
none.

<details>
<summary>Per question, sf-docs-agent / a. MCP in main session / b. MCP in a subagent</summary>

| Question | Tokens added to context | Seconds | Right answers, of 3 |
|---|---|---|---|
| 1. Scratch org editions | 248 / 5,011 / 421 | 23 / 22 / 18 | 3 / 3 / 3 |
| 2. Platform event allocation | 526 / 6,177 / 713 | 29 / 28 / 21 | 3 / 3 / 3 |
| 3. QueryLocator batch limits | 728 / 8,304 / 531 | 68 / 18 / 20 | 3 / 3 / 3 |
| 4. Integration patterns | 463 / 4,863 / 788 | 25 / 21 / 22 | 3 / 3 / 3 |
| 5. Salesforce Connect editions | 300 / 3,556 / 381 | 84 / 17 / 18 | 3 / 3 / 3 |
| 6. Flow version limits | 307 / 2,817 / 291 | 59 / 20 / 19 | 3 / 3 / 3 |
| 7. Headless 360 | 374 / 4,232 / 772 | 60 / 31 / 31 | 3 / 3 / 0 |
| 8. SLDS tooltips | 403 / 1,231 / 617 | 32 / 40 / 33 | 3 / 1 / 0 |
| 9. Bulk API batch size | 489 / 6,284 / 529 | 27 / 22 / 20 | 3 / 3 / 3 |
| 10. Pub/Sub fetch limit | 632 / 3,161 / 284 | 26 / 20 / 16 | 3 / 3 / 3 |

</details>
