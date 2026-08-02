// Smoke test: boots the server against a temp data dir + temp image root,
// indexes two generated PNG fixtures, and exercises the API end to end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractFromChunks } from './lib/meta.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'irl-smoke-'));
const dataDir = path.join(tmp, 'data');
const root = path.join(tmp, 'root');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ roots: [root] }));
process.env.DATA_DIR = dataDir;
process.env.WATCH_ENABLED = 'false';

/* ---------- minimal PNG fixture builder ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

function makePng(texts = {}) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(8 * (1 + 8 * 3));
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 251;
  const parts = [sig, chunk('IHDR', ihdr)];
  for (const [k, v] of Object.entries(texts)) {
    parts.push(chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])));
  }
  parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function readStoredZip(buffer) {
  const endOffset = buffer.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  assert.ok(endOffset >= 0, 'ZIP end record is missing');
  const count = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'ZIP central record is invalid');
    assert.equal(buffer.readUInt16LE(offset + 10), 0, 'basket ZIP unexpectedly compressed an image');
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, 'ZIP local record is invalid');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataOffset, dataOffset + size);
    assert.equal(crc32(data), expectedCrc, `ZIP CRC is invalid for ${name}`);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function makeStealthPng(metadata) {
  const width = 64;
  const height = 64;
  const channels = 4;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // truecolor + alpha

  const raw = Buffer.alloc(height * (1 + width * channels), 254);
  for (let y = 0; y < height; y += 1) raw[y * (1 + width * channels)] = 0;
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(metadata)));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length * 8);
  const encoded = Buffer.concat([Buffer.from('stealth_pngcomp'), length, payload]);
  assert.ok(encoded.length * 8 <= width * height, 'stealth fixture is too large');

  let bitIndex = 0;
  for (const byte of encoded) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      const x = Math.floor(bitIndex / height);
      const y = bitIndex % height;
      const offset = y * (1 + width * channels) + 1 + x * channels + 3;
      raw[offset] = (raw[offset] & 0xfe) | ((byte >> bit) & 1);
      bitIndex += 1;
    }
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PARAMS_A = [
  'score_9, score_8_up, 1girl, kan duguesh, giantess, red hair, by krekkov, detailed background, <lora:detail-slider:0.7>',
  'Negative prompt: worst quality, blurry',
  'Steps: 28, Sampler: Euler a, CFG scale: 6.5, Seed: 424242, Size: 832x1216, Model: ponyXL_v6',
].join('\n');

const PARAMS_A_V2 = [
  'newtag1, newtag2',
  'Steps: 12, Sampler: DDIM, CFG scale: 4, Seed: 1, Size: 512x512, Model: other_model',
].join('\n');

const COMFY_DETAILER_PROMPT = JSON.stringify({
  7: {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'worst quality, malformed hands', clip: ['4', 1] },
    _meta: { title: 'CLIP Text Encode (Negative)' },
  },
  74: {
    class_type: 'FaceDetailer',
    inputs: {
      image: ['76', 0], positive: ['80', 0], negative: ['7', 0],
      seed: 111, steps: 20, cfg: 8, sampler_name: 'euler', denoise: 0.45,
    },
  },
  76: { class_type: 'LoadImage', inputs: { image: 'source.png' } },
  80: { class_type: 'CLIPTextEncode', inputs: { text: 'face pass prompt', clip: ['4', 1] } },
  81: {
    class_type: 'FaceDetailer',
    inputs: {
      image: ['74', 0], positive: ['87', 0], negative: ['7', 0],
      seed: 222, steps: 24, cfg: 7, sampler_name: 'dpmpp_2m', denoise: 0.5,
    },
  },
  86: { class_type: 'JjkText', inputs: { text: 'final eye pass prompt, green eyes' } },
  87: { class_type: 'CLIPTextEncode', inputs: { text: ['86', 0], clip: ['4', 1] } },
});

const COMFY_HIRES_PROMPT = JSON.stringify({
  3: {
    class_type: 'KSampler',
    inputs: { positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0], seed: 10, steps: 30, cfg: 5.5, sampler_name: 'euler' },
  },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'main prompt, <lora:test-style:0.6>' } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'bad anatomy, blurry' }, _meta: { title: 'Negative' } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0] } },
  25: { class_type: 'VAEEncode', inputs: { pixels: ['8', 0] } },
  29: {
    class_type: 'KSampler',
    inputs: { positive: ['6', 0], negative: ['7', 0], latent_image: ['25', 0], seed: 20, steps: 12, cfg: 3, sampler_name: 'euler' },
  },
});

/* ---------- test runner ---------- */

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let server;
let base;
let idA;
let idB;
let speciesCollectionId;
let trainingCollectionId;
let exportBasketId;

async function j(pathname, opts = {}) {
  const init = {};
  if (opts.method) init.method = opts.method;
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${base}${pathname}`, init);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

test('ComfyUI detailer chain uses terminal stage and keeps negative polarity', () => {
  const d = extractFromChunks({ prompt: COMFY_DETAILER_PROMPT });
  assert.equal(d.source, 'comfyui');
  assert.equal(d.prompt_text, 'final eye pass prompt, green eyes');
  assert.equal(d.negative, 'worst quality, malformed hands');
  assert.equal(d.seed, '222');
  assert.equal(d.steps, 24);
  assert.equal(d.cfg, 7);
  assert.equal(d.sampler, 'dpmpp_2m');
});

test('ComfyUI hires chain selects downstream refine sampler', () => {
  const d = extractFromChunks({ prompt: COMFY_HIRES_PROMPT });
  assert.equal(d.prompt_text, 'main prompt, <lora:test-style:0.6>');
  assert.equal(d.negative, 'bad anatomy, blurry');
  assert.equal(d.seed, '20');
  assert.equal(d.steps, 12);
  assert.equal(d.cfg, 3);
  assert.ok(d.loras.some((lora) => lora.name === 'test-style' && lora.weight === 0.6));
});

test('NovelAI, Cologen, and metadata-free formats remain distinct', () => {
  const nai = extractFromChunks({
    Software: 'NovelAI',
    Source: 'NovelAI Diffusion V4.5',
    Comment: JSON.stringify({ prompt: 'nai positive', uc: 'nai negative', seed: 9, steps: 23, scale: 5.5, sampler: 'k_euler_ancestral', width: 832, height: 1216 }),
  });
  assert.equal(nai.source, 'novelai');
  assert.equal(nai.prompt_text, 'nai positive');
  assert.equal(nai.negative, 'nai negative');

  const cologen = extractFromChunks({ cologen: JSON.stringify({
    signature: { name: 'Cologen', metadataVersion: 2 },
    prompt: 'natural language edit prompt',
    meta: { model: 'gpt-image-2', size: '1536x2048' },
    requestConfig: { referenceFilenames: ['one.png', 'two.png'] },
  }) });
  assert.equal(cologen.source, 'cologen');
  assert.equal(cologen.prompt_text, 'natural language edit prompt');
  assert.equal(cologen.model, 'gpt-image-2');
  assert.equal(cologen.size, '1536x2048');

  const plain = extractFromChunks({});
  assert.equal(plain.source, '');
  assert.equal(plain.prompt_text, '');
  assert.equal(plain.negative, '');
});

test('scan indexes both fixtures', async () => {
  const res = await j('/api/scan', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.data.added, 2, `expected 2 added, got ${JSON.stringify(res.data)}`);
});

test('stats reflect the library', async () => {
  const res = await j('/api/stats');
  assert.equal(res.data.images, 2);
  assert.ok(res.data.tags > 0);
  assert.equal(res.data.collections, 0);
  assert.equal(res.data.explicit, 0);
  assert.deepEqual(res.data.roots, [root]);
});

test('image list returns both, filters by query', async () => {
  const all = await j('/api/images');
  assert.equal(all.data.total, 2);
  idA = all.data.items.find((i) => i.name === 'a-meta.png').id;
  idB = all.data.items.find((i) => i.name === 'b-plain.png').id;
  assert.ok(idA && idB);
  assert.equal(all.data.items.find((i) => i.id === idA).source, 'a1111');
  assert.equal(all.data.items.find((i) => i.id === idB).source, '');
  assert.ok(!Object.hasOwn(all.data.items[0], 'raw_meta'));
  const q = await j('/api/images?q=kan');
  assert.equal(q.data.total, 1);
  assert.equal(q.data.items[0].id, idA);
});

test('manual order persists drag-style image reordering', async () => {
  const initial = await j('/api/images?sort=manual&dir=asc&limit=200');
  assert.ok(initial.data.items.every((item) => item.manual_order > 0));

  const moved = await j('/api/reorder', {
    method: 'POST', body: { id: idB, target_id: idA, position: 'before' },
  });
  assert.equal(moved.status, 200);
  const reordered = await j('/api/images?sort=manual&dir=asc&limit=200');
  assert.ok(reordered.data.items.findIndex((item) => item.id === idB)
    < reordered.data.items.findIndex((item) => item.id === idA));

  const restored = await j('/api/reorder', {
    method: 'POST', body: { id: idA, target_id: idB, position: 'before' },
  });
  assert.equal(restored.status, 200);
});

test('A1111 metadata parsed: prompt, negative, settings, lora, tags', async () => {
  const res = await j(`/api/images/${idA}`);
  const d = res.data;
  assert.ok(d.prompt_text.includes('kan duguesh'));
  assert.ok(d.prompt_text.includes('<lora:detail-slider:0.7>'));
  assert.equal(d.negative, 'worst quality, blurry');
  assert.equal(d.steps, 28);
  assert.equal(d.cfg, 6.5);
  assert.equal(d.sampler, 'Euler a');
  assert.equal(d.model, 'ponyXL_v6');
  assert.equal(d.seed, '424242');
  assert.equal(d.width, 8);
  assert.equal(d.height, 8);
  assert.equal(d.meta_status, 'ok');
  const lora = d.loras.find((l) => l.name === 'detail-slider');
  assert.ok(lora, 'lora missing');
  assert.equal(lora.weight, 0.7);
  const tagNames = d.tags.map((t) => t.name);
  assert.ok(tagNames.includes('by krekkov'));
  assert.ok(!tagNames.some((t) => t.startsWith('<lora:')), 'lora leaked into tags');
  assert.ok(d.raw.parameters.includes('Steps: 28'));
  const posNames = d.tags.filter((t) => t.polarity !== 'neg').map((t) => t.name);
  const negNames = d.tags.filter((t) => t.polarity === 'neg').map((t) => t.name);
  assert.ok(negNames.includes('worst quality'), 'negative tag missing');
  assert.ok(negNames.includes('blurry'), 'negative tag missing');
  assert.ok(!posNames.includes('worst quality'), 'negative tag leaked into positive');
  assert.ok(posNames.includes('kan duguesh'));
});

test('plain PNG has no metadata but is indexed', async () => {
  const res = await j(`/api/images/${idB}`);
  assert.equal(res.data.meta_status, 'none');
  assert.equal(res.data.prompt_text, '');
});

test('tag/lora filters and tag suggestions work', async () => {
  const byTag = await j('/api/images?tag=by%20krekkov');
  assert.equal(byTag.data.total, 1);
  const byLora = await j('/api/images?lora=detail-slider');
  assert.equal(byLora.data.total, 1);
  const tags = await j('/api/tags?q=krek');
  assert.ok(tags.data.some((t) => t.name === 'by krekkov'));
  const loras = await j('/api/loras?q=detail');
  assert.ok(loras.data.some((l) => l.name === 'detail-slider'));
});

test('PATCH notes/source/favorite/user tags round-trips', async () => {
  const res = await j(`/api/images/${idA}`, {
    method: 'PATCH',
    body: { notes: 'hello', source_url: 'https://example.com/x', favorite: 1, add_tags: ['mytag'] },
  });
  assert.equal(res.data.notes, 'hello');
  assert.equal(res.data.source_url, 'https://example.com/x');
  assert.equal(res.data.favorite, 1);
  assert.ok(res.data.tags.some((t) => t.name === 'mytag' && t.origin === 'user'));
  const fav = await j('/api/images?fav=1');
  assert.equal(fav.data.total, 1);
  const notesSearch = await j('/api/images?q=hell');
  assert.equal(notesSearch.data.total, 1, 'FTS did not update after notes edit');
  const manualTagSearch = await j('/api/images?q=mytag');
  assert.equal(manualTagSearch.data.total, 1, 'manual tags were omitted from global search');
});

test('collections support multi-membership without copying images', async () => {
  const species = await j('/api/collections', { method: 'POST', body: { name: 'Fiera species' } });
  const training = await j('/api/collections', { method: 'POST', body: { name: 'Training candidates' } });
  assert.equal(species.status, 201);
  assert.equal(training.status, 201);
  speciesCollectionId = species.data.id;
  trainingCollectionId = training.data.id;

  const duplicate = await j('/api/collections', { method: 'POST', body: { name: 'fiera species' } });
  assert.equal(duplicate.status, 409);

  const patched = await j(`/api/images/${idA}`, {
    method: 'PATCH',
    body: { explicit: 1, collection_ids: [speciesCollectionId, trainingCollectionId] },
  });
  assert.equal(patched.data.explicit, 1);
  assert.deepEqual(patched.data.collections.map((item) => item.name), ['Fiera species', 'Training candidates']);

  const collections = await j('/api/collections');
  assert.equal(collections.data.length, 2);
  assert.ok(collections.data.every((item) => item.count === 1));
  const filtered = await j(`/api/images?collection=${speciesCollectionId}`);
  assert.equal(filtered.data.total, 1);
  assert.equal(filtered.data.items[0].id, idA);
  assert.equal(filtered.data.items[0].explicit, 1);

  const stats = await j('/api/stats');
  assert.equal(stats.data.collections, 2);
  assert.equal(stats.data.explicit, 1);
  assert.ok(fs.existsSync(path.join(root, 'a-meta.png')), 'collection membership copied or moved the image');
});

test('ratings and baskets support bulk operations and ZIP export', async () => {
  const basket = await j('/api/baskets', { method: 'POST', body: { name: 'Test export' } });
  assert.equal(basket.status, 201);
  exportBasketId = basket.data.id;

  const rated = await j('/api/bulk', {
    method: 'POST', body: { ids: [idA, idB], action: 'rating', value: 4 },
  });
  assert.equal(rated.status, 200);
  assert.equal(rated.data.updated, 2);
  const filtered = await j('/api/images?rating=4');
  assert.equal(filtered.data.total, 2);

  const added = await j('/api/bulk', {
    method: 'POST', body: { ids: [idA, idB], action: 'basket-add', basket_id: exportBasketId },
  });
  assert.equal(added.status, 200);
  const baskets = await j('/api/baskets');
  assert.equal(baskets.data.find((item) => item.id === exportBasketId).count, 2);
  const inBasket = await j(`/api/images?basket=${exportBasketId}`);
  assert.equal(inBasket.data.total, 2);

  const zip = await fetch(`${base}/api/baskets/${exportBasketId}/export`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const bytes = Buffer.from(await zip.arrayBuffer());
  const exported = readStoredZip(bytes);
  assert.deepEqual([...exported.keys()].sort(), ['a-meta.png', 'b-plain.png']);
  assert.deepEqual(exported.get('a-meta.png'), fs.readFileSync(path.join(root, 'a-meta.png')));
  assert.deepEqual(exported.get('b-plain.png'), fs.readFileSync(path.join(root, 'b-plain.png')));
  assert.ok(fs.existsSync(path.join(root, 'a-meta.png')), 'basket export modified an original');
});

test('perceptual similarity returns visually matching fixtures', async () => {
  const result = await j(`/api/images/${idA}/similar?threshold=0`);
  assert.equal(result.status, 200);
  assert.ok(result.data.items.some((item) => item.id === idB), 'matching fixture was not found');
  assert.equal(result.data.items.find((item) => item.id === idB).distance, 0);
});

test('artist flag works and artist filter matches', async () => {
  const tags = await j('/api/tags?q=krek');
  const tag = tags.data.find((t) => t.name === 'by krekkov');
  const res = await j(`/api/tags/${tag.id}/artist`, { method: 'POST', body: { is_artist: 1 } });
  assert.equal(res.data.is_artist, 1);
  const filtered = await j('/api/images?artist=1');
  assert.equal(filtered.data.total, 1);
  assert.equal(filtered.data.items[0].id, idA);
});

test('remove_tags removes user tags', async () => {
  const res = await j(`/api/images/${idA}`, { method: 'PATCH', body: { remove_tags: ['mytag'] } });
  assert.ok(!res.data.tags.some((t) => t.name === 'mytag'));
  // re-add so the rescan-preservation test can verify user tags survive
  await j(`/api/images/${idA}`, { method: 'PATCH', body: { add_tags: ['mytag'] } });
});

test('thumbnail endpoint serves a generated jpeg', async () => {
  const res = await j(`/api/thumb/${idA}`);
  if (res.status === 404) {
    console.log('  (ffmpeg unavailable, skipping thumbnail assertions)');
    return;
  }
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.ok(fs.existsSync(path.join(dataDir, 'thumbs', `${idA}.jpg`)));
});

test('move relocates the file on disk and updates filters', async () => {
  const res = await j(`/api/images/${idB}/move`, { method: 'POST', body: { dir: 'refs/sub' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.dir, 'refs/sub');
  assert.ok(fs.existsSync(path.join(root, 'refs', 'sub', 'b-plain.png')));
  assert.ok(!fs.existsSync(path.join(root, 'b-plain.png')));
  const folders = await j('/api/folders');
  assert.ok(folders.data.some((f) => f.dir === 'refs/sub' && f.count === 1));
  const filtered = await j('/api/images?folder=refs%2Fsub');
  assert.equal(filtered.data.total, 1);
});

test('move conflict returns 409', async () => {
  fs.writeFileSync(path.join(root, 'conflict.png'), makePng());
  await j('/api/scan', { method: 'POST' });
  const img = (await j('/api/images?q=conflict')).data.items[0];
  // A different file already occupies the destination on disk.
  fs.writeFileSync(path.join(root, 'refs', 'sub', 'conflict.png'), makePng());
  const res = await j(`/api/images/${img.id}/move`, { method: 'POST', body: { dir: 'refs/sub' } });
  assert.equal(res.status, 409);
});

test('path traversal is rejected', async () => {
  const move = await j(`/api/images/${idB}/move`, { method: 'POST', body: { dir: '../../evil' } });
  assert.equal(move.status, 400);
  const folder = await j('/api/folders', { method: 'POST', body: { dir: '../evil' } });
  assert.equal(folder.status, 400);
});

test('rescan refreshes prompt data but preserves user data', async () => {
  fs.writeFileSync(path.join(root, 'a-meta.png'), makePng({ parameters: PARAMS_A_V2 }));
  const scan = await j('/api/scan', { method: 'POST' });
  assert.equal(scan.data.updated, 1);
  const d = (await j(`/api/images/${idA}`)).data;
  assert.ok(d.prompt_text.includes('newtag1'));
  assert.ok(!d.tags.some((t) => t.name === 'kan duguesh'), 'stale prompt tag kept');
  assert.ok(d.tags.some((t) => t.name === 'newtag1' && t.origin === 'prompt'));
  assert.ok(!d.tags.some((t) => t.polarity === 'neg'), 'stale negative tags kept after rescan');
  assert.equal(d.steps, 12);
  assert.equal(d.notes, 'hello', 'notes lost');
  assert.equal(d.favorite, 1, 'favorite lost');
  assert.equal(d.source_url, 'https://example.com/x', 'source lost');
  assert.equal(d.explicit, 1, 'explicit mark lost');
  assert.equal(d.rating, 4, 'rating lost');
  assert.deepEqual(d.collections.map((item) => item.id), [speciesCollectionId, trainingCollectionId], 'collection membership lost');
  assert.ok(d.tags.some((t) => t.name === 'mytag' && t.origin === 'user'), 'user tag lost');
  const artist = (await j('/api/tags?q=krek')).data.find((t) => t.name === 'by krekkov');
  assert.equal(artist.is_artist, 1, 'artist flag lost');
});

test('deleting a collection preserves its images and other memberships', async () => {
  const removed = await j(`/api/collections/${trainingCollectionId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const d = (await j(`/api/images/${idA}`)).data;
  assert.equal(d.name, 'a-meta.png');
  assert.deepEqual(d.collections.map((item) => item.id), [speciesCollectionId]);
  assert.ok(fs.existsSync(path.join(root, 'a-meta.png')));
});

test('PUT config validates and rescans', async () => {
  const bad = await j('/api/config', { method: 'PUT', body: { roots: 'nope' } });
  assert.equal(bad.status, 400);
  const good = await j('/api/config', { method: 'PUT', body: { roots: [root] } });
  assert.equal(good.status, 200);
  // a-meta, b-plain (moved), conflict.png, refs/sub/conflict.png
  assert.equal(good.data.stats.images, 4);
});

test('forced metadata scan reindexes unchanged files without modifying them', async () => {
  const file = path.join(root, 'a-meta.png');
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;
  const res = await j('/api/scan?force=1', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.data.updated, 4);
  assert.ok(fs.readFileSync(file).equals(before));
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('upload writes file and parses metadata immediately', async () => {
  const png = makePng({ parameters: PARAMS_A });
  const res = await fetch(`${base}/api/upload?${new URLSearchParams({ name: 'uploaded.png', dir: 'refs' })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: png,
  });
  assert.equal(res.status, 201);
  const d = await res.json();
  assert.equal(d.dir, 'refs');
  assert.equal(d.name, 'uploaded.png');
  assert.ok(d.prompt_text.includes('kan duguesh'), 'metadata not parsed at upload');
  assert.ok(d.tags.some((t) => t.name === 'by krekkov'));
  assert.ok(d.loras.some((l) => l.name === 'detail-slider'));
  assert.ok(fs.existsSync(path.join(root, 'refs', 'uploaded.png')));
  // bytes on disk are exactly what was uploaded
  assert.ok(fs.readFileSync(path.join(root, 'refs', 'uploaded.png')).equals(png));
});

test('upload reads compressed NovelAI stealth metadata from alpha pixels', async () => {
  const comment = {
    prompt: 'stealth positive, ann takamaki',
    uc: 'stealth negative, lowres',
    seed: 2744247759,
    steps: 28,
    scale: 5.5,
    sampler: 'k_euler_ancestral',
    width: 832,
    height: 1216,
  };
  const png = makeStealthPng({
    Description: comment.prompt,
    Software: 'NovelAI',
    Source: 'NovelAI Diffusion V4.5',
    Comment: JSON.stringify(comment),
  });
  const res = await fetch(`${base}/api/upload?${new URLSearchParams({ name: 'stealth-nai.png', dir: 'refs' })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: png,
  });
  assert.equal(res.status, 201);
  const d = await res.json();
  assert.equal(d.meta_status, 'ok');
  assert.equal(d.source, 'novelai');
  assert.equal(d.prompt_text, comment.prompt);
  assert.equal(d.negative, comment.uc);
  assert.equal(d.model, 'NovelAI Diffusion V4.5');
  assert.equal(d.seed, String(comment.seed));
  assert.equal(d.steps, comment.steps);
  assert.equal(d.cfg, comment.scale);
  assert.equal(d.sampler, comment.sampler);
  assert.equal(d.raw.Software, 'NovelAI');
  assert.ok(fs.readFileSync(path.join(root, 'refs', 'stealth-nai.png')).equals(png));
});

test('upload auto-renames on collision and rejects bad input', async () => {
  const png = makePng();
  const res = await fetch(`${base}/api/upload?${new URLSearchParams({ name: 'uploaded.png', dir: 'refs' })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: png,
  });
  assert.equal(res.status, 201);
  const d = await res.json();
  assert.equal(d.name, 'uploaded-1.png');
  assert.ok(fs.existsSync(path.join(root, 'refs', 'uploaded-1.png')));

  const badExt = await fetch(`${base}/api/upload?${new URLSearchParams({ name: 'evil.txt' })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('nope'),
  });
  assert.equal(badExt.status, 400);
  const traversal = await fetch(`${base}/api/upload?${new URLSearchParams({ name: '../evil.png' })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: png,
  });
  // basename strips the traversal, so this lands safely as evil.png in the root
  assert.equal(traversal.status, 201);
  assert.ok(fs.existsSync(path.join(root, 'evil.png')));
  assert.ok(!fs.existsSync(path.join(tmp, 'evil.png')));
  const badDir = await fetch(`${base}/api/upload?${new URLSearchParams({ name: 'x.png', dir: '../..' })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: png,
  });
  assert.equal(badDir.status, 400);
});

test('image list sorting supports names and ratings', async () => {
  const byName = await j('/api/images?sort=name&dir=asc&limit=200');
  const names = byName.data.items.map((item) => item.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));

  const byRating = await j('/api/images?sort=rating&dir=desc&limit=200');
  const ratings = byRating.data.items.map((item) => item.rating);
  assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a));
});

test('delete moves an image to Trash and restore preserves sidecar data', async () => {
  const active = await j('/api/images?q=uploaded.png&limit=200');
  const image = active.data.items.find((item) => item.name === 'uploaded.png');
  assert.ok(image);
  await j(`/api/images/${image.id}`, { method: 'PATCH', body: { notes: 'keep after trash' } });

  const removed = await j(`/api/images/${image.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.ok(!fs.existsSync(path.join(root, 'refs', 'uploaded.png')));
  assert.ok(fs.readdirSync(path.join(root, '.image-ref-trash')).some((name) => name.endsWith('-uploaded.png')));
  assert.ok(!(await j('/api/images?limit=200')).data.items.some((item) => item.id === image.id));

  const trash = await j('/api/images?trash=1&limit=200');
  assert.ok(trash.data.items.some((item) => item.id === image.id));
  assert.equal((await j('/api/stats')).data.trash, 1);

  const restored = await j(`/api/images/${image.id}/restore`, { method: 'POST' });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.notes, 'keep after trash');
  assert.ok(fs.existsSync(path.join(root, 'refs', 'uploaded.png')));
  assert.equal((await j('/api/stats')).data.trash, 0);
});

test('Trash supports permanent deletion of one image and emptying all images', async () => {
  const activeDelete = await j(`/api/images/${idA}/permanent`, { method: 'DELETE' });
  assert.equal(activeDelete.status, 409);

  fs.writeFileSync(path.join(root, 'trash-one.png'), makePng());
  fs.writeFileSync(path.join(root, 'trash-two.png'), makePng());
  await j('/api/scan', { method: 'POST' });
  const active = await j('/api/images?sort=name&dir=asc&limit=200');
  const one = active.data.items.find((item) => item.name === 'trash-one.png');
  const two = active.data.items.find((item) => item.name === 'trash-two.png');
  assert.ok(one && two);

  await j(`/api/images/${one.id}`, { method: 'DELETE' });
  await j(`/api/images/${two.id}`, { method: 'DELETE' });
  assert.equal((await j('/api/stats')).data.trash, 2);

  const permanent = await j(`/api/images/${one.id}/permanent`, { method: 'DELETE' });
  assert.equal(permanent.status, 200);
  assert.equal((await j(`/api/images/${one.id}`)).status, 404);

  const unconfirmed = await j('/api/trash', { method: 'DELETE', body: {} });
  assert.equal(unconfirmed.status, 400);
  const emptied = await j('/api/trash', { method: 'DELETE', body: { confirm: true } });
  assert.equal(emptied.status, 200);
  assert.equal(emptied.data.deleted, 1);
  assert.equal((await j('/api/stats')).data.trash, 0);
  assert.ok(!fs.readdirSync(path.join(root, '.image-ref-trash')).some((name) => /trash-(one|two)\.png$/.test(name)));
});

test('exact duplicate filter uses content hashes', async () => {
  const duplicates = await j('/api/images?duplicates=1&limit=200');
  assert.ok(duplicates.data.total >= 2);
  assert.ok(duplicates.data.items.some((item) => item.name === 'b-plain.png'));
  assert.ok(duplicates.data.items.some((item) => item.name === 'uploaded-1.png'));
});

async function main() {
  const { createServer } = await import('./server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // Fixtures written after boot so the first explicit scan sees them as new.
  fs.writeFileSync(path.join(root, 'a-meta.png'), makePng({ parameters: PARAMS_A }));
  fs.writeFileSync(path.join(root, 'b-plain.png'), makePng());

  let failures = 0;
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`PASS ${name}`);
      } catch (err) {
        failures += 1;
        console.error(`FAIL ${name}: ${err.message}`);
      }
    }
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} test(s) FAILED` : '\nall tests passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exitCode = 1;
});
