// Regression tests for multi-account hosts.
//
// `gh` resolves credentials from the *active* account of a host; GH_HOST alone
// cannot pick between two logins on github.com. ghnew must therefore hand the
// selected account's token to every child process, or `gh repo create
// <other-login>/<name>` runs as the wrong identity (404 for EMU logins, whose
// profiles are invisible to tokens outside the enterprise).
//
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'ghnew.mjs');

const HOSTS = {
  hosts: {
    'github.com': [
      { state: 'success', active: true, host: 'github.com', login: 'octocat', gitProtocol: 'ssh' },
      { state: 'success', active: false, host: 'github.com', login: 'monalisa_acme', gitProtocol: 'https' },
    ],
    'ghe.example.com': [
      { state: 'success', active: true, host: 'ghe.example.com', login: 'hubot', gitProtocol: 'https' },
    ],
  },
};

// Extensionless CommonJS shims: no package.json in the temp dir, so node
// treats them as CJS.
const GH_SHIM = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
fs.appendFileSync(process.env.GHNEW_TEST_RECORD, JSON.stringify({
  bin: 'gh',
  args,
  env: {
    GH_HOST: process.env.GH_HOST,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
    GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN,
  },
}) + '\\n');
if (args[0] === '--version') { process.stdout.write('gh version 2.89.0\\n'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(process.env.GHNEW_TEST_HOSTS + '\\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'token') {
  const user = flag('--user') ?? flag('-u');
  const host = flag('--hostname') ?? flag('-h') ?? 'github.com';
  if (user && process.env.GHNEW_TEST_NO_USER_FLAG) {
    process.stderr.write('unknown flag: --user\\n');
    process.exit(1);
  }
  process.stdout.write('TOKEN::' + host + '::' + (user ?? 'active') + '\\n');
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'create') {
  process.exit(process.env.GHNEW_TEST_CREATE_FAIL ? 1 : 0);
}
process.exit(1);
`;

const GHQ_SHIM = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GHNEW_TEST_RECORD, JSON.stringify({
  bin: 'ghq',
  args,
  env: {
    GH_HOST: process.env.GH_HOST,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
    GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN,
  },
}) + '\\n');
if (args[0] === '--version') { process.stdout.write('ghq version 1.6.3\\n'); process.exit(0); }
if (args[0] === 'get') process.exit(0);
if (args[0] === 'list') { process.stdout.write('/fake/src/' + args[args.length - 1] + '\\n'); process.exit(0); }
process.exit(1);
`;

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ghnew-test-'));
  for (const [name, body] of [['gh', GH_SHIM], ['ghq', GHQ_SHIM]]) {
    const p = join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  return { dir, record: join(dir, 'record.jsonl') };
}

function runGhnew(args, extraEnv = {}) {
  const { dir, record } = makeSandbox();
  const env = { ...process.env };
  // Never let the developer's real credentials leak into the sandbox.
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']) {
    delete env[k];
  }
  // We pass NO_COLOR below; npm sets FORCE_COLOR for lifecycle scripts on a
  // TTY, and node warns to stderr when both are set. That warning lands on
  // the stream we assert against, so drop the conflicting vars.
  for (const k of ['FORCE_COLOR', 'CLICOLOR_FORCE']) delete env[k];
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...env,
      PATH: `${dir}:${env.PATH}`,
      NO_COLOR: '1',
      GHNEW_TEST_RECORD: record,
      GHNEW_TEST_HOSTS: JSON.stringify(HOSTS),
      ...extraEnv,
    },
  });
  const calls = existsSync(record)
    ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { ...r, calls };
}

const findCall = (calls, bin, ...head) =>
  calls.find((c) => c.bin === bin && head.every((h, i) => c.args[i] === h));

// I2 says stderr *carries* the error JSON, not that it is the only thing on
// the stream: node warnings and anything a child writes can share it. Pick the
// JSON line, and show the raw stream when there isn't one — a bare
// `Unexpected token '('` says nothing about what actually polluted stderr.
function errJson(stderr) {
  const line = stderr.split('\n').find((l) => l.trimStart().startsWith('{'));
  assert.ok(line, `no JSON error line on stderr. Raw stderr:\n${stderr}`);
  return JSON.parse(line);
}

test('non-active github.com account: gh repo create runs with that account token', () => {
  const r = runGhnew(['--json', '--remote', 'github.com/monalisa_acme', 'my-app']);
  assert.equal(r.status, 0, r.stderr);

  const create = findCall(r.calls, 'gh', 'repo', 'create');
  assert.ok(create, 'gh repo create was never invoked');
  assert.equal(create.args[2], 'monalisa_acme/my-app');
  assert.equal(create.env.GH_HOST, 'github.com');
  assert.equal(
    create.env.GH_TOKEN,
    'TOKEN::github.com::monalisa_acme',
    'gh repo create must use the selected account token, not the active one',
  );

  const out = JSON.parse(r.stdout);
  assert.equal(out.login, 'monalisa_acme');
  assert.equal(out.host, 'github.com');
});

test('ghq get inherits the same token (https credential helper)', () => {
  const r = runGhnew(['--json', '--remote', 'github.com/monalisa_acme', 'my-app']);
  assert.equal(r.status, 0, r.stderr);
  const get = findCall(r.calls, 'ghq', 'get');
  assert.ok(get, 'ghq get was never invoked');
  assert.equal(get.args[1], 'https://github.com/monalisa_acme/my-app');
  assert.equal(get.env.GH_TOKEN, 'TOKEN::github.com::monalisa_acme');
});

test('enterprise host also gets GH_ENTERPRISE_TOKEN', () => {
  const r = runGhnew(['--json', '--remote', 'ghe.example.com/hubot', 'my-app']);
  assert.equal(r.status, 0, r.stderr);
  const create = findCall(r.calls, 'gh', 'repo', 'create');
  assert.equal(create.env.GH_HOST, 'ghe.example.com');
  assert.equal(create.env.GH_ENTERPRISE_TOKEN, 'TOKEN::ghe.example.com::hubot');
  assert.equal(create.env.GH_TOKEN, 'TOKEN::ghe.example.com::hubot');
});

test('active account still works when gh is too old for `auth token --user`', () => {
  const r = runGhnew(
    ['--json', '--remote', 'github.com/octocat', 'my-app'],
    { GHNEW_TEST_NO_USER_FLAG: '1' },
  );
  assert.equal(r.status, 0, r.stderr);
  const create = findCall(r.calls, 'gh', 'repo', 'create');
  assert.equal(create.env.GH_HOST, 'github.com');
  assert.equal(create.env.GH_TOKEN, undefined);
});

test('non-active account + old gh: actionable E_AUTH instead of a confusing 404', () => {
  const r = runGhnew(
    ['--json', '--remote', 'github.com/monalisa_acme', 'my-app'],
    { GHNEW_TEST_NO_USER_FLAG: '1' },
  );
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  const err = errJson(r.stderr);
  assert.equal(err.error.code, 'E_AUTH');
  assert.match(err.error.message, /gh auth switch/);
  assert.equal(findCall(r.calls, 'gh', 'repo', 'create'), undefined, 'must not attempt the create');
});

// `gh` prefers an environment token over the keyring, so an ambient GH_TOKEN in
// the caller's shell silently overrides the account ghnew resolved — the same
// wrong-identity failure, from a different source. The child's GitHub
// credentials must be exactly what ghnew decided, nothing inherited.
const STALE = { GH_TOKEN: 'STALE', GITHUB_TOKEN: 'STALE', GH_ENTERPRISE_TOKEN: 'STALE', GITHUB_ENTERPRISE_TOKEN: 'STALE' };

test('ambient tokens never reach the children', () => {
  const r = runGhnew(['--json', '--remote', 'github.com/monalisa_acme', 'my-app'], STALE);
  assert.equal(r.status, 0, r.stderr);

  for (const call of [findCall(r.calls, 'gh', 'repo', 'create'), findCall(r.calls, 'ghq', 'get')]) {
    assert.equal(call.env.GH_TOKEN, 'TOKEN::github.com::monalisa_acme');
    assert.equal(call.env.GITHUB_TOKEN, undefined, 'ambient GITHUB_TOKEN must be cleared');
    assert.equal(call.env.GH_ENTERPRISE_TOKEN, undefined, 'github.com must not carry an enterprise token');
    assert.equal(call.env.GITHUB_ENTERPRISE_TOKEN, undefined);
  }
});

test('active-account fallback clears ambient tokens instead of inheriting them', () => {
  const r = runGhnew(
    ['--json', '--remote', 'github.com/octocat', 'my-app'],
    { ...STALE, GHNEW_TEST_NO_USER_FLAG: '1' },
  );
  assert.equal(r.status, 0, r.stderr);
  const create = findCall(r.calls, 'gh', 'repo', 'create');
  assert.equal(
    create.env.GH_TOKEN, undefined,
    "a stale GH_TOKEN would authenticate as whoever exported it, not the host's active account",
  );
  assert.equal(create.env.GITHUB_TOKEN, undefined);
});

test('gh repo create failure names the identity it ran as', () => {
  const r = runGhnew(
    ['--json', '--remote', 'github.com/monalisa_acme', 'my-app'],
    { GHNEW_TEST_CREATE_FAIL: '1' },
  );
  assert.equal(r.status, 1);
  const err = errJson(r.stderr);
  assert.equal(err.error.code, 'E_GH_CREATE');
  assert.match(err.error.message, /monalisa_acme\/my-app/, 'names the repo it tried to create');
  assert.match(err.error.message, /github\.com\/monalisa_acme/, 'names the account gh ran as');
  assert.match(err.error.message, /404/, 'explains what a 404 on that owner means');
});

// An ambient GH_TOKEN makes `gh auth status` report a nameless active account
// (login: "", tokenSource: GH_TOKEN). It can never own a repo.
test('nameless environment-token account never reaches the picker', () => {
  const hosts = {
    hosts: {
      'github.com': [
        { state: 'error', active: true, host: 'github.com', login: '', tokenSource: 'GH_TOKEN' },
        { state: 'success', active: false, host: 'github.com', login: 'octocat', gitProtocol: 'ssh' },
      ],
    },
  };
  // A login ghnew does not have: the E_AUTH message lists what *is* available,
  // which is where a nameless account would show up as a bare "github.com/".
  const r = runGhnew(
    ['--json', '--remote', 'github.com/nobody', 'my-app'],
    { GHNEW_TEST_HOSTS: JSON.stringify(hosts), GH_TOKEN: 'STALE' },
  );
  assert.equal(r.status, 2);
  const err = errJson(r.stderr);
  assert.equal(err.error.code, 'E_AUTH');
  assert.match(err.error.message, /github\.com\/octocat/);
  assert.doesNotMatch(
    err.error.message, /github\.com\/(,|\s|$)/,
    'the nameless GH_TOKEN account must not be offered as a choice',
  );
});

test('environment token alone is a named-account error, not "not logged in"', () => {
  const hosts = {
    hosts: {
      'github.com': [{ state: 'error', active: true, host: 'github.com', login: '', tokenSource: 'GH_TOKEN' }],
    },
  };
  const r = runGhnew(
    ['--json', '--remote', 'github.com/octocat', 'my-app'],
    { GHNEW_TEST_HOSTS: JSON.stringify(hosts), GH_TOKEN: 'STALE' },
  );
  assert.equal(r.status, 2);
  const err = errJson(r.stderr);
  assert.equal(err.error.code, 'E_AUTH');
  assert.match(err.error.message, /GH_TOKEN/, 'points at the environment token, not `gh auth login` alone');
});

// ── shell integration ────────────────────────────────────────────────────────
//
// ghnew used to hand back a `cd "…"` box and a clipboard prompt, which was a
// workaround for not being able to move the shell. It emits a function now, the
// same as ghqcd / gwqcd / gwqpull / gwqadd. A syntax check is not enough here:
// the first version of this in the sibling tools captured --help and fed it to
// `cd`, and `zsh -n` was perfectly happy with that.

const BIN_PATH = new URL('../bin/ghnew.mjs', import.meta.url).pathname;

function initFor(shell) {
  return spawnSync(process.execPath, [BIN_PATH, '--init', shell], {
    encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

for (const shell of ['zsh', 'bash', 'fish']) {
  test(`--init ${shell} emits a function with the three-step resolver`, () => {
    const r = initFor(shell);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ghnew/);
    assert.match(r.stdout, /--quiet/, 'the function must use the path channel');
    assert.match(r.stdout, /npx -y/, 'npx is the last-resort fallback');
    assert.ok(r.stdout.includes(BIN_PATH), 'the generating script is baked in');
  });

  test(`the ${shell} function passes --version and --help through`, (t) => {
    if (spawnSync(shell, ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip(`${shell} missing`);
    for (const flag of ['--version', '--help']) {
      const r = spawnSync(shell, ['-c', `${initFor(shell).stdout}\nghnew ${flag}`], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${flag}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /cd:|file name too long|no such file/,
        `${flag} must not be captured and handed to cd`);
    }
  });
}

test('--init rejects an unknown shell', () => {
  const r = initFor('tcsh');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /zsh \| bash \| fish/);
});

test('--cmd without --init is a validation error', () => {
  const r = spawnSync(process.execPath, [BIN_PATH, '--cmd', 'gn'], {
    encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only meaningful together with --init/);
});

test('--quiet no longer forbids prompting — only --json and a missing TTY do', () => {
  // It used to, and that made the shell integration impossible: `ghnew --quiet
  // foo` on a machine with several gh accounts died instead of asking. The
  // prompts write to stderr, so they never threatened the stdout contract.
  const src = readFileSync(BIN_PATH, 'utf8');
  assert.match(src, /const explicitNonInteractive = isJson;/,
    'isQuiet must not be an explicit non-interactive trigger');
  assert.match(src, /explicitNonInteractive \|\| fullySpecified \|\| !stdinTTY/,
    'no TTY must still forbid prompting');
});

test('the emitted snippet tells people to use `command`', () => {
  // `eval "$(<pkg> --init zsh)"` in ~/.zshrc resolves to the *function* on every
  // re-source after the first, and a stale function captures this very output
  // and hands it to cd. `command` skips functions. The header comment is the
  // line people copy, so it has to be the correct one.
  for (const shell of ['zsh', 'bash']) {
    const out = initFor(shell).stdout;
    assert.match(out, /eval "\$\(command ghnew --init (zsh|bash)\)"/,
      `${shell} header must recommend the command form`);
  }
  assert.match(initFor('fish').stdout, /command ghnew --init fish \| source/);
});

test('re-sourcing is idempotent even with a stale function defined', (t) => {
  if (spawnSync('zsh', ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip('zsh missing');
  const init = initFor('zsh').stdout;
  // A pre-`command` function: captures stdout and cds into it, whatever it is.
  const stale = `ghnew() { local d; d=$(echo stale) || return $?; builtin cd -- "$d"; }`;
  const script = [stale, init, 'ghnew --version'].join('\n');
  const r = spawnSync('zsh', ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ghnew \d+\.\d+\.\d+/m, 'the new function must have replaced the stale one');
  assert.doesNotMatch(r.stderr, /cd:|no such file/);
});
