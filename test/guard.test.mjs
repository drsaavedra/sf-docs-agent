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
const hook = input => spawnSync(process.execPath, [join(RT, 'guard.mjs')], { input, encoding: 'utf8' });
const bash = command => hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: PROJECT }));
const read = file_path => hook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path }, cwd: PROJECT }));

const allowed = [
  ['a fetch with terms', `${FD} --budget 480 developer.salesforce.com/docs/llms.txt --terms 'oauth,userinfo'`],
  ['a quoted Help URL with & and ?, piped to head', `${FD} --budget 480 'https://help.salesforce.com/s/articleView?id=x.htm&type=5' 2>&1 | head -80`],
  ['a fetch then a search', `${FD} --budget 480 x.md --terms a && ${FD} --search 'b c'`],
  ['--quote with a cache-relative file', `${FD} --quote help.salesforce.com/s/a.txt:11,13`],
  ['grep -n on a cache file', `grep -n -C3 -e 'term' -e 'other' "${C}/developer.salesforce.com/docs/p.md"`],
  ['cd into the cache, sed -n and cut', `cd "${C}/help.salesforce.com/s"; sed -n '55,70p;90,96p' a.txt | cut -c1-1200`],
  ['grep -o over a glob, sort -u, head', `cd "${C}/help.salesforce.com/apex" && grep -h -o -i -E 'id=[a-z_.0-9]*oauth' H_*.txt | sort -u | head -150`],
  ['ls and find in the cache', `ls "${C}" | head; find "${C}" -name 'a.txt' -type f`],
  ['wc, tail and cat on cache files', `wc -l "${C}/help.salesforce.com/s/a.txt"; tail -n 5 "${C}/developer.salesforce.com/docs/p.md"; cat "${C}/help.salesforce.com/s/a.txt"`],
  ['grep reading a pipe', `${FD} --search 'a' | grep -i -e 'help'`],
  ['echo between steps', `echo '---'; grep -c -e x "${C}/help.salesforce.com/s/a.txt"`],
];
const denied = [
  ['another command', 'rm -f /tmp/llms-product-docs.txt'],
  ['curl', 'curl https://help.salesforce.com/s/'],
  ['a file outside the install dir', 'grep -n -e root /etc/passwd'],
  ['a home path', 'cat ~/.ssh/id_ed25519'],
  ['a relative path with no cd first', 'grep -n -e SECRET .env'],
  ['a .. path out of the cache', `cd "${C}" && cat ../../../etc/passwd`],
  ['a glob that climbs with ..', `cd "${C}/help.salesforce.com/s" && cat */../../../x`],
  ['a variable', `D=${C}/help.salesforce.com/s; ${FD} --quote $D/a.txt:4`],
  ['command substitution', 'echo $(cat /etc/passwd)'],
  ['backticks', 'echo `id`'],
  ['a loop', 'for i in 1 2; do echo x; done'],
  ['eval', `eval ${FD} x.md`],
  ['a redirect', `grep -n -e x "${C}/help.salesforce.com/s/a.txt" > "${C}/b.txt"`],
  ['a heredoc', `cat <<'EOF'\nx\nEOF`],
  ['||', `cd "${C}/nope" || cat .env`],
  ['background &', `${FD} x.md &`],
  ['--out', `${FD} --out /tmp/c x.md`],
  ['another script', `node "${PROJECT}/evil.mjs"`],
  ['node -e', `node -e 'require("fs").rmSync("x")'`],
  ['cd out of the install dir', 'cd /tmp; ls'],
  ['ls with no cd and no path', 'ls'],
  ['cd inside a pipe', `cd "${C}" | cat a.txt`],
  ['grep -f reads a pattern file', `grep -f /etc/passwd "${C}/help.salesforce.com/s/a.txt"`],
  ['find -delete', `find "${C}" -name '*.txt' -delete`],
  ['find -exec', `find "${C}" -exec cat /etc/passwd ';'`],
  ['sed -i', `sed -i 's/a/b/' "${C}/help.salesforce.com/s/a.txt"`],
  ['a sed script that writes', `sed -n '1w /tmp/x' "${C}/help.salesforce.com/s/a.txt"`],
  ['sort -o writes', `sort -o "${C}/b.txt" "${C}/help.salesforce.com/s/a.txt"`],
  ['an env prefix', `X=1 grep -e x "${C}/help.salesforce.com/s/a.txt"`],
  ['a subshell', `(cd /tmp; ls)`],
  ['brace expansion', `cat "${C}"/{a,b}`],
  ['an unclosed quote', `grep -e 'x "${C}/a`],
  ['a symlink in the cache that leads out', `cat "${C}/link.txt"`],
  ['grep -C with its number detached', `grep -C /etc/passwd -e x "${C}/help.salesforce.com/s/a.txt"`],
  ['--regexp with no =', `grep --regexp /etc/passwd "${C}/help.salesforce.com/s/a.txt"`],
  ['a long option off the list', `sort --files0-from=/etc/passwd`],
  ['a file before a later -e', `grep /etc/passwd -e x "${C}/help.salesforce.com/s/a.txt"`],
  ['command substitution in double quotes', `grep -n -e "$(cat /etc/passwd)" "${C}/help.salesforce.com/s/a.txt"`],
  ['a command off the list, on a cache file', `tee "${C}/help.salesforce.com/s/a.txt"`],
  ['node with no script (a crash is a deny)', 'node'],
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
