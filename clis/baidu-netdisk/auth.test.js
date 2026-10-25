import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './auth.js';

const command = name => getRegistry().get(`baidu-netdisk/${name}`);
const ok = value => new Response(JSON.stringify({ errno: 0, ...value }));
const session = { bdstoken: 'synthetic-token', uk: 1234, loginstate: 1 };
const user = { uk: 1234, username: 'test-user', loginstate: 1, is_vip: 0, is_svip: 1, photo: 'https://example.com/avatar.png' };
let page, fetcher;
beforeEach(() => {
    page = { goto: vi.fn(), getCookies: vi.fn().mockResolvedValue([{ name: 'BDUSS', value: 'synthetic-cookie' }]) };
    fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe('Baidu Netdisk account commands', () => {
    it('checks an authenticated session remotely without leaking credentials', async () => {
        fetcher.mockResolvedValueOnce(ok({ result: session }));
        const result = await command('login-status').func(page);
        expect(result).toEqual([{ loggedIn: true, status: 'logged_in', id: '1234' }]);
        expect(JSON.stringify(result)).not.toMatch(/synthetic-token|synthetic-cookie/);
        expect(page.getCookies).toHaveBeenCalledTimes(1);
        expect(JSON.parse(new URL(fetcher.mock.calls[0][0]).searchParams.get('fields'))).toContain('loginstate');
        expect(command('login-status').access).toBe('read');
        expect(command('whoami').access).toBe('read');
    });

    it('reports logged out when the browser has no session cookie', async () => {
        page.getCookies.mockResolvedValue([]);
        expect(await command('login-status').func(page)).toEqual([{ loggedIn: false, status: 'logged_out', id: null }]);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([-6, -7, 110, 111])('reports expired login for server auth error %s', async errno => {
        fetcher.mockResolvedValueOnce(ok({ errno }));
        expect((await command('login-status').func(page))[0].loggedIn).toBe(false);
    });

    it('treats explicit loginstate=0 as logged out even if cookies still exist', async () => {
        fetcher.mockResolvedValueOnce(ok({ result: { loginstate: 0 } }));
        expect((await command('login-status').func(page))[0].status).toBe('logged_out');
    });

    it('does not convert network failure into logged-out status', async () => {
        fetcher.mockRejectedValueOnce(new Error('network unavailable'));
        await expect(command('login-status').func(page)).rejects.toMatchObject({ code: 'BAIDU_NETWORK' });
    });

    it('distinguishes HTTP, malformed JSON and incomplete auth payloads from logged out', async () => {
        for (const [response, code] of [[new Response('', { status: 500 }), 'BAIDU_HTTP'], [new Response('', { status: 403 }), 'BAIDU_HTTP'], [new Response('<html>verification</html>'), 'BAIDU_RESPONSE'], [ok({}), 'BAIDU_RESPONSE'], [ok({ result: { ...session, loginstate: undefined } }), 'BAIDU_RESPONSE'], [ok({ result: { ...session, loginstate: null } }), 'BAIDU_RESPONSE']]) {
            fetcher.mockResolvedValueOnce(response);
            await expect(command('login-status').func(page)).rejects.toMatchObject({ code });
        }
    });

    it.each([[0, 1, 'svip'], [1, 0, 'vip'], [0, 0, 'free']])('shows verified user and quota for vip=%s svip=%s', async (vip, svip, membership) => {
        fetcher.mockResolvedValueOnce(ok({ result: session }))
            .mockResolvedValueOnce(ok({ result: { ...user, is_vip: vip, is_svip: svip, bdstoken: 'must-not-output' } }))
            .mockResolvedValueOnce(ok({ total: 10000, used: 2500 }));
        const result = await command('whoami').func(page);
        expect(result).toEqual([{ loggedIn: true, id: '1234', username: 'test-user', avatar: 'https://example.com/avatar.png', membership, totalBytes: 10000, usedBytes: 2500, freeBytes: 7500 }]);
        expect(Object.keys(result[0])).toEqual(command('whoami').columns);
        expect(JSON.stringify(result)).not.toMatch(/must-not-output|synthetic-cookie|synthetic-token/);
        expect(new URL(fetcher.mock.calls.at(-1)[0]).pathname).toBe('/api/quota');
    });

    it('requires login for whoami', async () => {
        page.getCookies.mockResolvedValue([]);
        await expect(command('whoami').func(page)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    });

    it('rejects account changes before querying quota', async () => {
        fetcher.mockResolvedValueOnce(ok({ result: session })).mockResolvedValueOnce(ok({ result: { ...user, uk: 5678 } }));
        await expect(command('whoami').func(page)).rejects.toMatchObject({ code: 'BAIDU_ACCOUNT' });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('rejects incomplete profile and quota responses', async () => {
        fetcher.mockResolvedValueOnce(ok({ result: session })).mockResolvedValueOnce(ok({ result: { uk: 1234, loginstate: 1 } }));
        await expect(command('whoami').func(page)).rejects.toMatchObject({ code: 'BAIDU_RESPONSE' });
        fetcher.mockResolvedValueOnce(ok({ result: session })).mockResolvedValueOnce(ok({ result: user })).mockResolvedValueOnce(ok({ total: 'unknown', used: 100 }));
        await expect(command('whoami').func(page)).rejects.toMatchObject({ code: 'BAIDU_RESPONSE' });
    });

    it('reports zero available bytes for an over-quota account', async () => {
        fetcher.mockResolvedValueOnce(ok({ result: session })).mockResolvedValueOnce(ok({ result: { ...user, photo: undefined } })).mockResolvedValueOnce(ok({ total: 100, used: 150 }));
        expect((await command('whoami').func(page))[0]).toMatchObject({ totalBytes: 100, usedBytes: 150, freeBytes: 0, avatar: null });
    });
});
