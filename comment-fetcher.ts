import {
  GhIssueCommentListSchema,
  GhReviewCommentListSchema,
  CommentType,
} from './types.ts';
import type { PrInfo, NormalizedComment } from './types.ts';
import type { GitHubClient } from './github-api.ts';

async function fetchPrLevelCommentList(
  client: GitHubClient,
  pr: PrInfo,
  since?: string,
): Promise<NormalizedComment[]> {
  const params = since ? `?since=${since}` : '';
  const path = `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments${params}`;

  try {
    const raw = await client.get(path);
    const commentList = GhIssueCommentListSchema.parse(raw);

    return commentList.map(
      (c): NormalizedComment => ({
        id: c.id,
        type: CommentType.PrLevel,
        author: c.user.login,
        body: c.body,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        htmlUrl: c.html_url,
        filePath: null,
        line: null,
        startLine: null,
        side: null,
        diffHunk: null,
        inReplyToId: null,
        reviewId: null,
      }),
    );
  } catch {
    return [];
  }
}

async function fetchReviewCommentList(
  client: GitHubClient,
  pr: PrInfo,
  since?: string,
): Promise<NormalizedComment[]> {
  const params = since ? `?since=${since}` : '';
  const path = `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments${params}`;

  try {
    const raw = await client.get(path);
    const commentList = GhReviewCommentListSchema.parse(raw);

    return commentList.map(
      (c): NormalizedComment => ({
        id: c.id,
        type: CommentType.InlineReview,
        author: c.user.login,
        body: c.body,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        htmlUrl: c.html_url,
        filePath: c.path,
        line: c.line ?? c.original_line,
        startLine: c.start_line ?? c.original_start_line,
        side: c.side,
        diffHunk: c.diff_hunk,
        inReplyToId: c.in_reply_to_id,
        reviewId: c.pull_request_review_id,
      }),
    );
  } catch {
    return [];
  }
}

async function fetchAllCommentList(
  client: GitHubClient,
  pr: PrInfo,
  since?: string,
): Promise<NormalizedComment[]> {
  const [prCommentList, reviewCommentList] = await Promise.all([
    fetchPrLevelCommentList(client, pr, since),
    fetchReviewCommentList(client, pr, since),
  ]);

  const all = [...prCommentList, ...reviewCommentList];
  all.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  return all;
}

export { fetchAllCommentList };
