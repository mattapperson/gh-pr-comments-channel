# /github-pr:configure

Verify prerequisites and show the current channel status for the GitHub PR channel.

## Steps

1. **Check GitHub authentication**

   First check for `gh` CLI:
   - Run `gh --version`. If available, run `gh auth status` to verify authentication.
   - If `gh` is authenticated, note: `gh CLI is available and authenticated (preferred mode).`

   If `gh` is not available or not authenticated, check for token:
   - Check if `GITHUB_TOKEN` or `GH_TOKEN` environment variable is set.
   - If set, note: `Using GITHUB_TOKEN for API access.`

   If neither is available:
   > No GitHub authentication found. Either:
   > - Install and authenticate the GitHub CLI: https://cli.github.com/
   > - Set the GITHUB_TOKEN environment variable

2. **Check `rtk` (optional)**

   Run `rtk --version`. If it fails, note:
   > `rtk` is not installed (optional). CI failure logs will be truncated instead of compressed. Install for 60-90% token savings: `brew install rtk`

   If it succeeds, note:
   > `rtk` is installed. CI failure logs will be compressed automatically.

3. **Check current branch PR**

   Run `gh pr view --json number,title,url,state` (or use GitHub API if only token is available). If no PR:
   > No pull request found for the current branch. The channel will idle until a PR is created.

   If PR found, display the PR number, title, state, and URL.

4. **Summary**

   Print a summary of all checks with pass/fail status and any next steps.
