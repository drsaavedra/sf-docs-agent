// node evals/run.mjs [--config <claude config dir>] [--only 5,10] [--model sonnet] [--judge sonnet] [--conc 4] [--cold]   (macOS and Linux)
// Asks the installed sf-docs agent the questions in evals/questions.json, then grades each report: the agent's own guard
// checks every quote against the cached page, and a model with no tools judges the answer against the key.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = {
  type: 'object',
  properties: {
    page: { type: 'string', enum: ['right', 'equivalent', 'wrong', 'none'] },
    answer: { type: 'string', enum: ['correct', 'partial', 'wrong', 'not-found'] },
    gapsHonest: { type: 'boolean' },
    cause: { type: 'string', enum: ['none', 'discovery', 'brief', 'model', 'site-down', 'key-wrong'] },
    note: { type: 'string' },
  },
  required: ['page', 'answer', 'gapsHonest', 'cause', 'note'],
};

// The grading rules of the published rounds, less the steps a script now does: reading files and checking quotes.
export const judgePrompt = (q, report) => `Grade one answer from a Salesforce docs agent against its answer key. A script has already checked every quote against the cached page, so take them as verbatim.

Question (${q.kind}): ${q.question}
Key: ${q.key}
Key pages: ${q.keylines} (dev/ = developer.salesforce.com/docs/, arch/ = architect.salesforce.com/docs/architect/, help/<id> = the Help article with that id, admin/<p> = admin.salesforce.com/blog/<p>, lds/<p> = www.lightningdesignsystem.com/2e1ef8501/p/<p>, lds-full/<name> = the lightningdesignsystem.com page on that component, apexref-full/<name> = the Apex Reference page on that class; the numbers after a colon are line numbers in a snapshot, ignore them)

The agent's report, verbatim (more than one when it ran more than once):
<report>
${report}
</report>

1. page: is a Sources URL the key's official page, or does a quote show it states the same fact? Help counts by article id in any query order; architect at the bare path or .html is the same page. "equivalent" = a different official page that states the fact.
2. answer against the key. A scan must carry every item the key lists, or it is partial. A conflict passes only if both disagreeing lines are quoted and flagged. A version-scoped key needs the scope.
3. gapsHonest: does Gaps admit what the agent did not find, and does it avoid claims with no quote?
4. cause, when the page is wrong or none, the answer is not correct or Gaps is not honest: discovery (never reached the page), brief (did something the brief forbids or skipped a step it orders), model (had the right lines but misread), site-down (Help served its "temporarily unavailable" shell), key-wrong (the page now says something else and the agent quoted it). Otherwise none.
note: one sentence, the evidence for the grade.`;

export const verdict = (j, quotesOk) => quotesOk && ['right', 'equivalent'].includes(j.page) && j.answer === 'correct' && j.gapsHonest;

// The guard the agent file names: its hook runs on the hand-back, and the cache sits beside it.
export const guardOf = agent => agent.match(/node "([^"]+\/guard\.mjs)"/)?.[1];

// The guard's own hand-back check on each report, run again here because a hook can be off (an untrusted folder, a changed
// harness). It lets a report with no quotes through, for a real "not found", so at least one line must be quoted.
export const checkQuotes = (guard, reports) => {
  for (const message of reports) {
    const r = spawnSync(process.execPath, [guard], { input: JSON.stringify({ tool_name: 'SubagentHandback', tool_input: { message } }), encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, why: r.stderr.trim() };
  }
  return reports.some(r => /^\s*- ".*" \[\d+:\d+\]\s*$/m.test(r)) ? { ok: true } : { ok: false, unquoted: true, why: reports.length ? 'no quoted line in any report' : 'the sf-docs agent returned no report' };
};

// A guard from before 0.1.5 has no hand-back check and passes any report, so it must refuse a stray quote before it is trusted.
export const guardRefuses = guard => spawnSync(process.execPath, [guard], { input: JSON.stringify({ tool_name: 'SubagentHandback', tool_input: { message: 'Answer: "made up" [1:4]' } }), encoding: 'utf8' }).status === 2;

// Every hand-back of the sf-docs subagent in a session's transcript folder: a caller can run it once per part of a question.
export const reportsOf = dir => {
  if (!existsSync(dir)) return [];
  const reports = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.meta.json'))) {
    if (JSON.parse(readFileSync(join(dir, f), 'utf8')).agentType !== 'sf-docs') continue;
    let hand = '', text = '';
    for (const line of readFileSync(join(dir, f.replace('.meta.json', '.jsonl')), 'utf8').split('\n')) {
      let m; try { m = JSON.parse(line).message; } catch { continue; }
      for (const c of m?.content || []) {
        if (c?.type === 'tool_use' && c.name === 'SubagentHandback' && c.input?.message) hand = c.input.message;
        if (c?.type === 'text' && m.role === 'assistant') text = c.text;
      }
    }
    if (hand || text) reports.push(hand || text);
  }
  return reports;
};

// A session's folder, found by its id: Claude Code shortens long project paths, so the name cannot be rebuilt here.
export const sessionDir = (config, id) => (existsSync(join(config, 'projects')) ? readdirSync(join(config, 'projects')) : []).map(p => join(config, 'projects', p, id, 'subagents')).find(existsSync);

// A parent Claude Code session's variables make a child answer "Not logged in"; a login or provider setting has to stay.
// The config dir is passed only when set: setting it to the default moves where the CLI looks for its login.
export const childEnv = (env, config) => {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('CLAUDE') || /^CLAUDE_CODE_(OAUTH_TOKEN$|USE_|SKIP_|CLIENT_)/.test(k)));
  return config ? { ...out, CLAUDE_CONFIG_DIR: config } : out;
};

export const tally = rows => ({ n: rows.length, pass: rows.filter(r => r.pass).length, errors: rows.filter(r => r.error).length,
  timedOut: rows.filter(r => /timed out/.test(r.error)).length, cost: rows.reduce((a, r) => a + (r.cost || 0), 0) });

// What stops a report counting for or against the agent: its own BLOCKED line, a page pruned before the re-check, an outage or a stale key.
export const blockedBy = (reports, quotes, j) => reports.find(r => /^BLOCKED:/m.test(r))?.split('\n')[0]
  ?? (/is gone/.test(quotes.why) ? quotes.why : ['site-down', 'key-wrong'].includes(j?.cause) ? `${j.cause}: ${j.note}` : undefined);

export const claude = (args, env, minutes) => new Promise(res => {
  const p = spawn('claude', ['-p', ...args, '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { err += d; });
  const kill = setTimeout(() => {
    p.kill('SIGTERM');
    setTimeout(() => p.kill('SIGKILL'), 5000);
    p.stdout.destroy(); p.stderr.destroy(); // a child's child can hold the pipes open, so do not wait for close
    res({ err: `timed out after ${minutes} minutes` });
  }, minutes * 60_000);
  p.on('error', e => { clearTimeout(kill); res({ err: e.message }); }); // claude not on the PATH
  // Same hazard after a clean exit: close would wait out the timeout and lose a finished result.
  p.on('exit', () => setTimeout(() => { p.stdout.destroy(); p.stderr.destroy(); }, 2000).unref());
  p.on('close', () => {
    clearTimeout(kill);
    try { const j = JSON.parse(out); res(j.is_error ? { ...j, err: j.result || j.errors?.join('; ') || j.subtype || 'claude reported an error' } : j); }
    catch { res({ err: err.slice(0, 300) || out.slice(0, 300) || 'no output' }); }
  });
});

const judge = (q, report, model, env) => claude([judgePrompt(q, report), '--tools', '', '--no-session-persistence', '--model', model, '--json-schema', JSON.stringify(SCHEMA)], env, 5);

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let flags;
  try { ({ values: flags } = parseArgs({ options: { config: { type: 'string' }, only: { type: 'string' }, model: { type: 'string', default: 'sonnet' }, judge: { type: 'string', default: 'sonnet' }, conc: { type: 'string', default: '4' }, cold: { type: 'boolean' } } })); }
  catch (e) { console.error(e.message); process.exit(2); }
  const given = flags.config ? resolve(flags.config) : process.env.CLAUDE_CONFIG_DIR, config = given || join(homedir(), '.claude');
  const conc = Number(flags.conc), only = flags.only?.split(',').map(Number);
  const bank = JSON.parse(readFileSync(join(HERE, 'questions.json'), 'utf8')), questions = bank.filter(q => !only || only.includes(q.n));
  if (!Number.isInteger(conc) || conc < 1 || only?.some(n => !bank.some(q => q.n === n))) { console.error('--conc must be a whole number from 1, and --only must name questions in evals/questions.json'); process.exit(2); }
  const agentFile = [resolve('.claude/agents/sf-docs.md'), join(config, 'agents/sf-docs.md')].find(existsSync);
  const agent = agentFile ? readFileSync(agentFile, 'utf8') : '', guard = guardOf(agent);
  if (!guard || !existsSync(guard)) { console.error(`no installed sf-docs agent with a guard under ${config}: run npx sf-docs-agent first`); process.exit(2); }
  if (!guardRefuses(guard)) { console.error('the installed agent is older than 0.1.5 and cannot check quotes: run npx sf-docs-agent'); process.exit(2); }
  if (spawnSync('claude', ['--version'], { env: process.env }).status !== 0) { console.error('claude is not on the PATH'); process.exit(2); }
  if (flags.cold) rmSync(join(dirname(guard), 'cache'), { recursive: true, force: true }); // only pages, refetched on demand

  const out = join(HERE, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(out, { recursive: true });
  const env = childEnv(process.env, given);
  const ask = async q => {
    const a = await claude([`Answer this from the official Salesforce docs, with quotes and their sources: ${q.question} Site: ${q.site}.`, '--model', flags.model, '--permission-mode', 'auto'], env, 15);
    const cost = a.total_cost_usd || 0;
    if (a.err || !a.session_id) return { error: a.err || 'no session id', cost };
    try {
      const reports = reportsOf(sessionDir(config, a.session_id)), quotes = checkQuotes(guard, reports);
      if (blockedBy(reports, quotes)) return { quotes, reports, cost, error: blockedBy(reports, quotes) };
      if (!quotes.ok && !quotes.unquoted) return { quotes, reports, cost }; // a retyped quote: the judge is told they were checked
      if (!reports.length) return { quotes, reports, cost };
      const g = await judge(q, reports.join('\n\n'), flags.judge, env), j = g.structured_output;
      return { quotes, reports, judge: j, cost: cost + (g.total_cost_usd || 0), error: j ? blockedBy(reports, quotes, j) : g.err || 'no grade' };
    } catch (e) { return { error: e.message, cost }; }
  };

  const rows = [];
  let next = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (next < questions.length) {
      const q = questions[next++], t0 = Date.now(), tag = `Q${String(q.n).padStart(3, '0')}`;
      const r = await ask(q);
      const row = { q: q.n, pass: !!r.judge && verdict(r.judge, r.quotes.ok), secs: Math.round((Date.now() - t0) / 1000), ...r };
      writeFileSync(join(out, `${tag}.json`), JSON.stringify({ ...row, question: q.question, key: q.key }, null, 1));
      const { reports, ...brief } = row; // the reports stay in the per-question files
      rows.push(brief);
      console.log(`${tag} ${row.error ? `ERROR ${row.error}` : row.pass ? 'PASS' : `FAIL ${row.judge ? `${row.judge.cause}: ${row.judge.note}` : `quotes: ${row.quotes.why}`}`} (${row.secs}s)`);
    }
  }));
  const t = tally(rows.sort((x, y) => x.q - y.q));
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ ...t, caller: flags.model, judge: flags.judge, agent: agent.match(/^model: (.+)$/m)?.[1], rows }, null, 1));
  console.log(`right ${t.pass} of ${t.n}${t.errors ? `, ${t.errors} could not run` : ''}, cost ${t.timedOut ? 'at least ' : ''}$${t.cost.toFixed(2)}, reports in ${out}`);
  process.exitCode = t.pass === t.n ? 0 : 1;
}
