import { describe, expect, it } from 'vitest';
import { getFileDownloadInfo, getTopicFiles, getTopicText, toTopicRow } from './utils.js';

describe('zsxq utils', () => {
    it('keeps title and content separate when both fields exist', () => {
        const topic = {
            topic_id: '123',
            title: 'A full title that should not be truncated',
            talk: { text: 'This is the full body text.' },
        };

        expect(getTopicText(topic)).toBe('A full title that should not be truncated');
        expect(toTopicRow(topic)).toMatchObject({
            title: 'A full title that should not be truncated',
            content: 'This is the full body text.',
        });
    });

    it('falls back to body text for title when explicit title is absent', () => {
        const topic = {
            topic_id: '456',
            talk: { text: 'Body-only topic text should still appear as the title preview.' },
        };

        expect(getTopicText(topic)).toBe('Body-only topic text should still appear as the title preview.');
        expect(toTopicRow(topic)).toMatchObject({
            title: 'Body-only topic text should still appear as the title preview.',
            content: 'Body-only topic text should still appear as the title preview.',
        });
    });

    it('extracts file ids and names from talk files', () => {
        const topic = {
            topic_id: '789',
            talk: {
                text: 'Files attached',
                files: [
                    { file_id: 123, name: 'report.pdf', size: 42 },
                    { file: { file_id: '456', name: 'data.csv' } },
                    { name: 'missing-id.txt' },
                ],
            },
        };

        expect(getTopicFiles(topic)).toEqual([
            { file_id: 123, name: 'report.pdf' },
            { file_id: '456', name: 'data.csv' },
        ]);
        expect(toTopicRow(topic)).toMatchObject({
            files: [
                { file_id: 123, name: 'report.pdf' },
                { file_id: '456', name: 'data.csv' },
            ],
            file_preview: '123:report.pdf | 456:data.csv',
        });
    });

    it('unwraps and validates file download metadata', () => {
        expect(getFileDownloadInfo({
            succeeded: true,
            resp_data: {
                download_url: 'https://download.zsxq.com/path/report.pdf?token=abc',
                name: 'report.pdf',
            },
        })).toEqual({
            download_url: 'https://download.zsxq.com/path/report.pdf?token=abc',
            name: 'report.pdf',
        });
    });

    it('rejects missing or unsafe file download URLs', () => {
        expect(() => getFileDownloadInfo({ succeeded: true, resp_data: {} })).toThrow('Download URL not found');
        expect(() => getFileDownloadInfo({
            succeeded: true,
            resp_data: { download_url: 'file:///tmp/report.pdf' },
        })).toThrow('Unsupported download URL protocol');
    });
});
