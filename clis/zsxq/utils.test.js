import { describe, expect, it, vi } from 'vitest';
import { browserJsonRequest, getFileDownloadInfo, getTopicCommentItems, getTopicFiles, getTopicLookupIds, getTopicText, toTopicRow, unwrapRespData } from './utils.js';

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

    it('preserves whitespace and escape characters in topic content', () => {
        const content = '第一行\n第二行\t缩进\r\n第三行';
        const row = toTopicRow({
            topic_id: 'content-newlines',
            type: 'talk',
            talk: { text: content },
        });

        expect(row.content).toBe(content);
        expect(row.title).toBe('第一行 第二行 缩进 第三行');
    });

    it('signs browser API requests with the official ZSXQ headers', async () => {
        const page = {
            evaluate: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { succeeded: true } }),
        };

        await browserJsonRequest(page, 'https://api.zsxq.com/v2/groups/123/topics?scope=all&count=1');

        const script = page.evaluate.mock.calls[0][0];
        expect(script).toContain("const v2Version = \"2.96.0\"");
        expect(script).toContain("crypto.subtle.digest(");
        expect(script).toContain("xhr.setRequestHeader('X-Request-Id', requestId)");
        expect(script).toContain("xhr.setRequestHeader('X-Version', version)");
        expect(script).toContain("xhr.setRequestHeader('X-Signature', signature)");
        expect(script).toContain("xhr.setRequestHeader('X-Timestamp', timestamp)");
        expect(script).toContain("xhr.setRequestHeader('X-Aduid', aduid)");
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

    it('extracts files from task and solution carriers like the official client', () => {
        expect(getTopicFiles({
            topic_id: 't-1',
            task: { files: [{ file_id: 7, name: 'sheet.xlsx' }] },
        })).toEqual([{ file_id: 7, name: 'sheet.xlsx' }]);
        expect(toTopicRow({
            topic_id: 's-1',
            solution: { files: [{ file_id: 8, name: 'notes.pdf' }] },
        })).toMatchObject({ files: [{ file_id: 8, name: 'notes.pdf' }] });
    });

    it('surfaces a default message when the API error info is empty', () => {
        expect(() => unwrapRespData({ succeeded: false, code: 13701, info: '' }))
            .toThrow('ZSXQ API error 13701');
        expect(() => unwrapRespData({ succeeded: false, code: 13701 }))
            .toThrow('ZSXQ API error 13701');
        expect(() => unwrapRespData({ succeeded: false, code: 14001, info: 'count too large' }))
            .toThrow('count too large');
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
                        content: '这是回复\n的完整内容',
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
                    replies: [{ author: '数据驱动投资者', reply_to: '包包', content: '这是回复\n的完整内容' }],
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
            question: '问题\n内容',
            answer: '回答\n内容',
            question_author: '提问者',
            answer_author: '回答者',
            author: '提问者',
        });
        expect(row).not.toHaveProperty('content');
    });

    it('retries numeric topic ids around the listed topic_id for /info lookups', () => {
        expect(getTopicLookupIds('22258841418521420')).toEqual([
            '22258841418521420',
            '22258841418521421',
            '22258841418521419',
        ]);
        expect(getTopicLookupIds('abc')).toEqual(['abc']);
    });

    it('expands replied_comments from the comments endpoint into nested replies', () => {
        const rows = toTopicRow({
            topic_id: 'c-1',
            type: 'talk',
            talk: { text: 'body' },
            comments: [
                {
                    comment_id: 1,
                    owner: { name: 'Alice' },
                    text: 'root',
                    replied_comments: [
                        { comment_id: 11, parent_comment_id: 1, owner: { name: 'Bob' }, text: 'reply 1' },
                        { comment_id: 12, parent_comment_id: 1, owner: { name: 'Carol' }, text: 'reply 2' },
                    ],
                },
                { comment_id: 2, owner: { name: 'Dave' }, text: 'another root' },
            ],
        });
        expect(rows.comment_items).toEqual([
            {
                comment_id: 1,
                author: 'Alice',
                content: 'root',
                replies: [
                    { comment_id: 11, author: 'Bob', content: 'reply 1', replies: [] },
                    { comment_id: 12, author: 'Carol', content: 'reply 2', replies: [] },
                ],
            },
            { comment_id: 2, author: 'Dave', content: 'another root', replies: [] },
        ]);
    });
});
