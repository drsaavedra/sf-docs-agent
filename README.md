# sf-docs-agent

**Read the docs, keep your context.** A Claude Code agent that reads the official Salesforce docs for you and returns just the lines that answer, each with its official URL.

[![npm](https://img.shields.io/npm/v/sf-docs-agent)](https://www.npmjs.com/package/sf-docs-agent)

**The model picks the lines, a script copies them** word for word from the official page · **No third-party API**: pages come straight from Salesforce's sites to your machine · **83% fewer tokens** added to your session than Salesforce's own docs skill

[Install](#install) · [Use](#use) · [How it works](#how-it-works) · [How it compares](#how-it-compares) · [Limitations](#limitations) · [Benchmarks](https://github.com/drsaavedra/sf-docs-agent/blob/main/docs/benchmarks.md)

---

| Salesforce's platform-docs-get skill · 4,578 tokens | sf-docs-agent · 338 tokens |
|---|---|
| Every page it read lands in your session | Only the lines that answer, each with its official URL |

*"How many versions can a flow have, and how many active flows per flow type in Enterprise vs Professional?"* Same right answer. 4,578 tokens become 338.

The agent reads the pages in its own context. The model picks the lines and a script copies them word for word from the cached page, so no quote is written from the model's memory. Where Claude Code gives the agent its hand-back tool and runs its hook, the hook also checks each quote and source in the agent's report against the cached page before the report reaches you.

I built this because every docs lookup was dumping whole pages into my Claude Code session. I only wanted the lines that answer my question.

## Install

Needs Node 22+ and Claude Code.

```
npx sf-docs-agent
```

Then start a new Claude Code session. The agent is listed as `sf-docs`. Add `--project` to install it for the current project only. Claude Code then runs the agent's hook only in a folder you trust: in one you have not trusted, for example under `claude -p`, the agent runs without it.

<details>
<summary>Headless browser, Linux, update, remove, cache</summary>

- **Headless browser:** some sites have no `.md` copy of their pages, so the agent opens them in a headless browser. The installer asks before it downloads Chromium (about 200 MB). Pass `--yes` to skip the question.
- **Linux:** also run `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sf-docs/node_modules/playwright-core/cli.js" install-deps chromium` once.
- **Update:** `npx sf-docs-agent@latest`
- **Remove:** delete `~/.claude/agents/sf-docs.md` (or `.claude/agents/sf-docs.md` in the project), then `~/.claude/sf-docs/` once no project uses it. Chromium stays in Playwright's cache (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux); delete that too if nothing else uses Playwright.
- **Cache:** pages stay cached for 24 hours. Set `SF_DOCS_CACHE_HOURS` in your Claude Code `settings.json` to change it (`0` fetches every time).

</details>

## Use

Ask in your own words. Name the site or product if you know it, or paste a Salesforce docs link and ask about it.

```
Go scan the developer.salesforce.com docs on the current release's governors and limits
```

Part of what came back (Opus 5.5, 89 seconds):

> I read the Apex Developer Guide page **Execution Governors and Limits**. I spot-checked several of the quotes against the cached copy of the page and they match.
>
> | Limit | Sync | Async |
> |---|---|---|
> | SOQL queries | 100 | 200 |
> | DML statements / rows | 150 / 10,000 | 150 / 10,000 |
> | Heap | 10 MB | 25 MB |
> | CPU time | 10,000 ms | 60,000 ms |
>
> **Not covered:** I didn't read the Asynchronous Callout Limits page or the Winter '27 release notes.

It tells you what it did not read. A gap you can see beats a guess you can't.

It covers developer.salesforce.com, architect.salesforce.com, help.salesforce.com, admin.salesforce.com and lightningdesignsystem.com. Full outputs on Opus and Sonnet: [docs/examples.md](https://github.com/drsaavedra/sf-docs-agent/blob/main/docs/examples.md)

## How it works

1. **Finds the page.** It searches the site's `llms.txt` index or sitemaps, or starts from the link you give it.
2. **Reads the cleanest copy.** Where Salesforce publishes a `.md` copy of a page (the new developer docs, architect, SLDS 2), it reads that. Help, admin and some older guides have none, so it renders them in a headless browser. No fake user agent, no stealth plugin.
3. **Picks lines, not prose.** The model reads the cached page in the agent's own context and picks line numbers. A script copies those lines, each with its official URL.
4. **Names what it missed.** A page it did not read, or a link it did not follow, comes back as a gap.
5. **Reads each page once a day.** Pages are cached on your machine for 24 hours, by URL, and every session and project shares the cache. Ask again in another session and the page comes from disk: no network call, no browser. On a Help question that took a median of 27 seconds instead of 46; a developer `.md` page loads in about a second anyway, so there the cache saved nothing measurable ([runs](https://github.com/drsaavedra/sf-docs-agent/blob/main/docs/benchmarks.md#a-second-session-on-a-warm-cache)).

To check a line, replace `<cache path>` (the agent's Sources name it) and `<quote>` below. Apostrophes are safe, and the cache saves curly quotes as straight ones, so a quote you retype still matches. Keep one quote on one line with no blank line around it, since grep counts a blank line as matching every line. Any count above 0 means the line is on the page.

```
grep -c -F -f - <cache path> <<'EOF'
<quote>
EOF
```

Every site, and how it reads each one: [docs/how-it-works.md](https://github.com/drsaavedra/sf-docs-agent/blob/main/docs/how-it-works.md)

## How it compares

Salesforce has two official options for the same job. I ran both on the same 10 questions.

**[platform-docs-get](https://github.com/forcedotcom/sf-skills/tree/main/skills/platform-docs-get)**, a skill in Salesforce's sf-skills library, pulls every page it reads into your session. Against it, sf-docs-agent added 83% fewer tokens to your session and used 41% fewer tokens overall. sf-docs-agent got 40 of 40 runs right, and platform-docs-get 39 of 40.

**[Salesforce Docs MCP](https://labs.agentforce.com/docs/salesforce-docs-mcp)** searches a closed index with no dates on its results. It is the same trade-off you accept with [Context7](https://github.com/upstash/context7), whose README says its parsing and crawling engines are private: you can't see what the index holds or when it was taken. In my runs it returned no page from admin.salesforce.com or SLDS 2. In a subagent it got 24 of 30 right against sf-docs-agent's 30 of 30, and only 135 of its 177 quotes were on today's page, against 135 of 136. Called from the main session it got 28 of 30, but added 10 times as many tokens to your session.

**Where sf-docs-agent loses:** the MCP in a subagent is faster and cheaper: 218 seconds against 510 for all 10 questions, and 22% fewer tokens. If you are fine trusting the index, it is a good choice. I wanted something I control and can check against the live sites.

My numbers are from a rerun on 4 November 2026. The other tools ran on 30 and 31 October 2026 and were not rerun, and the docs changed in between.

Every number, per question, with the method: [docs/benchmarks.md](https://github.com/drsaavedra/sf-docs-agent/blob/main/docs/benchmarks.md)

## Limitations

- Help, admin and some older developer guides have no `.md` copy, so those pages are slower. If Salesforce changes their layout, the agent may read only part of an article. A daily check in this repo flags it.
- No Help search, because Help's `robots.txt` disallows it.
- From a page it found, it follows at most two more links in a row, and only toward a missing part of the answer. Anything further comes back as a gap.
- When a search term lands in a list or table, the script prints the whole list, one a page, up to 60 lines; a longer one it names by its line range. It cannot see a list on a rendered page, which has no list markers, and there the agent can still stop a row early. The quotes it gives are still right.
- If a site blocks headless browsers, it stops and tells you. It does not try to get around the block.
- The agent has Bash and Read. A hook limits Bash to the agent's script and to `grep` on files in its install folder. It limits Read to that folder, and it checks each quote in the agent's report against the cached page, when the agent hands its report back with Claude Code's hand-back tool. The hook stops all other commands. It checks the text of each command before the command runs, so it is not an operating system sandbox.
- No telemetry. Only the docs pages it fetches leave your machine.

How it reads each site, and the full list: [docs/how-it-works.md](https://github.com/drsaavedra/sf-docs-agent/blob/main/docs/how-it-works.md)

## Develop

```
git clone https://github.com/drsaavedra/sf-docs-agent && cd sf-docs-agent && npm install
npx playwright-core install --only-shell chromium
mkdir -p "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents"
sed "s|/path/to/sf-docs-agent|$PWD|g" agents/sf-docs.md > "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents/sf-docs.md"
npm test
```

On Linux, add `--with-deps` to the Chromium line. `agents/sf-docs.md` names its script and cache as `/path/to/sf-docs-agent`. The `sed` line writes your copy with your clone's path. Run it again after you edit the agent.

**Eval:** `node evals/run.mjs --cold` asks your installed agent the 20 regression questions in [evals/questions.json](evals/questions.json) and grades each report. The agent's guard checks every quote against the cached page, and a model with no tools judges the answer against the key. It takes about 5 minutes and $1.30 on Sonnet, and runs on your own Claude Code login, so it is on demand rather than in CI. Run it from a folder that config has trusted, since the agent's hook does not fire in an untrusted one, and on a plan with auto mode, which the agent's calls run under. `--only 5,10` runs a few questions, `--judge` picks the grading model, and `--config` points at another Claude config dir: use a clean one for numbers you will compare, since your own rules and plugins load otherwise. It needs macOS or Linux, and exits 1 if any question is not right. An outage or a stale key counts as could not run, not as a wrong answer. `--cold` empties the agent's page cache first. Reports land in `evals/results/`.

**Release:** open a PR that only bumps the version (`npm version patch --no-git-tag-version`, which changes `package.json` and `package-lock.json`). Merging it runs [`release.yml`](.github/workflows/release.yml): the tests, an install of the packed tarball, `npm publish` through npm trusted publishing (no token), a check that npm holds the tarball that was tested, then the `v<version>` tag and GitHub Release.

## License

MIT
