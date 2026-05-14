---
name: ghnew
description: >
  Create a brand-new GitHub or GHE repository AND immediately clone it locally
  under ghq's root, returning the absolute local path. Use this skill only when
  the user explicitly wants to scaffold a new remote repo and start working in
  it — not for cloning existing repos, forking, listing, or deleting.
when_to_use: |
  Use when the user says one of (or equivalent intent):
    - "create a new repo / 新規リポ作って"
    - "scaffold a new project on github"
    - "make a github repo and clone it"
    - "start a new private repo and cd into it"
    - "GitHub で新しいリポを始めたい"
    - "空のリポを作って clone まで"

  Do NOT use this skill when the user wants any of:
    - cloning an existing repository (use `gh repo clone` or `ghq get` directly)
    - forking someone else's repo
    - listing / searching repos
    - deleting or archiving a repo
    - renaming or transferring ownership
allowed-tools: Bash
---

# ghnew — create a GitHub repo, ghq-get it, return the local path

`ghnew` wraps `gh repo create` + `ghq get` + path resolution into a single
non-interactive call when given the right flags. It has a stable JSON output
so agents can chain it.

## Prerequisites (verify before invoking)

Run these checks. If any fail, surface the issue to the user instead of
calling ghnew with bad inputs.

1. `gh --version` (must be `>= 2.40`; older versions lack
   `gh auth status --json hosts`).
2. `ghq --version`.
3. `node --version` (must be `>= 20.12`).

## Choose host and account first

```bash
gh auth status --json hosts | jq -c '
  .hosts | to_entries | map({
    host: .key,
    login: (.value[] | select(.active == true) | .login)
  })
'
```

- Exactly **one** entry → use it.
- **Multiple** entries → ask the user which one (do NOT guess).
- **Zero** entries → tell the user to run `gh auth login` first; do NOT
  invoke ghnew.

If `jq` is unavailable, parse the raw `gh auth status --json hosts` JSON
yourself.

## Visibility — default to private

Pass `--private` semantics by default (it is the default, no flag needed).
Pass `--public` or `--internal` **only** when the user explicitly says one of:

- "public", "open source", "OSS", "publish", "share publicly"
- "オープンソース", "公開リポで", "OSS として"
- "internal" (in the context of an org), "社内向け", "社内に公開"

Never infer "public" from project type or excitement. Ask if unsure.

## Recommended call

If `ghnew` is on PATH:

```bash
ghnew --json --host <host> --account <login> [--public] [--description "..."] <name>
```

Otherwise (pin to `^0.2`, NOT `@latest`, so future major bumps do not
silently break the agent flow):

```bash
npx -y ghnew@^0.2 --json --host <host> --account <login> [--public] [--description "..."] <name>
```

Use `--remote <host>/<login>` as a shorthand for `--host X --account Y`.

## Output (stdout, 1 line)

```json
{
  "schemaVersion": 1,
  "host":          "github.com",
  "login":         "alice",
  "name":          "my-app",
  "url":           "https://github.com/alice/my-app",
  "path":          "/Users/alice/projects/github.com/alice/my-app",
  "visibility":    "private"
}
```

Parse with `jq -r .path` and `cd` there to continue working. Tolerate
unknown fields — the schema allows additive growth.

## Errors (stderr, 1 line JSON, non-zero exit)

```json
{
  "schemaVersion": 1,
  "error":   { "code": "E_AUTH", "message": "gh not authenticated" },
  "exitCode": 2
}
```

| code            | exit | meaning                                                   |
|-----------------|------|-----------------------------------------------------------|
| `E_VALIDATION`  | 1    | flag conflict, missing positional, bad `--remote` format  |
| `E_AUTH`        | 2    | not logged in OR `--account` not in authenticated list    |
| `E_DEPS`        | 127  | `gh` or `ghq` missing                                     |
| `E_GH_CREATE`   | 1    | `gh repo create` failed (e.g. name already taken)         |
| `E_GHQ_GET`     | 1    | `ghq get` failed                                          |
| `E_INTERRUPTED` | 130  | Ctrl-C                                                    |

On `E_GH_CREATE` because of a duplicate name, tell the user — do NOT
auto-retry with a mutated name.

## Things the skill must NOT do

- Pass `--public` or `--internal` without explicit user consent.
- Pass `--no-copy-prompt`. This skill always uses `--json`, which already
  skips the keypress phase.
- Call ghnew in pretty mode and try to parse the box output. Always use
  `--json`.
- Chain a second `ghnew` automatically after a failure.

## After success

Tell the user the repo URL and (if useful) propose `cd "<path>"`. If the
agent harness can change cwd, do that. Otherwise hand off the path.
