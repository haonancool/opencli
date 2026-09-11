import { beforeEach, describe, expect, it, vi } from 'vitest';
const { mockWarn } = vi.hoisted(() => ({
    mockWarn: vi.fn(),
}));
vi.mock('@jackwener/opencli/logger', () => ({
    log: {
        info: vi.fn(),
        warn: mockWarn,
        error: vi.fn(),
        verbose: vi.fn(),
        debug: vi.fn(),
        step: vi.fn(),
        stepResult: vi.fn(),
    },
}));
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { classifyStatusCommentsResponse } from './utils.js';
import {
    classifyXueqiuUserResponse,
    collectTimelineRows,
    enrichRowsWithComments,
    normalizeTimelineItem,
    parseUserInput,
    pickBestUser,
    summarizeStatusComments,
} from './user.js';

const command = getRegistry().get('xueqiu/user');

function commentsResponse(comments = []) {
    return {
        status: 200,
        contentType: 'application/json',
        json: { comments },
        textSnippet: '',
    };
}

function createCommandPage(response, extraResponses = []) {
    const evaluate = vi.fn().mockResolvedValueOnce(response);
    for (const extra of extraResponses) {
        evaluate.mockResolvedValueOnce(extra);
    }
    evaluate.mockResolvedValue(commentsResponse());
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate,
    };
}

function createSearchPage(searchResponse, timelineResponse) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi
            .fn()
            .mockResolvedValueOnce(searchResponse)
            .mockResolvedValueOnce(timelineResponse)
            .mockResolvedValue(commentsResponse()),
    };
}

function timelineResponse(items) {
    return {
        status: 200,
        contentType: 'application/json',
        json: { statuses: items },
        textSnippet: '',
    };
}

describe('xueqiu user', () => {
    beforeEach(() => {
        mockWarn.mockReset();
    });
    it('parses numeric user ids directly', () => {
        expect(parseUserInput('1102105103')).toEqual({ kind: 'id', userId: '1102105103' });
        expect(parseUserInput(' 42 ')).toEqual({ kind: 'id', userId: '42' });
    });
    it('parses profile urls into numeric user ids', () => {
        expect(parseUserInput('https://xueqiu.com/u/1102105103')).toEqual({ kind: 'id', userId: '1102105103' });
        expect(parseUserInput('https://www.xueqiu.com/u/1102105103/')).toEqual({ kind: 'id', userId: '1102105103' });
    });
    it('rejects blank input before any request is made', () => {
        expect(() => parseUserInput('   ')).toThrow(ArgumentError);
    });
    it('rejects urls that are not xueqiu profile pages', () => {
        expect(() => parseUserInput('https://xueqiu.com/S/SH600519')).toThrow(ArgumentError);
        expect(() => parseUserInput('https://example.com/u/123')).toThrow(ArgumentError);
    });
    it('treats non-numeric input as a screen-name query', () => {
        expect(parseUserInput('但斌')).toEqual({ kind: 'name', query: '但斌' });
        expect(parseUserInput(' Alice ')).toEqual({ kind: 'name', query: 'Alice' });
    });
    it('prefers exact screen-name matches when picking a user', () => {
        expect(pickBestUser([
            { id: 1, screen_name: '但斌投资笔记', followers_count: 10 },
            { id: 2, screen_name: '但斌', followers_count: 5 },
        ], '但斌')).toMatchObject({ id: 2 });
    });
    it('falls back to the most-followed candidate without an exact match', () => {
        expect(pickBestUser([
            { id: 1, screen_name: 'alice', followers_count: 10 },
            { id: 2, screen_name: 'bob', followers_count: 900 },
        ], 'al')).toMatchObject({ id: 2 });
    });
    it('returns null when no candidate has a usable id', () => {
        expect(pickBestUser([
            { screen_name: 'alice', followers_count: 10 },
            null,
        ], 'alice')).toBeNull();
        expect(pickBestUser([], 'alice')).toBeNull();
    });
    it('classifies 401 responses as auth failures', () => {
        expect(classifyXueqiuUserResponse({
            status: 401,
            contentType: 'application/json',
            json: null,
            textSnippet: '',
        })).toMatchObject({ kind: 'auth' });
    });
    it('classifies html challenge pages as anti-bot failures', () => {
        expect(classifyXueqiuUserResponse({
            status: 200,
            contentType: 'text/html',
            json: null,
            textSnippet: '<textarea id="renderData">{"_waf_bd8ce2ce37":"token"}</textarea>',
        })).toMatchObject({ kind: 'anti-bot' });
    });
    it('classifies the user-not-found error envelope as not-found', () => {
        expect(classifyXueqiuUserResponse({
            status: 400,
            contentType: 'application/json',
            json: { error_description: '用户不存在', error_code: '20206' },
            textSnippet: '',
        })).toMatchObject({ kind: 'not-found' });
    });
    it('classifies empty timeline arrays as empty results', () => {
        expect(classifyXueqiuUserResponse(timelineResponse([]))).toMatchObject({ kind: 'empty' });
    });
    it('classifies json responses without a statuses array as incompatible', () => {
        expect(classifyXueqiuUserResponse({
            status: 200,
            contentType: 'application/json',
            json: { success: false, message: 'unexpected backend state' },
            textSnippet: '',
        })).toMatchObject({ kind: 'incompatible' });
    });
    it('classifies usable timeline payloads as unknown', () => {
        expect(classifyXueqiuUserResponse(timelineResponse([
            { id: 1, description: 'hello', user: { screen_name: 'alice', id: 10 } },
        ]))).toMatchObject({ kind: 'unknown' });
    });
    it('does not misclassify generic html error pages as anti-bot failures', () => {
        expect(classifyXueqiuUserResponse({
            status: 500,
            contentType: 'text/html',
            json: null,
            textSnippet: '<html><body>server error</body></html>',
        })).toMatchObject({ kind: 'unknown' });
    });
    it('classifies html login pages as auth failures', () => {
        expect(classifyXueqiuUserResponse({
            status: 200,
            contentType: 'text/html',
            json: null,
            textSnippet: '<html><body>login required</body></html>',
        })).toMatchObject({ kind: 'auth' });
    });
    it('normalizes one raw timeline item into a cleaned row', () => {
        expect(normalizeTimelineItem({
            id: 123,
            user_id: 99,
            description: '<p>hello&nbsp;<b>world</b></p>',
            created_at: 1700000000000,
            user: { screen_name: 'alice', id: 99 },
            reply_count: 2,
            retweet_count: 3,
            fav_count: 4,
        })).toEqual({
            id: '123',
            author: 'alice',
            text: 'hello world',
            comment_preview: null,
            likes: 4,
            replies: 2,
            retweets: 3,
            created_at: new Date(1700000000000).toISOString(),
            url: 'https://xueqiu.com/99/123',
        });
    });
    it('drops invalid created_at values instead of throwing', () => {
        expect(normalizeTimelineItem({
            id: 456,
            user_id: 100,
            description: 'hello',
            created_at: 'not-a-date',
            user: { screen_name: 'bob', id: 100 },
        })).toMatchObject({ created_at: null });
    });
    it('drops object-like ids instead of turning them into fake identifiers', () => {
        expect(normalizeTimelineItem({
            id: { broken: true },
            user_id: { broken: true },
            description: 'hello',
            user: { screen_name: 'eve', id: { broken: true } },
        })).toEqual({
            id: '',
            author: 'eve',
            text: 'hello',
            comment_preview: null,
            likes: 0,
            replies: 0,
            retweets: 0,
            created_at: null,
            url: null,
        });
    });
    it('normalizes invalid count fields to zero', () => {
        expect(normalizeTimelineItem({
            id: 789,
            user_id: 101,
            description: 'hello',
            created_at: 1700000000000,
            user: { screen_name: 'carol', id: 101 },
            reply_count: 'oops',
            retweet_count: Infinity,
            fav_count: '',
        })).toMatchObject({ likes: 0, replies: 0, retweets: 0 });
    });
    it('removes no output keys beyond the documented columns', () => {
        expect(Object.keys(normalizeTimelineItem({
            id: 1,
            user_id: 2,
            description: 'hello',
            user: { screen_name: 'alice', id: 2 },
        })).sort()).toEqual([
            'author',
            'comment_preview',
            'created_at',
            'id',
            'likes',
            'replies',
            'retweets',
            'text',
            'url',
        ]);
    });
    it('registers the xueqiu user command', () => {
        expect(command).toMatchObject({
            site: 'xueqiu',
            name: 'user',
        });
    });
    it('rejects blank user input before navigating the page', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { user: '   ', limit: 5 })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('rejects unsupported urls before navigating the page', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { user: 'https://xueqiu.com/S/SH600519', limit: 5 })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('rejects non-positive limit before navigating the page', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { user: '1102105103', limit: 0 })).rejects.toThrow(ArgumentError);
        await expect(command.func(page, { user: '1102105103', limit: -1 })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('rejects limits above the supported maximum before navigating the page', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { user: '1102105103', limit: 101 })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('rejects non-positive page before navigating the page', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { user: '1102105103', limit: 5, page: 0 })).rejects.toThrow(ArgumentError);
        await expect(command.func(page, { user: '1102105103', limit: 5, page: -1 })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('returns normalized rows for a numeric user id', async () => {
        const page = createCommandPage(timelineResponse([
            {
                id: 123,
                user_id: 99,
                description: '<p>hello&nbsp;<b>world</b></p>',
                created_at: 1700000000000,
                user: { screen_name: 'alice', id: 99 },
                reply_count: 2,
                retweet_count: 3,
                fav_count: 4,
            },
        ]));
        const result = await command.func(page, { user: '1102105103', limit: 5 });
        expect(result).toEqual([
            {
                id: '123',
                author: 'alice',
                text: 'hello world',
                comment_preview: null,
                likes: 4,
                replies: 2,
                retweets: 3,
                created_at: new Date(1700000000000).toISOString(),
                url: 'https://xueqiu.com/99/123',
            },
        ]);
        expect(Object.keys(result[0]).sort()).toEqual([
            'author',
            'comment_preview',
            'created_at',
            'id',
            'likes',
            'replies',
            'retweets',
            'text',
            'url',
        ]);
        expect(page.goto).toHaveBeenCalledWith('https://xueqiu.com');
        expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('user_timeline.json'));
        expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('statuses/v3/comments.json'));
    });
    it('resolves screen names through user search before loading the timeline', async () => {
        const page = createSearchPage({
            status: 200,
            contentType: 'application/json',
            json: {
                list: [
                    { id: 1, screen_name: '但斌笔记', followers_count: 10 },
                    { id: 1102105103, screen_name: '但斌', followers_count: 523404, verified: true },
                ],
            },
            textSnippet: '',
        }, timelineResponse([
            { id: 7, user_id: 1102105103, description: 'first post', created_at: 1700000000000, user: { screen_name: '但斌', id: 1102105103 } },
        ]));
        const result = await command.func(page, { user: '但斌', limit: 5 });
        expect(result).toMatchObject([
            { author: '但斌', text: 'first post', url: 'https://xueqiu.com/1102105103/7' },
        ]);
        expect(page.evaluate).toHaveBeenNthCalledWith(1, expect.stringContaining('search/user.json'));
        expect(page.evaluate).toHaveBeenNthCalledWith(2, expect.stringContaining('user_timeline.json'));
        expect(page.evaluate).toHaveBeenNthCalledWith(3, expect.stringContaining('statuses/v3/comments.json'));
    });
    it('throws empty-result error when no user matches the screen name', async () => {
        const page = createCommandPage({
            status: 200,
            contentType: 'application/json',
            json: { count: 0, list: [] },
            textSnippet: '',
        });
        const rejection = command.func(page, { user: '不存在的用户zzz', limit: 5 });
        await expect(rejection).rejects.toThrow(EmptyResultError);
        await expect(rejection).rejects.toThrow('不存在的用户zzz');
    });
    it('throws auth error when the first timeline page responds with 401', async () => {
        const page = createCommandPage({
            status: 401,
            contentType: 'application/json',
            json: null,
            textSnippet: '',
        });
        await expect(command.func(page, { user: '1102105103', limit: 5 })).rejects.toThrow(AuthRequiredError);
        expect(page.goto).toHaveBeenCalledWith('https://xueqiu.com');
    });
    it('throws empty-result error when the user does not exist', async () => {
        const page = createCommandPage({
            status: 400,
            contentType: 'application/json',
            json: { error_description: '用户不存在', error_code: '20206' },
            textSnippet: '',
        });
        const rejection = command.func(page, { user: '9228789232', limit: 5 });
        await expect(rejection).rejects.toThrow(EmptyResultError);
        await expect(rejection).rejects.toThrow('9228789232');
    });
    it('throws empty-result error when the timeline is empty', async () => {
        const page = createCommandPage(timelineResponse([]));
        await expect(command.func(page, { user: '1102105103', limit: 5 })).rejects.toMatchObject({
            name: 'EmptyResultError',
            message: expect.stringContaining('1102105103'),
            hint: expect.stringContaining('page 1'),
        });
    });
    it('throws empty-result error when the requested start page has no posts', async () => {
        const page = createCommandPage(timelineResponse([]));
        await expect(command.func(page, { user: '1102105103', limit: 5, page: 9 })).rejects.toMatchObject({
            name: 'EmptyResultError',
            hint: expect.stringContaining('page 9'),
        });
    });
    it('throws a compact incompatible-response error when the json shape is unusable', async () => {
        const page = createCommandPage({
            status: 200,
            contentType: 'application/json',
            json: { success: false, message: 'unexpected backend state' },
            textSnippet: '',
        });
        const rejection = command.func(page, { user: '1102105103', limit: 5 });
        await expect(rejection).rejects.toThrow(CommandExecutionError);
        await expect(rejection).rejects.toThrow('Unexpected response');
    });
    it('throws auth-required error when the first timeline page is an html challenge', async () => {
        const page = createCommandPage({
            status: 200,
            contentType: 'text/html',
            json: null,
            textSnippet: '<textarea id="renderData">{"_waf_bd8ce2ce37":"token"}</textarea>',
        });
        await expect(command.func(page, { user: '1102105103', limit: 5 })).rejects.toThrow(AuthRequiredError);
    });
    it('throws command-execution error when the first page fetch fails before any rows are available', async () => {
        const page = createCommandPage({
            status: 0,
            contentType: 'text/plain',
            json: null,
            textSnippet: 'network failed',
        });
        const rejection = command.func(page, { user: '1102105103', limit: 5 });
        await expect(rejection).rejects.toThrow(CommandExecutionError);
        await expect(rejection).rejects.toThrow('Unexpected response');
    });
    it('collects later pages, deduplicates rows, and trims to limit', async () => {
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce(timelineResponse([
            { id: 1, user_id: 10, description: 'alpha', user: { screen_name: 'alice', id: 10 } },
            { id: 2, user_id: 11, description: 'beta', user: { screen_name: 'bob', id: 11 } },
        ]))
            .mockResolvedValueOnce(timelineResponse([
            { id: 2, user_id: 11, description: 'beta-duplicate', user: { screen_name: 'bob', id: 11 } },
            { id: 3, user_id: 12, description: 'gamma', user: { screen_name: 'carol', id: 12 } },
        ]));
        await expect(collectTimelineRows({
            userId: '1102105103',
            limit: 3,
            pageSize: 2,
            maxRequests: 5,
            fetchPage,
            warn: mockWarn,
        })).resolves.toMatchObject([
            { id: '1', text: 'alpha' },
            { id: '2', text: 'beta' },
            { id: '3', text: 'gamma' },
        ]);
        expect(fetchPage).toHaveBeenCalledTimes(2);
        expect(fetchPage).toHaveBeenNthCalledWith(1, 1, 2);
        expect(fetchPage).toHaveBeenNthCalledWith(2, 2, 2);
        expect(mockWarn).not.toHaveBeenCalled();
    });
    it('starts internal pagination from the requested page number', async () => {
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce(timelineResponse([
            { id: 21, user_id: 10, description: 'page-three', user: { screen_name: 'alice', id: 10 } },
            { id: 22, user_id: 11, description: 'page-three-b', user: { screen_name: 'bob', id: 11 } },
        ]))
            .mockResolvedValueOnce(timelineResponse([
            { id: 23, user_id: 12, description: 'page-four', user: { screen_name: 'carol', id: 12 } },
        ]));
        await expect(collectTimelineRows({
            userId: '1102105103',
            limit: 3,
            startPage: 3,
            pageSize: 2,
            maxRequests: 5,
            fetchPage,
            warn: mockWarn,
        })).resolves.toMatchObject([
            { id: '21', text: 'page-three' },
            { id: '22', text: 'page-three-b' },
            { id: '23', text: 'page-four' },
        ]);
        expect(fetchPage).toHaveBeenNthCalledWith(1, 3, 2);
        expect(fetchPage).toHaveBeenNthCalledWith(2, 4, 2);
    });
    it('requests the matching API page when --page is set', async () => {
        const page = createCommandPage(timelineResponse([
            { id: 21, user_id: 10, description: 'later post', user: { screen_name: 'alice', id: 10 } },
        ]));
        const result = await command.func(page, { user: '1102105103', limit: 5, page: 3, comment_limit: 0 });
        expect(result).toMatchObject([{ id: '21', text: 'later post' }]);
        expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('page=3'));
        expect(page.evaluate).not.toHaveBeenCalledWith(expect.stringContaining('page=1&'));
    });
    it('returns partial rows and emits warning when a later page fails', async () => {
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce(timelineResponse([
            { id: 1, user_id: 10, description: 'alpha', user: { screen_name: 'alice', id: 10 } },
            { id: 2, user_id: 11, description: 'beta', user: { screen_name: 'bob', id: 11 } },
        ]))
            .mockResolvedValueOnce({
            status: 200,
            contentType: 'text/html',
            json: null,
            textSnippet: '<textarea id="renderData">{"_waf_bd8ce2ce37":"token"}</textarea>',
        });
        await expect(collectTimelineRows({
            userId: '1102105103',
            limit: 3,
            pageSize: 2,
            maxRequests: 5,
            fetchPage,
            warn: mockWarn,
        })).resolves.toMatchObject([
            { id: '1', text: 'alpha' },
            { id: '2', text: 'beta' },
        ]);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('2/3'));
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('anti-bot'));
    });
    it('ends pagination quietly when a later page returns an empty timeline', async () => {
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce(timelineResponse([
            { id: 1, user_id: 10, description: 'alpha', user: { screen_name: 'alice', id: 10 } },
            { id: 2, user_id: 11, description: 'beta', user: { screen_name: 'bob', id: 11 } },
        ]))
            .mockResolvedValueOnce(timelineResponse([]));
        const result = await collectTimelineRows({
            userId: '1102105103',
            limit: 3,
            pageSize: 2,
            maxRequests: 5,
            fetchPage,
            warn: mockWarn,
        });
        expect(result).toMatchObject([
            { id: '1', text: 'alpha' },
            { id: '2', text: 'beta' },
        ]);
        expect(fetchPage).toHaveBeenCalledTimes(2);
        expect(mockWarn).not.toHaveBeenCalled();
    });
    it('emits warning when pagination stops at the safety cap', async () => {
        let nextId = 1;
        const fetchPage = vi
            .fn()
            .mockImplementation(async () => timelineResponse([
            { id: nextId++, user_id: 10, description: 'alpha', user: { screen_name: 'alice', id: 10 } },
            { id: nextId++, user_id: 11, description: 'beta', user: { screen_name: 'bob', id: 11 } },
        ]));
        const result = await collectTimelineRows({
            userId: '1102105103',
            limit: 12,
            pageSize: 2,
            maxRequests: 5,
            fetchPage,
            warn: mockWarn,
        });
        expect(result).toHaveLength(10);
        expect(fetchPage).toHaveBeenCalledTimes(5);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('10/12'));
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('reached safety cap'));
    });
    it('summarizes comments with author, reply target, and stripped text', () => {
        expect(summarizeStatusComments([
            { user: { screen_name: 'alice' }, text: '<p>nice&nbsp;post</p>' },
            { user: { screen_name: 'bob' }, reply_screenName: 'alice', text: 'agreed' },
            { user: {}, text: 'anonymous take' },
        ])).toBe('alice: nice post | bob -> alice: agreed | 匿名: anonymous take');
    });
    it('truncates each comment text in the preview', () => {
        expect(summarizeStatusComments([
            { user: { screen_name: 'alice' }, text: 'a'.repeat(200) },
        ], 60)).toBe(`alice: ${'a'.repeat(60)}`);
    });
    it('returns null preview for empty or malformed comment lists', () => {
        expect(summarizeStatusComments([])).toBeNull();
        expect(summarizeStatusComments(null)).toBeNull();
        expect(summarizeStatusComments([null, {}])).toBeNull();
    });
    it('classifies usable comment payloads as ok including empty lists', () => {
        expect(classifyStatusCommentsResponse({
            status: 200,
            contentType: 'application/json',
            json: { comments: [{ id: 1 }] },
            textSnippet: '',
        })).toMatchObject({ kind: 'ok' });
        expect(classifyStatusCommentsResponse({
            status: 200,
            contentType: 'application/json',
            json: { comments: [] },
            textSnippet: '',
        })).toMatchObject({ kind: 'ok' });
    });
    it('classifies comment auth and challenge failures', () => {
        expect(classifyStatusCommentsResponse({
            status: 403,
            contentType: 'application/json',
            json: null,
            textSnippet: '',
        })).toMatchObject({ kind: 'auth' });
        expect(classifyStatusCommentsResponse({
            status: 200,
            contentType: 'text/html',
            json: null,
            textSnippet: '<textarea id="renderData">{"_waf_bd8ce2ce37":"token"}</textarea>',
        })).toMatchObject({ kind: 'anti-bot' });
    });
    it('classifies comment payloads without a comments array as incompatible', () => {
        expect(classifyStatusCommentsResponse({
            status: 400,
            contentType: 'application/json',
            json: { error_description: '遇到错误', error_code: '10020' },
            textSnippet: '',
        })).toMatchObject({ kind: 'incompatible' });
        expect(classifyStatusCommentsResponse({
            status: 0,
            contentType: 'text/plain',
            json: null,
            textSnippet: 'network failed',
        })).toMatchObject({ kind: 'unknown' });
    });
    it('enriches every row with a comment preview', async () => {
        const page = {
            evaluate: vi.fn().mockImplementation(async (code) => {
                if (code.includes('id=2')) {
                    return {
                        status: 200,
                        contentType: 'application/json',
                        json: { comments: [] },
                        textSnippet: '',
                    };
                }
                return {
                    status: 200,
                    contentType: 'application/json',
                    json: { comments: [{ user: { screen_name: 'carol' }, text: 'first!' }] },
                    textSnippet: '',
                };
            }),
        };
        const rows = [
            { id: '1', author: 'alice' },
            { id: '2', author: 'bob' },
        ];
        await enrichRowsWithComments(page, rows, 5, mockWarn);
        expect(rows[0].comment_preview).toBe('carol: first!');
        expect(rows[1].comment_preview).toBeNull();
        expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('statuses/v3/comments.json'));
        expect(mockWarn).not.toHaveBeenCalled();
    });
    it('stops comment enrichment after the first failed post with one warning', async () => {
        const page = {
            evaluate: vi.fn().mockResolvedValue({
                status: 403,
                contentType: 'application/json',
                json: null,
                textSnippet: '',
            }),
        };
        const rows = [
            { id: '1', author: 'alice' },
            { id: '2', author: 'bob' },
        ];
        await enrichRowsWithComments(page, rows, 5, mockWarn);
        expect(rows[0].comment_preview).toBeUndefined();
        expect(rows[1].comment_preview).toBeUndefined();
        expect(page.evaluate).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('post 1'));
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('auth failure'));
    });
    it('rejects invalid comment limits before navigating the page', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { user: '1102105103', limit: 5, comment_limit: -1 })).rejects.toThrow(ArgumentError);
        await expect(command.func(page, { user: '1102105103', limit: 5, comment_limit: 1.5 })).rejects.toThrow(ArgumentError);
        await expect(command.func(page, { user: '1102105103', limit: 5, comment_limit: 21 })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('does not fetch comments when comment_limit is zero', async () => {
        const page = createCommandPage(timelineResponse([
            { id: 1, user_id: 10, description: 'alpha', user: { screen_name: 'alice', id: 10 } },
        ]));
        const result = await command.func(page, { user: '1102105103', limit: 5, comment_limit: 0 });
        expect(result).toMatchObject([{ comment_preview: null }]);
        expect(page.evaluate).toHaveBeenCalledTimes(1);
        expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('user_timeline.json'));
    });
    it('fetches comments by default when comment_limit is omitted', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi
                .fn()
                .mockResolvedValueOnce(timelineResponse([
                { id: 123, user_id: 99, description: 'post body', user: { screen_name: 'alice', id: 99 } },
            ]))
                .mockResolvedValueOnce({
                status: 200,
                contentType: 'application/json',
                json: { comments: [{ user: { screen_name: 'carol' }, text: 'first!' }] },
                textSnippet: '',
            }),
        };
        const result = await command.func(page, { user: '1102105103', limit: 5 });
        expect(result).toMatchObject([
            { id: '123', comment_preview: 'carol: first!' },
        ]);
        expect(page.evaluate).toHaveBeenNthCalledWith(2, expect.stringContaining('statuses/v3/comments.json'));
        expect(page.evaluate).toHaveBeenNthCalledWith(2, expect.stringContaining('size=20'));
    });
    it('embeds comment previews when comment_limit is set', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi
                .fn()
                .mockResolvedValueOnce(timelineResponse([
                { id: 123, user_id: 99, description: 'post body', user: { screen_name: 'alice', id: 99 } },
            ]))
                .mockResolvedValueOnce({
                status: 200,
                contentType: 'application/json',
                json: { comments: [{ user: { screen_name: 'carol' }, reply_screenName: 'alice', text: '<b>nice</b>' }] },
                textSnippet: '',
            }),
        };
        const result = await command.func(page, { user: '1102105103', limit: 5, comment_limit: 5 });
        expect(result).toMatchObject([
            { id: '123', comment_preview: 'carol -> alice: nice' },
        ]);
        expect(page.evaluate).toHaveBeenNthCalledWith(2, expect.stringContaining('statuses/v3/comments.json'));
        expect(page.evaluate).toHaveBeenNthCalledWith(2, expect.stringContaining('id=123'));
    });
});
