import fs from 'node:fs';
import { once } from 'node:events';

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffffn;
const UTF8_AND_DESCRIPTOR = 0x0808;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC_TABLE[n] = value >>> 0;
}

export async function streamStoredZip(output, entries) {
  const central = [];
  let offset = 0n;
  let usesZip64 = false;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (!name.length || name.length > UINT16_MAX) throw new Error('ZIP entry name is too long');

    const stat = fs.statSync(entry.path);
    if (!stat.isFile()) continue;
    const size = BigInt(stat.size);
    const localOffset = offset;
    const zip64 = size >= UINT32_MAX;
    usesZip64 ||= zip64 || localOffset >= UINT32_MAX;
    const { time, date } = dosDateTime(stat.mtime);
    const localExtra = zip64 ? zip64Extra([size, size]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(UTF8_AND_DESCRIPTOR, 6);
    local.writeUInt16LE(0, 8); // stored: source images are already compressed
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14); // CRC follows the streamed file
    local.writeUInt32LE(zip64 ? 0xffffffff : 0, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    offset = await writeParts(output, offset, local, name, localExtra);

    let crc = 0xffffffff;
    let written = 0n;
    for await (const chunk of fs.createReadStream(entry.path)) {
      crc = updateCrc(crc, chunk);
      written += BigInt(chunk.length);
      offset = await writeParts(output, offset, chunk);
    }
    if (written !== size) throw new Error(`File changed during export: ${entry.name}`);
    crc = (crc ^ 0xffffffff) >>> 0;

    const descriptor = Buffer.alloc(zip64 ? 24 : 16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    if (zip64) {
      descriptor.writeBigUInt64LE(size, 8);
      descriptor.writeBigUInt64LE(size, 16);
    } else {
      descriptor.writeUInt32LE(Number(size), 8);
      descriptor.writeUInt32LE(Number(size), 12);
    }
    offset = await writeParts(output, offset, descriptor);
    central.push({ name, size, crc, time, date, localOffset });
  }

  const centralOffset = offset;
  for (const entry of central) {
    const size64 = entry.size >= UINT32_MAX;
    const offset64 = entry.localOffset >= UINT32_MAX;
    const values = [];
    if (size64) values.push(entry.size, entry.size);
    if (offset64) values.push(entry.localOffset);
    const extra = values.length ? zip64Extra(values) : Buffer.alloc(0);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4); // Unix creator, ZIP specification 3.0
    header.writeUInt16LE(size64 || offset64 ? 45 : 20, 6);
    header.writeUInt16LE(UTF8_AND_DESCRIPTOR, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(size64 ? 0xffffffff : Number(entry.size), 20);
    header.writeUInt32LE(size64 ? 0xffffffff : Number(entry.size), 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset64 ? 0xffffffff : Number(entry.localOffset), 42);
    offset = await writeParts(output, offset, header, entry.name, extra);
  }

  const centralSize = offset - centralOffset;
  const count = BigInt(central.length);
  usesZip64 ||= count >= BigInt(UINT16_MAX) || centralSize >= UINT32_MAX || centralOffset >= UINT32_MAX;
  if (usesZip64) {
    const zip64Offset = offset;
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(count, 24);
    end64.writeBigUInt64LE(count, 32);
    end64.writeBigUInt64LE(centralSize, 40);
    end64.writeBigUInt64LE(centralOffset, 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(zip64Offset, 8);
    locator.writeUInt32LE(1, 16);
    offset = await writeParts(output, offset, end64, locator);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count16 = count >= BigInt(UINT16_MAX) ? UINT16_MAX : Number(count);
  end.writeUInt16LE(count16, 8);
  end.writeUInt16LE(count16, 10);
  end.writeUInt32LE(centralSize >= UINT32_MAX ? 0xffffffff : Number(centralSize), 12);
  end.writeUInt32LE(centralOffset >= UINT32_MAX ? 0xffffffff : Number(centralOffset), 16);
  await writeParts(output, offset, end);
}

function zip64Extra(values) {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(value, 4 + index * 8));
  return extra;
}

function dosDateTime(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function updateCrc(crc, chunk) {
  let value = crc >>> 0;
  for (const byte of chunk) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

async function writeParts(output, offset, ...parts) {
  let next = offset;
  for (const part of parts) {
    if (!output.write(part)) await once(output, 'drain');
    next += BigInt(part.length);
  }
  return next;
}
