// RFC 1321 algorithm, implemented here for the browser and Node theme filter.
const constants = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];
const rotations = [
  [7, 12, 17, 22],
  [5, 9, 14, 20],
  [4, 11, 16, 23],
  [6, 10, 15, 21],
];
export function md5(input: string): string {
  const original = new TextEncoder().encode(input);
  const bytes = new Uint8Array(Math.ceil((original.length + 9) / 64) * 64);
  bytes.set(original);
  bytes[original.length] = 128;
  const words = new DataView(bytes.buffer);
  words.setBigUint64(bytes.length - 8, BigInt(original.length) * 8n, true);
  let h0 = 0x67452301,
    h1 = 0xefcdab89,
    h2 = 0x98badcfe,
    h3 = 0x10325476;
  for (let offset = 0; offset < bytes.length; offset += 64) {
    let a = h0,
      b = h1,
      c = h2,
      d = h3;
    for (let i = 0; i < 64; i++) {
      let value: number, index: number;
      if (i < 16) {
        value = (b & c) | (~b & d);
        index = i;
      } else if (i < 32) {
        value = (d & b) | (~d & c);
        index = (5 * i + 1) % 16;
      } else if (i < 48) {
        value = b ^ c ^ d;
        index = (3 * i + 5) % 16;
      } else {
        value = c ^ (b | ~d);
        index = (7 * i) % 16;
      }
      const rotation = rotations[Math.floor(i / 16)]?.[i % 4],
        constant = constants[i];
      if (rotation === undefined || constant === undefined)
        throw new Error("Invalid MD5 round table");
      const sum = (a + value + constant + words.getUint32(offset + index * 4, true)) >>> 0;
      const next = (b + ((sum << rotation) | (sum >>> (32 - rotation)))) >>> 0;
      a = d;
      d = c;
      c = b;
      b = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
  }
  const output = new DataView(new ArrayBuffer(16));
  [h0, h1, h2, h3].forEach((word, i) => {
    output.setUint32(i * 4, word, true);
  });
  return [...new Uint8Array(output.buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
