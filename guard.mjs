#!/usr/bin/env node
// PreToolUse hook for the sf-docs agent (declared in its frontmatter, so it runs only for that agent's calls).
// Bash may run fetch-docs.mjs and grep on files in this install dir, joined only by &&; Read may open files in it.
// It only denies (exit 2, reason on stderr); an allowed call falls through to the user's own permission settings.
// The parser is not a shell: anything it does not recognise is denied, so a gap in it costs a call, never a hole.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'fetch-docs.mjs');
const deny = why => {
  console.error(`sf-docs guard: ${why}. Allowed: node "${SCRIPT.replaceAll('\\', '/')}" <args>, and grep on files under`
    + ` "${ROOT.replaceAll('\\', '/')}" by absolute path, two commands joined only by &&. No pipes, cd, ;, variables,`
    + ' loops, redirects other than 2>&1, or other commands.');
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

// Split into commands of words on &&. Single quotes are literal; a $, backtick or any other shell syntax outside
// them is refused, so every word the shell will see is the word checked here.
const commands = [];
{
  const src = args.command.trim();
  // The shell drops a backslash-newline even inside double quotes, so `.\<newline>.` would become `..`: no newlines.
  if (/[\r\n]/.test(src)) deny('a newline: write one command line, joining commands with &&');
  let cmd = [], word = null;
  const end = () => { if (word) cmd.push(word); word = null; };
  const add = (c, glob = false) => { word ??= { text: '', glob: false }; word.text += c; word.glob ||= glob; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) deny('unclosed quote');
      add(''); word.text += src.slice(i + 1, j); i = j;
    } else if (c === '"') {
      add('');
      for (i++; src[i] !== '"'; i++) {
        if (i >= src.length) deny('unclosed quote');
        if (src[i] === '$' || src[i] === '`') deny('variables and command substitution');
        if (src[i] === '\\' && '"\\'.includes(src[i + 1])) i++;
        word.text += src[i];
      }
    } else if (c === '\\') {
      if (i + 1 >= src.length) deny('trailing backslash');
      add(src[++i]);
    } else if (c === ' ' || c === '\t') end();
    else if (c === '&' && src[i + 1] === '&') { end(); commands.push(cmd); cmd = []; i++; }
    else if (c === '2' && !word && src.startsWith('2>&1', i) && /\s|$/.test(src[i + 4] ?? '')) i += 3;
    else if ('*?['.includes(c)) add(c, true);
    else if ('$`'.includes(c)) deny('variables and command substitution');
    else if (c === '|' || c === ';') deny(`${c}: join commands only with &&`);
    else if ('&<>(){}!#~=^'.includes(c) && (!word || !'=#'.includes(c))) deny(`shell syntax ${c}`);
    else add(c);
  }
  end();
  commands.push(cmd);
}

// grep options allowed: short flags, then short options taking a value (attached, or the next word), and long ones.
// grep -C is attached only (-C3): BSD grep's -C takes an optional value, so the next word would be a file.
const FLAGS = 'cEFhHiIlLnoqrRsvwx0123456789', VALUES = 'eABmC';
const LONG = ['--regexp', '--include', '--exclude', '--exclude-dir', '--color', '--max-count', '--context', '--ignore-case',
  '--line-number', '--count', '--only-matching', '--no-filename', '--recursive', '--extended-regexp', '--fixed-strings',
  '--word-regexp'];
for (const words of commands) {
  const [cmd, ...rest] = words.map(w => w.text);
  const path = w => {
    if (w.glob && /(^|\/)\.\.(\/|$)/.test(w.text)) deny(`.. in a glob: ${w.text}`);
    if (!isAbsolute(w.text) || !inside(w.text)) deny(`${cmd} ${w.text}: not an absolute path under the install dir`);
  };
  if (cmd === 'node') {
    if (!isAbsolute(rest[0]) || real(rest[0]) !== SCRIPT) deny(`node runs only fetch-docs.mjs, not ${rest[0]}`);
    if (rest.some(a => a === '--out' || a.startsWith('--out='))) deny('--out moves the cache');
    continue;
  }
  if (cmd !== 'grep') deny(`${cmd} is not allowed`);
  // GNU grep reorders options, so an -e anywhere makes every positional a file: then none is taken as the pattern.
  let pattern = !words.some(w => /^-[^-]*e/.test(w.text) || w.text.startsWith('--regexp')), paths = 0;
  for (let k = 1; k < words.length; k++) {
    const t = words[k].text;
    if (t.startsWith('--')) {
      const [name] = t.split('=');
      if (!LONG.includes(name)) deny(`grep ${name} is not allowed`);
      continue;
    }
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
