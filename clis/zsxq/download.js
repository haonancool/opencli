import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { httpDownload, sanitizeFilename } from '@jackwener/opencli/download';
import { formatBytes } from '@jackwener/opencli/download/progress';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { ensureZsxqAuth, ensureZsxqPage, fetchFirstJson, getFileDownloadInfo } from './utils.js';

function filenameFromDownload(fileId, requestedName, responseName, downloadUrl) {
    const explicitName = String(requestedName || responseName || '').trim();
    if (explicitName)
        return sanitizeFilename(path.basename(explicitName)) || `${fileId}.bin`;
    try {
        const basename = decodeURIComponent(path.basename(new URL(downloadUrl).pathname));
        if (basename && basename.includes('.'))
            return sanitizeFilename(basename) || `${fileId}.bin`;
    }
    catch {
        // getFileDownloadInfo already validates the URL; fall back defensively.
    }
    return `${fileId}.bin`;
}

export const downloadCommand = cli({
    site: 'zsxq',
    name: 'download',
    access: 'read',
    description: '通过 file_id 下载知识星球文件',
    domain: 'wx.zsxq.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'file_id', positional: true, required: true, help: 'File ID from the files field returned by zsxq topics' },
        { name: 'output', default: './zsxq-downloads', help: 'Output directory' },
        { name: 'name', help: 'Optional output filename (use the name returned by zsxq topics)' },
    ],
    columns: ['file_id', 'name', 'status', 'size', 'path'],
    func: async (page, kwargs) => {
        await ensureZsxqPage(page);
        await ensureZsxqAuth(page);
        const fileId = String(kwargs.file_id || '').trim();
        if (!/^\d+$/.test(fileId))
            throw new ArgumentError('file_id must be a numeric ZSXQ file ID');
        const { data } = await fetchFirstJson(page, [
            `https://api.zsxq.com/v2/files/${encodeURIComponent(fileId)}/download_url`,
        ]);
        const info = getFileDownloadInfo(data);
        const filename = filenameFromDownload(fileId, kwargs.name, info.name, info.download_url);
        const output = String(kwargs.output || './zsxq-downloads');
        const destPath = path.join(output, filename);
        const result = await httpDownload(info.download_url, destPath, { timeout: 60000 });
        if (!result.success) {
            throw new CommandExecutionError(`Failed to download ZSXQ file ${fileId}: ${result.error || 'unknown error'}`);
        }
        return [{
                file_id: fileId,
                name: filename,
                status: 'success',
                size: formatBytes(result.size),
                path: destPath,
            }];
    },
});

export const __test__ = { filenameFromDownload };
