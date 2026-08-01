# Colo Image Ref
## Note: most of this repository is vibecoded because I have more free tokens than time


For complete installation and use instructions, read the
[user guide](USER-GUIDE.md).

Colo Image Ref is a local gallery for organizing AI image references from ComfyUI, A1111, NovelAI, and Cologen PNGs,
plus A1111-style JPEGs.
Browse thumbnails, sort images into real folders, and keep prompt / tags / LoRAs /
artist flags / source URLs / notes in a sidecar SQLite DB.

Image files are **never modified** — embedded metadata is only read.

## Run

```sh
npm start          # http://localhost:4780
npm run dev        # auto-restart on changes
npm run check      # syntax check
npm run smoke      # end-to-end smoke test (uses a temp dir, no real data)
```

The server binds to `127.0.0.1` by default. To expose it deliberately on your
local network, run `HOST=0.0.0.0 npm start`. There is no built-in authentication,
so do not expose it directly to the public internet.

## Share safely

Do **not** archive the working directory: `data/` contains the configured library
paths, the sidecar database, and generated thumbnails. Build a privacy-safe source
archive with `npm pack`; the package allowlist includes only the application source
and documentation.

## Configure

Library roots (folders that get scanned) live in `data/config.json` and can be
edited from the UI via the **Folders** button. New installations default to
`~/Pictures/Colo Image Ref`.

- Drag & drop PNG/JPG files anywhere into the browser window to add them (they land
  in the currently selected folder, or the library root). Metadata is parsed
  immediately on upload. You can also copy files into a root and hit **Rescan**.
- A1111 `parameters`, ComfyUI `prompt`, NovelAI `Comment`/`Description`, and
  Cologen `cologen` PNG chunks are parsed automatically. NovelAI metadata hidden
  in alpha/RGB pixel bits (`stealth_*info` and compressed `stealth_*comp`) is
  decoded as well, including GZIP, zlib, and raw-DEFLATE payloads. ComfyUI parsing follows
  terminal sampler/detailer stages so hires and face/eye passes retain the
  correct positive and negative conditioning.
- Tags are split by origin: positive-prompt tags and negative-prompt tags are
  shown in separate sections (negative tags are styled red).
- Collections are virtual, sidecar-only groups. An image can belong to multiple
  collections without being copied or moved, while physical folders continue to
  control the file's real disk location.
- Images can be manually marked explicit. With **blur explicit images** enabled,
  their thumbnails and full preview stay blurred until revealed. The preference
  is stored in the browser; the explicit mark is stored in SQLite.
- Star any tag to mark it as an artist tag; filter the grid by tag, LoRA, artist,
  collection, folder, favorites, or free-text search.
- Search uses SQLite FTS5 prefix indexes across filenames, prompts, negatives,
  notes, and models, while also matching sidecar tags, LoRAs, and collections.
- Directory watchers automatically trigger a debounced incremental rescan when
  files or folders change; the Rescan button remains available for manual checks.
  `POST /api/scan?force=1` safely refreshes metadata for unchanged files after a
  parser upgrade without rewriting source files or recalculating existing hashes.
- Ratings are stored from 0–5 stars and can be assigned individually or in bulk.
- Select mode supports bulk favorite/explicit/rating changes, adding to collections
  or baskets, moving files, and confirmed moves to Trash.
- Images can be sorted by modified date, added date, filename, or rating. Delete
  actions move files into a hidden `.image-ref-trash` folder within their library
  root, preserving all sidecar data; the Trash view can restore them.
- Exact duplicates are detected with SHA-256. Visually similar images use a compact
  64-bit perceptual difference hash; hashes are calculated only for new or changed files.
- Baskets are saved task-oriented selections, separate from permanent collections.
  They can be filtered in the sidebar and exported as ZIP files without copying or
  modifying originals in the library.
- Detail view supports zoom: mouse wheel zooms at the cursor, drag to pan,
  double-click toggles zoom.
- "Move to folder" in the detail panel physically moves the file inside its root.

Thumbnails and perceptual hashes use ffmpeg. Basket export uses the system `zip`
command. Requires Node >= 22 (built-in `node:sqlite`, no npm dependencies).
