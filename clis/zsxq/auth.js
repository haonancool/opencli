import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { browserJsonRequest } from './utils.js';

// zsxq auth cookies are all httpOnly and span multiple subdomains
// (wx.zsxq.com / api.zsxq.com / .zsxq.com), so document.cookie / cookie
// probes are unreliable. Verify via a lightweight API 401 probe instead.
async function verifyZsxqIdentity(page) {
  await page.goto('https://wx.zsxq.com/');
  await page.wait(2);
  const currentUrl = await page.evaluate('location.href');
  if (/\/login(\b|$)/.test(currentUrl)) {
    throw new AuthRequiredError('zsxq.com', 'zsxq wx page redirected to /login — anonymous session');
  }
  let probe;
  try {
    const result = await browserJsonRequest(page, 'https://api.zsxq.com/v2/users/self');
    if (result.status === 401 || result.status === 403) {
      probe = { kind: 'auth', detail: 'zsxq /v2/users/self returned HTTP ' + result.status };
    } else if (!result.ok) {
      probe = { kind: 'http', httpStatus: result.status };
    } else if (result.data?.succeeded === false || !result.data?.resp_data?.user) {
      probe = { kind: 'auth', detail: 'zsxq /v2/users/self returned succeeded=false — anonymous' };
    } else {
      const user = result.data.resp_data.user;
      probe = { ok: true, user_id: String(user.user_id || user.id || ''), name: String(user.name || user.nickname || '') };
    }
  } catch (error) {
    probe = { kind: 'exception', detail: String(error?.message || error) };
  }
  if (probe?.kind === 'auth') throw new AuthRequiredError('zsxq.com', probe.detail);
  if (probe?.kind === 'http') throw new CommandExecutionError(`HTTP ${probe.httpStatus} from zsxq /v2/users/self`);
  if (probe?.kind === 'exception') throw new CommandExecutionError(`zsxq whoami failed: ${probe.detail}`);
  if (!probe?.ok) throw new CommandExecutionError(`Unexpected zsxq probe: ${JSON.stringify(probe)}`);
  if (!probe.user_id) {
    throw new AuthRequiredError('zsxq.com', 'zsxq /v2/users/self 200 but user_id missing — incomplete session');
  }
  return { user_id: probe.user_id, name: probe.name };
}

registerSiteAuthCommands({
  site: 'zsxq',
  domain: 'zsxq.com',
  loginUrl: 'https://wx.zsxq.com/login',
  columns: ['user_id', 'name'],
  verify: verifyZsxqIdentity,
  // No-navigation poll: probe the API from the current page so the login-page
  // QR code isn't reset by a goto on every interval.
  poll: async (page) => {
    const result = await browserJsonRequest(page, 'https://api.zsxq.com/v2/users/self');
    const loggedIn = result.ok && !!result.data?.resp_data?.user;
    if (!loggedIn) {
      throw new AuthRequiredError('zsxq.com', 'Waiting for zsxq login');
    }
    return verifyZsxqIdentity(page);
  },
});
