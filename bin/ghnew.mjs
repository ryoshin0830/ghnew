#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { input, select, confirm } from '@inquirer/prompts';

// Read from package.json rather than a hand-maintained constant: `npm version`
// only bumps the manifest, so a literal here silently drifts and `--version`
// then reports a build the user isn't running.
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const SCHEMA_VERSION = 1;
const PKG = 'ghnew';
const SELF = fileURLToPath(import.meta.url);

const HELP = `ghnew ${VERSION} — create a GitHub repo, ghq-get it, offer to copy the cd command.

USAGE
  ghnew [options] [<repo-name>]

OPTIONS
  --host <host>            choose host non-interactively (e.g. github.com)
  --account <login>        choose account non-interactively
  --remote <host>/<login>  shorthand for --host + --account
  --public                 create a public repo (default: private)
  --internal               create an internal repo (org-only)
  --description <text>     repo description (last --description wins)
  --init <shell>           print shell integration for zsh | bash | fish
  --cmd <name>             function name emitted by --init (default: ghnew)
  --json                   stdout = 1-line JSON, no prompts, no keypress
  --quiet                  stdout = path only (what the shell function uses)
  --no-copy-prompt         skip the "press c to copy" phase
  --no-color               disable ANSI colors (also respects NO_COLOR env)
  -h, --help               show this help
  -V, --version            show version

EXAMPLES
  ghnew                                              fully interactive
  ghnew my-app                                       interactive account select
  ghnew --remote github.com/alice my-app             non-interactive
  ghnew --json --remote github.com/alice my-app      machine-readable
  ghnew --quiet --remote github.com/alice my-app     path only
  ghnew --public --description "A demo" my-tool      visibility + description

SHELL INTEGRATION
  A child process cannot change its parent shell's directory, so ghnew can only
  *print* where the new repo landed. Add this to ~/.zshrc and it moves the shell
  for you instead, exactly like ghqcd / gwqcd / gwqpull / gwqadd:

    eval "$(ghnew --init zsh)"

  Without it, ghnew falls back to the copyable box below.

OUTPUT
  Default mode prints progress to stderr and a box with the cd command,
  then waits for one key:
    c / C        copy 'cd "<path>"' to clipboard
    any other    exit silently
    Ctrl-C       exit 130

  --json mode prints 1 line of JSON to stdout:
    {"schemaVersion":1,"host":"…","login":"…","name":"…","url":"…",
     "path":"…","visibility":"private"}

  On error in --json mode, stdout is empty and stderr gets:
    {"schemaVersion":1,"error":{"code":"E_AUTH","message":"…"},"exitCode":2}

EXIT CODES
  0    success
  1    validation / generic failure (E_VALIDATION, E_GH_CREATE, E_GHQ_GET)
  2    gh not authenticated, or --account not in authenticated list (E_AUTH)
  127  gh or ghq not installed (E_DEPS)
  130  interrupted via Ctrl-C (E_INTERRUPTED)
`;

// ── arg parsing ──────────────────────────────────────────────────────────────

// Detect --json early so even parseArgs / uncaughtException failures can
// produce a schema-compliant JSON error on stderr.
const rawJson = process.argv.slice(2).includes('--json');

function emitEarlyError(message, code = 'E_VALIDATION', exitCode = 1) {
  if (rawJson) {
    process.stderr.write(JSON.stringify({
      schemaVersion: 1,
      error: { code, message },
      exitCode,
    }) + '\n');
  } else {
    process.stderr.write(`ghnew: ${message}\n`);
    process.stderr.write(`run \`ghnew --help\` for usage.\n`);
  }
  process.exit(exitCode);
}

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    options: {
      public: { type: 'boolean' },
      internal: { type: 'boolean' },
      description: { type: 'string' },
      host: { type: 'string' },
      account: { type: 'string' },
      remote: { type: 'string' },
      init: { type: 'string' },
      cmd: { type: 'string' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      'no-copy-prompt': { type: 'boolean' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
    },
    allowPositionals: true,
  }));
} catch (err) {
  emitEarlyError(err.message);
}

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(`ghnew ${VERSION}\n`);
  process.exit(0);
}

// ── color helpers ────────────────────────────────────────────────────────────

const noColorEnv =
  process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const useColor =
  !noColorEnv && !values['no-color'] && process.stderr.isTTY;
const ansi = (code) =>
  useColor ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => String(s);
const dim = ansi(2);
const cyan = ansi(36);
const green = ansi(32);
const red = ansi(31);
const bold = ansi(1);

// ── output helpers ───────────────────────────────────────────────────────────

const isJson = !!values.json;
const isQuiet = !!values.quiet;
const isPretty = !isJson && !isQuiet;

const stderr = process.stderr;
// --quiet narrows *stdout* to the path; it does not gag the tool. Creating a
// repo and cloning it takes seconds, and the shell function runs in --quiet
// mode, so silence there would read as a hang. Only --json, whose contract is
// one line, goes quiet. This matches ghqcd / gwqcd / gwqpull / gwqadd.
const log = (s) => {
  if (isJson) return;
  stderr.write(s + '\n');
};
const logErr = (s) => stderr.write(s + '\n');

// ── error reporting ──────────────────────────────────────────────────────────

const EXIT = {
  E_VALIDATION: 1,
  E_GH_CREATE: 1,
  E_GHQ_GET: 1,
  E_AUTH: 2,
  E_DEPS: 127,
  E_INTERRUPTED: 130,
};

function die(code, message) {
  const exitCode = EXIT[code] ?? 1;
  if (isJson) {
    stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code, message },
      exitCode,
    }) + '\n');
  } else {
    stderr.write(`${red('ghnew:')} ${message}\n`);
  }
  process.exit(exitCode);
}

// ── shell integration (--init) ───────────────────────────────────────────────

const SHELLS = ['zsh', 'bash', 'fish'];

// Single-quote for POSIX shells: close, escape, reopen.
const shq = (v) => `'${String(v).replaceAll("'", `'\\''`)}'`;
// fish single-quotes only treat \ and ' as special.
const fishq = (v) => `'${String(v).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

// Same three-step resolution as the sibling tools: PATH first so a global
// install wins and picks up upgrades, then the absolute path of the script that
// generated the snippet (which is what makes `eval "$(npx -y ghnew --init zsh)"`
// work at all), then npx — because npm garbage-collects ~/.npm/_npx/<hash>/ and
// without that step the shell silently loses the command.
//
// The lookup must be PATH-only (`whence -p` / `type -P` / `command -s`): the
// function shares its name with the binary, and a function-aware lookup would
// find the function and recurse until the shell dies.
function shellInit(shell, fnName) {
  const desc = 'Create a GitHub repo, ghq-get it, and cd there';
  const v = `${PKG}@${VERSION}`;
  const slug = fnName.replaceAll(/[^A-Za-z0-9_]/g, '_');
  // Flags whose output belongs to the caller, not to cd. --json would also
  // collide with the --quiet the function adds.
  const pass = '-h|--help|-V|--version|--init|--init=*|--json';

  if (shell === 'zsh') {
    return `# ${PKG} ${VERSION} — zsh integration
# Add to ~/.zshrc:  eval "$(${PKG} --init zsh)"

__${slug}_fallback=${shq(SELF)}

__${slug}_exec() {
  local __bin
  __bin=$(whence -p ${PKG} 2>/dev/null)
  if [[ -n $__bin ]]; then
    "$__bin" "$@"
  elif [[ -x $__${slug}_fallback ]]; then
    "$__${slug}_fallback" "$@"
  else
    npx -y ${shq(v)} "$@"
  fi
}

# ${desc}.
${fnName}() {
  emulate -L zsh
  local __a
  for __a in "$@"; do
    case $__a in
      ${pass})
        __${slug}_exec "$@"
        return $?
        ;;
    esac
  done
  local __dir
  __dir=$(__${slug}_exec --quiet "$@") || return $?
  [[ -n $__dir ]] || return 0
  builtin cd -- "$__dir"
}
`;
  }

  if (shell === 'bash') {
    return `# ${PKG} ${VERSION} — bash integration
# Add to ~/.bashrc:  eval "$(${PKG} --init bash)"

__${slug}_fallback=${shq(SELF)}

__${slug}_exec() {
  local __bin
  __bin=$(type -P ${PKG} 2>/dev/null)
  if [ -n "$__bin" ]; then
    "$__bin" "$@"
  elif [ -x "$__${slug}_fallback" ]; then
    "$__${slug}_fallback" "$@"
  else
    npx -y ${shq(v)} "$@"
  fi
}

# ${desc}.
${fnName}() {
  local __a
  for __a in "$@"; do
    case "$__a" in
      ${pass})
        __${slug}_exec "$@"
        return $?
        ;;
    esac
  done
  local __dir
  __dir=$(__${slug}_exec --quiet "$@") || return $?
  [ -n "$__dir" ] || return 0
  cd -- "$__dir"
}
`;
  }

  if (shell === 'fish') {
    return `# ${PKG} ${VERSION} — fish integration
# Add to ~/.config/fish/config.fish:  ${PKG} --init fish | source

set -g __${slug}_fallback ${fishq(SELF)}

function __${slug}_exec
    set -l __bin (command -s ${PKG})
    if test -n "$__bin"
        $__bin $argv
    else if test -x "$__${slug}_fallback"
        $__${slug}_fallback $argv
    else
        npx -y ${fishq(v)} $argv
    end
end

function ${fnName} --description ${fishq(desc)}
    for __a in $argv
        switch $__a
            case -h --help -V --version --init '--init=*' --json
                __${slug}_exec $argv
                return $status
        end
    end
    set -l __dir (__${slug}_exec --quiet $argv)
    # \`set\` reports the command substitution's status, but not every fish
    # release agrees on that. Capturing it keeps a failed run from cd'ing, and
    # the empty-string guard below is correct either way.
    set -l __st $status
    if test $__st -ne 0
        return $__st
    end
    if test -z "$__dir"
        return 0
    end
    cd -- $__dir
end
`;
  }

  return null;
}

if (values.init != null) {
  if (!SHELLS.includes(values.init)) {
    emitEarlyError(`--init expects one of ${SHELLS.join(' | ')}, got '${values.init}'`);
  }
  const fnName = values.cmd ?? PKG;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(fnName)) {
    emitEarlyError(`--cmd must be a valid shell function name, got '${fnName}'`);
  }
  process.stdout.write(shellInit(values.init, fnName));
  process.exit(0);
}

// ── argument validation ──────────────────────────────────────────────────────

if (values.remote) {
  const m = values.remote.match(/^([^/]+)\/([^/]+)$/);
  if (!m) die('E_VALIDATION', '--remote must be in HOST/LOGIN form (no extra slashes)');
  if (values.host && values.host !== m[1]) {
    die('E_VALIDATION', `--remote host (${m[1]}) conflicts with --host (${values.host})`);
  }
  if (values.account && values.account !== m[2]) {
    die('E_VALIDATION', `--remote login (${m[2]}) conflicts with --account (${values.account})`);
  }
  values.host ??= m[1];
  values.account ??= m[2];
}

if (values.cmd != null) {
  die('E_VALIDATION', '--cmd is only meaningful together with --init');
}

if (values.public && values.internal) {
  die('E_VALIDATION', '--public and --internal are mutually exclusive');
}

if (values.json && values.quiet) {
  die('E_VALIDATION', '--json and --quiet are mutually exclusive');
}

if (positionals.length > 1) {
  die('E_VALIDATION', `unexpected extra arguments: ${positionals.slice(1).join(' ')}`);
}

const argName = positionals[0];

// Fast-fail: in --json or --quiet mode, the repo name MUST be provided as
// a positional. Otherwise we'd run deps/auth checks before discovering the
// missing arg, which violates the agent-facing contract.
if ((values.json || values.quiet) && !argName) {
  die('E_VALIDATION', 'repository name is required as positional argument in --json/--quiet mode');
}

// ── non-interactive mode determination ───────────────────────────────────────

const stdinTTY = !!process.stdin.isTTY;
const stderrTTY = !!process.stderr.isTTY;
const stdoutTTY = !!process.stdout.isTTY;
// --quiet is deliberately NOT here. It used to be, and that made the shell
// integration impossible: `ghnew --quiet foo` on a machine with more than one
// gh account died with "multiple authenticated accounts; specify --remote"
// instead of asking. Every prompt already writes to stderr, so prompting costs
// the stdout contract nothing. --json still forbids prompts, and no TTY still
// forbids them, which is what actually protects scripts and agents.
const explicitNonInteractive = isJson;
const fullySpecified = !!(argName && values.host && values.account);
const isNonInteractive =
  explicitNonInteractive || fullySpecified || !stdinTTY;

// ── tool / login checks ──────────────────────────────────────────────────────

function commandExists(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !(r.error && r.error.code === 'ENOENT');
}

function brewAvailable() {
  return spawnSync('brew', ['--version'], { stdio: 'ignore' }).status === 0;
}

const INSTALL_URLS = {
  gh: 'https://cli.github.com/manual/installation',
  ghq: 'https://github.com/x-motemen/ghq#installation',
};

async function ensureTool(cmd) {
  if (commandExists(cmd)) return;
  if (isNonInteractive) {
    die('E_DEPS', `'${cmd}' not found in PATH. Install: ${INSTALL_URLS[cmd]}`);
  }
  if (brewAvailable()) {
    const ok = await confirm({
      message: `'${cmd}' not found. Install via 'brew install ${cmd}'?`,
      default: true,
    }, { output: process.stderr });
    if (!ok) die('E_DEPS', `Aborted. See ${INSTALL_URLS[cmd]}`);
    const r = spawnSync('brew', ['install', cmd], { stdio: ['inherit', 2, 'inherit'] });
    if (r.status !== 0) die('E_DEPS', `brew install ${cmd} failed`);
  } else {
    die('E_DEPS', `'${cmd}' not found and Homebrew unavailable. See ${INSTALL_URLS[cmd]}`);
  }
}

// Every environment variable `gh` reads as a GitHub credential. ghnew decides
// all of them for its children; see accountCredentials().
const TOKEN_VARS = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
];

function readHosts() {
  const r = spawnSync('gh', ['auth', 'status', '--json', 'hosts'], {
    encoding: 'utf8',
  });
  if (r.status !== 0 || !r.stdout?.trim()) return [];
  try {
    const { hosts } = JSON.parse(r.stdout);
    return Object.entries(hosts ?? {}).flatMap(([host, arr]) =>
      arr
        // With an ambient GH_TOKEN, gh reports an extra nameless account
        // (login: "", active: true, tokenSource: "GH_TOKEN"). It can't own a
        // repo, so it must never reach the picker or an "Available:" list.
        .filter(({ login }) => !!login)
        .map(({ login, gitProtocol, active }) => ({
          host,
          login,
          gitProtocol: gitProtocol || 'https',
          active: !!active,
        })),
    );
  } catch {
    return [];
  }
}

async function ensureGhLoggedIn() {
  let accounts = readHosts();
  if (accounts.length > 0) return accounts;
  // Distinguish "no credentials at all" from "only an anonymous env token",
  // where `gh auth login` alone is the wrong advice.
  const envVar = TOKEN_VARS.find((v) => process.env[v]);
  if (envVar) {
    die('E_AUTH',
      `only an environment token (${envVar}) is configured; ghnew needs a named ` +
      'account to own the repo. Run `gh auth login`, or unset that variable.');
  }
  if (isNonInteractive) die('E_AUTH', 'gh not authenticated. Run `gh auth login` first.');
  const ok = await confirm({
    message: "gh is not logged in. Run 'gh auth login' now?",
    default: true,
  }, { output: process.stderr });
  if (!ok) die('E_AUTH', 'Aborted — run `gh auth login` and try again.');
  const r = spawnSync('gh', ['auth', 'login'], { stdio: ['inherit', 2, 'inherit'] });
  if (r.status !== 0) die('E_AUTH', '`gh auth login` did not complete successfully');
  accounts = readHosts();
  if (accounts.length === 0) die('E_AUTH', 'Still no authenticated accounts after login');
  return accounts;
}

// ── account selection ────────────────────────────────────────────────────────

function findAccount(accounts, host, login) {
  return accounts.find((a) => a.host === host && a.login === login);
}

async function pickAccount(accounts) {
  // host + login both provided
  if (values.host && values.account) {
    const hit = findAccount(accounts, values.host, values.account);
    if (!hit) {
      const list = accounts.map((a) => `${a.host}/${a.login}`).join(', ');
      die('E_AUTH',
        `--account ${values.account} on --host ${values.host} not in authenticated list. Available: ${list}`);
    }
    return hit;
  }

  // partial → non-interactive: error
  if (isNonInteractive && (values.host || values.account)) {
    die('E_VALIDATION',
      'non-interactive mode requires both --host and --account (or use --remote)');
  }

  // partial → interactive: filter then prompt
  let pool = accounts;
  if (values.host) pool = pool.filter((a) => a.host === values.host);
  if (values.account) pool = pool.filter((a) => a.login === values.account);
  if (pool.length === 0) die('E_AUTH', 'no authenticated account matches the given filters');
  if (pool.length === 1) return pool[0];

  if (isNonInteractive) {
    const list = pool.map((a) => `${a.host}/${a.login}`).join(', ');
    die('E_VALIDATION',
      `multiple authenticated accounts; specify --remote: ${list}`);
  }

  return await select({
    message: 'account:',
    choices: pool.map((a) => ({
      name: `${a.host} / ${a.login}  (${a.gitProtocol})`,
      value: a,
    })),
  }, { output: process.stderr });
}

// ── credentials for the selected account ─────────────────────────────────────

// GH_HOST picks the host, not the account: with several logins on one host
// `gh` always uses that host's *active* account. Selecting a non-active login
// therefore ran every API call as the wrong identity — and for an Enterprise
// Managed User the failure looks like `HTTP 404 …/users/<login>`, because EMU
// profiles are invisible to tokens from outside the enterprise. So resolve the
// chosen account's own token and hand it to the child processes.
//
// The returned env is the *complete* child environment: the caller's ambient
// GH_TOKEN/GITHUB_TOKEN are dropped first, because gh prefers an environment
// token over the keyring and would otherwise authenticate as whoever exported
// it — the same wrong-identity bug from a different source.
//
// `injected` reports whether the selected account's own token was supplied, so
// a later failure can say which credentials gh actually used.
function accountCredentials(account) {
  const env = { ...process.env, GH_HOST: account.host };
  for (const v of TOKEN_VARS) delete env[v];

  const r = spawnSync(
    'gh',
    ['auth', 'token', '--hostname', account.host, '--user', account.login],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const token = r.status === 0 ? (r.stdout ?? '').trim() : '';

  if (!token) {
    // gh < 2.40 has no `--user`, and keyring reads can fail. The active
    // account is what gh would pick anyway, so it needs no injection;
    // anything else would silently act as the wrong user.
    if (account.active) return { env, injected: false };
    die('E_AUTH',
      `could not read the token for ${account.host}/${account.login}; ` +
      `gh would fall back to that host's active account. Run ` +
      `\`gh auth switch --hostname ${account.host} --user ${account.login}\`, ` +
      'or upgrade gh to >= 2.40.');
  }

  // github.com reads GH_TOKEN; GHES reads GH_ENTERPRISE_TOKEN. Set both off
  // github.com so *.ghe.com tenancies are covered too.
  env.GH_TOKEN = token;
  if (account.host !== 'github.com') env.GH_ENTERPRISE_TOKEN = token;
  return { env, injected: true };
}

// ── width / box ──────────────────────────────────────────────────────────────

// Rough East Asian Width: 全角 CJK + 全角ラテン + half-symbols treated as wide.
// Good enough for box layouts; bail to one-line fallback when uncertain.
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 0x20) return 0;
  // East Asian Wide / Fullwidth blocks (approximate)
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||           // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x303E) ||           // CJK Radicals .. CJK Symbols
    (cp >= 0x3041 && cp <= 0x33FF) ||           // Hiragana .. CJK Compat
    (cp >= 0x3400 && cp <= 0x4DBF) ||           // CJK Ext A
    (cp >= 0x4E00 && cp <= 0x9FFF) ||           // CJK Unified
    (cp >= 0xA000 && cp <= 0xA4CF) ||           // Yi
    (cp >= 0xAC00 && cp <= 0xD7A3) ||           // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) ||           // CJK Compat Ideographs
    (cp >= 0xFE30 && cp <= 0xFE4F) ||           // CJK Compat Forms
    (cp >= 0xFF00 && cp <= 0xFF60) ||           // Fullwidth Forms
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x1F300 && cp <= 0x1FAFF)            // Emoji & symbols (rough)
  ) return 2;
  return 1;
}
function strWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

function renderBox(cdCommand) {
  const cols = process.stdout.columns || process.stderr.columns || 80;
  const innerNeeded = strWidth(cdCommand) + 4; // 2 spaces padding on each side
  const boxWidth = innerNeeded + 2;             // +2 for the side borders
  if (boxWidth > cols - 2) {
    // Fallback: one-liner
    return `${dim('next:')} ${cyan(cdCommand)}`;
  }
  const inner = innerNeeded;
  const titleRaw = ' next ';
  const titleW = strWidth(titleRaw);
  const lead = '─';
  const top = `╭─${titleRaw}${lead.repeat(Math.max(0, inner - titleW - 1))}╮`;
  const empty = `│${' '.repeat(inner)}│`;
  const bot = `╰${'─'.repeat(inner)}╯`;
  const pad = ' '.repeat(Math.max(0, inner - strWidth(cdCommand) - 2));
  return [
    dim(top),
    dim(empty),
    dim('│  ') + cyan(cdCommand) + dim(pad + '│'),
    dim(empty),
    dim(bot),
  ].join('\n');
}

// ── clipboard ────────────────────────────────────────────────────────────────

function hasCmd(c) {
  return spawnSync(c, ['--version'], { stdio: 'ignore' }).error?.code !== 'ENOENT'
    || spawnSync('which', [c], { stdio: 'ignore' }).status === 0;
}
function clipboardCommand() {
  if (process.platform === 'darwin') return { bin: 'pbcopy', args: [] };
  if (process.env.WAYLAND_DISPLAY && hasCmd('wl-copy')) {
    return { bin: 'wl-copy', args: [] };
  }
  if (process.env.DISPLAY && hasCmd('xclip')) {
    return { bin: 'xclip', args: ['-selection', 'clipboard'] };
  }
  return null;
}

function copyToClipboard(text) {
  // OSC 52 for tmux / SSH — best-effort, doesn't error
  if (process.env.SSH_CONNECTION || process.env.TMUX) {
    try {
      const b64 = Buffer.from(text).toString('base64');
      stderr.write(`\x1b]52;c;${b64}\x07`);
    } catch { /* ignore */ }
  }
  const cmd = clipboardCommand();
  if (!cmd) {
    stderr.write(dim('clipboard tool not found, copy manually\n'));
    return false;
  }
  const r = spawnSync(cmd.bin, cmd.args, { input: text });
  if (r.status !== 0) {
    stderr.write(dim(`${cmd.bin} failed, copy manually\n`));
    return false;
  }
  return true;
}

// ── keypress phase ───────────────────────────────────────────────────────────

let rawModeEngaged = false;
function disengageRawMode() {
  if (rawModeEngaged && process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
  rawModeEngaged = false;
}
function restoreCursor() {
  if (process.stderr.isTTY) {
    try { process.stderr.write('\x1b[?25h'); } catch { /* ignore */ }
  }
}

process.on('exit', () => { disengageRawMode(); restoreCursor(); });
for (const sig of ['SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { disengageRawMode(); restoreCursor(); process.exit(130); });
}
process.on('uncaughtException', (err) => {
  disengageRawMode(); restoreCursor();
  if (rawJson) {
    stderr.write(JSON.stringify({
      schemaVersion: 1,
      error: { code: 'E_VALIDATION', message: String(err?.message ?? err) },
      exitCode: 1,
    }) + '\n');
  } else {
    stderr.write(`${red('ghnew:')} ${err?.stack ?? err}\n`);
  }
  process.exit(1);
});

async function waitForKey() {
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('keypress');
  try {
    process.stdin.setRawMode(true);
    rawModeEngaged = true;
  } catch { /* setRawMode throws on non-TTY; let the keypress fall through */ }
  process.stdin.resume();
  try {
    return await new Promise((resolve) => {
      const handler = (buf) => {
        process.stdin.removeListener('data', handler);
        resolve(buf);
      };
      process.stdin.on('data', handler);
    });
  } finally {
    disengageRawMode();
    process.stdin.pause();
  }
}

// ── main flow ────────────────────────────────────────────────────────────────

async function main() {
  await ensureTool('gh');
  await ensureTool('ghq');
  const accounts = await ensureGhLoggedIn();
  const account = await pickAccount(accounts);

  let name = argName;
  if (!name) {
    if (isNonInteractive) die('E_VALIDATION', 'repository name is required as positional argument');
    name = (await input({
      message: 'repository name:',
      validate: (v) => (v.trim() ? true : 'repository name is required'),
    }, { output: process.stderr })).trim();
  }

  const visibility = values.public ? 'public' : values.internal ? 'internal' : 'private';
  const visFlag = `--${visibility}`;

  log(`${dim('┌')} ${bold('ghnew')}`);
  log(`${dim('│')} creating ${visibility} repo as ${cyan(`${account.host}/${account.login}`)}…`);

  // Every child runs as the selected account, not the host's active one.
  const { env: childEnv, injected } = accountCredentials(account);

  const createArgs = ['repo', 'create', `${account.login}/${name}`, visFlag, '--add-readme'];
  if (values.description) createArgs.push('--description', values.description);
  const createRes = spawnSync('gh', createArgs, {
    env: childEnv,
    stdio: isJson ? ['inherit', 'ignore', 'ignore'] : ['inherit', 2, 'inherit'],
  });
  if (createRes.signal === 'SIGINT') process.exit(130);
  if (createRes.status !== 0) {
    // Name the identity: gh's own error omits it, and "who did this run as?"
    // is the first question every create failure raises.
    die('E_GH_CREATE',
      `gh repo create failed for ${account.login}/${name} — gh ran as ` +
      `${account.host}/${account.login} using ` +
      `${injected ? "that account's token" : "the host's active credentials"}. ` +
      `An 'HTTP 404 …/users/${account.login}' above means gh authenticated as a ` +
      'different account; check `gh auth status`.');
  }

  log(`${dim('│')} ${green('✓')} created ${cyan(`${account.login}/${name}`)}`);

  const cloneUrl =
    account.gitProtocol === 'ssh'
      ? `git@${account.host}:${account.login}/${name}.git`
      : `https://${account.host}/${account.login}/${name}`;
  log(`${dim('│')} cloning via ${dim(account.gitProtocol)}…`);
  const getRes = spawnSync('ghq', ['get', cloneUrl], {
    // Same env: over HTTPS git shells out to `gh auth git-credential`, which
    // would otherwise authenticate as the host's active account.
    env: childEnv,
    stdio: isJson ? ['inherit', 'ignore', 'ignore'] : ['inherit', 2, 'inherit'],
  });
  if (getRes.signal === 'SIGINT') process.exit(130);
  if (getRes.status !== 0) die('E_GHQ_GET', `ghq get failed for ${cloneUrl}`);

  const listRes = spawnSync(
    'ghq', ['list', '-e', '-p', `${account.host}/${account.login}/${name}`],
    { encoding: 'utf8' },
  );
  const localPath = (listRes.stdout ?? '').trim().split('\n')[0];
  if (!localPath) die('E_GHQ_GET', 'could not resolve local path via `ghq list`');

  log(`${dim('│')} ${green('✓')} cloned`);
  log(`${dim('└')}`);

  // ── output ────────────────────────────────────────────────────────────────

  if (isJson) {
    process.stdout.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      host: account.host,
      login: account.login,
      name,
      url: `https://${account.host}/${account.login}/${name}`,
      path: localPath,
      visibility,
    }) + '\n');
    return;
  }
  if (isQuiet) {
    process.stdout.write(localPath + '\n');
    return;
  }

  const cdCommand = `cd "${localPath}"`;
  stderr.write('\n');
  stderr.write(renderBox(cdCommand) + '\n');

  // The cd box and the keypress hint are emitted to stderr, so the keypress
  // phase only makes sense if stderr is a TTY (where the user can see the
  // prompt) AND stdin is a TTY (where they can press a key).
  const canPrompt =
    !values['no-copy-prompt'] && stdinTTY && stderrTTY;

  if (!canPrompt) return;

  stderr.write(`   ${dim('press')} ${bold('c')} ${dim('to copy')} ${dim('·')} ${dim('any other key to exit')}\n`);

  const buf = await waitForKey();
  if (buf.includes(0x03)) process.exit(130);
  const first = buf[0];
  if (first === 99 || first === 67) {
    if (copyToClipboard(cdCommand)) {
      stderr.write(`   ${green('✓')} ${dim('copied')}\n`);
    }
  }
}

main().catch((err) => {
  disengageRawMode();
  restoreCursor();
  if (err?.name === 'ExitPromptError') process.exit(130);
  if (isJson) {
    stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code: 'E_VALIDATION', message: String(err?.message ?? err) },
      exitCode: 1,
    }) + '\n');
  } else {
    stderr.write(`${red('ghnew:')} ${err?.stack ?? err}\n`);
  }
  process.exit(1);
});
