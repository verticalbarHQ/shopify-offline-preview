// SHA-1 (FIPS 180-4), HMAC (RFC 2104) and BLAKE3, implemented here for the browser and Node
// theme filters like md5.ts.

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function sha1Bytes(input: Uint8Array): Uint8Array {
  const length = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(length);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(length - 8, Math.floor((input.length * 8) / 2 ** 32));
  view.setUint32(length - 4, (input.length * 8) >>> 0);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++)
      w[i] = rotl((w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0), 1);
    let [a, b, c, d, e] = h as [number, number, number, number, number];
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : i < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : i < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + (w[i] ?? 0)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + b) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  h.forEach((word, i) => {
    outView.setUint32(i * 4, word);
  });
  return out;
}
export function sha1(input: string): string {
  return hex(sha1Bytes(new TextEncoder().encode(input)));
}
export function hmacSha1(input: string, key: string): string {
  const encoded = new TextEncoder().encode(key);
  const secret: Uint8Array = encoded.length > 64 ? sha1Bytes(encoded) : encoded;
  const block = new Uint8Array(64);
  block.set(secret);
  const inner = new Uint8Array(64).map((_, i) => (block[i] ?? 0) ^ 0x36);
  const outer = new Uint8Array(64).map((_, i) => (block[i] ?? 0) ^ 0x5c);
  const message = new TextEncoder().encode(input);
  const first = new Uint8Array(64 + message.length);
  first.set(inner);
  first.set(message, 64);
  const second = new Uint8Array(64 + 20);
  second.set(outer);
  second.set(sha1Bytes(first), 64);
  return hex(sha1Bytes(second));
}

// BLAKE3 with the default 32-byte output, hashing mode only.
const IV = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1,
  CHUNK_END = 2,
  PARENT = 4,
  ROOT = 8;
function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
function compress(
  chaining: number[],
  block: Uint32Array,
  counter: number,
  blockLength: number,
  flags: number,
): Uint32Array {
  const s = new Uint32Array([
    ...chaining,
    ...IV.slice(0, 4),
    counter >>> 0,
    Math.floor(counter / 2 ** 32) >>> 0,
    blockLength,
    flags,
  ]);
  let m = Array.from(block);
  const g = (a: number, b: number, c: number, d: number, x: number, y: number) => {
    s[a] = (s[a] ?? 0) + (s[b] ?? 0) + x;
    s[d] = rotr((s[d] ?? 0) ^ (s[a] ?? 0), 16);
    s[c] = (s[c] ?? 0) + (s[d] ?? 0);
    s[b] = rotr((s[b] ?? 0) ^ (s[c] ?? 0), 12);
    s[a] = (s[a] ?? 0) + (s[b] ?? 0) + y;
    s[d] = rotr((s[d] ?? 0) ^ (s[a] ?? 0), 8);
    s[c] = (s[c] ?? 0) + (s[d] ?? 0);
    s[b] = rotr((s[b] ?? 0) ^ (s[c] ?? 0), 7);
  };
  for (let round = 0; round < 7; round++) {
    const w = (i: number) => m[i] ?? 0;
    g(0, 4, 8, 12, w(0), w(1));
    g(1, 5, 9, 13, w(2), w(3));
    g(2, 6, 10, 14, w(4), w(5));
    g(3, 7, 11, 15, w(6), w(7));
    g(0, 5, 10, 15, w(8), w(9));
    g(1, 6, 11, 12, w(10), w(11));
    g(2, 7, 8, 13, w(12), w(13));
    g(3, 4, 9, 14, w(14), w(15));
    m = PERMUTATION.map((i) => m[i] ?? 0);
  }
  for (let i = 0; i < 8; i++) {
    s[i] = (s[i] ?? 0) ^ (s[i + 8] ?? 0);
    s[i + 8] = (s[i + 8] ?? 0) ^ (chaining[i] ?? 0);
  }
  return s;
}
function words(bytes: Uint8Array): Uint32Array {
  const padded = new Uint8Array(64);
  padded.set(bytes);
  const view = new DataView(padded.buffer);
  return new Uint32Array(16).map((_, i) => view.getUint32(i * 4, true));
}
interface Output {
  chaining: number[];
  block: Uint32Array;
  counter: number;
  blockLength: number;
  flags: number;
}
function chunkOutput(chunk: Uint8Array, counter: number): Output {
  let chaining = IV.slice();
  const blocks = Math.max(1, Math.ceil(chunk.length / 64));
  for (let i = 0; i < blocks - 1; i++) {
    const flags = i === 0 ? CHUNK_START : 0;
    chaining = Array.from(
      compress(chaining, words(chunk.subarray(i * 64, i * 64 + 64)), counter, 64, flags),
    ).slice(0, 8);
  }
  const last = chunk.subarray((blocks - 1) * 64);
  return {
    chaining,
    block: words(last),
    counter,
    blockLength: last.length,
    flags: (blocks === 1 ? CHUNK_START : 0) | CHUNK_END,
  };
}
function chainingValue(output: Output): number[] {
  return Array.from(
    compress(output.chaining, output.block, output.counter, output.blockLength, output.flags),
  ).slice(0, 8);
}
function parentOutput(left: number[], right: number[]): Output {
  return {
    chaining: IV.slice(),
    block: new Uint32Array([...left, ...right]),
    counter: 0,
    blockLength: 64,
    flags: PARENT,
  };
}
export function blake3(input: string): string {
  return blake3Bytes(new TextEncoder().encode(input));
}
export function blake3Bytes(bytes: Uint8Array): string {
  const chunks = Math.max(1, Math.ceil(bytes.length / 1024));
  const stack: number[][] = [];
  let output = chunkOutput(bytes.subarray(0, 1024), 0);
  for (let i = 1; i < chunks; i++) {
    // Merge completed subtrees: the number of trailing zero bits of the chunk count.
    let chaining = chainingValue(output);
    let total = i;
    while ((total & 1) === 0) {
      chaining = chainingValue(parentOutput(stack.pop() ?? [], chaining));
      total >>= 1;
    }
    stack.push(chaining);
    output = chunkOutput(bytes.subarray(i * 1024, i * 1024 + 1024), i);
  }
  while (stack.length) output = parentOutput(stack.pop() ?? [], chainingValue(output));
  const root = compress(
    output.chaining,
    output.block,
    output.counter,
    output.blockLength,
    output.flags | ROOT,
  );
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) view.setUint32(i * 4, root[i] ?? 0, true);
  return hex(out);
}
