# gh-pr-comments-channel

A [Claude Code channel plugin](https://code.claude.com/docs/en/channels-reference) that surfaces GitHub PR comments and CI check results directly into your Claude Code session.

When your current git branch is associated with a pull request, this channel:

- Pushes existing PR comments and inline code review comments as ambient context
- Polls for new comments every 30 seconds
- Monitors CI check statuses and surfaces failures with compressed logs
- Provides reply tools so Claude can respond to comments directly

All events are wrapped in XML tags (`<pr-comment-context>`, `<ci-check-context>`) that signal to Claude this is background information — it won't interrupt whatever task is currently in progress.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- **GitHub auth** — one of:
  - [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated (preferred)
  - `GITHUB_TOKEN` or `GH_TOKEN` environment variable set
- [rtk](https://github.com/rtk-ai/rtk) (optional) — compresses CI failure logs by 60-90%. Falls back to truncation if not installed.

The channel auto-detects your auth method. When `gh` CLI is available it uses `gh api` for all calls. Otherwise it falls back to polling the GitHub REST API directly with your token.

## Installation

```bash
claude plugin install mattapperson/gh-pr-comments-channel
```

Then start Claude Code with the channel enabled:

```bash
claude --channels plugin:github-pr@mattapperson/gh-pr-comments-channel
```

During the research preview, add `--dangerously-load-development-channels`.

Run `/github-pr:configure` to verify prerequisites and check the current channel status.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_MS` | `30000` | Polling interval in milliseconds (minimum 5000) |
| `GH_PR_CHANNEL_DEBUG` | `false` | Enable debug output to stderr |
| `GITHUB_TOKEN` | — | GitHub personal access token (fallback when `gh` CLI is not available) |
| `GH_TOKEN` | — | Alias for `GITHUB_TOKEN` |

## How It Works

### Startup

1. Resolves GitHub auth: tries `gh` CLI first, then `GITHUB_TOKEN`/`GH_TOKEN`, then `gh auth token`
2. Detects owner/repo (via `gh repo view` or git remote URL parsing)
3. Finds the PR for the current branch
4. Fetches all existing comments and CI check statuses (marked as initial load)
5. Starts polling for new activity

### PR Comments

Two types of comments are fetched:

- **PR-level comments** — from the conversation tab (`/issues/{pr}/comments`)
- **Inline review comments** — from the code review tab (`/pulls/{pr}/comments`), including file path, line numbers, and diff hunks

Events arrive as:

```xml
<pr-comment-context comment_id="123" author="reviewer" file_path="src/foo.ts" line="42">
  ## Code Review Comment by @reviewer
  **File:** `src/foo.ts` **Line:** 42

  > Consider using a type guard here.

  [View on GitHub](https://github.com/...)
</pr-comment-context>
```

### CI Checks

Check statuses are monitored for state transitions. Failed checks include compressed failure logs:

```xml
<ci-check-context check_name="typecheck" conclusion="failure" run_id="12345">
  ## CI Check Failed: typecheck
  **Status:** failure
  **URL:** https://github.com/.../actions/runs/12345

  ### Failure Logs
  [compressed log output]
</ci-check-context>
```

If `rtk` is installed, failure logs are compressed (60-90% smaller). Otherwise, raw logs are truncated to ~2000 characters with head and tail preserved.

### Reply Tools

Two tools are exposed for Claude to respond:

- **`reply_to_pr_comment`** — Posts a top-level comment on the PR conversation tab
- **`reply_to_review_comment`** — Replies to an inline code review comment thread (requires `comment_id` from the event meta)

## Behavior Notes

- **No PR for branch**: Pushes one info event and idles without polling
- **Merged/closed PR**: Detected on startup; polling continues at reduced frequency
- **Rate limiting**: Exponential backoff on HTTP 429, capped at 5 minutes
- **Edited comments**: The `since` parameter catches updates; seen-ID tracking prevents duplicates

## License

MIT
