import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { log } from '@jackwener/opencli/logger';
import { isRecord } from '@jackwener/opencli/utils';
import {
    classifyXueqiuAccessFailure,
    classifyStatusCommentsResponse,
    describeXueqiuAccessFailure,
    envelopeTextFromJson,
    fetchXueqiuEnvelope,
    getStatusCommentItems,
    normalizeIdentifier,
    statusUrl,
    stripTags,
    throwXueqiuAccessFailure,
    toFiniteCount,
    toIsoTimestamp,
} from './utils.js';

const XUEQIU_STATUS_URL_PATTERN = /^https?:\/\/(?:www\.)?xueqiu\.com\/(?:u\/)?(\d{1,15})\/(\d{1,15})\/?$/i;
const XUEQIU_STATUS_ID_PATTERN = /^\d{1,15}$/;
const COMMENT_PAGE_SIZE = 20;
const COMMENT_MAX_PAGES = 40;
const COMMENT_LIMIT_MAX = COMMENT_PAGE_SIZE * COMMENT_MAX_PAGES;

/**
 * Parse a status id or a post URL like `https://xueqiu.com/9089343523/99380989`.
 *
 * @param raw User-provided CLI argument.
 * @returns Numeric status id string.
 */
export function parseStatusInput(raw) {
    const input = String(raw ?? '').trim();
    if (!input)
        throw new ArgumentError('xueqiu post requires a status id or post URL');
    const urlMatch = input.match(XUEQIU_STATUS_URL_PATTERN);
    if (urlMatch)
        return urlMatch[2];
    if (/^https?:\/\//i.test(input)) {
        throw new ArgumentError(`xueqiu post received an unsupported URL: ${input} (expected https://xueqiu.com/<user_id>/<status_id>)`);
    }
    if (!XUEQIU_STATUS_ID_PATTERN.test(input)) {
        throw new ArgumentError(`xueqiu post received an invalid status id: ${input}`);
    }
    return input;
}

/**
 * Classify one status-detail response.
 *
 * @param response Structured browser response payload.
 * @returns Tagged result describing the response class.
 */
export function classifyStatusDetailResponse(response) {
    const jsonRecord = isRecord(response.json) ? response.json : null;
    const envelopeText = envelopeTextFromJson(jsonRecord);
    const accessFailure = classifyXueqiuAccessFailure(response, envelopeText);
    if (accessFailure)
        return accessFailure;
    if (jsonRecord && envelopeText && !normalizeIdentifier(jsonRecord.id)) {
        if (/页面不存在|status not found|does not exist|not found/.test(envelopeText)
            || jsonRecord.error_code === '20210') {
            return { kind: 'not-found' };
        }
        return { kind: 'incompatible' };
    }
    if (jsonRecord && normalizeIdentifier(jsonRecord.id)) {
        return { kind: 'ok' };
    }
    if (response.contentType.includes('application/json') && jsonRecord) {
        return { kind: 'incompatible' };
    }
    return { kind: 'unknown' };
}

/**
 * Parse the JSON assignment delivered with a normal post page. Never execute
 * page script text or accept the embedded repost as the requested post.
 */
export function parseStatusPageScript(script, statusId, userId) {
    const match = script.match(/^\s*window\.SNOWMAN_STATUS\s*=\s*(\{[\s\S]*\})\s*;\s*(?:window\.SNOWMAN_TARGET\s*=\s*window\.SNOWMAN_STATUS\.user\s*;\s*)?$/);
    if (!match)
        return null;
    try {
        const post = JSON.parse(match[1]);
        if (String(post.id) !== statusId
            || String(post.user_id ?? post.user?.id) !== userId
            || typeof post.text !== 'string' || !post.text.trim()) {
            return null;
        }
        // Only return public fields consumed by normalizeStatusDetail.
        return {
            id: post.id,
            user_id: post.user_id ?? post.user?.id,
            text: post.text,
            description: post.description,
            created_at: post.created_at,
            reply_count: post.reply_count,
            retweet_count: post.retweet_count,
            fav_count: post.fav_count,
            user: { screen_name: post.user?.screen_name },
        };
    } catch {
        return null;
    }
}

export async function readStatusPage(page, statusId, userId) {
    return page.evaluate(`
    (() => {
      const status = performance.getEntriesByType('navigation')[0]?.responseStatus || 200;
      if (status < 200 || status >= 300)
        return { status, contentType: 'text/plain', json: null, textSnippet: '' };
      const parse = ${parseStatusPageScript.toString()};
      const statusId = ${JSON.stringify(statusId)};
      const userId = ${JSON.stringify(userId)};
      const pathMatches = location.pathname === '/' + userId + '/' + statusId
        || location.pathname === '/' + userId + '/' + statusId + '/';
      const article = document.querySelector('.article__bd');
      if (pathMatches && article) {
        for (const script of document.scripts) {
          if (script.src) continue;
          const post = parse(script.textContent || '', statusId, userId);
          if (!post) continue;
          const body = document.createElement('template');
          body.innerHTML = post.text;
          const normalize = text => text.replace(/\\s/g, '');
          if (normalize(article.textContent).includes(normalize(body.content.textContent))) {
            return { status: 200, contentType: 'application/json', json: post, textSnippet: '' };
          }
        }
      }
      // Return fixed diagnostic strings, never page HTML or account state.
      const text = (document.title + ' ' + document.body.innerText).toLowerCase();
      const challenge = document.querySelector('#renderData')
        || /captcha|aliyun_waf|eo_bot_ssid|安全验证|访问验证/.test(text);
      if (challenge)
        return { status: 200, contentType: 'text/html', json: null, textSnippet: 'challenge' };
      if (/页面不存在|帖子已删除|status not found/.test(text))
        return { status: 200, contentType: 'application/json', json: { error_code: '20210', error_description: 'status not found' }, textSnippet: '' };
      if (/请先登录|登录已过期/.test(text))
        return { status: 401, contentType: 'text/plain', json: null, textSnippet: '' };
      return { status: 200, contentType: 'application/json', json: {}, textSnippet: '' };
    })()
  `);
}

/**
 * Normalize one raw status detail payload into the post output row.
 *
 * @param item Raw status object from the validated post page.
 * @returns Public post row (`type=post`).
 */
export function normalizeStatusDetail(item) {
    const id = normalizeIdentifier(item.id);
    const userId = normalizeIdentifier(item.user_id) || normalizeIdentifier(item.user?.id);
    const text = stripTags(item.text) || stripTags(item.description);
    return {
        type: 'post',
        id,
        parent_id: null,
        author: String(item.user?.screen_name ?? ''),
        text,
        reply_to: null,
        likes: toFiniteCount(item.fav_count),
        replies: toFiniteCount(item.reply_count),
        retweets: toFiniteCount(item.retweet_count),
        created_at: toIsoTimestamp(item.created_at),
        url: statusUrl(userId, id),
    };
}

/**
 * Normalize one raw comment item into the comment output row.
 *
 * @param item Raw comment object from `statuses/v3/comments.json`.
 * @param root Top-level comment containing this reply, if any.
 * @returns Public comment row (`type=comment`).
 */
export function normalizeCommentItem(item, root = null) {
    const id = normalizeIdentifier(item.id);
    const userId = normalizeIdentifier(item.user_id) || normalizeIdentifier(item.user?.id);
    const replyTo = String(item.reply_screenName
        ?? item.reply_user?.screen_name
        ?? item.reply_comment?.user?.screen_name
        ?? '').trim() || root?.author || null;
    return {
        type: 'comment',
        id,
        parent_id: root?.id ?? null,
        author: String(item.user?.screen_name ?? ''),
        text: stripTags(item.text),
        reply_to: replyTo,
        likes: toFiniteCount(item.like_count),
        replies: toFiniteCount(item.comment_reply_count ?? item.reply_count),
        retweets: 0,
        created_at: toIsoTimestamp(item.created_at),
        url: statusUrl(userId, id),
    };
}

function commentFailureReason(kind, response) {
    const accessReason = describeXueqiuAccessFailure(kind);
    if (accessReason)
        return accessReason;
    if (response.status === 0)
        return 'browser fetch failed before receiving an HTTP response';
    const mime = response.contentType.split(';', 1)[0].trim().toLowerCase();
    const reason = mime === 'text/html' ? 'unexpected HTML response' : 'unexpected response shape';
    return `${reason} (HTTP ${response.status}${mime ? `, ${mime}` : ''})`;
}

/**
 * Paginate through the top-level comments until the requested limit, exhaustion,
 * or a safety cap is reached.
 *
 * The site's public comment stream is a filtered subset of `reply_count`
 * (commonly capped around 150). Exhaustion is `next_max_id === -1` or an
 * empty page, not `reply_count`.
 *
 * @param options Pagination inputs and a page-fetch callback.
 * @returns Deduplicated raw comments and whether a failed request stopped pagination.
 */
export async function collectCommentRows(options) {
    const warn = options.warn ?? log.warn;
    const comments = [];
    const seenIds = new Set();
    let maxId = '-1';
    for (let requestNumber = 1; requestNumber <= options.maxPages; requestNumber += 1) {
        const response = await options.fetchPage(maxId, options.pageSize);
        const classified = classifyStatusCommentsResponse(response);
        if (classified.kind !== 'ok') {
            if (requestNumber === 1 && !describeXueqiuAccessFailure(classified.kind)) {
                throw new CommandExecutionError(`Unexpected response while loading xueqiu comments for post ${options.statusId}: ${commentFailureReason(classified.kind, response)}`);
            }
            warn(`xueqiu post ${options.statusId} comment pagination stopped after request ${requestNumber}, `
                + `collected ${comments.length}/${options.limit} items, `
                + `reason: ${commentFailureReason(classified.kind, response)}`);
            return { comments, interrupted: true };
        }
        const rawItems = getStatusCommentItems(response.json) ?? [];
        const previousCount = comments.length;
        for (const item of rawItems) {
            const id = normalizeIdentifier(item?.id);
            if (!id || seenIds.has(id))
                continue;
            seenIds.add(id);
            comments.push(item);
            if (comments.length >= options.limit)
                return { comments, interrupted: false };
        }
        if (rawItems.length === 0) {
            break;
        }
        const nextMaxId = normalizeIdentifier(response.json.next_max_id);
        if (!nextMaxId || nextMaxId === '-1' || nextMaxId === maxId) {
            break;
        }
        if (comments.length === previousCount) {
            warn(`xueqiu post comment pagination stopped after request ${requestNumber}, `
                + `collected ${comments.length}/${options.limit} items, `
                + `reason: pagination did not advance`);
            break;
        }
        maxId = nextMaxId;
        if (requestNumber === options.maxPages) {
            warn(`xueqiu post comment pagination stopped after request ${requestNumber}, `
                + `collected ${comments.length}/${options.limit} items, `
                + `reason: reached safety cap`);
        }
    }
    return { comments, interrupted: false };
}

export function getChildCommentItems(json, rootId) {
    const comments = getStatusCommentItems(json);
    if (!comments || comments.length === 0)
        return comments;
    const root = comments.find(item => normalizeIdentifier(item?.id) === rootId);
    return Array.isArray(root?.child_comments) ? root.child_comments : null;
}

function addCommentRows(byId, items, root) {
    for (const item of items) {
        const id = normalizeIdentifier(item?.id);
        if (id && !byId.has(id))
            byId.set(id, normalizeCommentItem(item, root));
    }
}

async function fetchThreadReplies(page, statusId, root) {
    const replies = new Map();
    const seenCursors = new Set();
    let cursor = '-1';
    do {
        seenCursors.add(cursor);
        const query = new URLSearchParams({ id: statusId, comment_id: root.id, type: '4', child_type: '2', max_id: cursor });
        const response = await fetchXueqiuEnvelope(page, `/statuses/v3/comments.json?${query}`);
        const { kind } = classifyStatusCommentsResponse(response);
        if (kind !== 'ok') {
            return { replies, failure: commentFailureReason(kind, response) };
        }
        const children = getChildCommentItems(response.json, root.id);
        if (children === null) {
            return { replies, failure: 'response did not include the requested comment thread' };
        }
        const previousCount = replies.size;
        addCommentRows(replies, children, root);
        const nextCursor = normalizeIdentifier(response.json.next_max_id);
        if (nextCursor === '-1')
            return { replies };
        if (!nextCursor || seenCursors.has(nextCursor) || replies.size === previousCount) {
            return { replies, failure: 'pagination did not advance' };
        }
        cursor = nextCursor;
    } while (true);
}

async function buildCommentRows(page, statusId, { comments, interrupted }) {
    const rows = [];
    const seenIds = new Set(comments.map(item => normalizeIdentifier(item.id)));
    let fetchRemainingReplies = !interrupted;
    for (const item of comments) {
        const row = normalizeCommentItem(item);
        rows.push(row);
        let replies = new Map();
        if (Array.isArray(item.child_comments))
            addCommentRows(replies, item.child_comments, row);
        if (fetchRemainingReplies && replies.size < row.replies) {
            const thread = await fetchThreadReplies(page, statusId, row);
            for (const [id, child] of replies) {
                if (!thread.replies.has(id))
                    thread.replies.set(id, child);
            }
            replies = thread.replies;
            if (thread.failure) {
                log.warn(`xueqiu post ${statusId} nested replies stopped at comment ${row.id}, `
                    + `collected ${replies.size}/${row.replies} replies in this thread, reason: ${thread.failure}`);
                fetchRemainingReplies = false;
            }
        }
        for (const [id, child] of replies) {
            if (seenIds.has(id))
                continue;
            seenIds.add(id);
            rows.push(child);
        }
    }
    return rows;
}

cli({
    site: 'xueqiu',
    name: 'post',
    access: 'read',
    description: '获取雪球帖子正文、评论和楼中楼回复（需 --user 作者 UID）',
    domain: 'xueqiu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        {
            name: 'status',
            positional: true,
            required: true,
            help: '帖子 status_id 或完整 URL；必须同时传 --user 作者 UID',
        },
        { name: 'user', required: true, help: '必填：作者数字 UID；传完整 URL 时也须提供，且须与 URL 中作者一致' },
        { name: 'comment_limit', type: 'int', default: COMMENT_LIMIT_MAX, help: `Top-level comments to return with their replies (max ${COMMENT_LIMIT_MAX}, 0 = post only)` },
        { name: 'timeout', type: 'int', default: 900, help: 'Maximum seconds for the overall command' },
    ],
    columns: ['type', 'id', 'parent_id', 'author', 'text', 'reply_to', 'likes', 'replies', 'retweets', 'created_at', 'url'],
    func: async (page, args) => {
        const statusId = parseStatusInput(args.status);
        const commentLimit = Number(args.comment_limit ?? COMMENT_LIMIT_MAX);
        if (!Number.isInteger(commentLimit) || commentLimit < 0) {
            throw new ArgumentError('xueqiu post requires --comment_limit to be a non-negative integer');
        }
        if (commentLimit > COMMENT_LIMIT_MAX) {
            throw new ArgumentError(`xueqiu post supports --comment_limit up to ${COMMENT_LIMIT_MAX}`);
        }
        const urlMatch = String(args.status).trim().match(XUEQIU_STATUS_URL_PATTERN);
        const pageUserId = String(args.user ?? '').trim();
        if (!XUEQIU_STATUS_ID_PATTERN.test(pageUserId)) {
            throw new ArgumentError('xueqiu post requires --user <user_id> (a numeric author user_id)');
        }
        if (urlMatch && pageUserId !== urlMatch[1]) {
            throw new ArgumentError('xueqiu post --user must match the author user_id in the post URL');
        }
        await page.goto(statusUrl(pageUserId, statusId));
        const detailResponse = await readStatusPage(page, statusId, pageUserId);
        const classified = classifyStatusDetailResponse(detailResponse);
        throwXueqiuAccessFailure(classified.kind, `Loading xueqiu post ${statusId} (post page)`);
        if (classified.kind === 'not-found') {
            throw new EmptyResultError(`xueqiu/post ${statusId}`, `xueqiu post ${statusId} does not exist`);
        }
        if (classified.kind !== 'ok') {
            throw new CommandExecutionError(`Unexpected response while loading xueqiu post ${statusId}`, 'Run the command again with --verbose to inspect the raw site response.');
        }
        const postRow = normalizeStatusDetail(detailResponse.json);
        if (!postRow.id) {
            throw new CommandExecutionError(`Unexpected response while loading xueqiu post ${statusId}`, 'Run the command again with --verbose to inspect the raw site response.');
        }
        if (commentLimit === 0) {
            return [postRow];
        }
        const collected = await collectCommentRows({
            statusId,
            limit: commentLimit,
            pageSize: Math.min(commentLimit, COMMENT_PAGE_SIZE),
            maxPages: COMMENT_MAX_PAGES,
            fetchPage: (maxId, pageSize) => fetchXueqiuEnvelope(page, `/statuses/v3/comments.json?id=${encodeURIComponent(statusId)}&type=4&size=${pageSize}&max_id=${encodeURIComponent(maxId)}`),
            warn: log.warn,
        });
        const comments = await buildCommentRows(page, statusId, collected);
        return [postRow, ...comments];
    },
});
