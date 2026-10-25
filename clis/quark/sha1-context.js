// Quark's multipart service requires the standard SHA-1 chaining state at
// aligned part boundaries. This is a content checksum, not an auth signature.
const rol = (value, bits) => (value << bits) | (value >>> (32 - bits));
export class Sha1Context {
    constructor() { this.state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]; this.length = 0; }
    update(bytes) {
        if (bytes.length % 64 !== 0) throw new RangeError('SHA-1 context requires complete 64-byte blocks');
        const words = new Int32Array(80);
        for (let offset = 0; offset < bytes.length; offset += 64) {
            for (let i = 0; i < 16; i++) words[i] = bytes.readInt32BE(offset + i * 4);
            for (let i = 16; i < 80; i++) words[i] = rol(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
            let [a, b, c, d, e] = this.state;
            for (let i = 0; i < 80; i++) {
                const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
                const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
                const temp = (rol(a, 5) + f + e + k + words[i]) | 0;
                e = d; d = c; c = rol(b, 30); b = a; a = temp;
            }
            this.state = this.state.map((value, i) => (value + [a, b, c, d, e][i]) | 0);
        }
        this.length += bytes.length;
    }
    encode() {
        const value = { hash_type: 'sha1' };
        this.state.forEach((word, i) => { value[`h${i}`] = String(word >>> 0); });
        return Buffer.from(JSON.stringify({ ...value, Nl: String((this.length * 8) >>> 0), Nh: String(Math.floor(this.length / 0x20000000)), data: '', num: '0' })).toString('base64');
    }
}
