import { createHash } from 'node:crypto';
import { CliError } from '@jackwener/opencli/errors';
import { QuarkClient } from './drive-api.js';
import { CHUNK_SIZE } from './tasks.js';

const USER_AGENT = 'aliyun-sdk-js/1.0.0';
const digest = (bytes, encoding) => createHash('md5').update(bytes).digest(encoding);

export class QuarkUploadClient extends QuarkClient {
    async prepare(task, md5, sha1) {
        const result = await this.request('file/upload/pre', {}, {
            ccp_hash_update: false, parallel_upload: true, pdir_fid: task.parentId, dir_name: '',
            size: task.size, file_name: task.stageName, format_type: 'application/octet-stream',
            l_updated_at: Math.floor(task.mtimeMs), l_created_at: Math.floor(task.mtimeMs), md5, sha1,
        });
        const data = result.data;
        if (typeof data.fid !== 'string' || !/^[a-f\d]{32}$/i.test(data.fid) || typeof data.finish !== 'boolean') throw new CliError('QUARK_RESPONSE', 'Invalid upload preparation response');
        if (data.finish) return { fid: data.fid, instant: true };
        if (result.metadata?.part_size !== CHUNK_SIZE) throw new CliError('QUARK_RESPONSE', 'Unsupported server part size (expected 4 MiB)');
        for (const key of ['task_id', 'upload_id', 'obj_key', 'bucket', 'auth_info']) if (typeof data[key] !== 'string' || !data[key]) throw new CliError('QUARK_RESPONSE', 'Missing upload handle');
        if (!/^[a-z\d-]+$/.test(data.bucket) || !/^[a-z\d/_-]+$/i.test(data.obj_key) || !data.callback || typeof data.callback !== 'object') throw new CliError('QUARK_RESPONSE', 'Invalid upload destination');
        return { serverTaskId: data.task_id, uploadId: data.upload_id, objKey: data.obj_key, bucket: data.bucket, authInfo: data.auth_info, callback: data.callback, fid: data.fid, instant: false };
    }

    async signedRequest(task, method, query, bytes, extraHeaders = {}, signal) {
        if (!/^[a-z\d-]+$/.test(task.bucket || '') || !/^[a-z\d/_-]+$/i.test(task.objKey || '')) throw new CliError('UPLOAD_STATE', 'Invalid saved storage destination');
        const headers = { 'content-type': method === 'PUT' ? 'application/octet-stream' : 'application/xml', 'x-oss-date': new Date().toUTCString(), 'x-oss-user-agent': USER_AGENT, ...extraHeaders };
        if (method === 'POST') headers['content-md5'] = digest(bytes, 'base64');
        const hashContext = headers['X-Oss-Hash-Ctx'] ? `X-Oss-Hash-Ctx:${headers['X-Oss-Hash-Ctx']}\n` : '';
        const canonicalHeaders = hashContext + Object.entries(headers).filter(([key]) => key.startsWith('x-oss-')).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}:${value}\n`).join('');
        const suffix = Object.entries(query).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
        const authMeta = `${method}\n${headers['content-md5'] || ''}\n${headers['content-type']}\n${headers['x-oss-date']}\n${canonicalHeaders}/${task.bucket}/${task.objKey}?${suffix}`;
        const { data } = await this.request('file/upload/auth', {}, { task_id: task.serverTaskId, auth_info: task.authInfo, auth_meta: authMeta }, signal);
        if (typeof data.auth_key !== 'string' || !data.auth_key.startsWith('OSS ')) throw new CliError('QUARK_RESPONSE', 'Missing server upload authorization');
        for (const [key, value] of Object.entries(data.headers || {})) {
            if (!/^x-oss-/i.test(key) || typeof value !== 'string') throw new CliError('QUARK_RESPONSE', 'Unexpected upload authorization header');
            headers[key] = value;
        }
        headers.authorization = data.auth_key;
        let response;
        try {
            response = await this.fetcher(`https://${task.bucket}.pds.quark.cn/${task.objKey}?${new URLSearchParams(query)}`, {
                method, headers, body: bytes, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000),
            });
        } catch (error) {
            if (signal?.aborted) throw error;
            throw new CliError('QUARK_UPLOAD_NETWORK', 'Storage request failed or timed out');
        }
        if (!response.ok) {
            const text = await response.text();
            const code = text.match(/<Code>([A-Za-z\d_-]+)<\/Code>/)?.[1];
            throw new CliError('QUARK_UPLOAD_HTTP', `Storage returned HTTP ${response.status}${code ? ` (${code})` : ''}`);
        }
        return response;
    }

    async uploadPart(task, index, bytes, signal) {
        const extra = index > 0 ? { 'X-Oss-Hash-Ctx': task.partContexts?.[index] } : {};
        if (index > 0 && typeof extra['X-Oss-Hash-Ctx'] !== 'string') throw new CliError('UPLOAD_STATE', 'Missing part checksum context');
        const response = await this.signedRequest(task, 'PUT', { partNumber: String(index + 1), uploadId: task.uploadId }, bytes, extra, signal);
        const etag = response.headers.get('etag')?.replace(/^"|"$/g, '');
        await response.arrayBuffer();
        if (etag?.toLowerCase() !== digest(bytes, 'hex')) throw new CliError('UPLOAD_CHECKSUM', `Part ${index + 1} checksum mismatch`);
        return etag;
    }

    async complete(task) {
        const parts = task.etags.map((etag, index) => {
            if (!/^[a-f\d]{32}$/i.test(etag || '')) throw new CliError('UPLOAD_STATE', 'Missing acknowledged part checksum');
            return `<Part><PartNumber>${index + 1}</PartNumber><ETag>"${etag}"</ETag></Part>`;
        }).join('');
        const xml = `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`;
        const response = await this.signedRequest(task, 'POST', { uploadId: task.uploadId }, Buffer.from(xml), { 'x-oss-callback': Buffer.from(JSON.stringify(task.callback)).toString('base64') });
        const text = await response.text();
        if (/<Error\b/.test(text)) throw new CliError('QUARK_UPLOAD_RESPONSE', 'Storage rejected multipart completion');
        const { data } = await this.request('file/upload/finish', {}, { obj_key: task.objKey, task_id: task.serverTaskId });
        if (data.finish !== true || data.fid !== task.fid || data.size !== task.size) throw new CliError('UPLOAD_VERIFY', 'Upload finish returned unexpected metadata');
    }
}
