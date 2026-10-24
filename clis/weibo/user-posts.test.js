import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import './user-posts.js';
import { testInternals } from './user-posts.js';

function envelope(data) {
    return { session: 'site:weibo:test', data };
}

function makePage(payload) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(payload),
    };
}

function makeExtractionPage(pages, wrap = false) {
    const page = makePage();
    page.fetch = vi.fn(async url => {
        if (!url.startsWith('/ajax/statuses/searchProfile?')) throw new Error(`Unexpected request: ${url}`);
        const index = Number(new URL(url, 'https://weibo.com').searchParams.get('page')) - 1;
        return { ok: true, status: 200, json: async () => ({ ok: 1, data: { list: pages[index] || [] } }) };
    });
    page.evaluate = vi.fn(async script => {
        const data = await new Function('fetch', `return (${script})`)(page.fetch);
        return wrap ? envelope(data) : data;
    });
    return page;
}

function status(index, overrides = {}) {
    return {
        idstr: String(5354759798396000 + index), mblogid: `post${index}`,
        user: { id: 5628009214, screen_name: 'Test author' }, text_raw: 'A post', pic_num: 0,
        ...overrides,
    };
}

describe('weibo user-posts', () => {
    const command = getRegistry().get('weibo/user-posts');

    it('validates id, limit, dates, and date ranges before navigation', async () => {
        await expect(command.func(makePage({ rows: [] }), { id: '', limit: 10 }))
            .rejects.toBeInstanceOf(ArgumentError);
        await expect(command.func(makePage({ rows: [] }), { id: '123', limit: 0 }))
            .rejects.toBeInstanceOf(ArgumentError);
        await expect(command.func(makePage({ rows: [] }), { id: '123', start: '2025-02-30', limit: 10 }))
            .rejects.toBeInstanceOf(ArgumentError);
        await expect(command.func(makePage({ rows: [] }), { id: '123', start: '2025-06-02', end: '2025-06-01', limit: 10 }))
            .rejects.toBeInstanceOf(ArgumentError);
    });

    it('converts Asia/Shanghai date boundaries to unix seconds', () => {
        expect(testInternals.dateToTimestamp('2025-06-01')).toBe(1748707200);
        expect(testInternals.dateToTimestamp('2025-01-01')).toBe(1735660800);
    });

    it('registers the type choices and defaults to all posts', () => {
        expect(command.args.find(arg => arg.name === 'type')).toMatchObject({
            default: '全部', choices: ['全部', '文字', '图文', '视频', '直播', '文章'],
        });
    });

    it.each(['图片', 'video', '', 'unknown'])('rejects invalid type %j before navigating', async type => {
        const page = makePage();
        await expect(command.func(page, { id: '5628009214', type })).rejects.toBeInstanceOf(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('unwraps browser bridge envelopes and returns stable listing rows', async () => {
        const page = makePage(envelope(['1670458304', [{
                id: '5012345678901234',
                mblogid: 'QD5uq0ydj',
                type: '图文',
                author: 'Alice',
                uid: '1670458304',
                text: 'hello',
                time: 'Sun Jun 01 10:00:00 +0800 2025',
                reposts: 1,
                comments: 2,
                likes: 3,
                pic_count: 4,
                url: 'https://weibo.com/1670458304/QD5uq0ydj',
            }], true, true]));

        await expect(command.func(page, {
            id: '1670458304',
            start: '2025-06-01',
            end: '2025-06-02',
            limit: 20,
        })).resolves.toEqual([{
            rank: 1,
            id: '5012345678901234',
            mblogid: 'QD5uq0ydj',
            type: '图文',
            author: 'Alice',
            uid: '1670458304',
            text: 'hello',
            time: 'Sun Jun 01 10:00:00 +0800 2025',
            reposts: 1,
            comments: 2,
            likes: 3,
            pic_count: 4,
            url: 'https://weibo.com/1670458304/QD5uq0ydj',
        }]);
    });

    it.each([
        [{}, '文字'],
        [{ pic_num: 2 }, '图文'],
        [{ pic_num: '2' }, '图文'],
        [{ pic_ids: ['photo'] }, '图文'],
        [{ pic_infos: { photo: { largest: { url: 'https://wx1.sinaimg.cn/large/photo.jpg' } } } }, '图文'],
        [{ page_info: { object_type: 'video', page_pic: 'https://wx1.sinaimg.cn/cover.jpg' }, pic_num: 1 }, '视频'],
        [{ page_info: { media_info: { media_type: 'video' } } }, '视频'],
        [{ page_info: { object_type: 'live', media_info: { live_status: 9 } } }, '直播'],
        [{ page_info: { object_type: 'live', media_info: { live_status: 3 } } }, '直播'],
        [{ page_info: { object_type: 'video', media_info: { live_id: '1022:room', media_type: 'video' } }, pic_num: 1 }, '直播'],
        [{ page_info: { object_type: 'article', page_pic: 'https://wx1.sinaimg.cn/cover.jpg' } }, '文章'],
        [{ page_info: { object_type: 'webpage', page_pic: 'https://wx1.sinaimg.cn/cover.jpg' } }, '文字'],
        [{ retweeted_status: { page_info: { object_type: 'video' } } }, '视频'],
        [{ retweeted_status: { page_info: { object_type: 'live' } } }, '直播'],
        [{ retweeted_status: { pic_num: 3 } }, '图文'],
        [{ retweeted_status: { page_info: { object_type: 'article' } } }, '文章'],
        [{ pic_num: 1, retweeted_status: { page_info: { object_type: 'video' } } }, '图文'],
        [{ retweeted_status: {} }, '文字'],
    ])('classifies listing metadata %j as %s through the browser script', async (metadata, expected) => {
        const page = makeExtractionPage([[status(1, metadata)]], true);
        const rows = await command.func(page, { id: '5628009214', limit: 20, 'include-retweets': true });
        expect(rows[0].type).toBe(expected);
        expect(Object.keys(rows[0])).toEqual(command.columns);
        expect(rows[0]).toMatchObject({ rank: 1, id: '5354759798396001', mblogid: 'post1', text: 'A post' });
        expect(page.fetch).toHaveBeenCalledTimes(1);
        expect(page.fetch.mock.calls[0][0]).toContain('hasret=1');
    });

    it('preserves types, ranks, and the requested limit across listing pages', async () => {
        const first = Array.from({ length: 10 }, (_, index) => status(index));
        const second = [
            status(10, { page_info: { object_type: 'video' } }),
            status(11, { page_info: { object_type: 'live' } }),
            status(12, { page_info: { object_type: 'article' } }),
        ];
        const page = makeExtractionPage([first, second]);
        const rows = await command.func(page, { id: '5628009214', limit: 12 });
        expect(rows).toHaveLength(12);
        expect(rows.slice(-2).map(row => [row.rank, row.type])).toEqual([[11, '视频'], [12, '直播']]);
        expect(rows.every(row => Object.keys(row).join(',') === command.columns.join(','))).toBe(true);
        expect(page.fetch).toHaveBeenCalledTimes(2);
        expect(page.fetch.mock.calls[1][0]).toContain('page=2');
    });

    it.each(['文字', '图文', '视频', '直播', '文章'])('filters by type %s', async type => {
        const list = [
            status(1), status(2, { pic_num: 1 }), status(3, { page_info: { object_type: 'video' } }),
            status(4, { page_info: { object_type: 'live' } }), status(5, { page_info: { object_type: 'article' } }),
        ];
        const page = makeExtractionPage([list], true);
        const rows = await command.func(page, { id: '5628009214', type, limit: 1 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ rank: 1, type });
        expect(Object.keys(rows[0])).toEqual(command.columns);
    });

    it('keeps the unfiltered result when type is 全部', async () => {
        const page = makeExtractionPage([[status(1), status(2, { pic_num: 1 })]]);
        const rows = await command.func(page, { id: '5628009214', type: '全部', limit: 10 });
        expect(rows.map(row => row.type)).toEqual(['文字', '图文']);
        expect(page.fetch).toHaveBeenCalledTimes(1);
    });

    it('continues past nonmatching and short pages, counting limit after filtering', async () => {
        const page = makeExtractionPage([
            [status(1), status(2, { pic_num: 1 })],
            [status(3, { page_info: { object_type: 'video' } })],
            [status(4, { retweeted_status: { page_info: { object_type: 'video' } } }), status(5)],
        ]);
        const rows = await command.func(page, {
            id: '5628009214', type: '视频', limit: 2,
            start: '2026-10-01', end: '2026-10-24', 'include-retweets': true,
        });
        expect(rows.map(row => [row.rank, row.mblogid, row.type])).toEqual([[1, 'post3', '视频'], [2, 'post4', '视频']]);
        expect(page.fetch).toHaveBeenCalledTimes(3);
        for (const [url] of page.fetch.mock.calls) {
            const params = new URL(url, 'https://weibo.com').searchParams;
            expect(params.get('hasret')).toBe('1');
            expect(params.get('starttime')).toBe(String(testInternals.dateToTimestamp('2026-10-01')));
            expect(params.get('endtime')).toBe(String(testInternals.dateToTimestamp('2026-10-24') + 86399));
        }
    });

    it('returns fewer matching rows only when the upstream list is exhausted', async () => {
        const page = makeExtractionPage([
            [status(1, { page_info: { object_type: 'live' } })],
            [status(2), status(3, { page_info: { object_type: 'live' } })],
        ]);
        const rows = await command.func(page, { id: '5628009214', type: '直播', limit: 5 });
        expect(rows.map(row => [row.rank, row.type])).toEqual([[1, '直播'], [2, '直播']]);
        expect(page.fetch).toHaveBeenCalledTimes(3);
    });

    it('reports no matching types as EmptyResultError rather than parser drift', async () => {
        const page = makeExtractionPage([[status(1)], [status(2, { pic_num: 1 })]]);
        await expect(command.func(page, { id: '5628009214', type: '直播', limit: 5 }))
            .rejects.toMatchObject({ code: 'EMPTY_RESULT', hint: expect.stringContaining('直播') });
        expect(page.fetch).toHaveBeenCalledTimes(3);
    });

    it('still reports parser drift when every candidate is invalid under a type filter', async () => {
        const page = makeExtractionPage([[{ idstr: '123' }]]);
        await expect(command.func(page, { id: '5628009214', type: '视频', limit: 5 }))
            .rejects.toBeInstanceOf(CommandExecutionError);
    });

    it.each([403, 503])('does not return partial filtered rows after HTTP %s', async code => {
        const page = makeExtractionPage([[status(1, { page_info: { object_type: 'video' } })]]);
        const original = page.fetch.getMockImplementation();
        page.fetch.mockImplementation(async url => new URL(url, 'https://weibo.com').searchParams.get('page') === '2'
            ? { ok: false, status: code } : original(url));
        await expect(command.func(page, { id: '5628009214', type: '视频', limit: 2 }))
            .rejects.toBeInstanceOf(code === 403 ? AuthRequiredError : CommandExecutionError);
    });

    it.each([0, 1])('reports the scan cap rather than returning %s incomplete matches', async matches => {
        const pages = Array.from({ length: 100 }, (_, index) => [status(index, matches && index === 0
            ? { page_info: { object_type: 'video' } } : {})]);
        const page = makeExtractionPage(pages);
        await expect(command.func(page, { id: '5628009214', type: '视频', limit: 2 }))
            .rejects.toThrow(`100-page scan limit with ${matches} matching posts`);
        expect(page.fetch).toHaveBeenCalledTimes(100);
    });

    it('maps auth-like evaluate errors to AuthRequiredError', async () => {
        await expect(command.func(makePage({ error: 'login required: HTTP 403' }), { id: '123', limit: 10 }))
            .rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('maps malformed payload and parser drift to CommandExecutionError', async () => {
        await expect(command.func(makePage({ rows: [] }), { id: '123', limit: 10 }))
            .rejects.toBeInstanceOf(CommandExecutionError);
        await expect(command.func(makePage({ error: 'Weibo user posts response did not include data.list' }), { id: '123', limit: 10 }))
            .rejects.toBeInstanceOf(CommandExecutionError);
        await expect(command.func(makePage(['123', [], true, true]), { id: '123', limit: 10 }))
            .rejects.toBeInstanceOf(CommandExecutionError);
    });

    it('maps true empty lists to EmptyResultError', async () => {
        await expect(command.func(makePage(['123', [], true, false]), { id: '123', limit: 10 }))
            .rejects.toBeInstanceOf(EmptyResultError);
    });
});
