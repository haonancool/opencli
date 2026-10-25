import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha1Context } from './sha1-context.js';
describe('SHA-1 upload boundary context', () => {
    it.each([0, 3, 64, 128, 4096])('matches Node SHA-1 after padding %s source bytes', size => {
        const bytes = Buffer.alloc(size, 42), paddingLength = 64 - ((size + 8) % 64);
        const padded = Buffer.concat([bytes, Buffer.from([0x80]), Buffer.alloc(paddingLength - 1), Buffer.alloc(8)]);
        padded.writeBigUInt64BE(BigInt(size * 8), padded.length - 8);
        const context = new Sha1Context(); context.update(padded);
        const data = JSON.parse(Buffer.from(context.encode(), 'base64').toString());
        const hex = Array.from({ length: 5 }, (_, i) => Number(data[`h${i}`]).toString(16).padStart(8, '0')).join('');
        expect(hex).toBe(createHash('sha1').update(bytes).digest('hex'));
    });
    it('produces the same state across incremental aligned updates', () => {
        const bytes = Buffer.alloc(256, 51), first = new Sha1Context(), second = new Sha1Context();
        first.update(bytes); second.update(bytes.subarray(0, 64)); second.update(bytes.subarray(64));
        expect(first.encode()).toBe(second.encode());
        expect(JSON.parse(Buffer.from(first.encode(), 'base64').toString())).toMatchObject({ Nl: '2048', Nh: '0', num: '0', data: '' });
    });
});
