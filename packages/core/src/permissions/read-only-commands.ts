import { splitCommands, type SimpleCommand } from './shell-parse.js';

/** Programs that only read, whatever their arguments (flags that write are checked below). */
const READ_ONLY_PROGRAMS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'pwd',
  'echo',
  'printf',
  'which',
  'whereis',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'cmp',
  'comm',
  'date',
  'uname',
  'whoami',
  'id',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'jq',
  'nl',
  'od',
  'hexdump',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
  'true',
  'false',
  'test',
  '[',
  'ps',
  'cd',
  'fd',
  'Get-ChildItem',
  'Get-Content',
  'Get-Location',
  'Select-String',
]);

/** git subcommands that never change the repository or the working tree. */
const READ_ONLY_GIT = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  'grep',
  'describe',
  'shortlog',
  'reflog',
  'merge-base',
  'name-rev',
  'show-ref',
  'whatchanged',
]);

/** Flags that make an otherwise read-only program write (`sort -o`, `find -delete`, …). */
const WRITING_FLAGS: Record<string, readonly string[]> = {
  sort: ['-o', '--output'],
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'],
  tree: ['-o'],
  fd: ['-x', '--exec', '-X', '--exec-batch'],
  rg: ['--pre'],
  date: ['-s', '--set'],
  file: ['-C', '--compile'],
};

const SAFE_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', 'NUL', 'nul']);

function gitSubcommand(words: readonly string[]): string | undefined {
  // skip global options such as `-C dir` or `--no-pager`
  for (let i = 1; i < words.length; i++) {
    const w = words[i] ?? '';
    if (w === '-C') {
      i++;
      continue;
    }
    if (w.startsWith('-')) continue;
    return w;
  }
  return undefined;
}

function isReadOnlySimple(cmd: SimpleCommand): boolean {
  if (cmd.text.includes('$(') || cmd.text.includes('`')) return false;
  if (cmd.redirects.some((r) => !SAFE_SINKS.has(r))) return false;
  const [program = '', ...args] = cmd.words;
  const base = program.split('/').pop() ?? program;
  // `VAR=value cmd` can change what cmd runs (PAGER, GIT_EXTERNAL_DIFF, …)
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(cmd.text)) return false;
  if (base === 'git') {
    // `-c key=value`, --output and --ext-diff can make git run programs or write files
    const risky = ['-c', '--ext-diff', '-O', '--open-files-in-pager'];
    if (args.some((a) => risky.includes(a) || a.startsWith('--output') || a.startsWith('-O')))
      return false;
    const sub = gitSubcommand(cmd.words);
    if (sub === 'branch' || sub === 'tag' || sub === 'remote' || sub === 'stash') {
      // listing forms only: `git branch`, `git branch -a`, `git stash list`, `git remote -v`
      const rest = args.filter((a) => a !== sub);
      if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
      return rest.every((a) => /^(-a|-r|-v|-vv|--all|--list|-l|--remotes|--verbose)$/.test(a));
    }
    if (sub === 'config') return args.some((a) => a === '--get' || a === '--list' || a === '-l');
    return sub !== undefined && READ_ONLY_GIT.has(sub);
  }
  if (base === 'find') {
    const writing = WRITING_FLAGS.find ?? [];
    return !args.some((a) => writing.includes(a));
  }
  // `uniq in out` writes its second operand
  if (base === 'uniq' && args.filter((a) => !a.startsWith('-')).length > 1) return false;
  if (!READ_ONLY_PROGRAMS.has(base)) return false;
  const writing = WRITING_FLAGS[base] ?? [];
  return !args.some((a) => writing.some((f) => a === f || a.startsWith(`${f}=`)));
}

/**
 * True when every part of a command line only reads: `ls`, `cat`, `grep`, `git status`/`log`/
 * `diff`, … with no output redirected to a file and no command substitution. Conservative: an
 * unknown program counts as writing.
 */
export function isReadOnlyCommand(command: string): boolean {
  const cmds = splitCommands(command);
  return cmds.length > 0 && cmds.every(isReadOnlySimple);
}
