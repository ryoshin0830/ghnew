# ghnew

[![npm](https://img.shields.io/npm/v/ghnew.svg)](https://www.npmjs.com/package/ghnew)
[![license](https://img.shields.io/npm/l/ghnew.svg)](LICENSE)
[![node](https://img.shields.io/node/v/ghnew.svg)](package.json)

Create a GitHub (or GHE) repo, `ghq get` it, and offer to copy the `cd`
command — in one shot. Keyboard-driven account selection, automatic
SSH/HTTPS protocol detection, stable JSON output for agent use.

```
┌ ghnew
│ creating private repo on github.com…
│ ✓ created alice/my-app
│ cloning via https…
│ ✓ cloned
└

╭─ next ──────────────────────────────────────────────╮
│                                                     │
│  cd "/Users/alice/projects/github.com/alice/my-app" │
│                                                     │
╰─────────────────────────────────────────────────────╯
   press c to copy · any other key to exit
```

## What it does

1. Reads every authenticated account from `gh auth status --json hosts`
   (GitHub.com + every GHE you're logged into).
2. You pick one with the arrow keys, **or** specify it non-interactively.
3. Runs `gh repo create <owner>/<name>` against the right host (via
   `GH_HOST` env, default `--private --add-readme`).
4. Runs `ghq get` with SSH or HTTPS automatically based on each host's
   `gitProtocol` setting.
5. Prints `cd "<path>"` in a box. Press `c` to copy it to your clipboard
   (`pbcopy` / `wl-copy` / `xclip` / OSC 52 over SSH-tmux).

## Prereqs

- [`gh`](https://cli.github.com/) `>= 2.40` (uses `gh auth status --json hosts`)
- [`ghq`](https://github.com/x-motemen/ghq)
- Node.js `>= 20.12`

If `gh` or `ghq` are missing, ghnew offers to `brew install` them. If you're
not logged into `gh`, it offers to launch `gh auth login`.

## Install

```sh
npm i -g ghnew
```

Or run without installing (slower on first run because npx cold-starts):

```sh
npx --yes ghnew my-new-app
```

## Use

### Interactive

```sh
ghnew                  # prompts for repo name and account
ghnew my-new-app       # prompts only for account (skipped if you have one)
```

### Non-interactive (`--remote` shorthand)

```sh
ghnew --remote github.com/alice my-app
ghnew --remote git.acme.com/bob --public --description "Demo" my-tool
```

`--remote HOST/LOGIN` is shorthand for `--host HOST --account LOGIN`.

### Flags

| Flag | Effect |
|---|---|
| `--public` | create a public repo (default: private) |
| `--internal` | create an org-internal repo |
| `--description <text>` | repo description (last value wins) |
| `--host <host>` | choose host non-interactively |
| `--account <login>` | choose account non-interactively |
| `--remote <host>/<login>` | shorthand for `--host` + `--account` |
| `--json` | stdout = 1-line JSON, no prompts, no keypress |
| `--quiet` | stdout = path only, no prompts, no keypress |
| `--no-copy-prompt` | skip the "press c to copy" phase |
| `--no-color` / `NO_COLOR` | disable ANSI colors |
| `-h, --help`, `-V, --version` | usage / version |

When `<name>`, `--host`, and `--account` are all provided, ghnew runs
**fully non-interactively** — no prompts, no keypress — so it's safe to
call from scripts and CI.

### Scripting

```sh
# Capture the local path:
path=$(ghnew --quiet --remote github.com/alice my-tool)
cd "$path"

# Or with --json + jq:
ghnew --json --remote github.com/alice my-tool | jq -r .path
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | validation / generic failure (`E_VALIDATION`, `E_GH_CREATE`, `E_GHQ_GET`) |
| 2 | gh not authenticated, or `--account` not in authenticated list (`E_AUTH`) |
| 127 | `gh` or `ghq` missing (`E_DEPS`) |
| 130 | interrupted via Ctrl-C (`E_INTERRUPTED`) |

In `--json` mode, errors are also reported as `{"schemaVersion":1,"error":{"code":"E_*","message":"…"},"exitCode":N}` on stderr.

## For AI agents

`ghnew` ships with a Claude Code skill that teaches an agent how to call
the CLI safely (non-interactive `--json` mode, default-to-private
visibility, error handling).

### Install the skill (recommended)

Use the [`skills`](https://www.npmjs.com/package/skills) CLI — it clones
the repo, discovers the bundled `SKILL.md`, and registers it for you:

```sh
npx skills add -y -g https://github.com/ryoshin0830/ghnew
```

- `-y` / `--yes`: skip the interactive agent picker (avoids a known bug
  in the picker when more than one target is detected).
- `-g` / `--global`: install into `~/.claude/skills/` so the skill is
  available in every session, not just the current project.

After installing, restart Claude Code once so the new skill directory is
registered. Subsequent edits to `SKILL.md` reload live.

If you want the skill **only inside a specific project**, omit `-g` and
run the command from that project's root — it will install under
`.claude/skills/` of the current directory.

### Manual install (no `skills` CLI)

If you'd rather not run the `skills` CLI, clone the repo and symlink:

```sh
ghq get https://github.com/ryoshin0830/ghnew
mkdir -p ~/.claude/skills
ln -s "$(ghq list -e -p github.com/ryoshin0830/ghnew)/.claude/skills/ghnew" \
      ~/.claude/skills/ghnew
```

### Recommended agent call

```sh
npx -y ghnew@^0.2 --json --remote <host>/<login> --description "..." <name>
```

Pin to `^0.2`, not `@latest`, so future major bumps don't silently break
the agent. The JSON output schema is documented in
`.claude/skills/ghnew/SKILL.md`.

## Security

- **No `preinstall` / `postinstall` scripts** in `package.json`. `npm install --ignore-scripts` works fine. (This package intentionally avoids the
  install-script vector used by the Shai-Hulud npm worm.)
- The runtime is plain ESM in [`bin/ghnew.mjs`](bin/ghnew.mjs). Single
  runtime dep: `@inquirer/prompts`.
- nvm users: `npm i -g ghnew` only installs into the currently active Node
  version. Pin with `.nvmrc` or reinstall after `nvm use`.

## Troubleshooting

- **"non-TTY stdin"** — you're piping into ghnew or running it under a
  process that doesn't allocate a TTY. Provide `--remote` and `<name>`, or
  add `--json` / `--quiet` to opt into the non-interactive contract.
- **`gh repo create` fails with "Name already exists"** — pick a different
  name. ghnew does not auto-suffix.
- **`ghq get` clones via HTTPS but you wanted SSH** — set the host's
  protocol with `gh config set git_protocol ssh --host <host>`, then
  re-run.
- **Cursor disappears after a Ctrl-C** — open a new shell or run
  `printf '\e[?25h'`. If you can reproduce, please open an issue.
- **Clipboard didn't work over SSH** — ghnew emits an OSC 52 escape that
  most modern terminal emulators understand; verify yours
  ([iTerm2](https://iterm2.com/), [WezTerm](https://wezfurlong.org/wezterm/),
  Alacritty, etc.) has clipboard-from-app enabled.

## Fallback

If the npm package is ever unavailable, run from GitHub:

```sh
npx --yes github:ryoshin0830/ghnew my-new-app
```

## License

MIT — see [LICENSE](LICENSE).
