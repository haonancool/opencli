import { describe, expect, it } from 'vitest';
import { getFileDownloadInfo, getTopicCommentItems, getTopicFiles, getTopicText, toTopicRow } from './utils.js';

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
        });
        expect(toTopicRow(topic)).not.toHaveProperty('file_preview');
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

    it('nests replies under their parent comments', () => {
        const topic = {
            topic_id: 'comments-1',
            comments_count: 2,
            show_comments: [
                {
                    comment_id: 10,
                    owner: { name: '包包' },
                    text: '这是评论',
                },
                {
                    comment_id: 11,
                    parent_comment_id: 10,
                    owner: { name: '数据驱动投资者' },
                    repliee: { name: '包包' },
                    text: '这是回复\n的完整内容',
                },
            ],
        };

        expect(getTopicCommentItems(topic)).toEqual([
            {
                comment_id: 10,
                author: '包包',
                content: '这是评论',
                replies: [{
                        comment_id: 11,
                        author: '数据驱动投资者',
                        reply_to: '包包',
                        content: '这是回复 的完整内容',
                        replies: [],
                    }],
            },
        ]);
        expect(toTopicRow(topic)).toMatchObject({
            comments: 2,
            comment_preview: '包包: 这是评论 | 数据驱动投资者 -> 包包: 这是回复 的完整内容',
            comment_items: [
                {
                    author: '包包',
                    content: '这是评论',
                    replies: [{ author: '数据驱动投资者', reply_to: '包包', content: '这是回复 的完整内容' }],
                },
            ],
        });
    });

    it('uses question and answer fields instead of content for q&a topics', () => {
        const row = toTopicRow({
            topic_id: 'qa-1',
            type: 'q&a',
            question: { owner: { name: '提问者' }, text: '问题\n内容' },
            answer: { owner: { name: '回答者' }, text: '回答\n内容' },
        });

        expect(row).toMatchObject({
            question: '问题 内容',
            answer: '回答 内容',
        });
        expect(row).not.toHaveProperty('content');
    });
});
