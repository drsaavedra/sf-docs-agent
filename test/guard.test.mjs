// The PreToolUse guard: each case feeds the hook one Bash command or Read path, as Claude Code would, and checks it
// allows (exit 0) or denies (exit 2). Commands are shaped on real agent calls; RT is the install dir, C its cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'guard.mjs');
const RT = realpathSync(mkdtempSync(join(tmpdir(), 'sf-docs-guard-')));
const C = join(RT, 'cache');
const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'sf-docs-project-')));
copyFileSync(GUARD, join(RT, 'guard.mjs'));
writeFileSync(join(RT, 'fetch-docs.mjs'), '');
for (const f of ['developer.salesforce.com/docs/p.md', 'help.salesforce.com/s/a.txt', 'help.salesforce.com/apex/H_1.txt']) {
  mkdirSync(dirname(join(C, f)), { recursive: true });
  writeFileSync(join(C, f), 'Source: https://x\n');
}
writeFileSync(join(PROJECT, '.env'), 'SECRET=1\n');
symlinkSync(join(PROJECT, '.env'), join(C, 'link.txt'));

const FD = `node "${RT}/fetch-docs.mjs"`;
const A = `"${C}/help.salesforce.com/s/a.txt"`;
const hook = input => spawnSync(process.execPath, [join(RT, 'guard.mjs')], { input, encoding: 'utf8' });
const bash = command => hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: PROJECT }));
const read = file_path => hook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path }, cwd: PROJECT }));

const allowed = [
  ['a fetch with terms', `${FD} --budget 480 developer.salesforce.com/docs/llms.txt --terms 'oauth,userinfo'`],
  ['a quoted Help URL with & and ?, with 2>&1', `${FD} --budget 480 'https://help.salesforce.com/s/articleView?id=x.htm&type=5' 2>&1`],
  ['2>&1 directly before &&', `${FD} --search x 2>&1&& ${FD} --search y`],
  ['a fetch then a search', `${FD} --budget 480 x.md --terms a && ${FD} --search 'b c'`],
  ['--quote with a cache-relative file', `${FD} --quote help.salesforce.com/s/a.txt:11,13`],
  ['grep -n -C3 on a cache file', `grep -n -C3 -e 'term' -e 'other' "${C}/developer.salesforce.com/docs/p.md"`],
  ['grep with a positional pattern and a | inside it', `grep -n -i -E 'oauth|userinfo' ${A}`],
  ['grep -o -m with a quoted bracket pattern', `grep -h -o -m 40 -e 'id=[a-z_.]*' "${C}/help.salesforce.com/apex/H_1.txt"`],
  ['grep -r over a cache folder', `grep -rhoi -m5 -e 'id=[a-z_]*xorg' "${C}/help.salesforce.com/apex"`],
  ['a no-break space inside a quoted grep term', `grep -n -e 'a\u00a0b' ${A}`],
  ['a quoted URL that holds #', `${FD} --budget 480 'https://developer.salesforce.com/docs/x.html#sec'`],
  ['a trailing newline', `grep -c -e x ${A}\n`],
];
const denied = [
  ['another command', 'rm -f /tmp/llms-product-docs.txt'],
  ['curl', 'curl https://help.salesforce.com/s/'],
  ['a command that was in the middle list', `head -5 ${A}`],
  ['a command off the list, shaped like grep', `sed -n -e '1w /tmp/x' ${A}`],
  ['a pipe', `${FD} --search 'a' | head`],
  [';', `grep -c -e x ${A}; grep -c -e y ${A}`],
  ['a newline between commands', `grep -c -e x ${A}\ngrep -c -e y ${A}`],
  ['cd', `cd "${C}" && grep -c -e x help.salesforce.com/s/a.txt`],
  ['a file outside the install dir', 'grep -n -e root /etc/passwd'],
  ['a home path', 'grep -e x ~/.ssh/id_ed25519'],
  ['a relative path', 'grep -n -e SECRET .env'],
  ['a .. path out of the cache', `grep -e x "${C}/../../../etc/passwd"`],
  ['an unquoted * wildcard', `grep -e x "${C}/help.salesforce.com/s/"*/../../../x`],
  ['a symlink in the cache that leads out', `grep -e x "${C}/link.txt"`],
  ['a variable', `${FD} --quote $HOME/.ssh/id_ed25519:1`],
  ['command substitution', 'grep -e $(id) /x'],
  ['command substitution in double quotes', `grep -n -e "$(cat /etc/passwd)" ${A}`],
  ['backticks', `${FD} \`id\``],
  ['eval', `eval ${FD} x.md`],
  ['2>&1 glued to a word, which redirects to a file', `${FD} --search x 2>&1foo`],
  ['a redirect', `grep -n -e x ${A} > "${C}/b.txt"`],
  ['a heredoc', `grep -c -F -f - ${A} <<'EOF'\nx\nEOF`],
  ['||', `grep -e x ${A} || grep -e y ${A}`],
  ['background &', `${FD} x.md &`],
  ['--out', `${FD} --out /tmp/c x.md`],
  ['another script', `node "${PROJECT}/evil.mjs"`],
  ['node -e', `node -e 'require("fs").rmSync("x")'`],
  ['node with no script (a crash is a deny)', 'node'],
  ['grep -f reads a pattern file', `grep -f /etc/passwd ${A}`],
  ['grep -C with its number detached', `grep -C /etc/passwd -e x ${A}`],
  ['a long option off the list', `grep --file=/etc/passwd -e x ${A}`],
  ['any long option', `grep --regexp=x ${A}`],
  ['a file before a later -e', `grep /etc/passwd -e x ${A}`],
  ['grep with no file', `grep -r -e x`],
  ['an env prefix', `X=1 grep -e x ${A}`],
  ['a subshell', `(grep -e x ${A})`],
  ['brace expansion', `grep -e x "${C}"/{a,b}`],
  ['an unclosed quote', `grep -e 'x ${A}`],
  ['grep -R, which follows every symlink it meets', `grep -R -e SECRET "${C}"`],
  ['a .* glob, which bash before 5.2 expands to ..', `grep -c -e root ${C}/.*/.*/.*/etc/passwd`],
  ['a # inside a word, a wildcard under zsh extendedglob', `grep -e SECRET ${C}/link.txt#`],
  ['a glob that reaches a symlink in the cache', `grep -e SECRET ${C}/link*`],
  ['2>&1 then a vertical tab, which zsh reads as a redirect to a file', `${FD} --search x 2>&1\u000bfoo`],
  ['2>&1 then a no-break space', `${FD} --search x 2>&1\u00a0foo`],
  ['2>&1 then a vertical tab at the end of the line', `${FD} --search x 2>&1\u000b`],
  ['2>&1 then a no-break space at the end of the line', `${FD} --search x 2>&1\u00a0`],
  ['an unquoted backslash-newline that the shell turns into ..', `grep -c -e root ${C}/.\\\n./.\\\n./.\\\n./etc/passwd`],
  ['a C1 control character outside quotes', `grep -c -e x\u0085y ${A}`],
  ['a NUL inside single quotes', `grep -c -e root '/etc/passwd\u0000/../../..${C}/a'`],
  ['a NUL inside double quotes', `grep -c -e root "/etc/passwd\u0000/../../..${C}/a"`],
  ['a newline inside single quotes', `grep -c -e 'x\ny' ${A}`],
  ['a carriage return inside double quotes', `grep -c -e x "${C}/a\r.txt"`],
  ['a carriage return', `grep -c -e x ${A}\rgrep -c -e y ${A}`],
  ['a backslash-newline in double quotes that the shell turns into ..', `grep -c -e root "${C}/.\\\n./.\\\n./.\\\n./.\\\n./etc/passwd"`],
];

for (const [name, cmd] of allowed) test(`allows ${name}`, () => {
  const r = bash(cmd);
  assert.equal(r.status, 0, r.stderr);
});
for (const [name, cmd] of denied) test(`denies ${name}`, () => {
  const r = bash(cmd);
  assert.equal(r.status, 2, `allowed: ${cmd}`);
  assert.match(r.stderr, /sf-docs guard/);
});

test('allows a Read in the cache and denies one outside it', () => {
  assert.equal(read(`${C}/help.salesforce.com/s/a.txt`).status, 0);
  assert.equal(read(`${PROJECT}/.env`).status, 2);
  assert.equal(read(`${C}/../../${PROJECT.split('/').pop()}/.env`).status, 2);
});

test('denies input it cannot parse', () => {
  assert.equal(hook('not json').status, 2);
});

// The hook line in the agent file, run as Claude Code runs it: a missing guard must deny, not exit 1 (which runs the call).
test('the agent file hook denies when guard.mjs cannot run', () => {
  const line = readFileSync(join(dirname(GUARD), 'agents', 'sf-docs.md'), 'utf8').match(/command: '(.+guard\.mjs.*)'/)[1];
  const run = dir => spawnSync('sh', ['-c', line.replaceAll('/path/to/sf-docs-agent', dir)],
    { input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: `${C}/help.salesforce.com/s/a.txt` } }) });
  assert.equal(run(RT).status, 0);
  assert.equal(run(PROJECT).status, 2);
});

test('a long option is denied with a pointer to the short one', () => {
  assert.match(bash(`grep --ignore-case -e x ${A}`).stderr, /grep --ignore-case: use the short option/);
});

test('a bare -- is denied with advice the agent can follow', () => {
  assert.match(bash(`grep -e x -- ${A}`).stderr, /grep --: drop it/);
});

// The hand-back gate: each Evidence line must be the cached page's line for its [n:line], as --quote prints it.
const PAGE = join(C, 'developer.salesforce.com/docs/limits.md');
writeFileSync(PAGE, 'Source: https://developer.salesforce.com/docs/limits.html\n# Limits\n| Edition | Per hour |\n| Enterprise | 250,000 [see](https://x/a.meta/a/b.htm) |\n');
const report = (...ev) => `Answer: Enterprise gets 250,000 an hour.\nEvidence:\n${ev.join('\n')}\nSources:\n[1] https://developer.salesforce.com/docs/limits.html\n    cache: ${PAGE}\nGaps: none.`;
const handback = message => hook(JSON.stringify({ tool_name: 'SubagentHandback', tool_input: { message }, cwd: PROJECT }));
const L4 = '- "| Enterprise | 250,000 [see](https://x/a.meta/a/b.htm) |" [1:4]';

test('the hand-back passes when every Evidence line is the cited line, and when there is no Evidence', () => {
  assert.equal(handback(report('- "# Limits" [1:2]', L4)).status, 0);
  assert.equal(handback('Answer: not found.\nGaps: checked the limits page.').status, 0);
});

test('the hand-back is refused when a quote was retyped, and the refusal carries the line on the page', () => {
  const r = handback(report('- "| Enterprise | 250,000 [see](https://x/a.meta/b.htm) |" [1:4]'));
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes(`is on the page as:\n${L4}`), r.stderr);
});

test('the hand-back is refused for a quote with no line reference or no cache path', () => {
  assert.equal(handback(report('- "| Enterprise | 250,000 |"')).status, 2);
  assert.equal(handback(report(L4.replace('[1:4]', '[2:4]'))).status, 2);
  assert.equal(handback(report(L4).replace(`cache: ${PAGE}`, `cache: ${PROJECT}/.env`)).status, 2);
});

test('the hand-back is refused, not passed, when the report is not in the --quote shape', () => {
  const shapes = {
    'a bold Evidence header': report(L4).replace('Evidence:', '**Evidence:**'),
    'a note after the header': report(L4).replace('Evidence:', 'Evidence (cells are tab-separated):'),
    'a * bullet': report(L4.replace('- "', '* "')),
    'a line with no reference': report(L4, 'the row also says 250,000'),
    'no Sources block': report(L4).replace(/Sources:[\s\S]*/, ''),
    'two Evidence blocks': report(L4) + '\n' + report('- "# Limits" [1:2]'),
    'quotes with no Evidence block': `Answer: 250,000.\n${L4}\nSources:\n[1] x\n    cache: ${PAGE}`,
  };
  for (const [name, message] of Object.entries(shapes)) assert.equal(handback(message).status, 2, name);
  assert.equal(handback(report(L4).replaceAll('\n', '\r\n')).status, 0, 'CRLF line ends');
  assert.equal(handback('Answer: not found.\nGaps: the sources I checked do not say.').status, 0, 'prose that starts with a header word');
});

test('the hand-back is refused for a cited file --quote would not read', () => {
  const other = join(RT, 'notes.md'); writeFileSync(other, 'Source: https://x\n# notes\n');
  assert.equal(handback(report('- "# notes" [1:2]').replace(`cache: ${PAGE}`, `cache: ${other}`)).status, 2, 'a file outside the cache');
  assert.equal(handback(report('- "Source: https://developer.salesforce.com/docs/limits.html" [1:1]')).status, 2, 'the Source line');
  assert.equal(handback(report('- "" [1:0]')).status, 2, 'line 0');
  assert.equal(handback(report('- "" [1:99]')).status, 2, 'past the end');
});

test('the hand-back is refused when a Sources URL was retyped, and the refusal carries the URL on the page', () => {
  const r = handback(report(L4).replace('[1] https://developer.salesforce.com/docs/limits.html', '[1] https://developer.salesforce.com/limits.html'));
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('is on the page as:\n[1] https://developer.salesforce.com/docs/limits.html'), r.stderr);
});
