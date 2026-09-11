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
 * @returns Public comment row (`type=comment`).
 */
export function normalizeCommentItem(item) {
    const id = normalizeIdentifier(item.id);
    const userId = normalizeIdentifier(item.user_id) || normalizeIdentifier(item.user?.id);
    const replyTo = String(item.reply_screenName ?? item.reply_comment?.user?.screen_name ?? '').trim() || null;
    return {
        type: 'comment',
        id,
        author: String(item.user?.screen_name ?? ''),
        text: stripTags(item.text),
        reply_to: replyTo,
        likes: toFiniteCount(item.like_count),
        replies: toFiniteCount(item.reply_count),
        retweets: 0,
        created_at: toIsoTimestamp(item.created_at),
        url: statusUrl(userId, id),
    };
}

function commentFailureReason(kind) {
    if (kind === 'auth' || kind === 'anti-bot')
        return 'auth failure';
    if (kind === 'unknown')
        return 'unknown request failure';
    return 'unexpected response shape';
}

/**
 * Paginate through the v3 comments API until the requested limit, exhaustion,
 * or a safety cap is reached.
 *
 * The site's public comment stream is a filtered subset of `reply_count`
 * (commonly capped around 150). Exhaustion is `next_max_id === -1` or an
 * empty page, not `reply_count`.
 *
 * @param options Pagination inputs and a page-fetch callback.
 * @returns Deduplicated normalized comment rows, possibly partial with a warning.
 */
export async function collectCommentRows(options) {
    const warn = options.warn ?? log.warn;
    const rows = [];
    const seenIds = new Set();
    let maxId = -1;
    for (let requestNumber = 1; requestNumber <= options.maxPages; requestNumber += 1) {
        const response = await options.fetchPage(maxId, options.pageSize);
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
        const rawItems = getStatusCommentItems(response.json) ?? [];
        const pageRows = rawItems
            .map(item => normalizeCommentItem(item))
            .filter(row => row.id);
        if (pageRows.length === 0) {
            break;
        }
        let advanced = false;
        for (const row of pageRows) {
            if (seenIds.has(row.id))
                continue;
            seenIds.add(row.id);
            rows.push(row);
            advanced = true;
            if (rows.length >= options.limit)
                return rows;
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
    ],
    columns: ['type', 'id', 'author', 'text', 'reply_to', 'likes', 'replies', 'retweets', 'created_at', 'url'],
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
        const detailResponse = await fetchXueqiuEnvelope(page, `https://xueqiu.com/statuses/show.json?id=${encodeURIComponent(statusId)}`);
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
            fetchPage: (maxId, pageSize) => fetchXueqiuEnvelope(page, `https://xueqiu.com/statuses/v3/comments.json?id=${encodeURIComponent(statusId)}&type=4&size=${pageSize}&max_id=${maxId}`),
            warn: log.warn,
        });
        return [postRow, ...comments];
    },
});
