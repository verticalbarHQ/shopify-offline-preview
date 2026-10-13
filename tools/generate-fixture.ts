import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { defaultFixture, imageFiles } from "../packages/data/src/fixture.js";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, payload: Buffer): Buffer {
  const name = Buffer.from(type);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, payload])));
  return Buffer.concat([header, name, payload, checksum]);
}
function pattern(index: number): Buffer {
  const width = 64;
  const height = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      pixels[offset] = (index * 31 + Math.floor(x / 8) * 29) % 256;
      pixels[offset + 1] = (index * 47 + Math.floor(y / 8) * 37) % 256;
      pixels[offset + 2] = (index * 13 + Math.floor((x + y) / 8) * 41) % 256;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const output = "fixtures/default";
await mkdir(`${output}/images`, { recursive: true });
const snapshot = Buffer.from(`${JSON.stringify(defaultFixture(), null, 2)}\n`);
const files = new Map([
  [`${output}/snapshot.json`, snapshot],
  ...imageFiles.map((file, index): [string, Buffer] => [
    `${output}/images/${file}`,
    pattern(index),
  ]),
]);
for (const [path, bytes] of files) {
  if (process.argv.includes("--check")) {
    if (!(await readFile(path)).equals(bytes)) throw new Error(`Fixture drift: ${path}`);
  } else await writeFile(path, bytes);
}
console.log(`Synthetic fixture: 40 products, 3 articles, ${imageFiles.length} deterministic PNGs`);
