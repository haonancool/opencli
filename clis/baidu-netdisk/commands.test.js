import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './commands.js';
import { BaiduClient, listFiles } from './api.js';
import { readTask, taskDirectory } from './tasks.js';

const entry = (remote = '/docs/a.txt', id = 123) => ({ fs_id: id, path: remote, server_filename: path.posix.basename(remote), isdir: 0, size: 7, server_mtime: 1700000000 });
const ok = value => new Response(JSON.stringify({ errno: 0, ...value }));
const command = name => getRegistry().get(`baidu-netdisk/${name}`);
let temp, fetcher, page;

beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-baidu-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(temp);
    fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    page = { goto: vi.fn(), getCookies: vi.fn().mockResolvedValue([{ name: 'BDUSS', value: 'synthetic-cookie' }]) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(temp, { recursive: true, force: true }); });
function auth() { fetcher.mockResolvedValueOnce(ok({ result: { bdstoken: 'synthetic-token', uk: 'test-account', loginstate: 1 } })); }

describe('baidu-netdisk production commands', () => {
    it('registers browser writes and offline task controls with matching columns', () => {
        for (const name of ['rename', 'move', 'mkdir', 'delete', 'upload', 'upload-resume']) expect(command(name)).toMatchObject({ access: 'write', browser: true });
        expect(command('upload-pause')).toMatchObject({ access: 'write', browser: false });
        expect(command('uploads').columns).toEqual(command('upload-status').columns);
        expect(command('list').columns).toEqual(command('info').columns);
        expect(command('list').columns).toEqual(command('search').columns);
    });

    it('rejects invalid targets and limits before touching browser or network', async () => {
        for (const [name, args] of [['search', { query: ' ' }], ['list', { dir: 'relative' }], ['list', { limit: 0 }], ['rename', { path: '/a', name: '../b' }], ['move', { path: '/a', to: '/a/b' }], ['info', { path: '/../a' }]]) {
            await expect(command(name).func(page, args)).rejects.toMatchObject({ code: 'ARGUMENT' });
        }
        expect(page.goto).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('lists with browser cookies, pagination, exact limit and shared file schema', async () => {
        auth();
        fetcher.mockResolvedValueOnce(ok({ list: Array.from({ length: 100 }, (_, i) => entry(`/docs/${i}.txt`, i)) }));
        fetcher.mockResolvedValueOnce(ok({ list: [entry('/docs/last.txt', 101)] }));
        const rows = await command('list').func(page, { dir: '/docs', limit: 101 });
        expect(rows).toHaveLength(101);
        expect(rows.at(-1)).toEqual({ name: 'last.txt', path: '/docs/last.txt', type: 'file', size: 7, modifiedAt: 1700000000, id: '101' });
        expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('page')).toBe('2');
        expect(fetcher.mock.calls[1][1].headers.cookie).toContain('BDUSS=synthetic-cookie');
    });

    it('searches a scoped directory and accepts a true empty result', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok({ list: [], has_more: 0 }));
        expect(await command('search').func(page, { query: 'hello 世界', dir: '/docs' })).toEqual([]);
        const url = new URL(fetcher.mock.calls[1][0]);
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ key: 'hello 世界', dir: '/docs', recursion: '1' });
    });

    it('does not return partial results on repeated pages or upstream failures', async () => {
        const items = Array.from({ length: 100 }, (_, i) => entry(`/docs/${i}`, i));
        const client = new BaiduClient({ token: 'fake', cookie: 'fake' }, vi.fn().mockImplementation(async () => ok({ list: items })));
        await expect(listFiles(client, 'list', {}, 200)).rejects.toMatchObject({ code: 'BAIDU_PAGINATION' });
        auth(); fetcher.mockResolvedValueOnce(ok({ list: items })).mockResolvedValueOnce(ok({ errno: -6 }));
        await expect(command('list').func(page, { limit: 200 })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    });

    it('rejects malformed JSON, HTTP errors and a missing list', async () => {
        for (const response of [new Response('<html>Login</html>'), new Response('error', { status: 500 }), ok({})]) {
            auth(); fetcher.mockResolvedValueOnce(response);
            await expect(command('list').func(page, {})).rejects.toHaveProperty('code');
        }
    });

    it('verifies renames against destination metadata and preserves identity', async () => {
        auth();
        fetcher.mockResolvedValueOnce(ok({ info: [entry('/a.txt')] }))
            .mockResolvedValueOnce(ok({ errno: 12, info: [{ errno: -9 }] }))
            .mockResolvedValueOnce(ok({ info: [{ errno: 0, path: '/a.txt' }] }))
            .mockResolvedValueOnce(ok({ info: [entry('/b.txt')] }));
        const rows = await command('rename').func(page, { path: '/a.txt', name: 'b.txt' });
        expect(rows[0].path).toBe('/b.txt');
        const [, request] = fetcher.mock.calls.find(([url]) => url.includes('/filemanager?'));
        expect(JSON.parse(request.body.get('filelist'))).toEqual([{ path: '/a.txt', newname: 'b.txt' }]);
        expect(request.body.get('ondup')).toBe('fail');
        expect(request.body.get('async')).toBe('0');
    });

    it('checks per-file failure even if the top-level result is success', async () => {
        auth();
        fetcher.mockResolvedValueOnce(ok({ info: [entry('/a.txt')] }))
            .mockResolvedValueOnce(ok({ errno: 12 }))
            .mockResolvedValueOnce(ok({ info: [{ errno: -9 }] }));
        await expect(command('rename').func(page, { path: '/a.txt', name: 'b.txt' })).rejects.toMatchObject({ code: 'BAIDU_API' });
        expect(fetcher).toHaveBeenCalledTimes(4);
    });

    it('refuses to overwrite existing destinations', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok({ info: [entry('/a.txt')] })).mockResolvedValueOnce(ok({ info: [entry('/b.txt', 456)] }));
        await expect(command('rename').func(page, { path: '/a.txt', name: 'b.txt' })).rejects.toMatchObject({ code: 'BAIDU_EXISTS' });
        expect(fetcher.mock.calls.some(([url]) => url.includes('/filemanager?'))).toBe(false);
    });

    it('creates a paused task and queries it offline without persisting credentials', async () => {
        const file = path.join(temp, 'hello.txt'); fs.writeFileSync(file, 'hello');
        auth(); fetcher.mockResolvedValueOnce(ok({ errno: 12 }));
        const [row] = await command('upload').func(page, { file, paused: true });
        expect(row).toMatchObject({ name: 'hello.txt', status: 'paused', progress: 0, size: 5 });
        const raw = fs.readFileSync(path.join(taskDirectory(), `${row.id}.json`), 'utf8');
        expect(raw).not.toMatch(/synthetic-cookie|synthetic-token|BDUSS/);
        const totalCalls = fetcher.mock.calls.length;
        expect(await command('upload-status').func({ id: row.id })).toEqual([row]);
        expect(await command('uploads').func({})).toEqual([row]);
        expect(await command('upload-pause').func({ id: row.id })).toEqual([row]);
        expect(fetcher).toHaveBeenCalledTimes(totalCalls);
        expect(readTask(taskDirectory(), row.id).status).toBe('paused');
        expect(fs.statSync(path.join(taskDirectory(), `${row.id}.json`)).mode & 0o777).toBe(0o600);
    });

    it('deletes an exact path and verifies it is absent with a separate read', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok({ info: [entry('/a.txt')] }))
            .mockResolvedValueOnce(ok({ info: [{ errno: 0, path: '/a.txt' }] }))
            .mockResolvedValueOnce(ok({ errno: 12, info: [{ errno: -9 }] }));
        const [row] = await command('delete').func(page, { path: '/a.txt' });
        expect(row).toMatchObject({ path: '/a.txt', id: '123', status: 'deleted' });
        const [url, request] = fetcher.mock.calls[2];
        expect(new URL(url).searchParams.get('opera')).toBe('delete');
        expect(JSON.parse(request.body.get('filelist'))).toEqual(['/a.txt']);
        expect(fetcher.mock.calls.at(-1)[0]).toContain('/filemetas?');
    });

    it('requires explicit recursion for directory deletion and refuses root deletion', async () => {
        await expect(command('delete').func(page, { path: '/' })).rejects.toMatchObject({ code: 'ARGUMENT' });
        expect(page.goto).not.toHaveBeenCalled();
        auth(); fetcher.mockResolvedValueOnce(ok({ info: [{ ...entry('/docs'), isdir: 1 }] }));
        await expect(command('delete').func(page, { path: '/docs' })).rejects.toMatchObject({ code: 'ARGUMENT' });
        expect(fetcher.mock.calls.some(([url]) => url.includes('/filemanager?'))).toBe(false);
    });

    it('never reports deleted when the remote path is still present', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok({ info: [entry('/a.txt')] }))
            .mockResolvedValueOnce(ok({ info: [{ errno: 0 }] }))
            .mockResolvedValueOnce(ok({ info: [entry('/a.txt')] }));
        await expect(command('delete').func(page, { path: '/a.txt' })).rejects.toMatchObject({ code: 'BAIDU_VERIFY' });
    });
});
