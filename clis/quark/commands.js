import path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { DOMAIN, FILE_COLUMNS, QuarkClient, browserAuth, fileName, fileRow, positiveInt, remotePath } from './drive-api.js';
import { STATUSES, TASK_COLUMNS, createTask, inspectLocalFile, launchTask, pauseTask, recoverTask, taskDirectory, taskList, taskRow, withTask } from './tasks.js';

const browser = { site: 'quark', domain: DOMAIN, strategy: Strategy.COOKIE, browser: true, navigateBefore: false };
const local = { site: 'quark', strategy: Strategy.LOCAL, browser: false };
const targetArg = { name: 'path', positional: true, required: true, help: 'Absolute remote path or file ID' };
const dirArg = { name: 'dir', default: '/', help: 'Absolute remote directory path' };
const limitArg = { name: 'limit', type: 'int', default: 100, help: 'Maximum results (1-10000)' };
const pageArg = { name: 'page', type: 'int', default: 1, help: 'Starting API page (100 entries per page)' };
const idArg = { name: 'id', positional: true, required: true, help: 'OpenCLI Quark upload task ID' };
const clientFor = async page => new QuarkClient(await browserAuth(page));
export function validateTarget(target) {
    if (typeof target !== 'string' || (!target.startsWith('/') && !/^[a-f\d]{32}$/i.test(target))) throw new ArgumentError('Provide an absolute remote path or Quark file ID');
    return target.startsWith('/') ? remotePath(target) : target;
}

cli({ ...browser, name: 'list', access: 'read', description: 'List Quark files with paths, metadata and pagination',
    args: [dirArg, limitArg, pageArg, { name: 'sort', default: 'name', choices: ['name', 'time', 'size'], help: 'Sort field' }, { name: 'desc', type: 'bool', default: false, help: 'Descending sort' }], columns: FILE_COLUMNS,
    func: async (page, args) => {
        const dir = remotePath(args.dir ?? '/'), limit = positiveInt(args.limit ?? 100, 'limit'), start = positiveInt(args.page ?? 1, 'page');
        const sort = { name: 'file_name', time: 'updated_at', size: 'size' }[args.sort ?? 'name'];
        if (!sort) throw new ArgumentError('sort must be name, time, or size');
        const client = await clientFor(page), parent = await client.assertDirectory(dir), rows = [];
        for await (const items of client.pages('file/sort', { pdir_fid: parent.fid, _sort: `file_type:asc,${sort}:${args.desc ? 'desc' : 'asc'}` }, start)) {
            rows.push(...items.map(item => fileRow(item, path.posix.join(dir, item.file_name))));
            if (rows.length >= limit) return rows.slice(0, limit);
        }
        return rows;
    },
});
cli({ ...browser, name: 'info', access: 'read', description: 'View metadata for a Quark file or directory by path or ID',
    args: [targetArg], columns: FILE_COLUMNS,
    func: async (page, args) => { const target = validateTarget(args.path); return [fileRow(await (await clientFor(page)).resolve(target))]; },
});
cli({ ...browser, name: 'search', access: 'read', description: 'Search Quark filenames recursively under a directory',
    args: [{ name: 'query', positional: true, required: true, help: 'Filename keyword' }, dirArg, limitArg, pageArg], columns: FILE_COLUMNS,
    func: async (page, args) => {
        const query = String(args.query ?? '').trim();
        if (!query) throw new ArgumentError('Search query cannot be empty');
        const dir = remotePath(args.dir ?? '/'), limit = positiveInt(args.limit ?? 100, 'limit'), start = positiveInt(args.page ?? 1, 'page');
        const client = await clientFor(page), rows = [];
        await client.assertDirectory(dir);
        for await (const items of client.pages('file/search', { q: query, _is_hl: '0', _sort: 'file_name:asc' }, start)) {
            for (const item of items) {
                const row = fileRow(await client.info(item.fid));
                if (dir === '/' || row.path.startsWith(`${dir}/`)) rows.push(row);
                if (rows.length >= limit) return rows;
            }
        }
        return rows;
    },
});
cli({ ...browser, name: 'move', access: 'write', description: 'Move a Quark file or directory by path or ID, without overwriting',
    args: [targetArg, { name: 'to', required: true, help: 'Existing destination directory path' }], columns: FILE_COLUMNS,
    func: async (page, args) => { const target = validateTarget(args.path), dir = remotePath(args.to); return [await (await clientFor(page)).move(target, dir)]; },
});
cli({ ...browser, name: 'delete', access: 'write', description: 'Delete a Quark file or directory to the recycle bin',
    args: [targetArg, { name: 'recursive', type: 'bool', default: false, help: 'Allow deleting directories and their contents' }], columns: [...FILE_COLUMNS, 'status'],
    func: async (page, args) => {
        const target = validateTarget(args.path);
        if (target === '/') throw new ArgumentError('Cannot delete the root directory');
        return [await (await clientFor(page)).delete(target, Boolean(args.recursive))];
    },
});
cli({ ...browser, name: 'upload', access: 'write', description: 'Start a persistent background Quark file upload',
    args: [{ name: 'file', positional: true, required: true, help: 'Local regular file path' }, dirArg, { name: 'name', help: 'Remote basename' }, { name: 'paused', type: 'bool', default: false, help: 'Create a paused task' }], columns: TASK_COLUMNS,
    func: async (page, args) => {
        const file = inspectLocalFile(args.file), dir = remotePath(args.dir ?? '/'), destination = path.posix.join(dir, fileName(args.name ?? path.basename(file.localPath)));
        const auth = await browserAuth(page), client = new QuarkClient(auth), parent = await client.assertDirectory(dir);
        await client.assertAbsent(destination);
        const task = createTask(file, destination, auth.account);
        await withTask(taskDirectory(), task.id, task => { task.parentId = parent.fid; task.stageName = `.opencli-${task.id}.upload`; task.etags = []; });
        return [taskRow(args.paused ? await recoverTask(taskDirectory(), task.id) : await launchTask(task.id, auth))];
    },
});
cli({ ...local, name: 'uploads', access: 'read', description: 'List OpenCLI Quark upload tasks and acknowledged progress', args: [{ name: 'status', choices: STATUSES, help: 'Task status filter' }, limitArg], columns: TASK_COLUMNS,
    func: async args => {
        const limit = positiveInt(args.limit ?? 100, 'limit');
        if (args.status && !STATUSES.includes(args.status)) throw new ArgumentError('Unknown upload status');
        return (await taskList()).filter(task => !args.status || task.status === args.status).slice(0, limit).map(taskRow);
    },
});
cli({ ...local, name: 'upload-status', access: 'read', description: 'View a Quark upload task and its progress', args: [idArg], columns: TASK_COLUMNS,
    func: async args => [taskRow(await recoverTask(taskDirectory(), args.id))],
});
cli({ ...local, name: 'upload-pause', access: 'write', description: 'Pause an OpenCLI Quark upload and abort its in-flight part', args: [idArg], columns: TASK_COLUMNS,
    func: async args => [taskRow(await pauseTask(args.id))],
});
cli({ ...browser, name: 'upload-resume', access: 'write', description: 'Resume a Quark upload with fresh browser login', args: [idArg], columns: TASK_COLUMNS,
    func: async (page, args) => {
        const task = await recoverTask(taskDirectory(), args.id);
        if (['completed', 'uncertain'].includes(task.status)) throw new ArgumentError(`Cannot resume a ${task.status} task; inspect its destination`);
        return [taskRow(await launchTask(args.id, await browserAuth(page)))];
    },
});
