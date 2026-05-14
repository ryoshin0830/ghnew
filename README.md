# ghnew

Create a GitHub (or GHE) repo, `ghq get` it, and print the `cd` command for the new directory.

## What it does

1. Lists every account from `gh auth status --json hosts` (GitHub.com + any GHE you're logged into).
2. You pick one with the arrow keys.
3. Runs `gh repo create <owner>/<name> --private --add-readme` against the right host.
4. Runs `ghq get` with the right URL (SSH or HTTPS, auto-detected from your `gh` `gitProtocol` setting).
5. Prints `cd <path>` — copy-paste to move there.

## Prereqs

- [`gh`](https://cli.github.com/) `>= 2.40` (this tool uses `gh auth status --json hosts`)
- [`ghq`](https://github.com/x-motemen/ghq)
- Node.js `>= 20.12`

## Install

```sh
npm i -g ghnew
```

Or run without installing (slower because `npx` cold-starts):

```sh
npx --yes ghnew my-new-app
```

## Use

```sh
ghnew                  # prompts for repo name and account
ghnew my-new-app       # prompts only for account (skipped if you have only one)
```

If `gh` or `ghq` are missing, ghnew offers to `brew install` them. If you're not logged into `gh`, it offers to launch `gh auth login`.

Example output:

```
✓ github.com/ryoshin0830/my-new-app created and cloned.

  cd /Users/you/projects/github.com/ryoshin0830/my-new-app
```

Copy the `cd` line and run it.

## Security

- This package has **no `preinstall` / `postinstall` scripts** (the infection vector used by the Shai-Hulud npm worm). `npm install --ignore-scripts` works fine.
- Source is plain ESM under `bin/ghnew.mjs`. Read it.
- nvm users: `npm i -g ghnew` only installs into the currently active Node version. Pin with `.nvmrc` or reinstall after `nvm use`.

## Fallback

If the npm package is ever unavailable, run directly from GitHub:

```sh
npx --yes github:ryoshin0830/ghnew my-new-app
```

## License

MIT
