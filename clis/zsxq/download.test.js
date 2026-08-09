import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';

const { mockHttpDownload } = vi.hoisted(() => ({
    mockHttpDownload: vi.fn(),
}));
vi.mock('@jackwener/opencli/download', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, httpDownload: mockHttpDownload };
});

const { __test__ } = await import('./download.js');

describe('zsxq download command', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mockHttpDownload.mockReset();
    });

    it('downloads the signed URL returned for a file id', async () => {
        const command = getRegistry().get('zsxq/download');
        const mockPage = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce({
                ok: true,
                data: {
                    succeeded: true,
                    resp_data: {
                        download_url: 'https://download.zsxq.com/path/server-name?attname=API%20report.pdf&token=abc',
                    },
                },
            }),
        };
        mockHttpDownload.mockResolvedValue({ success: true, size: 2048 });

        const result = await command.func(mockPage, {
            file_id: '181288214421242',
            output: '/tmp/zsxq',
            name: 'Quarterly report.pdf',
        });

        expect(mockPage.goto).toHaveBeenCalledWith('https://wx.zsxq.com');
        expect(mockPage.evaluate.mock.calls[1][0]).toContain('/v2/files/181288214421242/download_url');
        expect(mockHttpDownload).toHaveBeenCalledWith(
            'https://download.zsxq.com/path/server-name?attname=API%20report.pdf&token=abc',
            '/tmp/zsxq/Quarterly report.pdf',
            { timeout: 60000 },
        );
        expect(result).toEqual([{
                file_id: '181288214421242',
                name: 'Quarterly report.pdf',
                status: 'success',
                size: '2.0 KB',
                path: '/tmp/zsxq/Quarterly report.pdf',
            }]);
    });

    it('rejects invalid file ids before requesting a download URL', async () => {
        const command = getRegistry().get('zsxq/download');
        const mockPage = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValueOnce(true),
        };

        await expect(command.func(mockPage, { file_id: '../secret' })).rejects.toMatchObject({
            code: 'ARGUMENT',
        });
        expect(mockPage.evaluate).toHaveBeenCalledTimes(1);
        expect(mockHttpDownload).not.toHaveBeenCalled();
    });

    it('reports a typed error when the file transfer fails', async () => {
        const command = getRegistry().get('zsxq/download');
        const mockPage = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce({
                ok: true,
                data: { succeeded: true, resp_data: { download_url: 'https://download.zsxq.com/a.pdf' } },
            }),
        };
        mockHttpDownload.mockResolvedValue({ success: false, size: 0, error: 'HTTP 403' });

        await expect(command.func(mockPage, { file_id: '123' })).rejects.toMatchObject({
            code: 'COMMAND_EXEC',
            message: 'Failed to download ZSXQ file 123: HTTP 403',
        });
    });

    it('defaults to the current directory and decodes attname as the filename', async () => {
        const command = getRegistry().get('zsxq/download');
        const mockPage = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce({
                ok: true,
                data: {
                    succeeded: true,
                    resp_data: {
                        download_url: 'https://files.zsxq.com/blob?attname=%E5%91%A8%E5%A4%8D%E7%9B%9820260809.pdf&token=abc',
                    },
                },
            }),
        };
        mockHttpDownload.mockResolvedValue({ success: true, size: 1024 });

        const result = await command.func(mockPage, { file_id: '181288214421242' });

        expect(command.args.find(arg => arg.name === 'output')?.default).toBe('.');
        expect(mockHttpDownload).toHaveBeenCalledWith(
            'https://files.zsxq.com/blob?attname=%E5%91%A8%E5%A4%8D%E7%9B%9820260809.pdf&token=abc',
            '周复盘20260809.pdf',
            { timeout: 60000 },
        );
        expect(result[0]).toMatchObject({
            name: '周复盘20260809.pdf',
            path: '周复盘20260809.pdf',
        });
    });

    it('derives a safe filename from explicit metadata or the signed URL path as fallbacks', () => {
        expect(__test__.filenameFromDownload('123', '', 'folder/report 2026.pdf', 'https://example.com/x')).toBe('report 2026.pdf');
        expect(__test__.filenameFromDownload('123', '', '', 'https://example.com/files/data%20set.csv?token=x')).toBe('data set.csv');
        expect(__test__.filenameFromDownload('123', '../manual name.pdf', '', 'https://example.com/x?attname=api.pdf')).toBe('manual name.pdf');
        expect(__test__.filenameFromDownload('123', '', '', 'https://example.com/download?token=x')).toBe('123.bin');
    });
});
