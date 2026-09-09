import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './topic.js';
describe('zsxq topic command', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    it('fetches topic detail and comments from the group-independent /v2/topics endpoints', async () => {
        const command = getRegistry().get('zsxq/topic');
        expect(command?.func).toBeTypeOf('function');
        const evaluateUrls = [];
        const mockPage = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://api.zsxq.com/v2/groups', data: { succeeded: true, resp_data: { groups: [] } } }) // ensureZsxqAuth
                .mockImplementationOnce(async (code) => {
                evaluateUrls.push(code);
                return {
                    ok: true,
                    status: 200,
                    url: 'https://api.zsxq.com/v2/topics/1/info',
                    data: {
                        succeeded: true,
                        resp_data: {
                            topic_id: 1,
                            type: 'talk',
                            talk: { owner: { name: 'alice' }, text: 'hello topic' },
                            comments_count: 1,
                            likes_count: 2,
                        },
                    },
                };
            })
                .mockImplementationOnce(async (code) => {
                evaluateUrls.push(code);
                return {
                    ok: true,
                    status: 200,
                    url: 'https://api.zsxq.com/v2/topics/1/comments',
                    data: {
                        succeeded: true,
                        resp_data: { comments: [{ owner: { name: 'bob' }, text: 'hi' }] },
                    },
                };
            }),
        };
        const rows = await command.func(mockPage, { id: '1', comment_limit: 20 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            topic_id: 1,
            author: 'alice',
            title: 'hello topic',
            comments: 1,
            likes: 2,
        });
        expect(rows[0].comment_preview).toContain('bob: hi');
        expect(evaluateUrls.join('\n')).toContain('/v2/topics/1/info');
        expect(evaluateUrls.join('\n')).toContain('/v2/topics/1/comments');
        expect(evaluateUrls.join('\n')).not.toContain('/v2/groups/');
    });
    it('maps API 1007 missing-topic responses to NOT_FOUND', async () => {
        const command = getRegistry().get('zsxq/topic');
        const mockPage = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://api.zsxq.com/v2/groups', data: { succeeded: true, resp_data: { groups: [] } } }) // ensureZsxqAuth
                .mockResolvedValueOnce({
                ok: true,
                status: 200,
                url: 'https://api.zsxq.com/v2/topics/404/info',
                data: { succeeded: false, code: 1007, info: '', error: '主题不存在或已被删除' },
            }),
        };
        await expect(command.func(mockPage, { id: '404', comment_limit: 20 })).rejects.toMatchObject({
            code: 'NOT_FOUND',
            message: 'Topic 404 not found',
        });
    });
    it('surfaces 1059 risk-control responses with the API code', async () => {
        const command = getRegistry().get('zsxq/topic');
        const mockPage = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://api.zsxq.com/v2/groups', data: { succeeded: true, resp_data: { groups: [] } } }) // ensureZsxqAuth
                .mockResolvedValueOnce({
                ok: true,
                status: 200,
                url: 'https://api.zsxq.com/v2/topics/1/info',
                data: { succeeded: false, code: 1059, info: '不支持非官方工具访问', resp_data: {} },
            }),
        };
        await expect(command.func(mockPage, { id: '1', comment_limit: 20 })).rejects.toMatchObject({
            code: '1059',
            message: '不支持非官方工具访问',
        });
    });
    it('maps topic detail 404 responses to NOT_FOUND before fetching comments', async () => {
        const command = getRegistry().get('zsxq/topic');
        const mockPage = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://api.zsxq.com/v2/groups', data: { succeeded: true, resp_data: { groups: [] } } }) // ensureZsxqAuth
                .mockResolvedValueOnce({
                ok: true,
                status: 404,
                url: 'https://api.zsxq.com/v2/topics/404/info',
                data: null,
            }),
        };
        await expect(command.func(mockPage, { id: '404', comment_limit: 20 })).rejects.toMatchObject({
            code: 'NOT_FOUND',
            message: 'Topic 404 not found',
        });
        expect(mockPage.goto).toHaveBeenCalledWith('https://wx.zsxq.com');
    });
    it('retries the adjacent topic_uid when /info returns 1007 for the listed topic_id', async () => {
        const command = getRegistry().get('zsxq/topic');
        const evaluateUrls = [];
        const mockPage = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://api.zsxq.com/v2/groups', data: { succeeded: true, resp_data: { groups: [] } } })
                .mockImplementation(async (code) => {
                evaluateUrls.push(code);
                if (code.includes('/v2/topics/10/info')) {
                    return { ok: true, status: 200, url: 'https://api.zsxq.com/v2/topics/10/info', data: { succeeded: false, code: 1007, error: '主题不存在或已被删除' } };
                }
                if (code.includes('/v2/topics/11/info')) {
                    return {
                        ok: true,
                        status: 200,
                        url: 'https://api.zsxq.com/v2/topics/11/info',
                        data: {
                            succeeded: true,
                            resp_data: {
                                topic: {
                                    topic_id: 10,
                                    topic_uid: '11',
                                    type: 'talk',
                                    talk: { owner: { name: 'alice' }, text: 'hello' },
                                    comments_count: 0,
                                },
                            },
                        },
                    };
                }
                if (code.includes('/comments')) {
                    return { ok: true, status: 200, data: { succeeded: true, resp_data: { comments: [] } } };
                }
                return { ok: false, status: 500, error: 'unexpected' };
            }),
        };
        const rows = await command.func(mockPage, { id: '10', comment_limit: 5 });
        expect(rows[0]).toMatchObject({ topic_id: 10, topic_uid: '11', author: 'alice' });
        expect(evaluateUrls.join('\n')).toContain('/v2/topics/10/info');
        expect(evaluateUrls.join('\n')).toContain('/v2/topics/11/info');
        expect(evaluateUrls.join('\n')).toContain('/v2/topics/11/comments');
    });
});
