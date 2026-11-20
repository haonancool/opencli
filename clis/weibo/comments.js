/**
 * Weibo comments — get comments on a post.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { requireArrayEvaluateResult, unwrapEvaluateResult } from './utils.js';
cli({
    site: 'weibo',
    name: 'comments',
    access: 'read',
    description: 'Get comments on a Weibo post',
    domain: 'weibo.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'id', required: true, positional: true, help: 'Post ID (numeric idstr)' },
        { name: 'limit', type: 'int', default: 20, help: 'Number of comments (max 50)' },
    ],
    columns: ['rank', 'author', 'text', 'likes', 'replies', 'time'],
    func: async (page, kwargs) => {
        const count = Math.min(kwargs.limit || 20, 50);
        await page.goto('https://weibo.com');
        await page.wait(2);
        const id = String(kwargs.id);
        const data = requireArrayEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const id = ${JSON.stringify(id)};
        const count = ${count};
        const strip = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

        const url = '/ajax/statuses/buildComments?flow=0&is_reload=1&id=' + id + '&is_show_bulletin=2&is_mix=0&count=' + count;
        const resp = await fetch(url, {credentials: 'include'});
        if (!resp.ok) return {error: 'HTTP ' + resp.status};
        const data = await resp.json();
        if (!data.ok) return {error: 'API error: ' + (data.msg || 'unknown')};

        const commentId = (comment) => {
          const value = comment?.idstr || comment?.id;
          return typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : undefined;
        };
        const toComment = (c) => {
          const item = {
            author: c.user?.screen_name || '',
            text: strip(c.text || ''),
            likes: c.like_count || 0,
            replies: c.total_number || 0,
            time: c.created_at || '',
          };
          if (c.reply_comment) {
            item.reply_to = (c.reply_comment.user?.screen_name || '') + ': ' + strip(c.reply_comment.text || '').substring(0, 80);
          }
          return item;
        };

        return (data.data || []).map((c, i) => {
          const id = commentId(c);
          const seen = new Set(id ? [id] : []);
          const reply_items = (Array.isArray(c.comments) ? c.comments : []).flatMap((reply) => {
            if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return [];
            const replyId = commentId(reply);
            if (replyId && seen.has(replyId)) return [];
            if (replyId) seen.add(replyId);
            const replyToId = commentId(reply.reply_comment);
            return [{
              ...toComment(reply),
              ...(replyId ? { id: replyId } : {}),
              ...(replyToId ? { reply_to_id: replyToId } : {}),
            }];
          });
          return {
            rank: i + 1,
            ...toComment(c),
            ...(id ? { id } : {}),
            reply_items,
          };
        });
      })()
    `)), 'weibo comments');
        return data;
    },
});
