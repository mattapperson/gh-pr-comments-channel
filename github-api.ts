import { $ } from 'zx';

$.verbose = false;

//#region Types

type GitHubClient = {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  mode: 'gh-cli' | 'token';
};

//#endregion

//#region Token Resolution

async function resolveToken(): Promise<string | null> {
  const envToken = process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'];
  if (envToken) {
    return envToken;
  }

  try {
    const result = await $`gh auth token`;
    const token = result.stdout.trim();
    if (token) {
      return token;
    }
  } catch {
    // gh not available or not authenticated
  }

  return null;
}

async function isGhCliAvailable(): Promise<boolean> {
  try {
    await $`gh --version`;
    return true;
  } catch {
    return false;
  }
}

//#endregion

//#region gh CLI Client

function createGhCliClient(): GitHubClient {
  return {
    mode: 'gh-cli',
    async get(path: string): Promise<unknown> {
      const result = await $`gh api ${path} --paginate`;
      return JSON.parse(result.stdout) as unknown;
    },
    async post(path: string, body: Record<string, unknown>): Promise<unknown> {
      const args = Object.entries(body).flatMap(([k, v]) => ['-f', `${k}=${String(v)}`]);
      const result = await $`gh api ${path} ${args}`;
      return JSON.parse(result.stdout) as unknown;
    },
  };
}

//#endregion

//#region Fetch Client

function createFetchClient(token: string): GitHubClient {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  return {
    mode: 'token',
    async get(path: string): Promise<unknown> {
      const allItems: unknown[] = [];
      let url: string | null = `https://api.github.com/${path}`;

      while (url) {
        const response = await fetch(url, { headers });
        if (!response.ok) {
          throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        if (Array.isArray(data)) {
          allItems.push(...data);
        } else {
          return data;
        }

        url = parseLinkNext(response.headers.get('link'));
      }

      return allItems;
    },
    async post(path: string, body: Record<string, unknown>): Promise<unknown> {
      const response = await fetch(`https://api.github.com/${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
      }
      return response.json();
    },
  };
}

function parseLinkNext(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return match?.[1] ?? null;
}

//#endregion

//#region Factory

async function createGitHubClient(): Promise<GitHubClient | null> {
  const ghAvailable = await isGhCliAvailable();
  if (ghAvailable) {
    return createGhCliClient();
  }

  const token = await resolveToken();
  if (token) {
    return createFetchClient(token);
  }

  return null;
}

//#endregion

export { createGitHubClient, isGhCliAvailable };
export type { GitHubClient };
