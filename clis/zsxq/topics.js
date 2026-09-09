import { cli, Strategy } from '@jackwener/opencli/registry';
import { getActiveGroupId, ensureZsxqAuth, ensureZsxqPage, fetchFirstJson, getTopicsFromResponse, toTopicRow, } from './utils.js';
const TOPIC_SCOPES = ['all', 'digests', 'by_owner', 'questions', 'with_files', 'with_images'];
export function buildTopicsUrl(groupId, options) {
    const url = new URL(`https://api.zsxq.com/v2/groups/${encodeURIComponent(groupId)}/topics`);
    url.searchParams.set('scope', options.scope);
    url.searchParams.set('count', String(options.count));
    if (options.beginTime)
        url.searchParams.set('begin_time', options.beginTime);
    if (options.endTime)
        url.searchParams.set('end_time', options.endTime);
    return url.toString();
}
cli({
    site: 'zsxq',
    name: 'topics',
    access: 'read',
    description: '获取当前星球的话题列表',
    domain: 'wx.zsxq.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'count', type: 'int', default: 20, help: 'Number of topics to request and return' },
        { name: 'limit', type: 'int', help: 'Deprecated alias for --count' },
        { name: 'begin_time', help: 'Optional inclusive start time, e.g. 2026-08-06T12:40:04.266+0800' },
        { name: 'end_time', help: 'Optional inclusive end time, e.g. 2026-08-06T21:40:04.266+0800' },
        { name: 'scope', default: 'all', choices: TOPIC_SCOPES, help: 'Topic filter scope' },
        { name: 'group_id', help: 'Optional group id; defaults to the active group in Chrome' },
    ],
    columns: ['topic_id', 'type', 'author', 'title', 'question', 'answer', 'question_author', 'answer_author', 'comments', 'comment_preview', 'likes', 'time', 'url'],
    func: async (page, kwargs) => {
        await ensureZsxqPage(page);
        await ensureZsxqAuth(page);
        const count = Math.max(1, Number(kwargs.limit ?? kwargs.count) || 20);
        const scope = String(kwargs.scope || 'all');
        const beginTime = String(kwargs.begin_time || '').trim();
        const endTime = String(kwargs.end_time || '').trim();
        const groupId = String(kwargs.group_id || await getActiveGroupId(page));
        const { data } = await fetchFirstJson(page, [
            buildTopicsUrl(groupId, { count, scope, beginTime, endTime }),
        ]);
        return getTopicsFromResponse(data).slice(0, count).map(toTopicRow);
    },
});
