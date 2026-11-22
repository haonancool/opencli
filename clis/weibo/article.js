import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { requireObjectEvaluateResult, unwrapEvaluateResult } from './utils.js';

const origin = 'https://weibo.com';

function articleUrl(value) {
    if (typeof value !== 'string') return '';
    try {
        const url = new URL(value, origin);
        const id = url.searchParams.get('id');
        if (url.origin === origin && url.pathname === '/ttarticle/p/show' && /^230940\d+$/.test(id || '')) {
            return origin + '/ttarticle/p/show?id=' + id;
        }
    } catch {}
    return '';
}

function cardUrl(post) {
    const card = post?.page_info;
    if (card?.object_type !== 'article') return '';
    const direct = articleUrl(card.page_url);
    if (direct) return direct;
    const objectId = /^1022:(230940\d+)$/.exec(card.object_id || '')?.[1];
    // On desktop, the real article URL accompanies the app deep link in url_struct.
    const links = (Array.isArray(post.url_struct) ? post.url_struct : [])
        .map(link => articleUrl(link?.long_url))
        .filter(Boolean);
    return objectId ? links.find(url => url.endsWith('=' + objectId)) || ''
        : links.length === 1 ? links[0] : '';
}

function postUrl(post) {
    const uid = String(post?.user?.idstr || post?.user?.id || '');
    const mid = post?.mblogid || '';
    return /^\d+$/.test(uid) && /^[a-zA-Z0-9]+$/.test(mid) ? origin + '/' + uid + '/' + mid : '';
}

async function readStatus(id) {
    // The same desktop status request used by weibo post.
    if (location.origin !== 'https://weibo.com' || location.pathname.startsWith('/login')) return { state: 'auth' };
    const response = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(id), {
        credentials: 'same-origin',
        redirect: 'manual',
    });
    if (response.type === 'opaqueredirect' || response.status === 401) return { state: 'auth' };
    if (!response.ok) return { state: 'http', status: response.status };
    if (!response.headers.get('content-type')?.includes('json')) return { state: 'unexpected' };
    const post = await response.json();
    return { state: 'status', post };
}

function readArticle() {
    const visible = element => element && element.checkVisibility({
        visibilityProperty: true,
        opacityProperty: true,
    });
    // This dedicated container excludes the publication text, comments and recommendations.
    const body = document.querySelector('[node-type="contentBody"]');
    const gate = [...document.querySelectorAll('[action-type="maskFollow"], a, button')]
        .some(element => !body?.contains(element) && visible(element)
            && (element.getAttribute('action-type') === 'maskFollow'
                || /^(关注作者[，,]?\s*阅读全文|登录.*阅读全文|登录后查看)$/.test(element.textContent.trim())));
    // A geometrically clipped preview can still expose hidden paragraphs via innerText.
    const clipped = body && body.scrollHeight > body.clientHeight + 1
        && ['hidden', 'clip'].includes(getComputedStyle(body).overflowY);
    return {
        url: location.href,
        title: document.title,
        restricted: gate || clipped,
        body: !gate && !clipped && visible(body) ? body.innerText.replace(/^[\s\u200b]+|[\s\u200b]+$/g, '') : '',
    };
}

cli({
    site: 'weibo',
    name: 'article',
    access: 'read',
    description: 'Read the body of an independent Weibo headline article',
    domain: 'weibo.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [{ name: 'source', positional: true, required: true, help: 'Weibo status ID, post URL, or desktop headline article URL' }],
    columns: ['status', 'source_kind', 'source_url', 'original_post_url', 'article_url', 'title', 'body'],
    func: async (page, kwargs) => {
        const source = String(kwargs.source).trim();
        let url = articleUrl(source);
        let sourceUrl = url;
        let originalPostUrl = '';
        let sourceKind = 'article';
        if (!url) {
            const id = /^(?:https:\/\/weibo\.com\/\d+\/)?([a-zA-Z0-9]+)(?:[?#].*)?$/.exec(source)?.[1];
            if (!id) throw new CommandExecutionError('Expected a Weibo status ID, post URL, or desktop headline article URL');
            await page.goto(origin);
            const result = requireObjectEvaluateResult(
                unwrapEvaluateResult(await page.evaluate('(' + readStatus.toString() + ')(' + JSON.stringify(id) + ')')),
                'weibo article status',
            );
            if (result.state === 'auth') throw new AuthRequiredError('weibo.com', 'Weibo status lookup requires an accessible session');
            if (result.state === 'http') throw new CommandExecutionError('Weibo status lookup failed: HTTP ' + result.status);
            if (result.state !== 'status' || (!result.post?.idstr && !result.post?.id)) {
                throw new CommandExecutionError('Weibo status is unavailable from the current session' +
                    (result.post?.msg ? ': ' + result.post.msg : ''));
            }
            const post = result.post;
            const original = post.retweeted_status;
            const ownUrl = cardUrl(post);
            const originalUrl = cardUrl(original);
            url = ownUrl || originalUrl;
            sourceUrl = postUrl(post);
            originalPostUrl = postUrl(original);
            if (!url) {
                const hasCard = post.page_info?.object_type === 'article' || original?.page_info?.object_type === 'article';
                if (hasCard) throw new CommandExecutionError('Weibo article card has no accessible desktop article URL');
                const long = [post, original].some(item => item?.isLongText || item?.is_long_text);
                return [{ status: 'not_article', source_kind: original ? 'retweet' : long ? 'long_status' : 'status',
                    source_url: sourceUrl, original_post_url: originalPostUrl, article_url: '', title: '', body: '' }];
            }
            sourceKind = original ? 'retweet' : 'status';
        }

        await page.goto(url);
        const result = requireObjectEvaluateResult(
            unwrapEvaluateResult(await page.evaluate('(' + readArticle.toString() + ')()')),
            'weibo article page',
        );
        if (articleUrl(result.url) !== url) throw new CommandExecutionError('Weibo article redirected away from its source: ' + url);
        if (result.restricted) throw new CommandExecutionError('Weibo article access is restricted: ' + url);
        if (!result.body) throw new CommandExecutionError('Weibo article has no visible body in this session: ' + url);
        return [{ status: 'ok', source_kind: sourceKind, source_url: sourceUrl, original_post_url: originalPostUrl,
            article_url: url, title: result.title, body: result.body }];
    },
});
