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
    classifyStatusDetailResponse,
    collectCommentRows,
    getChildCommentItems,
    normalizeCommentItem,
    normalizeStatusDetail,
    parseStatusInput,
} from './post.js';

const command = getRegistry().get('xueqiu/post');

function envelope(json, extras = {}) {
    return {
        status: extras.status ?? 200,
        contentType: extras.contentType ?? 'application/json',
        json,
        textSnippet: extras.textSnippet ?? '',
    };
}

function statusDetail(overrides = {}) {
    return {
        id: 99380989,
        user_id: 9089343523,
        description: 'short desc',
        text: '<p>hello&nbsp;<b>world</b></p>',
        created_at: 1700000000000,
        user: { screen_name: 'alice', id: 9089343523 },
        reply_count: 12,
        retweet_count: 3,
        fav_count: 4,
        ...overrides,
    };
}

function commentItem(overrides = {}) {
    return {
        id: 11,
        user_id: 22,
        text: '<p>nice</p>',
        created_at: 1700000001000,
        user: { screen_name: 'bob', id: 22 },
        like_count: 5,
        reply_count: 1,
        ...overrides,
    };
}

describe('xueqiu post', () => {
    beforeEach(() => {
        mockWarn.mockReset();
    });
    it('parses numeric status ids and post urls', () => {
        expect(parseStatusInput('99380989')).toBe('99380989');
        expect(parseStatusInput(' https://xueqiu.com/9089343523/99380989 ')).toBe('99380989');
        expect(parseStatusInput('https://www.xueqiu.com/u/9089343523/99380989/')).toBe('99380989');
    });
    it('rejects blank, non-numeric, and unsupported urls before any request', () => {
        expect(() => parseStatusInput('   ')).toThrow(ArgumentError);
        expect(() => parseStatusInput('abc')).toThrow(ArgumentError);
        expect(() => parseStatusInput('https://xueqiu.com/S/SH600519')).toThrow(ArgumentError);
    });
    it('classifies missing posts, auth failures, and usable details', () => {
        expect(classifyStatusDetailResponse(envelope({ error_description: '您访问的页面不存在', error_code: '20210' }, { status: 400 }))).toMatchObject({ kind: 'not-found' });
        expect(classifyStatusDetailResponse(envelope(null, { status: 401 }))).toMatchObject({ kind: 'auth' });
        expect(classifyStatusDetailResponse(envelope(null, { contentType: 'text/html', textSnippet: '<textarea id="renderData">{"_waf_bd8ce2ce37":"token"}</textarea>' }))).toMatchObject({ kind: 'anti-bot' });
        expect(classifyStatusDetailResponse(envelope({ success: false, message: 'unexpected backend state' }))).toMatchObject({ kind: 'incompatible' });
        expect(classifyStatusDetailResponse(envelope(statusDetail()))).toMatchObject({ kind: 'ok' });
    });
    it('normalizes a status detail into a post row using the HTML body', () => {
        expect(normalizeStatusDetail(statusDetail())).toEqual({
            type: 'post',
            id: '99380989',
            author: 'alice',
            text: 'hello world',
            reply_to: null,
            likes: 4,
            replies: 12,
            retweets: 3,
            created_at: new Date(1700000000000).toISOString(),
            url: 'https://xueqiu.com/9089343523/99380989',
        });
    });
    it('falls back to description when the HTML body is empty', () => {
        expect(normalizeStatusDetail(statusDetail({ text: '', description: 'plain body' })).text).toBe('plain body');
    });
    it('normalizes a comment including reply target', () => {
        expect(normalizeCommentItem(commentItem({
            reply_screenName: 'alice',
            like_count: 'oops',
        }))).toEqual({
            type: 'comment',
            id: '11',
            author: 'bob',
            text: 'nice',
            reply_to: 'alice',
            likes: 0,
            replies: 1,
            retweets: 0,
            created_at: new Date(1700000001000).toISOString(),
            url: 'https://xueqiu.com/22/11',
        });
    });
    it('normalizes nested reply counts and falls back to the root author as reply target', () => {
        expect(normalizeCommentItem(commentItem({ reply_count: 0, comment_reply_count: 13 }))).toMatchObject({ replies: 13, reply_to: null });
        expect(normalizeCommentItem(commentItem({ reply_user: { screen_name: 'carol' } }), 'alice').reply_to).toBe('carol');
        expect(normalizeCommentItem(commentItem({ reply_user: null }), 'alice').reply_to).toBe('alice');
    });
    it('extracts child comments from the root echoed by the child_type=2 endpoint', () => {
        const json = { comments: [{ id: 7, child_comments: [commentItem({ id: 71 }), commentItem({ id: 72 })] }] };
        expect(getChildCommentItems(json, '7').map(item => item.id)).toEqual([71, 72]);
        expect(getChildCommentItems({ comments: [] }, '7')).toEqual([]);
        expect(getChildCommentItems({ error: 'x' }, '7')).toBeNull();
    });
    it('classifies the EO_Bot_Ssid JS challenge as anti-bot', () => {
        expect(classifyStatusCommentsResponse(envelope(null, {
            contentType: 'text/html',
            textSnippet: '<script>function a(a){case"0":t+="EO_Bot_Ssid=";continue;}</script>',
        }))).toMatchObject({ kind: 'anti-bot' });
    });
    it('registers the xueqiu post command', () => {
        expect(command).toMatchObject({ site: 'xueqiu', name: 'post' });
    });
    it('rejects invalid status and comment_limit before navigating', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { status: '   ', comment_limit: 5 })).rejects.toThrow(ArgumentError);
        await expect(command.func(page, { status: '99380989', comment_limit: -1 })).rejects.toThrow(ArgumentError);
        await expect(command.func(page, { status: '99380989', comment_limit: 801 })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('returns the post row and skips comments when comment_limit is zero', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValueOnce(envelope(statusDetail())),
        };
        const result = await command.func(page, { status: '99380989', comment_limit: 0 });
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ type: 'post', id: '99380989', text: 'hello world' });
        expect(page.evaluate).toHaveBeenCalledTimes(1);
        expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('statuses/show.json'));
    });
    it('returns the post plus paginated comments for a numeric status id', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi
                .fn()
                .mockResolvedValueOnce(envelope(statusDetail()))
                .mockResolvedValueOnce(envelope({
                comments: [commentItem({ id: 11 }), commentItem({ id: 12, user: { screen_name: 'carol', id: 33 }, user_id: 33, text: 'second' })],
                next_max_id: 12,
            }))
                .mockResolvedValueOnce(envelope({
                comments: [commentItem({ id: 13, user: { screen_name: 'dave', id: 44 }, user_id: 44, text: 'third' })],
                next_max_id: -1,
            })),
        };
        const result = await command.func(page, { status: 'https://xueqiu.com/9089343523/99380989', comment_limit: 5 });
        expect(result.map(row => ({ type: row.type, id: row.id, text: row.text }))).toEqual([
            { type: 'post', id: '99380989', text: 'hello world' },
            { type: 'comment', id: '11', text: 'nice' },
            { type: 'comment', id: '12', text: 'second' },
            { type: 'comment', id: '13', text: 'third' },
        ]);
        expect(Object.keys(result[0]).sort()).toEqual([
            'author',
            'created_at',
            'id',
            'likes',
            'replies',
            'reply_to',
            'retweets',
            'text',
            'type',
            'url',
        ]);
        expect(page.evaluate).toHaveBeenNthCalledWith(2, expect.stringContaining('max_id=-1'));
        expect(page.evaluate).toHaveBeenNthCalledWith(3, expect.stringContaining('max_id=12'));
    });
    it('throws empty-result when the post does not exist', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValueOnce(envelope({ error_description: '您访问的页面不存在', error_code: '20210' }, { status: 400 })),
        };
        const rejection = command.func(page, { status: '1', comment_limit: 5 });
        await expect(rejection).rejects.toThrow(EmptyResultError);
        await expect(rejection).rejects.toThrow('1');
    });
    it('throws auth-required when the detail page is a challenge', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValueOnce(envelope(null, {
                contentType: 'text/html',
                textSnippet: '<textarea id="renderData">{"_waf_bd8ce2ce37":"token"}</textarea>',
            })),
        };
        await expect(command.func(page, { status: '99380989', comment_limit: 5 })).rejects.toThrow(AuthRequiredError);
    });
    it('throws command-execution when the first comments page is unusable', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi
                .fn()
                .mockResolvedValueOnce(envelope(statusDetail()))
                .mockResolvedValueOnce(envelope({ success: false, message: 'unexpected backend state' })),
        };
        const rejection = command.func(page, { status: '99380989', comment_limit: 5 });
        await expect(rejection).rejects.toThrow(CommandExecutionError);
        await expect(rejection).rejects.toThrow('Unexpected response');
    });
    it('collects later comment pages, deduplicates, and trims to limit', async () => {
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce(envelope({
            comments: [commentItem({ id: 1, text: 'a' }), commentItem({ id: 2, text: 'b' })],
            next_max_id: 2,
        }))
            .mockResolvedValueOnce(envelope({
            comments: [commentItem({ id: 2, text: 'b-dup' }), commentItem({ id: 3, text: 'c' })],
            next_max_id: 3,
        }));
        await expect(collectCommentRows({
            statusId: '99380989',
            limit: 3,
            pageSize: 20,
            maxPages: 5,
            fetchPage,
            warn: mockWarn,
        })).resolves.toMatchObject([
            { id: '1', text: 'a' },
            { id: '2', text: 'b' },
            { id: '3', text: 'c' },
        ]);
        expect(fetchPage).toHaveBeenCalledTimes(2);
        expect(mockWarn).not.toHaveBeenCalled();
    });
    it('returns partial comments and warns when a later page fails', async () => {
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce(envelope({
            comments: [commentItem({ id: 1, text: 'a' }), commentItem({ id: 2, text: 'b' })],
            next_max_id: 2,
        }))
            .mockResolvedValueOnce(envelope(null, {
            contentType: 'text/html',
            textSnippet: '<textarea id="renderData">{"_waf_bd8ce2ce37":"token"}</textarea>',
        }));
        await expect(collectCommentRows({
            statusId: '99380989',
            limit: 5,
            pageSize: 20,
            maxPages: 5,
            fetchPage,
            warn: mockWarn,
        })).resolves.toMatchObject([
            { id: '1', text: 'a' },
            { id: '2', text: 'b' },
        ]);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('2/5'));
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('auth failure'));
    });
    it('uses the embedded child preview when it already covers every nested reply', async () => {
        const fetchPage = vi.fn().mockResolvedValueOnce(envelope({
            comments: [commentItem({
                id: 1,
                comment_reply_count: 2,
                child_comments: [commentItem({ id: 11, text: 'r1', user: { screen_name: 'carol', id: 33 } }), commentItem({ id: 12, text: 'r2', reply_user: { screen_name: 'carol' } })],
            })],
            next_max_id: -1,
        }));
        const fetchChildPage = vi.fn();
        const result = await collectCommentRows({
            statusId: '99380989', limit: 20, pageSize: 20, maxPages: 5, fetchPage, fetchChildPage, warn: mockWarn,
        });
        expect(result.map(row => [row.id, row.reply_to])).toEqual([['1', null], ['11', 'bob'], ['12', 'carol']]);
        expect(fetchChildPage).not.toHaveBeenCalled();
    });
    it('paginates nested replies after each root comment when the preview is partial', async () => {
        const fetchPage = vi.fn().mockResolvedValueOnce(envelope({
            comments: [
                commentItem({ id: 1, comment_reply_count: 3, child_comments: [commentItem({ id: 11 })] }),
                commentItem({ id: 2 }),
            ],
            next_max_id: -1,
        }));
        const fetchChildPage = vi
            .fn()
            .mockResolvedValueOnce(envelope({ comments: [{ id: 1, child_comments: [commentItem({ id: 11 }), commentItem({ id: 12 })] }], next_max_id: 12 }))
            .mockResolvedValueOnce(envelope({ comments: [{ id: 1, child_comments: [commentItem({ id: 13 })] }], next_max_id: -1 }));
        const result = await collectCommentRows({
            statusId: '99380989', limit: 20, pageSize: 20, maxPages: 5, fetchPage, fetchChildPage, warn: mockWarn,
        });
        expect(result.map(row => row.id)).toEqual(['1', '11', '12', '13', '2']);
        expect(fetchChildPage).toHaveBeenNthCalledWith(1, '1', -1, 20);
        expect(fetchChildPage).toHaveBeenNthCalledWith(2, '1', 12, 20);
        expect(mockWarn).not.toHaveBeenCalled();
    });
    it('counts nested replies toward the limit', async () => {
        const fetchPage = vi.fn().mockResolvedValueOnce(envelope({
            comments: [commentItem({ id: 1, comment_reply_count: 2, child_comments: [commentItem({ id: 11 }), commentItem({ id: 12 })] }), commentItem({ id: 2 })],
            next_max_id: -1,
        }));
        const result = await collectCommentRows({
            statusId: '99380989', limit: 2, pageSize: 20, maxPages: 5, fetchPage, warn: mockWarn,
        });
        expect(result.map(row => row.id)).toEqual(['1', '11']);
    });
    it('returns partial rows and warns when a nested reply page fails', async () => {
        const fetchPage = vi.fn().mockResolvedValueOnce(envelope({
            comments: [commentItem({ id: 1, comment_reply_count: 5, child_comments: [] }), commentItem({ id: 2 })],
            next_max_id: -1,
        }));
        const fetchChildPage = vi.fn().mockResolvedValueOnce(envelope({ success: false }));
        const result = await collectCommentRows({
            statusId: '99380989', limit: 20, pageSize: 20, maxPages: 5, fetchPage, fetchChildPage, warn: mockWarn,
        });
        expect(result.map(row => row.id)).toEqual(['1']);
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('replies to comment 1'));
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('unexpected response shape'));
    });
    it('recovers from a mid-run anti-bot challenge and retries the same page', async () => {
        const challenge = envelope(null, { contentType: 'text/html', textSnippet: '<script>t+="EO_Bot_Ssid="</script>' });
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce(envelope({ comments: [commentItem({ id: 1 })], next_max_id: 1 }))
            .mockResolvedValueOnce(challenge)
            .mockResolvedValueOnce(envelope({ comments: [commentItem({ id: 2 })], next_max_id: -1 }));
        const recover = vi.fn().mockResolvedValue(undefined);
        const result = await collectCommentRows({
            statusId: '99380989', limit: 20, pageSize: 20, maxPages: 5, fetchPage, recover, maxRecoveries: 1, warn: mockWarn,
        });
        expect(result.map(row => row.id)).toEqual(['1', '2']);
        expect(recover).toHaveBeenCalledTimes(1);
        expect(fetchPage).toHaveBeenNthCalledWith(3, 1, 20);
        expect(mockWarn).not.toHaveBeenCalled();
    });
    it('ends comment pagination quietly when next_max_id is -1', async () => {
        const fetchPage = vi.fn().mockResolvedValueOnce(envelope({
            comments: [commentItem({ id: 1, text: 'a' })],
            next_max_id: -1,
        }));
        const result = await collectCommentRows({
            statusId: '99380989',
            limit: 20,
            pageSize: 20,
            maxPages: 5,
            fetchPage,
            warn: mockWarn,
        });
        expect(result).toHaveLength(1);
        expect(fetchPage).toHaveBeenCalledTimes(1);
        expect(mockWarn).not.toHaveBeenCalled();
    });
});
