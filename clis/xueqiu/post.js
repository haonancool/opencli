import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { log } from '@jackwener/opencli/logger';
import { isRecord } from '@jackwener/opencli/utils';
import {
    classifyBrowserAuthFailure,
    classifyStatusCommentsResponse,
    envelopeTextFromJson,
    fetchXueqiuEnvelope,
    getStatusCommentItems,
    normalizeIdentifier,
    statusUrl,
    stripTags,
    toFiniteCount,
    toIsoTimestamp,
} from './utils.js';

const XUEQIU_STATUS_URL_PATTERN = /^https?:\/\/(?:www\.)?xueqiu\.com\/(?:u\/)?(\d{1,15})\/(\d{1,15})\/?$/i;
const XUEQIU_STATUS_ID_PATTERN = /^\d{1,15}$/;
const COMMENT_PAGE_SIZE = 20;
const COMMENT_MAX_PAGES = 40;
const COMMENT_LIMIT_MAX = COMMENT_PAGE_SIZE * COMMENT_MAX_PAGES;
const CHILD_COMMENT_MAX_PAGES = 20;
// Back-to-back comment requests trip xueqiu's EO_Bot_Ssid JS challenge within a few pages.
const COMMENT_REQUEST_DELAY_MS = 600;
const COMMENT_MAX_RECOVERIES = 5;

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
    const authFailure = classifyBrowserAuthFailure(response, envelopeText);
    if (authFailure)
        return authFailure;
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
 * @param root Root comment `{ id, author }` when `item` is a nested reply.
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
        parent_id: root?.id || null,
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

/**
 * Extract the nested replies of one root comment from a `child_type=2` page.
 *
 * The child endpoint echoes the root comment in `comments[]` and pages its
 * replies through that root's `child_comments`.
 *
 * @param json Raw parsed JSON payload from browser fetch.
 * @param commentId Root comment id the page was requested for.
 * @returns Child comment items when the response shape is usable, otherwise null.
 */
export function getChildCommentItems(json, commentId) {
    const comments = getStatusCommentItems(json);
    if (!comments)
        return null;
    const root = comments.find(item => normalizeIdentifier(item?.id) === commentId) ?? comments[0];
    if (!root)
        return [];
    return Array.isArray(root.child_comments) ? root.child_comments : [];
}

function commentFailureReason(kind) {
    if (kind === 'auth' || kind === 'anti-bot')
        return 'auth failure';
    if (kind === 'unknown')
        return 'unknown request failure';
    return 'unexpected response shape';
}

function delay(ms) {
    return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Load every nested reply under one root comment.
 *
 * Uses the embedded `child_comments` preview when it already covers
 * `comment_reply_count`, otherwise paginates the `child_type=2` endpoint.
 *
 * @returns `{ items }` on success or `{ items, failure }` when a page failed.
 */
async function collectChildItems(rootItem, rootId, options, request) {
    const expected = toFiniteCount(rootItem.comment_reply_count);
    if (expected <= 0)
        return { items: [] };
    const preview = Array.isArray(rootItem.child_comments) ? rootItem.child_comments : [];
    if (preview.length >= expected || !options.fetchChildPage)
        return { items: preview };
    const items = [];
    const seenIds = new Set();
    let maxId = -1;
    for (let pageNumber = 1; pageNumber <= options.childMaxPages; pageNumber += 1) {
        const response = await request(() => options.fetchChildPage(rootId, maxId, options.pageSize));
        const classified = classifyStatusCommentsResponse(response);
        const childItems = classified.kind === 'ok' ? getChildCommentItems(response.json, rootId) : null;
        if (!childItems)
            return { items, failure: classified.kind === 'ok' ? 'incompatible' : classified.kind };
        let advanced = false;
        for (const item of childItems) {
            const id = normalizeIdentifier(item?.id);
            if (!id || seenIds.has(id))
                continue;
            seenIds.add(id);
            items.push(item);
            advanced = true;
        }
        const nextMaxId = isRecord(response.json) ? response.json.next_max_id : null;
        if (!advanced || nextMaxId == null || nextMaxId === -1 || nextMaxId === maxId)
            break;
        maxId = nextMaxId;
    }
    return { items };
}

/**
 * Paginate through the v3 comments API until the requested limit, exhaustion,
 * or a safety cap is reached. Each root comment is followed by its nested
 * replies (楼中楼), which the root stream only previews.
 *
 * The site's public root-comment stream is a filtered subset of `reply_count`
 * (commonly capped around 150). Exhaustion is `next_max_id === -1` or an
 * empty page, not `reply_count`.
 *
 * @param options Pagination inputs and page-fetch callbacks.
 * @returns Deduplicated normalized comment rows, possibly partial with a warning.
 */
export async function collectCommentRows(options) {
    const warn = options.warn ?? log.warn;
    const requestDelayMs = options.requestDelayMs ?? 0;
    const childOptions = { ...options, childMaxPages: options.childMaxPages ?? options.maxPages };
    let requestCount = 0;
    let recoveriesLeft = options.recover ? (options.maxRecoveries ?? 0) : 0;
    const request = async (fetch) => {
        if (requestCount > 0)
            await delay(requestDelayMs);
        requestCount += 1;
        let response = await fetch();
        // A mid-run EO_Bot_Ssid challenge clears once the browser reloads a xueqiu page.
        while (recoveriesLeft > 0 && classifyStatusCommentsResponse(response).kind === 'anti-bot') {
            recoveriesLeft -= 1;
            await options.recover();
            response = await fetch();
        }
        return response;
    };
    const rows = [];
    const seenIds = new Set();
    const pushRow = (row) => {
        if (!row.id || seenIds.has(row.id))
            return false;
        seenIds.add(row.id);
        rows.push(row);
        return true;
    };
    let maxId = -1;
    for (let requestNumber = 1; requestNumber <= options.maxPages; requestNumber += 1) {
        const response = await request(() => options.fetchPage(maxId, options.pageSize));
        const classified = classifyStatusCommentsResponse(response);
        if (classified.kind !== 'ok') {
            if (requestNumber === 1) {
                if (classified.kind === 'auth' || classified.kind === 'anti-bot') {
                    throw new AuthRequiredError('xueqiu.com', 'Post comments require login or challenge clearance');
                }
                throw new CommandExecutionError(`Unexpected response while loading xueqiu comments for post ${options.statusId}`, 'Run the command again with --verbose to inspect the raw site response.');
            }
            warn(`xueqiu post comment pagination stopped after request ${requestNumber}, `
                + `collected ${rows.length}/${options.limit} items, `
                + `reason: ${commentFailureReason(classified.kind)}`);
            break;
        }
        const rawItems = (getStatusCommentItems(response.json) ?? [])
            .filter(item => normalizeIdentifier(item?.id));
        if (rawItems.length === 0) {
            break;
        }
        let advanced = false;
        for (const rawItem of rawItems) {
            const rootRow = normalizeCommentItem(rawItem);
            if (!pushRow(rootRow))
                continue;
            advanced = true;
            if (rows.length >= options.limit)
                return rows;
            const children = await collectChildItems(rawItem, rootRow.id, childOptions, request);
            for (const childItem of children.items) {
                pushRow(normalizeCommentItem(childItem, rootRow));
                if (rows.length >= options.limit)
                    return rows;
            }
            if (children.failure) {
                warn(`xueqiu post comment pagination stopped while loading replies to comment ${rootRow.id}, `
                    + `collected ${rows.length}/${options.limit} items, `
                    + `reason: ${commentFailureReason(children.failure)}`);
                return rows;
            }
        }
        const nextMaxId = isRecord(response.json) ? response.json.next_max_id : null;
        if (nextMaxId == null || nextMaxId === -1 || nextMaxId === maxId) {
            break;
        }
        if (!advanced) {
            warn(`xueqiu post comment pagination stopped after request ${requestNumber}, `
                + `collected ${rows.length}/${options.limit} items, `
                + `reason: pagination did not advance`);
            break;
        }
        maxId = nextMaxId;
        if (requestNumber === options.maxPages && rows.length < options.limit) {
            warn(`xueqiu post comment pagination stopped after request ${requestNumber}, `
                + `collected ${rows.length}/${options.limit} items, `
                + `reason: reached safety cap`);
        }
    }
    return rows;
}

cli({
    site: 'xueqiu',
    name: 'post',
    access: 'read',
    description: '获取单条雪球帖子正文和评论',
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
        { name: 'comment_limit', type: 'int', default: COMMENT_LIMIT_MAX, help: `Comments to return (max ${COMMENT_LIMIT_MAX}, 0 = post only)` },
        { name: 'timeout', type: 'int', default: 300, help: 'Max seconds for the overall command (default: 300 — paced comment and reply pagination)' },
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
        if (classified.kind === 'auth' || classified.kind === 'anti-bot') {
            throw new AuthRequiredError('xueqiu.com', 'Post detail requires login or challenge clearance');
        }
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
        const comments = await collectCommentRows({
            statusId,
            limit: commentLimit,
            pageSize: COMMENT_PAGE_SIZE,
            maxPages: COMMENT_MAX_PAGES,
            childMaxPages: CHILD_COMMENT_MAX_PAGES,
            requestDelayMs: COMMENT_REQUEST_DELAY_MS,
            maxRecoveries: COMMENT_MAX_RECOVERIES,
            recover: () => page.goto('https://xueqiu.com'),
            fetchPage: (maxId, pageSize) => fetchXueqiuEnvelope(page, `/statuses/v3/comments.json?id=${encodeURIComponent(statusId)}&type=4&size=${pageSize}&max_id=${maxId}`),
            fetchChildPage: (commentId, maxId, pageSize) => fetchXueqiuEnvelope(page, `/statuses/v3/comments.json?id=${encodeURIComponent(statusId)}&comment_id=${encodeURIComponent(commentId)}&type=4&child_type=2&size=${pageSize}&max_id=${maxId}`),
            warn: log.warn,
        });
        return [postRow, ...comments];
    },
});
