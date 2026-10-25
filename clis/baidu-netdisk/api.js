import path from 'node:path';
import { ArgumentError, AuthRequiredError, CliError } from '@jackwener/opencli/errors';

export const DOMAIN = 'pan.baidu.com';
export const HOME = `https://${DOMAIN}/disk/main`;
export const FILE_COLUMNS = ['name', 'path', 'type', 'size', 'modifiedAt', 'id'];
export { fileName, positiveInt, remotePath } from '../_shared/drive-paths.js';

const COMMON = { app_id: '250528', web: '1', channel: 'chunlei', clienttype: '0' };

export function checkPayload(data, label) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CliError('BAIDU_RESPONSE', `${label}: invalid JSON response`);
    const errno = data.errno ?? data.error_code;
    if ([-6, -7, 111, 110, 31045].includes(Number(errno))) throw new AuthRequiredError(DOMAIN);
    if (errno !== undefined && Number(errno) !== 0) {
        // Do not include upstream messages/URLs: they can contain session credentials.
        throw new CliError('BAIDU_API', `${label}: Baidu returned error ${errno}`, 'Check the path, permissions, available storage, or browser login');
    }
    return data;
}

async function jsonResponse(response, label, requireErrno = true) {
    if (response.status === 401 || response.status === 403) throw new AuthRequiredError(DOMAIN);
    if (!response.ok) throw new CliError('BAIDU_HTTP', `${label}: HTTP ${response.status}`);
    let data;
    try { data = await response.json(); }
    catch { throw new CliError('BAIDU_RESPONSE', `${label}: expected JSON; log in again if Baidu returned a verification page`); }
    checkPayload(data, label);
    if (requireErrno && data.errno === undefined) throw new CliError('BAIDU_RESPONSE', `${label}: missing errno`);
    return data;
}

export async function browserAuth(page, { includePcsCookies = true } = {}) {
    await page.goto(HOME);
    const cookies = await page.getCookies({ url: `https://${DOMAIN}/` });
    const cookie = cookies.map(x => `${x.name}=${x.value}`).join('; ');
    if (!cookies.some(x => x.name === 'BDUSS')) throw new AuthRequiredError(DOMAIN);
    const headers = { cookie, referer: HOME, 'user-agent': 'Mozilla/5.0' };
    let response;
    try {
        response = await fetch(`https://${DOMAIN}/api/gettemplatevariable?fields=${encodeURIComponent('["bdstoken","uk","loginstate"]')}`, {
            headers, signal: AbortSignal.timeout(30000),
        });
    } catch { throw new CliError('BAIDU_NETWORK', 'Login check failed or timed out', 'Check connectivity and retry'); }
    // 403 can be a WAF/risk-control denial, not proof that the user logged out.
    if (response.status === 403) throw new CliError('BAIDU_HTTP', 'Login: HTTP 403', 'Baidu refused the session check; inspect the browser and retry');
    const data = await jsonResponse(response, 'Login');
    if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) throw new CliError('BAIDU_RESPONSE', 'Login: missing session data');
    if ([0, '0'].includes(data.result.loginstate)) throw new AuthRequiredError(DOMAIN);
    if (![1, '1'].includes(data.result.loginstate) || !data.result.bdstoken || !data.result.uk) throw new CliError('BAIDU_RESPONSE', 'Login: incomplete session data');
    const pcsCookies = includePcsCookies ? await page.getCookies({ url: 'https://d.pcs.baidu.com/' }) : [];
    return { cookie, pcsCookie: pcsCookies.map(x => `${x.name}=${x.value}`).join('; '), token: data.result.bdstoken, account: String(data.result.uk) };
}

export async function accountInfo(client) {
    const profile = await client.request('gettemplatevariable', { fields: JSON.stringify(['uk', 'username', 'loginstate', 'is_vip', 'is_svip', 'photo']) });
    const user = profile.result;
    if (user && [0, '0'].includes(user.loginstate)) throw new AuthRequiredError(DOMAIN);
    if (!user || ![1, '1'].includes(user.loginstate) || !user.uk || typeof user.username !== 'string' || !user.username.trim() ||
        ![0, 1, '0', '1'].includes(user.is_vip) || ![0, 1, '0', '1'].includes(user.is_svip)) throw new CliError('BAIDU_RESPONSE', 'User information is incomplete');
    if (String(user.uk) !== client.auth.account) throw new CliError('BAIDU_ACCOUNT', 'The logged-in account changed while reading user information; retry');
    const quota = await client.request('quota', { checkexpire: '1', checkfree: '1' });
    if (!Number.isSafeInteger(quota.total) || quota.total < 0 || !Number.isSafeInteger(quota.used) || quota.used < 0) throw new CliError('BAIDU_RESPONSE', 'Invalid storage quota');
    return { loggedIn: true, id: String(user.uk), username: user.username, avatar: typeof user.photo === 'string' ? user.photo : null,
        membership: Number(user.is_svip) ? 'svip' : Number(user.is_vip) ? 'vip' : 'free',
        totalBytes: quota.total, usedBytes: quota.used, freeBytes: Math.max(0, quota.total - quota.used) };
}

export class BaiduClient {
    constructor(auth, fetcher = fetch) { this.auth = auth; this.fetcher = fetcher; }

    async request(endpoint, params = {}, body, signal) {
        const query = new URLSearchParams({ ...COMMON, bdstoken: this.auth.token, ...params });
        let response;
        try {
            response = await this.fetcher(`https://${DOMAIN}/api/${endpoint}?${query}`, {
                method: body ? 'POST' : 'GET',
                headers: { cookie: this.auth.cookie, referer: HOME, 'user-agent': 'Mozilla/5.0' },
                body: body ? new URLSearchParams(body) : undefined,
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
            });
        } catch (error) {
            if (signal?.aborted) throw error;
            throw new CliError('BAIDU_NETWORK', `${endpoint}: request failed or timed out`, 'For write operations, inspect the destination before retrying');
        }
        return jsonResponse(response, endpoint);
    }

    async info(target, { missing = false } = {}) {
        let result;
        try { result = await this.request('filemetas', { target: JSON.stringify([target]) }); }
        catch (error) { if (missing && error.code === 'BAIDU_API' && /error 12$/.test(error.message)) return null; throw error; }
        if (!Array.isArray(result.info) || result.info.length !== 1) throw new CliError('BAIDU_RESPONSE', 'filemetas: expected one file');
        checkPayload(result.info[0], 'filemetas item');
        if (result.info[0].path !== target) throw new CliError('BAIDU_RESPONSE', 'filemetas: target mismatch');
        return result.info[0];
    }

    async assertDirectory(dir) {
        if (dir !== '/' && Number((await this.info(dir)).isdir) !== 1) throw new ArgumentError(`Destination is not a directory: ${dir}`);
    }

    async assertAbsent(target) {
        if (await this.info(target, { missing: true })) throw new CliError('BAIDU_EXISTS', `Destination already exists: ${target}`, 'Choose a different name; this adapter never overwrites an existing file');
    }

    async manage(opera, source, destination) {
        const original = await this.info(source);
        await this.assertDirectory(path.posix.dirname(destination));
        await this.assertAbsent(destination);
        const item = { path: source, newname: path.posix.basename(destination) };
        if (opera === 'move') item.dest = path.posix.dirname(destination);
        const result = await this.request('filemanager', { opera }, { async: '0', ondup: 'fail', filelist: JSON.stringify([item]) });
        if (!Array.isArray(result.info) || result.info.length !== 1) throw new CliError('BAIDU_RESPONSE', 'filemanager: missing per-file result; inspect destination before retrying');
        checkPayload(result.info[0], 'filemanager item');
        const updated = await this.info(destination);
        if (String(original.fs_id) !== String(updated.fs_id)) throw new CliError('BAIDU_VERIFY', 'The destination file ID does not match the source');
        return fileRow(updated);
    }

    async delete(target, recursive = false) {
        const original = await this.info(target);
        if (Number(original.isdir) === 1 && !recursive) throw new ArgumentError('Deleting a directory requires --recursive');
        const result = await this.request('filemanager', { opera: 'delete' }, { async: '0', filelist: JSON.stringify([target]) });
        if (!Array.isArray(result.info) || result.info.length !== 1) throw new CliError('BAIDU_RESPONSE', 'delete: missing per-file result; inspect the path before retrying');
        checkPayload(result.info[0], 'delete item');
        if (await this.info(target, { missing: true })) throw new CliError('BAIDU_VERIFY', 'Deleted path still exists; inspect it before retrying');
        return { ...fileRow(original), status: 'deleted' };
    }

    async uploadPart(task, index, bytes, signal) {
        const query = new URLSearchParams({ ...COMMON, method: 'upload', type: 'tmpfile', path: task.remotePath, uploadid: task.uploadId, partseq: String(index) });
        const form = new FormData();
        form.set('file', new Blob([bytes]), 'blob');
        let response;
        try {
            response = await this.fetcher(`https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?${query}`, {
                method: 'POST', headers: { cookie: this.auth.pcsCookie, referer: HOME, 'user-agent': 'Mozilla/5.0' }, body: form,
                signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
            });
        } catch (error) {
            if (signal.aborted) throw error;
            throw new CliError('BAIDU_NETWORK', 'Upload part failed or timed out', 'Resume the task to retry the unacknowledged part');
        }
        const result = await jsonResponse(response, 'Upload part', false);
        if (!/^[a-f\d]{32}$/i.test(result.md5 || '')) throw new CliError('BAIDU_RESPONSE', 'Upload part: missing checksum');
        return result.md5;
    }
}

export function fileRow(item) {
    if (typeof item.path !== 'string' || item.fs_id === undefined || ![0, 1].includes(Number(item.isdir))) throw new CliError('BAIDU_RESPONSE', 'Invalid file entry');
    return { name: item.server_filename || path.posix.basename(item.path), path: item.path, type: Number(item.isdir) ? 'directory' : 'file', size: Number(item.size || 0), modifiedAt: item.server_mtime || item.mtime || null, id: String(item.fs_id) };
}

export async function listFiles(client, endpoint, params, limit, startPage = 1) {
    const rows = [], seen = new Set();
    for (let page = startPage; page < startPage + 100; page++) {
        const data = await client.request(endpoint, { ...params, page: String(page), num: '100' });
        if (!Array.isArray(data.list)) throw new CliError('BAIDU_RESPONSE', `${endpoint}: missing file list`);
        let added = 0;
        for (const item of data.list) {
            const row = fileRow(item);
            if (!seen.has(row.path)) { seen.add(row.path); rows.push(row); added++; }
        }
        if (rows.length >= limit) return rows.slice(0, limit);
        if (!data.list.length || Number(data.has_more) === 0 || (data.has_more === undefined && data.list.length < 100)) return rows;
        if (!added) throw new CliError('BAIDU_PAGINATION', 'Baidu returned a repeated page');
    }
    throw new CliError('BAIDU_PAGINATION', 'Page limit reached; narrow the directory or search query');
}
