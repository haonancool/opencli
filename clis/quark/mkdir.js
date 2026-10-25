import path from 'node:path';
import { ArgumentError, CliError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { QuarkClient, browserAuth, fileName, fileRow, remotePath } from './drive-api.js';
cli({
    site: 'quark', name: 'mkdir', access: 'write', description: 'Create a Quark folder by name or absolute path',
    domain: 'pan.quark.cn', strategy: Strategy.COOKIE, navigateBefore: false, defaultFormat: 'json',
    args: [
        { name: 'name', required: true, positional: true, help: 'Folder name or absolute remote path' },
        { name: 'parent', help: 'Parent folder path' },
        { name: 'parent-fid', help: 'Parent folder ID' },
    ],
    func: async (page, args) => {
        const absolute = String(args.name || '').startsWith('/');
        if ((args.parent && args['parent-fid']) || (absolute && (args.parent || args['parent-fid']))) throw new ArgumentError('Use an absolute path, --parent, or --parent-fid separately');
        const target = absolute ? remotePath(args.name) : null;
        if (target === '/') throw new ArgumentError('The root directory already exists');
        const name = fileName(absolute ? path.posix.basename(target) : args.name);
        const dir = absolute ? path.posix.dirname(target) : remotePath('/' + String(args.parent || '').replace(/^\/+/, ''));
        const client = new QuarkClient(await browserAuth(page));
        const parent = args['parent-fid'] === '0' ? await client.resolve('/') : args['parent-fid'] ? await client.info(args['parent-fid']) : await client.assertDirectory(dir);
        if (!parent.dir) throw new ArgumentError('Parent must be a directory');
        const destination = path.posix.join(fileRow(parent).path, name);
        await client.assertAbsent(destination);
        const { data } = await client.request('file', {}, { pdir_fid: parent.fid, file_name: name, dir_path: '', dir_init_lock: false });
        const updated = await client.waitForPath(destination, data.fid);
        if (updated.fid !== data.fid || !updated.dir) throw new CliError('QUARK_VERIFY', 'Created directory could not be verified');
        return { status: 'ok', fid: updated.fid, ...fileRow(updated) };
    },
});
