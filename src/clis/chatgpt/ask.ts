import { execSync, spawnSync } from 'node:child_process';
import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

export const askCommand = cli({
  site: 'chatgpt',
  name: 'ask',
  description: 'Send a prompt and wait for the AI response (send + wait + read)',
  domain: 'localhost',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'text', required: true, positional: true, help: 'Prompt to send' },
    { name: 'timeout', required: false, help: 'Max seconds to wait for response (default: 30)', default: '30' },
  ],
  columns: ['Role', 'Text'],
  func: async (page: IPage | null, kwargs: any) => {
    const text = kwargs.text as string;
    const timeout = parseInt(kwargs.timeout as string, 10) || 30;

    // Backup clipboard
    let clipBackup = '';
    try { clipBackup = execSync('pbpaste', { encoding: 'utf-8' }); } catch {}

    // Send the message
    spawnSync('pbcopy', { input: text });
    execSync("osascript -e 'tell application \"ChatGPT\" to activate'");
    execSync("osascript -e 'delay 0.5'");

    const cmd = "osascript " +
                "-e 'tell application \"System Events\"' " +
                "-e 'keystroke \"v\" using command down' " +
                "-e 'delay 0.2' " +
                "-e 'keystroke return' " +
                "-e 'end tell'";
    execSync(cmd);

    // Clear clipboard marker
    spawnSync('pbcopy', { input: '__OPENCLI_WAITING__' });

    // Wait for response, then read it
    const pollInterval = 3;
    const maxPolls = Math.ceil(timeout / pollInterval);
    let response = '';

    for (let i = 0; i < maxPolls; i++) {
      // Wait
      execSync(`sleep ${pollInterval}`);

      // Try Cmd+Shift+C to copy the latest response
      execSync("osascript -e 'tell application \"ChatGPT\" to activate'");
      execSync("osascript -e 'tell application \"System Events\" to keystroke \"c\" using {command down, shift down}'");
      execSync("osascript -e 'delay 0.3'");

      const copied = execSync('pbpaste', { encoding: 'utf-8' }).trim();
      if (copied && copied !== '__OPENCLI_WAITING__' && copied !== text) {
        response = copied;
        break;
      }
    }

    // Restore clipboard
    if (clipBackup) spawnSync('pbcopy', { input: clipBackup });

    if (!response) {
      return [
        { Role: 'User', Text: text },
        { Role: 'System', Text: `No response within ${timeout}s. ChatGPT may still be generating.` },
      ];
    }

    return [
      { Role: 'User', Text: text },
      { Role: 'Assistant', Text: response },
    ];
  },
});
