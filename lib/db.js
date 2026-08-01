import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'library.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY,
      root TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      dir TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      meta_status TEXT NOT NULL DEFAULT 'none',
      prompt_text TEXT NOT NULL DEFAULT '',
      negative TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      seed TEXT NOT NULL DEFAULT '',
      steps INTEGER,
      cfg REAL,
      sampler TEXT NOT NULL DEFAULT '',
      raw_meta TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0,
      explicit INTEGER NOT NULL DEFAULT 0,
      rating INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '',
      perceptual_hash TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(root, rel_path)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      is_artist INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS image_tags (
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      origin TEXT NOT NULL DEFAULT 'user',
      polarity TEXT NOT NULL DEFAULT 'pos',
      PRIMARY KEY (image_id, tag_id, origin, polarity)
    );

    CREATE TABLE IF NOT EXISTS loras (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );

    CREATE TABLE IF NOT EXISTS image_loras (
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      lora_id INTEGER NOT NULL REFERENCES loras(id) ON DELETE CASCADE,
      weight REAL,
      PRIMARY KEY (image_id, lora_id)
    );

    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection_images (
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      PRIMARY KEY (collection_id, image_id)
    );

    CREATE TABLE IF NOT EXISTS baskets (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS basket_images (
      basket_id INTEGER NOT NULL REFERENCES baskets(id) ON DELETE CASCADE,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (basket_id, image_id)
    );

    CREATE INDEX IF NOT EXISTS idx_images_dir ON images(root, dir);
    CREATE INDEX IF NOT EXISTS idx_images_mtime ON images(mtime);
    CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_image_loras_lora ON image_loras(lora_id);
    CREATE INDEX IF NOT EXISTS idx_collection_images_image ON collection_images(image_id);
    CREATE INDEX IF NOT EXISTS idx_basket_images_image ON basket_images(image_id);
  `);

  // Additive migrations preserve existing sidecar data.
  const imageCols = db.prepare('PRAGMA table_info(images)').all().map((c) => c.name);
  if (!imageCols.includes('explicit')) {
    db.exec('ALTER TABLE images ADD COLUMN explicit INTEGER NOT NULL DEFAULT 0');
  }
  if (!imageCols.includes('rating')) {
    db.exec('ALTER TABLE images ADD COLUMN rating INTEGER NOT NULL DEFAULT 0');
  }
  if (!imageCols.includes('content_hash')) {
    db.exec("ALTER TABLE images ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
  }
  if (!imageCols.includes('perceptual_hash')) {
    db.exec("ALTER TABLE images ADD COLUMN perceptual_hash TEXT NOT NULL DEFAULT ''");
  }
  if (!imageCols.includes('trashed_at')) {
    db.exec('ALTER TABLE images ADD COLUMN trashed_at INTEGER NOT NULL DEFAULT 0');
  }
  if (!imageCols.includes('original_rel_path')) {
    db.exec("ALTER TABLE images ADD COLUMN original_rel_path TEXT NOT NULL DEFAULT ''");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_images_content_hash ON images(content_hash);
    CREATE INDEX IF NOT EXISTS idx_images_perceptual_hash ON images(perceptual_hash);
    CREATE INDEX IF NOT EXISTS idx_images_trashed_at ON images(trashed_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
      name, prompt_text, negative, notes, model,
      content='images', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS images_fts_insert AFTER INSERT ON images BEGIN
      INSERT INTO images_fts(rowid, name, prompt_text, negative, notes, model)
      VALUES (new.id, new.name, new.prompt_text, new.negative, new.notes, new.model);
    END;
    CREATE TRIGGER IF NOT EXISTS images_fts_delete AFTER DELETE ON images BEGIN
      INSERT INTO images_fts(images_fts, rowid, name, prompt_text, negative, notes, model)
      VALUES ('delete', old.id, old.name, old.prompt_text, old.negative, old.notes, old.model);
    END;
    CREATE TRIGGER IF NOT EXISTS images_fts_update AFTER UPDATE OF name, prompt_text, negative, notes, model ON images BEGIN
      INSERT INTO images_fts(images_fts, rowid, name, prompt_text, negative, notes, model)
      VALUES ('delete', old.id, old.name, old.prompt_text, old.negative, old.notes, old.model);
      INSERT INTO images_fts(rowid, name, prompt_text, negative, notes, model)
      VALUES (new.id, new.name, new.prompt_text, new.negative, new.notes, new.model);
    END;
  `);
  const imageCount = db.prepare('SELECT COUNT(*) AS count FROM images').get().count;
  const ftsCount = db.prepare('SELECT COUNT(*) AS count FROM images_fts').get().count;
  if (imageCount !== ftsCount) db.exec("INSERT INTO images_fts(images_fts) VALUES ('rebuild')");

  db.function('hamming64', (left, right) => hamming64(left, right));
  return db;
}

function hamming64(left, right) {
  if (!left || !right) return 65;
  try {
    let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
    let count = 0;
    while (bits) {
      bits &= bits - 1n;
      count += 1;
    }
    return count;
  } catch {
    return 65;
  }
}

// Older DBs have image_tags without polarity (and a narrower PK).
// Rebuilds the table, marking every existing row as positive, and returns
// true when a migration happened (caller should re-derive prompt relations
// from raw_meta so negative-prompt tags appear).
export function migrateImageTagsPolarity(db) {
  const cols = db.prepare('PRAGMA table_info(image_tags)').all().map((c) => c.name);
  if (cols.includes('polarity')) return false;
  db.exec(`
    ALTER TABLE image_tags RENAME TO image_tags_old;
    CREATE TABLE image_tags (
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      origin TEXT NOT NULL DEFAULT 'user',
      polarity TEXT NOT NULL DEFAULT 'pos',
      PRIMARY KEY (image_id, tag_id, origin, polarity)
    );
    CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag_id);
    INSERT INTO image_tags (image_id, tag_id, origin, polarity)
      SELECT image_id, tag_id, origin, 'pos' FROM image_tags_old;
    DROP TABLE image_tags_old;
  `);
  return true;
}
