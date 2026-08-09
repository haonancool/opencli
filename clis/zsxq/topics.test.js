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
                                type: 'talk',
                                talk: {
                                    text: 'Attachment topic',
                                    files: [{ file_id: 202, name: 'report.pdf' }],
                                },
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
            file_preview: '202:report.pdf',
        });
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
