import { runInNewContext } from 'node:vm';
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
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import {
    classifyStatusDetailResponse,
    collectCommentRows,
    getChildCommentItems,
    normalizeCommentItem,
    normalizeStatusDetail,
    parseStatusInput,
    parseStatusPageScript,
    readStatusPage,
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
        reply_count: 0,
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
    it('ignores login wording inside a successful post body', () => {
        const post = statusDetail({ text: '访问资料时显示 login required / 请先登录' });
        expect(classifyStatusDetailResponse(envelope(post, { textSnippet: JSON.stringify(post) }))).toMatchObject({ kind: 'ok' });
    });
    it('parses only JSON for the requested page and returns public post fields', () => {
        const post = statusDetail({ private_field: 'fixture-secret' });
        const script = `window.SNOWMAN_STATUS = ${JSON.stringify(post)};\nwindow.SNOWMAN_TARGET = window.SNOWMAN_STATUS.user;`;
        const parsed = parseStatusPageScript(script, '99380989', '9089343523');
        expect(normalizeStatusDetail(parsed)).toMatchObject({ id: '99380989', text: 'hello world' });
        expect(parsed).not.toHaveProperty('private_field');
        expect(parsed.user).toEqual({ screen_name: 'alice' });
        expect(parseStatusPageScript(script, '2', '9089343523')).toBeNull();
        expect(parseStatusPageScript(script, '99380989', '2')).toBeNull();
        expect(parseStatusPageScript('window.SNOWMAN_STATUS = (() => alert(1))();', '99380989', '9089343523')).toBeNull();
        expect(parseStatusPageScript('window.SNOWMAN_STATUS = {broken};', '99380989', '9089343523')).toBeNull();
        expect(parseStatusPageScript(`window.SNOWMAN_STATUS = ${JSON.stringify(statusDetail({ text: '' }))};`, '99380989', '9089343523')).toBeNull();
    });
    it.each([
        [200, true, 'hello world', 'ok'],
        [200, false, 'hello world', 'incompatible'],
        [200, true, 'another post', 'incompatible'],
        [403, true, 'hello world', 'forbidden'],
        [429, true, 'hello world', 'rate-limit'],
        [401, true, 'hello world', 'auth'],
        [500, true, 'hello world', 'unknown'],
    ])('checks the actual page reader for HTTP %i and visible body %s/%s', async (status, articlePresent, body, kind) => {
        const page = {
            evaluate: script => runInNewContext(script, {
                location: { pathname: '/9089343523/99380989' },
                performance: { getEntriesByType: () => [{ responseStatus: status }] },
                document: {
                    title: '',
                    body: { innerText: body },
                    scripts: [{ src: '', textContent: `window.SNOWMAN_STATUS = ${JSON.stringify(statusDetail())};` }],
                    querySelector: selector => selector === '.article__bd' && articlePresent ? { textContent: body } : null,
                    createElement: () => ({ content: {}, set innerHTML(value) { this.content.textContent = value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '); } }),
                },
            }),
        };
        expect(classifyStatusDetailResponse(await readStatusPage(page, '99380989', '9089343523'))).toMatchObject({ kind });
    });
    it('reads a full URL from the normal page without fetching the legacy detail endpoint', async () => {
        const page = { goto: vi.fn(), evaluate: vi.fn().mockResolvedValueOnce(envelope(statusDetail())) };
        const rows = await command.func(page, { user: '9089343523', status: 'https://www.xueqiu.com/u/9089343523/99380989/', comment_limit: 0 });
        expect(rows).toMatchObject([{ type: 'post', id: '99380989', text: 'hello world' }]);
        expect(page.goto).toHaveBeenCalledExactlyOnceWith('https://xueqiu.com/9089343523/99380989');
        expect(page.evaluate).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('window\\.SNOWMAN_STATUS'));
        expect(page.evaluate.mock.calls[0][0]).not.toContain('fetch(');
        expect(page.evaluate.mock.calls[0][0]).not.toContain('statuses/show.json');
    });
    it('reads a numeric status with --user from the normal page without calling the legacy API', async () => {
        const page = { goto: vi.fn(), evaluate: vi.fn().mockResolvedValue(envelope(statusDetail())) };
        const rows = await command.func(page, { status: '99380989', user: '9089343523', comment_limit: 0 });
        expect(rows).toMatchObject([{ type: 'post', id: '99380989', text: 'hello world' }]);
        expect(page.goto).toHaveBeenCalledExactlyOnceWith('https://xueqiu.com/9089343523/99380989');
        expect(page.evaluate).toHaveBeenCalledTimes(1);
        expect(page.evaluate.mock.calls[0][0]).not.toContain('fetch(');
    });
    it.each(['99380989', 'https://xueqiu.com/9089343523/99380989'])('requires --user even for %s before navigation', async (status) => {
        const page = { goto: vi.fn(), evaluate: vi.fn() };
        await expect(command.func(page, { status })).rejects.toMatchObject({
            name: 'ArgumentError',
            message: expect.stringContaining('--user <user_id>'),
        });
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.evaluate).not.toHaveBeenCalled();
    });
    it.each([undefined, null, '', 'alice', '1/2', 'https://xueqiu.com/u/9089343523', '1234567890123456'])('rejects invalid --user %j before navigation', async (user) => {
        const page = { goto: vi.fn(), evaluate: vi.fn() };
        await expect(command.func(page, { status: '99380989', user, comment_limit: 0 })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.evaluate).not.toHaveBeenCalled();
    });
    it('rejects --user conflicting with a full URL before navigation', async () => {
        const page = { goto: vi.fn(), evaluate: vi.fn() };
        await expect(command.func(page, { status: 'https://xueqiu.com/9089343523/99380989', user: '22' })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('rejects missing page detail before loading comments', async () => {
        const page = { goto: vi.fn(), evaluate: vi.fn().mockResolvedValueOnce(envelope({})) };
        await expect(command.func(page, { user: '9089343523', status: 'https://xueqiu.com/9089343523/99380989' })).rejects.toThrow(CommandExecutionError);
        expect(page.evaluate).toHaveBeenCalledTimes(1);
    });
    it('normalizes a status detail into a post row using the HTML body', () => {
        expect(normalizeStatusDetail(statusDetail())).toEqual({
            type: 'post',
            id: '99380989',
            author: 'alice',
            text: 'hello world',
            parent_id: null,
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
            reply_count: 1,
        }))).toEqual({
            type: 'comment',
            id: '11',
            author: 'bob',
            text: 'nice',
            parent_id: null,
            reply_to: 'alice',
            likes: 0,
            replies: 1,
            retweets: 0,
            created_at: new Date(1700000001000).toISOString(),
            url: 'https://xueqiu.com/22/11',
        });
    });
    it('prefers the nested reply count and falls back to the root author as reply target', () => {
        expect(normalizeCommentItem(commentItem({ reply_count: 0, comment_reply_count: 13 }))).toMatchObject({ replies: 13, reply_to: null });
        const root = { id: '7', author: 'alice' };
        expect(normalizeCommentItem(commentItem({ reply_user: { screen_name: 'carol' } }), root)).toMatchObject({ parent_id: '7', reply_to: 'carol' });
        expect(normalizeCommentItem(commentItem(), root)).toMatchObject({ parent_id: '7', reply_to: 'alice' });
    });
    it('reads replies only from the requested comment thread', () => {
        const json = { comments: [{ id: 7, child_comments: [commentItem({ id: 71 })] }] };
        expect(getChildCommentItems(json, '7').map(item => item.id)).toEqual([71]);
        expect(getChildCommentItems(json, '8')).toBeNull();
        expect(getChildCommentItems({ comments: [] }, '7')).toEqual([]);
    });
    it('registers the xueqiu post command', () => {
        expect(command).toMatchObject({ site: 'xueqiu', name: 'post' });
        expect(command.args.find(arg => arg.name === 'user')).toMatchObject({ required: true });
    });
    it('rejects invalid status and comment_limit before navigating', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { user: '9089343523', status: '   ', comment_limit: 5 })).rejects.toThrow(ArgumentError);
        await expect(command.func(page, { user: '9089343523', status: '99380989', comment_limit: -1 })).rejects.toThrow(ArgumentError);
        await expect(command.func(page, { user: '9089343523', status: '99380989', comment_limit: 801 })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('returns the post row and skips comments when comment_limit is zero', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValueOnce(envelope(statusDetail())),
        };
        const result = await command.func(page, { user: '9089343523', status: '99380989', comment_limit: 0 });
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ type: 'post', id: '99380989', text: 'hello world' });
        expect(page.evaluate).toHaveBeenCalledTimes(1);
        expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('window\\.SNOWMAN_STATUS'));
        expect(page.evaluate.mock.calls[0][0]).not.toContain('fetch(');
    });
    it.each([
        ['https://xueqiu.com/9089343523/418596457', '9089343523', 'post page'],
        ['418596457', '9089343523', 'post page'],
    ])('stops on a detail HTTP 403 for %s and user %s without retrying or loading comments', async (status, user, source) => {
        const page = {
            goto: vi.fn(),
            // Even a usable-looking body must not override an HTTP refusal.
            evaluate: vi.fn().mockResolvedValue(envelope(statusDetail({ id: 418596457 }), { status: 403 })),
        };
        await expect(command.func(page, { status, user })).rejects.toMatchObject({
            name: 'CommandExecutionError',
            message: `Loading xueqiu post 418596457 (${source}): access denied (HTTP 403)`,
            hint: expect.stringContaining('automatic requests have stopped'),
        });
        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.evaluate).toHaveBeenCalledTimes(1);
        expect(mockWarn).not.toHaveBeenCalled();
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
        const result = await command.func(page, { user: '9089343523', status: 'https://xueqiu.com/9089343523/99380989', comment_limit: 5 });
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
            'parent_id',
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
    it('expands nested replies by default and reuses complete embedded threads', async () => {
        const embeddedReply = commentItem({ id: 111, text: 'already complete' });
        const firstReply = commentItem({ id: 121, text: 'first reply' });
        const secondReply = commentItem({ id: 122, text: 'second reply' });
        const thirdReply = commentItem({ id: 123, text: 'third reply', reply_screenName: 'carol' });
        function threadPage(replies, nextMaxId) {
            return envelope({ comments: [commentItem({ id: 12, child_comments: replies })], next_max_id: nextMaxId });
        }
        const page = {
            goto: vi.fn(),
            evaluate: vi.fn()
                .mockResolvedValueOnce(envelope(statusDetail()))
                .mockResolvedValueOnce(envelope({
                    comments: [
                        commentItem({ id: 11, reply_count: 1, child_comments: [embeddedReply] }),
                        commentItem({ id: 12, reply_count: 3, child_comments: [firstReply] }),
                    ],
                    next_max_id: -1,
                }))
                .mockResolvedValueOnce(threadPage([firstReply, secondReply], 122))
                .mockResolvedValueOnce(threadPage([secondReply, thirdReply], '-1')),
        };
        const rows = await command.func(page, { user: '9089343523', status: '99380989' });
        expect(rows.map(({ id, parent_id }) => [id, parent_id])).toEqual([
            ['99380989', null], ['11', null], ['111', '11'], ['12', null], ['121', '12'], ['122', '12'], ['123', '12'],
        ]);
        expect(rows.at(-1)).toMatchObject({ type: 'comment', text: 'third reply', reply_to: 'carol' });
        expect(page.evaluate).toHaveBeenCalledTimes(4);
        expect(page.evaluate).toHaveBeenNthCalledWith(3, expect.stringContaining('comment_id=12&type=4&child_type=2&max_id=-1'));
        expect(page.evaluate).toHaveBeenNthCalledWith(4, expect.stringContaining('max_id=122'));
        expect(mockWarn).not.toHaveBeenCalled();
    });
    it('counts only top-level comments toward comment_limit', async () => {
        const page = {
            goto: vi.fn(),
            evaluate: vi.fn()
                .mockResolvedValueOnce(envelope(statusDetail()))
                .mockResolvedValueOnce(envelope({ comments: [
                    commentItem({ id: 11, reply_count: 2, child_comments: [commentItem({ id: 111 }), commentItem({ id: 112 })] }),
                    commentItem({ id: 12 }),
                ] })),
        };
        const rows = await command.func(page, { user: '9089343523', status: '99380989', comment_limit: 1 });
        expect(rows.map(row => row.id)).toEqual(['99380989', '11', '111', '112']);
        expect(page.evaluate).toHaveBeenCalledTimes(2);
    });
    it('keeps fetched and embedded replies when a nested page is rate limited', async () => {
        const page = {
            goto: vi.fn(),
            evaluate: vi.fn()
                .mockResolvedValueOnce(envelope(statusDetail()))
                .mockResolvedValueOnce(envelope({ comments: [
                    commentItem({ id: 11, reply_count: 3, child_comments: [commentItem({ id: 111 })] }),
                    commentItem({ id: 12, reply_count: 2, child_comments: [commentItem({ id: 121 })] }),
                ] }))
                .mockResolvedValueOnce(envelope({
                    comments: [commentItem({ id: 11, child_comments: [commentItem({ id: 111 }), commentItem({ id: 112 })] })],
                    next_max_id: 112,
                }))
                .mockResolvedValueOnce(envelope(null, { status: 429 })),
        };
        const rows = await command.func(page, { user: '9089343523', status: '99380989' });
        expect(rows.map(({ id, parent_id }) => [id, parent_id])).toEqual([
            ['99380989', null], ['11', null], ['111', '11'], ['112', '11'], ['12', null], ['121', '12'],
        ]);
        expect(page.evaluate).toHaveBeenCalledTimes(4);
        expect(mockWarn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/comment 11.*2\/3.*HTTP 429/));
    });
    it.each([
        ['<script></script>', 'unexpected HTML response (HTTP 200, text/html)'],
        ['<script>/* EO_Bot_Ssid */</script>', 'browser verification required'],
    ])('stops on script-only HTML %s, preserving replies from earlier pages', async (textSnippet, reason) => {
        const page = {
            goto: vi.fn(),
            evaluate: vi.fn()
                .mockResolvedValueOnce(envelope(statusDetail()))
                .mockResolvedValueOnce(envelope({ comments: [
                    commentItem({ id: 11, reply_count: 3 }),
                    commentItem({ id: 12, reply_count: 2 }),
                ] }))
                .mockResolvedValueOnce(envelope({
                    comments: [commentItem({ id: 11, child_comments: [commentItem({ id: 111 })] })],
                    next_max_id: 111,
                }))
                .mockResolvedValueOnce(envelope(null, { contentType: 'text/html', textSnippet })),
        };
        const rows = await command.func(page, { user: '9089343523', status: '99380989' });
        expect(rows.map(row => row.id)).toEqual(['99380989', '11', '111', '12']);
        expect(page.evaluate).toHaveBeenCalledTimes(4);
        expect(mockWarn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(reason));
    });
    it('skips nested requests after a top-level page is restricted', async () => {
        const page = {
            goto: vi.fn(),
            evaluate: vi.fn()
                .mockResolvedValueOnce(envelope(statusDetail()))
                .mockResolvedValueOnce(envelope({
                    comments: [commentItem({ id: 11, reply_count: 3, child_comments: [commentItem({ id: 111 })] })],
                    next_max_id: 11,
                }))
                .mockResolvedValueOnce(envelope(null, { status: 403 })),
        };
        const rows = await command.func(page, { user: '9089343523', status: '99380989' });
        expect(rows.map(row => row.id)).toEqual(['99380989', '11', '111']);
        expect(page.evaluate).toHaveBeenCalledTimes(3);
        expect(mockWarn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('HTTP 403'));
    });
    it('throws empty-result when the post does not exist', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValueOnce(envelope({ error_description: '您访问的页面不存在', error_code: '20210' }, { status: 400 })),
        };
        const rejection = command.func(page, { user: '9089343523', status: '1', comment_limit: 5 });
        await expect(rejection).rejects.toThrow(EmptyResultError);
        await expect(rejection).rejects.toThrow('1');
    });
    it('reports browser verification when the detail page is a challenge', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValueOnce(envelope(null, {
                contentType: 'text/html',
                textSnippet: '<textarea id="renderData">{"_waf_bd8ce2ce37":"token"}</textarea>',
            })),
        };
        await expect(command.func(page, { user: '9089343523', status: '99380989', comment_limit: 5 })).rejects.toMatchObject({
            name: 'CommandExecutionError',
            message: expect.stringContaining('browser verification required'),
        });
        expect(page.evaluate).toHaveBeenCalledTimes(1);
    });
    it('keeps the post when the first comments page is rate limited', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce(envelope(statusDetail()))
                .mockResolvedValueOnce(envelope({ comments: [] }, { status: 429 })),
        };
        const result = await command.func(page, { user: '9089343523', status: '99380989', comment_limit: 3 });
        expect(result).toMatchObject([{ type: 'post', id: '99380989' }]);
        expect(page.evaluate).toHaveBeenCalledTimes(2);
        expect(page.evaluate).toHaveBeenNthCalledWith(2, expect.stringContaining('size=3'));
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('collected 0/3 items, reason: rate limit (HTTP 429)'));
    });
    it('throws command-execution when the first comments page is unusable', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi
                .fn()
                .mockResolvedValueOnce(envelope(statusDetail()))
                .mockResolvedValueOnce(envelope({ success: false, message: 'unexpected backend state' })),
        };
        const rejection = command.func(page, { user: '9089343523', status: '99380989', comment_limit: 5 });
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
        })).resolves.toMatchObject({
            comments: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }, { id: 3, text: 'c' }],
            interrupted: false,
        });
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
        })).resolves.toMatchObject({
            comments: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }],
            interrupted: true,
        });
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('2/5'));
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('browser verification required'));
    });
    it.each([-1, '-1'])('ends comment pagination quietly when next_max_id is %j', async (nextMaxId) => {
        const fetchPage = vi.fn().mockResolvedValueOnce(envelope({
            comments: [commentItem({ id: 1, text: 'a' })],
            next_max_id: nextMaxId,
        }));
        const result = await collectCommentRows({
            statusId: '99380989',
            limit: 20,
            pageSize: 20,
            maxPages: 5,
            fetchPage,
            warn: mockWarn,
        });
        expect(result.comments).toHaveLength(1);
        expect(fetchPage).toHaveBeenCalledTimes(1);
        expect(mockWarn).not.toHaveBeenCalled();
    });
});
