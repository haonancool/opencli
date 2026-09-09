import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { browserJsonRequest, ensureZsxqAuth, ensureZsxqPage, fetchFirstJson, getCommentsFromResponse, getTopicFromResponse, getTopicUrl, summarizeComments, toTopicRow, } from './utils.js';
cli({
    site: 'zsxq',
    name: 'topic',
    access: 'read',
    description: '获取单个话题详情和评论',
    domain: 'wx.zsxq.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'id', required: true, positional: true, help: 'Topic ID' },
        { name: 'group_id', help: 'Deprecated: topic lookup uses /v2/topics/{id}/info and no longer needs a group id (ignored)' },
        { name: 'comment_limit', type: 'int', default: 20, help: 'Number of comments to fetch' },
    ],
    columns: ['topic_id', 'type', 'author', 'title', 'question', 'answer', 'question_author', 'answer_author', 'comments', 'comment_preview', 'likes', 'url'],
    func: async (page, kwargs) => {
        await ensureZsxqPage(page);
        await ensureZsxqAuth(page);
        const topicId = String(kwargs.id);
        const commentLimit = Math.max(1, Number(kwargs.comment_limit) || 20);
        const detailUrl = `https://api.zsxq.com/v2/topics/${topicId}/info`;
        const detailResp = await browserJsonRequest(page, detailUrl);
        if (detailResp.status === 404) {
            throw new CliError('NOT_FOUND', `Topic ${topicId} not found`);
        }
        if (!detailResp.ok) {
            throw new CliError('FETCH_ERROR', detailResp.error || `Failed to fetch topic ${topicId}`, `Checked endpoint: ${detailUrl}`);
        }
        // zsxq answers API-level errors as HTTP 200 + succeeded:false:
        // 1007/15403 = topic missing or deleted, 1059 = anti-tool risk control (retry later).
        const payload = detailResp.data;
        if (payload && payload.succeeded === false) {
            const code = Number(payload.code) || 0;
            if (code === 1007 || code === 15403) {
                throw new CliError('NOT_FOUND', `Topic ${topicId} not found`);
            }
            throw new CliError(String(payload.code ?? 'API_ERROR'), payload.info || payload.error || `Failed to fetch topic ${topicId}`, `Checked endpoint: ${detailUrl}`);
        }
        const commentsResp = await fetchFirstJson(page, [
            `https://api.zsxq.com/v2/topics/${topicId}/comments?sort=asc&count=${commentLimit}`,
        ]);
        const topic = getTopicFromResponse(payload);
        if (!topic)
            throw new CliError('NOT_FOUND', `Topic ${topicId} not found`);
        const comments = getCommentsFromResponse(commentsResp.data);
        const row = toTopicRow({
            ...topic,
            comments,
            comments_count: topic.comments_count ?? comments.length,
        });
        return [{
                ...row,
                comment_preview: summarizeComments(comments, 5),
                url: getTopicUrl(topic.topic_id ?? topicId),
            }];
    },
});
