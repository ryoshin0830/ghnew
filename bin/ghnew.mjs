#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Buffer } from 'node:buffer';
import { input, select, confirm } from '@inquirer/prompts';

const VERSION = '0.2.0';
const SCHEMA_VERSION = 1;

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
  --json                   stdout = 1-line JSON, no prompts, no keypress
  --quiet                  stdout = path only, no prompts, no keypress
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
const log = (s) => {
  if (isJson || isQuiet) return;
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
const explicitNonInteractive = isJson || isQuiet;
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

function readHosts() {
  const r = spawnSync('gh', ['auth', 'status', '--json', 'hosts'], {
    encoding: 'utf8',
  });
  if (r.status !== 0 || !r.stdout?.trim()) return [];
  try {
    const { hosts } = JSON.parse(r.stdout);
    return Object.entries(hosts ?? {}).flatMap(([host, arr]) =>
      arr.map(({ login, gitProtocol }) => ({
        host,
        login,
        gitProtocol: gitProtocol || 'https',
      })),
    );
  } catch {
    return [];
  }
}

async function ensureGhLoggedIn() {
  let accounts = readHosts();
  if (accounts.length > 0) return accounts;
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
  log(`${dim('│')} creating ${visibility} repo on ${cyan(account.host)}…`);

  const createArgs = ['repo', 'create', `${account.login}/${name}`, visFlag, '--add-readme'];
  if (values.description) createArgs.push('--description', values.description);
  const createRes = spawnSync('gh', createArgs, {
    env: { ...process.env, GH_HOST: account.host },
    stdio: isPretty ? ['inherit', 2, 'inherit'] : ['inherit', 'ignore', 'ignore'],
  });
  if (createRes.signal === 'SIGINT') process.exit(130);
  if (createRes.status !== 0) die('E_GH_CREATE', 'gh repo create failed');

  log(`${dim('│')} ${green('✓')} created ${cyan(`${account.login}/${name}`)}`);

  const cloneUrl =
    account.gitProtocol === 'ssh'
      ? `git@${account.host}:${account.login}/${name}.git`
      : `https://${account.host}/${account.login}/${name}`;
  log(`${dim('│')} cloning via ${dim(account.gitProtocol)}…`);
  const getRes = spawnSync('ghq', ['get', cloneUrl], {
    stdio: isPretty ? ['inherit', 2, 'inherit'] : ['inherit', 'ignore', 'ignore'],
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
