import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './commands.js';
import './auth.js';
import './rename.js';
import './mkdir.js';
import { QuarkClient } from './drive-api.js';
import { taskDirectory } from './tasks.js';
const ID = 'a'.repeat(32), DIR = 'b'.repeat(32);
const item = (fid = ID, name = 'file.txt', extra = {}) => ({ fid, file_name: name, pdir_fid: '0', size: 7, dir: false, updated_at: 1700000000000, full_path: [], ...extra });
const ok = (data, metadata) => new Response(JSON.stringify({ status: 200, code: 0, data, ...(metadata ? { metadata } : {}) }));
const command = name => getRegistry().get(`quark/${name}`);
let fetcher, page, temp;
beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(temp);
    page = { goto: vi.fn(), getCookies: vi.fn().mockResolvedValue([{ name: '__uid', value: 'test-account' }, { name: '__puus', value: 'test-cookie' }]) };
    fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(temp, { recursive: true, force: true }); });
const auth = () => fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, code: 0, data: { nickname: 'Synthetic user', avatarUri: 'https://example.com/avatar' } })));

describe('Quark parity commands', () => {
    it('exposes matching schemas and read/write routing', () => {
        expect(command('list').columns).toEqual(command('info').columns);
        expect(command('list').columns).toEqual(command('search').columns);
        expect(command('uploads').columns).toEqual(command('upload-status').columns);
        expect(command('upload-pause')).toMatchObject({ access: 'write', browser: false });
        expect(command('upload-resume')).toMatchObject({ access: 'write', browser: true });
    });
    it('rejects invalid input before navigation', async () => {
        for (const [name, args] of [['list', { limit: 0 }], ['info', { path: 'bad' }], ['search', { query: ' ' }], ['delete', { path: '/' }], ['move', { path: '/a', to: '../bad' }]]) await expect(command(name).func(page, args)).rejects.toMatchObject({ code: 'ARGUMENT' });
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('lists files with exact limits and fails on repeated pages', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok({ list: [item()] }, { _total: 1 }));
        expect(await command('list').func(page, {})).toEqual([{ name: 'file.txt', path: '/file.txt', type: 'file', size: 7, modifiedAt: 1700000000, id: ID }]);
        const client = new QuarkClient({}, async () => ok({ list: [item()] }, { _total: 2 }));
        await expect(client.children('0')).rejects.toMatchObject({ code: 'QUARK_PAGINATION' });
    });
    it('rejects premature empty pages and missing totals instead of returning partial data', async () => {
        for (const response of [ok({ list: [] }, { _total: 5 }), ok({ list: [] })]) {
            const client = new QuarkClient({}, async () => response);
            await expect(client.children('0')).rejects.toHaveProperty('code');
        }
    });
    it('resolves directory paths even when root directory details omit full_path', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok({ list: [item(DIR, 'Docs', { dir: true, size: 0 })] }, { _total: 1 }))
            .mockResolvedValueOnce(ok(item(DIR, 'Docs', { dir: true, size: 0, full_path: undefined })));
        expect((await command('info').func(page, { path: '/Docs' }))[0]).toMatchObject({ path: '/Docs', type: 'directory', id: DIR });
    });
    it('filters recursive search using verified full paths', async () => {
        auth();
        fetcher.mockResolvedValueOnce(ok({ list: [item(DIR, 'Docs', { dir: true, size: 0 })] }, { _total: 1 }))
            .mockResolvedValueOnce(ok(item(DIR, 'Docs', { dir: true, size: 0 })))
            .mockResolvedValueOnce(ok({ list: [item(), item('c'.repeat(32), 'outside.txt')] }, { _total: 2 }))
            .mockResolvedValueOnce(ok(item(ID, 'file.txt', { pdir_fid: DIR, full_path: [{ file_name: 'Docs' }] })))
            .mockResolvedValueOnce(ok(item('c'.repeat(32), 'outside.txt')));
        const rows = await command('search').func(page, { query: 'txt', dir: '/Docs' });
        expect(rows.map(x => x.path)).toEqual(['/Docs/file.txt']);
    });
    it('distinguishes logged-out sessions from HTTP 403 and network errors', async () => {
        page.getCookies.mockResolvedValueOnce([]);
        expect((await command('login-status').func(page))[0].loggedIn).toBe(false);
        page.getCookies.mockResolvedValue([{ name: '__uid', value: 'test-account' }, { name: '__puus', value: 'test-cookie' }]);
        fetcher.mockResolvedValueOnce(new Response('', { status: 403 }));
        await expect(command('login-status').func(page)).rejects.toMatchObject({ code: 'QUARK_HTTP' });
        fetcher.mockRejectedValueOnce(new Error('offline'));
        await expect(command('login-status').func(page)).rejects.toMatchObject({ code: 'QUARK_NETWORK' });
    });
    it('adds membership and quota to whoami while preserving nickname and logged_in', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok({ member_type: 'SUPER_VIP', total_capacity: 100, use_capacity: 40 }));
        const result = await command('whoami').func(page, {});
        expect(result).toMatchObject({ logged_in: true, nickname: 'Synthetic user', id: 'test-account', membership: 'SUPER_VIP', totalBytes: 100, usedBytes: 40, freeBytes: 60 });
        expect(JSON.stringify(result)).not.toMatch(/test-cookie/);
    });
    it('verifies delete against the parent listing', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok(item())).mockResolvedValueOnce(ok({}))
            .mockResolvedValueOnce(ok({ list: [] }, { _total: 0 }));
        const [row] = await command('delete').func(page, { path: ID });
        expect(row).toMatchObject({ status: 'deleted', id: ID });
        const body = JSON.parse(fetcher.mock.calls[2][1].body);
        expect(body).toEqual({ action_type: 2, filelist: [ID], exclude_fids: [] });
    });
    it('requires explicit recursion to delete a directory', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok(item(DIR, 'Docs', { dir: true, size: 0 })));
        await expect(command('delete').func(page, { path: DIR })).rejects.toMatchObject({ code: 'ARGUMENT' });
        expect(fetcher.mock.calls.some(([url]) => url.includes('file/delete'))).toBe(false);
    });
    it('queues offline-queryable paused uploads with no stored browser credentials', async () => {
        const file = path.join(temp, 'hello.txt'); fs.writeFileSync(file, 'hello');
        auth(); fetcher.mockResolvedValueOnce(ok({ list: [] }, { _total: 0 }));
        const [task] = await command('upload').func(page, { file, paused: true });
        expect(task.status).toBe('paused');
        const state = fs.readFileSync(path.join(taskDirectory(), `${task.id}.json`), 'utf8');
        expect(state).not.toMatch(/test-cookie|__puus/);
        expect((await command('upload-status').func({ id: task.id }))[0]).toEqual(task);
        expect(taskDirectory()).toContain(path.join('.opencli', 'quark', 'uploads'));
    });
    it('preserves explicit root --parent-fid 0 when creating directories', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok({ list: [] }, { _total: 0 }))
            .mockResolvedValueOnce(ok({ fid: DIR }))
            .mockResolvedValueOnce(ok({ list: [item(DIR, 'Docs', { dir: true, size: 0 })] }, { _total: 1 }))
            .mockResolvedValueOnce(ok(item(DIR, 'Docs', { dir: true, size: 0 })));
        expect(await command('mkdir').func(page, { name: 'Docs', 'parent-fid': '0' })).toMatchObject({ status: 'ok', fid: DIR, path: '/Docs' });
        expect(JSON.parse(fetcher.mock.calls[2][1].body).pdir_fid).toBe('0');
    });
    it('does not navigate repeatedly while waiting for manual login', async () => {
        page.getCookies.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        page.wait = vi.fn().mockResolvedValue(undefined);
        auth(); fetcher.mockResolvedValueOnce(ok({ member_type: 'NORMAL', total_capacity: 100, use_capacity: 0 }));
        const result = await command('login').func(page, { timeout: 1 });
        expect(result).toMatchObject({ status: 'login_complete', nickname: 'Synthetic user' });
        expect(page.goto).toHaveBeenCalledTimes(2); // initial probe + opening the login page
    });
    it('retries only reads when directory visibility lags a successful create', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok({ list: [] }, { _total: 0 }))
            .mockResolvedValueOnce(ok({ fid: DIR }))
            .mockResolvedValueOnce(ok({ list: [] }, { _total: 0 }))
            .mockResolvedValueOnce(ok({ list: [item(DIR, 'Docs', { dir: true, size: 0 })] }, { _total: 1 }))
            .mockResolvedValueOnce(ok(item(DIR, 'Docs', { dir: true, size: 0 })));
        expect(await command('mkdir').func(page, { name: 'Docs' })).toMatchObject({ status: 'ok', fid: DIR });
        expect(fetcher.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    });
    it('refuses rename collisions before sending a mutation', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok(item()))
            .mockResolvedValueOnce(ok({ list: [item(DIR, 'occupied.txt')] }, { _total: 1 }))
            .mockResolvedValueOnce(ok(item(DIR, 'occupied.txt')));
        await expect(command('rename').func(page, { fid: ID, name: 'occupied.txt' })).rejects.toMatchObject({ code: 'QUARK_EXISTS' });
        expect(fetcher.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
    });
    it('waits for matching metadata paths after rename without replaying the write', async () => {
        auth(); fetcher.mockResolvedValueOnce(ok(item()))
            .mockResolvedValueOnce(ok({ list: [] }, { _total: 0 }))
            .mockResolvedValueOnce(ok({}))
            .mockResolvedValueOnce(ok({ list: [item(ID, 'new.txt')] }, { _total: 1 }))
            .mockResolvedValueOnce(ok(item()))
            .mockResolvedValueOnce(ok({ list: [item(ID, 'new.txt')] }, { _total: 1 }))
            .mockResolvedValueOnce(ok(item(ID, 'new.txt')));
        expect(await command('rename').func(page, { fid: ID, name: 'new.txt' })).toMatchObject({ status: 'ok', path: '/new.txt', id: ID });
        expect(fetcher.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    });
});
