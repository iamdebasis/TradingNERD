import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A one-file zip as Binance Vision's daily files are laid out (measured 2026-11-07: deflated,
 * the sizes in the entry's own header and in the central directory, no comment). `descriptor`
 * leaves the sizes out of the entry's header, as zips written on the fly do; `stored` keeps the
 * file uncompressed.
 */
export function zipOf(
  name: string,
  text: string,
  options: { stored?: boolean; descriptor?: boolean } = {},
): Uint8Array {
  const data = Buffer.from(text, 'utf8');
  const body = options.stored ? data : deflateRawSync(data);
  const method = options.stored ? 0 : 8;
  const flags = options.descriptor ? 0x08 : 0;
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(options.descriptor ? 0 : crc, 14);
  local.writeUInt32LE(options.descriptor ? 0 : body.length, 18);
  local.writeUInt32LE(options.descriptor ? 0 : data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const descriptor = Buffer.alloc(options.descriptor ? 16 : 0);
  if (options.descriptor) {
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(body.length, 8);
    descriptor.writeUInt32LE(data.length, 12);
  }

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + nameBytes.length + body.length + descriptor.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);

  return new Uint8Array(
    Buffer.concat([local, nameBytes, body, descriptor, central, nameBytes, end]),
  );
}
