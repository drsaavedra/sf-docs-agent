#!/usr/bin/env node
// PreToolUse hook for the sf-docs agent: Bash may run fetch-docs.mjs and grep on files in this dir; Read may open them.
// On the agent's hand-back it checks each Evidence line against the cached page it cites.
// It only denies (exit 2, reason on stderr); a Bash command its parser does not recognise is denied, the rest falls through.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'fetch-docs.mjs');
// How the agent file names this dir; sh's :- takes the default when the variable is unset or empty.
const CONFIG_VAR = '${CLAUDE_CONFIG_DIR:-$HOME/.claude}', CONFIG = process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME ?? ''}/.claude`;
const deny = why => {
  console.error(`sf-docs guard: ${why}. Allowed: node "${SCRIPT.replaceAll('\\', '/')}" <args>, and grep on files under`
    + ` "${ROOT.replaceAll('\\', '/')}" by absolute path, commands joined only by &&, grep with short options only (no -R).`
    + ` No unquoted wildcards or #, pipes, cd, ;, variables (but a leading "${CONFIG_VAR}"), loops,`
    + ' redirects other than 2>&1, or other commands.');
  process.exit(2);
};
// A crash exits 1, which Claude Code treats as a non-blocking error and runs the call: make it a deny.
process.on('uncaughtException', e => deny(`guard error: ${e.message}`));
// Judged by real path (of its nearest existing parent, for a file not there yet), so no symlink leads in or out.
const real = p => {
  let head = p, tail = '';
  while (!existsSync(head)) { if (dirname(head) === head) return p; tail = join(basename(head), tail); head = dirname(head); }
  return join(realpathSync(head), tail);
};
const inside = p => { const r = relative(ROOT, real(p)); return !r.startsWith('..') && !isAbsolute(r); };

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { deny('hook input is not JSON'); }
const { tool_name: tool, tool_input: args = {} } = input;
// The hand-back: the Evidence and Sources blocks must be what --quote prints for the lines they cite, and no [n:line]
// reference, [n] source or cache path may sit outside them, so a quote or URL the model retyped cannot reach the caller.
if (tool === 'SubagentHandback') try {
  const msg = (typeof args.message === 'string' ? args.message : '').replace(/\r\n?/g, '\n'); // spans compare exactly
  const refuse = (why, fix = 'Paste the --quote output unchanged') => { console.error(`sf-docs guard: ${why}. ${fix} and send the report again.`); process.exit(2); };
  const STRAY = 'Put each quote in Evidence through --quote, name pages you checked in Gaps as plain URLs with no [n], and write a time without square brackets';
  const lines = msg.split('\n'), at = h => lines.flatMap((l, i) => l.trim() === h ? [i] : []);
  // Outside the two blocks, refuse --quote's own syntax in any spelling, not the model's phrasings: a square-bracket
  // [n:line] reference (ranges and lists too), a [n] label on a doc URL, a cache: line with a path, or an Evidence or
  // Source header written any other way (unless it says none). Quoted prose with no reference is prose: unchecked.
  const HEAD = /^[\s>*#_•-]*(evidence|sources?)\b[\s*_]*(:|\s[—–]\s)/i, NONE = /^[\s>*#_•-]*(evidence|sources?)\b[\s*_]*(:|\s[—–]\s)[\s*_]*(none|n\/a|not found)[\s.*_]*$/i;
  // A reference may sit in prose when it names a line the Evidence block holds ("the wording in [1:31]"): it was checked.
  // A quote right before it must be on that line, so "999,000" [1:4] cannot pass on a line that says 250,000.
  let refs = new Map(); // filled once the Evidence block is read
  const carries = l => [...l.matchAll(/\[\s*\d+\s*:\s*\d+[\d\s,:-]*\]/g)].some(m => {
    if (!refs.has(m[0])) return true;
    const q = l.slice(0, m.index).match(/["“'‘`]([^"“”'‘’`\n]{1,500})["”'’`][^\w\n]{0,4}$/);
    return q && !refs.get(m[0]).includes(q[1]);
  })
    || /\[\d+\]:?\s*<?(https?:\/\/|[\w.-]+\.(salesforce|lightningdesignsystem)\.com)/i.test(l)
    || /^\s*cache:\s*(\/|~|[a-z]:[\\/])/i.test(l)
    || (HEAD.test(l) && !['Evidence:', 'Sources:'].includes(l.trim()) && !NONE.test(l.trim()));
  const [e, s] = [at('Evidence:'), at('Sources:')];
  if (!e.length && !s.length) {
    const stray = lines.find(carries);
    if (stray) refuse(`a quote or source outside the --quote blocks: ${stray.trim()}`, STRAY);
    process.exit(0); // a report with no quotes, such as not found
  }
  if (e.length !== 1 || s.length !== 1 || s[0] < e[0]) refuse('one Evidence: block, then one Sources: block, as one --quote call prints them');
  // Sources: [n] url / cache: path pairs, numbered from 1, until the first other line.
  const src = [];
  let k = s[0] + 1;
  for (; k + 1 < lines.length; k += 2) {
    const a = lines[k].match(/^\s*\[(\d+)\] (.+?)\s*$/), b = lines[k + 1].match(/^\s*cache: (.+?)\s*$/);
    if (!a || !b) break;
    if (a[1] !== String(src.length + 1)) refuse(`Sources numbered other than --quote numbers them, at [${a[1]}]`);
    src.push({ url: a[2], file: b[1] });
  }
  refs = new Map(lines.slice(e[0] + 1, s[0]).flatMap(l => { const m = l.trim().match(/^- "(.*)" (\[\d+:\d+\])$/); return m ? [[m[2], m[1]]] : []; }));
  const stray = lines.find((l, i) => (i < e[0] || i >= k) && carries(l));
  if (stray) refuse(`a quote or source outside the --quote blocks: ${stray.trim()}`, STRAY);
  if (!src.length) refuse('no [n] url and cache: lines under Sources:');
  // A page as --quote reads one: a file in the cache that starts with its Source: line. Each file is read once.
  const pages = new Map(), page = f => {
    if (!pages.has(f)) {
      const r = isAbsolute(f) && real(f), c = r && relative(join(ROOT, 'cache'), r), ok = c && !c.startsWith('..') && !isAbsolute(c);
      const there = ok && existsSync(f), p = there ? readFileSync(f, 'utf8').split('\n') : null;
      pages.set(f, p?.[0].startsWith('Source: ') ? p : ok && !there ? 'gone' : null);
    }
    return pages.get(f);
  };
  const wrong = [];
  src.forEach(({ url, file }, i) => {
    const p = page(file);
    if (p === 'gone') wrong.push(`the cached page ${file} is gone: fetch [${i + 1}] ${url} again and run --quote again`);
    else if (!p) wrong.push(`[${i + 1}] cache: ${file} is not a cached page`);
    else if (url !== p[0].slice(8).trim()) wrong.push(`this source:\n[${i + 1}] ${url}\nis on the page as:\n[${i + 1}] ${p[0].slice(8).trim()}`);
  });
  for (const l of lines.slice(e[0] + 1, s[0]).map(x => x.trim()).filter(Boolean)) {
    const m = l.match(/^- ".*" \[(\d+):(\d+)\]$/), f = m && src[m[1] - 1], p = f && page(f.file);
    if (p === 'gone') continue; // said once, under Sources
    const text = Array.isArray(p) && m[2] > 1 ? (p[m[2] - 1] || '').trim() : '';
    const want = text && `- "${text}" [${Number(m[1])}:${Number(m[2])}]`;
    if (l !== want) wrong.push(want ? `this line:\n${l}\nis on the page as:\n${want}` : `this line is not a --quote line for a page in Sources:\n${l}`);
  }
  if (wrong.length) refuse(`${wrong.length} line(s) in Evidence or Sources differ from the cached pages\n\n${wrong.join('\n\n')}\n`);
  process.exit(0);
} catch (e) { // a read that fails (a directory, no permission): about the report, not the Bash allowlist deny() prints
  console.error(`sf-docs guard: could not check the report (${e.code || e.message}). Run --quote again and paste its output unchanged.`);
  process.exit(2);
}
if (tool === 'Read') {
  if (typeof args.file_path !== 'string' || !isAbsolute(args.file_path) || !inside(resolve(args.file_path)))
    deny(`Read is limited to files under the install dir, not ${args.file_path}`);
  process.exit(0);
}
if (tool !== 'Bash') process.exit(0);
if (typeof args.command !== 'string') deny('no command');

// Split into commands of words on &&. Single quotes are literal; a $, backtick or any other shell syntax outside
// them is refused, so every word the shell will see is the word checked here.
const commands = [];
{
  // Trim space, tab and newline only: JS trim() also strips \v, \r and NBSP, which the shell keeps as word text.
  const src = args.command.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
  // No control character but tab, quoted or not: a NUL cuts a word, and a backslash-newline is dropped even in "...".
  if (/[\0-\x08\x0a-\x1f\x7f-\x9f]/.test(src)) deny('a newline or control character');
  let cmd = [], word = null;
  const end = () => { if (word) cmd.push(word); word = null; };
  const add = c => { word ??= { text: '' }; word.text += c; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) deny('unclosed quote');
      add(src.slice(i + 1, j)); i = j;
    } else if (c === '"') {
      add('');
      for (i++; src[i] !== '"'; i++) {
        if (i >= src.length) deny('unclosed quote');
        // The agent file's one variable, expanded as sh would from this env, which Claude Code also gives the Bash tool.
        if (src.startsWith(CONFIG_VAR, i)) { word.text += CONFIG; i += CONFIG_VAR.length - 1; continue; }
        if (src[i] === '$' || src[i] === '`') deny('variables and command substitution');
        // sh reads \$ and \` in "..." as literal text, which the expansion above would not see as such.
        if (src[i] === '\\' && '$`'.includes(src[i + 1])) deny('an escaped $ or backtick');
        if (src[i] === '\\' && '"\\'.includes(src[i + 1])) i++;
        word.text += src[i];
      }
    } else if (c === '\\') {
      if (i + 1 >= src.length) deny('trailing backslash');
      add(src[++i]);
    } else if (c === ' ' || c === '\t') end();
    else if (c === '&' && src[i + 1] === '&') { end(); commands.push(cmd); cmd = []; i++; }
    else if (c === '2' && !word && src.startsWith('2>&1', i)
      && ([' ', '\t', undefined].includes(src[i + 4]) || src.startsWith('&&', i + 4))) i += 3;
    // A wildcard is checked as text but run as the files it matches (a symlink, or .. on bash before 5.2).
    else if ('*?['.includes(c)) deny(`wildcard ${c}: name each file, or quote the pattern`);
    else if ('$`'.includes(c)) deny('variables and command substitution');
    else if (c === '|' || c === ';') deny(`${c}: join commands only with &&`);
    // # anywhere: zsh's extendedglob makes x# a wildcard. = only starts a word in zsh's =cmd expansion.
    else if ('&<>(){}!#~=^'.includes(c) && (!word || c !== '=')) deny(`shell syntax ${c}`);
    else add(c);
  }
  end();
  commands.push(cmd);
}

// grep short options only; VALUES take a value. -C only attached (-C3): BSD's -C value is optional. No -R: GNU -R
// follows every symlink it meets, GNU -r only those named on the line (checked here), BSD -r none by default.
const FLAGS = 'cEFhHiIlLnoqrsvwx0123456789', VALUES = 'eABmC';
for (const words of commands) {
  const [cmd, ...rest] = words.map(w => w.text);
  const path = w => {
    if (!isAbsolute(w.text) || !inside(w.text)) deny(`${cmd} ${w.text}: not an absolute path under the install dir`);
  };
  if (cmd === 'node') {
    if (!isAbsolute(rest[0]) || real(rest[0]) !== SCRIPT) deny(`node runs only fetch-docs.mjs, not ${rest[0]}`);
    if (rest.some(a => a === '--out' || a.startsWith('--out='))) deny('--out moves the cache');
    continue;
  }
  if (cmd !== 'grep') deny(`${cmd} is not allowed`);
  // GNU grep reorders options, so an -e anywhere makes every positional a file: then none is taken as the pattern.
  let pattern = !words.some(w => /^-[^-]*e/.test(w.text)), paths = 0;
  for (let k = 1; k < words.length; k++) {
    const t = words[k].text;
    if (t === '--') deny('grep --: drop it, and give the pattern with -e');
    if (t.startsWith('--')) deny(`grep ${t.split('=')[0]}: use the short option`); // the allowlist below denies it anyway
    if (t.startsWith('-') && t.length > 1) {
      for (let p = 1; p < t.length; p++) {
        const c = t[p];
        if (VALUES.includes(c)) {
          if (p === t.length - 1) { if (c === 'C') deny('grep -C takes its number attached, like -C3'); if (++k >= words.length) deny(`-${c} needs a value`); }
          break; // the rest of the word, or the next word, is the value
        }
        if (!FLAGS.includes(c)) deny(`grep -${c} is not allowed`);
      }
      continue;
    }
    if (pattern) { pattern = false; continue; }
    path(words[k]);
    paths++;
  }
  // grep with no file reads stdin, which nothing feeds here; -r with no file reads the shell's unknown cwd.
  if (!paths) deny('grep needs a file under the install dir');
}
process.exit(0);
