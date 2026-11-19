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
 * Normalize one raw status detail payload into the post output row.
 *
 * @param item Raw status object from `statuses/show.json`.
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
    description: '获取单条雪球帖子正文、评论和楼中楼回复',
    domain: 'xueqiu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        {
            name: 'status',
            positional: true,
            required: true,
            help: '帖子 status_id 或 URL(https://xueqiu.com/<user_id>/<status_id>)',
        },
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
        await page.goto('https://xueqiu.com');
        const detailResponse = await fetchXueqiuEnvelope(page, `/statuses/show.json?id=${encodeURIComponent(statusId)}`);
        const classified = classifyStatusDetailResponse(detailResponse);
        throwXueqiuAccessFailure(classified.kind, `Loading xueqiu post ${statusId}`);
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
