import { describe, expect, it, vi } from 'vitest';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import './post.js';

const command = getRegistry().get('weibo/post');

// Execute the actual browser script so these tests catch extraction regressions,
// including regex escaping inside the page.evaluate template string.
function makePage(status, { envelope = false, longtext, room, roomStatus = 200 } = {}) {
    const fetch = vi.fn(async (url) => {
        if (url.startsWith('/l/!/2/wblive/room/show_pc_live.json')) {
            return {
                ok: roomStatus >= 200 && roomStatus < 300,
                status: roomStatus,
                json: async () => typeof room === 'function' ? room(url) : room ?? {
                    code: 100000, error_code: 0,
                    data: { liveId: new URL(url, 'https://weibo.com').searchParams.get('live_id'), endTime: 0 },
                },
            };
        }
        return { ok: true, json: async () => url.startsWith('/ajax/statuses/longtext') ? longtext : status };
    });
    return {
        fetch,
        goto: vi.fn(),
        wait: vi.fn(),
        evaluate: vi.fn(async script => {
            const data = await new Function('fetch', `return (${script})`)(fetch);
            return envelope ? { session: 'site:weibo:test', data } : data;
        }),
    };
}

function post(overrides = {}) {
    return {
        idstr: '5354759798396074',
        mblogid: 'RmYyfzecy',
        user: { id: 5628009214, screen_name: 'Test author' },
        text_raw: 'A post',
        pic_num: 0,
        ...overrides,
    };
}

async function read(status, options) {
    const page = makePage(status, options);
    const rows = await command.func(page, { id: status.mblogid });
    expect(rows.every(row => Object.keys(row).join(',') === command.columns.join(','))).toBe(true);
    expect(rows.some(row => ['m3u8_url', 'retweeted_m3u8_url'].includes(row.field))).toBe(false);
    return { fields: Object.fromEntries(rows.map(row => [row.field, row.value])), page };
}

describe('weibo post media', () => {
    it.each([
        [{}, '文字'],
        [{ pic_num: 2 }, '图文'],
        [{ pic_ids: ['photo'] }, '图文'],
        [{ pic_infos: { photo: {} } }, '图文'],
        [{ page_info: { object_type: 'video' }, pic_num: 1 }, '视频'],
        [{ page_info: { media_info: { media_type: 'video' } } }, '视频'],
        [{ page_info: { object_type: 'live', media_info: { live_status: 9 } } }, '直播'],
        [{ page_info: { object_type: 'video', media_info: { live_id: '1022:room' } } }, '直播'],
        [{ page_info: { object_type: 'article' } }, '文章'],
        [{ retweeted_status: { page_info: { object_type: 'video' } } }, '视频'],
        [{ retweeted_status: { page_info: { object_type: 'live' } } }, '直播'],
        [{ pic_num: 1, retweeted_status: { page_info: { object_type: 'video' } } }, '图文'],
    ])('returns post type %s with the same rules as user-posts: %s', async (metadata, expected) => {
        const { fields } = await read(post(metadata), { envelope: true });
        expect(fields.type).toBe(expected);
    });

    it('returns largest images in pic_ids order and preserves existing fields', async () => {
        const { fields, page } = await read(post({
            pic_num: 2,
            pic_ids: ['second', 'first'],
            pic_infos: {
                first: { largest: { url: 'https://wx1.sinaimg.cn/large/first.jpg' } },
                second: {
                    largest: { url: 'https://wx2.sinaimg.cn/large/second.gif' },
                    original: { url: 'https://wx2.sinaimg.cn/orj1080/second.gif' },
                },
            },
        }), { envelope: true });

        expect(JSON.parse(fields.pic_urls)).toEqual([
            'https://wx2.sinaimg.cn/large/second.gif',
            'https://wx1.sinaimg.cn/large/first.jpg',
        ]);
        expect(fields).toMatchObject({
            id: '5354759798396074', author: 'Test author', text: 'A post', pic_count: '2',
            video_url: '', live_url: '', url: 'https://weibo.com/5628009214/RmYyfzecy',
        });
        expect(page.fetch).toHaveBeenCalledExactlyOnceWith('/ajax/statuses/show?id=RmYyfzecy', { credentials: 'include' });
    });

    it('falls back through available image sizes, normalizes URLs and deduplicates', async () => {
        const { fields } = await read(post({
            pic_ids: [],
            pic_infos: {
                a: { largest: { url: '' }, original: { url: '//wx1.sinaimg.cn/original/a.jpg' } },
                b: { large: { url: 'https://wx1.sinaimg.cn/large/b.jpg' } },
                c: { bmiddle: { url: 'https://wx1.sinaimg.cn/bmiddle/c.jpg' } },
                d: { thumbnail: { url: 'https://wx1.sinaimg.cn/thumb/d.jpg' } },
                duplicate: { original: { url: '//wx1.sinaimg.cn/original/a.jpg' } },
                missing: {},
                invalid: { largest: { url: 'javascript:bad' } },
            },
        }));
        expect(JSON.parse(fields.pic_urls)).toEqual([
            'https://wx1.sinaimg.cn/original/a.jpg',
            'https://wx1.sinaimg.cn/large/b.jpg',
            'https://wx1.sinaimg.cn/bmiddle/c.jpg',
            'https://wx1.sinaimg.cn/thumb/d.jpg',
        ]);
    });

    it('handles a missing pic_info entry without inventing a URL', async () => {
        const { fields } = await read(post({ pic_num: 1, pic_ids: ['missing'] }));
        expect(fields.pic_count).toBe('1');
        expect(JSON.parse(fields.pic_urls)).toEqual([]);
    });

    it('selects the highest quality playback video and skips scrubber images and audio', async () => {
        const { fields } = await read(post({
            page_info: {
                object_type: 'video',
                media_info: {
                    stream_url_hd: 'http://f.video.weibocdn.com/fallback.mp4',
                    playback_list: [
                        { meta: { quality_index: 480 }, play_info: { mime: 'video/mp4', url: 'https://f.video.weibocdn.com/sd.mp4' } },
                        { meta: { quality_index: 2160 }, play_info: { mime: 'image/jpeg', url: 'https://wx1.sinaimg.cn/scrubber.jpg' } },
                        { meta: { quality_index: 1080 }, play_info: { mime: 'audio/mp4', url: 'https://f.video.weibocdn.com/audio.mp4' } },
                        { meta: { quality_index: 720 }, play_info: { mime: 'video/mp4', url: 'https://f.video.weibocdn.com/hd.mp4?Expires=123&ssig=a%2Fb' } },
                    ],
                },
            },
        }));
        expect(fields.video_url).toBe('https://f.video.weibocdn.com/hd.mp4?Expires=123&ssig=a%2Fb');
        expect(fields.live_url).toBe('');
        expect(JSON.parse(fields.pic_urls)).toEqual([]);
    });

    it('returns the TV page heading as video_title while preserving the post text', async () => {
        const { fields, page } = await read(post({
            text_raw: '以后开特斯拉再也不担心堵车了 #特斯拉roadster真的会飞#',
            page_info: {
                object_type: 'video',
                page_title: '股市小杨哥的微博视频',
                content2: '以后开特斯拉飞行汽车再也不担心堵车了',
                media_info: { name: 'An older heading', kol_title: 'Post caption', next_title: 'Related caption' },
            },
        }), { envelope: true });
        expect(fields.video_title).toBe('股市小杨哥的微博视频');
        expect(fields.text).toBe('以后开特斯拉再也不担心堵车了 #特斯拉roadster真的会飞#');
        expect(page.fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        { object_type: 'video', page_title: ' ', media_info: { name: '<b>摩西电影的微博视频</b>&nbsp;&amp;更多' } },
        { object_type: 'video', content1: '<b>摩西电影的微博视频</b>&nbsp;&amp;更多' },
        { media_info: { media_type: 'video', name: '<b>摩西电影的微博视频</b>&nbsp;&amp;更多' } },
        { media_info: { stream_url: 'https://f.video.weibocdn.com/video.mp4', name: '<b>摩西电影的微博视频</b>&nbsp;&amp;更多' } },
    ])('falls back to available video heading fields and strips markup: %j', async page_info => {
        const { fields } = await read(post({ page_info }));
        expect(fields.video_title).toBe('摩西电影的微博视频 &更多');
    });

    it('leaves absent video titles empty instead of using a caption', async () => {
        const { fields } = await read(post({
            page_info: { object_type: 'video', content2: 'Caption', media_info: { kol_title: 'Caption' } },
        }));
        expect(fields.video_title).toBe('');
    });

    it.each(['live', 'article'])('does not use a %s page heading as video_title', async object_type => {
        const { fields } = await read(post({
            page_info: { object_type, page_title: 'A non-video heading', media_info: { name: 'A non-video name' } },
        }));
        expect(fields.video_title).toBe('');
    });

    it('keeps retweeted video titles separate from the outer post', async () => {
        const { fields } = await read(post({
            retweeted_status: { page_info: {
                object_type: 'video', page_title: '摩西电影的微博视频',
                media_info: { stream_url: 'https://f.video.weibocdn.com/original.mp4' },
            } },
        }));
        expect(fields.video_title).toBe('');
        expect(fields.retweeted_video_title).toBe('摩西电影的微博视频');
        expect(fields.retweeted_video_url).toBe('https://f.video.weibocdn.com/original.mp4');
    });

    it.each(['stream_url_hd', 'mp4_720p_mp4', 'mp4_hd_url', 'stream_url', 'mp4_sd_url'])(
        'supports legacy video field %s without playback_list', async key => {
            const { fields } = await read(post({
                page_info: { object_type: 'video', media_info: { [key]: 'https://f.video.weibocdn.com/video.mp4' } },
            }));
            expect(fields.video_url).toBe('https://f.video.weibocdn.com/video.mp4');
        },
    );

    it('returns a video HLS playlist when playback uses HLS', async () => {
        const { fields } = await read(post({
            page_info: { object_type: 'video', media_info: { playback_list: [
                { play_info: { mime: 'application/x-mpegURL', url: '//f.video.weibocdn.com/video.m3u8?token=abc' } },
            ] } },
        }));
        expect(fields.video_url).toBe('https://f.video.weibocdn.com/video.m3u8?token=abc');
        expect(fields.live_url).toBe(fields.video_url);
    });

    it('returns the replay HD m3u8 instead of the room/play API endpoint', async () => {
        const { fields } = await read(post({
            page_info: { object_type: 'live', media_info: {
                live_id: '1022:2321325355288961351726',
                stream_url: 'https://wblive-out.api.weibo.com/2/wblive/room/play?id=1022:2321325355288961351726',
                replay_hd: 'http://live.video.weibocdn.com/replay_hd_index.m3u8',
                replay_ld: 'http://live.video.weibocdn.com/replay_ld_index.m3u8',
                live_ld: 'https://plwb00.live.weibo.com/alicdn/live.m3u8',
            } },
        }));
        expect(fields.live_url).toBe('http://live.video.weibocdn.com/replay_hd_index.m3u8');
        expect(fields.video_url).toBe('');
    });

    it.each(['replay_ld', 'live_hd', 'live_ld', 'stream_url'])(
        'falls back to a direct live playlist in %s', async key => {
            const { fields } = await read(post({
                page_info: { media_info: { live_id: '1022:room', [key]: '//live.video.weibocdn.com/replay.m3u8?x=1&y=2' } },
            }));
            expect(fields.live_url).toBe('https://live.video.weibocdn.com/replay.m3u8?x=1&y=2');
            expect(fields.video_url).toBe('');
        },
    );

    it('does not invent a playlist for an upcoming live broadcast', async () => {
        const { fields } = await read(post({
            page_info: { object_type: 'live', media_info: {
                live_status: 9,
                stream_url: 'https://wblive-out.api.weibo.com/2/wblive/room/play?id=1022:room',
            } },
        }));
        expect(fields.video_url).toBe('');
        expect(fields.live_url).toBe('');
        expect(fields.live_status).toBe('未开播');
    });

    it.each([
        [0, '未开播'], ['0', '未开播'], [9, '未开播'], ['9', '未开播'],
        [1, '直播中'], ['1', '直播中'], [3, '直播结束'], ['3', '直播结束'],
    ])('maps live status %s to %s', async (live_status, expected) => {
        const { fields } = await read(post({
            page_info: { object_type: 'live', media_info: { live_status } },
        }));
        expect(fields.live_status).toBe(expected);
    });

    it('prefers real_status and preserves zero as an explicit upcoming state', async () => {
        const { fields } = await read(post({
            page_info: { object_type: 'live', status: '3', media_info: { real_status: 0, live_status: 1 } },
        }));
        expect(fields.live_status).toBe('未开播');
    });

    it('falls back to the card status when media status is unavailable', async () => {
        const { fields } = await read(post({
            page_info: { object_type: 'live', status: '3', media_info: { real_status: null } },
        }));
        expect(fields.live_status).toBe('直播结束');
    });

    it.each([undefined, null, '', 2, 99, 'toString'])('leaves missing or unrecognized live status %s null', async live_status => {
        const { fields } = await read(post({
            page_info: { object_type: 'live', media_info: {
                live_status, replay_hd: 'https://live.video.weibocdn.com/replay.m3u8',
            } },
        }));
        expect(fields.live_status).toBeNull();
    });

    it('leaves live status empty on non-live posts', async () => {
        const { fields } = await read(post({
            page_info: { object_type: 'video', status: '1', media_info: { live_status: 1 } },
        }));
        expect(fields.live_status).toBe('');
    });

    it.each([1792324834, '1792324834'])(
        'returns live start timestamp %s as ISO time with an explicit UTC+08:00 offset', async live_start_time => {
            const { fields } = await read(post({
                created_at: 'Sun Oct 18 08:41:00 +0800 2026',
                page_info: { object_type: 'live', media_info: { live_status: 3, live_start_time } },
            }));
            expect(fields.live_start_time).toBe('2026-10-18T20:00:34+08:00');
            expect(fields.created_at).toBe('Sun Oct 18 08:41:00 +0800 2026');
        },
    );

    it('returns the scheduled start time for an upcoming live broadcast', async () => {
        const { fields } = await read(post({
            page_info: { object_type: 'live', media_info: {
                real_status: 0, live_status: 9, live_start_time: 1792929600,
            } },
        }));
        expect(fields.live_status).toBe('未开播');
        expect(fields.live_start_time).toBe('2026-10-25T20:00:00+08:00');
    });

    it.each([undefined, null, '', 0, -1, 'invalid', 1.5, 1e30, true, []])(
        'leaves unavailable or invalid live start time %s null', async live_start_time => {
            const { fields } = await read(post({
                page_info: { object_type: 'live', media_info: { live_start_time } },
            }));
            expect(fields.live_start_time).toBeNull();
        },
    );

    it('leaves live start time empty on non-live posts', async () => {
        const { fields } = await read(post({
            page_info: { object_type: 'video', media_info: { live_start_time: 1792324834 } },
        }));
        expect(fields.live_start_time).toBe('');
        expect(fields.live_end_time).toBe('');
    });

    it.each([
        [1792327850000, '2026-10-18T20:50:50+08:00'],
        ['1792327850000', '2026-10-18T20:50:50+08:00'],
        [1792327850123, '2026-10-18T20:50:50.123+08:00'],
    ])('reads room endTime %s in milliseconds with the correct timezone', async (endTime, expected) => {
        const liveId = '1022:2321325355288961351726';
        const { fields, page } = await read(post({
            page_info: { object_type: 'live', media_info: {
                live_id: liveId, live_status: 3, live_start_time: 1792324834,
            } },
        }), { envelope: true, room: { code: 100000, data: { liveId, endTime } } });
        expect(fields.live_end_time).toBe(expected);
        expect(fields.live_start_time).toBe('2026-10-18T20:00:34+08:00');
        expect(page.fetch).toHaveBeenCalledWith(
            '/l/!/2/wblive/room/show_pc_live.json?live_id=1022%3A2321325355288961351726',
            { credentials: 'include' },
        );
    });

    it.each([0, 1])('returns null end time for an unfinished room with status %s', async live_status => {
        const { fields } = await read(post({
            page_info: { object_type: 'live', media_info: { live_id: '1022:room', live_status } },
        }));
        expect(fields.live_end_time).toBeNull();
    });

    it.each([undefined, null, -1, 'invalid', 1e30])('does not invent an end time for invalid endTime %s', async endTime => {
        const { fields } = await read(post({
            page_info: { object_type: 'live', media_info: { live_id: '1022:room', live_status: 3 } },
        }), { room: { code: 100000, data: { liveId: '1022:room', endTime } } });
        expect(fields.live_end_time).toBeNull();
    });

    it('uses a live card object_id when media.live_id is missing', async () => {
        const { fields } = await read(post({
            page_info: { object_type: 'live', object_id: '1022:room' },
        }), { room: { code: 100000, data: { liveId: '1022:room', endTime: 1792327850000 } } });
        expect(fields.live_end_time).toBe('2026-10-18T20:50:50+08:00');
    });

    it('returns null without querying an unrelated room when a live card has no room ID', async () => {
        const { fields, page } = await read(post({ page_info: { object_type: 'live' } }));
        expect(fields.live_end_time).toBeNull();
        expect(page.fetch).toHaveBeenCalledTimes(1);
    });

    it('shares one room request for the same live broadcast in the outer and retweeted posts', async () => {
        const info = { object_type: 'live', media_info: { live_id: '1022:room' } };
        const { fields, page } = await read(post({ page_info: info, retweeted_status: { page_info: info } }), {
            room: { code: 100000, data: { liveId: '1022:room', endTime: 1792327850000 } },
        });
        expect(fields.live_end_time).toBe('2026-10-18T20:50:50+08:00');
        expect(fields.retweeted_live_end_time).toBe(fields.live_end_time);
        expect(page.fetch).toHaveBeenCalledTimes(2);
    });

    it('keeps end times separate when the outer and retweeted posts have different rooms', async () => {
        const { fields, page } = await read(post({
            page_info: { object_type: 'live', media_info: { live_id: '1022:outer' } },
            retweeted_status: { page_info: { object_type: 'live', media_info: { live_id: '1022:original' } } },
        }), { room: url => {
            const liveId = new URL(url, 'https://weibo.com').searchParams.get('live_id');
            return { code: 100000, data: { liveId, endTime: liveId === '1022:outer' ? 1792327850000 : 1792327950000 } };
        } });
        expect(fields.live_end_time).toBe('2026-10-18T20:50:50+08:00');
        expect(fields.retweeted_live_end_time).toBe('2026-10-18T20:52:30+08:00');
        expect(page.fetch).toHaveBeenCalledTimes(3);
    });

    it.each([
        { roomStatus: 503 },
        { room: { code: 100001, error_code: 1, msg: 'Room unavailable' } },
        { room: { code: 100000, data: { liveId: '1022:other', endTime: 1792327850000 } } },
        { room: () => { throw new Error('Malformed room JSON'); } },
    ])('propagates room lookup failures as typed errors: %j', async options => {
        const page = makePage(post({ page_info: { object_type: 'live', media_info: { live_id: '1022:room' } } }), options);
        await expect(command.func(page, { id: 'RmYyfzecy' })).rejects.toBeInstanceOf(CommandExecutionError);
    });

    it('returns the room title from page_desc instead of the generic live card label', async () => {
        const { fields, page } = await read(post({
            mblogid: 'Rnclb526U',
            page_info: {
                object_type: 'live',
                page_title: 'Test author的微博直播',
                page_desc: '下周很关键',
                content2: 'An older title',
                media_info: { replay_hd: 'http://live.video.weibocdn.com/replay.m3u8' },
            },
        }));
        expect(fields.live_title).toBe('下周很关键');
        expect(fields.live_url).toBe('http://live.video.weibocdn.com/replay.m3u8');
        expect(page.fetch).toHaveBeenCalledTimes(1);
    });

    it('falls back to content2 for live cards and strips title markup', async () => {
        const { fields } = await read(post({
            page_info: {
                page_desc: ' ',
                content2: '<b>下周起飞？</b>&nbsp;&amp;复盘',
                media_info: { live_id: '1022:room', live_status: 9 },
            },
        }));
        expect(fields.live_title).toBe('下周起飞？ &复盘');
    });

    it('does not use article descriptions or generic live labels as room titles', async () => {
        const article = await read(post({ page_info: { object_type: 'article', page_desc: 'Article description' } }));
        expect(article.fields.live_title).toBe('');
        const live = await read(post({ page_info: { object_type: 'live', page_title: 'Test author的微博直播' } }));
        expect(live.fields.live_title).toBe('');
    });

    it('keeps retweeted images and replay links separate from the outer post', async () => {
        const { fields } = await read(post({
            retweeted_status: {
                user: { screen_name: 'Original author' }, text: '<b>Original</b>',
                pic_infos: { a: { largest: { url: 'https://wx1.sinaimg.cn/large/a.jpg' } } },
                page_info: { object_type: 'live', page_desc: 'Original room title', media_info: {
                    live_status: 3, live_start_time: 1792324834, replay_hd: 'https://live.video.weibocdn.com/original.m3u8',
                } },
            },
        }));
        expect(fields).toMatchObject({
            pic_urls: '[]', video_url: '', live_url: '',
            type: '直播', retweeted_type: '直播',
            retweeted_from: 'Original author', retweeted_text: 'Original',
            retweeted_pic_urls: '["https://wx1.sinaimg.cn/large/a.jpg"]',
            retweeted_video_url: '', retweeted_live_url: 'https://live.video.weibocdn.com/original.m3u8',
            live_title: '', retweeted_live_title: 'Original room title',
            live_status: '', retweeted_live_status: '直播结束',
            live_start_time: '', retweeted_live_start_time: '2026-10-18T20:00:34+08:00',
        });
    });

    it('extracts a retweeted video and tolerates deleted originals', async () => {
        const { fields } = await read(post({
            retweeted_status: { page_info: { media_info: { stream_url: 'https://f.video.weibocdn.com/original.mp4' } } },
        }));
        expect(fields.retweeted_from).toBe('[deleted]');
        expect(fields.retweeted_video_url).toBe('https://f.video.weibocdn.com/original.mp4');
    });

    it('preserves long text fetching and handles text-only posts', async () => {
        const { fields } = await read(post({ isLongText: true }), {
            longtext: { data: { longTextContent: '<b>Full text</b> &amp; more' } },
        });
        expect(fields.text).toBe('Full text & more');
        expect(fields.type).toBe('文字');
        expect(fields).not.toHaveProperty('retweeted_type');
        expect(fields).toMatchObject({ pic_urls: '[]', video_url: '', live_url: '' });
        expect(fields).not.toHaveProperty('retweeted_pic_urls');
    });

    it('still propagates API errors as typed failures', async () => {
        await expect(command.func(makePage({ ok: 0 }), { id: 'missing' }))
            .rejects.toBeInstanceOf(CommandExecutionError);
        const page = makePage(post());
        page.fetch.mockResolvedValue({ ok: false, status: 403 });
        await expect(command.func(page, { id: 'blocked' })).rejects.toThrow('HTTP 403');
    });
});
