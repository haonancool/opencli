import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { httpDownload } from '@jackwener/opencli/download';
import { formatBytes } from '@jackwener/opencli/download/progress';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { ensureZsxqAuth, ensureZsxqPage, fetchFirstJson, getFileDownloadInfo } from './utils.js';

function safeFilename(value) {
    const basename = String(value || '').replace(/\\/g, '/').split('/').pop()?.trim() || '';
    if (!basename || basename === '.' || basename === '..')
        return '';
    return basename
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .slice(0, 200);
}
function filenameFromDownload(fileId, requestedName, responseName, downloadUrl) {
    try {
        const url = new URL(downloadUrl);
        const attname = safeFilename(url.searchParams.get('attname'));
        const explicitName = safeFilename(requestedName);
        if (explicitName)
            return explicitName;
        if (attname)
            return attname;
        const apiName = safeFilename(responseName);
        if (apiName)
            return apiName;
        const basename = safeFilename(decodeURIComponent(path.basename(url.pathname)));
        if (basename && basename.includes('.'))
            return basename;
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
        { name: 'output', default: '.', help: 'Output directory (defaults to the current directory)' },
        { name: 'name', help: 'Optional output filename (defaults to the decoded attname in the download URL)' },
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
        const output = String(kwargs.output || '.');
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
