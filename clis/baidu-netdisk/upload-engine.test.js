import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaiduClient } from './api.js';
import { runUpload } from './upload-engine.js';
import { CHUNK_SIZE, createTask, inspectLocalFile, launchTask, pauseTask, readTask, recoverTask, taskRow, withTask } from './tasks.js';

const auth = { token: 'fake-token', cookie: 'BDUSS=fake', pcsCookie: 'BDUSS=fake', account: 'synthetic-account' };
const digest = value => createHash('md5').update(value).digest('hex');
const json = value => new Response(JSON.stringify({ errno: 0, ...value }));
let dir, local, task;
beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-baidu-upload-'));
    local = path.join(dir, 'parts.bin');
    fs.writeFileSync(local, Buffer.alloc(CHUNK_SIZE * 2 + 17, 42));
    task = createTask(inspectLocalFile(local), '/parts.bin', auth.account, dir);
    await withTask(dir, task.id, task => { task.runId = randomUUID(); task.status = 'queued'; task.pid = process.pid; });
    task = readTask(dir, task.id);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

function transport({ part, commit, pre, verify } = {}) {
    let committed = false;
    const fetcher = vi.fn(async (input, options) => {
        const url = new URL(input), endpoint = url.pathname.split('/').at(-1);
        if (endpoint === 'filemetas') {
            if (!committed) return json({ errno: 12, info: [{ errno: -9 }] });
            return json({ info: [{ fs_id: 77, path: '/parts.bin', size: task.size, isdir: 0, ...verify }] });
        }
        if (endpoint === 'precreate') return json({ uploadid: 'synthetic-upload-id', block_list: [0, 1, 2], ...pre });
        if (endpoint === 'superfile2') {
            const index = Number(url.searchParams.get('partseq'));
            const bytes = Buffer.from(await options.body.get('file').arrayBuffer());
            if (part) return part(index, bytes, options.signal);
            return json({ md5: digest(bytes), partseq: index });
        }
        if (endpoint === 'create') {
            committed = true;
            if (commit) return commit(options);
            return json({ fs_id: 77, path: '/parts.bin', size: task.size });
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    });
    return { client: new BaiduClient(auth, fetcher), fetcher };
}

describe('Baidu upload worker and durable controls', () => {
    it('uploads bounded parts and reports complete only after independent remote verification', async () => {
        const { client, fetcher } = transport();
        await runUpload(task.id, dir, task.runId, auth, client);
        const result = readTask(dir, task.id);
        expect(result).toMatchObject({ status: 'completed', uploadedBytes: task.size, fsId: '77', pid: null });
        expect(taskRow(result)).toMatchObject({ progress: 100, size: task.size });
        const parts = fetcher.mock.calls.filter(([url]) => url.includes('/superfile2?'));
        expect(parts.map(([, options]) => options.body.get('file').size)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 17]);
        expect(fetcher.mock.calls.at(-1)[0]).toContain('/filemetas?');
    });

    it('aborts a part on pause and resumes with the saved upload ID, skipping acknowledged parts', async () => {
        let interrupted = false, pausePromise;
        const { client, fetcher } = transport({ part: async (index, bytes, signal) => {
            if (index === 1 && !interrupted) {
                interrupted = true;
                pausePromise = pauseTask(task.id, dir);
                await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
                // Do not wait for pauseTask: it waits for this worker's acknowledgement.
                signal.throwIfAborted();
            }
            return json({ md5: digest(bytes) });
        } });
        await runUpload(task.id, dir, task.runId, auth, client);
        await pausePromise;
        const paused = readTask(dir, task.id);
        expect(paused).toMatchObject({ status: 'paused', uploadedBytes: CHUNK_SIZE, completedParts: [0] });
        expect(taskRow(paused).progress).toBeGreaterThan(0);
        expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname === '/api/create')).toBe(false);
        await withTask(dir, task.id, task => { task.status = 'queued'; task.runId = randomUUID(); task.pid = process.pid; });
        const resumed = readTask(dir, task.id);
        await runUpload(task.id, dir, resumed.runId, auth, client);
        expect(readTask(dir, task.id).status).toBe('completed');
        expect(fetcher.mock.calls.filter(([url]) => url.includes('/precreate?'))).toHaveLength(1);
        expect(fetcher.mock.calls.filter(([url]) => url.includes('/superfile2?')).map(([url]) => new URL(url).searchParams.get('partseq'))).toEqual(['0', '1', '1', '2']);
    });

    it('marks lost commit responses uncertain and refuses automatic replay', async () => {
        const { client, fetcher } = transport({ commit: () => { throw new Error('network lost'); } });
        await runUpload(task.id, dir, task.runId, auth, client);
        expect(readTask(dir, task.id).status).toBe('uncertain');
        expect(taskRow(readTask(dir, task.id)).progress).toBe(99.9);
        await expect(launchTask(task.id, auth, dir)).rejects.toThrow(/Cannot resume/);
        expect(fetcher.mock.calls.filter(([url]) => new URL(url).pathname === '/api/create')).toHaveLength(1);
    });

    it('rejects a checksum mismatch without marking a part complete or committing', async () => {
        const { client, fetcher } = transport({ part: () => json({ md5: 'a'.repeat(32) }) });
        await runUpload(task.id, dir, task.runId, auth, client);
        expect(readTask(dir, task.id)).toMatchObject({ status: 'failed', uploadedBytes: 0, completedParts: [] });
        expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname === '/api/create')).toBe(false);
    });

    it('validates precreate shape and never treats malformed part lists as already uploaded', async () => {
        const { client, fetcher } = transport({ pre: { block_list: [99999] } });
        await runUpload(task.id, dir, task.runId, auth, client);
        expect(readTask(dir, task.id)).toMatchObject({ status: 'failed', uploadedBytes: 0 });
        expect(fetcher.mock.calls.some(([url]) => url.includes('/superfile2?'))).toBe(false);
    });

    it('honors server-side deduplicated parts', async () => {
        const { client, fetcher } = transport({ pre: { block_list: [1] } });
        await runUpload(task.id, dir, task.runId, auth, client);
        expect(readTask(dir, task.id)).toMatchObject({ status: 'completed', uploadedBytes: task.size });
        expect(fetcher.mock.calls.filter(([url]) => url.includes('/superfile2?'))).toHaveLength(1);
    });

    it('reassembles short local reads without corrupting parts', async () => {
        const original = fsp.open.bind(fsp);
        vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
            const handle = await original(...args);
            const read = handle.read.bind(handle);
            handle.read = (buffer, offset, length, position) => read(buffer, offset, Math.min(length, 32001), position);
            return handle;
        });
        const { client } = transport();
        await runUpload(task.id, dir, task.runId, auth, client);
        expect(readTask(dir, task.id).status).toBe('completed');
    });

    it('detects local file modifications before resuming and rejects account changes', async () => {
        await withTask(dir, task.id, task => { task.status = 'paused'; task.pid = null; });
        await expect(launchTask(task.id, { ...auth, account: 'another-account' }, dir)).rejects.toMatchObject({ code: 'UPLOAD_ACCOUNT' });
        fs.appendFileSync(local, 'changed');
        await expect(launchTask(task.id, auth, dir)).rejects.toMatchObject({ code: 'UPLOAD_FILE_CHANGED' });
    });

    it('detects same-size changes even when timestamps are restored', async () => {
        const { client } = transport();
        const stat = fs.statSync(local);
        await withTask(dir, task.id, task => { task.hashes = [digest(Buffer.alloc(CHUNK_SIZE, 43))]; });
        fs.utimesSync(local, stat.atime, new Date(stat.mtimeMs));
        await runUpload(task.id, dir, task.runId, auth, client);
        expect(readTask(dir, task.id).status).toBe('failed');
    });

    it('recovers dead workers and serializes concurrent control writes', async () => {
        await withTask(dir, task.id, task => { task.pid = null; task.status = 'uploading'; });
        expect((await recoverTask(dir, task.id)).status).toBe('interrupted');
        await Promise.all(Array.from({ length: 12 }, () => withTask(dir, task.id, task => { task.counter = (task.counter || 0) + 1; })));
        expect(readTask(dir, task.id).counter).toBe(12);
        await withTask(dir, task.id, task => { task.status = 'finalizing'; });
        expect((await recoverTask(dir, task.id)).status).toBe('uncertain');
    });

    it('rejects a second worker and disallows pausing a commit', async () => {
        await expect(launchTask(task.id, auth, dir)).rejects.toMatchObject({ code: 'UPLOAD_BUSY' });
        await withTask(dir, task.id, task => { task.status = 'finalizing'; });
        await expect(pauseTask(task.id, dir)).rejects.toMatchObject({ code: 'UPLOAD_FINALIZING' });
    });

    it('serializes separate processes and safely ignores abandoned unique lock tickets', async () => {
        const exec = promisify(execFile);
        const { stdout } = await exec(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
        const deadPid = Number(stdout), lockDir = path.join(dir, `${task.id}.json.lock`);
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(path.join(lockDir, `${deadPid}-${randomUUID()}.json`), JSON.stringify({ choosing: true, number: 0 }));
        fs.writeFileSync(path.join(lockDir, `${deadPid}-${randomUUID()}.json.tmp`), '');
        const source = `import {withTask} from ${JSON.stringify(new URL('./tasks.js', import.meta.url).href)};
            for(let i=0;i<8;i++) await withTask(process.argv[1], process.argv[2], async task=>{
                const before=task.counter||0; await new Promise(r=>setTimeout(r,3)); task.counter=before+1;
            });`;
        await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath, ['--input-type=module', '-e', source, dir, task.id])));
        expect(readTask(dir, task.id).counter).toBe(48);
        expect((await recoverTask(dir, task.id)).id).toBe(task.id);
    }, 15000);

    it('detects reused worker PIDs and removes tickets from an earlier process with the same PID', async () => {
        await withTask(dir, task.id, task => { task.workerIdentity = 'different-process-start-time'; task.status = 'uploading'; task.pid = process.pid; });
        const lockDir = path.join(dir, `${task.id}.json.lock`);
        const staleTicket = path.join(lockDir, `${process.pid}-${randomUUID()}.json`);
        fs.writeFileSync(staleTicket, JSON.stringify({ choosing: true, number: 0, identity: 'different-process-start-time' }));
        expect((await recoverTask(dir, task.id)).status).toBe('interrupted');
        expect(fs.existsSync(staleTicket)).toBe(false);
    });

    it('keeps process identity stable when a caller changes timezone or locale', async () => {
        let identity;
        await withTask(dir, task.id, () => {
            const lockDir = path.join(dir, `${task.id}.json.lock`);
            const ticket = fs.readdirSync(lockDir).find(file => file.endsWith('.json'));
            identity = JSON.parse(fs.readFileSync(path.join(lockDir, ticket), 'utf8')).identity;
        });
        const source = `import {isAlive} from ${JSON.stringify(new URL('./tasks.js', import.meta.url).href)};
            process.stdout.write(String(isAlive(Number(process.argv[1]),process.argv[2])));`;
        for (const timezone of ['UTC', 'Asia/Taipei']) {
            const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, String(process.pid), identity], { env: { ...process.env, TZ: timezone, LC_ALL: 'C' } });
            expect(stdout).toBe('true');
        }
    });
});
