#!/usr/bin/env bun

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadEnv } from './env.ts';
import { createGitHubClient } from './github-api.ts';
import type { GitHubClient } from './github-api.ts';
import { detectPr } from './pr-detection.ts';
import { fetchAllCommentList } from './comment-fetcher.ts';
import { formatCommentContent, formatCiCheckContent } from './comment-formatter.ts';
import {
  fetchCheckList,
  diffCheckStateList,
  fetchFailureLogs,
} from './ci-checker.ts';
import type { PrInfo, CiCheckState } from './types.ts';

//#region Constants

const INSTRUCTIONS = `You are receiving GitHub PR activity from the pull request associated with
your current git branch. Events arrive in two forms:

- <pr-comment-context> — PR comments and inline code review comments
- <ci-check-context> — CI check pass/fail notifications with failure logs

These are ALL ambient context — do NOT interrupt your current task to act on
them. Finish what you are doing first, then consider whether action is needed.

Events with is_initial_load=true are existing state for background context.

For new PR comments (is_initial_load=false): when you have a natural pause,
review and decide if a response is warranted. Read the referenced file and
line range before responding. Use reply_to_review_comment for inline code
comments (provide the comment_id from the meta). Use reply_to_pr_comment
for general PR discussion.

For CI check failures: the logs have been compressed for readability. Use
them to understand what went wrong. You do not need to respond to these —
they are informational context that may help guide your current work.

Always be constructive and specific. Reference exact code when responding
to inline comments. Keep replies concise.`;

const REPLY_PR_COMMENT_TOOL = {
  name: 'reply_to_pr_comment',
  description: 'Post a comment on the PR conversation tab.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      body: {
        type: 'string' as const,
        description: 'Markdown body of the comment.',
      },
    },
    required: ['body'],
  },
};

const REPLY_REVIEW_COMMENT_TOOL = {
  name: 'reply_to_review_comment',
  description:
    'Reply to an inline code review comment thread on a specific file/line.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      comment_id: {
        type: 'string' as const,
        description: 'The ID of the review comment to reply to (from event meta).',
      },
      body: {
        type: 'string' as const,
        description: 'Markdown body of the reply.',
      },
    },
    required: ['comment_id', 'body'],
  },
};

const ReplyPrBodySchema = z.object({ body: z.string().min(1) });
const ReplyReviewBodySchema = z.object({
  comment_id: z.string().min(1),
  body: z.string().min(1),
});

//#endregion

//#region State

type ChannelState = {
  client: GitHubClient;
  pr: PrInfo;
  seenCommentIdSet: Set<number>;
  checkStateMap: Map<string, CiCheckState>;
  lastPollTimestamp: string | null;
  pollIntervalMs: number;
  pollTimerId: ReturnType<typeof setInterval> | null;
  backoffMultiplier: number;
};

//#endregion

//#region Server Setup

async function main(): Promise<void> {
  const env = loadEnv();

  const server = new Server(
    { name: 'gh-pr-comments', version: '0.1.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  const client = await createGitHubClient();

  if (!client) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    pushEvent(
      server,
      '<pr-comment-context is_initial_load="true">\nNo GitHub authentication found. Either install gh CLI (https://cli.github.com/) or set GITHUB_TOKEN.\n</pr-comment-context>',
      { is_initial_load: 'true' },
    );
    return;
  }

  currentClient = client;
  registerToolHandlers(server);

  const detection = await detectPr(client);

  if (!detection.found) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    pushEvent(
      server,
      `<pr-comment-context is_initial_load="true">\n${detection.reason}\n</pr-comment-context>`,
      { is_initial_load: 'true' },
    );
    return;
  }

  const state: ChannelState = {
    client,
    pr: detection.pr,
    seenCommentIdSet: new Set(),
    checkStateMap: new Map(),
    lastPollTimestamp: null,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    pollTimerId: null,
    backoffMultiplier: 1,
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);

  await loadInitialState(server, state);
  startPolling(server, state);
}

//#endregion

//#region Tool Handlers

let currentClient: GitHubClient | null = null;
let currentPr: PrInfo | null = null;

function registerToolHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [REPLY_PR_COMMENT_TOOL, REPLY_REVIEW_COMMENT_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'reply_to_pr_comment') {
      return handlePrReply(args);
    }
    if (name === 'reply_to_review_comment') {
      return handleReviewReply(args);
    }

    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function handlePrReply(
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  if (!currentClient || !currentPr) {
    return { content: [{ type: 'text', text: 'No PR detected.' }], isError: true };
  }

  const parsed = ReplyPrBodySchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Invalid input: ${parsed.error.message}` }], isError: true };
  }

  try {
    await currentClient.post(
      `repos/${currentPr.owner}/${currentPr.repo}/issues/${currentPr.number}/comments`,
      { body: parsed.data.body },
    );
    return { content: [{ type: 'text', text: 'Comment posted successfully.' }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Failed to post comment: ${message}` }], isError: true };
  }
}

async function handleReviewReply(
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  if (!currentClient || !currentPr) {
    return { content: [{ type: 'text', text: 'No PR detected.' }], isError: true };
  }

  const parsed = ReplyReviewBodySchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Invalid input: ${parsed.error.message}` }], isError: true };
  }

  try {
    await currentClient.post(
      `repos/${currentPr.owner}/${currentPr.repo}/pulls/${currentPr.number}/comments/${parsed.data.comment_id}/replies`,
      { body: parsed.data.body },
    );
    return { content: [{ type: 'text', text: 'Reply posted successfully.' }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Failed to post reply: ${message}` }], isError: true };
  }
}

//#endregion

//#region Initial Load

async function loadInitialState(
  server: Server,
  state: ChannelState,
): Promise<void> {
  currentPr = state.pr;

  const [commentList, checkList] = await Promise.all([
    fetchAllCommentList(state.client, state.pr),
    fetchCheckList(state.client, state.pr),
  ]);

  for (const comment of commentList) {
    state.seenCommentIdSet.add(comment.id);
    const { content, meta } = formatCommentContent(comment, true);
    pushEvent(server, content, meta);
  }

  for (const check of checkList) {
    state.checkStateMap.set(check.name, check);

    if (check.conclusion) {
      const logs =
        check.conclusion === 'failure'
          ? await fetchFailureLogs(state.client, state.pr, extractRunId(check.detailsUrl))
          : null;
      const { content, meta } = formatCiCheckContent(check, logs, true);
      pushEvent(server, content, meta);
    }
  }

  state.lastPollTimestamp = new Date().toISOString();
}

//#endregion

//#region Polling

function startPolling(server: Server, state: ChannelState): void {
  const poll = async (): Promise<void> => {
    try {
      await pollComments(server, state);
      await pollCiChecks(server, state);
      state.backoffMultiplier = 1;
    } catch {
      state.backoffMultiplier = Math.min(state.backoffMultiplier * 2, 10);
    }

    const nextInterval = state.pollIntervalMs * state.backoffMultiplier;
    state.pollTimerId = setTimeout(poll, nextInterval);
  };

  state.pollTimerId = setTimeout(poll, state.pollIntervalMs);
}

async function pollComments(server: Server, state: ChannelState): Promise<void> {
  const commentList = await fetchAllCommentList(
    state.client,
    state.pr,
    state.lastPollTimestamp ?? undefined,
  );

  for (const comment of commentList) {
    if (state.seenCommentIdSet.has(comment.id)) {
      continue;
    }
    state.seenCommentIdSet.add(comment.id);
    const { content, meta } = formatCommentContent(comment, false);
    pushEvent(server, content, meta);
  }

  state.lastPollTimestamp = new Date().toISOString();
}

async function pollCiChecks(server: Server, state: ChannelState): Promise<void> {
  const checkList = await fetchCheckList(state.client, state.pr);
  const transitionList = diffCheckStateList(state.checkStateMap, checkList);

  for (const { check } of transitionList) {
    const logs =
      check.conclusion === 'failure'
        ? await fetchFailureLogs(state.client, state.pr, extractRunId(check.detailsUrl))
        : null;
    const { content, meta } = formatCiCheckContent(check, logs, false);
    pushEvent(server, content, meta);
  }

  for (const check of checkList) {
    state.checkStateMap.set(check.name, check);
  }
}

//#endregion

//#region Helpers

function pushEvent(
  server: Server,
  content: string,
  meta: Record<string, string>,
): void {
  server.notification({
    method: 'notifications/claude/channel',
    params: { content, meta },
  });
}

function extractRunId(detailsUrl: string | null): string {
  if (!detailsUrl) {
    return '';
  }
  const match = /\/runs\/(\d+)/.exec(detailsUrl);
  return match?.[1] ?? '';
}

//#endregion

main().catch((error) => {
  process.stderr.write(`gh-pr-comments-channel fatal: ${String(error)}\n`);
  process.exit(1);
});
