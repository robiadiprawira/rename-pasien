/* Logika murni (tanpa DOM) — dipakai oleh app.js di browser dan oleh tes di Node. */
(function (root) {
  'use strict';

  /* ---------- 1. Ekstrak baris teks dari PDF referensi ---------- */

  // Mengembalikan array "baris"; tiap baris = array item {s, x, w} urut kiri→kanan.
  async function extractLines(pdfjsLib, data) {
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items
        .filter((i) => i.str && i.str.trim() !== '')
        .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const pageLines = [];
      for (const it of items) {
        const last = pageLines[pageLines.length - 1];
        if (last && Math.abs(last.y - it.y) <= 3) last.items.push(it);
        else pageLines.push({ y: it.y, items: [it] });
      }
      for (const ln of pageLines) {
        ln.items.sort((a, b) => a.x - b.x);
        lines.push(ln.items.map((i) => ({ s: i.s, x: i.x, w: i.w })));
      }
    }
    return lines;
  }

  // Ubah hasil OCR (kata + kotak) menjadi baris seperti extractLines.
  // words: [{text, bbox:{x0,y0,x1,y1}}], scale: faktor render (px per poin).
  function linesFromWords(words, scale) {
    scale = scale || 1;
    const ws = words
      .map((w) => ({
        s: String(w.text || '').replace(/[|_\[\]{}\\]/g, '').trim(),
        x0: w.bbox.x0, x1: w.bbox.x1, yc: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0,
      }))
      .filter((w) => w.s !== '');
    if (!ws.length) return [];
    const hs = ws.map((w) => w.h).sort((a, b) => a - b);
    const tol = 0.75 * hs[Math.floor(hs.length / 2)];
    ws.sort((a, b) => a.x0 - b.x0);
    const lines = [];
    for (const w of ws) {
      let best = null, bestD = Infinity;
      for (const ln of lines) {
        const d = Math.abs(ln.last.yc - w.yc);
        if (d <= tol && d < bestD) { best = ln; bestD = d; }
      }
      if (best) { best.items.push(w); best.last = w; }
      else lines.push({ items: [w], last: w });
    }
    lines.sort((a, b) => a.items[0].yc - b.items[0].yc);
    // y rata-rata baris bergerak seiring kemiringan; urutkan dengan rata-rata
    lines.sort((a, b) => avg(a.items.map((i) => i.yc)) - avg(b.items.map((i) => i.yc)));
    return lines.map((ln) => ln.items.map((i) => ({ s: i.s, x: i.x0 / scale, w: (i.x1 - i.x0) / scale })));
  }
  function avg(a) { return a.reduce((s, v) => s + v, 0) / a.length; }

  // Gabungkan item dalam satu baris menjadi sel-sel. Jarak > gap = sel baru.
  function buildRows(lines, gap) {
    gap = gap == null ? 8 : gap;
    return lines.map((items) => {
      const cells = [];
      let cur = null;
      for (const it of items) {
        if (cur && it.x - cur.x2 < gap) {
          cur.t += (it.x - cur.x2 > 1 ? ' ' : '') + it.s;
          cur.x2 = it.x + it.w;
        } else {
          cur = { t: it.s, x2: it.x + it.w };
          cells.push(cur);
        }
      }
      return cells.map((c) => c.t.replace(/\s+/g, ' ').trim());
    });
  }

  /* ---------- 2. Tebak kolom ---------- */

  const RE_URUT = /^\d{1,4}\.?$/;
  const RE_PELAYANAN = /^[A-Za-z0-9\-\/.]*\d{5,}[A-Za-z0-9\-\/.]*$/;
  const RE_NAMA = /[A-Za-z]{3,}/;

  // Kembalikan array peran per kolom: 'urut' | 'nama' | 'pelayanan' | 'abaikan'
  function guessColumns(rows) {
    const counts = {};
    rows.forEach((r) => { counts[r.length] = (counts[r.length] || 0) + 1; });
    let modal = 0, best = 0;
    for (const k in counts) if (counts[k] > best) { best = counts[k]; modal = +k; }
    const sample = rows.filter((r) => r.length === modal);
    const roles = new Array(modal).fill('abaikan');
    if (!sample.length) return roles;
    const frac = (col, re) => sample.filter((r) => re.test(r[col])).length / sample.length;
    const used = {};
    for (let c = 0; c < modal; c++) {
      if (!used.urut && frac(c, RE_URUT) >= 0.8) { roles[c] = 'urut'; used.urut = true; }
      else if (!used.pelayanan && frac(c, RE_PELAYANAN) >= 0.8) { roles[c] = 'pelayanan'; used.pelayanan = true; }
    }
    for (let c = 0; c < modal; c++) {
      if (roles[c] === 'abaikan' && !used.nama && frac(c, RE_NAMA) >= 0.8) { roles[c] = 'nama'; used.nama = true; }
    }
    return roles;
  }

  /* ---------- 3. Ambil data pasien sesuai pemetaan kolom ---------- */

  function extractPatients(rows, roles) {
    const iUrut = roles.indexOf('urut');
    const iNama = roles.indexOf('nama');
    const iPel = roles.indexOf('pelayanan');
    if (iNama < 0 || iPel < 0) return [];
    const out = [];
    for (const r of rows) {
      const nama = (r[iNama] || '').trim();
      const pel = (r[iPel] || '').trim();
      if (!nama || !pel) continue;
      let no;
      if (iUrut >= 0) {
        const raw = (r[iUrut] || '').trim();
        if (!RE_URUT.test(raw)) continue; // baris header / bukan data
        no = parseInt(raw, 10);
      } else {
        if (!RE_PELAYANAN.test(pel)) continue;
        no = out.length + 1;
      }
      out.push({ no, nama, pelayanan: pel });
    }
    return out;
  }

  /* ---------- 4. Pencocokan nama file ↔ pasien ---------- */

  const TITLES = new Set(['tn', 'ny', 'nn', 'an', 'by', 'bpk', 'bapak', 'ibu', 'sdr', 'sdri', 'nyonya', 'tuan', 'nona', 'anak', 'bayi', 'dr', 'h', 'hj', 'anc', 'usg', 'kb', 'kia']);

  function normalize(s) {
    return String(s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\(\d+\)\s*$/, ' ')      // akhiran "(1)" dari duplikat unduhan
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function tokens(s) {
    return normalize(s).split(' ').filter((t) => t && !TITLES.has(t));
  }

  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }

  // Skor 0..1: gabungan kesamaan kata dan kesamaan huruf (tahan salah ketik / salah baca OCR).
  function similarity(a, b) {
    const ta = tokens(a), tb = tokens(b);
    const A = new Set(ta), B = new Set(tb);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach((t) => { if (B.has(t)) inter++; });
    const jac = inter / (A.size + B.size - inter);
    const sa = ta.join(' '), sb = tb.join(' ');
    const chr = 1 - lev(sa, sb) / Math.max(sa.length, sb.length);
    // nama sebagian (mis. "Amy" untuk "Amy Siti Kusdiyanti") atau ada kata tambahan: semua kata yang pendek ada di yang panjang
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    let inBig = 0;
    small.forEach((t) => { if (big.has(t)) inBig++; });
    const cont = inBig === small.size ? 0.8 : 0;
    return Math.max(jac, chr, cont);
  }

  function baseName(filename) {
    return filename.replace(/\.[^.]+$/, '');
  }

  // Kembalikan array {ref: index | -1, kind: 'exact'|'mirip'|'none'} per nama file
  function matchFiles(fileNames, patients) {
    const result = fileNames.map(() => ({ ref: -1, kind: 'none' }));
    const normPat = patients.map((p) => normalize(p.nama));
    const taken = new Set();

    // Tahap 1: nama persis sama (setelah normalisasi).
    // Nama kembar (mis. dua "WULANDARI") tidak bisa dipastikan → dipasangkan berurutan, ditandai 'kembar'.
    // kunci perbandingan: kata-kata nama tanpa gelar / kata umum seperti "ANC"
    const key = (str) => tokens(str).join(' ');
    const patByName = {}, fileByName = {};
    patients.forEach((p, j) => { const k = key(p.nama); if (k) (patByName[k] = patByName[k] || []).push(j); });
    fileNames.forEach((fn, i) => {
      const k = key(baseName(fn));
      if (k) (fileByName[k] = fileByName[k] || []).push(i);
    });
    for (const n in fileByName) {
      const pj = patByName[n];
      if (!pj) continue;
      const suffix = (i) => { const m = baseName(fileNames[i]).match(/\((\d+)\)\s*$/); return m ? parseInt(m[1], 10) : 0; };
      const fi = fileByName[n].slice().sort((a, b) =>
        suffix(a) - suffix(b) || fileNames[a].localeCompare(fileNames[b], 'id', { numeric: true }));
      if (pj.length === 1 && fi.length === 1) {
        const same = normalize(baseName(fileNames[fi[0]])) === normPat[pj[0]];
        result[fi[0]] = { ref: pj[0], kind: same ? 'exact' : 'mirip' };
        taken.add(pj[0]);
      } else {
        for (let k = 0; k < Math.min(pj.length, fi.length); k++) {
          result[fi[k]] = { ref: pj[k], kind: 'kembar' };
          taken.add(pj[k]);
        }
      }
    }

    // Tahap 2: mirip (kesamaan kata/huruf), butuh konfirmasi manual
    fileNames.forEach((fn, i) => {
      if (result[i].ref !== -1) return;
      let bestJ = -1, best = 0, second = 0;
      patients.forEach((p, j) => {
        if (taken.has(j)) return;
        const sc = similarity(baseName(fn), p.nama);
        if (sc > best) { second = best; best = sc; bestJ = j; }
        else if (sc > second) second = sc;
      });
      if (bestJ >= 0 && best >= 0.7 && best - second >= 0.12) {
        result[i] = { ref: bestJ, kind: 'mirip' };
        taken.add(bestJ);
      }
    });
    return result;
  }

  /* ---------- 5. Nama baru ---------- */

  function sanitize(s) {
    return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
  }

  function newName(template, patient, ext) {
    const base = template
      .replace(/\{no\}/g, String(patient.no))
      .replace(/\{(?:pelayanan|kunjungan)\}/g, patient.pelayanan)
      .replace(/\{nama\}/g, patient.nama);
    return sanitize(base) + (ext || '.pdf');
  }

  /* ---------- 5b. Pra-pemrosesan gambar untuk OCR ---------- */

  // Ubah gambar RGBA (in-place) menjadi hitam-putih bersih: tanpa garis tabel, teks hitam di latar putih.
  function preprocessImage(rgba, w, h) {
    const n = w * h;
    const gray = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;

    // ambang adaptif (rata-rata lokal lewat integral image)
    const W1 = w + 1;
    const integ = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += gray[y * w + x];
        integ[(y + 1) * W1 + (x + 1)] = integ[y * W1 + (x + 1)] + row;
      }
    }
    const r = Math.max(10, Math.round(w / 150));
    const dark = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const sum = integ[y1 * W1 + x1] - integ[y0 * W1 + x1] - integ[y1 * W1 + x0] + integ[y0 * W1 + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        dark[y * w + x] = gray[y * w + x] < mean - 15 ? 1 : 0;
      }
    }

    // hapus garis panjang (horizontal & vertikal, termasuk yang sedikit miring)
    const L = Math.max(50, Math.round(w * 0.022));
    const kill = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!dark[y * w + x]) { x++; continue; }
        let e = x;
        while (e < w && dark[y * w + e]) e++;
        if (e - x >= L) for (let k = x; k < e; k++) kill[y * w + k] = 1;
        x = e;
      }
    }
    for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        if (!dark[y * w + x]) { y++; continue; }
        let e = y;
        while (e < h && dark[e * w + x]) e++;
        if (e - y >= L) for (let k = y; k < e; k++) kill[k * w + x] = 1;
        y = e;
      }
    }
    // perlebar area yang dihapus 1 piksel agar sisa tepi garis ikut hilang
    const kill2 = new Uint8Array(kill);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (kill[i - 1] || kill[i + 1] || kill[i - w] || kill[i + w]) kill2[i] = 1;
      }
    }
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const v = dark[i] && !kill2[i] ? 0 : 255;
      rgba[j] = rgba[j + 1] = rgba[j + 2] = v;
      rgba[j + 3] = 255;
    }
    return rgba;
  }

  // Cari "Total Data : N" di baris-baris hasil baca (untuk pemeriksaan jumlah).
  function findTotalData(lines) {
    for (const items of lines.slice(0, 20)) {
      const m = items.map((i) => i.s).join(' ').match(/total\s*data\D{0,6}(\d{1,5})/i);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  // Cara baca bebas: ID = kata-kata berangka di awal baris, nama = kata sesudahnya sampai tanggal.
  const RE_DATE = /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/;
  function freeformPatients(lines) {
    const out = [];
    for (const items of lines) {
      const w = items.map((i) => i.s);
      let i = 0, id = '';
      while (i < w.length && /\d/.test(w[i]) && !RE_DATE.test(w[i])) { id += w[i]; i++; }
      id = id.replace(/[^A-Za-z0-9]/g, '');
      if (id.length < 10) continue;
      const name = [];
      let prevEnd = null;
      while (i < w.length && !RE_DATE.test(w[i]) && !/\d/.test(w[i])) {
        // jarak besar (> 7 poin) berarti sudah masuk kolom berikutnya
        if (prevEnd !== null && items[i].x - prevEnd > 7) break;
        name.push(w[i]);
        prevEnd = items[i].x + items[i].w;
        i++;
      }
      if (!name.length) continue;
      out.push({ no: out.length + 1, nama: name.join(' '), pelayanan: id });
    }
    return out;
  }

  /* ---------- 6. Pemeriksaan & perbaikan ID hasil OCR ---------- */

  function shape(id) {
    return id.replace(/[0-9]/g, '9').replace(/[A-Za-z]/g, 'A');
  }

  // Tandai (true) ID yang bentuknya berbeda dari kebanyakan ID lain.
  function flagIds(patients) {
    if (patients.length < 3) return patients.map(() => false);
    const cnt = {};
    patients.forEach((p) => { const s = shape(p.pelayanan); cnt[s] = (cnt[s] || 0) + 1; });
    let modal = '', best = 0;
    for (const s in cnt) if (cnt[s] > best) { best = cnt[s]; modal = s; }
    // posisi yang hampir semua ID sepakat (>= 85%) → ID yang menyimpang dicurigai salah baca
    const sameLen = patients.filter((p) => shape(p.pelayanan) === modal);
    const strong = {};
    if (sameLen.length >= 6) {
      for (let i = 0; i < modal.length; i++) {
        const c = {};
        sameLen.forEach((p) => { c[p.pelayanan[i]] = (c[p.pelayanan[i]] || 0) + 1; });
        let top = '', tn = 0;
        for (const ch in c) if (c[ch] > tn) { tn = c[ch]; top = ch; }
        if (tn / sameLen.length >= 0.85) strong[i] = top;
      }
    }
    return patients.map((p) => {
      if (shape(p.pelayanan) !== modal) return true;
      for (const i in strong) if (p.pelayanan[i] !== strong[i]) return true;
      return false;
    });
  }

  // Format standar No Kunjungan BPJS: 4 angka, huruf, 7 angka, huruf, 6 angka (mis. 0219B0071026P000044).
  const BPJS_SHAPE = '9999A9999999A999999';

  // Perbaiki salah baca OCR yang umum (O↔0, B↔8, dst.) berdasarkan bentuk ID.
  function repairIds(patients) {
    if (patients.length < 3) return patients;
    const toDigit = { O: '0', Q: '0', D: '0', C: '0', I: '1', L: '1', l: '1', Z: '2', S: '5', G: '6', B: '8', T: '7' };
    const toLetter = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 6: 'G', 8: 'B' };
    const cnt = {};
    patients.forEach((p) => { const s = shape(p.pelayanan); cnt[s] = (cnt[s] || 0) + 1; });
    let modal = '', best = 0;
    for (const s in cnt) if (cnt[s] > best) { best = cnt[s]; modal = s; }
    const len19 = patients.filter((p) => p.pelayanan.length === BPJS_SHAPE.length).length;
    const pattern = len19 / patients.length >= 0.5 ? BPJS_SHAPE : modal;

    // tahap 1: paksa kelas angka/huruf sesuai pola
    let fixed = patients.map((p) => {
      if (p.pelayanan.length !== pattern.length) return p;
      let out = '';
      for (let i = 0; i < pattern.length; i++) {
        let ch = p.pelayanan[i];
        if (pattern[i] === '9' && /[A-Za-z]/.test(ch)) ch = toDigit[ch] || toDigit[ch.toUpperCase()] || ch;
        else if (pattern[i] === 'A') ch = /[0-9]/.test(ch) ? (toLetter[ch] || ch) : ch.toUpperCase();
        out += ch;
      }
      return out === p.pelayanan ? p : Object.assign({}, p, { pelayanan: out });
    });

    // tahap 2: huruf yang konstan di posisi huruf (mis. 'B' dan 'P') dipaksa jika mayoritas jelas
    const same = fixed.filter((p) => p.pelayanan.length === pattern.length);
    const constLetter = {};
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] !== 'A') continue;
      const c = {};
      same.forEach((p) => { c[p.pelayanan[i]] = (c[p.pelayanan[i]] || 0) + 1; });
      let top = '', tn = 0;
      for (const ch in c) if (c[ch] > tn) { tn = c[ch]; top = ch; }
      if (same.length && tn / same.length >= 0.6) constLetter[i] = top;
    }
    fixed = fixed.map((p) => {
      if (p.pelayanan.length !== pattern.length) return p;
      let out = '';
      for (let i = 0; i < pattern.length; i++) out += constLetter[i] || p.pelayanan[i];
      return out === p.pelayanan ? p : Object.assign({}, p, { pelayanan: out });
    });

    // tahap 3 (hanya format BPJS): dalam satu FPK, 13 karakter pertama (kode klinik + bulan) sama untuk semua baris.
    if (pattern === BPJS_SHAPE) {
      const PRE = pattern.length - 6;
      const full = fixed.filter((p) => p.pelayanan.length === pattern.length);
      const pref = [];
      let strongEnough = full.length >= 4;
      for (let i = 0; i < PRE && strongEnough; i++) {
        const c = {};
        full.forEach((p) => { c[p.pelayanan[i]] = (c[p.pelayanan[i]] || 0) + 1; });
        let top = '', tn = 0;
        for (const ch in c) if (c[ch] > tn) { tn = c[ch]; top = ch; }
        if (tn / full.length < 0.5) strongEnough = false;
        pref.push(top);
      }
      if (strongEnough) {
        const pre = pref.join('');
        fixed = fixed.map((p) => {
          if (p.pelayanan.length !== pattern.length || p.pelayanan.slice(0, PRE) === pre) return p;
          return Object.assign({}, p, { pelayanan: pre + p.pelayanan.slice(PRE), fixed: true });
        });
      }
    }
    return fixed;
  }

  // Tandai nama yang tampak hasil salah baca (huruf kecil di antara huruf kapital, tanda baca aneh).
  function flagNames(patients) {
    const upper = patients.filter((p) => p.nama === p.nama.toUpperCase()).length / (patients.length || 1);
    return patients.map((p) =>
      /[^A-Za-z .'\-]/.test(p.nama) || (upper >= 0.7 && p.nama !== p.nama.toUpperCase()));
  }

  const api = { extractLines, linesFromWords, buildRows, guessColumns, extractPatients, freeformPatients, findTotalData, preprocessImage, normalize, similarity, matchFiles, baseName, sanitize, newName, flagIds, flagNames, repairIds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RenameLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
