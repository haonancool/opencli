import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { QuarkUploadClient } from './upload-api.js';
import { runUpload } from './upload-engine.js';
import { CHUNK_SIZE, createTask, inspectLocalFile, pauseTask, readTask, withTask } from './tasks.js';
const ID = 'a'.repeat(32), auth = { account: 'test-account', cookie: 'synthetic-cookie' };
const digest = value => createHash('md5').update(value).digest('hex');
const ok = (data, metadata) => new Response(JSON.stringify({ code: 0, status: 200, data, metadata }));
let dir, task;
beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-worker-test-'));
    const file = path.join(dir, 'parts.bin'); fs.writeFileSync(file, Buffer.alloc(CHUNK_SIZE * 2 + 17, 42));
    task = createTask(inspectLocalFile(file), '/parts.bin', auth.account, dir);
    await withTask(dir, task.id, task => { task.parentId = '0'; task.stageName = `.opencli-${task.id}.upload`; task.etags = []; task.status = 'queued'; task.pid = process.pid; task.runId = randomUUID(); });
    task = readTask(dir, task.id);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function transport({ part, complete, instant = false, partSize = CHUNK_SIZE } = {}) {
    let committed = instant, renamed = false;
    const entry = () => ({ fid: ID, pdir_fid: '0', full_path: [], file_name: renamed ? 'parts.bin' : task.stageName, size: task.size, dir: false });
    const fetcher = vi.fn(async (input, options) => {
        const url = new URL(input);
        if (url.host.endsWith('.pds.quark.cn')) {
            expect(options.headers.cookie).toBeUndefined();
            expect(options.headers.authorization).toBe('OSS synthetic-signature');
            if (options.method === 'PUT') {
                const index = Number(url.searchParams.get('partNumber')) - 1;
                if (index > 0) expect(JSON.parse(Buffer.from(options.headers['X-Oss-Hash-Ctx'], 'base64').toString()).Nl).toBe(String(index * CHUNK_SIZE * 8));
                if (part) return part(index, options.body, options.signal);
                return new Response('', { headers: { etag: `"${digest(options.body).toUpperCase()}"` } });
            }
            expect(options.headers['content-md5']).toBe(createHash('md5').update(options.body).digest('base64'));
            expect(options.body.toString()).toContain('<CompleteMultipartUpload>');
            for (const etag of options.body.toString().split('<ETag>').slice(1).map(value => value.split('</ETag>')[0])) expect(etag).toBe(etag.toUpperCase());
            if (complete) return complete();
            committed = true; return new Response('{}');
        }
        const endpoint = url.pathname.replace('/1/clouddrive/', '');
        if (endpoint === 'file/sort') return ok({ list: committed ? [entry()] : [] }, { _total: committed ? 1 : 0 });
        if (endpoint === 'file/info') return ok(entry());
        if (endpoint === 'file/rename') { renamed = true; return ok({}); }
        if (endpoint === 'file/upload/pre') {
            const body = JSON.parse(options.body);
            expect(body.file_name).toBe(task.stageName);
            expect(body.file_name).not.toBe('parts.bin');
            expect(body.md5).toMatch(/^[a-f\d]{32}$/);
            expect(body.sha1).toMatch(/^[a-f\d]{40}$/);
            return ok({ fid: ID, finish: instant, task_id: 'server-task', upload_id: 'upload-id', obj_key: 'synthetic/object', bucket: 'test-bucket', auth_info: 'synthetic-lease', callback: { callbackUrl: 'https://example.com/callback' } }, { part_size: partSize });
        }
        if (endpoint === 'file/upload/auth') {
            const body = JSON.parse(options.body);
            expect(body.task_id).toBe('server-task');
            expect(body.auth_meta).toContain('/test-bucket/synthetic/object?');
            if (/partNumber=[23]/.test(body.auth_meta)) expect(body.auth_meta).toContain('\nX-Oss-Hash-Ctx:');
            return ok({ auth_key: 'OSS synthetic-signature', headers: {} });
        }
        if (endpoint === 'file/upload/finish') return ok({ finish: true, fid: ID, size: task.size });
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    });
    return { fetcher, client: new QuarkUploadClient(auth, fetcher) };
}
describe('Quark multipart worker', () => {
    it('uploads bounded parts, signs through the server and verifies the final rename', async () => {
        const { client, fetcher } = transport();
        await runUpload(task.id, dir, task.runId, auth, client);
        expect(readTask(dir, task.id)).toMatchObject({ status: 'completed', uploadedBytes: task.size, completedParts: [0, 1, 2], pid: null });
        const parts = fetcher.mock.calls.filter(([url, options]) => url.includes('.pds.quark.cn') && options.method === 'PUT');
        expect(parts.map(([, options]) => options.body.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 17]);
        expect(new URL(fetcher.mock.calls.at(-1)[0]).pathname).toBe('/1/clouddrive/file/info');
    });
    it('aborts an in-flight part, retains acknowledgements and resumes without a second precreate', async () => {
        let aborted = false, pause;
        const { client, fetcher } = transport({ part: async (index, bytes, signal) => {
            if (index === 1 && !aborted) {
                aborted = true; pause = pauseTask(task.id, dir);
                await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
                signal.throwIfAborted();
            }
            return new Response('', { headers: { etag: `"${digest(bytes).toUpperCase()}"` } });
        } });
        await runUpload(task.id, dir, task.runId, auth, client); await pause;
        expect(readTask(dir, task.id)).toMatchObject({ status: 'paused', uploadedBytes: CHUNK_SIZE, completedParts: [0] });
        await withTask(dir, task.id, task => { task.status = 'queued'; task.pid = process.pid; task.runId = randomUUID(); });
        await runUpload(task.id, dir, readTask(dir, task.id).runId, auth, client);
        expect(readTask(dir, task.id).status).toBe('completed');
        expect(fetcher.mock.calls.filter(([url]) => url.includes('/upload/pre?'))).toHaveLength(1);
        expect(fetcher.mock.calls.filter(([url, options]) => url.includes('.pds.quark.cn') && options.method === 'PUT').map(([url]) => new URL(url).searchParams.get('partNumber'))).toEqual(['1', '2', '2', '3']);
    });
    it('supports instant deduplication without sending parts', async () => {
        const { client, fetcher } = transport({ instant: true });
        // The destination lookup before preparation must not see the future staging file.
        await runUpload(task.id, dir, task.runId, auth, client);
        expect(readTask(dir, task.id).status).toBe('completed');
        expect(fetcher.mock.calls.some(([url]) => url.includes('.pds.quark.cn'))).toBe(false);
    });
    it('marks a lost completion response uncertain without replaying it', async () => {
        const { client, fetcher } = transport({ complete: () => { throw new Error('lost response'); } });
        await runUpload(task.id, dir, task.runId, auth, client);
        expect(readTask(dir, task.id).status).toBe('uncertain');
        expect(fetcher.mock.calls.filter(([url, options]) => url.includes('.pds.quark.cn') && options.method === 'POST')).toHaveLength(1);
    });
    it('refuses changed files, checksums and unsupported part sizes', async () => {
        const { client } = transport({ part: () => new Response('', { headers: { etag: 'wrong' } }) });
        await runUpload(task.id, dir, task.runId, auth, client);
        expect(readTask(dir, task.id)).toMatchObject({ status: 'failed', uploadedBytes: 0 });
    });
    it('does not accept a malformed server upload configuration', async () => {
        const { client } = transport({ partSize: 123 });
        await runUpload(task.id, dir, task.runId, auth, client);
        expect(readTask(dir, task.id)).toMatchObject({ status: 'uncertain', uploadedBytes: 0 });
    });
    it('rejects a tampered storage hostname before requesting authorization', async () => {
        const { client, fetcher } = transport();
        await expect(client.signedRequest({ bucket: 'example.com/escape', objKey: 'object' }, 'PUT', {}, Buffer.from('x'))).rejects.toMatchObject({ code: 'UPLOAD_STATE' });
        expect(fetcher).not.toHaveBeenCalled();
    });
});
