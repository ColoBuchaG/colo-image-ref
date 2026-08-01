import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { openDb, migrateImageTagsPolarity } from './lib/db.js';
import { scanRoots, makeIndexer, reparseAllPromptRelations, IMG_EXTS } from './lib/scanner.js';
import { detectSource } from './lib/meta.js';
import { createLibraryWatcher } from './lib/watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const DEFAULT_ROOTS = [path.join(os.homedir(), 'Pictures', 'Colo Image Ref')];
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4780);

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  const config = loadConfig();
  const db = openDb(DATA_DIR);
  if (migrateImageTagsPolarity(db)) {
    const n = reparseAllPromptRelations(db);
    console.log(`migration: split prompt tags by polarity for ${n} image(s)`);
  }
  const indexer = makeIndexer(db);

  // First boot with an empty library: scan automatically.
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM images').get();
  if (c === 0) {
    const res = scanRoots(db, config.roots, DATA_DIR);
    if (res.added || res.updated || res.removed) {
      console.log(`initial scan: +${res.added} ~${res.updated} -${res.removed}`);
    }
  }

  const thumbsInFlight = new Set();
  let scanRunning = false;
  const runScan = (forceMetadata = false) => {
    if (scanRunning) return { added: 0, updated: 0, removed: 0, busy: true };
    scanRunning = true;
    try {
      return scanRoots(db, config.roots, DATA_DIR, { forceMetadata });
    } finally {
      scanRunning = false;
    }
  };
  const watcher = process.env.WATCH_ENABLED === 'false'
    ? null
    : createLibraryWatcher(() => config.roots, () => {
        const result = runScan();
        if (result.added || result.updated || result.removed) {
          console.log(`watch scan: +${result.added} ~${result.updated} -${result.removed}`);
        }
      });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        serveStatic(res, url.pathname);
      }
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: 'internal error' });
    }
  });
  server.on('close', () => watcher?.close());

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const method = req.method;

    if (method === 'GET' && p === '/api/stats') {
      return sendJson(res, 200, stats());
    }
    if (method === 'GET' && p === '/api/config') {
      return sendJson(res, 200, { roots: config.roots });
    }
    if (method === 'PUT' && p === '/api/config') {
      const body = await readBody(req);
      const roots = sanitizeRoots(body.roots);
      if (!roots) return sendJson(res, 400, { error: 'roots must be an array of absolute paths' });
      for (const root of roots) {
        try {
          fs.mkdirSync(root, { recursive: true });
        } catch {
          return sendJson(res, 400, { error: `cannot create root: ${root}` });
        }
      }
      config.roots = roots;
      saveConfig(config);
      const scan = runScan();
      watcher?.refresh();
      return sendJson(res, 200, { roots: config.roots, scan, stats: stats() });
    }
    if (method === 'POST' && p === '/api/scan') {
      const scan = runScan(url.searchParams.get('force') === '1');
      watcher?.refresh();
      return sendJson(res, 200, scan);
    }
    if (method === 'POST' && p === '/api/upload') {
      return handleUpload(req, res, url);
    }
    if (method === 'GET' && p === '/api/folders') {
      return sendJson(res, 200, listFolders());
    }
    if (method === 'POST' && p === '/api/folders') {
      const body = await readBody(req);
      const root = typeof body.root === 'string' && config.roots.includes(body.root) ? body.root : config.roots[0];
      const dir = sanitizeDir(body.dir);
      if (dir == null) return sendJson(res, 400, { error: 'invalid dir' });
      if (!root) return sendJson(res, 400, { error: 'no roots configured' });
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET' && p === '/api/collections') {
      return sendJson(res, 200, listCollections());
    }
    if (method === 'POST' && p === '/api/collections') {
      const body = await readBody(req);
      const name = sanitizeCollectionName(body.name);
      if (!name) return sendJson(res, 400, { error: 'collection name is required' });
      try {
        const result = db.prepare('INSERT INTO collections (name, created_at) VALUES (?, ?)').run(name, Date.now());
        return sendJson(res, 201, db.prepare('SELECT id, name FROM collections WHERE id = ?').get(Number(result.lastInsertRowid)));
      } catch (err) {
        if (err.errcode === 2067 || /UNIQUE constraint failed/i.test(err.message || '')) {
          return sendJson(res, 409, { error: 'collection already exists' });
        }
        throw err;
      }
    }
    const collectionMatch = p.match(/^\/api\/collections\/(\d+)$/);
    if (collectionMatch && method === 'DELETE') {
      const result = db.prepare('DELETE FROM collections WHERE id = ?').run(Number(collectionMatch[1]));
      return result.changes
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, 404, { error: 'not found' });
    }
    if (method === 'GET' && p === '/api/baskets') {
      return sendJson(res, 200, listBaskets());
    }
    if (method === 'POST' && p === '/api/baskets') {
      const body = await readBody(req);
      const name = sanitizeCollectionName(body.name);
      if (!name) return sendJson(res, 400, { error: 'basket name is required' });
      try {
        const result = db.prepare('INSERT INTO baskets (name, created_at) VALUES (?, ?)').run(name, Date.now());
        return sendJson(res, 201, db.prepare('SELECT id, name FROM baskets WHERE id = ?').get(Number(result.lastInsertRowid)));
      } catch (err) {
        if (err.errcode === 2067 || /UNIQUE constraint failed/i.test(err.message || '')) {
          return sendJson(res, 409, { error: 'basket already exists' });
        }
        throw err;
      }
    }
    const basketMatch = p.match(/^\/api\/baskets\/(\d+)$/);
    if (basketMatch && method === 'DELETE') {
      const result = db.prepare('DELETE FROM baskets WHERE id = ?').run(Number(basketMatch[1]));
      return result.changes ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not found' });
    }
    const basketExportMatch = p.match(/^\/api\/baskets\/(\d+)\/export$/);
    if (basketExportMatch && method === 'GET') {
      return exportBasket(res, Number(basketExportMatch[1]));
    }
    if (method === 'POST' && p === '/api/bulk') {
      const body = await readBody(req);
      return handleBulk(res, body);
    }
    if (method === 'GET' && p === '/api/images') {
      return sendJson(res, 200, listImages(url.searchParams));
    }
    const similarMatch = p.match(/^\/api\/images\/(\d+)\/similar$/);
    if (similarMatch && method === 'GET') {
      return sendJson(res, 200, similarImages(Number(similarMatch[1]), url.searchParams));
    }
    const imgMatch = p.match(/^\/api\/images\/(\d+)$/);
    if (imgMatch && method === 'GET') {
      const detail = getDetail(Number(imgMatch[1]));
      return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'not found' });
    }
    if (imgMatch && method === 'PATCH') {
      const body = await readBody(req);
      const detail = patchImage(Number(imgMatch[1]), body);
      return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'not found' });
    }
    if (imgMatch && method === 'DELETE') {
      return deleteImage(res, Number(imgMatch[1]));
    }
    const restoreMatch = p.match(/^\/api\/images\/(\d+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      return restoreImage(res, Number(restoreMatch[1]));
    }
    const moveMatch = p.match(/^\/api\/images\/(\d+)\/move$/);
    if (moveMatch && method === 'POST') {
      const body = await readBody(req);
      return moveImage(res, Number(moveMatch[1]), body.dir);
    }
    if (method === 'GET' && p === '/api/tags') {
      return sendJson(res, 200, listTags(url.searchParams));
    }
    const artistMatch = p.match(/^\/api\/tags\/(\d+)\/artist$/);
    if (artistMatch && method === 'POST') {
      const body = await readBody(req);
      db.prepare('UPDATE tags SET is_artist = ? WHERE id = ?').run(body.is_artist ? 1 : 0, Number(artistMatch[1]));
      return sendJson(res, 200, { id: Number(artistMatch[1]), is_artist: body.is_artist ? 1 : 0 });
    }
    if (method === 'GET' && p === '/api/loras') {
      return sendJson(res, 200, listLoras(url.searchParams));
    }
    const fileMatch = p.match(/^\/api\/file\/(\d+)$/);
    if (fileMatch && method === 'GET') {
      return serveImageFile(res, Number(fileMatch[1]));
    }
    const thumbMatch = p.match(/^\/api\/thumb\/(\d+)$/);
    if (thumbMatch && method === 'GET') {
      return serveThumb(res, Number(thumbMatch[1]));
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  function stats() {
    const one = (sql) => db.prepare(sql).get().c;
    return {
      images: one('SELECT COUNT(*) AS c FROM images WHERE trashed_at = 0'),
      trash: one('SELECT COUNT(*) AS c FROM images WHERE trashed_at != 0'),
      folders: one('SELECT COUNT(DISTINCT root || char(0) || dir) AS c FROM images WHERE trashed_at = 0'),
      tags: one('SELECT COUNT(*) AS c FROM tags'),
      loras: one('SELECT COUNT(*) AS c FROM loras'),
      artists: one('SELECT COUNT(*) AS c FROM tags WHERE is_artist = 1'),
      collections: one('SELECT COUNT(*) AS c FROM collections'),
      baskets: one('SELECT COUNT(*) AS c FROM baskets'),
      explicit: one('SELECT COUNT(*) AS c FROM images WHERE explicit = 1 AND trashed_at = 0'),
      duplicates: one(`SELECT COUNT(*) AS c FROM images i WHERE i.trashed_at = 0 AND i.content_hash != '' AND EXISTS (
        SELECT 1 FROM images other WHERE other.id != i.id AND other.trashed_at = 0 AND other.content_hash = i.content_hash
      )`),
      watchers: watcher?.count || 0,
      roots: config.roots,
    };
  }

  function listFolders() {
    const counts = new Map();
    for (const row of db.prepare('SELECT root, dir, COUNT(*) AS c FROM images WHERE trashed_at = 0 GROUP BY root, dir').all()) {
      counts.set(`${row.root}${row.dir}`, row.c);
    }
    const out = [];
    for (const root of config.roots) {
      for (const dir of walkDirs(root)) {
        out.push({ root, dir, count: counts.get(`${root}${dir}`) || 0 });
      }
    }
    out.sort((a, b) => a.dir.localeCompare(b.dir) || a.root.localeCompare(b.root));
    return out;
  }

  function listImages(params) {
    const where = [params.get('trash') === '1' ? 'i.trashed_at != 0' : 'i.trashed_at = 0'];
    const args = [];
    const q = (params.get('q') || '').trim();
    if (q) {
      const fts = buildFtsQuery(q);
      if (fts) {
        const like = `%${escapeLike(q)}%`;
        where.push(`(
          i.id IN (SELECT rowid FROM images_fts WHERE images_fts MATCH ?)
          OR EXISTS (SELECT 1 FROM image_tags sit JOIN tags st ON st.id = sit.tag_id
                     WHERE sit.image_id = i.id AND st.name LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM image_loras sil JOIN loras sl ON sl.id = sil.lora_id
                     WHERE sil.image_id = i.id AND sl.name LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM collection_images sci JOIN collections sc ON sc.id = sci.collection_id
                     WHERE sci.image_id = i.id AND sc.name LIKE ? ESCAPE '\\')
        )`);
        args.push(fts, like, like, like);
      }
    }
    if (params.get('root')) {
      where.push('i.root = ?');
      args.push(params.get('root'));
    }
    if (params.has('folder')) {
      where.push('i.dir = ?');
      args.push(params.get('folder'));
    }
    if (params.get('tag')) {
      where.push(`EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
                 WHERE it.image_id = i.id AND t.name = ? COLLATE NOCASE)`);
      args.push(params.get('tag'));
    }
    if (params.get('lora')) {
      where.push(`EXISTS (SELECT 1 FROM image_loras il JOIN loras l ON l.id = il.lora_id
                 WHERE il.image_id = i.id AND l.name = ? COLLATE NOCASE)`);
      args.push(params.get('lora'));
    }
    if (params.get('collection')) {
      where.push('EXISTS (SELECT 1 FROM collection_images ci WHERE ci.image_id = i.id AND ci.collection_id = ?)');
      args.push(Number(params.get('collection')));
    }
    if (params.get('basket')) {
      where.push('EXISTS (SELECT 1 FROM basket_images bi WHERE bi.image_id = i.id AND bi.basket_id = ?)');
      args.push(Number(params.get('basket')));
    }
    if (params.get('rating')) {
      where.push('i.rating = ?');
      args.push(Math.max(0, Math.min(5, Number(params.get('rating')) || 0)));
    }
    if (params.get('duplicates') === '1') {
      where.push(`i.content_hash != '' AND EXISTS (
        SELECT 1 FROM images other WHERE other.id != i.id AND other.trashed_at = 0 AND other.content_hash = i.content_hash
      )`);
    }
    if (params.get('artist') === '1') {
      where.push(`EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
                 WHERE it.image_id = i.id AND t.is_artist = 1)`);
    }
    if (params.get('fav') === '1') where.push('i.favorite = 1');
    if (params.get('hasmeta') === '1') where.push(`i.meta_status = 'ok'`);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortCol = {
      mtime: 'i.mtime', name: 'i.name', size: 'i.size', created: 'i.created_at',
      rating: 'i.rating', trashed: 'i.trashed_at',
    }[params.get('sort')] || 'i.mtime';
    const sortDir = params.get('dir') === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, parseInt(params.get('page'), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(params.get('limit'), 10) || 60));

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM images i ${whereSql}`).get(...args);
    const items = db.prepare(`
      SELECT i.id, i.root, i.dir, i.name, i.ext, i.width, i.height, i.size, i.favorite, i.explicit,
             i.rating, i.meta_status, i.content_hash, i.raw_meta,
             i.created_at AS added
      FROM images i ${whereSql}
      ORDER BY ${sortCol} ${sortDir}, i.id ${sortDir}
      LIMIT ? OFFSET ?
    `).all(...args, limit, (page - 1) * limit).map(withDetectedSource);

    return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
  }

  function getDetail(id) {
    const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
    if (!row) return null;
    const tags = db.prepare(`
      SELECT t.id, t.name, t.is_artist, it.origin, it.polarity
      FROM image_tags it JOIN tags t ON t.id = it.tag_id
      WHERE it.image_id = ? ORDER BY t.name
    `).all(id);
    const loras = db.prepare(`
      SELECT l.id, l.name, il.weight
      FROM image_loras il JOIN loras l ON l.id = il.lora_id
      WHERE il.image_id = ? ORDER BY l.name
    `).all(id);
    const collections = db.prepare(`
      SELECT c.id, c.name
      FROM collections c JOIN collection_images ci ON ci.collection_id = c.id
      WHERE ci.image_id = ? ORDER BY c.name
    `).all(id);
    const baskets = db.prepare(`
      SELECT b.id, b.name
      FROM baskets b JOIN basket_images bi ON bi.basket_id = b.id
      WHERE bi.image_id = ? ORDER BY b.name
    `).all(id);
    let raw = {};
    try { raw = row.raw_meta ? JSON.parse(row.raw_meta) : {}; } catch { raw = {}; }
    delete row.raw_meta;
    return { ...row, raw, tags, loras, collections, baskets, source: detectSource(raw) };
  }

  function patchImage(id, body) {
    const row = db.prepare('SELECT id FROM images WHERE id = ?').get(id);
    if (!row) return null;
    const now = Date.now();
    if (typeof body.source_url === 'string') {
      db.prepare('UPDATE images SET source_url = ?, updated_at = ? WHERE id = ?').run(body.source_url.slice(0, 2000), now, id);
    }
    if (typeof body.notes === 'string') {
      db.prepare('UPDATE images SET notes = ?, updated_at = ? WHERE id = ?').run(body.notes.slice(0, 10000), now, id);
    }
    if (body.favorite != null) {
      db.prepare('UPDATE images SET favorite = ?, updated_at = ? WHERE id = ?').run(body.favorite ? 1 : 0, now, id);
    }
    if (body.explicit != null) {
      db.prepare('UPDATE images SET explicit = ?, updated_at = ? WHERE id = ?').run(body.explicit ? 1 : 0, now, id);
    }
    if (body.rating != null) {
      const rating = Math.max(0, Math.min(5, Math.round(Number(body.rating) || 0)));
      db.prepare('UPDATE images SET rating = ?, updated_at = ? WHERE id = ?').run(rating, now, id);
    }
    if (Array.isArray(body.collection_ids)) {
      const wanted = [...new Set(body.collection_ids
        .slice(0, 200)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0))];
      const existing = new Set(db.prepare('SELECT id FROM collections').all().map((item) => item.id));
      const link = db.prepare('INSERT OR IGNORE INTO collection_images (collection_id, image_id) VALUES (?, ?)');
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM collection_images WHERE image_id = ?').run(id);
        for (const collectionId of wanted) {
          if (existing.has(collectionId)) link.run(collectionId, id);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    if (Array.isArray(body.add_tags)) {
      const insTag = db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
      const getTag = db.prepare('SELECT id FROM tags WHERE name = ?');
      const link = db.prepare(`INSERT INTO image_tags (image_id, tag_id, origin, polarity) VALUES (?, ?, 'user', 'pos') ON CONFLICT(image_id, tag_id, origin, polarity) DO NOTHING`);
      for (const raw of body.add_tags.slice(0, 50)) {
        const name = String(raw).trim().slice(0, 200);
        if (!name) continue;
        insTag.run(name);
        link.run(id, getTag.get(name).id);
      }
    }
    if (Array.isArray(body.remove_tags)) {
      const unlink = db.prepare(`
        DELETE FROM image_tags WHERE image_id = ? AND origin = 'user' AND tag_id IN (SELECT id FROM tags WHERE name = ?)
      `);
      for (const raw of body.remove_tags.slice(0, 50)) {
        unlink.run(id, String(raw).trim());
      }
    }
    return getDetail(id);
  }

  function moveImage(res, id, dirRaw) {
    const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });
    const dir = sanitizeDir(dirRaw);
    if (dir == null) return sendJson(res, 400, { error: 'invalid dir' });
    const src = path.join(row.root, row.rel_path);
    const destDir = path.join(row.root, dir);
    const dest = path.join(destDir, row.name);
    if (fs.existsSync(dest)) return sendJson(res, 409, { error: 'a file with that name already exists there' });
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(src, dest);
    } catch (err) {
      return sendJson(res, 500, { error: `move failed: ${err.message}` });
    }
    const rel = dir ? path.join(dir, row.name) : row.name;
    db.prepare('UPDATE images SET rel_path = ?, dir = ?, updated_at = ? WHERE id = ?')
      .run(rel, dir, Date.now(), id);
    return sendJson(res, 200, getDetail(id));
  }

  // Move an image into a hidden folder inside its library root. The DB row and
  // sidecar metadata remain intact so the image can be restored later.
  function deleteImage(res, id) {
    const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });
    if (row.trashed_at) return sendJson(res, 409, { error: 'image is already in Trash' });
    try {
      moveToTrash(row);
    } catch (err) {
      return sendJson(res, 500, { error: `trash failed: ${err.message}` });
    }
    thumbsInFlight.delete(id);
    return sendJson(res, 200, { ok: true });
  }

  function moveToTrash(row) {
    const trashDir = path.join(row.root, '.image-ref-trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const trashedAt = Date.now();
    const trashRel = path.join('.image-ref-trash', `${row.id}-${trashedAt}-${row.name}`);
    fs.renameSync(path.join(row.root, row.rel_path), path.join(row.root, trashRel));
    db.prepare(`UPDATE images
      SET rel_path = ?, dir = '.image-ref-trash', original_rel_path = ?, trashed_at = ?, updated_at = ?
      WHERE id = ?`)
      .run(trashRel, row.rel_path, trashedAt, trashedAt, row.id);
  }

  function restoreImage(res, id) {
    const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });
    if (!row.trashed_at || !row.original_rel_path) return sendJson(res, 409, { error: 'image is not in Trash' });
    const destination = path.join(row.root, row.original_rel_path);
    if (fs.existsSync(destination)) return sendJson(res, 409, { error: 'a file already exists at the original location' });
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(path.join(row.root, row.rel_path), destination);
    } catch (err) {
      return sendJson(res, 500, { error: `restore failed: ${err.message}` });
    }
    const originalDir = path.dirname(row.original_rel_path);
    db.prepare(`UPDATE images
      SET rel_path = ?, dir = ?, original_rel_path = '', trashed_at = 0, updated_at = ?
      WHERE id = ?`)
      .run(row.original_rel_path, originalDir === '.' ? '' : originalDir, Date.now(), id);
    return sendJson(res, 200, getDetail(id));
  }

  // Drag-drop upload: raw binary body, ?name=<filename>&dir=<target dir>&root=<root>.
  // The file is written into the library and indexed immediately, so parsed
  // prompt/tags/LoRAs are available in the response right away.
  async function handleUpload(req, res, url) {
    const name = sanitizeUploadName(url.searchParams.get('name'));
    if (!name) return sendJson(res, 400, { error: 'invalid or unsupported filename (png/jpg/jpeg only)' });
    const dir = sanitizeDir(url.searchParams.get('dir') ?? '');
    if (dir == null) return sendJson(res, 400, { error: 'invalid dir' });
    const rootParam = url.searchParams.get('root');
    const root = rootParam && config.roots.includes(rootParam) ? rootParam : config.roots[0];
    if (!root) return sendJson(res, 400, { error: 'no roots configured' });

    let buf;
    try {
      buf = await readRawBody(req, 60 * 1024 * 1024);
    } catch {
      return sendJson(res, 413, { error: 'file too large (60 MB max)' });
    }
    if (!buf.length) return sendJson(res, 400, { error: 'empty body' });

    // Auto-rename on collision: "name.png" -> "name-1.png", "name-2.png", ...
    const ext = path.extname(name).toLowerCase();
    const stem = name.slice(0, name.length - ext.length);
    let finalName = name;
    let n = 1;
    const destDir = path.join(root, dir);
    while (fs.existsSync(path.join(destDir, finalName))) {
      finalName = `${stem}-${n}${ext}`;
      n += 1;
    }

    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, finalName), buf);
    } catch (err) {
      return sendJson(res, 500, { error: `write failed: ${err.message}` });
    }
    const rel = dir ? path.join(dir, finalName) : finalName;
    const { id } = indexer.indexFile(root, rel);
    return sendJson(res, 201, getDetail(id));
  }

  function listTags(params) {
    const q = (params.get('q') || '').trim();
    const limit = Math.min(500, Math.max(1, parseInt(params.get('limit'), 10) || 200));
    const where = q ? `WHERE t.name LIKE ? ESCAPE '\\'` : '';
    const args = q ? [`%${escapeLike(q)}%`] : [];
    return db.prepare(`
      SELECT t.id, t.name, t.is_artist,
             (SELECT COUNT(*) FROM image_tags it JOIN images i ON i.id = it.image_id
              WHERE it.tag_id = t.id AND i.trashed_at = 0) AS count
      FROM tags t
      ${where}
      ORDER BY count DESC, t.name LIMIT ?
    `).all(...args, limit);
  }

  function listLoras(params) {
    const q = (params.get('q') || '').trim();
    const limit = Math.min(500, Math.max(1, parseInt(params.get('limit'), 10) || 200));
    const where = q ? `WHERE l.name LIKE ? ESCAPE '\\'` : '';
    const args = q ? [`%${escapeLike(q)}%`] : [];
    return db.prepare(`
      SELECT l.id, l.name,
             (SELECT COUNT(*) FROM image_loras il JOIN images i ON i.id = il.image_id
              WHERE il.lora_id = l.id AND i.trashed_at = 0) AS count
      FROM loras l
      ${where}
      ORDER BY count DESC, l.name LIMIT ?
    `).all(...args, limit);
  }

  function listCollections() {
    return db.prepare(`
      SELECT c.id, c.name,
             (SELECT COUNT(*) FROM collection_images ci JOIN images i ON i.id = ci.image_id
              WHERE ci.collection_id = c.id AND i.trashed_at = 0) AS count
      FROM collections c ORDER BY c.name
    `).all();
  }

  function listBaskets() {
    return db.prepare(`
      SELECT b.id, b.name,
             (SELECT COUNT(*) FROM basket_images bi JOIN images i ON i.id = bi.image_id
              WHERE bi.basket_id = b.id AND i.trashed_at = 0) AS count
      FROM baskets b ORDER BY b.name
    `).all();
  }

  function similarImages(id, params) {
    const source = db.prepare('SELECT id, perceptual_hash FROM images WHERE id = ? AND trashed_at = 0').get(id);
    if (!source) return { source: null, items: [] };
    if (!source.perceptual_hash) return { source: id, items: [], unavailable: true };
    const threshold = Math.max(0, Math.min(32, Number(params.get('threshold')) || 10));
    const limit = Math.max(1, Math.min(200, Number(params.get('limit')) || 60));
    const items = db.prepare(`
      SELECT id, root, dir, name, ext, width, height, size, favorite, explicit, rating, content_hash, raw_meta,
             hamming64(perceptual_hash, ?) AS distance
      FROM images
      WHERE id != ? AND trashed_at = 0 AND perceptual_hash != '' AND hamming64(perceptual_hash, ?) <= ?
      ORDER BY distance, id DESC LIMIT ?
    `).all(source.perceptual_hash, id, source.perceptual_hash, threshold, limit).map(withDetectedSource);
    return { source: id, threshold, items };
  }

  function handleBulk(res, body) {
    const ids = sanitizeImageIds(body.ids);
    if (!ids.length) return sendJson(res, 400, { error: 'select at least one image' });
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM images WHERE id IN (${placeholders})`).all(...ids);
    if (!rows.length) return sendJson(res, 404, { error: 'no selected images found' });
    const now = Date.now();
    const action = String(body.action || '');

    if (action === 'favorite' || action === 'explicit') {
      const value = body.value ? 1 : 0;
      db.prepare(`UPDATE images SET ${action} = ?, updated_at = ? WHERE id IN (${placeholders})`).run(value, now, ...ids);
    } else if (action === 'rating') {
      const rating = Math.max(0, Math.min(5, Math.round(Number(body.value) || 0)));
      db.prepare(`UPDATE images SET rating = ?, updated_at = ? WHERE id IN (${placeholders})`).run(rating, now, ...ids);
    } else if (action === 'collection-add' || action === 'collection-remove') {
      const collectionId = Number(body.collection_id);
      if (!db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId)) {
        return sendJson(res, 404, { error: 'collection not found' });
      }
      const stmt = action.endsWith('add')
        ? db.prepare('INSERT OR IGNORE INTO collection_images (collection_id, image_id) VALUES (?, ?)')
        : db.prepare('DELETE FROM collection_images WHERE collection_id = ? AND image_id = ?');
      db.exec('BEGIN');
      try {
        for (const id of ids) stmt.run(collectionId, id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } else if (action === 'basket-add' || action === 'basket-remove') {
      const basketId = Number(body.basket_id);
      if (!db.prepare('SELECT id FROM baskets WHERE id = ?').get(basketId)) {
        return sendJson(res, 404, { error: 'basket not found' });
      }
      const stmt = action.endsWith('add')
        ? db.prepare('INSERT OR IGNORE INTO basket_images (basket_id, image_id, added_at) VALUES (?, ?, ?)')
        : db.prepare('DELETE FROM basket_images WHERE basket_id = ? AND image_id = ?');
      db.exec('BEGIN');
      try {
        for (const id of ids) action.endsWith('add') ? stmt.run(basketId, id, now) : stmt.run(basketId, id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } else if (action === 'move') {
      const dir = sanitizeDir(body.dir);
      if (dir == null) return sendJson(res, 400, { error: 'invalid dir' });
      const destinations = new Set();
      for (const row of rows) {
        const source = path.resolve(row.root, row.rel_path);
        const destination = path.resolve(row.root, dir, row.name);
        if (destination === source) continue;
        if (destinations.has(destination) || fs.existsSync(destination)) {
          return sendJson(res, 409, { error: `move conflict: ${row.name}` });
        }
        destinations.add(destination);
      }
      for (const row of rows) {
        const source = path.resolve(row.root, row.rel_path);
        const destinationDir = path.resolve(row.root, dir);
        const destination = path.join(destinationDir, row.name);
        if (destination === source) continue;
        fs.mkdirSync(destinationDir, { recursive: true });
        fs.renameSync(source, destination);
        const rel = dir ? path.join(dir, row.name) : row.name;
        db.prepare('UPDATE images SET rel_path = ?, dir = ?, updated_at = ? WHERE id = ?').run(rel, dir, now, row.id);
      }
      watcher?.refresh();
    } else if (action === 'delete') {
      if (body.confirm !== true) return sendJson(res, 400, { error: 'bulk delete requires confirmation' });
      for (const row of rows) {
        if (row.trashed_at) continue;
        try { moveToTrash(row); } catch (err) {
          return sendJson(res, 500, { error: `trash failed: ${row.name}: ${err.message}` });
        }
      }
    } else {
      return sendJson(res, 400, { error: 'unsupported bulk action' });
    }
    return sendJson(res, 200, { ok: true, updated: rows.length });
  }

  function exportBasket(res, basketId) {
    const basket = db.prepare('SELECT id, name FROM baskets WHERE id = ?').get(basketId);
    if (!basket) return sendJson(res, 404, { error: 'basket not found' });
    const rows = db.prepare(`
      SELECT i.id, i.root, i.rel_path, i.name
      FROM images i JOIN basket_images bi ON bi.image_id = i.id
      WHERE bi.basket_id = ? AND i.trashed_at = 0 ORDER BY bi.added_at, i.id
    `).all(basketId);
    if (!rows.length) return sendJson(res, 400, { error: 'basket is empty' });

    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'image-ref-basket-'));
    const used = new Set();
    for (const row of rows) {
      const source = resolveImagePath(row);
      if (!source || !fs.existsSync(source)) continue;
      let name = path.basename(row.name).replace(/[\\/]/g, '_');
      if (used.has(name.toLowerCase())) name = `${row.id}-${name}`;
      used.add(name.toLowerCase());
      fs.symlinkSync(source, path.join(stage, name));
    }
    const filename = `${basket.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'basket'}.zip`;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
    const zip = spawn('zip', ['-q', '-0', '-r', '-', '.'], { cwd: stage });
    zip.stdout.pipe(res);
    zip.stderr.on('data', (chunk) => console.error(`basket export: ${chunk}`));
    const cleanup = () => fs.rmSync(stage, { recursive: true, force: true });
    zip.on('close', cleanup);
    zip.on('error', (err) => {
      console.error(`basket export: ${err.message}`);
      cleanup();
      res.destroy(err);
    });
  }

  function resolveImagePath(row) {
    if (!row || !config.roots.includes(row.root)) return null;
    const full = path.resolve(row.root, row.rel_path);
    if (!full.startsWith(path.resolve(row.root) + path.sep)) return null;
    return full;
  }

  function serveImageFile(res, id) {
    const row = db.prepare('SELECT root, rel_path, ext FROM images WHERE id = ?').get(id);
    const full = resolveImagePath(row);
    if (!full || !fs.existsSync(full)) return sendJson(res, 404, { error: 'not found' });
    const type = row.ext === '.png' ? 'image/png' : 'image/jpeg';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': fs.statSync(full).size,
      'Cache-Control': 'private, max-age=3600',
    });
    fs.createReadStream(full).pipe(res);
  }

  function serveThumb(res, id) {
    const thumbPath = path.join(THUMB_DIR, `${id}.jpg`);
    if (!fs.existsSync(thumbPath)) {
      if (thumbsInFlight.has(id)) {
        // Another request is generating it; ask the client to retry shortly.
        return sendJson(res, 202, { retry: true });
      }
      const row = db.prepare('SELECT root, rel_path FROM images WHERE id = ?').get(id);
      const full = resolveImagePath(row);
      if (!full || !fs.existsSync(full)) return sendJson(res, 404, { error: 'not found' });
      thumbsInFlight.add(id);
      // Temp name must end in .jpg so ffmpeg infers the muxer format.
      const tmpPath = `${thumbPath}.${process.pid}.jpg`;
      execFile('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', full,
        '-vf', "scale='min(480,iw)':-2",
        '-q:v', '4', tmpPath,
      ], { timeout: 30000 }, (err) => {
        thumbsInFlight.delete(id);
        if (err) {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          console.error(`thumb ${id}: ${err.message}`);
          return sendJson(res, 404, { error: 'thumbnail failed' });
        }
        try {
          fs.renameSync(tmpPath, thumbPath);
        } catch { /* raced by another request */ }
        sendThumbFile(res, thumbPath);
      });
      return;
    }
    sendThumbFile(res, thumbPath);
  }

  return server;
}

function sendThumbFile(res, thumbPath) {
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': fs.statSync(thumbPath).size,
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  fs.createReadStream(thumbPath).pipe(res);
}

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return sendJson(res, 404, { error: 'not found' });
  }
  const type = STATIC_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(full).size });
  fs.createReadStream(full).pipe(res);
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const roots = sanitizeRoots(raw.roots);
    if (roots) return { roots };
  } catch { /* missing or invalid config: recreate */ }
  const config = { roots: [...DEFAULT_ROOTS] };
  for (const root of config.roots) {
    try { fs.mkdirSync(root, { recursive: true }); } catch (err) {
      console.error(`cannot create default root ${root}: ${err.message}`);
    }
  }
  saveConfig(config);
  return config;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function sanitizeRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0 || roots.length > 20) return null;
  const out = [];
  for (const r of roots) {
    if (typeof r !== 'string' || !r.trim()) return null;
    const abs = path.resolve(r.trim());
    if (!path.isAbsolute(abs)) return null;
    if (out.includes(abs)) continue;
    out.push(abs);
  }
  return out;
}

function withDetectedSource(row) {
  let raw = {};
  try { raw = row.raw_meta ? JSON.parse(row.raw_meta) : {}; } catch { raw = {}; }
  const { raw_meta: _rawMeta, ...item } = row;
  return { ...item, source: detectSource(raw) };
}

// Reject absolute paths and traversal; '' means the root itself.
function sanitizeDir(dirRaw) {
  if (dirRaw == null || dirRaw === '') return '';
  if (typeof dirRaw !== 'string') return null;
  const norm = path.normalize(dirRaw.trim()).replace(/^([/\\])+/, '');
  if (norm === '.' ) return '';
  if (norm.startsWith('..') || path.isAbsolute(norm) || norm.includes('\0')) return null;
  return norm;
}

function walkDirs(root) {
  const out = [''];
  const stack = [''];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const rel = dir ? path.join(dir, e.name) : e.name;
      out.push(rel);
      stack.push(rel);
    }
  }
  return out.sort();
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function buildFtsQuery(input) {
  const terms = String(input || '')
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.slice(0, 20) || [];
  return terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(' AND ');
}

function sanitizeImageIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .slice(0, 1000)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sanitizeUploadName(nameRaw) {
  if (!nameRaw || typeof nameRaw !== 'string') return null;
  const name = path.basename(nameRaw.trim());
  if (!name || name.startsWith('.') || name.includes('\0') || name.length > 255) return null;
  if (!IMG_EXTS.has(path.extname(name).toLowerCase())) return null;
  return name;
}

function sanitizeCollectionName(nameRaw) {
  if (typeof nameRaw !== 'string') return null;
  const name = nameRaw.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 120 || name.includes('\0')) return null;
  return name;
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Colo Image Ref → http://${HOST}:${server.address().port}`);
  });
}
