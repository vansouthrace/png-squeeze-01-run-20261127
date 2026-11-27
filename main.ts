// png-squeeze: a lossless PNG minimiser written from scratch in pure TypeScript.
// Strategy: decode the screenshot, shrink its representation (palette when the
// image holds at most 256 colours, grey / grey+alpha when every pixel is grey,
// a tRNS key when a single transparent colour can replace an alpha channel),
// pick each scanline's filter with the minimum-sum heuristic, screen every
// candidate form with zlib level 6, and write the winner with zlib level 9.
// Fully deterministic: no clock, no environment, no randomness — the same
// input always produces the same bytes.
import { constants, deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;

// ---- CRC-32 (PNG) ---------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function pngOf(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, width);
  new DataView(d.buffer).setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---- PNG decoding ----------------------------------------------------------
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!header) throw new Error('no IHDR');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++)
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = (palette as Uint8Array).length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = (palette as Uint8Array)[e * 3];
      lut[e * 4 + 1] = (palette as Uint8Array)[e * 3 + 1];
      lut[e * 4 + 2] = (palette as Uint8Array)[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---- Filtering --------------------------------------------------------------
// Filter one row of `cur` (stride samples, bpp per pixel) against `prev` into out.
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) out.set(cur);
    else for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
  } else if (type === 3) {
    for (let i = 0; i < n; i++)
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Every row filtered by the type with the smallest signed sum (PNG spec 12.8 heuristic).
function minsumFiltered(samples: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      const s = signedSum(trial[t]);
      if (s < best) {
        best = s;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

// Brute-force filter choice, in the manner of the kit's scale screen: each row
// is tried under all five filters and the one whose zlib stream (level 4, with
// the 32 KiB written before it as dictionary) is smallest wins. This costs five
// small deflate runs per row, but only ever runs on the single winning form, so
// the whole set stays far inside the wall budget. It consistently beats the
// minimum-sum heuristic on photo-like and gradient rows, where the cheapest
// filter by byte magnitude is not the cheapest once LZ77 sees the row.
function bruteFiltered(samples: Uint8Array, width: number, height: number, bpp: number, level = 4): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      const opts: { level: number; memLevel: number; dictionary?: Uint8Array } =
        before.length === 0 ? { level, memLevel: 9 } : { level, memLevel: 9, dictionary: before };
      const cost = deflateSync(trial[t], opts).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// Every row filtered by one fixed type.
function fixedFiltered(samples: Uint8Array, width: number, height: number, bpp: number, type: number): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    raw[at] = type;
    filterRow(type, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return raw;
}

// ---- Image analysis ---------------------------------------------------------
interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
  key: number;
  count: number;
}

function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const k = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
      const c = counts.get(k);
      if (c === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(k, 1);
      } else counts.set(k, c + 1);
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours: Colour[] = [];
  for (const [k, count] of counts) {
    colours.push({ r: (k >>> 24) & 0xff, g: (k >>> 16) & 0xff, b: (k >>> 8) & 0xff, a: k & 0xff, key: k, count });
  }
  return { opaque, grey, colours };
}

// The single fully-transparent value the image may key by tRNS, or null.
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
}

function paletteForm(rgba: Uint8Array, colours: Colour[], order: 'count' | 'luminance'): Form {
  const lum = (c: Colour): number => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.key - y.key;
    return y.count - x.count || x.key - y.key;
  });
  const index = new Map<number, number>(entries.map((c, i) => [c.key, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const k = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
    indices[i] = index.get(k) as number;
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// ---- Encoding one image -----------------------------------------------------
interface Candidate {
  form: Form;
  data: Uint8Array;
  bytes: number;
}

function encode(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const { opaque, grey, colours } = analyse(rgba);
  const candidates: Candidate[] = [];
  const screen = (form: Form, data: Uint8Array): void => {
    const zlib = deflateSync(data, { level: 6, memLevel: 8 });
    const overhead = (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
    candidates.push({ form, data, bytes: zlib.length + overhead });
  };

  if (colours !== null) {
    // Palette, ordered by count: filter 0 (flat runs stay flat), minsum, and
    // the other fixed filters — each screened, the smallest kept.
    const byCount = paletteForm(rgba, colours, 'count');
    screen(byCount, fixedFiltered(byCount.samples, width, height, 1, 0));
    screen(byCount, minsumFiltered(byCount.samples, width, height, 1));
    for (const t of [1, 2, 4]) screen(byCount, fixedFiltered(byCount.samples, width, height, 1, t));
    // Palette, ordered by luminance: minsum (neighbouring indices stay close
    // on smooth gradients, so Sub/Up residuals stay small) and unfiltered.
    const byLum = paletteForm(rgba, colours, 'luminance');
    screen(byLum, minsumFiltered(byLum.samples, width, height, 1));
    screen(byLum, fixedFiltered(byLum.samples, width, height, 1, 0));
    // A grey image can also go through the plain grey form; it sometimes wins
    // on smooth gradients where palette indices jump around.
    if (grey) {
      const key = opaque ? null : transparentKey(rgba, true);
      const ct = opaque || key !== null ? 0 : 4;
      const trns = key === null ? null : Uint8Array.of(0, key);
      const form: Form = { colourType: ct, bpp: ct === 0 ? 1 : 2, samples: samplesOf(rgba, ct), plte: null, trns };
      screen(form, minsumFiltered(form.samples, width, height, form.bpp));
      screen(form, fixedFiltered(form.samples, width, height, form.bpp, 0));
      screen(form, fixedFiltered(form.samples, width, height, form.bpp, 4));
    }
  }
  if (colours === null || grey) {
    // Full channel form (only reached when there is no palette, or as the
    // grey alternative above; for non-grey >256-colour images this is the one).
    if (colours === null) {
      const key = opaque ? null : transparentKey(rgba, grey);
      let ct: number;
      let trns: Uint8Array | null = null;
      if (grey) {
        ct = opaque || key !== null ? 0 : 4;
        if (key !== null) trns = Uint8Array.of(0, key);
      } else {
        ct = opaque || key !== null ? 2 : 6;
        if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
      }
      const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
      const form: Form = { colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns };
      screen(form, minsumFiltered(form.samples, width, height, bpp));
      // Fixed filters matter: on images with large flat transparent areas an
      // unfiltered row compresses far better than any filtered one, and the
      // minimum-sum heuristic never picks it. Screen them all.
      for (const t of [0, 1, 2, 3, 4]) screen(form, fixedFiltered(form.samples, width, height, bpp, t));
    }
  }

  let best = candidates[0];
  for (const c of candidates) if (c.bytes < best.bytes) best = c;

  // Brute-force the winning form's filters and keep the brute version when its
  // level-6 screen beats the heuristic version. (A level-9 per-row cost model
  // was tried: it screened smaller at level 6 but compressed larger at level 9
  // on flat images, and doubled the runtime, so level 4 stays.)
  const overheadOf = (form: Form): number =>
    (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
  const bruteData = bruteFiltered(best.form.samples, width, height, best.form.bpp, 4);
  const bruteBytes = deflateSync(bruteData, { level: 6, memLevel: 8 }).length + overheadOf(best.form);
  if (bruteBytes < best.bytes) best = { form: best.form, data: bruteData, bytes: bruteBytes };

  // Final squeeze: zlib level 9, default and filtered strategies, keep smaller.
  // When the runner-up candidate screened within 1% of the winner, its level-9
  // stream can still win (level-6 and level-9 rankings differ), so try it too.
  const finals: Array<{ form: Form; data: Uint8Array }> = [{ form: best.form, data: best.data }];
  let second: Candidate | null = null;
  for (const c of candidates) {
    if (c.data === best.data) continue;
    if (second === null || c.bytes < second.bytes) second = c;
  }
  if (second !== null && second.bytes <= best.bytes * 1.03) finals.push({ form: second.form, data: second.data });
  let idat: Uint8Array | null = null;
  let idatTotal = Infinity;
  let winForm: Form = best.form;
  for (const f of finals) {
    // Compare whole files, not just the IDAT stream: a runner-up form can carry
    // a PLTE/tRNS overhead that outweighs a slightly smaller zlib stream.
    const overhead = (f.form.plte === null ? 0 : 12 + f.form.plte.length) + (f.form.trns === null ? 0 : 12 + f.form.trns.length);
    for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
      const z = deflateSync(f.data, { level: 9, memLevel: 9, strategy });
      if (z.length + overhead < idatTotal) {
        idat = new Uint8Array(z);
        idatTotal = z.length + overhead;
        winForm = f.form;
      }
    }
  }
  const bestForm = winForm;
  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrOf(width, height, bestForm.colourType)]];
  if (bestForm.plte !== null) chunks.push(['PLTE', bestForm.plte]);
  if (bestForm.trns !== null) chunks.push(['tRNS', bestForm.trns]);
  chunks.push(['IDAT', idat as Uint8Array]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---- Main -------------------------------------------------------------------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), encode(image.rgba, image.width, image.height));
}
