import { $ } from 'zx';
import { PrInfoSchema, RepoInfoSchema } from './types.ts';
import type { PrInfo } from './types.ts';
import type { GitHubClient } from './github-api.ts';

$.verbose = false;

//#region Types

type DetectResult =
  | { found: true; pr: PrInfo }
  | { found: false; reason: string };

//#endregion

//#region PR Detection

async function detectPr(client: GitHubClient): Promise<DetectResult> {
  const repoResult = await detectRepo(client);
  if (!repoResult.ok) {
    return { found: false, reason: repoResult.reason };
  }

  const { owner, repo } = repoResult;
  const branch = await getCurrentBranch();
  if (!branch) {
    return { found: false, reason: 'Could not detect current git branch.' };
  }

  const prResult = await findPrForBranch(client, owner, repo, branch);
  if (!prResult.ok) {
    return { found: false, reason: prResult.reason };
  }

  return {
    found: true,
    pr: { ...prResult.data, owner, repo },
  };
}

//#endregion

//#region Repo Detection

async function detectRepo(
  client: GitHubClient,
): Promise<{ ok: true; owner: string; repo: string } | { ok: false; reason: string }> {
  if (client.mode === 'gh-cli') {
    return detectRepoViaGh();
  }
  return detectRepoViaGitRemote();
}

async function detectRepoViaGh(): Promise<
  { ok: true; owner: string; repo: string } | { ok: false; reason: string }
> {
  try {
    const result = await $`gh repo view --json owner,name`;
    const parsed = RepoInfoSchema.parse(JSON.parse(result.stdout));
    return { ok: true, owner: parsed.owner.login, repo: parsed.name };
  } catch {
    return {
      ok: false,
      reason: 'Could not detect repository. Ensure you are in a GitHub repo with a remote.',
    };
  }
}

async function detectRepoViaGitRemote(): Promise<
  { ok: true; owner: string; repo: string } | { ok: false; reason: string }
> {
  try {
    const result = await $`git remote get-url origin`;
    const url = result.stdout.trim();
    const parsed = parseGitHubRemoteUrl(url);
    if (!parsed) {
      return { ok: false, reason: `Could not parse GitHub owner/repo from remote: ${url}` };
    }
    return { ok: true, ...parsed };
  } catch {
    return {
      ok: false,
      reason: 'Could not detect repository. Ensure you are in a git repo with an origin remote.',
    };
  }
}

function parseGitHubRemoteUrl(url: string): { owner: string; repo: string } | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = /github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  return null;
}

//#endregion

//#region Branch + PR Lookup

async function getCurrentBranch(): Promise<string | null> {
  try {
    const result = await $`git rev-parse --abbrev-ref HEAD`;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function findPrForBranch(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ ok: true; data: Omit<PrInfo, 'owner' | 'repo'> } | { ok: false; reason: string }> {
  if (client.mode === 'gh-cli') {
    return findPrViaGh();
  }
  return findPrViaApi(client, owner, repo, branch);
}

async function findPrViaGh(): Promise<
  { ok: true; data: Omit<PrInfo, 'owner' | 'repo'> } | { ok: false; reason: string }
> {
  try {
    const result =
      await $`gh pr view --json number,title,url,headRefName,baseRefName,author,state`;
    const parsed = PrInfoSchema.parse(JSON.parse(result.stdout));
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, reason: 'No pull request found for the current branch.' };
  }
}

async function findPrViaApi(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ ok: true; data: Omit<PrInfo, 'owner' | 'repo'> } | { ok: false; reason: string }> {
  try {
    const raw = await client.get(
      `repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
    );
    const prList = Array.isArray(raw) ? raw : [];
    if (prList.length === 0) {
      return { ok: false, reason: 'No pull request found for the current branch.' };
    }

    const pr = prList[0];
    const parsed = PrInfoSchema.parse({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      headRefName: pr.head?.ref,
      baseRefName: pr.base?.ref,
      author: pr.user,
      state: pr.state,
    });
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, reason: 'No pull request found for the current branch.' };
  }
}

//#endregion

export { detectPr };
export type { DetectResult };
