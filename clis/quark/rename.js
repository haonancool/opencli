import { ArgumentError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { QuarkClient, browserAuth, fileName } from './drive-api.js';
cli({
    site: 'quark',
    name: 'rename',
    access: 'write',
    description: 'Rename a file in your Quark Drive',
    domain: 'pan.quark.cn',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    defaultFormat: 'json',
    args: [
        { name: 'fid', required: true, positional: true, help: 'File ID or absolute remote path to rename' },
        { name: 'name', required: true, help: 'New file name' },
    ],
    func: async (page, kwargs) => {
        const fid = kwargs.fid;
        const name = fileName(kwargs.name);
        if (!name.trim())
            throw new ArgumentError('New name cannot be empty');
        return new QuarkClient(await browserAuth(page)).rename(fid, name);
    },
});
