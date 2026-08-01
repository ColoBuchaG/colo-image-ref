'use strict';

const $ = (sel) => document.querySelector(sel);
const SOURCE_INFO = {
  a1111: { label: 'A1111', mark: 'A' },
  cologen: { label: 'Cologen', mark: 'CO' },
  comfyui: { label: 'ComfyUI', mark: 'UI' },
  novelai: { label: 'NovelAI', mark: 'N' },
};
const state = {
  q: '',
  root: null,
  folder: null, // null = all folders
  tag: null,
  lora: null,
  collection: null,
  basket: null,
  rating: null,
  duplicates: false,
  similarTo: null,
  artistOnly: false,
  fav: false,
  trash: false,
  sort: 'mtime',
  sortDir: 'desc',
  blurExplicit: localStorage.getItem('blurExplicit') !== 'false',
  showSourceBadges: localStorage.getItem('showSourceBadges') !== 'false',
  revealedExplicit: new Set(),
  page: 1,
  pages: 1,
  items: [],
  loading: false,
  folders: [],
  collections: [],
  baskets: [],
  selectionMode: false,
  selected: new Set(),
  detailIndex: -1,
  detail: null,
};

async function api(path, opts = {}) {
  const init = { headers: {} };
  if (opts.method) init.method = opts.method;
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  if (res.status === 202) return { retry: true };
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = `toast${isErr ? ' err' : ''}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ---------- image list ---------- */

function queryString(page) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.root) p.set('root', state.root);
  if (state.folder != null) p.set('folder', state.folder);
  if (state.tag) p.set('tag', state.tag);
  if (state.lora) p.set('lora', state.lora);
  if (state.collection) p.set('collection', String(state.collection));
  if (state.basket) p.set('basket', String(state.basket));
  if (state.rating != null) p.set('rating', String(state.rating));
  if (state.duplicates) p.set('duplicates', '1');
  if (state.artistOnly) p.set('artist', '1');
  if (state.fav) p.set('fav', '1');
  if (state.trash) p.set('trash', '1');
  p.set('sort', state.sort);
  p.set('dir', state.sortDir);
  p.set('page', String(page));
  return p.toString();
}

async function loadImages(reset = false) {
  if (state.loading) return;
  state.loading = true;
  try {
    if (reset) {
      state.items = [];
      state.page = 1;
    }
    const data = state.similarTo
      ? await api(`/api/images/${state.similarTo}/similar?threshold=10&limit=200`).then((result) => ({
          items: result.items || [], total: (result.items || []).length, pages: 1,
        }))
      : await api(`/api/images?${queryString(state.page)}`);
    state.pages = data.pages;
    state.items = state.items.concat(data.items);
    renderGrid();
    renderChips();
    $('#empty').classList.toggle('hidden', data.total !== 0 || hasActiveFilters());
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.loading = false;
  }
}

function hasActiveFilters() {
  return !!(state.q || state.folder != null || state.tag || state.lora || state.collection || state.basket || state.rating != null || state.duplicates || state.similarTo || state.artistOnly || state.fav || state.trash);
}

function mediaUrl(kind, image) {
  const version = image.content_hash || image.updated_at || image.added || '';
  return `/api/${kind}/${image.id}?v=${encodeURIComponent(version)}`;
}

function renderGrid() {
  const grid = $('#grid');
  grid.textContent = '';
  const frag = document.createDocumentFragment();
  state.items.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.classList.toggle('selected', state.selected.has(item.id));
    const img = document.createElement('img');
    img.src = mediaUrl('thumb', item);
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = item.name;
    card.appendChild(img);
    const sourceInfo = SOURCE_INFO[item.source];
    if (sourceInfo && state.showSourceBadges) {
      const sourceBadge = document.createElement('div');
      sourceBadge.className = 'source-badge';
      sourceBadge.dataset.source = item.source;
      sourceBadge.title = `Source: ${sourceInfo.label}`;
      const sourceMark = document.createElement('span');
      sourceMark.className = 'source-mark';
      sourceMark.textContent = sourceInfo.mark;
      const sourceName = document.createElement('span');
      sourceName.textContent = sourceInfo.label;
      sourceBadge.append(sourceMark, sourceName);
      card.appendChild(sourceBadge);
    }
    if (item.explicit) {
      card.classList.add('explicit');
      if (state.blurExplicit && !state.revealedExplicit.has(item.id)) card.classList.add('blurred');
      const explicitBadge = document.createElement('div');
      explicitBadge.className = 'explicit-badge';
      explicitBadge.textContent = '18+';
      card.appendChild(explicitBadge);
    }
    if (item.favorite) {
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = '♥';
      card.appendChild(badge);
    }
    if (!state.trash) {
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'select-mark';
      mark.textContent = '✓';
      mark.title = state.selected.has(item.id) ? 'Remove from selection' : 'Select image';
      mark.setAttribute('aria-label', mark.title);
      mark.setAttribute('aria-pressed', String(state.selected.has(item.id)));
      mark.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleSelection(item.id);
      });
      card.appendChild(mark);
    }
    if (item.rating > 0) {
      const rating = document.createElement('div');
      rating.className = 'rating-badge';
      rating.textContent = '★'.repeat(item.rating);
      card.appendChild(rating);
    }
    const action = document.createElement('button');
    action.className = `card-action${state.trash ? ' restore' : ''}`;
    action.textContent = state.trash ? 'Restore' : 'Delete';
    action.title = state.trash ? 'Restore image' : 'Move image to Trash';
    action.addEventListener('click', async (event) => {
      event.stopPropagation();
      await runCardAction(item, i);
    });
    card.appendChild(action);
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = item.name;
    card.appendChild(label);
    card.addEventListener('click', (event) => {
      if (state.selectionMode || event.ctrlKey || event.metaKey) {
        toggleSelection(item.id);
      } else {
        openDetail(i);
      }
    });
    frag.appendChild(card);
  });
  grid.appendChild(frag);
}

async function runCardAction(item, index) {
  const restoring = state.trash;
  if (!restoring && !confirm(`Move ${item.name} to Trash?`)) return;
  try {
    await api(`/api/images/${item.id}${restoring ? '/restore' : ''}`, { method: restoring ? 'POST' : 'DELETE' });
    state.selected.delete(item.id);
    state.items.splice(index, 1);
    toast(restoring ? 'Image restored' : 'Image moved to Trash');
    renderGrid();
    loadStats();
    loadFolders();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderChips() {
  const wrap = $('#chips');
  wrap.textContent = '';
  const chips = [];
  if (state.q) chips.push({ label: `search: ${state.q}`, clear: () => { state.q = ''; $('#search').value = ''; } });
  if (state.folder != null) chips.push({ label: `folder: ${state.folder || '(root)'}`, clear: () => { state.folder = null; state.root = null; } });
  if (state.tag) chips.push({ label: `tag: ${state.tag}`, clear: () => { state.tag = null; } });
  if (state.lora) chips.push({ label: `lora: ${state.lora}`, clear: () => { state.lora = null; } });
  if (state.collection) {
    const collection = state.collections.find((item) => item.id === state.collection);
    chips.push({ label: `collection: ${collection?.name || state.collection}`, clear: () => { state.collection = null; } });
  }
  if (state.basket) {
    const basket = state.baskets.find((item) => item.id === state.basket);
    chips.push({ label: `basket: ${basket?.name || state.basket}`, clear: () => { state.basket = null; } });
  }
  if (state.rating != null) chips.push({ label: state.rating ? `rating: ${'★'.repeat(state.rating)}` : 'unrated', clear: () => { state.rating = null; $('#rating-filter').value = ''; } });
  if (state.duplicates) chips.push({ label: 'exact duplicates', clear: () => { state.duplicates = false; setNav('all'); } });
  if (state.similarTo) chips.push({ label: 'visually similar', clear: () => { state.similarTo = null; } });
  if (state.artistOnly) chips.push({ label: 'artists only', clear: () => { state.artistOnly = false; $('#artist-only').checked = false; } });
  if (state.fav) chips.push({ label: 'favorites', clear: () => setNav('all') });
  for (const c of chips) {
    const el = document.createElement('span');
    el.className = 'fchip';
    el.append(document.createTextNode(c.label));
    const x = document.createElement('button');
    x.textContent = '×';
    x.addEventListener('click', () => { c.clear(); refreshAll(); });
    el.appendChild(x);
    wrap.appendChild(el);
  }
}

function refreshAll() {
  loadFolders();
  loadCollections();
  loadBaskets();
  loadImages(true);
}

function toggleSelection(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  if (!state.selectionMode) state.selectionMode = true;
  updateSelectionUi();
  renderGrid();
}

function updateSelectionUi() {
  $('#select-mode').classList.toggle('active', state.selectionMode);
  $('#select-mode').textContent = state.selectionMode ? 'Done selecting' : 'Batch select';
  $('#bulkbar').classList.toggle('hidden', !state.selectionMode);
  $('#bulk-count').textContent = `${state.selected.size} selected`;
}

/* ---------- sidebar ---------- */

async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#stat-images').textContent = s.images;
    $('#stat-duplicates').textContent = s.duplicates || '';
    $('#stat-trash').textContent = s.trash || '';
  } catch { /* non-fatal */ }
}

async function loadFolders() {
  try {
    state.folders = await api('/api/folders');
    const ul = $('#folder-list');
    ul.textContent = '';
    for (const f of state.folders) {
      const li = document.createElement('li');
      const label = f.dir === '' ? `(root) ${shortRoot(f.root)}` : f.dir;
      li.textContent = label;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = f.count;
      li.appendChild(count);
      if (state.folder === f.dir && state.root === f.root) li.classList.add('active');
      li.title = f.dir === '' ? f.root : `${f.root}/${f.dir}`;
      li.addEventListener('click', () => {
        if (state.folder === f.dir && state.root === f.root) {
          state.folder = null;
          state.root = null;
        } else {
          state.folder = f.dir;
          state.root = f.root;
        }
        refreshAll();
      });
      ul.appendChild(li);
    }
    populateBulkOptions();
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadCollections() {
  try {
    state.collections = await api('/api/collections');
    const ul = $('#collection-list');
    ul.textContent = '';
    for (const collection of state.collections) {
      const li = document.createElement('li');
      if (state.collection === collection.id) li.classList.add('active');

      const name = document.createElement('span');
      name.className = 'collection-name';
      name.textContent = collection.name;
      li.appendChild(name);

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = collection.count;
      li.appendChild(count);

      const remove = document.createElement('button');
      remove.className = 'collection-remove';
      remove.textContent = '×';
      remove.title = 'Delete collection (images stay untouched)';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!confirm(`Delete collection “${collection.name}”? Images will not be deleted.`)) return;
        try {
          await api(`/api/collections/${collection.id}`, { method: 'DELETE' });
          if (state.collection === collection.id) state.collection = null;
          toast('Collection deleted');
          refreshAll();
        } catch (err) {
          toast(err.message, true);
        }
      });
      li.appendChild(remove);

      li.addEventListener('click', () => {
        state.collection = state.collection === collection.id ? null : collection.id;
        loadCollections();
        loadImages(true);
      });
      ul.appendChild(li);
    }
    populateBulkOptions();
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadBaskets() {
  try {
    state.baskets = await api('/api/baskets');
    const ul = $('#basket-list');
    ul.textContent = '';
    for (const basket of state.baskets) {
      const li = document.createElement('li');
      if (state.basket === basket.id) li.classList.add('active');
      const name = document.createElement('span');
      name.className = 'collection-name';
      name.textContent = basket.name;
      li.appendChild(name);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = basket.count;
      li.appendChild(count);

      const download = document.createElement('button');
      download.className = 'basket-export';
      download.textContent = '⇩';
      download.title = 'Download basket as ZIP';
      download.disabled = basket.count === 0;
      download.addEventListener('click', (event) => {
        event.stopPropagation();
        window.location.href = `/api/baskets/${basket.id}/export`;
      });
      li.appendChild(download);

      const remove = document.createElement('button');
      remove.className = 'collection-remove';
      remove.textContent = '×';
      remove.title = 'Delete basket (images stay untouched)';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!confirm(`Delete basket “${basket.name}”? Images will not be deleted.`)) return;
        try {
          await api(`/api/baskets/${basket.id}`, { method: 'DELETE' });
          if (state.basket === basket.id) state.basket = null;
          toast('Basket deleted');
          refreshAll();
        } catch (err) {
          toast(err.message, true);
        }
      });
      li.appendChild(remove);
      li.addEventListener('click', () => {
        state.basket = state.basket === basket.id ? null : basket.id;
        loadBaskets();
        loadImages(true);
      });
      ul.appendChild(li);
    }
    populateBulkOptions();
  } catch (err) {
    toast(err.message, true);
  }
}

function populateBulkOptions() {
  const fill = (selector, placeholder, items, label) => {
    const select = $(selector);
    const value = select.value;
    select.textContent = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = placeholder;
    select.appendChild(first);
    for (const item of items) {
      const option = document.createElement('option');
      option.value = String(item.id ?? item.dir);
      option.textContent = label(item);
      select.appendChild(option);
    }
    if ([...select.options].some((option) => option.value === value)) select.value = value;
  };
  fill('#bulk-collection', 'Add to collection…', state.collections, (item) => item.name);
  fill('#bulk-basket', 'Add to basket…', state.baskets, (item) => item.name);
  const root = state.root || state.folders[0]?.root;
  const folders = root ? state.folders.filter((item) => item.root === root) : [];
  fill('#bulk-move', 'Move to folder…', folders.map((item) => ({ id: `folder:${item.dir}`, dir: item.dir })), (item) => item.dir || '(root)');
}

function shortRoot(root) {
  const parts = root.split('/').filter(Boolean);
  return parts[parts.length - 1] || root;
}

function setNav(which) {
  state.fav = which === 'fav';
  state.duplicates = which === 'duplicates';
  state.trash = which === 'trash';
  if (state.trash) {
    state.root = null;
    state.folder = null;
    state.similarTo = null;
    state.selectionMode = false;
    state.selected.clear();
  }
  $('#select-mode').disabled = state.trash;
  updateSelectionUi();
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === which);
  });
}

function bindSuggest(inputSel, listSel, endpoint, onPick) {
  const input = $(inputSel);
  const list = $(listSel);
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) {
        list.classList.add('hidden');
        return;
      }
      try {
        const items = await api(`${endpoint}?q=${encodeURIComponent(q)}&limit=12`);
        list.textContent = '';
        for (const it of items) {
          const li = document.createElement('li');
          li.textContent = it.name;
          if (it.is_artist) {
            const star = document.createElement('span');
            star.className = 'star';
            star.textContent = ' ★';
            li.appendChild(star);
          }
          const count = document.createElement('span');
          count.className = 'count';
          count.textContent = it.count;
          li.appendChild(count);
          li.addEventListener('click', () => {
            onPick(it.name);
            input.value = '';
            list.classList.add('hidden');
            refreshAll();
          });
          list.appendChild(li);
        }
        list.classList.toggle('hidden', items.length === 0);
      } catch { /* non-fatal */ }
    }, 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      onPick(input.value.trim());
      input.value = '';
      list.classList.add('hidden');
      refreshAll();
    }
  });
  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) list.classList.add('hidden');
  });
}

/* ---------- detail overlay ---------- */

/* ---------- zoom & pan (detail overlay) ---------- */

const zoom = { s: 1 };

function resetZoom() {
  zoom.s = 1;
  const img = $('#overlay-img');
  const wrap = $('#overlay-img-wrap');
  img.style.width = '';
  img.style.maxWidth = '';
  img.style.maxHeight = '';
  wrap.classList.remove('zoomed');
  wrap.scrollLeft = 0;
  wrap.scrollTop = 0;
}

// Size the image would have at "fit" (scale 1) inside the wrap.
function fitSize() {
  const img = $('#overlay-img');
  const wrap = $('#overlay-img-wrap');
  const w = wrap.clientWidth - 36;
  const h = wrap.clientHeight - 36;
  const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  return { w: img.naturalWidth * s, h: img.naturalHeight * s };
}

// Zoom so the image point under the cursor stays under the cursor.
function zoomAt(clientX, clientY, targetScale) {
  const img = $('#overlay-img');
  const wrap = $('#overlay-img-wrap');
  if (!img.naturalWidth) return;
  const s = Math.min(12, Math.max(1, targetScale));
  if (s === 1) {
    resetZoom();
    return;
  }
  const cur = img.getBoundingClientRect();
  const rx = (clientX - cur.left) / cur.width;
  const ry = (clientY - cur.top) / cur.height;
  const fit = fitSize();
  const newW = fit.w * s;
  const newH = fit.h * s;
  zoom.s = s;
  wrap.classList.add('zoomed');
  img.style.width = `${newW}px`;
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  const wrect = wrap.getBoundingClientRect();
  wrap.scrollLeft = rx * newW - (clientX - wrect.left);
  wrap.scrollTop = ry * newH - (clientY - wrect.top);
}

function bindZoom() {
  const img = $('#overlay-img');
  const wrap = $('#overlay-img-wrap');
  wrap.addEventListener('wheel', (e) => {
    if (state.detailIndex < 0) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, zoom.s * (e.deltaY < 0 ? 1.25 : 0.8));
  }, { passive: false });
  img.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (zoom.s > 1) resetZoom();
    else zoomAt(e.clientX, e.clientY, 2.5);
  });
  let drag = null;
  img.addEventListener('pointerdown', (e) => {
    if (zoom.s <= 1) return;
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
    img.classList.add('dragging');
    img.setPointerCapture(e.pointerId);
  });
  img.addEventListener('pointermove', (e) => {
    if (!drag) return;
    wrap.scrollLeft = drag.sl - (e.clientX - drag.x);
    wrap.scrollTop = drag.st - (e.clientY - drag.y);
  });
  const endDrag = () => {
    drag = null;
    img.classList.remove('dragging');
  };
  img.addEventListener('pointerup', endDrag);
  img.addEventListener('pointercancel', endDrag);
}

async function openDetail(index) {
  if (index < 0 || index >= state.items.length) return;
  state.detailIndex = index;
  try {
    state.detail = await api(`/api/images/${state.items[index].id}`);
    resetZoom();
    renderDetail();
    $('#overlay').classList.remove('hidden');
  } catch (err) {
    toast(err.message, true);
  }
}

function closeDetail() {
  state.detailIndex = -1;
  state.detail = null;
  resetZoom();
  $('#overlay').classList.add('hidden');
  $('#overlay-img').src = '';
}

function applyDetailBlur() {
  const d = state.detail;
  const blurred = Boolean(d?.explicit && state.blurExplicit && !state.revealedExplicit.has(d.id));
  $('#overlay-img-wrap').classList.toggle('explicit-blurred', blurred);
  $('#p-reveal').classList.toggle('hidden', !blurred);
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  $('#overlay-img').src = mediaUrl('file', d);
  $('#p-name').textContent = d.name;
  const kb = d.size > 1024 * 1024 ? `${(d.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(d.size / 1024)} KB`;
  $('#p-sub').textContent = `${d.dir || '(root)'} · ${d.width || '?'}×${d.height || '?'} · ${kb}`;
  $('#p-fav').textContent = d.favorite ? '♥' : '♡';
  $('#p-fav').classList.toggle('on', !!d.favorite);
  $('#p-explicit').checked = Boolean(d.explicit);
  $('#p-delete').textContent = d.trashed_at ? 'Restore image' : 'Move to Trash';
  $('#p-delete').classList.toggle('danger', !d.trashed_at);
  $('#p-delete').classList.toggle('restore-action', Boolean(d.trashed_at));
  $('#p-move').closest('.p-block').classList.toggle('hidden', Boolean(d.trashed_at));
  applyDetailBlur();
  const srcEl = $('#p-src');
  srcEl.textContent = SOURCE_INFO[d.source]?.label || d.source || '';
  srcEl.dataset.source = d.source || '';
  srcEl.classList.toggle('hidden', !d.source);
  $('#p-prompt').textContent = d.prompt_text || '';
  $('#p-neg-block').classList.toggle('hidden', !d.negative);
  $('#p-negative').textContent = d.negative || '';

  const stats = $('#p-stats');
  stats.textContent = '';
  const rows = [
    ['model', d.model], ['seed', d.seed], ['steps', d.steps],
    ['cfg', d.cfg], ['sampler', d.sampler],
  ].filter(([, v]) => v != null && v !== '');
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    stats.append(dt, dd);
  }
  $('#p-stats-block').classList.toggle('hidden', rows.length === 0);

  const ratingWrap = $('#p-rating');
  ratingWrap.textContent = '';
  for (let value = 1; value <= 5; value += 1) {
    const star = document.createElement('button');
    star.type = 'button';
    star.textContent = '★';
    star.classList.toggle('on', value <= (d.rating || 0));
    star.title = value === d.rating ? 'Clear rating' : `Rate ${value}`;
    star.addEventListener('click', () => setDetailRating(value === d.rating ? 0 : value));
    ratingWrap.appendChild(star);
  }

  const loraWrap = $('#p-loras');
  loraWrap.textContent = '';
  for (const l of d.loras) {
    const chip = document.createElement('span');
    chip.className = 'tchip';
    chip.textContent = l.name;
    if (l.weight != null) {
      const w = document.createElement('span');
      w.className = 'w';
      w.textContent = ` ${l.weight}`;
      chip.appendChild(w);
    }
    chip.title = 'Filter by this LoRA';
    chip.addEventListener('click', () => {
      state.lora = l.name;
      closeDetail();
      refreshAll();
    });
    loraWrap.appendChild(chip);
  }
  $('#p-lora-block').classList.toggle('hidden', d.loras.length === 0);

  const posTags = d.tags.filter((t) => t.polarity !== 'neg');
  const negTags = d.tags.filter((t) => t.polarity === 'neg');
  const tagWrap = $('#p-tags');
  tagWrap.textContent = '';
  for (const t of posTags) tagWrap.appendChild(makeTagChip(t, d));
  $('#p-tag-block').classList.toggle('hidden', posTags.length === 0);
  const negWrap = $('#p-neg-tags');
  negWrap.textContent = '';
  for (const t of negTags) negWrap.appendChild(makeTagChip(t, d));
  $('#p-neg-tag-block').classList.toggle('hidden', negTags.length === 0);

  $('#p-source').value = d.source_url || '';
  $('#p-notes').value = d.notes || '';

  const collectionWrap = $('#p-collections');
  collectionWrap.textContent = '';
  const selectedCollections = new Set((d.collections || []).map((collection) => collection.id));
  if (state.collections.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'hint';
    empty.textContent = 'Create a collection from the sidebar first.';
    collectionWrap.appendChild(empty);
  } else {
    for (const collection of state.collections) {
      const label = document.createElement('label');
      label.className = 'collection-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(collection.id);
      input.checked = selectedCollections.has(collection.id);
      input.addEventListener('change', saveDetailCollections);
      label.append(input, document.createTextNode(collection.name));
      collectionWrap.appendChild(label);
    }
  }

  const basketWrap = $('#p-baskets');
  basketWrap.textContent = '';
  const selectedBaskets = new Set((d.baskets || []).map((basket) => basket.id));
  if (state.baskets.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'hint';
    empty.textContent = 'Create an export basket from the sidebar first.';
    basketWrap.appendChild(empty);
  } else {
    for (const basket of state.baskets) {
      const label = document.createElement('label');
      label.className = 'collection-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(basket.id);
      input.checked = selectedBaskets.has(basket.id);
      input.addEventListener('change', () => saveDetailBasket(basket.id, input.checked));
      label.append(input, document.createTextNode(basket.name));
      basketWrap.appendChild(label);
    }
  }

  const move = $('#p-move');
  move.textContent = '';
  const dirs = state.folders.filter((f) => f.root === d.root);
  for (const f of dirs) {
    const opt = document.createElement('option');
    opt.value = f.dir;
    opt.textContent = f.dir === '' ? '(root)' : f.dir;
    if (f.dir === d.dir) opt.selected = true;
    move.appendChild(opt);
  }
}

async function saveDetailCollections() {
  const d = state.detail;
  if (!d) return;
  const collectionIds = [...document.querySelectorAll('#p-collections input:checked')]
    .map((input) => Number(input.value));
  try {
    state.detail = await api(`/api/images/${d.id}`, { method: 'PATCH', body: { collection_ids: collectionIds } });
    toast('Collections saved');
    await loadCollections();
    renderDetail();
    if (state.collection) loadImages(true);
  } catch (err) {
    toast(err.message, true);
    renderDetail();
  }
}

async function setDetailRating(rating) {
  if (!state.detail) return;
  try {
    state.detail = await api(`/api/images/${state.detail.id}`, { method: 'PATCH', body: { rating } });
    const item = state.items[state.detailIndex];
    if (item) item.rating = state.detail.rating;
    renderDetail();
    renderGrid();
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveDetailBasket(basketId, add) {
  if (!state.detail) return;
  try {
    await api('/api/bulk', {
      method: 'POST',
      body: { ids: [state.detail.id], action: add ? 'basket-add' : 'basket-remove', basket_id: basketId },
    });
    state.detail = await api(`/api/images/${state.detail.id}`);
    await loadBaskets();
    renderDetail();
  } catch (err) {
    toast(err.message, true);
    renderDetail();
  }
}

function makeTagChip(t, d) {
  const chip = document.createElement('span');
  chip.className = `tchip${t.is_artist ? ' artist' : ''}${t.origin === 'user' ? ' user' : ''}${t.polarity === 'neg' ? ' neg' : ''}`;
  chip.textContent = t.name;
  chip.title = t.origin === 'user' ? 'Your tag' : t.polarity === 'neg' ? 'From negative prompt' : 'From prompt';
  chip.addEventListener('click', () => {
    state.tag = t.name;
    closeDetail();
    refreshAll();
  });
  const star = document.createElement('button');
  star.className = `star${t.is_artist ? ' on' : ''}`;
  star.textContent = t.is_artist ? '★' : '☆';
  star.title = 'Toggle artist tag';
  star.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await api(`/api/tags/${t.id}/artist`, { method: 'POST', body: { is_artist: t.is_artist ? 0 : 1 } });
      t.is_artist = t.is_artist ? 0 : 1;
      chip.classList.toggle('artist', !!t.is_artist);
      star.classList.toggle('on', !!t.is_artist);
      star.textContent = t.is_artist ? '★' : '☆';
    } catch (err) {
      toast(err.message, true);
    }
  });
  chip.appendChild(star);
  if (t.origin === 'user') {
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Remove tag';
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        state.detail = await api(`/api/images/${d.id}`, { method: 'PATCH', body: { remove_tags: [t.name] } });
        renderDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
    chip.appendChild(x);
  }
  return chip;
}

async function toggleFav() {
  const d = state.detail;
  if (!d) return;
  try {
    state.detail = await api(`/api/images/${d.id}`, { method: 'PATCH', body: { favorite: d.favorite ? 0 : 1 } });
    renderDetail();
    const item = state.items[state.detailIndex];
    if (item) item.favorite = state.detail.favorite;
  } catch (err) {
    toast(err.message, true);
  }
}

function bindDetailEvents() {
  bindZoom();
  $('#p-reveal').addEventListener('click', (event) => {
    event.stopPropagation();
    if (!state.detail) return;
    state.revealedExplicit.add(state.detail.id);
    applyDetailBlur();
    renderGrid();
  });
  $('#overlay').addEventListener('click', (e) => {
    if (e.target.id === 'overlay' || e.target.id === 'overlay-img-wrap') closeDetail();
  });
  $('#p-fav').addEventListener('click', toggleFav);
  $('#p-explicit').addEventListener('change', async () => {
    const d = state.detail;
    if (!d) return;
    try {
      state.detail = await api(`/api/images/${d.id}`, {
        method: 'PATCH',
        body: { explicit: $('#p-explicit').checked ? 1 : 0 },
      });
      if (!state.detail.explicit) state.revealedExplicit.delete(d.id);
      const item = state.items[state.detailIndex];
      if (item) item.explicit = state.detail.explicit;
      renderDetail();
      renderGrid();
      loadStats();
      toast(state.detail.explicit ? 'Marked explicit' : 'Explicit mark removed');
    } catch (err) {
      toast(err.message, true);
      renderDetail();
    }
  });
  $('#p-copy').addEventListener('click', async () => {
    const text = state.detail ? state.detail.prompt_text : '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('Prompt copied');
    } catch {
      toast('Copy failed', true);
    }
  });
  $('#p-similar').addEventListener('click', () => {
    if (!state.detail) return;
    state.similarTo = state.detail.id;
    closeDetail();
    loadImages(true);
  });
  $('#p-add-tag').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const name = e.target.value.trim();
    if (!name || !state.detail) return;
    e.target.value = '';
    try {
      state.detail = await api(`/api/images/${state.detail.id}`, { method: 'PATCH', body: { add_tags: [name] } });
      renderDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#p-source').addEventListener('blur', async () => {
    if (!state.detail || $('#p-source').value === (state.detail.source_url || '')) return;
    try {
      await api(`/api/images/${state.detail.id}`, { method: 'PATCH', body: { source_url: $('#p-source').value.trim() } });
      toast('Source saved');
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#p-notes').addEventListener('blur', async () => {
    if (!state.detail || $('#p-notes').value === (state.detail.notes || '')) return;
    try {
      await api(`/api/images/${state.detail.id}`, { method: 'PATCH', body: { notes: $('#p-notes').value } });
      toast('Notes saved');
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#p-move').addEventListener('change', async () => {
    const d = state.detail;
    if (!d || $('#p-move').value === d.dir) return;
    try {
      state.detail = await api(`/api/images/${d.id}/move`, { method: 'POST', body: { dir: $('#p-move').value } });
      toast(`Moved to ${state.detail.dir || '(root)'}`);
      renderDetail();
      loadFolders();
    } catch (err) {
      toast(err.message, true);
      renderDetail();
    }
  });
  $('#p-delete').addEventListener('click', deleteDetail);
  async function deleteDetail() {
    const d = state.detail;
    if (!d) return;
    const restoring = Boolean(d.trashed_at);
    if (!restoring && !confirm(`Move ${d.name} to Trash?`)) return;
    try {
      await api(`/api/images/${d.id}${restoring ? '/restore' : ''}`, { method: restoring ? 'POST' : 'DELETE' });
      state.items.splice(state.detailIndex, 1);
      toast(restoring ? 'Image restored' : 'Image moved to Trash');
      closeDetail();
      renderGrid();
      loadStats();
      loadFolders();
    } catch (err) {
      toast(err.message, true);
    }
  }
  document.addEventListener('keydown', (e) => {
    if (state.detailIndex < 0) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape') closeDetail();
    else if (!typing && e.key === 'ArrowRight') openDetail(state.detailIndex + 1);
    else if (!typing && e.key === 'ArrowLeft') openDetail(state.detailIndex - 1);
    else if (!typing && (e.key === 'f' || e.key === 'F')) toggleFav();
  });
}

/* ---------- header / settings ---------- */

function bindHeader() {
  let timer = null;
  $('#search').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = $('#search').value.trim();
      loadImages(true);
    }, 150);
  });
  $('#select-mode').addEventListener('click', () => {
    if (state.trash) return;
    state.selectionMode = !state.selectionMode;
    if (!state.selectionMode) state.selected.clear();
    updateSelectionUi();
    renderGrid();
  });
  $('#sort').addEventListener('change', () => {
    [state.sort, state.sortDir] = $('#sort').value.split(':');
    loadImages(true);
  });
  $('#rescan').addEventListener('click', async () => {
    try {
      const res = await api('/api/scan', { method: 'POST' });
      toast(`Scan: +${res.added} new, ~${res.updated} updated, −${res.removed} removed`);
      loadStats();
      refreshAll();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#settings-btn').addEventListener('click', async () => {
    const pop = $('#settings-pop');
    if (pop.classList.contains('hidden')) {
      try {
        const cfg = await api('/api/config');
        $('#roots-edit').value = cfg.roots.join('\n');
      } catch { /* keep previous */ }
    }
    pop.classList.toggle('hidden');
  });
  $('#roots-cancel').addEventListener('click', () => $('#settings-pop').classList.add('hidden'));
  $('#roots-save').addEventListener('click', async () => {
    const roots = $('#roots-edit').value.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      const res = await api('/api/config', { method: 'PUT', body: { roots } });
      toast(`Roots saved. Scan: +${res.scan.added} −${res.scan.removed}`);
      $('#settings-pop').classList.add('hidden');
      loadStats();
      refreshAll();
    } catch (err) {
      toast(err.message, true);
    }
  });
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.addEventListener('click', () => {
      setNav(b.dataset.nav);
      loadImages(true);
    });
  });
  $('#artist-only').addEventListener('change', () => {
    state.artistOnly = $('#artist-only').checked;
    loadImages(true);
  });
  $('#rating-filter').addEventListener('change', () => {
    state.rating = $('#rating-filter').value === '' ? null : Number($('#rating-filter').value);
    loadImages(true);
  });
  $('#blur-explicit').addEventListener('change', () => {
    state.blurExplicit = $('#blur-explicit').checked;
    localStorage.setItem('blurExplicit', String(state.blurExplicit));
    renderGrid();
    applyDetailBlur();
  });
  $('#show-source-badges').addEventListener('change', () => {
    state.showSourceBadges = $('#show-source-badges').checked;
    localStorage.setItem('showSourceBadges', String(state.showSourceBadges));
    renderGrid();
  });
  $('#new-folder').addEventListener('click', async () => {
    const dir = prompt('New folder path (relative to a root), e.g. "poses/hands":');
    if (!dir) return;
    try {
      const body = { dir };
      if (state.root) body.root = state.root;
      await api('/api/folders', { method: 'POST', body });
      toast('Folder created');
      loadFolders();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#new-collection').addEventListener('click', async () => {
    const name = prompt('Collection name, e.g. “Fiera species” or “Training candidates”:');
    if (!name?.trim()) return;
    try {
      await api('/api/collections', { method: 'POST', body: { name: name.trim() } });
      toast('Collection created');
      loadCollections();
      if (state.detail) {
        state.collections = await api('/api/collections');
        renderDetail();
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#new-basket').addEventListener('click', async () => {
    const name = prompt('Basket name, e.g. “July training export”:');
    if (!name?.trim()) return;
    try {
      await api('/api/baskets', { method: 'POST', body: { name: name.trim() } });
      toast('Basket created');
      loadBaskets();
      if (state.detail) {
        state.baskets = await api('/api/baskets');
        renderDetail();
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
  bindBulkActions();
}

function bindBulkActions() {
  $('#bulk-loaded').addEventListener('click', () => {
    const loaded = state.items.map((item) => item.id);
    const allSelected = loaded.length > 0 && loaded.every((id) => state.selected.has(id));
    for (const id of loaded) allSelected ? state.selected.delete(id) : state.selected.add(id);
    updateSelectionUi();
    renderGrid();
  });
  $('#bulk-clear').addEventListener('click', () => {
    state.selected.clear();
    state.selectionMode = false;
    updateSelectionUi();
    renderGrid();
  });
  $('#bulk-favorite').addEventListener('click', () => runBulk({ action: 'favorite', value: 1 }, 'Favorited'));
  $('#bulk-explicit').addEventListener('click', () => runBulk({ action: 'explicit', value: 1 }, 'Marked explicit'));
  $('#bulk-rating').addEventListener('change', async () => {
    const value = $('#bulk-rating').value;
    if (value === '') return;
    await runBulk({ action: 'rating', value: Number(value) }, 'Rating updated');
    $('#bulk-rating').value = '';
  });
  $('#bulk-collection').addEventListener('change', async () => {
    const value = Number($('#bulk-collection').value);
    if (!value) return;
    await runBulk({ action: 'collection-add', collection_id: value }, 'Added to collection');
    $('#bulk-collection').value = '';
  });
  $('#bulk-basket').addEventListener('change', async () => {
    const value = Number($('#bulk-basket').value);
    if (!value) return;
    await runBulk({ action: 'basket-add', basket_id: value }, 'Added to basket');
    $('#bulk-basket').value = '';
  });
  $('#bulk-move').addEventListener('change', async () => {
    const value = $('#bulk-move').value;
    if (!value.startsWith('folder:')) return;
    await runBulk({ action: 'move', dir: value.slice(7) }, 'Images moved');
    $('#bulk-move').value = '';
  });
  $('#bulk-delete').addEventListener('click', async () => {
    if (!state.selected.size) return;
    if (!confirm(`Move ${state.selected.size} selected image(s) to Trash?`)) return;
    await runBulk({ action: 'delete', confirm: true }, 'Images moved to Trash');
  });
}

async function runBulk(operation, successMessage) {
  const ids = [...state.selected];
  if (!ids.length) {
    toast('Select at least one image', true);
    return false;
  }
  try {
    const result = await api('/api/bulk', { method: 'POST', body: { ids, ...operation } });
    toast(`${successMessage}: ${result.updated}`);
    state.selected.clear();
    state.selectionMode = false;
    updateSelectionUi();
    loadStats();
    refreshAll();
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

/* ---------- drag & drop upload ---------- */

function bindDrop() {
  const hint = $('#drophint');
  let dragDepth = 0;

  const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth += 1;
    const target = state.folder != null
      ? `${state.root ? shortRoot(state.root) : 'root'}:${state.folder || '(root)'}`
      : 'library root';
    $('#drophint-target').textContent = `→ ${target}`;
    hint.classList.remove('hidden');
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hint.classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (isFileDrag(e)) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    hint.classList.add('hidden');
    const files = [...e.dataTransfer.files].filter((f) => /\.(png|jpe?g)$/i.test(f.name));
    if (!files.length) {
      toast('Only PNG/JPG images can be added', true);
      return;
    }
    let added = 0;
    let failed = 0;
    for (const file of files) {
      try {
        const params = new URLSearchParams({ name: file.name });
        if (state.folder != null) {
          params.set('dir', state.folder);
          if (state.root) params.set('root', state.root);
        }
        const res = await fetch(`/api/upload?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: await file.arrayBuffer(),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error((data && data.error) || `HTTP ${res.status}`);
        }
        added += 1;
      } catch (err) {
        failed += 1;
        toast(`${file.name}: ${err.message}`, true);
      }
    }
    if (added) toast(`Added ${added} image${added > 1 ? 's' : ''} — metadata parsed`);
    if (!added && failed) toast('Upload failed', true);
    loadStats();
    loadFolders();
    loadImages(true);
  });
}

/* ---------- init ---------- */

function init() {
  $('#blur-explicit').checked = state.blurExplicit;
  $('#show-source-badges').checked = state.showSourceBadges;
  updateSelectionUi();
  bindHeader();
  bindDetailEvents();
  bindDrop();
  bindSuggest('#tag-input', '#tag-suggest', '/api/tags', (name) => { state.tag = name; });
  bindSuggest('#lora-input', '#lora-suggest', '/api/loras', (name) => { state.lora = name; });

  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !state.loading && state.page < state.pages) {
      state.page += 1;
      loadImages();
    }
  });
  observer.observe($('#sentinel'));

  loadStats();
  loadFolders();
  loadCollections();
  loadBaskets();
  loadImages(true);
}

init();
