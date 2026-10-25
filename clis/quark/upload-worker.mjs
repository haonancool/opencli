import { runUpload } from './upload-engine.js';
const [id, dir, runId] = process.argv.slice(2);
try {
    let input = '';
    for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 1024 * 1024) throw new Error('Invalid worker input');
    }
    await runUpload(id, dir, runId, JSON.parse(input));
} catch { process.exitCode = 1; }
