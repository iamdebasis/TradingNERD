import { inflateRawSync } from 'node:zlib';

/** At most this much text from one file: Binance Vision's daily files unpack to about 40 KB. */
export const MAX_UNZIPPED_BYTES = 8 * 1024 * 1024;

/**
 * The one file in a zip archive, as text: Binance Vision's daily files hold one CSV each. Read
 * through the archive's central directory, which has the sizes even when the entry's own header
 * leaves them out; stored or deflated entries only. A download is untrusted, so its size is
 * capped and anything malformed is an error.
 */
export function unzipSingle(data: Uint8Array): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u32 = (at: number) => (at + 4 <= data.length ? view.getUint32(at, true) : -1);
  const u16 = (at: number) => (at + 2 <= data.length ? view.getUint16(at, true) : -1);
  // The end of central directory record: 22 bytes, then a comment of up to 64 KB.
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 0xffff); at--) {
    if (u32(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');
  const central = u32(end + 16);
  if (u16(end + 10) < 1 || u32(central) !== 0x02014b50) throw new Error('the zip holds no file');
  const method = u16(central + 10);
  const compressed = u32(central + 20);
  const size = u32(central + 24);
  const local = u32(central + 42);
  if (u32(local) !== 0x04034b50) throw new Error('the zip entry is damaged');
  const start = local + 30 + u16(local + 26) + u16(local + 28);
  if (compressed < 0 || start + compressed > data.length) throw new Error('the zip is cut short');
  if (size > MAX_UNZIPPED_BYTES) throw new Error('the zipped file is too large');
  const body = data.subarray(start, start + compressed);
  let bytes: Uint8Array;
  if (method === 0) bytes = body;
  else if (method === 8) bytes = inflateRawSync(body, { maxOutputLength: MAX_UNZIPPED_BYTES });
  else throw new Error(`zip method ${method} isn't supported`);
  return new TextDecoder().decode(bytes);
}
