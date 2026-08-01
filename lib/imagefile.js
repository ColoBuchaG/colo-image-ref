// Read-only extraction of dimensions and embedded text metadata from
// PNG (tEXt/iTXt chunks) and JPEG (SOF for dims, EXIF via ImageMagick).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { inflateRawSync, inflateSync, unzipSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STEALTH_SIGNATURE_BYTES = 15;
const STEALTH_MAX_PAYLOAD_BITS = 16 * 1024 * 1024;
const STEALTH_MAX_TEXT_BYTES = 2 * 1024 * 1024;

export function readPngMeta(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('not a PNG');
  }
  let width = null;
  let height = null;
  let bitDepth = null;
  let colorType = null;
  let interlace = null;
  const texts = {};
  const idat = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const dataStart = off + 8;
    if (dataStart + len > buf.length) break; // truncated file
    const data = buf.subarray(dataStart, dataStart + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0) {
        texts[data.toString('latin1', 0, nul)] = data.toString('latin1', nul + 1);
      }
    } else if (type === 'iTXt') {
      const parsed = parseItxt(data);
      if (parsed) texts[parsed.key] = parsed.value;
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    off = dataStart + len + 4; // skip data + CRC
    if (type === 'IEND') break;
  }

  // NovelAI can store its normal Description/Comment metadata in the least
  // significant bits of the decoded pixels instead of PNG text chunks.
  // Avoid the extra image decode when ordinary generation metadata exists.
  const hasGenerationText = ['parameters', 'prompt', 'Comment', 'cologen']
    .some((key) => typeof texts[key] === 'string' && texts[key].trim());
  if (!hasGenerationText && idat.length) {
    const stealth = readStealthMeta({
      width, height, bitDepth, colorType, interlace,
      compressedPixels: Buffer.concat(idat),
    });
    if (stealth) Object.assign(texts, stealth, texts);
  }
  return { width, height, texts };
}

function readStealthMeta({ width, height, bitDepth, colorType, interlace, compressedPixels }) {
  // NovelAI stealth metadata is written to 8-bit RGB/RGBA, non-interlaced
  // images. Other PNG layouts are left untouched and simply report no data.
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels || bitDepth !== 8 || interlace !== 0 || !width || !height) return null;

  const rowBytes = width * channels;
  const decodedBytes = height * (rowBytes + 1);
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > 512 * 1024 * 1024) return null;

  let filtered;
  try {
    filtered = inflateSync(compressedPixels, { maxOutputLength: decodedBytes });
  } catch {
    return null;
  }
  if (filtered.length !== decodedBytes) return null;

  const pixels = unfilterPng(filtered, width, height, channels);
  if (!pixels) return null;

  const modes = channels === 4 ? ['alpha', 'rgb'] : ['rgb'];
  for (const mode of modes) {
    const found = decodeStealthPayload(pixels, width, height, channels, mode);
    if (found) return found;
  }
  return null;
}

function unfilterPng(filtered, width, height, channels) {
  const rowBytes = width * channels;
  const out = Buffer.allocUnsafe(rowBytes * height);
  let src = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = filtered[src++];
    if (filter > 4) return null;
    const row = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const value = filtered[src++];
      const left = x >= channels ? out[row + x - channels] : 0;
      const up = y > 0 ? out[row - rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= channels ? out[row - rowBytes + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      out[row + x] = (value + predictor) & 0xff;
    }
  }
  return out;
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upperLeft);
  return dl <= du && dl <= dul ? left : du <= dul ? up : upperLeft;
}

function decodeStealthPayload(pixels, width, height, channels, mode) {
  const pixelCount = width * height;
  const availableBits = mode === 'alpha' ? pixelCount : pixelCount * 3;
  const headerBits = (STEALTH_SIGNATURE_BYTES + 4) * 8;
  if (availableBits < headerBits) return null;

  const bitAt = (bitIndex) => {
    const pixelIndex = mode === 'alpha' ? bitIndex : Math.floor(bitIndex / 3);
    const channel = mode === 'alpha' ? 3 : bitIndex % 3;
    const x = Math.floor(pixelIndex / height);
    const y = pixelIndex % height;
    return pixels[y * width * channels + x * channels + channel] & 1;
  };
  const bytesAt = (startBit, byteLength) => {
    const out = Buffer.allocUnsafe(byteLength);
    for (let i = 0; i < byteLength; i += 1) {
      let value = 0;
      for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bitAt(startBit + i * 8 + bit);
      out[i] = value;
    }
    return out;
  };

  const signature = bytesAt(0, STEALTH_SIGNATURE_BYTES).toString('ascii');
  const valid = mode === 'alpha'
    ? signature === 'stealth_pnginfo' || signature === 'stealth_pngcomp'
    : signature === 'stealth_rgbinfo' || signature === 'stealth_rgbcomp';
  if (!valid) return null;

  let payloadBits = 0;
  for (let i = STEALTH_SIGNATURE_BYTES * 8; i < headerBits; i += 1) {
    payloadBits = payloadBits * 2 + bitAt(i);
  }
  if (!payloadBits || payloadBits % 8 !== 0 || payloadBits > STEALTH_MAX_PAYLOAD_BITS) return null;
  if (headerBits + payloadBits > availableBits) return null;

  let payload = bytesAt(headerBits, payloadBits / 8);
  if (signature.endsWith('comp')) {
    const options = { maxOutputLength: STEALTH_MAX_TEXT_BYTES };
    try {
      // unzip auto-detects the zlib and GZIP wrappers used by NovelAI/pako.
      payload = unzipSync(payload, options);
    } catch {
      try {
        payload = inflateRawSync(payload, options);
      } catch {
        return null;
      }
    }
  }
  if (payload.length > STEALTH_MAX_TEXT_BYTES) return null;

  const text = payload.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const normalized = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value == null) continue;
      normalized[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return normalized;
  } catch {
    // Some stealth writers store an A1111 parameter block directly.
    return { parameters: text };
  }
}

function parseItxt(data) {
  try {
    let p = data.indexOf(0);
    if (p <= 0) return null;
    const key = data.toString('latin1', 0, p);
    const compressed = data[p + 1] === 1;
    p += 2; // compression flag + method
    let end = data.indexOf(0, p); // language tag
    if (end < 0) return null;
    p = end + 1;
    end = data.indexOf(0, p); // translated keyword
    if (end < 0) return null;
    p = end + 1;
    let text = data.subarray(p);
    if (compressed) text = inflateSync(text);
    return { key, value: text.toString('utf8') };
  } catch {
    return null;
  }
}

// JPEG dimensions from SOF markers.
export function readJpegSize(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error('not a JPEG');
  }
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) { off += 1; continue; }
    const marker = buf[off + 1];
    // Standalone markers without a length field
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
    }
    off += 2 + len;
  }
  return { width: null, height: null };
}

// A1111-style JPEGs carry the generation block in EXIF UserComment.
// Uses ImageMagick; returns '' on any failure.
export function readJpegExifText(filePath) {
  try {
    const out = execFileSync(
      'identify',
      ['-format', '%[exif:UserComment]%[exif:ImageDescription]%[comment]', filePath],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 }
    );
    return (out || '').trim();
  } catch {
    return '';
  }
}
