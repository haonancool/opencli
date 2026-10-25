import path from 'node:path';
import { ArgumentError } from '@jackwener/opencli/errors';

export function remotePath(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\\]/.test(value)) {
        throw new ArgumentError('Provide an absolute remote drive path, e.g. /Documents');
    }
    if (value.split('/').some(part => part === '.' || part === '..')) throw new ArgumentError('Remote paths cannot contain . or .. segments');
    return path.posix.normalize(value).replace(/\/$/, '') || '/';
}

export function fileName(value) {
    if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(value)) {
        throw new ArgumentError('Provide a filename without path separators or reserved characters');
    }
    return value;
}

export function positiveInt(value, label, max = 10000) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new ArgumentError(`${label} must be between 1 and ${max}`);
    return n;
}
