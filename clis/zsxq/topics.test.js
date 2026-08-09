import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { buildTopicsUrl } from './topics.js';
describe('zsxq topics command', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    it('requires an explicit group_id when there is no active group context', async () => {
        const command = getRegistry().get('zsxq/topics');
        expect(command?.func).toBeTypeOf('function');
        const mockPage = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(null),
        };
        await expect(command.func(mockPage, { limit: 20 })).rejects.toMatchObject({
            code: 'ARGUMENT',
            message: 'Cannot determine active group_id',
        });
        expect(mockPage.goto).toHaveBeenCalledWith('https://wx.zsxq.com');
        expect(mockPage.evaluate).toHaveBeenCalledTimes(2);
    });

    it('builds the API request with count, scope, and either time boundary', async () => {
        const command = getRegistry().get('zsxq/topics');
        const mockPage = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce({
                ok: true,
                data: {
                    succeeded: true,
                    resp_data: {
                        topics: [{
                                topic_id: 101,
                                type: 'q&a',
                                question: {
                                    text: 'A question',
                                    files: [{ file_id: 202, name: 'report.pdf' }],
                                },
                                answer: { text: 'An answer' },
                                talk: { files: [{ file_id: 202, name: 'report.pdf' }] },
                                comments_count: 2,
                                show_comments: [
                                    { comment_id: 1, owner: { name: 'Alice' }, text: 'First comment' },
                                    { comment_id: 2, parent_comment_id: 1, owner: { name: 'Bob' }, repliee: { name: 'Alice' }, text: 'A reply' },
                                ],
                            }],
                    },
                },
            }),
        };

        const result = await command.func(mockPage, {
            count: 7,
            scope: 'with_files',
            begin_time: '2026-08-06T12:40:04.266+0800',
            group_id: '51112282585554',
        });

        const requestScript = mockPage.evaluate.mock.calls[1][0];
        expect(requestScript).toContain('scope=with_files');
        expect(requestScript).toContain('count=7');
        expect(requestScript).toContain('begin_time=2026-08-06T12%3A40%3A04.266%2B0800');
        expect(requestScript).not.toContain('end_time=');
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            topic_id: 101,
            files: [{ file_id: 202, name: 'report.pdf' }],
            question: 'A question',
            answer: 'An answer',
            comments: 2,
            comment_preview: 'Alice: First comment | Bob -> Alice: A reply',
            comment_items: [
                {
                    author: 'Alice',
                    content: 'First comment',
                    replies: [{ author: 'Bob', reply_to: 'Alice', content: 'A reply' }],
                },
            ],
        });
        expect(result[0]).not.toHaveProperty('content');
        expect(result[0]).not.toHaveProperty('file_preview');
    });

    it('supports both time boundaries and keeps --limit as a compatibility alias', () => {
        const url = new URL(buildTopicsUrl('group/id', {
            count: 3,
            scope: 'digests',
            beginTime: '2026-08-06T12:40:04.266+0800',
            endTime: '2026-08-06T21:40:04.266+0800',
        }));

        expect(url.pathname).toBe('/v2/groups/group%2Fid/topics');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            scope: 'digests',
            count: '3',
            begin_time: '2026-08-06T12:40:04.266+0800',
            end_time: '2026-08-06T21:40:04.266+0800',
        });
        const command = getRegistry().get('zsxq/topics');
        expect(command.args.find(arg => arg.name === 'scope')?.choices).toEqual([
            'all', 'digests', 'by_owner', 'questions', 'with_files', 'with_images',
        ]);
        expect(command.args.find(arg => arg.name === 'limit')?.help).toContain('Deprecated');
    });
});
