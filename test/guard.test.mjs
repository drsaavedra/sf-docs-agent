// The PreToolUse guard: each case feeds the hook one Bash command or Read path, as Claude Code would, and checks it
// allows (exit 0) or denies (exit 2). Commands are shaped on real agent calls; RT is the install dir, C its cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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
  ['a fetch then a search', `${FD} --budget 480 x.md --terms a && ${FD} --search 'b c'`],
  ['--quote with a cache-relative file', `${FD} --quote help.salesforce.com/s/a.txt:11,13`],
  ['grep -n -C3 on a cache file', `grep -n -C3 -e 'term' -e 'other' "${C}/developer.salesforce.com/docs/p.md"`],
  ['grep with a positional pattern and a | inside it', `grep -n -i -E 'oauth|userinfo' ${A}`],
  ['grep -o -m with a quoted bracket pattern', `grep -h -o -m 40 -e 'id=[a-z_.]*' "${C}/help.salesforce.com/apex/H_1.txt"`],
  ['grep -r over a cache folder', `grep -rhoi -m5 -e 'id=[a-z_]*xorg' "${C}/help.salesforce.com/apex"`],
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
  ['a glob that climbs with ..', `grep -e x "${C}/help.salesforce.com/s/"*/../../../x`],
  ['a symlink in the cache that leads out', `grep -e x "${C}/link.txt"`],
  ['a variable', `${FD} --quote $HOME/.ssh/id_ed25519:1`],
  ['command substitution', 'grep -e $(id) /x'],
  ['command substitution in double quotes', `grep -n -e "$(cat /etc/passwd)" ${A}`],
  ['backticks', `${FD} \`id\``],
  ['eval', `eval ${FD} x.md`],
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
  ['a file before a later -e', `grep /etc/passwd -e x ${A}`],
  ['grep with no file', `grep -r -e x`],
  ['an env prefix', `X=1 grep -e x ${A}`],
  ['a subshell', `(grep -e x ${A})`],
  ['brace expansion', `grep -e x "${C}"/{a,b}`],
  ['an unclosed quote', `grep -e 'x ${A}`],
  ['grep -R, which follows every symlink it meets', `grep -R -e SECRET "${C}"`],
  ['a .* glob, which bash before 5.2 expands to ..', `grep -c -e root ${C}/.*/.*/.*/etc/passwd`],
  ['a glob that reaches a symlink in the cache', `grep -e SECRET ${C}/link*`],
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
