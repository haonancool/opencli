import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

export const newCommand = cli({
  site: 'cursor',
  name: 'new',
  description: 'Start a new Cursor chat or Composer session',
  domain: 'localhost',
  strategy: Strategy.UI,
  browser: true,
  args: [],
  columns: ['Status'],
  func: async (page: IPage) => {
    // Use keyboard shortcut — most robust approach, avoids brittle DOM selectors
    const isMac = process.platform === 'darwin';
    await page.pressKey(isMac ? 'Meta+N' : 'Control+N');
    await page.wait(1);

    return [{ Status: 'Success' }];
  },
});
