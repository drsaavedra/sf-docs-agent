// Offline: the eval's own logic. The model calls are the eval's job, not a test's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockedBy, checkQuotes, childEnv, claude, guardOf, guardRefuses, judgePrompt, reportsOf, sessionDir, tally, verdict } from '../evals/run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const good = { page: 'right', answer: 'correct', gapsHonest: true };

test('a run passes only with the right page, a correct answer, honest gaps and checked quotes', () => {
  assert.equal(verdict(good, true), true);
  assert.equal(verdict({ ...good, page: 'equivalent' }, true), true);
  assert.equal(verdict(good, false), false);
  assert.equal(verdict({ ...good, page: 'wrong' }, true), false);
  assert.equal(verdict({ ...good, page: 'none' }, true), false);
  assert.equal(verdict({ ...good, answer: 'partial' }, true), false);
  assert.equal(verdict({ ...good, gapsHonest: false }, true), false);
});

test('the guard is the one the agent file names', () => {
  assert.equal(guardOf(readFileSync(join(ROOT, 'agents/sf-docs.md'), 'utf8')), '/path/to/sf-docs-agent/guard.mjs');
  assert.equal(guardOf('no hook here'), undefined);
});

// An install: the guard beside its cache, one cached page, and a report that quotes it.
const install = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sf-docs-eval-'))), page = join(dir, 'cache/developer.salesforce.com/docs/p.md');
  copyFileSync(join(ROOT, 'guard.mjs'), join(dir, 'guard.mjs'));
  mkdirSync(dirname(page), { recursive: true });
  writeFileSync(page, 'Source: https://developer.salesforce.com/docs/p.html\n# P\n\nThe limit is 100.\n');
  const report = line => `Answer: 100.\n\nEvidence:\n- "${line}" [1:4]\nSources:\n[1] https://developer.salesforce.com/docs/p.html\n    cache: ${page}\n\nGaps: none`;
  return { dir, page, guard: join(dir, 'guard.mjs'), report };
};

test('the quote check passes lines copied from the cached page and fails a retyped one', () => {
  const { guard, report } = install();
  assert.equal(checkQuotes(guard, [report('The limit is 100.')]).ok, true);
  const bad = checkQuotes(guard, [report('The limit is 999.')]);
  assert.equal(bad.ok, false);
  assert.match(bad.why, /is on the page as/);
});

test('reports with no quoted line fail, one honest "not found" beside a quoted report passes', () => {
  const { guard, report, page } = install();
  assert.deepEqual(checkQuotes(guard, ['Answer: the page says "100".\n\nGaps: none']), { ok: false, unquoted: true, why: 'no quoted line in any report' });
  assert.deepEqual(checkQuotes(guard, [`Answer: 100.\n\nEvidence:\nSources:\n[1] https://developer.salesforce.com/docs/p.html\n    cache: ${page}\n\nGaps: none`]), { ok: false, unquoted: true, why: 'no quoted line in any report' });
  assert.equal(checkQuotes(guard, ['Not found.\n\nGaps: none', report('The limit is 100.')]).ok, true);
  assert.deepEqual(checkQuotes(guard, []), { ok: false, unquoted: true, why: 'the sf-docs agent returned no report' });
  assert.equal(checkQuotes(guard, [`${report('The limit is 100.').replace('[1:4]', '[1:4] ')}`]).ok, true);
});

test('the reports are each sf-docs hand-back, not the brief and not another agent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-docs-eval-'));
  const lines = (...content) => content.map(([role, c]) => JSON.stringify({ message: { role, content: [c] } })).join('\n');
  writeFileSync(join(dir, 'a.meta.json'), '{"agentType":"Explore"}');
  writeFileSync(join(dir, 'a.jsonl'), lines(['assistant', { type: 'text', text: 'not this' }]));
  assert.deepEqual(reportsOf(dir), []);
  writeFileSync(join(dir, 'b.meta.json'), '{"agentType":"sf-docs"}');
  writeFileSync(join(dir, 'b.jsonl'), `${lines(['user', { type: 'text', text: 'the brief' }], ['assistant', { type: 'text', text: 'working' }], ['assistant', { type: 'tool_use', name: 'SubagentHandback', input: { message: 'the report' } }])}\nnot json`);
  assert.deepEqual(reportsOf(dir), ['the report']);
  writeFileSync(join(dir, 'c.meta.json'), '{"agentType":"sf-docs"}');
  writeFileSync(join(dir, 'c.jsonl'), lines(['assistant', { type: 'text', text: 'second report' }]));
  assert.deepEqual(reportsOf(dir), ['the report', 'second report']);
  writeFileSync(join(dir, 'b.jsonl'), lines(['user', { type: 'text', text: 'the brief' }]));
  assert.deepEqual(reportsOf(dir), ['second report']);
  assert.deepEqual(reportsOf(join(dir, 'nowhere')), []);
});

test('a session is found by its id, whatever the project folder is called', () => {
  const config = mkdtempSync(join(tmpdir(), 'sf-docs-eval-'));
  mkdirSync(join(config, 'projects/short/other/subagents'), { recursive: true });
  mkdirSync(join(config, 'projects/a-very-long-path-abc123/session-1/subagents'), { recursive: true });
  assert.equal(sessionDir(config, 'session-1'), join(config, 'projects/a-very-long-path-abc123/session-1/subagents'));
  assert.equal(sessionDir(config, 'nope'), undefined);
});

test('a child keeps its login and provider settings and loses the parent session', () => {
  const env = childEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', CLAUDE_CODE_CLIENT_CERT: 'c', CLAUDE_CONFIG_DIR: '/parent' });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', CLAUDE_CODE_CLIENT_CERT: 'c' });
  assert.equal(childEnv({}, '/given').CLAUDE_CONFIG_DIR, '/given');
});

test('the tally counts passes, runs that could not finish and cost', () => {
  const t = tally([{ q: 5, pass: true, cost: 0.5 }, { q: 10, pass: false, cost: 0.25 }, { q: 15, pass: false, error: 'timed out' }]);
  assert.deepEqual(t, { n: 3, pass: 1, errors: 1, timedOut: 1, cost: 0.75 });
  assert.equal(tally([{ q: 5, error: 'boom' }]).timedOut, 0);
});

test('the bank is the 20 published regression questions, each with a key', () => {
  const qs = JSON.parse(readFileSync(join(ROOT, 'evals/questions.json'), 'utf8'));
  assert.deepEqual(qs.map(q => q.n), Array.from({ length: 20 }, (_, i) => (i + 1) * 5));
  for (const q of qs) for (const k of ['question', 'key', 'keylines', 'site', 'kind']) assert.ok(q[k], `Q${q.n} has no ${k}`);
  assert.match(judgePrompt(qs[0], 'THE REPORT'), new RegExp(`${qs[0].question.slice(0, 30).replace(/[?()]/g, '.')}[\\s\\S]*THE REPORT`));
});

// The real main block in a temp copy, so its results stay out of evals/results, with a fake claude first on the PATH: an agent
// call writes a session holding FAKE_REPORT and prints FAKE_ANSWER; a judge call logs itself and prints FAKE_JUDGE.
const FAKE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs'), { join } = require('node:path');
const e = process.env;
if (process.argv.includes('--version')) process.exit(0);
appendFileSync(e.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes('--json-schema')) { console.log(e.FAKE_JUDGE); process.exit(0); }
const d = join(e.CLAUDE_CONFIG_DIR, 'projects/p/s1/subagents');
mkdirSync(d, { recursive: true });
writeFileSync(join(d, 'a.meta.json'), '{"agentType":"sf-docs"}');
writeFileSync(join(d, 'a.jsonl'), JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: e.FAKE_REPORT }] } }));
console.log(e.FAKE_ANSWER);`;
const RIGHT = JSON.stringify({ structured_output: { page: 'right', answer: 'correct', gapsHonest: true, cause: 'none', note: 'ok' }, total_cost_usd: 0.25 });
const setup = () => {
  const i = install(), config = join(i.dir, 'config'), code = join(i.dir, 'evals');
  mkdirSync(join(config, 'agents'), { recursive: true });
  mkdirSync(code);
  for (const f of ['run.mjs', 'questions.json']) copyFileSync(join(ROOT, 'evals', f), join(code, f));
  writeFileSync(join(config, 'agents/sf-docs.md'), `model: claude-sonnet-5-5\ncommand: 'node "${i.guard}" || exit 2'\n`);
  writeFileSync(join(i.dir, 'claude'), FAKE);
  chmodSync(join(i.dir, 'claude'), 0o755);
  const log = join(i.dir, 'log');
  writeFileSync(log, '');
  const main = (args, env = {}) => spawnSync(process.execPath, [join(code, 'run.mjs'), '--config', config, ...args], { encoding: 'utf8', cwd: i.dir, env: {
    ...process.env, PATH: `${i.dir}:${process.env.PATH}`, FAKE_LOG: log, FAKE_REPORT: i.report('The limit is 100.'), FAKE_JUDGE: RIGHT,
    FAKE_ANSWER: '{"session_id":"s1","total_cost_usd":0.5}', ...env } });
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { ...i, main, config, calls, judged: () => calls().some(c => c.includes('--json-schema')) };
};

test('a bad flag stops before anything runs, and the cache stays', () => {
  const { main, page } = setup();
  for (const args of [['--conc', 'abc'], ['--conc', '0'], ['--conc', 'Infinity'], ['--only', '7'], ['--only', '5,7']]) {
    const r = main([...args, '--cold']);
    assert.equal(r.status, 2, `${args}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--conc must be a whole number/);
  }
  for (const args of [['--only=x=1', '--nope'], ['--model']]) assert.equal(main([...args, '--cold']).status, 2);
  assert.equal(existsSync(page), true);
});

test('--cold empties the cache of the guard it found', () => {
  const { main, page } = setup();
  main(['--only', '5', '--cold']);
  assert.equal(existsSync(page), false);
});

test('a right report passes, adds up both costs and exits 0', () => {
  const r = setup().main(['--only', '5']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Q005 PASS/);
  assert.match(r.stdout, /right 1 of 1, cost \$0\.75/);
});

test('a retyped quote fails without paying for the judge, and exits 1', () => {
  const s = setup(), r = s.main(['--only', '5'], { FAKE_REPORT: s.report('The limit is 999.') });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Q005 FAIL quotes:/);
  assert.equal(s.judged(), false);
});

test('a wrong answer fails, naming its cause', () => {
  const r = setup().main(['--only', '5'], { FAKE_JUDGE: JSON.stringify({ structured_output: { page: 'right', answer: 'wrong', gapsHonest: true, cause: 'model', note: 'misread' } }) });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Q005 FAIL model: misread/);
});

test('a run that fails or goes ungraded counts as could not run, with its reason', () => {
  const cases = [[{ FAKE_ANSWER: '{"is_error":true,"result":"Not logged in"}' }, /Q005 ERROR Not logged in/],
    [{ FAKE_ANSWER: '{"is_error":true,"subtype":"error_max_turns"}' }, /Q005 ERROR error_max_turns/],
    [{ FAKE_ANSWER: '{"is_error":true,"errors":["boom"]}' }, /Q005 ERROR boom/],
    [{ FAKE_ANSWER: '{"total_cost_usd":0.5}' }, /Q005 ERROR no session id/],
    [{ FAKE_JUDGE: '{"result":"no schema"}' }, /Q005 ERROR no grade/]];
  for (const [env, line] of cases) {
    const r = setup().main(['--only', '5'], env);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, line);
    assert.match(r.stdout, /right 0 of 1, 1 could not run/);
  }
});

test('the agent runs in auto mode with no MCP servers, and the judge has no tools and its own model', () => {
  const s = setup();
  assert.equal(s.main(['--only', '5', '--model', 'opus', '--judge', 'haiku']).status, 0);
  const [agent, judge] = s.calls();
  assert.deepEqual(agent.slice(agent.indexOf('--model'), agent.indexOf('--model') + 4), ['--model', 'opus', '--permission-mode', 'auto']);
  assert.ok(agent.includes('--strict-mcp-config'));
  assert.equal(judge[judge.indexOf('--tools') + 1], '');
  assert.equal(judge[judge.indexOf('--model') + 1], 'haiku');
  assert.ok(judge.includes('--no-session-persistence'));
});

test('a BLOCKED report could not run, and a report with no quotes still reaches the judge', () => {
  const s = setup(), r = s.main(['--only', '5'], { FAKE_REPORT: 'BLOCKED: headless Chromium did not start' });
  assert.match(r.stdout, /Q005 ERROR BLOCKED: headless Chromium/);
  assert.equal(s.judged(), false);
  const q = setup(), n = q.main(['--only', '5'], { FAKE_REPORT: 'Not found.\n\nGaps: the page was down.', FAKE_JUDGE: JSON.stringify({ structured_output: { page: 'none', answer: 'not-found', gapsHonest: true, cause: 'discovery', note: 'never reached it' } }) });
  assert.match(n.stdout, /Q005 FAIL discovery: never reached it/);
});

test('an outage or a stale key counts as could not run, a page pruned before the check too', () => {
  const j = cause => ({ cause, note: 'n' });
  assert.equal(blockedBy([], { ok: true }, j('site-down')), 'site-down: n');
  assert.equal(blockedBy([], { ok: true }, j('key-wrong')), 'key-wrong: n');
  assert.equal(blockedBy([], { ok: true }, j('model')), undefined);
  assert.equal(blockedBy(['x'], { ok: false, why: 'the cached page /a is gone: fetch [1]' }), 'the cached page /a is gone: fetch [1]');
});

test('an old guard, no agent or no claude stops the run before the cache is touched', () => {
  const s = setup();
  writeFileSync(s.guard, 'process.exit(0);');
  assert.equal(guardRefuses(s.guard), false);
  const old = s.main(['--cold']);
  assert.equal(old.status, 2);
  assert.match(old.stderr, /older than 0\.1\.5/);
  const n = setup();
  rmSync(join(n.config, 'agents/sf-docs.md'));
  assert.match(n.main([]).stderr, /no installed sf-docs agent/);
  const c = setup();
  rmSync(join(c.dir, 'claude'));
  const miss = c.main(['--cold'], { PATH: dirname(process.execPath) });
  assert.equal(miss.status, 2, miss.stdout + miss.stderr);
  assert.match(miss.stderr, /claude is not on the PATH/);
  assert.equal(existsSync(c.page), true);
});

test('a call past its time limit resolves with the reason, and a CLI that is missing says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-docs-eval-'));
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\nsleep 30\n');
  chmodSync(join(dir, 'claude'), 0o755);
  assert.match((await claude([], { PATH: `${dir}:${process.env.PATH}` }, 0.002)).err, /^timed out after/);
  assert.match((await claude([], { PATH: '/nowhere' }, 1)).err, /ENOENT/);
});

test('a result is kept when a child of claude holds the pipe open after it exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-docs-eval-'));
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\necho \'{"session_id":"s1"}\'\nsleep 30 &\n');
  chmodSync(join(dir, 'claude'), 0o755);
  const t0 = Date.now();
  assert.equal((await claude([], { PATH: `${dir}:${process.env.PATH}` }, 1)).session_id, 's1');
  assert.ok(Date.now() - t0 < 10_000, 'waited for the child');
});
