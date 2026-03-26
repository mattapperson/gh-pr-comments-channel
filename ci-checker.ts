import { $ } from 'zx';
import { z } from 'zod';
import { GhCheckListSchema } from './types.ts';
import type { PrInfo, CiCheckState } from './types.ts';
import type { GitHubClient } from './github-api.ts';

$.verbose = false;

const MAX_RAW_LOG_CHARS = 2_000;

//#region Check Fetching

const GhCheckRunListSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().catch(null),
      details_url: z.string().nullable().catch(null),
      completed_at: z.string().nullable().catch(null),
    }),
  ),
});

async function fetchCheckList(
  client: GitHubClient,
  pr: PrInfo,
): Promise<CiCheckState[]> {
  if (client.mode === 'gh-cli') {
    return fetchCheckListViaGh(pr);
  }
  return fetchCheckListViaApi(client, pr);
}

async function fetchCheckListViaGh(pr: PrInfo): Promise<CiCheckState[]> {
  try {
    const result =
      await $`gh pr checks ${pr.number} --json name,state,conclusion,detailsUrl,completedAt`;
    const raw = JSON.parse(result.stdout) as unknown;
    return GhCheckListSchema.parse(raw);
  } catch {
    return [];
  }
}

async function fetchCheckListViaApi(
  client: GitHubClient,
  pr: PrInfo,
): Promise<CiCheckState[]> {
  try {
    const raw = await client.get(
      `repos/${pr.owner}/${pr.repo}/commits/${pr.headRefName}/check-runs`,
    );
    const parsed = GhCheckRunListSchema.parse(raw);
    return parsed.check_runs.map(
      (run): CiCheckState => ({
        name: run.name,
        state: run.status,
        conclusion: run.conclusion,
        detailsUrl: run.details_url,
        completedAt: run.completed_at,
      }),
    );
  } catch {
    return [];
  }
}

//#endregion

//#region State Diffing

type CheckTransition = {
  check: CiCheckState;
  previousConclusion: string | null;
};

function diffCheckStateList(
  previous: Map<string, CiCheckState>,
  current: CiCheckState[],
): CheckTransition[] {
  const transitionList: CheckTransition[] = [];

  for (const check of current) {
    if (!check.conclusion) {
      continue;
    }

    const prev = previous.get(check.name);
    const prevConclusion = prev?.conclusion ?? null;

    if (prevConclusion !== check.conclusion) {
      transitionList.push({
        check,
        previousConclusion: prevConclusion,
      });
    }
  }

  return transitionList;
}

//#endregion

//#region Log Fetching

const FailedJobsSchema = z.object({
  jobs: z.array(
    z.object({
      name: z.string(),
      conclusion: z.string().nullable(),
      steps: z
        .array(
          z.object({
            name: z.string(),
            conclusion: z.string().nullable(),
            number: z.number(),
          }),
        )
        .default([]),
    }),
  ),
});

async function fetchFailureLogs(
  client: GitHubClient,
  pr: PrInfo,
  runId: string,
): Promise<string | null> {
  if (!runId) {
    return null;
  }

  try {
    if (client.mode === 'gh-cli') {
      return await fetchLogsViaGh(runId);
    }
    return await fetchLogsViaApi(client, pr, runId);
  } catch {
    return null;
  }
}

async function fetchLogsViaGh(runId: string): Promise<string> {
  const rtkAvailable = await isRtkAvailable();

  if (rtkAvailable) {
    const result = await $`gh run view ${runId} --log-failed | rtk read -`;
    return result.stdout.trim();
  }

  const result = await $`gh run view ${runId} --log-failed`;
  return truncateLogs(result.stdout.trim());
}

async function fetchLogsViaApi(
  client: GitHubClient,
  pr: PrInfo,
  runId: string,
): Promise<string> {
  const raw = await client.get(
    `repos/${pr.owner}/${pr.repo}/actions/runs/${runId}/jobs?filter=failed`,
  );
  const jobs = FailedJobsSchema.parse(raw);

  const failedSteps = jobs.jobs.flatMap((job) =>
    job.steps
      .filter((step) => step.conclusion === 'failure')
      .map((step) => `${job.name} > Step ${step.number}: ${step.name} (FAILED)`),
  );

  if (failedSteps.length === 0) {
    return 'No failed steps found in job details.';
  }

  return truncateLogs(failedSteps.join('\n'));
}

async function isRtkAvailable(): Promise<boolean> {
  try {
    await $`rtk --version`;
    return true;
  } catch {
    return false;
  }
}

function truncateLogs(raw: string): string {
  if (raw.length <= MAX_RAW_LOG_CHARS) {
    return raw;
  }

  const halfLimit = Math.floor(MAX_RAW_LOG_CHARS / 2);
  const head = raw.slice(0, halfLimit);
  const tail = raw.slice(-halfLimit);
  return `${head}\n\n... [truncated ${raw.length - MAX_RAW_LOG_CHARS} chars] ...\n\n${tail}`;
}

//#endregion

export { fetchCheckList, diffCheckStateList, fetchFailureLogs };
export type { CheckTransition };
