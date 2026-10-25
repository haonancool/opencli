import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArgumentError, CliError } from '@jackwener/opencli/errors';

export const CHUNK_SIZE = 4 * 1024 * 1024;
export const TASK_COLUMNS = ['id', 'name', 'remotePath', 'status', 'progress', 'uploadedBytes', 'size', 'speed', 'error'];
export const ACTIVE = ['queued', 'hashing', 'uploading', 'pausing', 'finalizing'];
export const STATUSES = [...ACTIVE, 'paused', 'completed', 'failed', 'interrupted', 'uncertain'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ownIdentity;
export function taskDirectory() { return path.join(os.homedir(), '.opencli', 'baidu-netdisk', 'uploads'); }

function ensureStore(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
function taskFile(dir, id) {
    if (!/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id || '')) throw new ArgumentError('Invalid upload task ID');
    return path.join(dir, `${id}.json`);
}

export function readTask(dir, id) {
    try { return JSON.parse(fs.readFileSync(taskFile(dir, id), 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') throw new CliError('UPLOAD_NOT_FOUND', `Upload task not found: ${id}`);
        if (error instanceof SyntaxError) throw new CliError('UPLOAD_STATE', `Invalid upload state: ${id}`);
        throw error;
    }
}

function saveTask(dir, task) {
    const target = taskFile(dir, task.id), temp = `${target}.${randomUUID()}.tmp`;
    task.updatedAt = new Date().toISOString();
    try {
        fs.writeFileSync(temp, JSON.stringify(task), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, target);
    } finally { fs.rmSync(temp, { force: true }); }
}

function processIdentity(pid) {
    try {
        if (process.platform === 'linux') {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
            return `${fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${startTicks}`;
        }
        const command = process.platform === 'win32' ? 'powershell.exe' : 'ps';
        const args = process.platform === 'win32'
            ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`]
            : ['-p', String(pid), '-o', 'lstart='];
        return execFileSync(command, args, {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
            env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        }).trim() || undefined;
    } catch { return undefined; }
}

export function isAlive(pid, identity) {
    if (!Number.isInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); } catch (error) { if (error.code !== 'EPERM') return false; }
    if (!identity) return true;
    const actual = pid === process.pid ? (ownIdentity ??= processIdentity(pid)) : processIdentity(pid);
    // If the OS identity query is unavailable, fail closed: do not steal a live lock.
    return actual === undefined || actual === identity;
}

function publishTicket(file, value) {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
}

function liveTickets(lockDir) {
    const tickets = [];
    for (const file of fs.readdirSync(lockDir).filter(name => /^\d+-[a-f\d-]{36}\.json$/.test(name))) {
        const fullPath = path.join(lockDir, file);
        // Filenames are never reused. Removing a dead contender cannot unlink a new owner's lock.
        try {
            const ticket = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            if (!isAlive(Number(file.split('-')[0]), ticket.identity)) { fs.rmSync(fullPath, { force: true }); continue; }
            tickets.push({ file, ...ticket });
        }
        catch (error) { if (error.code !== 'ENOENT') throw new CliError('UPLOAD_LOCK', 'Invalid upload lock ticket'); }
    }
    return tickets;
}

// Lamport bakery lock: publish unique contender tickets atomically, then wait in
// (number, filename) order. Dead owners have no reusable pathname to race over.
// A crash before initial publication leaves only an ignored .tmp file.
export async function withTask(dir, id, edit) {
    ensureStore(dir);
    const lockDir = `${taskFile(dir, id)}.lock`;
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const file = `${process.pid}-${randomUUID()}.json`, ticket = path.join(lockDir, file);
    try {
        const identity = ownIdentity ??= processIdentity(process.pid);
        publishTicket(ticket, { choosing: true, number: 0, identity });
        const number = Math.max(0, ...liveTickets(lockDir).map(x => x.number)) + 1;
        publishTicket(ticket, { choosing: false, number, identity });
        let acquired = false;
        for (let i = 0; i < 500; i++) {
            const ahead = liveTickets(lockDir).some(other => other.file !== file &&
                (other.choosing || other.number < number || (other.number === number && other.file < file)));
            if (!ahead) { acquired = true; break; }
            await sleep(10);
        }
        if (!acquired) throw new CliError('UPLOAD_BUSY', 'Upload task is busy; retry shortly');
        const task = readTask(dir, id);
        const result = await edit(task);
        saveTask(dir, task);
        return result ?? task;
    } finally { fs.rmSync(ticket, { force: true }); fs.rmSync(`${ticket}.tmp`, { force: true }); }
}

export function inspectLocalFile(file) {
    if (typeof file !== 'string' || !file.trim()) throw new ArgumentError('Provide a local file path');
    const localPath = path.resolve(file);
    let stat;
    try { stat = fs.statSync(localPath); }
    catch { throw new ArgumentError(`Local file does not exist: ${localPath}`); }
    if (!stat.isFile()) throw new ArgumentError('Upload accepts one regular file; directories are not supported');
    if (stat.size < 1) throw new ArgumentError('Empty files are not supported by the Baidu multipart upload protocol');
    if (Math.ceil(stat.size / CHUNK_SIZE) > 10000) throw new ArgumentError('File exceeds the 10,000-part upload limit');
    fs.accessSync(localPath, fs.constants.R_OK);
    return { localPath, size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
}

export function assertUnchanged(task) {
    const current = inspectLocalFile(task.localPath);
    if (['size', 'mtimeMs', 'dev', 'ino'].some(key => current[key] !== task[key])) throw new CliError('UPLOAD_FILE_CHANGED', 'Local file changed since the upload was created; start a new task');
}

export function createTask(local, remotePath, account, dir = taskDirectory()) {
    ensureStore(dir);
    const task = { id: randomUUID(), ...local, remotePath, account, status: 'paused', uploadedBytes: 0, speed: 0, completedParts: [], hashes: [], createdAt: new Date().toISOString(), error: null };
    saveTask(dir, task);
    return task;
}

export async function recoverTask(dir, id) {
    return withTask(dir, id, task => {
        if (ACTIVE.includes(task.status) && !isAlive(task.pid, task.workerIdentity)) {
            task.status = task.status === 'finalizing' ? 'uncertain' : task.status === 'pausing' ? 'paused' : 'interrupted';
            task.error = task.status === 'uncertain' ? 'Worker exited during commit; inspect the remote destination before starting another upload' : 'Worker stopped; resume to continue';
            task.speed = 0;
            task.pid = null;
        }
    });
}

export async function taskList(dir = taskDirectory()) {
    ensureStore(dir);
    const tasks = [];
    for (const file of fs.readdirSync(dir).filter(x => /^[a-f\d-]{36}\.json$/.test(x))) tasks.push(await recoverTask(dir, file.slice(0, -5)));
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function taskRow(task) {
    return { id: task.id, name: path.basename(task.localPath), remotePath: task.remotePath, status: task.status,
        progress: task.status === 'completed' ? 100 : Math.min(99.9, Math.floor(task.uploadedBytes / task.size * 1000) / 10),
        uploadedBytes: task.uploadedBytes, size: task.size, speed: task.speed || 0, error: task.error || null };
}

export async function pauseTask(id, dir = taskDirectory()) {
    await recoverTask(dir, id);
    const task = await withTask(dir, id, task => {
        if (task.status === 'finalizing') throw new CliError('UPLOAD_FINALIZING', 'The upload is committing; wait for completion before changing it');
        if (['completed', 'uncertain'].includes(task.status)) throw new ArgumentError(`Cannot pause a ${task.status} task`);
        if (isAlive(task.pid, task.workerIdentity) && ACTIVE.includes(task.status)) task.status = 'pausing';
        else task.status = 'paused';
        task.speed = 0;
    });
    // Wait for the worker's abort acknowledgement; never claim paused while a request is still active.
    if (task.status === 'pausing') {
        for (let i = 0; i < 50; i++) {
            await sleep(100);
            const current = await recoverTask(dir, id);
            if (current.status !== 'pausing') return current;
        }
    }
    return readTask(dir, id);
}

export async function launchTask(id, auth, dir = taskDirectory()) {
    await recoverTask(dir, id);
    return withTask(dir, id, async task => {
        if (task.account !== auth.account) throw new CliError('UPLOAD_ACCOUNT', 'This task belongs to a different Baidu account; log in to the original account');
        if (ACTIVE.includes(task.status)) throw new CliError('UPLOAD_BUSY', 'This upload task already has a worker');
        if (['completed', 'uncertain'].includes(task.status)) throw new ArgumentError(`Cannot resume a ${task.status} task; inspect the destination`);
        assertUnchanged(task);
        task.runId = randomUUID();
        task.status = 'queued';
        task.error = null;
        const child = spawn(process.execPath, [fileURLToPath(new URL('./upload-worker.mjs', import.meta.url)), id, dir, task.runId], {
            detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
        });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        task.pid = child.pid;
        task.workerIdentity = processIdentity(child.pid);
        // Auth travels over a pipe, never argv, task JSON, or worker logs.
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(auth));
        child.unref();
    });
}
