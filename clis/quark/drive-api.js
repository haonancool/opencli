import path from 'node:path';
import { ArgumentError, AuthRequiredError, CliError } from '@jackwener/opencli/errors';
import { fileName, positiveInt, remotePath } from '../_shared/drive-paths.js';
export { fileName, positiveInt, remotePath };

export const DOMAIN = 'pan.quark.cn';
export const HOME = 'https://pan.quark.cn/';
export const API = 'https://drive-pc.quark.cn/1/clouddrive/';
export const MEMBER = 'https://drive-member-h.quark.cn/1/clouddrive/member';
export const FILE_COLUMNS = ['name', 'path', 'type', 'size', 'modifiedAt', 'id'];
export const USER_COLUMNS = ['logged_in', 'site', 'id', 'nickname', 'avatar', 'membership', 'totalBytes', 'usedBytes', 'freeBytes'];

async function parseResponse(response, account = false) {
    if (response.status === 401) throw new AuthRequiredError(DOMAIN);
    if (!response.ok) throw new CliError('QUARK_HTTP', `Quark returned HTTP ${response.status}`);
    let data;
    try { data = await response.json(); } catch { throw new CliError('QUARK_RESPONSE', 'Quark returned a non-JSON response; inspect the browser for verification'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CliError('QUARK_RESPONSE', 'Invalid Quark response');
    if ([401, 41001, 31001].includes(Number(data.code)) || Number(data.status) === 401) throw new AuthRequiredError(DOMAIN);
    if (account) {
        if (Array.isArray(data.data) && data.data.length === 0) throw new AuthRequiredError(DOMAIN);
        if (data.success !== true) throw new CliError('QUARK_RESPONSE', 'Account check was not successful');
    } else if (data.status !== 200 || data.code !== 0) {
        throw new CliError('QUARK_API', `Quark API error ${data.code ?? 'unknown'} (status ${data.status ?? 'unknown'})`, 'Check login, permissions and the target; inspect state before retrying a write');
    }
    if (!data.data || typeof data.data !== 'object' || Array.isArray(data.data)) throw new CliError('QUARK_RESPONSE', 'Missing Quark response data');
    return data;
}

export async function browserAuth(page, { navigate = true } = {}) {
    if (navigate) await page.goto(HOME);
    const scoped = await Promise.all([HOME, API, MEMBER].map(url => page.getCookies({ url })));
    const uid = scoped[0].find(c => c.name === '__uid')?.value;
    if (!uid || !scoped[0].some(c => c.name === '__puus')) throw new AuthRequiredError(DOMAIN);
    const [panCookie, cookie, memberCookie] = scoped.map(cookies => cookies.map(c => `${c.name}=${c.value}`).join('; '));
    const auth = { account: uid, cookie, panCookie, memberCookie };
    const profile = await new QuarkClient(auth).profile();
    return { ...auth, profile };
}

export class QuarkClient {
    constructor(auth, fetcher = fetch) { this.auth = auth; this.fetcher = fetcher; }

    async fetchJson(url, body, signal, account = false) {
        const cookie = url.startsWith(HOME) ? this.auth.panCookie : url.startsWith(MEMBER) ? this.auth.memberCookie : this.auth.cookie;
        let response;
        try {
            response = await this.fetcher(url, { method: body ? 'POST' : 'GET', headers: { cookie, referer: HOME, 'user-agent': 'Mozilla/5.0', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect: 'error' });
        } catch (error) {
            if (signal?.aborted) throw error;
            throw new CliError('QUARK_NETWORK', 'Quark request failed or timed out', 'For writes, inspect the destination before retrying');
        }
        return parseResponse(response, account);
    }

    async request(endpoint, params = {}, body, signal) {
        return this.fetchJson(`${API}${endpoint}?${new URLSearchParams({ pr: 'ucpro', fr: 'pc', uc_param_str: '', ...params })}`, body, signal);
    }

    async profile() {
        const { data } = await this.fetchJson(`${HOME}account/info?fr=pc&platform=pc`, undefined, undefined, true);
        if (typeof data.nickname !== 'string' || !data.nickname.trim()) throw new CliError('QUARK_RESPONSE', 'Missing account nickname');
        return { nickname: data.nickname, avatar: typeof data.avatarUri === 'string' ? data.avatarUri : null };
    }

    async userInfo() {
        const profile = this.auth.profile || await this.profile();
        const { data } = await this.fetchJson(`${MEMBER}?pr=ucpro&fr=pc`);
        if (!Number.isSafeInteger(data.total_capacity) || data.total_capacity < 0 || !Number.isSafeInteger(data.use_capacity) || data.use_capacity < 0 || typeof data.member_type !== 'string') throw new CliError('QUARK_RESPONSE', 'Invalid member capacity response');
        return { logged_in: true, site: 'quark', id: this.auth.account, ...profile, membership: data.member_type,
            totalBytes: data.total_capacity, usedBytes: data.use_capacity, freeBytes: Math.max(0, data.total_capacity - data.use_capacity) };
    }

    async *pages(endpoint, params = {}, startPage = 1) {
        const seen = new Set();
        let received = (startPage - 1) * 100;
        for (let page = startPage; page < startPage + 100; page++) {
            const result = await this.request(endpoint, { ...params, _page: String(page), _size: '100', _fetch_total: '1' });
            const list = result.data.list, total = result.metadata?._total;
            if (!Array.isArray(list) || !Number.isSafeInteger(total) || total < 0) throw new CliError('QUARK_RESPONSE', 'Missing file list or total count');
            const unique = [];
            for (const item of list) {
                if (!item || typeof item.fid !== 'string' || !item.file_name || typeof item.dir !== 'boolean') throw new CliError('QUARK_RESPONSE', 'Malformed file entry');
                if (seen.has(item.fid)) throw new CliError('QUARK_PAGINATION', 'Quark returned a repeated file/page');
                seen.add(item.fid); unique.push(item);
            }
            received += list.length;
            if (!list.length && received < total) throw new CliError('QUARK_PAGINATION', 'Quark returned an empty page before the reported total');
            yield unique;
            if (received >= total) return;
        }
        throw new CliError('QUARK_PAGINATION', 'Page limit reached; narrow the directory or search');
    }

    async children(fid) {
        const items = [];
        for await (const batch of this.pages('file/sort', { pdir_fid: fid, _sort: 'file_type:asc,file_name:asc' })) items.push(...batch);
        return items;
    }

    async info(fid, ancestors = new Set()) {
        if (!/^[a-f\d]{32}$/i.test(fid)) throw new ArgumentError('Provide a Quark file ID or absolute path');
        if (ancestors.has(fid) || ancestors.size >= 128) throw new CliError('QUARK_RESPONSE', 'Cyclic or excessively deep parent directory chain');
        ancestors.add(fid);
        const { data } = await this.request('file/info', { fid, _fetch_full_path: '1' });
        if (data.fid !== fid || typeof data.dir !== 'boolean' || typeof data.pdir_fid !== 'string') throw new CliError('QUARK_RESPONSE', 'Invalid file detail or identity mismatch');
        if (data.full_path === undefined) {
            if (data.pdir_fid === '0') data.full_path = [];
            else { const parent = await this.info(data.pdir_fid, ancestors); data.full_path = [...parent.full_path, parent]; }
        }
        if (!Array.isArray(data.full_path)) throw new CliError('QUARK_RESPONSE', 'Invalid parent directory path');
        return data;
    }

    async resolve(target, { missing = false } = {}) {
        if (!target.startsWith('/')) return this.info(target);
        const full = remotePath(target);
        if (full === '/') return { fid: '0', pdir_fid: null, dir: true, file_name: '', full_path: [], size: 0 };
        let parent = '0';
        const segments = full.split('/').filter(Boolean);
        for (let i = 0; i < segments.length; i++) {
            const matches = (await this.children(parent)).filter(x => x.file_name === segments[i]);
            if (!matches.length) {
                if (missing && i === segments.length - 1) return null;
                throw new CliError('QUARK_NOT_FOUND', `Remote path not found: ${full}`);
            }
            if (matches.length !== 1) throw new CliError('QUARK_AMBIGUOUS', `Multiple files have the path: ${full}`);
            const match = matches[0];
            if (i === segments.length - 1) return this.info(match.fid);
            if (!match.dir) throw new ArgumentError('A parent path component is not a directory');
            parent = match.fid;
        }
    }

    async assertDirectory(dir) {
        const item = await this.resolve(dir);
        if (!item.dir) throw new ArgumentError('Destination is not a directory');
        return item;
    }

    async assertAbsent(target, allowedFid) {
        const existing = await this.resolve(target, { missing: true });
        if (existing && existing.fid !== allowedFid) throw new CliError('QUARK_EXISTS', `Destination already exists: ${target}`);
    }

    async waitForPath(target, fid) {
        // The directory index may lag a successful mutation. Retry only reads.
        for (let i = 0; i < 12; i++) {
            try {
                const item = await this.resolve(target);
                if (item.fid !== fid) throw new CliError('QUARK_VERIFY', 'Destination identity differs from the mutated file');
                if (fileRow(item).path === target) return item;
            } catch (error) { if (error.code !== 'QUARK_NOT_FOUND') throw error; }
            await new Promise(r => setTimeout(r, 250));
        }
        throw new CliError('QUARK_VERIFY', 'Destination is not yet visible; inspect it before retrying the write');
    }

    async waitTask(id) {
        if (!id) return;
        for (let i = 0; i < 60; i++) {
            const { data } = await this.request('task', { task_id: id, retry_index: String(i) });
            if (data.status === 2) return;
            if (![0, 1].includes(data.status)) throw new CliError('QUARK_TASK', `Remote file operation failed (status ${data.status})`);
            await new Promise(r => setTimeout(r, 500));
        }
        throw new CliError('QUARK_TASK', 'Remote operation timed out; inspect the destination before retrying');
    }

    async rename(target, name) {
        const item = await this.resolve(target), original = fileRow(item);
        if (item.fid === '0') throw new ArgumentError('Cannot rename the root directory');
        const destination = path.posix.join(path.posix.dirname(original.path), fileName(name));
        if (destination === original.path) throw new ArgumentError('Choose a different name');
        await this.assertAbsent(destination);
        await this.request('file/rename', {}, { fid: item.fid, file_name: name });
        const updated = await this.waitForPath(destination, item.fid);
        if (updated.fid !== item.fid) throw new CliError('QUARK_VERIFY', 'Renamed file identity does not match the source');
        return { ...fileRow(updated), status: 'ok', fid: item.fid, new_name: name };
    }

    async move(target, dir) {
        const item = await this.resolve(target), source = fileRow(item), destination = path.posix.join(dir, source.name);
        if (item.fid === '0' || destination === source.path || dir === source.path || dir.startsWith(`${source.path}/`)) throw new ArgumentError('Cannot move the root or move a directory into itself');
        const parent = await this.assertDirectory(dir);
        await this.assertAbsent(destination);
        const { data } = await this.request('file/move', {}, { filelist: [item.fid], to_pdir_fid: parent.fid });
        await this.waitTask(data.task_id);
        const updated = await this.waitForPath(destination, item.fid);
        if (updated.fid !== item.fid) throw new CliError('QUARK_VERIFY', 'Moved file identity does not match the source');
        return fileRow(updated);
    }

    async delete(target, recursive = false) {
        const item = await this.resolve(target), original = fileRow(item);
        if (item.fid === '0') throw new ArgumentError('Cannot delete the root directory');
        if (item.dir && !recursive) throw new ArgumentError('Deleting a directory requires --recursive');
        const { data } = await this.request('file/delete', {}, { action_type: 2, filelist: [item.fid], exclude_fids: [] });
        await this.waitTask(data.task_id);
        for (let i = 0; i < 12; i++) {
            if (!(await this.children(item.pdir_fid)).some(x => x.fid === item.fid)) return { ...original, status: 'deleted' };
            await new Promise(r => setTimeout(r, 250));
        }
        throw new CliError('QUARK_VERIFY', 'Deleted file is still present; inspect the path before retrying');
    }
}

export function fileRow(item, knownPath) {
    if (!item || typeof item.fid !== 'string' || typeof item.dir !== 'boolean' || typeof item.file_name !== 'string' || !Number.isSafeInteger(item.size) || item.size < 0) throw new CliError('QUARK_RESPONSE', 'Malformed file metadata');
    const full = knownPath ?? '/' + [...(item.full_path || []).map(x => x.file_name), item.file_name].filter(Boolean).join('/');
    const modified = item.updated_at ?? item.l_updated_at;
    return { name: item.file_name, path: full, type: item.dir ? 'directory' : 'file', size: item.size, modifiedAt: Number.isFinite(modified) ? Math.floor(modified / 1000) : null, id: item.fid };
}
