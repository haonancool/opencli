import { cli, Strategy } from '@jackwener/opencli/registry';
import { BaiduClient, DOMAIN, accountInfo, browserAuth } from './api.js';

const options = { site: 'baidu-netdisk', domain: DOMAIN, strategy: Strategy.COOKIE, browser: true, navigateBefore: false, access: 'read', args: [] };

cli({ ...options, name: 'login-status', description: 'Check the current Baidu Netdisk browser login session',
    columns: ['loggedIn', 'status', 'id'],
    func: async page => {
        try {
            const auth = await browserAuth(page, { includePcsCookies: false });
            return [{ loggedIn: true, status: 'logged_in', id: auth.account }];
        } catch (error) {
            if (error.code !== 'AUTH_REQUIRED') throw error;
            return [{ loggedIn: false, status: 'logged_out', id: null }];
        }
    },
});

cli({ ...options, name: 'whoami', description: 'Show the current Baidu Netdisk user, membership and storage quota',
    columns: ['loggedIn', 'id', 'username', 'avatar', 'membership', 'totalBytes', 'usedBytes', 'freeBytes'],
    func: async page => [await accountInfo(new BaiduClient(await browserAuth(page, { includePcsCookies: false })))],
});
