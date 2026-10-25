import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from '@jackwener/opencli/errors';
import { BaiduClient } from './api.js';
import { CHUNK_SIZE, assertUnchanged, readTask, withTask } from './tasks.js';

const md5 = bytes => createHash('md5').update(bytes).digest('hex');

async function readPart(handle, size, index) {
    const length = Math.min(CHUNK_SIZE, size - index * CHUNK_SIZE), bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
        const read = await handle.read(bytes, offset, length - offset, index * CHUNK_SIZE + offset);
        if (!read.bytesRead) throw new CliError('UPLOAD_FILE_CHANGED', 'Local file ended before the expected size');
        offset += read.bytesRead;
    }
    return bytes;
}

export async function runUpload(id, dir, runId, auth, client = new BaiduClient(auth)) {
    const controller = new AbortController();
    let handle, timer, committing = false;
    const check = () => {
        const task = readTask(dir, id);
        if (task.runId !== runId || task.status === 'pausing') controller.abort();
        controller.signal.throwIfAborted();
        return task;
    };
    const edit = callback => withTask(dir, id, task => {
        if (task.runId !== runId) throw new CliError('UPLOAD_SUPERSEDED', 'Upload worker superseded');
        return callback(task);
    });
    try {
        // The launcher publishes queued/runId while holding the same lock. Wait
        // for that publication before inspecting state or starting the pause poll.
        await edit(() => {});
        timer = setInterval(() => { if (!committing) { try { check(); } catch { controller.abort(); } } }, 100);
        timer.unref();
        let task = check();
        if (task.account !== auth.account) throw new CliError('UPLOAD_ACCOUNT', 'Upload account mismatch');
        assertUnchanged(task);
        handle = await fs.open(task.localPath, 'r');
        await edit(task => { if (task.status !== 'pausing') task.status = 'hashing'; });
        const hashes = [];
        for (let i = 0; i < Math.ceil(task.size / CHUNK_SIZE); i++) {
            check();
            hashes.push(md5(await readPart(handle, task.size, i)));
            if (task.hashes.length && task.hashes[i] !== hashes[i]) throw new CliError('UPLOAD_FILE_CHANGED', 'Local file checksum changed; start a new task');
        }
        assertUnchanged(task);
        await edit(task => { task.hashes = hashes; });
        task = check();
        await client.assertDirectory(path.posix.dirname(task.remotePath));
        await client.assertAbsent(task.remotePath);
        check();
        if (!task.uploadId) {
            const pre = await client.request('precreate', { rtype: '0' }, {
                path: task.remotePath, size: String(task.size), isdir: '0', autoinit: '1', rtype: '0', block_list: JSON.stringify(hashes),
            }, controller.signal);
            if (!pre.uploadid || !Array.isArray(pre.block_list) || !pre.block_list.every(i => Number.isInteger(i) && i >= 0 && i < hashes.length)) {
                throw new CliError('BAIDU_RESPONSE', 'precreate: invalid upload ID or part list');
            }
            await edit(task => {
                task.uploadId = pre.uploadid;
                // The server may already have some content-addressed parts.
                task.completedParts = hashes.map((_, i) => i).filter(i => !pre.block_list.includes(i));
                task.uploadedBytes = task.completedParts.reduce((sum, i) => sum + Math.min(CHUNK_SIZE, task.size - i * CHUNK_SIZE), 0);
            });
        }
        check();
        await edit(task => { if (task.status !== 'pausing') task.status = 'uploading'; });
        task = check();
        for (let i = 0; i < hashes.length; i++) {
            check();
            if (task.completedParts.includes(i)) continue;
            assertUnchanged(task);
            const bytes = await readPart(handle, task.size, i);
            if (md5(bytes) !== hashes[i]) throw new CliError('UPLOAD_FILE_CHANGED', 'Local file changed while uploading');
            const start = Date.now();
            const checksum = await client.uploadPart(task, i, bytes, controller.signal);
            if (checksum !== hashes[i]) throw new CliError('UPLOAD_CHECKSUM', `Part ${i} checksum mismatch`);
            await edit(task => {
                task.completedParts.push(i);
                task.uploadedBytes += bytes.length;
                task.speed = Math.round(bytes.length / Math.max(0.001, (Date.now() - start) / 1000));
            });
        }
        task = check();
        assertUnchanged(task);
        await client.assertAbsent(task.remotePath);
        check();
        // Commit is not retried or aborted by pause. A lost response is an uncertain write.
        await edit(task => {
            if (task.status === 'pausing') { controller.abort(); controller.signal.throwIfAborted(); }
            task.status = 'finalizing'; task.speed = 0;
        });
        committing = true;
        const created = await client.request('create', { isdir: '0', rtype: '0' }, {
            path: task.remotePath, size: String(task.size), uploadid: task.uploadId, block_list: JSON.stringify(hashes),
        });
        if (created.path !== task.remotePath || Number(created.size) !== task.size || created.fs_id === undefined) throw new CliError('UPLOAD_VERIFY', 'Upload commit returned unexpected metadata');
        const remote = await client.info(task.remotePath);
        if (Number(remote.size) !== task.size || String(remote.fs_id) !== String(created.fs_id)) throw new CliError('UPLOAD_VERIFY', 'Remote metadata does not match the committed upload');
        await edit(task => { task.status = 'completed'; task.fsId = String(remote.fs_id); task.error = null; task.pid = null; });
    } catch (error) {
        await edit(task => {
            task.status = committing ? 'uncertain' : controller.signal.aborted ? 'paused' : 'failed';
            task.error = task.status === 'paused' ? null : error.code && typeof error.exitCode === 'number' ? error.message : 'Upload failed; resume to retry unfinished parts';
            task.speed = 0; task.pid = null;
        });
    } finally { if (timer) clearInterval(timer); await handle?.close(); }
}
