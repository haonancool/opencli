import path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CliError } from '@jackwener/opencli/errors';
import { BaiduClient, DOMAIN, FILE_COLUMNS, browserAuth, fileName, fileRow, listFiles, positiveInt, remotePath } from './api.js';
import { STATUSES, TASK_COLUMNS, createTask, inspectLocalFile, launchTask, pauseTask, recoverTask, taskDirectory, taskList, taskRow } from './tasks.js';

const browserOptions = { site: 'baidu-netdisk', domain: DOMAIN, strategy: Strategy.COOKIE, browser: true, navigateBefore: false };
const localOptions = { site: 'baidu-netdisk', strategy: Strategy.LOCAL, browser: false };
const pathArg = { name: 'path', positional: true, required: true, help: 'Absolute remote file or directory path' };
const idArg = { name: 'id', positional: true, required: true, help: 'OpenCLI upload task ID (from uploads)' };
const dirArg = { name: 'dir', default: '/', help: 'Absolute remote directory path' };
const limitArg = { name: 'limit', type: 'int', default: 100, help: 'Maximum results (1-10000; follows pagination)' };
const pageArg = { name: 'page', type: 'int', default: 1, help: 'Starting API page (100 entries per page)' };
const clientFor = async page => new BaiduClient(await browserAuth(page));

cli({ ...browserOptions, name: 'list', access: 'read', description: 'List files and subdirectories in Baidu Netdisk',
    args: [dirArg, limitArg, pageArg, { name: 'sort', default: 'name', choices: ['name', 'time', 'size'], help: 'Sort field' }, { name: 'desc', type: 'bool', default: false, help: 'Descending sort' }], columns: FILE_COLUMNS,
    func: async (page, kwargs) => {
        const dir = remotePath(kwargs.dir ?? '/'), limit = positiveInt(kwargs.limit ?? 100, 'limit'), start = positiveInt(kwargs.page ?? 1, 'page');
        const sort = kwargs.sort ?? 'name';
        if (!['name', 'time', 'size'].includes(sort)) throw new ArgumentError('sort must be name, time, or size');
        return listFiles(await clientFor(page), 'list', { dir, order: sort, desc: kwargs.desc ? '1' : '0' }, limit, start);
    },
});

cli({ ...browserOptions, name: 'info', access: 'read', description: 'View metadata for a Baidu Netdisk file or directory',
    args: [pathArg], columns: FILE_COLUMNS,
    func: async (page, kwargs) => {
        const target = remotePath(kwargs.path);
        if (target === '/') throw new ArgumentError('Use list --dir / to view the root directory');
        return [fileRow(await (await clientFor(page)).info(target))];
    },
});

cli({ ...browserOptions, name: 'search', access: 'read', description: 'Search Baidu Netdisk filenames recursively',
    args: [{ name: 'query', positional: true, required: true, help: 'Filename keyword' }, dirArg, limitArg, pageArg], columns: FILE_COLUMNS,
    func: async (page, kwargs) => {
        const query = String(kwargs.query ?? '').trim();
        if (!query) throw new ArgumentError('Search query cannot be empty');
        const dir = remotePath(kwargs.dir ?? '/'), limit = positiveInt(kwargs.limit ?? 100, 'limit'), start = positiveInt(kwargs.page ?? 1, 'page');
        return listFiles(await clientFor(page), 'search', { key: query, dir, recursion: '1' }, limit, start);
    },
});

cli({ ...browserOptions, name: 'rename', access: 'write', description: 'Rename a Baidu Netdisk file or directory without overwriting',
    args: [pathArg, { name: 'name', required: true, help: 'New basename (without directory path)' }], columns: FILE_COLUMNS,
    func: async (page, kwargs) => {
        const source = remotePath(kwargs.path), name = fileName(kwargs.name), destination = path.posix.join(path.posix.dirname(source), name);
        if (source === '/' || source === destination) throw new ArgumentError('Choose a different name for a non-root path');
        return [await (await clientFor(page)).manage('rename', source, destination)];
    },
});

cli({ ...browserOptions, name: 'move', access: 'write', description: 'Move a Baidu Netdisk file or directory without overwriting',
    args: [pathArg, { name: 'to', required: true, help: 'Existing destination directory' }], columns: FILE_COLUMNS,
    func: async (page, kwargs) => {
        const source = remotePath(kwargs.path), dir = remotePath(kwargs.to), destination = path.posix.join(dir, path.posix.basename(source));
        if (source === '/' || source === destination || dir === source || dir.startsWith(`${source}/`)) throw new ArgumentError('Cannot move the root, move into itself, or move into a descendant');
        return [await (await clientFor(page)).manage('move', source, destination)];
    },
});

cli({ ...browserOptions, name: 'mkdir', access: 'write', description: 'Create a Baidu Netdisk directory (parent must exist)',
    args: [pathArg], columns: FILE_COLUMNS,
    func: async (page, kwargs) => {
        const target = remotePath(kwargs.path);
        fileName(path.posix.basename(target));
        if (target === '/') throw new ArgumentError('The root directory already exists');
        const client = await clientFor(page);
        await client.assertDirectory(path.posix.dirname(target));
        await client.assertAbsent(target);
        const result = await client.request('create', { a: 'commit', isdir: '1', rtype: '0' }, { path: target, isdir: '1', block_list: '[]' });
        const remote = await client.info(target);
        if (Number(remote.isdir) !== 1 || String(remote.fs_id) !== String(result.fs_id)) throw new CliError('BAIDU_VERIFY', 'Directory creation could not be verified');
        return [fileRow(remote)];
    },
});

cli({ ...browserOptions, name: 'delete', access: 'write', description: 'Delete a Baidu Netdisk file or directory to the recycle bin',
    args: [pathArg, { name: 'recursive', type: 'bool', default: false, help: 'Allow deletion of a directory and its contents' }], columns: [...FILE_COLUMNS, 'status'],
    func: async (page, kwargs) => {
        const target = remotePath(kwargs.path);
        if (target === '/') throw new ArgumentError('Cannot delete the root directory');
        return [await (await clientFor(page)).delete(target, Boolean(kwargs.recursive))];
    },
});

cli({ ...browserOptions, name: 'upload', access: 'write', description: 'Queue a local file for background, resumable Baidu Netdisk upload',
    args: [{ name: 'file', positional: true, required: true, help: 'Local regular file path' }, dirArg,
        { name: 'name', help: 'Remote basename (defaults to local filename)' },
        { name: 'paused', type: 'bool', default: false, help: 'Create a paused task without starting transfer' }], columns: TASK_COLUMNS,
    func: async (page, kwargs) => {
        const local = inspectLocalFile(kwargs.file), dir = remotePath(kwargs.dir ?? '/');
        const destination = path.posix.join(dir, fileName(kwargs.name ?? path.basename(local.localPath)));
        const auth = await browserAuth(page), client = new BaiduClient(auth);
        await client.assertDirectory(dir);
        await client.assertAbsent(destination);
        const task = createTask(local, destination, auth.account);
        return [taskRow(kwargs.paused ? task : await launchTask(task.id, auth))];
    },
});

cli({ ...localOptions, name: 'uploads', access: 'read', description: 'List persistent OpenCLI upload tasks and acknowledged progress',
    args: [{ name: 'status', choices: STATUSES, help: 'Filter by task status' }, limitArg], columns: TASK_COLUMNS,
    func: async kwargs => {
        const limit = positiveInt(kwargs.limit ?? 100, 'limit');
        if (kwargs.status && !STATUSES.includes(kwargs.status)) throw new ArgumentError('Unknown upload status');
        return (await taskList()).filter(task => !kwargs.status || task.status === kwargs.status).slice(0, limit).map(taskRow);
    },
});

cli({ ...localOptions, name: 'upload-status', access: 'read', description: 'View one OpenCLI upload task and its progress',
    args: [idArg], columns: TASK_COLUMNS,
    func: async kwargs => [taskRow(await recoverTask(taskDirectory(), kwargs.id))],
});

cli({ ...localOptions, name: 'upload-pause', access: 'write', description: 'Pause an OpenCLI upload, aborting its in-flight part',
    args: [idArg], columns: TASK_COLUMNS,
    func: async kwargs => [taskRow(await pauseTask(kwargs.id))],
});

cli({ ...browserOptions, name: 'upload-resume', access: 'write', description: 'Resume an OpenCLI upload with fresh browser credentials',
    args: [idArg], columns: TASK_COLUMNS,
    func: async (page, kwargs) => {
        const task = await recoverTask(taskDirectory(), kwargs.id);
        if (['completed', 'uncertain'].includes(task.status)) throw new ArgumentError(`Cannot resume a ${task.status} task; inspect the remote destination`);
        return [taskRow(await launchTask(kwargs.id, await browserAuth(page)))];
    },
});
