#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { input, select, confirm } from '@inquirer/prompts';

const HELP = `ghnew — create a GitHub repo and ghq-get it.

Usage:
  ghnew [repo-name]

Prereqs: gh (>=2.40), ghq, Node 20.12+.

After the repo is created and cloned, ghnew prints the local path and the
exact 'cd' command to run.
`;

const log = (msg) => process.stderr.write(msg + '\n');

function commandExists(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !(r.error && r.error.code === 'ENOENT');
}

function brewAvailable() {
  return spawnSync('brew', ['--version'], { stdio: 'ignore' }).status === 0;
}

async function ensureTool(cmd) {
  if (commandExists(cmd)) return;
  const urls = {
    gh: 'https://cli.github.com/manual/installation',
    ghq: 'https://github.com/x-motemen/ghq#installation',
  };
  if (brewAvailable()) {
    const ok = await confirm({
      message: `'${cmd}' not found. Install via 'brew install ${cmd}'?`,
      default: true,
    });
    if (!ok) {
      log(`Aborted. See ${urls[cmd]} for manual installation.`);
      process.exit(127);
    }
    const r = spawnSync('brew', ['install', cmd], { stdio: 'inherit' });
    if (r.status !== 0) {
      log(`brew install ${cmd} failed.`);
      process.exit(r.status ?? 1);
    }
  } else {
    log(`'${cmd}' not found in PATH and Homebrew is unavailable.`);
    log(`Install manually: ${urls[cmd]}`);
    process.exit(127);
  }
}

function readHosts() {
  const r = spawnSync('gh', ['auth', 'status', '--json', 'hosts'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout?.trim()) return [];
  try {
    const { hosts } = JSON.parse(r.stdout);
    return Object.entries(hosts ?? {}).flatMap(([host, arr]) =>
      arr.map(({ login, gitProtocol }) => ({ host, login, gitProtocol })),
    );
  } catch {
    return [];
  }
}

async function ensureGhLoggedIn() {
  let accounts = readHosts();
  if (accounts.length > 0) return accounts;

  const ok = await confirm({
    message: "gh is not logged in. Run 'gh auth login' now?",
    default: true,
  });
  if (!ok) {
    log('Aborted — please run `gh auth login` and try again.');
    process.exit(2);
  }
  const r = spawnSync('gh', ['auth', 'login'], { stdio: 'inherit' });
  if (r.status !== 0) {
    log('`gh auth login` did not complete successfully.');
    process.exit(r.status ?? 2);
  }
  accounts = readHosts();
  if (accounts.length === 0) {
    log('Still no authenticated accounts after login. Aborting.');
    process.exit(2);
  }
  return accounts;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write('ghnew 0.1.0\n');
    process.exit(0);
  }
  const positional = args.filter((a) => !a.startsWith('-'));
  return { name: positional[0] };
}

function buildCloneUrl({ host, login, gitProtocol }, name) {
  return gitProtocol === 'ssh'
    ? `git@${host}:${login}/${name}.git`
    : `https://${host}/${login}/${name}`;
}

async function main() {
  process.on('exit', () => process.stderr.write('\x1b[?25h'));

  const { name: argName } = parseArgs(process.argv);

  if (!process.stdin.isTTY) {
    if (!argName) {
      log('non-TTY detected; pass the repo name as an argument: `ghnew <name>`');
      process.exit(1);
    }
    log('non-TTY detected; interactive account selection unavailable. Aborting.');
    process.exit(1);
  }

  await ensureTool('gh');
  await ensureTool('ghq');

  const accounts = await ensureGhLoggedIn();

  const name =
    argName ??
    (await input({
      message: 'repository name:',
      validate: (v) => (v.trim() ? true : 'repository name is required'),
    })).trim();

  const account =
    accounts.length === 1
      ? accounts[0]
      : await select({
          message: 'account:',
          choices: accounts.map((a) => ({
            name: `${a.host} / ${a.login}  (${a.gitProtocol})`,
            value: a,
          })),
        });

  const createRes = spawnSync(
    'gh',
    ['repo', 'create', `${account.login}/${name}`, '--private', '--add-readme'],
    { env: { ...process.env, GH_HOST: account.host }, stdio: 'inherit' },
  );
  if (createRes.signal === 'SIGINT') process.exit(130);
  if (createRes.status !== 0) {
    log('gh repo create failed.');
    process.exit(createRes.status ?? 1);
  }

  const cloneUrl = buildCloneUrl(account, name);
  const getRes = spawnSync('ghq', ['get', cloneUrl], { stdio: 'inherit' });
  if (getRes.signal === 'SIGINT') process.exit(130);
  if (getRes.status !== 0) {
    log('ghq get failed. The repo was created on GitHub but not cloned locally.');
    log(`Retry manually: ghq get ${cloneUrl}`);
    process.exit(getRes.status ?? 1);
  }

  const listRes = spawnSync(
    'ghq',
    ['list', '-e', '-p', `${account.host}/${account.login}/${name}`],
    { encoding: 'utf8' },
  );
  const localPath = (listRes.stdout ?? '').trim().split('\n')[0];
  if (!localPath) {
    log('Could not resolve local path via `ghq list -e -p`.');
    process.exit(1);
  }

  console.log();
  console.log(`✓ ${account.host}/${account.login}/${name} created and cloned.`);
  console.log();
  console.log(`  cd ${localPath}`);
  console.log();
}

main().catch((err) => {
  if (err?.name === 'ExitPromptError') {
    process.exit(130);
  }
  log(String(err?.stack ?? err));
  process.exit(1);
});
