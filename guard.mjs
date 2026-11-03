#!/usr/bin/env node
// PreToolUse hook for the sf-docs agent (declared in its frontmatter, so it runs only for that agent's calls).
// Bash may run fetch-docs.mjs and read-only commands on files in this install dir; Read may open files in it.
// It only denies (exit 2, reason on stderr); an allowed call falls through to the user's own permission settings.
// The parser is not a shell: anything it does not recognise is denied, so a gap in it costs a call, never a hole.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'fetch-docs.mjs');
const deny = why => {
  console.error(`sf-docs guard: ${why}. Allowed: node "${SCRIPT.replaceAll('\\', '/')}" <args>, and grep, sed -n '<a,b>p',`
    + ` head, tail, cut, sort, wc, ls, find, cat, echo on files under "${ROOT.replaceAll('\\', '/')}", joined by |, ; or &&,`
    + ' with cd into that dir first or absolute paths. No variables, loops, redirects or other commands.');
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
if (tool === 'Read') {
  if (typeof args.file_path !== 'string' || !isAbsolute(args.file_path) || !inside(resolve(args.file_path)))
    deny(`Read is limited to files under the install dir, not ${args.file_path}`);
  process.exit(0);
}
if (tool !== 'Bash') process.exit(0);
if (typeof args.command !== 'string') deny('no command');

// Split into segments of words on | ; && and newlines. Single quotes are literal; a $, backtick or any other
// shell syntax outside them is refused, so every word the shell will see is the word checked here.
const segments = [];
{
  const src = args.command;
  let seg = [], word = null, i = 0;
  const end = () => { if (word) seg.push(word); word = null; };
  const cut = op => {
    end();
    if (!seg.length) { if (op === ';' && segments.at(-1)?.op !== '|' && segments.at(-1)?.op !== '&&') return; deny(`empty command before ${op}`); }
    segments.push({ words: seg, op }); seg = [];
  };
  const add = (c, glob = false) => { word ??= { text: '', glob: false, quoted: false }; word.text += c; word.glob ||= glob; };
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) deny('unclosed quote');
      add(''); word.quoted = true; word.text += src.slice(i + 1, j); i = j;
    } else if (c === '"') {
      add(''); word.quoted = true;
      for (i++; src[i] !== '"'; i++) {
        if (i >= src.length) deny('unclosed quote');
        if (src[i] === '$' || src[i] === '`') deny('variables and command substitution');
        if (src[i] === '\\' && '"\\'.includes(src[i + 1])) i++;
        word.text += src[i];
      }
    } else if (c === '\\') {
      if (i + 1 >= src.length) deny('trailing backslash');
      if (src[++i] !== '\n') add(src[i]);
    } else if (c === ' ' || c === '\t') end();
    else if (c === '\n' || c === ';') cut(';');
    else if (c === '|') cut('|');
    else if (c === '&') { if (src[i + 1] !== '&') deny('background &'); cut('&&'); i++; }
    else if (c === '2' && !word && src.startsWith('2>&1', i) && /[\s|;]|$/.test(src[i + 4] ?? '')) i += 3;
    else if ('*?['.includes(c)) add(c, true);
    else if ('$`'.includes(c)) deny('variables and command substitution');
    else if ('<>(){}!#~=^'.includes(c) && (!word || !'=#'.includes(c))) deny(`shell syntax ${c}`);
    else add(c);
  }
  end();
  if (seg.length) segments.push({ words: seg, op: ';' });
  else if (segments.length && segments.at(-1).op !== ';') deny('command ends in an operator');
}

// Allowed options only, so an option that reads or writes a file (grep -f, sort -o, sed -i, find -delete) is denied
// by absence. Per command: short flags, then short options taking a value (attached, or the next word). grep -C is
// attached only (-C3): BSD grep's -C takes an optional value, so the next word would be a file, not a number.
const OPTS = {
  grep: ['cEFhHiIlLnoqrRsvwx0123456789', 'eABmC'], sed: ['n', ''], head: ['', 'nc'], tail: ['', 'nc'],
  cut: ['sn', 'bcdf'], sort: ['bdfhnruV', 'kt'], wc: ['clmw', ''], cat: ['bennstuv', ''], ls: ['1aAdFhlRrSt', ''],
};
// grep long options, accepted only as --name or --name=value: some take an optional value on BSD grep.
const LONG = ['--regexp', '--include', '--exclude', '--exclude-dir', '--color', '--max-count', '--context', '--ignore-case',
  '--line-number', '--count', '--only-matching', '--no-filename', '--recursive', '--extended-regexp', '--fixed-strings',
  '--word-regexp'];
const FIND_VALUES = ['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-size', '-mtime', '-mmin'];
const FIND_FLAGS = ['-print', '-print0', '-empty'];
let cwd = null; // only a cd in this same command sets it: the agent's shell cwd is not known here
segments.forEach(({ words, op }, n) => {
  const piped = op === '|' || segments[n - 1]?.op === '|';
  const [cmd, ...rest] = words.map(w => w.text);
  const path = (w, why) => {
    if (w.glob && /(^|\/)\.\.(\/|$)/.test(w.text)) deny(`.. in a glob: ${w.text}`);
    if (!inside(resolve(cwd ?? '/', w.text))) deny(`${why ?? cmd} ${w.text} is outside the install dir (a relative path needs a cd into it first)`);
  };
  if (cmd === 'cd') {
    if (piped) deny('cd inside a pipe');
    if (rest.length !== 1 || rest[0].startsWith('-')) deny('cd takes one directory');
    path(words[1], 'cd');
    const dir = resolve(cwd ?? '/', rest[0]);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) deny(`cd into a missing directory ${rest[0]}`);
    cwd = dir;
    return;
  }
  if (cmd === 'echo') { words.slice(1).filter(w => w.glob).forEach(w => path(w)); return; }
  if (cmd === 'node') {
    if (!isAbsolute(words[1].text) && !cwd) deny('node runs only fetch-docs.mjs, by its absolute path');
    if (real(resolve(cwd ?? '/', words[1].text)) !== SCRIPT) deny(`node runs only fetch-docs.mjs, not ${words[1].text}`);
    if (rest.some(a => a === '--out' || a.startsWith('--out='))) deny('--out moves the cache');
    return;
  }
  if (!['grep', 'sed', 'head', 'tail', 'cut', 'sort', 'wc', 'ls', 'find', 'cat'].includes(cmd)) deny(`${cmd} is not allowed`);
  const [flags, values] = OPTS[cmd] ?? ['', ''];
  // GNU grep reorders options, so an -e anywhere makes every positional a file: then none is taken as the pattern.
  const e = words.some(w => /^-[^-]*e/.test(w.text) || w.text.startsWith('--regexp'));
  let paths = 0, pattern = cmd === 'grep' && !e, script = cmd === 'sed', recursive = false;
  for (let k = 1; k < words.length; k++) {
    const w = words[k], t = w.text;
    if (cmd === 'find' && t.startsWith('-')) {
      if (FIND_VALUES.includes(t)) { if (++k >= words.length) deny(`${t} needs a value`); continue; }
      if (!FIND_FLAGS.includes(t)) deny(`find ${t} is not allowed`);
      continue;
    }
    if (/^-\d+$/.test(t) && (cmd === 'head' || cmd === 'tail')) continue;
    if (t.startsWith('--')) {
      const [name] = t.split('=');
      if (cmd !== 'grep' || !LONG.includes(name)) deny(`${cmd} ${name} is not allowed`);
      if (name === '--recursive') recursive = true;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      for (let p = 1; p < t.length; p++) {
        const c = t[p];
        if (cmd === 'grep' && 'rR'.includes(c)) recursive = true;
        if (values.includes(c)) {
          if (p === t.length - 1) { if (c === 'C') deny('grep -C takes its number attached, like -C3'); if (++k >= words.length) deny(`-${c} needs a value`); }
          break; // the rest of the word, or the next word, is the value
        }
        if (!flags.includes(c)) deny(`${cmd} -${c} is not allowed`);
      }
      continue;
    }
    if (pattern) { pattern = false; continue; }
    if (script) {
      if (!/^(\d+|\$)(,(\d+|\$))?p(;(\d+|\$)(,(\d+|\$))?p)*;?$/.test(t)) deny(`sed script ${t}: only line ranges like '12,30p;90,96p'`);
      script = false;
      continue;
    }
    path(w);
    paths++;
  }
  // With no file, these read the shell's cwd, which only a cd in this command makes known.
  if (!paths && (cmd === 'ls' || cmd === 'find' || recursive) && !cwd) deny(`${cmd} with no path reads an unknown dir`);
});
process.exit(0);
