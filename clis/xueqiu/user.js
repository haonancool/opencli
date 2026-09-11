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

const XUEQIU_PROFILE_URL_PATTERN = /^https?:\/\/(?:www\.)?xueqiu\.com\/u\/(\d{1,15})\/?$/i;
const XUEQIU_USER_ID_PATTERN = /^\d{1,15}$/;
const USER_SEARCH_COUNT = 10;
const USER_TIMELINE_PAGE_SIZE = 20;
const STATUS_COMMENTS_MAX = 20;
const COMMENT_PREVIEW_TEXT_LENGTH = 60;

const FAILURE_REASON_BY_KIND = {
    auth: 'auth failure',
    'anti-bot': 'anti-bot challenge',
    'not-found': 'user does not exist',
    empty: 'no more timeline data',
    incompatible: 'unexpected response shape',
    unknown: 'unknown request failure',
};

/**
 * Extract the raw status list from one timeline payload.
 *
 * @param json Raw parsed JSON payload from browser fetch.
 * @returns Status items when the response shape is usable, otherwise null.
 */
export function getTimelineItems(json) {
    if (!isRecord(json))
        return null;
    if (Array.isArray(json.statuses))
        return json.statuses;
    return null;
}

/**
 * Classify one raw browser response before command-level error handling.
 *
 * @param response Structured browser response payload.
 * @returns Tagged result describing the response class.
 */
export function classifyXueqiuUserResponse(response) {
    const jsonRecord = isRecord(response.json) ? response.json : null;
    const statusItems = jsonRecord ? getTimelineItems(jsonRecord) : null;
    const envelopeText = envelopeTextFromJson(jsonRecord);
    const authFailure = classifyBrowserAuthFailure(response, envelopeText);
    if (authFailure)
        return authFailure;
    if (jsonRecord && envelopeText && statusItems === null) {
        if (/用户不存在|user does not exist|user not found/.test(envelopeText)
            || jsonRecord.error_code === '20206') {
            return { kind: 'not-found' };
        }
        return { kind: 'incompatible' };
    }
    if (statusItems && statusItems.length === 0) {
        return { kind: 'empty' };
    }
    if (response.contentType.includes('application/json') && jsonRecord && statusItems === null) {
        return { kind: 'incompatible' };
    }
    return { kind: 'unknown' };
}

/**
 * Normalize one raw xueqiu timeline status into the CLI row shape.
 *
 * @param item Raw API status item.
 * @returns Cleaned CLI row; `id` doubles as the pagination dedupe key.
 */
export function normalizeTimelineItem(item) {
    const id = normalizeIdentifier(item.id);
    const userId = normalizeIdentifier(item.user_id) || normalizeIdentifier(item.user?.id);
    return {
        id,
        author: String(item.user?.screen_name ?? ''),
        text: stripTags(item.description),
        comment_preview: null,
        likes: toFiniteCount(item.fav_count),
        replies: toFiniteCount(item.reply_count),
        retweets: toFiniteCount(item.retweet_count),
        created_at: toIsoTimestamp(item.created_at),
        url: statusUrl(userId, id),
    };
}

/**
 * Convert response classification into a compact warning phrase.
 *
 * @param kind Classifier result kind.
 * @returns Human-readable reason fragment for stderr warnings.
 */
export function describeFailureKind(kind) {
    return FAILURE_REASON_BY_KIND[kind];
}

/**
 * Convert raw CLI input into a normalized user reference.
 *
 * Accepts a numeric user id, a profile URL like
 * `https://xueqiu.com/u/1102105103`, or a free-text screen name that will be
 * resolved through the user search API.
 *
 * @param raw User-provided CLI argument.
 * @returns Tagged reference: numeric id or screen-name query.
 */
export function parseUserInput(raw) {
    const input = String(raw ?? '').trim();
    if (!input)
        throw new ArgumentError('xueqiu user requires a user id, screen name, or profile URL');
    const urlMatch = input.match(XUEQIU_PROFILE_URL_PATTERN);
    if (urlMatch)
        return { kind: 'id', userId: urlMatch[1] };
    if (/^https?:\/\//i.test(input)) {
        throw new ArgumentError(`xueqiu user received an unsupported URL: ${input} (expected https://xueqiu.com/u/<user_id>)`);
    }
    if (XUEQIU_USER_ID_PATTERN.test(input))
        return { kind: 'id', userId: input };
    return { kind: 'name', query: input };
}

/**
 * Pick the best candidate from a user search result list.
 *
 * Prefers an exact screen-name match, then the candidate with the most
 * followers.
 *
 * @param candidates Raw user objects from the search API.
 * @param query Original screen-name query.
 * @returns The best matching raw user object.
 */
export function pickBestUser(candidates, query) {
    const users = candidates.filter((item) => !!item && typeof item === 'object' && normalizeIdentifier(item.id));
    if (users.length === 0)
        return null;
    const normalizedQuery = String(query ?? '').trim().toLowerCase();
    const exact = users.find((item) => String(item.screen_name ?? '').trim().toLowerCase() === normalizedQuery);
    if (exact)
        return exact;
    return [...users].sort((a, b) => toFiniteCount(b.followers_count) - toFiniteCount(a.followers_count))[0];
}

/**
 * Fetch one page from inside the browser context so cookies and any
 * site-side request state stay attached to the request.
 *
 * @param page Active browser page.
 * @param url Absolute xueqiu API URL.
 * @returns Structured response for command-side classification.
 */
export async function fetchInPage(page, url) {
    return fetchXueqiuEnvelope(page, url);
}

/**
 * Resolve a screen-name query into a xueqiu user via the search API.
 *
 * @param page Active browser page already navigated to xueqiu.com.
 * @param query Screen-name query from the CLI input.
 * @returns The matched raw user object.
 */
export async function resolveUserByQuery(page, query) {
    const url = `https://xueqiu.com/query/v1/search/user.json?q=${encodeURIComponent(query)}&count=${USER_SEARCH_COUNT}&page=1`;
    const response = await fetchInPage(page, url);
    const classified = classifySearchResponse(response);
    if (classified.kind === 'auth' || classified.kind === 'anti-bot') {
        throw new AuthRequiredError('xueqiu.com', 'User search requires login or challenge clearance');
    }
    if (classified.kind === 'incompatible' || classified.kind === 'unknown') {
        throw new CommandExecutionError(`Unexpected response while searching xueqiu users for ${query}`, 'Run the command again with --verbose to inspect the raw site response.');
    }
    const jsonRecord = isRecord(response.json) ? response.json : null;
    const candidates = Array.isArray(jsonRecord?.list) ? jsonRecord.list : [];
    const best = pickBestUser(candidates, query);
    if (!best) {
        throw new EmptyResultError(`xueqiu/user ${query}`, `No xueqiu user matched "${query}". Pass a numeric user id or a profile URL (https://xueqiu.com/u/<user_id>) to be exact.`);
    }
    return best;
}

/**
 * Classify one user search response.
 *
 * @param response Structured browser response payload.
 * @returns Tagged result describing the response class.
 */
export function classifySearchResponse(response) {
    const jsonRecord = isRecord(response.json) ? response.json : null;
    const envelopeText = envelopeTextFromJson(jsonRecord);
    const authFailure = classifyBrowserAuthFailure(response, envelopeText);
    if (authFailure)
        return authFailure;
    if (response.contentType.includes('application/json') && jsonRecord && !Array.isArray(jsonRecord.list)) {
        return { kind: 'incompatible' };
    }
    if (!jsonRecord) {
        return { kind: 'unknown' };
    }
    return { kind: 'ok' };
}

function buildPaginationStopMessage(requestNumber, collected, target, reason) {
    return `xueqiu user pagination stopped after request ${requestNumber}, `
        + `collected ${collected}/${target} items, `
        + `reason: ${reason}`;
}

/**
 * Collect enough timeline rows to satisfy the requested limit, starting from
 * an explicit 1-based API page.
 *
 * @param options Pagination inputs and a page-fetch callback.
 * @returns Deduplicated normalized rows, possibly partial with a warning.
 */
export async function collectTimelineRows(options) {
    const warn = options.warn ?? log.warn;
    const startPage = options.startPage ?? 1;
    const rows = [];
    const seenIds = new Set();
    for (let requestNumber = 1; requestNumber <= options.maxRequests; requestNumber += 1) {
        const pageNumber = startPage + requestNumber - 1;
        const response = await options.fetchPage(pageNumber, options.pageSize);
        const classified = classifyXueqiuUserResponse(response);
        if (requestNumber === 1 && classified.kind !== 'unknown' && classified.kind !== 'empty') {
            if (classified.kind === 'auth' || classified.kind === 'anti-bot') {
                throw new AuthRequiredError('xueqiu.com', 'User timeline requires login or challenge clearance');
            }
            if (classified.kind === 'not-found') {
                throw new EmptyResultError(`xueqiu/user ${options.userId}`, `xueqiu user ${options.userId} does not exist. If this was meant as a screen name, pass the profile URL instead.`);
            }
            throw new CommandExecutionError(`Unexpected response while loading xueqiu timeline for user ${options.userId}`, 'Run the command again with --verbose to inspect the raw site response.');
        }
        if (classified.kind === 'empty') {
            if (requestNumber === 1) {
                throw new EmptyResultError(`xueqiu/user ${options.userId}`, `No posts found for xueqiu user ${options.userId} on page ${pageNumber}`);
            }
            break;
        }
        else if (classified.kind !== 'unknown') {
            warn(buildPaginationStopMessage(requestNumber, rows.length, options.limit, describeFailureKind(classified.kind)));
            break;
        }
        const rawItems = getTimelineItems(response.json) ?? [];
        const pageRows = rawItems
            .map(item => normalizeTimelineItem(item))
            .filter(row => row.id);
        if (pageRows.length === 0) {
            if (requestNumber === 1) {
                throw new CommandExecutionError(`Unexpected response while loading xueqiu timeline for user ${options.userId}`, 'Run the command again with --verbose to inspect the raw site response.');
            }
            if (classified.kind === 'unknown') {
                warn(buildPaginationStopMessage(requestNumber, rows.length, options.limit, describeFailureKind(classified.kind)));
            }
            break;
        }
        let advanced = false;
        for (const row of pageRows) {
            if (seenIds.has(row.id))
                continue;
            seenIds.add(row.id);
            rows.push(row);
            advanced = true;
        }
        if (rows.length >= options.limit) {
            return rows.slice(0, options.limit);
        }
        if (rawItems.length < options.pageSize) {
            break;
        }
        if (!advanced) {
            warn(buildPaginationStopMessage(requestNumber, rows.length, options.limit, 'pagination did not advance'));
            break;
        }
        if (requestNumber === options.maxRequests) {
            warn(buildPaginationStopMessage(requestNumber, rows.length, options.limit, 'reached safety cap'));
        }
    }
    return rows.slice(0, options.limit);
}

/**
 * Render fetched comments into a one-line preview.
 *
 * Mirrors the zsxq `comment_preview` convention: `author -> repliee: text`
 * fragments joined with ` | `.
 *
 * @param comments Raw comment items from the status-comments API.
 * @param textLength Per-comment text truncation length.
 * @returns Preview string, or null when there are no comments.
 */
export function summarizeStatusComments(comments, textLength = COMMENT_PREVIEW_TEXT_LENGTH) {
    const entries = (Array.isArray(comments) ? comments : [])
        .filter((item) => !!item && typeof item === 'object')
        .map((comment) => {
        const author = String(comment.user?.screen_name ?? '').trim() || '匿名';
        const repliee = String(comment.reply_screenName ?? comment.reply_comment?.user?.screen_name ?? '').trim();
        const target = repliee ? ` -> ${repliee}` : '';
        const text = stripTags(comment.text).substring(0, textLength);
        return `${author}${target}: ${text}`;
    })
        .filter((entry) => !entry.endsWith(': '));
    if (entries.length === 0)
        return null;
    return entries.join(' | ');
}

/**
 * Fetch one page of comments for one status from inside the browser context.
 *
 * @param page Active browser page.
 * @param statusId Numeric status id from the timeline row.
 * @param size Number of comments to request.
 * @returns Structured response for command-side classification.
 */
export async function fetchStatusComments(page, statusId, size) {
    return fetchInPage(page, `https://xueqiu.com/statuses/v3/comments.json?id=${encodeURIComponent(statusId)}&type=4&size=${size}&max_id=-1`);
}

/**
 * Attach a `comment_preview` to each timeline row.
 *
 * Comments are enrichment, not the primary contract: the first failed fetch
 * stops enrichment with a single warning and leaves remaining previews null
 * instead of failing the whole command.
 *
 * @param page Active browser page already navigated to xueqiu.com.
 * @param rows Timeline rows to enrich (mutated in place).
 * @param commentLimit Number of comments to fetch per post.
 * @param warn Warning sink for degradation reasons.
 */
export async function enrichRowsWithComments(page, rows, commentLimit, warn = log.warn) {
    for (const row of rows) {
        const response = await fetchStatusComments(page, row.id, commentLimit);
        const classified = classifyStatusCommentsResponse(response);
        if (classified.kind === 'ok') {
            const comments = getStatusCommentItems(response.json) ?? [];
            row.comment_preview = summarizeStatusComments(comments.slice(0, commentLimit));
            continue;
        }
        warn(`xueqiu user comment enrichment stopped at post ${row.id}, `
            + `reason: ${classified.kind === 'auth' || classified.kind === 'anti-bot' ? 'auth failure' : classified.kind === 'unknown' ? 'unknown request failure' : 'unexpected response shape'}`);
        break;
    }
    return rows;
}

cli({
    site: 'xueqiu',
    name: 'user',
    access: 'read',
    description: '获取指定博主(用户)的帖子时间线',
    domain: 'xueqiu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        {
            name: 'user',
            positional: true,
            required: true,
            help: '博主 user_id、昵称、或个人主页 URL(https://xueqiu.com/u/<user_id>)',
        },
        { name: 'limit', type: 'int', default: 20, help: 'Number of posts to return (max 100)' },
        { name: 'page', type: 'int', default: 1, help: '1-based timeline page to start from (20 posts per page)' },
        { name: 'comment_limit', type: 'int', default: 20, help: 'Comments to embed per post as comment_preview (max 20, 0 = off)' },
    ],
    columns: ['id', 'author', 'text', 'comment_preview', 'likes', 'replies', 'retweets', 'created_at', 'url'],
    func: async (page, args) => {
        const limit = Number(args.limit);
        if (!Number.isInteger(limit) || limit <= 0) {
            throw new ArgumentError('xueqiu user requires --limit to be a positive integer');
        }
        if (limit > 100) {
            throw new ArgumentError('xueqiu user supports --limit up to 100');
        }
        const startPage = Number(args.page ?? 1);
        if (!Number.isInteger(startPage) || startPage <= 0) {
            throw new ArgumentError('xueqiu user requires --page to be a positive integer');
        }
        const commentLimit = Number(args.comment_limit ?? STATUS_COMMENTS_MAX);
        if (!Number.isInteger(commentLimit) || commentLimit < 0) {
            throw new ArgumentError('xueqiu user requires --comment_limit to be a non-negative integer');
        }
        if (commentLimit > STATUS_COMMENTS_MAX) {
            throw new ArgumentError(`xueqiu user supports --comment_limit up to ${STATUS_COMMENTS_MAX}`);
        }
        const reference = parseUserInput(args.user);
        await page.goto('https://xueqiu.com');
        let userId;
        if (reference.kind === 'id') {
            userId = reference.userId;
        }
        else {
            const matched = await resolveUserByQuery(page, reference.query);
            userId = normalizeIdentifier(matched.id);
            log.info(`xueqiu user: resolved "${reference.query}" to ${String(matched.screen_name ?? '')} (user_id ${userId})`);
        }
        const rows = await collectTimelineRows({
            userId,
            limit,
            startPage,
            pageSize: USER_TIMELINE_PAGE_SIZE,
            maxRequests: 5,
            fetchPage: (pageNumber, currentPageSize) => fetchInPage(page, `https://xueqiu.com/v4/statuses/user_timeline.json?user_id=${userId}&page=${pageNumber}&count=${currentPageSize}`),
            warn: log.warn,
        });
        if (rows.length === 0) {
            throw new EmptyResultError(`xueqiu/user ${userId}`, `No posts found for xueqiu user ${userId}`);
        }
        if (commentLimit > 0) {
            await enrichRowsWithComments(page, rows, commentLimit, log.warn);
        }
        return rows;
    },
});
