// Filesystem scanner + single-file indexer: indexes images under the
// configured roots into the DB. Read-only with respect to image files —
// never writes to or modifies them.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readPngMeta, readJpegSize, readJpegExifText } from './imagefile.js';
import { extractFromChunks, tagsFromPrompt } from './meta.js';

export const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg']);

// Factory holding prepared statements so scans and uploads can share one indexer.
export function makeIndexer(db) {
  const findStmt = db.prepare('SELECT id, size, mtime, content_hash, perceptual_hash FROM images WHERE root = ? AND rel_path = ?');
  const insertStmt = db.prepare(`
    INSERT INTO images (root, rel_path, dir, name, ext, size, mtime, width, height, meta_status,
                        prompt_text, negative, model, seed, steps, cfg, sampler, raw_meta,
                        content_hash, perceptual_hash, manual_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            (SELECT COALESCE(MAX(manual_order), 0) + 1 FROM images), ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE images SET dir = ?, name = ?, ext = ?, size = ?, mtime = ?, width = ?, height = ?,
                      meta_status = ?, prompt_text = ?, negative = ?, model = ?, seed = ?,
                      steps = ?, cfg = ?, sampler = ?, raw_meta = ?, content_hash = ?,
                      perceptual_hash = ?, updated_at = ?
    WHERE id = ?
  `);
  const updateHashesStmt = db.prepare('UPDATE images SET content_hash = ?, perceptual_hash = ?, updated_at = ? WHERE id = ?');
  const delPromptTags = db.prepare(`DELETE FROM image_tags WHERE image_id = ? AND origin = 'prompt'`);
  const delLoras = db.prepare('DELETE FROM image_loras WHERE image_id = ?');
  const insTag = db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
  const getTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const linkTag = db.prepare(`INSERT INTO image_tags (image_id, tag_id, origin, polarity) VALUES (?, ?, 'prompt', ?) ON CONFLICT(image_id, tag_id, origin, polarity) DO NOTHING`);
  const insLora = db.prepare('INSERT INTO loras (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
  const getLora = db.prepare('SELECT id FROM loras WHERE name = ?');
  const linkLora = db.prepare('INSERT INTO image_loras (image_id, lora_id, weight) VALUES (?, ?, ?) ON CONFLICT(image_id, lora_id) DO UPDATE SET weight = excluded.weight');

  const upsertTag = (name) => {
    insTag.run(name);
    return getTag.get(name).id;
  };
  const upsertLora = (name) => {
    insLora.run(name);
    return getLora.get(name).id;
  };

  // Index (or re-index) one file. Returns { id, status: 'added'|'updated'|'unchanged' }.
  // User data (user tags, source_url, notes, favorite) is never touched.
  function indexFile(root, rel, { forceMetadata = false } = {}) {
    const now = Date.now();
    const full = path.join(root, rel);
    const st = fs.statSync(full);
    const existing = findStmt.get(root, rel);
    const unchanged = existing && existing.size === st.size && existing.mtime === Math.round(st.mtimeMs);
    if (unchanged && !forceMetadata) {
      if (!existing.content_hash || !existing.perceptual_hash) {
        const hashes = computeHashes(full);
        updateHashesStmt.run(hashes.content, hashes.perceptual, now, existing.id);
      }
      return { id: existing.id, status: 'unchanged' };
    }

    const meta = extractMeta(full);
    // A forced metadata refresh should not redo expensive hashes for an
    // unchanged file. Missing hashes are still backfilled normally.
    const hashes = unchanged && existing.content_hash && existing.perceptual_hash
      ? { content: existing.content_hash, perceptual: existing.perceptual_hash }
      : computeHashes(full);
    const dir = dirOf(rel);
    const name = path.basename(rel);
    const ext = path.extname(rel).toLowerCase();

    let imageId;
    let status;
    if (existing) {
      updateStmt.run(dir, name, ext, st.size, Math.round(st.mtimeMs), meta.width, meta.height,
        meta.status, meta.prompt_text, meta.negative, meta.model, meta.seed,
        meta.steps, meta.cfg, meta.sampler, meta.raw, hashes.content, hashes.perceptual, now, existing.id);
      imageId = existing.id;
      status = 'updated';
    } else {
      const res = insertStmt.run(root, rel, dir, name, ext, st.size, Math.round(st.mtimeMs),
        meta.width, meta.height, meta.status, meta.prompt_text, meta.negative, meta.model,
        meta.seed, meta.steps, meta.cfg, meta.sampler, meta.raw, hashes.content, hashes.perceptual, now, now);
      imageId = Number(res.lastInsertRowid);
      status = 'added';
    }

    // Refresh prompt-derived relations only.
    delPromptTags.run(imageId);
    // cologen prompts are natural language, not tag lists — keep the text, skip tags
    if (meta.source !== 'cologen') {
      for (const tag of tagsFromPrompt(meta.prompt_text)) {
        linkTag.run(imageId, upsertTag(tag), 'pos');
      }
      for (const tag of tagsFromPrompt(meta.negative)) {
        linkTag.run(imageId, upsertTag(tag), 'neg');
      }
    }
    delLoras.run(imageId);
    for (const lora of meta.loras) {
      linkLora.run(imageId, upsertLora(lora.name), lora.weight);
    }
    return { id: imageId, status };
  }

  return { indexFile };
}

function computeHashes(full) {
  let content = '';
  let perceptual = '';
  try {
    content = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  } catch { /* file may vanish during scan */ }
  try {
    const pixels = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', full,
      '-vf', 'scale=9:8,format=gray', '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ], { timeout: 20000, maxBuffer: 1024 * 1024 });
    if (pixels.length >= 72) {
      let bits = 0n;
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          bits = (bits << 1n) | (pixels[y * 9 + x] > pixels[y * 9 + x + 1] ? 1n : 0n);
        }
      }
      perceptual = bits.toString(16).padStart(16, '0');
    }
  } catch { /* ffmpeg is optional; exact duplicate detection still works */ }
  return { content, perceptual };
}

export function scanRoots(db, roots, dataDir, { forceMetadata = false } = {}) {
  const indexer = makeIndexer(db);
  const seen = new Set();
  let added = 0;
  let updated = 0;

  for (const root of roots) {
    let files;
    try {
      files = listImages(root);
    } catch (err) {
      console.error(`scan: cannot read root ${root}: ${err.message}`);
      continue;
    }
    for (const rel of files) {
      const key = `${root}${rel}`;
      seen.add(key);
      let result;
      try {
        result = indexer.indexFile(root, rel, { forceMetadata });
      } catch {
        continue; // vanished mid-scan
      }
      if (result.status === 'added') added += 1;
      else if (result.status === 'updated') updated += 1;
    }
  }

  // Prune rows for files that vanished or roots that were removed.
  let removed = 0;
  const thumbDir = path.join(dataDir, 'thumbs');
  const delImage = db.prepare('DELETE FROM images WHERE id = ?');
  for (const row of db.prepare('SELECT id, root, rel_path FROM images WHERE trashed_at = 0').all()) {
    const key = `${row.root}${row.rel_path}`;
    if (!seen.has(key)) {
      delImage.run(row.id);
      try { fs.unlinkSync(path.join(thumbDir, `${row.id}.jpg`)); } catch { /* no thumb */ }
      removed += 1;
    }
  }

  return { added, updated, removed };
}

export function dirOf(rel) {
  const d = path.dirname(rel);
  return d === '.' ? '' : d;
}

// Re-derive prompt-origin tags (pos + neg) and LoRAs from the stored raw
// metadata, without touching image files. Used after schema migrations that
// change how prompt relations are extracted. User data is never touched.
export function reparseAllPromptRelations(db) {
  const rows = db.prepare(`SELECT id, raw_meta FROM images WHERE meta_status = 'ok' AND raw_meta != ''`).all();
  if (!rows.length) return 0;
  const delTags = db.prepare(`DELETE FROM image_tags WHERE image_id = ? AND origin = 'prompt'`);
  const delLoras = db.prepare('DELETE FROM image_loras WHERE image_id = ?');
  const insTag = db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
  const getTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const linkTag = db.prepare(`INSERT INTO image_tags (image_id, tag_id, origin, polarity) VALUES (?, ?, 'prompt', ?) ON CONFLICT(image_id, tag_id, origin, polarity) DO NOTHING`);
  const insLora = db.prepare('INSERT INTO loras (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
  const getLora = db.prepare('SELECT id FROM loras WHERE name = ?');
  const linkLora = db.prepare('INSERT INTO image_loras (image_id, lora_id, weight) VALUES (?, ?, ?) ON CONFLICT(image_id, lora_id) DO UPDATE SET weight = excluded.weight');

  let count = 0;
  for (const row of rows) {
    let raw;
    try {
      raw = JSON.parse(row.raw_meta);
    } catch {
      continue;
    }
    const parsed = extractFromChunks(raw);
    delTags.run(row.id);
    if (parsed.source !== 'cologen') {
      for (const tag of tagsFromPrompt(parsed.prompt_text)) {
        insTag.run(tag);
        linkTag.run(row.id, getTag.get(tag).id, 'pos');
      }
      for (const tag of tagsFromPrompt(parsed.negative)) {
        insTag.run(tag);
        linkTag.run(row.id, getTag.get(tag).id, 'neg');
      }
    }
    delLoras.run(row.id);
    for (const lora of parsed.loras) {
      insLora.run(lora.name);
      linkLora.run(row.id, getLora.get(lora.name).id, lora.weight);
    }
    count += 1;
  }
  return count;
}

function listImages(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const dir = stack.pop();
    const absDir = path.join(root, dir);
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = dir ? path.join(dir, e.name) : e.name;
      if (e.isDirectory()) {
        stack.push(rel);
      } else if (e.isFile() && IMG_EXTS.has(path.extname(e.name).toLowerCase())) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

function extractMeta(full) {
  const empty = {
    width: null, height: null, status: 'none', prompt_text: '', negative: '',
    model: '', seed: '', steps: null, cfg: null, sampler: '', raw: '', loras: [], source: '',
  };
  try {
    const ext = path.extname(full).toLowerCase();
    let width = null;
    let height = null;
    let texts = {};
    if (ext === '.png') {
      const png = readPngMeta(full);
      width = png.width;
      height = png.height;
      texts = png.texts;
    } else {
      ({ width, height } = readJpegSize(full));
      const exif = readJpegExifText(full);
      if (exif) texts = { parameters: exif };
    }
    const parsed = extractFromChunks(texts);
    if (!width && parsed.size) {
      const m = String(parsed.size).match(/(\d+)\s*x\s*(\d+)/i);
      if (m) {
        width = parseInt(m[1], 10);
        height = parseInt(m[2], 10);
      }
    }
    const hasMeta = Object.keys(texts).length > 0;
    return {
      width, height,
      status: hasMeta ? 'ok' : 'none',
      source: parsed.source,
      prompt_text: parsed.prompt_text,
      negative: parsed.negative,
      model: parsed.model,
      seed: parsed.seed,
      steps: parsed.steps,
      cfg: parsed.cfg,
      sampler: parsed.sampler,
      raw: hasMeta ? JSON.stringify(parsed.raw) : '',
      loras: parsed.loras,
    };
  } catch {
    return { ...empty, status: 'error' };
  }
}
