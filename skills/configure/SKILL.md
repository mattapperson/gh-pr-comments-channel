---
name: "github-pr:configure"
description: "This skill should be used when the user wants to verify prerequisites, check authentication status, or troubleshoot the GitHub PR channel plugin. Triggers on: /github-pr:configure, 'check github pr channel', 'configure pr channel', 'why isn't the pr channel working'."
---

# GitHub PR Channel Configuration

Verify prerequisites and display the current status of the GitHub PR channel plugin. This plugin surfaces PR comments, inline code reviews, and CI check results as ambient context in Claude Code sessions.

## Procedure

Run each check below in order. Collect all results, then print a single summary table at the end.

### 1. GitHub Authentication

The channel supports two auth modes. Check in priority order:

**Check gh CLI (preferred):**

```bash
gh --version
```

If available, verify authentication:

```bash
gh auth status
```

If `gh` is installed and authenticated, record: `gh CLI — authenticated (preferred mode)`.

**Check token fallback:**

If `gh` is unavailable or unauthenticated, check for a token:

```bash
echo "${GITHUB_TOKEN:-${GH_TOKEN:-NOT_SET}}"
```

If a token is set, record: `GITHUB_TOKEN — configured (fallback mode)`.

If neither auth method is available, record a failure and provide remediation:

- Install GitHub CLI: https://cli.github.com/ then run `gh auth login`
- Or set `GITHUB_TOKEN` environment variable in the MCP server config

### 2. rtk (Optional)

```bash
rtk --version
```

If available, record: `rtk — installed (CI logs will be compressed)`.

If unavailable, record: `rtk — not installed (CI logs will be truncated to ~2000 chars). Install for 60-90% token savings: brew install rtk`

### 3. Current Branch PR

Detect the PR for the current branch. Use `gh` if available, otherwise parse git remote and query the API.

With gh CLI:

```bash
gh pr view --json number,title,url,state
```

Without gh CLI (token mode), determine owner/repo from git remote:

```bash
git remote get-url origin
```

Then query `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open`.

If a PR is found, record its number, title, state, and URL.

If no PR is found, record: `No PR found for current branch. The channel will idle until a PR exists.`

### 4. Summary

Print results as a status table:

```
GitHub PR Channel Status
========================
Auth:   [pass/fail] — [mode details]
rtk:    [pass/skip] — [status]
PR:     [found/none] — [PR #number: title (state)]

Next steps: [any remediation needed, or "All prerequisites met."]
```
