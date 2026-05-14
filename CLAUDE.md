# CLAUDE.md

Guidance for any AI agent (Claude Code, Codex, opencode, etc.) that works **inside** this repository.

This file is for **maintainers of `ghnew`**. If you want to USE ghnew from an agent
session, see `.claude/skills/ghnew/SKILL.md` and the "For AI agents" section of
`README.md` instead.

---

## What this package does

A small Node.js CLI (~300 lines) that:

1. Reads `gh auth status --json hosts` for the list of authenticated GitHub /
   GHE accounts.
2. Picks one (prompt, single account, or `--host`/`--account`/`--remote` flag).
3. Runs `gh repo create <login>/<name> --<visibility> --add-readme [--description …]`.
4. Runs `ghq get <url>` where the URL uses HTTPS or SSH based on each
   host's `gitProtocol` setting.
5. Resolves the cloned path via `ghq list -e -p <host>/<login>/<name>`.
6. Prints a `cd "<path>"` line in a box (default) — or JSON (`--json`) — or
   raw path (`--quiet`).
7. In default mode, waits for one keypress: `c`/`C` copies the `cd "…"`
   command to the clipboard, anything else exits.

Single source of behavior: `bin/ghnew.mjs`. Single runtime dep:
`@inquirer/prompts`.

---

## Invariants (do not break)

### I1. stdout / stderr discipline

- **stdout** is for machine-readable output **only**: `--json` payload,
  `--quiet` path, `--help`/`--version` body.
- **stderr** is for everything else: progress logs, the `cd` box, the
  keypress prompt, ANSI cursor restore, every error message.
- `ghnew foo > out.txt` MUST leave the human-facing box on the terminal
  and `out.txt` empty.

### I2. `--json` schema (external contract)

Stable fields, never delete or rename:

```json
{
  "schemaVersion": 1,
  "host":          "<github-or-ghe-host>",
  "login":         "<account-login>",
  "name":          "<repo-name>",
  "url":           "https://<host>/<login>/<name>",
  "path":          "<absolute-local-path>",
  "visibility":    "private" | "public" | "internal"
}
```

Error JSON (stderr, exit ≠ 0):

```json
{
  "schemaVersion": 1,
  "error":   { "code": "E_*", "message": "…" },
  "exitCode": <number>
}
```

Adding new fields is fine. Removing or renaming requires a `schemaVersion` bump.

### I3. Exit codes

| Code | Constant         | Meaning                                              |
|------|------------------|------------------------------------------------------|
| 0    | —                | success                                              |
| 1    | `E_VALIDATION`   | flag conflict, missing positional, parseArgs error   |
| 1    | `E_GH_CREATE`    | `gh repo create` failed                              |
| 1    | `E_GHQ_GET`      | `ghq get` failed or path not resolvable              |
| 2    | `E_AUTH`         | not logged in, or `--account` not in auth'd list     |
| 127  | `E_DEPS`         | `gh`/`ghq` missing and user declined install         |
| 130  | `E_INTERRUPTED`  | Ctrl-C / SIGINT                                      |

### I4. Subprocess stdio

All child processes (`gh`, `ghq`, `brew`) use `stdio: 'inherit'` in pretty
mode so their TTY-aware output lands on the user's terminal. In `--json` and
`--quiet` modes child stdout is silenced (`'ignore'`) and only stderr
inherits — so subprocess noise never contaminates our stdout contract.

### I5. Non-interactive determination

`isNonInteractive` is decided once at startup and gates every `@inquirer`
prompt afterward. Triggers:

- `--json` or `--quiet`
- `name + host + account` all provided
- `process.stdin.isTTY` is falsy

If any of those is true, the code path MUST NOT call `confirm`/`input`/
`select`. Each prompt site has a non-interactive branch that `die()`s with
the right `E_*` code instead.

### I6. Raw mode cleanup

`process.stdin.setRawMode(true)` is guarded by both `stdin.isTTY` and
`stdout.isTTY`. Cleanup runs on `exit`, `SIGTERM`, `SIGHUP`,
`uncaughtException`, and inside `try/finally`. Cursor restore (`\x1b[?25h`)
is guarded by `stderr.isTTY` to prevent escape bytes leaking into files.

### I7. Engines

`engines.node >= 20.12.0` because we depend on `node:util` `parseArgs` and
`@inquirer/prompts` v7. Do not lower.

---

## Do NOT

- Add `preinstall` / `postinstall` scripts to `package.json` (Shai-Hulud
  worm infection vector). `npm install --ignore-scripts` must work.
- Remove `.claude/` or `CLAUDE.md` from `.npmignore`. Those files are for
  agents and maintainers, not end users; bundling them inflates the tarball
  and widens the typosquat blast radius.
- Replace the `--json` schema fields without bumping `schemaVersion`.
- Add external runtime deps lightly. The only dep is `@inquirer/prompts`.
- Use `console.log` for human output. Use `stderr.write(...)`. `console.log`
  goes to stdout and violates I1.
- Skip the TTY guard before `setRawMode`. It throws on non-TTY streams.

---

## Release workflow

```sh
# 1. Make changes, commit them.
git add -A && git commit -m "feat: …"

# 2. Verify the tarball contents (must not include .claude/, CLAUDE.md, .git, node_modules):
npm pack --dry-run

# 3. Bump version (also tags and commits):
npm version patch     # 0.x.y → 0.x.(y+1)   bug fix
npm version minor     # 0.x.y → 0.(x+1).0   feature
npm version major     # only meaningful from 1.0.0 onwards

# 4. Push commit + tag, then publish:
git push --follow-tags
npm publish           # prompts for passkey/OTP via the npm web auth flow

# 5. Verify:
npm view ghnew version
npx -y ghnew@latest --version
```

The `prepublishOnly` script runs `npm pack --dry-run && node bin/ghnew.mjs --help`
to catch broken shebangs and missing files before they hit the registry.

---

## Manual test matrix

After non-trivial changes, run these against the local `npm link`'d binary:

| Scenario                     | Command                                                        | Expect                                   |
|------------------------------|----------------------------------------------------------------|------------------------------------------|
| Help                         | `ghnew --help`                                                 | flags table, exit codes, exit 0          |
| Version                      | `ghnew --version`                                              | `ghnew <version>`, exit 0                |
| Stdout separation            | `ghnew --remote github.com/<you> --json foo > out.txt`          | `out.txt` = JSON 1 line                  |
| Stdout separation, pretty    | `ghnew foo > out.txt`                                          | `out.txt` empty, box on terminal         |
| Validation error             | `ghnew --json` (no args)                                       | stderr = error JSON, exit 1              |
| `--remote` shorthand         | `ghnew --remote github.com/<you> --json foo`                   | JSON with correct host/login             |
| `--quiet`                    | `p=$(ghnew --quiet --remote …/… foo); cd "$p"`                 | cd works                                 |
| Visibility                   | `ghnew --public --description "…" foo`                         | repo created public with description     |
| Conflict                     | `ghnew --public --internal foo`                                | E_VALIDATION, exit 1                     |
| `NO_COLOR=1`                 | `NO_COLOR=1 ghnew --help`                                      | no ANSI escapes                          |
| `NO_COLOR=` (empty)          | `NO_COLOR= ghnew --help`                                       | ANSI escapes present (spec)              |
| Keypress copy                | `ghnew foo`, press `c`                                         | clipboard contains `cd "<path>"` no `\n` |
| Keypress dismiss             | `ghnew foo`, press space                                       | exits 0, nothing in clipboard            |
| Ctrl-C during keypress       | `ghnew foo`, Ctrl-C                                            | exit 130, cursor restored                |
| Bare `npm pack --dry-run`    | inside the repo                                                | no `.claude/`, `CLAUDE.md`, `.git/`      |

---

## Where things live

- `bin/ghnew.mjs` — the entire CLI (~300 lines, ESM, top-level await OK).
- `package.json` — `bin.ghnew`, `engines.node`, `files`, `scripts.prepublishOnly`.
- `.npmignore` — defense-in-depth complement to `files`.
- `.claude/skills/ghnew/SKILL.md` — agent USE contract. Bumping this is a
  user-visible interface change; document it in the commit.
- `README.md` — end-user docs.

No tests under `__tests__/` yet; the test plan above is the contract. If
adding tests, prefer `node:test` (zero new deps).

---

## Things that are intentionally NOT here

- **Subcommands.** `ghnew` stays flat. If `ghnew clone <url>` or
  `ghnew delete <repo>` ever ships, it goes in a new entrypoint, not by
  rewriting this CLI's positional handling.
- **A logger library** (pino, winston, debug, etc.). The two output helpers
  (`log`, `logErr`) are intentional; please don't replace them with a
  dependency.
- **A clipboard package** (clipboardy, etc.). The dispatcher is ~15 lines
  and handles macOS, Wayland, X11, plus OSC 52 for tmux/SSH.
- **Telemetry / analytics.**
