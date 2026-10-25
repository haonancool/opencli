import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from '@jackwener/opencli/errors';
import { QuarkUploadClient } from './upload-api.js';
import { Sha1Context } from './sha1-context.js';
import { CHUNK_SIZE, assertUnchanged, readTask, withTask } from './tasks.js';

const md5 = bytes => createHash('md5').update(bytes).digest('hex');
async function readPart(handle, size, index) {
    const length = Math.min(CHUNK_SIZE, size - index * CHUNK_SIZE), bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
        const result = await handle.read(bytes, offset, length - offset, index * CHUNK_SIZE + offset);
        if (!result.bytesRead) throw new CliError('UPLOAD_FILE_CHANGED', 'Local file ended before its expected size');
        offset += result.bytesRead;
    }
    return bytes;
}

export async function runUpload(id, dir, runId, auth, client = new QuarkUploadClient(auth)) {
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
    const finalize = async () => {
        await edit(task => {
            if (task.status === 'pausing') { controller.abort(); controller.signal.throwIfAborted(); }
            task.status = 'finalizing'; task.speed = 0;
        });
        committing = true;
    };
    try {
        await edit(() => {});
        timer = setInterval(() => { if (!committing) { try { check(); } catch { controller.abort(); } } }, 100); timer.unref();
        let task = check();
        if (task.account !== auth.account) throw new CliError('UPLOAD_ACCOUNT', 'Upload account mismatch');
        assertUnchanged(task);
        handle = await fs.open(task.localPath, 'r');
        await edit(task => { if (task.status !== 'pausing') task.status = 'hashing'; });
        const hashes = [], contexts = [], context = new Sha1Context(), wholeMd5 = createHash('md5'), sha1 = createHash('sha1');
        for (let i = 0; i < Math.ceil(task.size / CHUNK_SIZE); i++) {
            check(); const bytes = await readPart(handle, task.size, i);
            contexts.push(i > 0 ? context.encode() : null);
            if (bytes.length === CHUNK_SIZE) context.update(bytes);
            hashes.push(md5(bytes)); wholeMd5.update(bytes); sha1.update(bytes);
            if (task.hashes.length && task.hashes[i] !== hashes[i]) throw new CliError('UPLOAD_FILE_CHANGED', 'Local file checksum changed; start a new task');
        }
        assertUnchanged(task);
        await edit(task => { task.hashes = hashes; task.partContexts = contexts; });
        task = check();
        const parent = await client.assertDirectory(path.posix.dirname(task.remotePath));
        if (parent.fid !== task.parentId) throw new CliError('UPLOAD_DESTINATION_CHANGED', 'The destination directory changed; start a new task');
        await client.assertAbsent(task.remotePath);
        check();
        if (!task.uploadId && !task.instant) {
            // Precreate can instantly materialize a deduplicated file. Treat its
            // uncertainty as a write; use a task-unique staging name, never the final name.
            await finalize();
            const prepared = await client.prepare(task, wholeMd5.digest('hex'), sha1.digest('hex'));
            await edit(task => { Object.assign(task, prepared); task.etags = []; task.status = prepared.instant ? 'finalizing' : 'uploading'; });
            committing = prepared.instant;
        }
        task = check();
        if (!task.instant) {
            await edit(task => { if (task.status !== 'pausing') task.status = 'uploading'; });
            for (let i = 0; i < hashes.length; i++) {
                task = check();
                if (task.completedParts.includes(i)) continue;
                assertUnchanged(task);
                const bytes = await readPart(handle, task.size, i);
                if (md5(bytes) !== hashes[i]) throw new CliError('UPLOAD_FILE_CHANGED', 'Local file changed during upload');
                const start = Date.now(), etag = await client.uploadPart(task, i, bytes, controller.signal);
                await edit(task => { task.etags[i] = etag; task.completedParts.push(i); task.uploadedBytes += bytes.length; task.speed = Math.round(bytes.length / Math.max(0.001, (Date.now() - start) / 1000)); });
            }
            check(); assertUnchanged(task);
            await client.assertAbsent(task.remotePath);
            await finalize();
            await client.complete(readTask(dir, id));
        }
        task = readTask(dir, id);
        const staged = await client.info(task.fid);
        if (staged.size !== task.size || staged.pdir_fid !== task.parentId || staged.file_name !== task.stageName) throw new CliError('UPLOAD_VERIFY', 'Uploaded staging file does not match the task');
        const remote = await client.rename(task.fid, path.posix.basename(task.remotePath));
        if (remote.id !== task.fid || remote.path !== task.remotePath || remote.size !== task.size) throw new CliError('UPLOAD_VERIFY', 'Final file metadata does not match the task');
        await edit(task => { task.status = 'completed'; task.uploadedBytes = task.size; task.speed = 0; task.error = null; task.pid = null; });
    } catch (error) {
        await edit(task => { task.status = committing ? 'uncertain' : controller.signal.aborted ? 'paused' : 'failed'; task.pid = null; task.speed = 0;
            task.error = task.status === 'paused' ? null : typeof error.exitCode === 'number' ? error.message : 'Upload failed; resume to retry unfinished parts'; });
    } finally { if (timer) clearInterval(timer); await handle?.close(); }
}
