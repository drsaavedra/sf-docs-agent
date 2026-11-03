#!/usr/bin/env node
// PreToolUse hook for the sf-docs agent: Bash may run fetch-docs.mjs and grep on files in this dir; Read may open them.
// It only denies (exit 2, reason on stderr), and denies anything its parser does not recognise; the rest falls through.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'fetch-docs.mjs');
const deny = why => {
  console.error(`sf-docs guard: ${why}. Allowed: node "${SCRIPT.replaceAll('\\', '/')}" <args>, and grep on files under`
    + ` "${ROOT.replaceAll('\\', '/')}" by absolute path, commands joined only by &&, grep with short options only (no -R).`
    + ' No unquoted wildcards or #, pipes, cd, ;, variables, loops, redirects other than 2>&1, or other commands.');
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
  // Trim space, tab and newline only: JS trim() also strips \v and NBSP, which the shell keeps as word text.
  const src = args.command.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
  // Outside quotes the shell splits on space and tab only, so no control character or other space; a backslash-newline
  // is dropped even in double quotes (`.\<newline>.` is `..`), so no newline there. Single quotes are literal.
  const ODD = /[\0-\x08\x0a-\x1f\x7f-\x9f]|[^\S \t]/u, odd = 'a newline, control character or space other than space and tab';
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
        if (src[i] === '$' || src[i] === '`') deny('variables and command substitution');
        if (src[i] === '\n') deny(`${odd} inside double quotes`);
        if (src[i] === '\\' && '"\\'.includes(src[i + 1])) i++;
        word.text += src[i];
      }
    } else if (c === '\\') {
      if (i + 1 >= src.length) deny('trailing backslash');
      if (ODD.test(src[i + 1])) deny(`${odd} after a backslash`);
      add(src[++i]);
    } else if (c === ' ' || c === '\t') end();
    else if (ODD.test(c)) deny(`${odd} outside quotes`);
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
