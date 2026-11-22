import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './article.js';

const command = getRegistry().get('weibo/article');
const url = 'https://weibo.com/ttarticle/p/show?id=2309401234567890123';
const origin = 'https://weibo.com';
const html = readFileSync(new URL('./__fixtures__/article.html', import.meta.url), 'utf8');
const status = {
    idstr: '12345',
    mblogid: 'AbC',
    user: { idstr: '10001' },
    text_raw: 'Publication wrapper',
    page_info: { object_type: 'article', object_id: '1022:2309401234567890123', page_url: 'sinaweibo://articlebrowser' },
    url_struct: [{ long_url: 'https://weibo.com/ttarticle/p/show?id=2309409999' }, { long_url: url }],
};

function makePage(post, { http = 200, redirect, documentHtml = html } = {}) {
    const fetch = vi.fn(async () => new Response(JSON.stringify(post), {
        status: http, headers: { 'content-type': 'application/json' },
    }));
    let window;
    const page = {
        fetch,
        goto: vi.fn(async target => {
            window?.close();
            window = new JSDOM(documentHtml, { url: target === origin ? origin : redirect || target }).window;
            window.HTMLElement.prototype.checkVisibility = function () {
                return !this.closest('[hidden]');
            };
            // JSDOM does not render innerText. Preserve line breaks of this fixture's paragraphs.
            const body = window.document.querySelector('[node-type="contentBody"]');
            if (body) body.innerText = [...body.querySelectorAll('p')].map(p => p.textContent).join('\n\n');
        }),
        evaluate: vi.fn(async source => ({
            session: 'site:weibo:test',
            data: await new Function('fetch', 'document', 'location', 'getComputedStyle', 'return (' + source + ')')(
                fetch, window.document, window.location, window.getComputedStyle,
            ),
        })),
    };
    return page;
}

describe('weibo article', () => {
    it.each([
        ['https://weibo.com/10001/AbC', status, 'status', 'https://weibo.com/10001/AbC', ''],
        ['67890', { idstr: '67890', mblogid: 'DeF', user: { id: 20002 }, retweeted_status: status },
            'retweet', 'https://weibo.com/20002/DeF', 'https://weibo.com/10001/AbC'],
        ['67890', { ...status, idstr: '67890', mblogid: 'DeF', user: { id: 20002 }, retweeted_status: status },
            'retweet', 'https://weibo.com/20002/DeF', 'https://weibo.com/10001/AbC'],
        [url, null, 'article', url, ''],
    ])('returns only the separate body for %s and retains provenance', async (source, post, sourceKind, sourceUrl, originalPostUrl) => {
        const page = makePage(post);
        expect(await command.func(page, { source })).toEqual([{
            status: 'ok', source_kind: sourceKind, source_url: sourceUrl, original_post_url: originalPostUrl,
            article_url: url, title: 'Fixture article', body: 'First paragraph.\n\nLast paragraph.',
        }]);
        expect(page.goto.mock.calls).toEqual(post ? [[origin], [url]] : [[url]]);
    });

    it('identifies ordinary long statuses without returning their wrappers or expanding longtext', async () => {
        const page = makePage({ ...status, page_info: null, isLongText: true });
        expect(await command.func(page, { source: status.idstr })).toMatchObject([
            { status: 'not_article', source_kind: 'long_status', body: '' },
        ]);
        expect(page.fetch).toHaveBeenCalledTimes(1);
        expect(page.goto).toHaveBeenCalledTimes(1);
    });

    it('does not guess article locations from the object ID or use off-site URLs', async () => {
        const page = makePage({ ...status, url_struct: [{ long_url: url.replace('weibo.com', 'weibo.com.example.org') }] });
        await expect(command.func(page, { source: status.idstr })).rejects.toThrow(/no accessible desktop article URL/);
        expect(page.goto).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403, 429])('stops after status HTTP %i', async http => {
        const page = makePage(status, { http });
        await expect(command.func(page, { source: status.idstr })).rejects.toThrow(http === 401 ? /session/ : new RegExp('HTTP ' + http));
        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        [{ documentHtml: html.replace('div hidden', 'div') }, /restricted/],
        [{ documentHtml: '<div>Wrapper or security challenge</div>' }, /no visible body/],
        [{ redirect: 'https://weibo.com/login' }, /redirected/],
    ])('stops at the article page when the complete body is inaccessible', async (options, expected) => {
        const page = makePage(null, options);
        await expect(command.func(page, { source: url })).rejects.toThrow(expected);
        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.fetch).not.toHaveBeenCalled();
    });
});
