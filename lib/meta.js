// Parse embedded generation metadata: A1111 "parameters" text, ComfyUI
// "prompt" graph JSON, NovelAI "Comment"/"Description" chunks, and cologen
// (GPT Image Browser) "cologen" JSON. Pure functions, no I/O.

const LORA_RE = /<lora:([^:>]+)(?::([^>]*))?>/g;
const RAW_CAP = 200_000;

// texts: { key: value } from PNG chunks, or { parameters: exifText } from JPEG.
export function extractFromChunks(texts) {
  const out = {
    prompt_text: '', negative: '', model: '', seed: '',
    steps: null, cfg: null, sampler: '', size: '',
    source: '', loras: [], raw: {},
  };
  if (!texts || typeof texts !== 'object') return out;

  for (const [k, v] of Object.entries(texts)) {
    out.raw[k] = typeof v === 'string' && v.length > RAW_CAP ? v.slice(0, RAW_CAP) : v;
  }

  let positive = '';
  let negative = '';
  let settings = {};

  if (typeof texts.parameters === 'string' && texts.parameters.trim()) {
    ({ positive, negative, settings } = parseA1111(texts.parameters));
    out.source = 'a1111';
  } else if (typeof texts.prompt === 'string' && texts.prompt.trim()) {
    const comfy = parseComfy(texts.prompt);
    positive = comfy.positive;
    negative = comfy.negative;
    if (comfy.model) settings.Model = comfy.model;
    if (comfy.seed != null) settings.Seed = String(comfy.seed);
    if (comfy.steps != null) settings.Steps = String(comfy.steps);
    if (comfy.cfg != null) settings['CFG scale'] = String(comfy.cfg);
    if (comfy.sampler) settings.Sampler = comfy.sampler;
    out.loras.push(...comfy.loras);
    out.source = 'comfyui';
  } else if (isNaiChunks(texts)) {
    const nai = parseNai(texts);
    positive = nai.positive;
    negative = nai.negative;
    settings = nai.settings;
    out.source = 'novelai';
  } else if (typeof texts.cologen === 'string' && texts.cologen.trim()) {
    const colo = parseCologen(texts.cologen);
    positive = colo.positive;
    settings = colo.settings;
    out.source = 'cologen';
  }

  out.prompt_text = positive.trim();
  out.negative = negative.trim();
  out.model = settings.Model || '';
  out.seed = settings.Seed != null ? String(settings.Seed) : '';
  out.sampler = settings.Sampler || '';
  out.size = settings.Size || '';

  if (settings.Steps != null && settings.Steps !== '') {
    const n = parseInt(settings.Steps, 10);
    if (Number.isFinite(n)) out.steps = n;
  }
  const cfgRaw = settings['CFG scale'] ?? settings.cfg;
  if (cfgRaw != null && cfgRaw !== '') {
    const n = parseFloat(cfgRaw);
    if (Number.isFinite(n)) out.cfg = n;
  }

  out.loras.push(...lorasFromText(out.prompt_text));
  out.loras = dedupeLoras(out.loras);
  return out;
}

// Identify which generator wrote these chunks without fully parsing them.
export function detectSource(texts) {
  if (!texts || typeof texts !== 'object') return '';
  if (typeof texts.parameters === 'string' && texts.parameters.trim()) return 'a1111';
  if (typeof texts.prompt === 'string' && texts.prompt.trim()) return 'comfyui';
  if (isNaiChunks(texts)) return 'novelai';
  if (typeof texts.cologen === 'string' && texts.cologen.trim()) return 'cologen';
  return '';
}

export function parseA1111(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');

  // The settings line is the last non-empty line, if it looks like "Key: value, Key: value".
  let settingsIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^[A-Za-z][A-Za-z _]*:\s*\S/.test(l) && /,\s*[A-Za-z][A-Za-z _]*:/.test(l)) {
      settingsIdx = i;
    }
    break;
  }

  const settings = {};
  let body = lines.join('\n');
  if (settingsIdx >= 0) {
    const settingsLine = lines[settingsIdx];
    body = lines.slice(0, settingsIdx).join('\n');
    // Values may contain commas as long as the comma isn't followed by "Key:".
    for (const m of settingsLine.matchAll(/([^,:]+):\s*((?:[^,]|,(?!\s*[A-Za-z_ ]+:))*)/g)) {
      settings[m[1].trim()] = m[2].trim();
    }
  }

  let positive = body;
  let negative = '';
  const negMatch = body.match(/\nNegative prompt:\s?/);
  if (negMatch) {
    positive = body.slice(0, negMatch.index);
    negative = body.slice(negMatch.index + negMatch[0].length);
  } else if (/^Negative prompt:\s?/.test(body)) {
    positive = '';
    negative = body.replace(/^Negative prompt:\s?/, '');
  }
  return { positive, negative, settings };
}

export function parseComfy(jsonText) {
  const out = { positive: '', negative: '', model: '', seed: null, steps: null, cfg: null, sampler: '', loras: [] };
  let graph;
  try {
    graph = JSON.parse(jsonText);
  } catch {
    return out;
  }
  if (!graph || typeof graph !== 'object') return out;

  const entries = Object.entries(graph).filter(([, node]) => node && typeof node === 'object');
  const byId = new Map(entries.map(([id, node]) => [String(id), node]));
  const idByNode = new Map(entries.map(([id, node]) => [node, String(id)]));
  const nodes = entries.map(([, node]) => node);

  const follow = (ref) => {
    if (!Array.isArray(ref) || ref.length === 0) return null;
    const node = byId.get(String(ref[0]));
    return node && typeof node === 'object' ? node : null;
  };

  // Resolve the text feeding a conditioning input: direct CLIPTextEncode,
  // or through pass-through wrappers (styles, zero-outs, etc).
  const textOf = (node, depth = 0) => {
    if (!node || depth > 6) return '';
    const inp = node.inputs || {};
    if (typeof inp.text === 'string') return inp.text;
    // text may be a link to a string-producing node (e.g. LoraTagLoader STRING out)
    if (inp.text) {
      const viaLink = textOf(follow(inp.text), depth + 1);
      if (viaLink) return viaLink;
    }
    for (const key of ['conditioning', 'positive', 'input', 'conditioning_1']) {
      const next = follow(inp[key]);
      if (next) {
        const t = textOf(next, depth + 1);
        if (t) return t;
      }
    }
    return '';
  };

  const inputRefs = (node) => Object.values(node?.inputs || {})
    .filter((value) => Array.isArray(value) && value.length >= 2 && byId.has(String(value[0])))
    .map((value) => String(value[0]));

  // A Comfy execution graph can end in KSampler, FaceDetailer, or a custom
  // sampling node. Find nodes that consume both positive and negative
  // conditioning, then discard stages which feed a later stage. This avoids
  // selecting a bypassed/base sampler when the saved image came from a hires
  // or detailer pass.
  const stages = nodes.filter((node) => {
    const inp = node.inputs || {};
    return Array.isArray(inp.positive) && Array.isArray(inp.negative);
  });

  const dependsOn = (node, targetId, seen = new Set()) => {
    for (const refId of inputRefs(node)) {
      if (refId === targetId) return true;
      if (seen.has(refId)) continue;
      seen.add(refId);
      if (dependsOn(byId.get(refId), targetId, seen)) return true;
    }
    return false;
  };

  const terminalStages = stages.filter((stage) => {
    const stageId = idByNode.get(stage);
    return !stages.some((other) => other !== stage && dependsOn(other, stageId));
  });
  const sampler = terminalStages.at(-1) || stages.at(-1) || null;

  if (sampler) {
    const inp = sampler.inputs || {};
    if (inp.seed != null) out.seed = inp.seed;
    else if (inp.noise_seed != null) out.seed = inp.noise_seed;
    if (inp.steps != null && Number.isFinite(Number(inp.steps))) out.steps = Number(inp.steps);
    if (inp.cfg != null && Number.isFinite(Number(inp.cfg))) out.cfg = Number(inp.cfg);
    if (typeof inp.sampler_name === 'string') out.sampler = inp.sampler_name;
    out.positive = textOf(follow(inp.positive));
    out.negative = textOf(follow(inp.negative));
  }
  if (!out.positive) {
    const negativeIds = new Set(stages
      .map((stage) => stage.inputs?.negative)
      .filter(Array.isArray)
      .map((ref) => String(ref[0])));
    const texts = entries
      .filter(([id, n]) => !negativeIds.has(String(id)) && !/negative/i.test(n._meta?.title || ''))
      .map(([, n]) => n)
      .filter((n) => (n.class_type || '') === 'CLIPTextEncode' && n.inputs && typeof n.inputs.text === 'string')
      .map((n) => n.inputs.text);
    if (texts.length) out.positive = texts.join('\n');
  }

  for (const node of nodes) {
    const ct = node.class_type || '';
    const inp = node.inputs || {};
    if (ct.includes('LoraLoader') && typeof inp.lora_name === 'string' && inp.lora_name) {
      const w = Number(inp.strength_model ?? inp.strength);
      out.loras.push({ name: stripExt(inp.lora_name), weight: Number.isFinite(w) ? w : null });
    }
    if (/^CheckpointLoader/.test(ct) && typeof inp.ckpt_name === 'string' && !out.model) {
      out.model = inp.ckpt_name;
    }
  }
  return out;
}

// NovelAI PNGs carry "Description" (plain positive prompt) and "Comment"
// (JSON with prompt/uc/settings, plus v4 caption structure). Software is
// "NovelAI"; Source identifies the model.
export function parseNai(texts) {
  const out = { positive: '', negative: '', settings: {} };
  const comment = parseJsonLoose(texts.Comment);
  if (comment) {
    const v4p = comment.v4_prompt?.caption?.base_caption;
    const v4n = comment.v4_negative_prompt?.caption?.base_caption;
    out.positive = typeof v4p === 'string' && v4p.trim() ? v4p : (comment.prompt || '');
    out.negative = typeof v4n === 'string' && v4n.trim() ? v4n : (comment.uc || '');
    if (comment.steps != null) out.settings.Steps = String(comment.steps);
    if (comment.scale != null) out.settings['CFG scale'] = String(comment.scale);
    if (comment.seed != null) out.settings.Seed = String(comment.seed);
    if (comment.sampler) out.settings.Sampler = String(comment.sampler);
    if (comment.width && comment.height) out.settings.Size = `${comment.width}x${comment.height}`;
  }
  if (!out.positive && typeof texts.Description === 'string') {
    out.positive = texts.Description;
  }
  if (typeof texts.Source === 'string' && texts.Source.trim()) {
    out.settings.Model = texts.Source.trim();
  }
  return out;
}

function isNaiChunks(texts) {
  if (typeof texts.Comment !== 'string' || !texts.Comment.trim()) return false;
  if (typeof texts.Software === 'string' && /novelai/i.test(texts.Software)) return true;
  // Fallback: Comment JSON with NAI-specific keys, even without Software tag.
  const c = parseJsonLoose(texts.Comment);
  return !!(c && (c.uc != null || c.v4_prompt != null));
}

// cologen (GPT Image Browser) writes a "cologen" tEXt chunk with JSON,
// preceded by a stray NUL byte. Prompt at top level or in requestConfig.
export function parseCologen(text) {
  const out = { positive: '', settings: {} };
  const j = parseJsonLoose(text);
  if (!j) return out;
  const rc = j.requestConfig && typeof j.requestConfig === 'object' ? j.requestConfig : {};
  if (typeof j.prompt === 'string' && j.prompt.trim()) out.positive = j.prompt;
  else if (typeof rc.prompt === 'string') out.positive = rc.prompt;
  const model = j.meta?.model || rc.model;
  if (model) out.settings.Model = String(model);
  const size = j.meta?.size || rc.resolvedSize;
  if (size) out.settings.Size = String(size);
  return out;
}

// Some writers prepend NULs/whitespace before the JSON payload.
function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

export function lorasFromText(text) {
  const out = [];
  if (!text) return out;
  for (const m of String(text).matchAll(LORA_RE)) {
    const name = stripExt(m[1].trim());
    const w = parseFloat(m[2]);
    if (name) out.push({ name, weight: Number.isFinite(w) ? w : null });
  }
  return out;
}

export function tagsFromPrompt(prompt) {
  if (!prompt) return [];
  const seen = new Set();
  const tags = [];
  for (const raw of String(prompt).split(/[,\n]/)) {
    const t = raw.trim();
    if (!t || /^<lora:/i.test(t) || /^<[^>]+>$/.test(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(t);
  }
  return tags;
}

function stripExt(name) {
  return String(name).replace(/\.[^./\\]+$/, '');
}

function dedupeLoras(loras) {
  const seen = new Set();
  const out = [];
  for (const l of loras) {
    const key = l.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}
