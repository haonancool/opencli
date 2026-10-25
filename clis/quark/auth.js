import { cli, Strategy } from '@jackwener/opencli/registry';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { DOMAIN, HOME, USER_COLUMNS, QuarkClient, browserAuth } from './drive-api.js';

async function verifyQuarkIdentity(page) {
    return new QuarkClient(await browserAuth(page)).userInfo();
}
registerSiteAuthCommands({
    site: 'quark', domain: DOMAIN, loginUrl: HOME,
    columns: USER_COLUMNS.slice(2), verify: verifyQuarkIdentity,
    poll: async page => new QuarkClient(await browserAuth(page, { navigate: false })).userInfo(),
});
cli({ site: 'quark', name: 'login-status', access: 'read', description: 'Verify the current Quark browser login session',
    domain: DOMAIN, strategy: Strategy.COOKIE, browser: true, navigateBefore: false, args: [], columns: ['loggedIn', 'status', 'id'],
    func: async page => {
        try {
            const auth = await browserAuth(page);
            return [{ loggedIn: true, status: 'logged_in', id: auth.account }];
        } catch (error) {
            if (error.code !== 'AUTH_REQUIRED') throw error;
            return [{ loggedIn: false, status: 'logged_out', id: null }];
        }
    },
});
