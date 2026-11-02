# Benchmarks

[Back to the README](../README.md)

The sf-docs-agent numbers below come from a rerun on 2026-11-02 with the agent that follows up to two links. The
platform-docs-get and Salesforce Docs MCP numbers are from their runs on 2026-10-30 and 2026-10-31, which were not
repeated, and the docs changed in between: the Apex guides gained `.md` copies on 2026-10-31.
[One link against two](#one-link-against-two) compares the agent before and after the change.

## 84% less in your context, 34% fewer tokens than platform-docs-get

On 10 questions against Salesforce's own platform-docs-get skill, the agent
added 84% fewer tokens to your context and used 34% fewer tokens over the whole session, with the right answer on
39 of 40 runs for each. In the second of four rounds, platform-docs-get missed question 5 and sf-docs-agent missed
question 4.

Below are the medians of those four rounds, each read as platform-docs-get → sf-docs-agent.

| Question | Site | Tokens added to context | Saved | Session token usage | Saved |
|---|---|---|---|---|---|
| 1. Scratch org editions | developer | 2,178 → **261** | **88.0%** | 186,768 → **108,986** | **41.6%** |
| 2. Platform event allocation | developer | 4,107 → **517** | **87.4%** | 245,482 → **126,394** | **48.5%** |
| 3. QueryLocator batch limits | developer | 2,567 → **439** | **82.9%** | 217,691 → **115,116** | **47.1%** |
| 4. Integration patterns | architect | 1,104 → **599** | **45.7%** | 127,043 → **126,123** | **0.7%** |
| 5. Salesforce Connect editions | help | 1,949 → **367** | **81.2%** | 201,770 → **199,655** | **1.0%** |
| 6. Flow version limits | help | 4,578 → **303** | **93.4%** | 217,138 → **165,364** | **23.8%** |
| 7. Headless 360 | admin | 3,772 → **369** | **90.2%** | 250,200 → **116,094** | **53.6%** |
| 8. SLDS tooltips | lightningdesignsystem | 3,875 → **413** | **89.3%** | 201,906 → **113,047** | **44.0%** |
| 9. Bulk API batch size | developer | 2,134 → **547** | **74.4%** | 255,340 → **141,404** | **44.6%** |
| 10. Pub/Sub fetch limit | developer | 1,199 → **619** | **48.4%** | 141,826 → **135,983** | **4.1%** |
| **All** | | 27,463 → **4,434** | **83.9%** | 2,045,164 → **1,348,166** | **34.1%** |

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
| Tokens added to context | **4,508** | 45,636 | 5,327 |
| Session token usage | 1,323,755 | 1,052,673 | **937,229** |
| Seconds, all 10 | 346 | 239 | **218** |
| Right answers, of 30 | **29** | 28 | 24 |
| Quotes that match the text the tools returned, all runs | **117 of 117** | 173 of 188 | 172 of 177 |
| Quotes on today's page, checked with sf-docs-agent's fetcher, all runs | **117 of 117** | 159 of 188 | 135 of 177 |

The MCP in a subagent is faster and uses 29% fewer session tokens than sf-docs-agent, and a. MCP in main session uses
20% fewer. sf-docs-agent's one wrong answer is question 4 in its second round, a list reported a row short (a known
limitation). The quote audit counted one more quoted string for sf-docs-agent, "Salesforce Flow Limits by Edition",
which is the title of a page the agent named in its Gaps as not read, not a quote. Its results come back as markdown excerpts, so I suspect Salesforce keeps a `.md` snapshot of the docs taken
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

In the 2026-10-31 runs, most of the speed gap was page rendering. Of sf-docs-agent's 30 runs then, the 18 that read at least one `.md` page took a
median 26.5 seconds, against 20.5 for the MCP subagent on the same questions and rounds. Help, admin and the
Apex Developer Guide had no `.md` copy, so sf-docs-agent rendered them in a headless browser, and the 12 runs that
rendered every page took a median 68.5 seconds, against 20 for the MCP subagent. The Apex Developer Guide and Apex
Reference had `.md` copies by 2026-10-31, and in the 2026-11-02 rerun sf-docs-agent's total for all 10 fell from 433
to 346 seconds. Help, admin, Metadata API and Object Reference still have none.

<details>
<summary>Per question, sf-docs-agent / a. MCP in main session / b. MCP in a subagent</summary>

| Question | Tokens added to context | Seconds | Right answers, of 3 |
|---|---|---|---|
| 1. Scratch org editions | 284 / 5,011 / 421 | 20 / 22 / 18 | 3 / 3 / 3 |
| 2. Platform event allocation | 516 / 6,177 / 713 | 25 / 28 / 21 | 3 / 3 / 3 |
| 3. QueryLocator batch limits | 451 / 8,304 / 531 | 45 / 18 / 20 | 3 / 3 / 3 |
| 4. Integration patterns | 700 / 4,863 / 788 | 25 / 21 / 22 | 2 / 3 / 3 |
| 5. Salesforce Connect editions | 362 / 3,556 / 381 | 79 / 17 / 18 | 3 / 3 / 3 |
| 6. Flow version limits | 318 / 2,817 / 291 | 42 / 20 / 19 | 3 / 3 / 3 |
| 7. Headless 360 | 368 / 4,232 / 772 | 26 / 31 / 31 | 3 / 3 / 0 |
| 8. SLDS tooltips | 390 / 1,231 / 617 | 28 / 40 / 33 | 3 / 1 / 0 |
| 9. Bulk API batch size | 496 / 6,284 / 529 | 27 / 22 / 20 | 3 / 3 / 3 |
| 10. Pub/Sub fetch limit | 623 / 3,161 / 284 | 29 / 20 / 16 | 3 / 3 / 3 |

</details>

## One link against two

On 2026-11-02 the agent that follows at most one link from the page it found (0.1.2) ran against the agent that
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
