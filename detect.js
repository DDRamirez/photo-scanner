/*
 * detect.js - finds a printed photo in a scan and returns its four corners.
 *
 * Same method as crop_photos.py, in plain JavaScript so it needs no libraries:
 *   1. shrink the photo to ~800 px and convert to Lab colour
 *   2. take the background colour from a thin strip around the frame edge
 *   3. mark every pixel clearly different from the background as "print"
 *   4. clean the mask up, keep the sizeable blobs, and take their outline
 *   5. fit the tightest rotated rectangle around that outline
 *
 * Runs as a Web Worker (new Worker('detect.js')) so detection never slows the
 * camera, and also loads as a normal script as a fallback.
 * Corners come back normalised (0-1) in the order top-left, top-right,
 * bottom-right, bottom-left, so they apply to the photo at any resolution.
 */
(function (root) {
  'use strict';

  const WORK_SIZE = 800;   // long edge used for detection
  const MIN_DIFF = 12;     // minimum colour difference from the background (Lab units)
  const MAX_DIFF = 30;     // cap, so a print reaching into the edge strip can't inflate the threshold
  const MIN_FRAC = 0.01;   // print must cover at least 1% of the frame
  const MAX_FRAC = 0.97;
  const MIN_FILL = 0.85;   // outline must fill at least 85% of its rectangle
  const EDGE_MARGIN = 0.01;

  /* ---------- colour ---------- */
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

  function toLab(rgba, n) {
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = LIN[rgba[j]], g = LIN[rgba[j + 1]], b = LIN[rgba[j + 2]];
      const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
      const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
      const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
      L[i] = 116 * fy - 16; A[i] = 500 * (fx - fy); B[i] = 200 * (fy - fz);
    }
    return [L, A, B];
  }

  /* 3x3 box blur on one channel (cuts sensor noise before thresholding) */
  function blur(src, w, h) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const a = src[o + Math.max(0, x - 1)], b = src[o + x], c = src[o + Math.min(w - 1, x + 1)];
        tmp[o + x] = (a + b + c) / 3;
      }
    }
    for (let y = 0; y < h; y++) {
      const up = Math.max(0, y - 1) * w, dn = Math.min(h - 1, y + 1) * w, o = y * w;
      for (let x = 0; x < w; x++) out[o + x] = (tmp[up + x] + tmp[o + x] + tmp[dn + x]) / 3;
    }
    return out;
  }

  const median = arr => { const s = Float32Array.from(arr).sort(); return s[s.length >> 1]; };
  const percentile = (arr, p) => { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

  /* ---------- morphology: square max/min filters, done separably ---------- */
  function morph(mask, w, h, k, isMax) {
    const r = k >> 1, tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
    const pick = isMax ? 1 : 0;
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let v = 1 - pick;
        for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < w && mask[o + xx] === pick) { v = pick; break; } }
        tmp[o + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 1 - pick;
        for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < h && tmp[yy * w + x] === pick) { v = pick; break; } }
        out[y * w + x] = v;
      }
    }
    return out;
  }
  const dilate = (m, w, h, k) => morph(m, w, h, k, true);
  const erode = (m, w, h, k) => morph(m, w, h, k, false);

  /* ---------- geometry ---------- */
  function convexHull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }
  function polyArea(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return Math.abs(s) / 2;
  }
  /* Smallest-area rectangle around a convex hull: one side always lies along a hull edge. */
  function minAreaRect(hull) {
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1e-9) continue;
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, vx = -uy, vy = ux;
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const p of hull) {
        const u = p[0] * ux + p[1] * uy, v = p[0] * vx + p[1] * vy;
        if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) best = { area, ux, uy, vx, vy, minU, maxU, minV, maxV };
    }
    const r = best, P = (u, v) => [u * r.ux + v * r.vx, u * r.uy + v * r.vy];
    return { area: r.area, pts: [P(r.minU, r.minV), P(r.maxU, r.minV), P(r.maxU, r.maxV), P(r.minU, r.maxV)] };
  }
  /* Order as top-left, top-right, bottom-right, bottom-left. */
  function orderCorners(q) {
    const c = [q.reduce((s, p) => s + p[0], 0) / 4, q.reduce((s, p) => s + p[1], 0) / 4];
    const byAngle = q.slice().sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
    // byAngle runs clockwise on screen starting near the left; rotate so the top-left (smallest x+y) comes first
    let start = 0;
    for (let i = 1; i < 4; i++) if (byAngle[i][0] + byAngle[i][1] < byAngle[start][0] + byAngle[start][1]) start = i;
    return [0, 1, 2, 3].map(i => byAngle[(start + i) % 4]);
  }

  /* ---------- main detection on raw RGBA pixels ---------- */
  function detectPrint(rgba, w, h) {
    const n = w * h;
    let [L, A, B] = toLab(rgba, n);
    L = blur(L, w, h); A = blur(A, w, h); B = blur(B, w, h);

    // Background colour from a strip around the frame edge
    const b = Math.max(3, Math.round(Math.min(w, h) * 0.03)), border = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      if (y < b || y >= h - b || x < b || x >= w - b) border.push(y * w + x);
    const bgL = median(border.map(i => L[i])), bgA = median(border.map(i => A[i])), bgB = median(border.map(i => B[i]));
    const dist = i => Math.hypot(L[i] - bgL, A[i] - bgA, B[i] - bgB);
    const thresh = Math.min(MAX_DIFF, Math.max(MIN_DIFF, 1.5 * percentile(border.map(dist), 0.9)));

    let mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = dist(i) > thresh ? 1 : 0;

    // Close small gaps (twice), then remove specks
    const k = Math.max(3, (Math.round(Math.max(w, h) * 0.009) | 1));
    for (let it = 0; it < 2; it++) mask = erode(dilate(mask, w, h, k), w, h, k);
    mask = dilate(erode(mask, w, h, k), w, h, k);

    // Connected blobs; keep every sizeable one (a print with background-coloured areas can split)
    const label = new Int32Array(n), sizes = [0], stack = new Int32Array(n);
    let next = 1;
    for (let i = 0; i < n; i++) {
      if (!mask[i] || label[i]) continue;
      let sp = 0, count = 0; stack[sp++] = i; label[i] = next;
      while (sp) {
        const p = stack[--sp]; count++;
        const x = p % w, y = (p - x) / w;
        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = next; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = next; stack[sp++] = p + w; }
      }
      sizes.push(count); next++;
    }
    const keep = sizes.map(s => s > 0.01 * n);
    if (!keep.some(Boolean)) return { status: 'none', note: 'print not found', frac: 0 };

    // Outline: the left/right extremes of every row are enough for a convex hull
    const pts = [];
    for (let y = 0; y < h; y++) {
      let lo = -1, hi = -1;
      for (let x = 0; x < w; x++) if (keep[label[y * w + x]] && label[y * w + x]) { if (lo < 0) lo = x; hi = x; }
      if (lo >= 0) { pts.push([lo, y], [hi + 1, y], [lo, y + 1], [hi + 1, y + 1]); }
    }
    const hull = convexHull(pts), hullArea = polyArea(hull), frac = hullArea / n;
    if (frac < MIN_FRAC) return { status: 'none', note: 'print too small or not found', frac };
    if (frac > MAX_FRAC) return { status: 'none', note: 'print fills the frame, or the background wasn’t found', frac };

    const rect = minAreaRect(hull), fill = hullArea / Math.max(rect.area, 1);
    if (fill < MIN_FILL) return { status: 'none', note: 'shape isn’t rectangular', frac };

    const q = orderCorners(rect.pts);
    const mx = EDGE_MARGIN * Math.max(w, h);
    const touches = q.some(p => p[0] < mx || p[1] < mx || p[0] > w - mx || p[1] > h - mx);
    return {
      status: touches ? 'check' : 'ok',
      note: touches ? 'print touches the frame edge; a corner may be cut off' : 'found',
      frac,
      corners: q.map(p => [p[0] / w, p[1] / h])
    };
  }

  /* ---------- image helpers (browser only) ---------- */
  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  function canvasToBlob(c, type, q) {
    if (c.convertToBlob) return c.convertToBlob({ type, quality: q });
    return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), type, q));
  }
  /* Draw the straightened, trimmed print onto a canvas. corners are normalised; W,H are the source size. */
  function drawCrop(src, W, H, corners, maxSide, trim) {
    const [tl, tr, , bl] = corners.map(p => [p[0] * W, p[1] * H]);
    const cw = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), ch = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
    const angle = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]);
    const t = Math.round(Math.min(cw, ch) * (trim || 0));
    const s = maxSide ? Math.min(1, maxSide / Math.max(cw - 2 * t, ch - 2 * t)) : 1;
    const ow = Math.max(1, Math.round((cw - 2 * t) * s)), oh = Math.max(1, Math.round((ch - 2 * t) * s));
    const c = makeCanvas(ow, oh), ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.scale(s, s);
    ctx.translate(-t, -t);
    ctx.rotate(-angle);
    ctx.translate(-tl[0], -tl[1]);
    ctx.drawImage(src, 0, 0, W, H);
    return c;
  }

  /* Analyse one captured photo: corners plus a small cropped thumbnail. */
  async function analyze(blob) {
    const bmp = await createImageBitmap(blob);
    const W = bmp.width, H = bmp.height, s = Math.min(1, WORK_SIZE / Math.max(W, H));
    const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
    const c = makeCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    const result = detectPrint(ctx.getImageData(0, 0, w, h).data, w, h);
    result.width = W; result.height = H;
    if (result.corners) {
      const tc = drawCrop(c, w, h, result.corners, 220, 0.01);
      result.thumb = await canvasToBlob(tc, 'image/jpeg', 0.8);
    }
    return result;
  }

  /* Full-resolution crop for export. */
  async function cropFull(blob, corners, trim) {
    const bmp = await createImageBitmap(blob);
    const c = drawCrop(bmp, bmp.width, bmp.height, corners, 0, trim == null ? 0.01 : trim);
    bmp.close && bmp.close();
    return canvasToBlob(c, 'image/jpeg', 0.95);
  }

  const api = { detectPrint, analyze, cropFull, drawCrop };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PrintDetect = api;

  // Worker mode: answer {id, op, blob, corners} messages.
  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    root.onmessage = async e => {
      const { id, op, blob, corners, trim } = e.data;
      try {
        const out = op === 'crop' ? await cropFull(blob, corners, trim) : await analyze(blob);
        root.postMessage({ id, ok: true, out });
      } catch (err) {
        root.postMessage({ id, ok: false, error: String((err && err.message) || err) });
      }
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
