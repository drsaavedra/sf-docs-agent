# Benchmarks

[Back to the README](../README.md)

The sf-docs-agent numbers below come from a rerun on 4 November 2026. That agent reads a Help or admin sitemap index
in one call, and it asks the caller to wait for its report. The platform-docs-get and Salesforce Docs MCP numbers are
from their runs on 30 and 31 October 2026, which were not repeated, and the docs changed in between: the Apex guides
gained `.md` copies on 31 October 2026. [What changed on 4 November](#what-changed-on-4-november) gives the
2 November numbers and the cause of each change. [One link against two](#one-link-against-two) compares the agent
before and after it started to follow two links.

## 83% less in your context, 41% fewer tokens than platform-docs-get

On 10 questions against Salesforce's own platform-docs-get skill, the agent
added 83% fewer tokens to your context and used 41% fewer tokens over the whole session. sf-docs-agent had the right
answer on 40 of 40 runs and platform-docs-get on 39 of 40: it missed question 5 in the second of four rounds.

Below are the medians of those four rounds, each read as platform-docs-get → sf-docs-agent.

| Question | Site | Tokens added to context | Saved | Session token usage | Saved |
|---|---|---|---|---|---|
| 1. Scratch org editions | developer | 2,178 → **239** | **89.0%** | 186,768 → **113,706** | **39.1%** |
| 2. Platform event allocation | developer | 4,107 → **519** | **87.4%** | 245,482 → **120,394** | **51.0%** |
| 3. QueryLocator batch limits | developer | 2,567 → **558** | **78.3%** | 217,691 → **111,018** | **49.0%** |
| 4. Integration patterns | architect | 1,104 → **752** | **31.9%** | 127,043 → **103,650** | **18.4%** |
| 5. Salesforce Connect editions | help | 1,949 → **282** | **85.5%** | 201,770 → **139,668** | **30.8%** |
| 6. Flow version limits | help | 4,578 → **338** | **92.6%** | 217,138 → **130,048** | **40.1%** |
| 7. Headless 360 | admin | 3,772 → **380** | **89.9%** | 250,200 → **121,508** | **51.4%** |
| 8. SLDS tooltips | lightningdesignsystem | 3,875 → **445** | **88.5%** | 201,906 → **118,348** | **41.4%** |
| 9. Bulk API batch size | developer | 2,134 → **472** | **77.9%** | 255,340 → **142,031** | **44.4%** |
| 10. Pub/Sub fetch limit | developer | 1,199 → **655** | **45.4%** | 141,826 → **107,168** | **24.4%** |
| **All** | | 27,463 → **4,640** | **83.1%** | 2,045,164 → **1,207,539** | **41.0%** |

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
| Tokens added to context | **4,560** | 45,636 | 5,327 |
| Session token usage | 1,202,023 | 1,052,673 | **937,229** |
| Seconds, all 10 | 510 | 239 | **218** |
| Right answers, of 30 | **30** | 28 | 24 |
| Quotes that match the text the tools returned, all runs | **135 of 136** | 173 of 188 | 172 of 177 |
| Quotes on today's page, checked with sf-docs-agent's fetcher, all runs | **135 of 136** | 159 of 188 | 135 of 177 |

The MCP in a subagent is faster and uses 22% fewer session tokens than sf-docs-agent, and a. MCP in main session uses
12% fewer. sf-docs-agent's one quote that is not on the page is on question 2: the script printed an 887-character
table row correctly, and the agent dropped one folder from a link in that row when it wrote its report. The agent's hook now sends a quote like that back to the agent ([how it works](how-it-works.md)). The MCP's results come back as markdown excerpts, so I suspect Salesforce keeps a `.md` snapshot of the docs taken
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

In the 31 October 2026 runs, most of the speed gap was page rendering. Of sf-docs-agent's 30 runs then, the 18 that read at least one `.md` page took a
median 26.5 seconds, against 20.5 for the MCP subagent on the same questions and rounds. Help, admin and the
Apex Developer Guide had no `.md` copy, so sf-docs-agent rendered them in a headless browser, and the 12 runs that
rendered every page took a median 68.5 seconds, against 20 for the MCP subagent. The Apex Developer Guide and Apex
Reference had `.md` copies by 31 October 2026, and in the 2 November 2026 rerun sf-docs-agent's total for all 10 fell from 433
to 346 seconds. In the 4 November 2026 rerun it rose to 510 seconds, and the cause is not known. Help, admin,
Metadata API and Object Reference still have none.

<details>
<summary>Per question, sf-docs-agent / a. MCP in main session / b. MCP in a subagent</summary>

| Question | Tokens added to context | Seconds | Right answers, of 3 |
|---|---|---|---|
| 1. Scratch org editions | 242 / 5,011 / 421 | 29 / 22 / 18 | 3 / 3 / 3 |
| 2. Platform event allocation | 514 / 6,177 / 713 | 37 / 28 / 21 | 3 / 3 / 3 |
| 3. QueryLocator batch limits | 482 / 8,304 / 531 | 51 / 18 / 20 | 3 / 3 / 3 |
| 4. Integration patterns | 740 / 4,863 / 788 | 40 / 21 / 22 | 3 / 3 / 3 |
| 5. Salesforce Connect editions | 306 / 3,556 / 381 | 106 / 17 / 18 | 3 / 3 / 3 |
| 6. Flow version limits | 315 / 2,817 / 291 | 46 / 20 / 19 | 3 / 3 / 3 |
| 7. Headless 360 | 384 / 4,232 / 772 | 62 / 31 / 31 | 3 / 3 / 0 |
| 8. SLDS tooltips | 446 / 1,231 / 617 | 44 / 40 / 33 | 3 / 1 / 0 |
| 9. Bulk API batch size | 479 / 6,284 / 529 | 53 / 22 / 20 | 3 / 3 / 3 |
| 10. Pub/Sub fetch limit | 652 / 3,161 / 284 | 42 / 20 / 16 | 3 / 3 / 3 |

</details>

## What changed on 4 November

On 2 November 2026 sf-docs-agent used 34% fewer session tokens than platform-docs-get, and only 0.7%, 1.0% and 4.1%
fewer on questions 4, 5 and 10. The transcripts of those runs gave three causes:

- **The caller spent one turn to wait.** The caller started the agent in the background, and then used one turn
  only to say that the agent was still running. That turn cost about 22,000 tokens on all 40 runs. The agent's
  description now tells the caller to start it with `run_in_background: false`. In 9 test runs, no caller used
  that turn.
- **Help sitemaps took many calls.** With no article id, the agent read the Help sitemap index, and then typed the
  46 sitemap URLs that the index lists into more calls, 20 URLs at a time. Now, `--terms` on a sitemap index reads
  all of its sitemaps in the same call and shows only the matches. On question 5 the session fell from 284,673 tokens
  to 137,273 in 3 runs each.
- **A list was not shown whole.** On question 4 the agent opened the whole page to see the full patterns table.
  0.1.4 shows a list or table whole when a term matches in it, and that step is gone.

Some cost stays because the agent is a second session:

- **Each question has a fixed cost.** The caller uses about 46,000 tokens to start the agent and to give the
  answer, and the agent uses about 42,000 or more. When platform-docs-get finds the page with one search and one
  fetch, as on question 4, the saving on session tokens is small. The saving on context does not change.
- **A quote check costs one more turn.** The caller can check a quote with `grep` on the cached page. On some runs
  it does, and that turn costs about 22,000 tokens.

## One link against two

On 2 November 2026 the agent that follows at most one link from the page it found (0.1.2) ran against the agent that
follows up to two, on the same fetcher, in a clean Claude Code config with a Sonnet caller, a cold cache before each
round, and the same grader as above. Two question sets came from the project's 100-question set: 20 regression
questions (every fifth), one round, and 6 link-following questions (five that start from one page and need another,
and one Help question whose answer sits on a linked article), three rounds.

| | One link | Two links |
|---|---|---|
| Right answers, 20 regression questions | 20 of 20 | 20 of 20 |
| Right answers, 6 link-following questions × 3 rounds | 12 of 18 | 13 of 18 |
| Agent tokens, regression median (most) | 14,419 (22,473) | 13,928 (17,435) |
| Tool calls, regression median (most) | 4 (14) | 4 (7) |
| Seconds, regression median (slowest) | 26 (117) | 26 (69) |
| Pages fetched in one run, most | 8 | 3 |
| Quotes found on the cached page, all runs | 120 of 120 | 113 of 113 |

Nothing got worse. The one extra right answer is a single run, within the noise between rounds, so two links are not
shown to answer more questions. The question that still fails most often needs a link from a developer page to a Help
article that the agent does not follow at all, which the link limit does not decide.
