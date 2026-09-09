import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CliError } from '@jackwener/opencli/errors';
import { browserJsonRequest, ensureZsxqAuth, ensureZsxqPage, fetchFirstJson, getCommentsFromResponse, getTopicFromResponse, getTopicLookupIds, getTopicUrl, summarizeComments, toTopicRow, } from './utils.js';
cli({
    site: 'zsxq',
    name: 'topic',
    access: 'read',
    description: '获取单个话题详情和评论',
    domain: 'wx.zsxq.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'topic_uid', required: true, positional: true, help: 'topic_uid from `zsxq topics` or share URL /topic/<uid>; listed topic_id still works via adjacent-id fallback' },
        { name: 'group_id', help: 'Deprecated: topic lookup uses /v2/topics/{id}/info and no longer needs a group id (ignored)' },
        { name: 'comment_limit', type: 'int', default: 20, help: 'Number of comments to fetch (max 30)' },
    ],
    columns: ['topic_id', 'topic_uid', 'type', 'author', 'title', 'question', 'answer', 'question_author', 'answer_author', 'comments', 'comment_preview', 'likes', 'url'],
    func: async (page, kwargs) => {
        const topicId = String(kwargs.topic_uid ?? kwargs.id);
        const commentLimit = Math.max(1, Number(kwargs.comment_limit) || 20);
        if (commentLimit > 30) {
            throw new ArgumentError('--comment_limit must be between 1 and 30', 'The ZSXQ comments API rejects larger pages with code 17801');
        }
        await ensureZsxqPage(page);
        await ensureZsxqAuth(page);
        // /info resolves by topic_uid. topics list historically printed topic_id
        // (often uid-1), so retry the adjacent numeric ids on API 1007/15403.
        let detailResp = null;
        let resolvedId = topicId;
        let lastMissingUrl = '';
        for (const candidate of getTopicLookupIds(topicId)) {
            const detailUrl = `https://api.zsxq.com/v2/topics/${candidate}/info`;
            const resp = await browserJsonRequest(page, detailUrl);
            if (!resp) {
                lastMissingUrl = detailUrl;
                continue;
            }
            if (resp.status === 404) {
                lastMissingUrl = detailUrl;
                continue;
            }
            if (!resp.ok) {
                throw new CliError('FETCH_ERROR', resp.error || `Failed to fetch topic ${topicId}`, `Checked endpoint: ${detailUrl}`);
            }
            const payload = resp.data;
            if (payload && payload.succeeded === false) {
                const code = Number(payload.code) || 0;
                if (code === 1007 || code === 15403) {
                    lastMissingUrl = detailUrl;
                    continue;
                }
                throw new CliError(String(payload.code ?? 'API_ERROR'), payload.info || payload.error || `Failed to fetch topic ${topicId}`, `Checked endpoint: ${detailUrl}`);
            }
            detailResp = resp;
            resolvedId = candidate;
            break;
        }
        if (!detailResp) {
            throw new CliError('NOT_FOUND', `Topic ${topicId} not found`, lastMissingUrl ? `Checked endpoint: ${lastMissingUrl}` : undefined);
        }
        const commentsResp = await fetchFirstJson(page, [
            `https://api.zsxq.com/v2/topics/${resolvedId}/comments?sort=asc&count=${commentLimit}`,
        ]);
        const topic = getTopicFromResponse(detailResp.data);
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
                url: getTopicUrl(topic.topic_uid ?? resolvedId),
            }];
    },
});
