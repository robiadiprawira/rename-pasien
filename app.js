(function () {
  'use strict';
  const L = window.RenameLogic;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

  const $ = (id) => document.getElementById(id);
  const ROLES = [
    ['urut', 'No Urut'],
    ['nama', 'Nama Pasien'],
    ['pelayanan', 'No Kunjungan'],
    ['abaikan', '(abaikan)'],
  ];

  const state = {
    refData: null,    // byte PDF referensi
    lines: null,      // baris mentah (teks PDF atau hasil OCR)
    rows: [],         // baris → sel (mode kolom)
    roles: [],        // peran tiap kolom
    mode: '',         // 'kolom' | 'bebas' | 'ocr'
    autoNumber: true, // No urut = urutan dari atas ke bawah
    totalData: null,
    previews: [],     // gambar halaman PDF asli (mode OCR)
    patients: [],     // {no, nama, pelayanan}
    files: [],
    assign: [],       // per file: { ref, kind }
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function setStatus(el, text, cls) {
    el.textContent = text || '';
    el.className = 'status ' + (cls || '');
  }

  /* ---------- Langkah 1: PDF referensi ---------- */

  $('refInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await loadReference(f, false);
  });
  $('ocrBtn').addEventListener('click', () => runOcr());
  $('gapInput').addEventListener('change', () => { applyColumnMode(true); });

  async function loadReference(file) {
    setStatus($('refStatus'), 'Membaca PDF referensi…');
    $('mapping').hidden = true;
    $('patientsBox').hidden = true;
    $('ocrBtn').hidden = true;
    try {
      state.refData = new Uint8Array(await file.arrayBuffer());
      state.lines = await L.extractLines(pdfjsLib, state.refData.slice());
      state.totalData = L.findTotalData(state.lines);
      if (!state.lines.length) {
        setStatus($('refStatus'), 'PDF ini tidak punya teks (hasil scan). Membaca dengan OCR…', 'warn');
        await runOcr();
        return;
      }
      state.mode = 'kolom';
      applyColumnMode(true);
      if (!state.patients.length) {
        state.patients = L.freeformPatients(state.lines);
        state.mode = 'bebas';
        state.autoNumber = true;
        $('mapping').hidden = true;
      }
      if (!state.patients.length) {
        setStatus($('refStatus'), 'Teks PDF tidak berisi daftar yang dikenali. Mencoba OCR…', 'warn');
        await runOcr();
        return;
      }
      $('ocrBtn').hidden = false;
      setStatus($('refStatus'), 'Terbaca dari teks PDF: ' + file.name, 'ok');
      afterPatientsChanged();
    } catch (err) {
      console.error(err);
      setStatus($('refStatus'), 'Gagal membaca PDF: ' + err.message, 'bad');
    }
  }

  /* ----- mode kolom (PDF bertulisan teks dengan tabel rapi) ----- */

  function applyColumnMode(reguess) {
    if (!state.lines || !state.lines.length) return;
    const gap = Math.max(2, Number($('gapInput').value) || 8);
    state.rows = L.buildRows(state.lines, gap);
    if (reguess) state.roles = L.guessColumns(state.rows);
    state.mode = 'kolom';
    state.autoNumber = state.roles.indexOf('urut') < 0;
    state.patients = L.extractPatients(state.rows, state.roles);
    $('mapping').hidden = false;
    renderMapping();
    afterPatientsChanged();
  }

  function renderMapping() {
    const t = $('mapTable');
    const ncol = state.roles.length;
    let html = '<thead><tr>';
    for (let c = 0; c < ncol; c++) {
      html += '<th><select data-col="' + c + '">' +
        ROLES.map(([v, l]) => '<option value="' + v + '"' + (state.roles[c] === v ? ' selected' : '') + '>' + l + '</option>').join('') +
        '</select></th>';
    }
    html += '</tr></thead><tbody>';
    state.rows.slice(0, 12).forEach((r) => {
      html += '<tr>';
      for (let c = 0; c < Math.max(ncol, r.length); c++) html += '<td>' + esc(r[c] || '') + '</td>';
      html += '</tr>';
    });
    html += '</tbody>';
    t.innerHTML = html;
    t.querySelectorAll('select').forEach((s) => s.addEventListener('change', (e) => {
      const col = Number(e.target.dataset.col);
      const val = e.target.value;
      if (val !== 'abaikan') state.roles = state.roles.map((r, i) => (i !== col && r === val ? 'abaikan' : r));
      state.roles[col] = val;
      applyColumnMode(false);
    }));
  }

  /* ----- OCR (PDF hasil scan) ----- */

  async function runOcr() {
    const st = $('refStatus');
    if (location.protocol === 'file:') {
      setStatus(st, 'PDF ini perlu OCR, dan OCR tidak bisa jalan jika index.html dibuka langsung. ' +
        'Tutup halaman ini, jalankan Mulai.bat (Windows) atau mulai.sh (Mac/Linux) di folder aplikasi, lalu ulangi.', 'bad');
      return;
    }
    if (typeof Tesseract === 'undefined') {
      setStatus(st, 'Komponen OCR tidak ditemukan di folder lib/tesseract.', 'bad');
      return;
    }
    let worker = null;
    try {
      const base = new URL('.', location.href).href;
      setStatus(st, 'Menyiapkan OCR…', 'warn');
      worker = await Tesseract.createWorker('eng', 1, {
        workerPath: base + 'lib/tesseract/worker.min.js',
        corePath: base + 'lib/tesseract/core/',
        langPath: base + 'lib/tesseract/lang/',
        gzip: true,
        cacheMethod: 'none',
        logger: (m) => {
          if (m.status === 'recognizing text' && state._ocrPage) {
            setStatus(st, 'OCR halaman ' + state._ocrPage + '… ' + Math.round(m.progress * 100) + '%', 'warn');
          }
        },
      });
      await worker.setParameters({ tessedit_pageseg_mode: '11' });

      const pdf = await pdfjsLib.getDocument({ data: state.refData.slice() }).promise;
      state.previews = [];

      // Satu kali baca penuh pada lebar target tertentu → baris-baris teks
      async function ocrPass(targetW, passLabel, keepPreview) {
        const out = [];
        for (let p = 1; p <= pdf.numPages; p++) {
          state._ocrPage = passLabel + ', halaman ' + p + '/' + pdf.numPages;
          setStatus(st, 'Membaca (' + state._ocrPage + ')…', 'warn');
          const page = await pdf.getPage(p);
          const base1 = page.getViewport({ scale: 1 });
          const scale = Math.min(5, Math.max(2, targetW / base1.width));
          const vp = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(vp.width);
          canvas.height = Math.round(vp.height);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          if (keepPreview) {
            const pv = document.createElement('canvas');
            pv.width = 1100;
            pv.height = Math.round(canvas.height * 1100 / canvas.width);
            pv.getContext('2d').drawImage(canvas, 0, 0, pv.width, pv.height);
            state.previews.push(pv.toDataURL('image/jpeg', 0.7));
          }
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          L.preprocessImage(img.data, canvas.width, canvas.height);
          ctx.putImageData(img, 0, 0);
          const { data } = await worker.recognize(canvas, {}, { blocks: true });
          let words = data.words;
          if (!words) {
            words = [];
            (data.blocks || []).forEach((b) => b.paragraphs.forEach((pa) => pa.lines.forEach((l) => l.words.forEach((w) => words.push(w)))));
          }
          out.push(...L.linesFromWords(words, scale));
        }
        return out;
      }

      const allLines = await ocrPass(4200, 'bacaan 1 dari 2', true);
      const linesB = await ocrPass(3200, 'bacaan 2 dari 2', false);
      const confirmed = new Set(L.repairIds(L.freeformPatients(linesB)).map((p) => p.pelayanan));
      state.lines = allLines;
      state.totalData = L.findTotalData(allLines);
      state.patients = L.repairIds(L.freeformPatients(allLines));
      state.patients.forEach((p) => { if (!confirmed.has(p.pelayanan)) p.unconfirmed = true; });
      state.mode = 'ocr';
      state.autoNumber = true;
      $('mapping').hidden = true;
      $('ocrBtn').hidden = true;
      if (!state.patients.length) {
        setStatus(st, 'OCR selesai tetapi tidak menemukan daftar pasien. Pastikan PDF-nya benar dan cukup jelas.', 'bad');
        $('patientsBox').hidden = true;
        return;
      }
      setStatus(st, 'Dibaca dengan OCR. Mohon periksa tabel di bawah, lalu perbaiki yang salah.', 'warn');
      afterPatientsChanged();
    } catch (err) {
      console.error(err);
      setStatus(st, 'OCR gagal: ' + err.message, 'bad');
    } finally {
      state._ocrPage = '';
      if (worker) { try { await worker.terminate(); } catch (e) { /* abaikan */ } }
    }
  }

  /* ----- tabel pasien (bisa diedit) ----- */

  function afterPatientsChanged() {
    renderPatients();
    recomputeMatches();
  }

  function renderPatients() {
    const box = $('patientsBox');
    if (!state.patients.length) {
      box.hidden = true;
      if (state.mode === 'kolom') {
        setStatus($('patientCount'), 'Belum ada data pasien terbaca. Atur peran kolom di atas (butuh minimal Nama Pasien dan No Kunjungan).', 'bad');
      }
      return;
    }
    box.hidden = false;
    $('patientCount').textContent = '';
    const flags = L.flagIds(state.patients);
    const nflags = L.flagNames(state.patients);
    const dupIds = findDuplicates(state.patients.map((p) => p.pelayanan));
    let red = 0;
    let html = '<thead><tr><th>No</th><th>Nama Pasien</th><th>No Kunjungan</th><th></th></tr></thead><tbody>';
    state.patients.forEach((p, i) => {
      const bad = dupIds.has(p.pelayanan) || (!p.checked && (flags[i] || p.unconfirmed));
      if (bad) red++;
      html += '<tr><td class="num">' + esc(p.no) + '</td>' +
        '<td><input type="text" data-i="' + i + '" data-f="nama" value="' + esc(p.nama) + '" size="32"' + (nflags[i] && state.mode === 'ocr' ? ' class="sus"' : '') + '></td>' +
        '<td><input type="text" data-i="' + i + '" data-f="pelayanan" value="' + esc(p.pelayanan) + '" size="24"' + (bad ? ' class="sus"' : p.fixed ? ' class="fix" title="Diperbaiki otomatis dari hasil OCR — mohon cek"' : '') + '></td>' +
        '<td><button type="button" class="mini" data-del="' + i + '" title="Hapus baris ini">×</button></td></tr>';
    });
    html += '</tbody>';
    state._red = red;
    $('ackBtn').hidden = red === 0;
    $('patientsTable').innerHTML = html;

    $('patientsTable').querySelectorAll('input').forEach((inp) => inp.addEventListener('change', (e) => {
      const i = Number(e.target.dataset.i);
      state.patients[i][e.target.dataset.f] = e.target.value.trim();
      delete state.patients[i].fixed;
      delete state.patients[i].unconfirmed;
      state.patients[i].checked = true;
      afterPatientsChanged();
    }));
    $('patientsTable').querySelectorAll('button[data-del]').forEach((btn) => btn.addEventListener('click', (e) => {
      state.patients.splice(Number(e.target.dataset.del), 1);
      if (state.autoNumber) state.patients.forEach((p, k) => { p.no = k + 1; });
      afterPatientsChanged();
    }));

    // ringkasan + peringatan
    const notes = [];
    let cls = 'ok';
    notes.push(state.patients.length + ' pasien terbaca.');
    if (state.totalData != null && state.totalData !== state.patients.length) {
      notes.push('Total Data di PDF tertulis ' + state.totalData + '. Kalau PDF terdiri dari beberapa halaman dan semuanya sudah terbaca, berarti ada baris yang terlewat.');
      cls = 'warn';
    } else if (state.totalData != null) {
      notes.push('Sesuai dengan Total Data di PDF (' + state.totalData + ').');
    }
    const nFlag = flags.filter(Boolean).length;
    if (nFlag) { notes.push(nFlag + ' No Kunjungan bertanda merah tampak berbeda dari yang lain — mohon dicek.'); cls = 'warn'; }
    if (dupIds.size) { notes.push('Ada No Kunjungan ganda: ' + Array.from(dupIds).join(', ')); cls = 'bad'; }
    const nUnc = state.patients.filter((p) => p.unconfirmed).length;
    if (nUnc) { notes.push(nUnc + ' No Kunjungan tidak sama pada dua kali pembacaan OCR (kotak merah) — pasti ada yang salah baca, cek di PDF asli.'); cls = 'warn'; }
    const nFix = state.patients.filter((p) => p.fixed).length;
    if (nFix) { notes.push(nFix + ' No Kunjungan (kotak kuning) diperbaiki otomatis karena 13 karakter awalnya berbeda dari mayoritas — cek tetap perlu.'); if (cls === 'ok') cls = 'warn'; }
    if (state.mode === 'ocr') { notes.push('Hasil OCR bisa keliru pada huruf/angka mirip; cocokkan dengan PDF asli.'); if (cls === 'ok') cls = 'warn'; }
    setStatus($('patientNote'), notes.join(' '), cls);
    const pb = $('pdfPreview');
    if (state.mode === 'ocr' && state.previews.length) {
      pb.hidden = false;
      $('pdfPreviewImgs').innerHTML = state.previews.map((u) => '<img alt="Halaman PDF referensi" src="' + u + '">').join('');
    } else pb.hidden = true;
  }

  $('ackBtn').addEventListener('click', () => {
    if (!confirm('Pastikan semua No Kunjungan bertanda merah sudah Anda cocokkan dengan PDF asli. Tandai semuanya sudah dicek?')) return;
    state.patients.forEach((p) => { p.checked = true; });
    afterPatientsChanged();
  });

  function findDuplicates(arr) {
    const seen = new Set(), dup = new Set();
    arr.forEach((v) => { if (seen.has(v)) dup.add(v); seen.add(v); });
    return dup;
  }

  /* ---------- Langkah 2: file pasien ---------- */

  $('filesInput').addEventListener('change', (e) => {
    state.files = Array.from(e.target.files).sort((a, b) => a.name.localeCompare(b.name, 'id', { numeric: true }));
    setStatus($('filesStatus'), state.files.length + ' file dipilih.', state.files.length ? 'ok' : '');
    recomputeMatches();
  });

  function recomputeMatches() {
    if (!state.files.length || !state.patients.length) {
      $('step3').hidden = true;
      return;
    }
    state.assign = L.matchFiles(state.files.map((f) => f.name), state.patients);
    $('step3').hidden = false;
    renderPreview();
  }

  /* ---------- Langkah 3: preview ---------- */

  $('templateInput').addEventListener('input', renderPreview);

  function currentStatuses() {
    const used = {};
    state.assign.forEach((a) => { if (a.ref >= 0) used[a.ref] = (used[a.ref] || 0) + 1; });
    return state.assign.map((a) => {
      if (a.ref < 0) return 'none';
      if (used[a.ref] > 1) return 'dup';
      return a.kind === 'mirip' ? 'mirip' : a.kind === 'kembar' ? 'kembar' : 'ok';
    });
  }

  const STATUS_LABEL = { ok: 'Cocok', mirip: 'Mirip — cek', kembar: 'Nama kembar — cek', none: 'Tidak cocok', dup: 'Ganda' };
  const STATUS_CLASS = { ok: 'ok', mirip: 'mirip', kembar: 'mirip', none: 'none', dup: 'dup' };

  function renderPreview() {
    const tpl = $('templateInput').value || '{no}. {kunjungan}';
    const statuses = currentStatuses();
    const nameCounts = {};
    const newNames = state.files.map((f, i) => {
      const a = state.assign[i];
      if (a.ref < 0) return '';
      const ext = (f.name.match(/\.[^.]+$/) || ['.pdf'])[0];
      const nn = L.newName(tpl, state.patients[a.ref], ext);
      nameCounts[nn] = (nameCounts[nn] || 0) + 1;
      return nn;
    });

    let html = '<thead><tr><th>#</th><th>Nama file sekarang</th><th>Pasien (dari PDF)</th><th>Nama baru</th><th>Status</th></tr></thead><tbody>';
    state.files.forEach((f, i) => {
      const a = state.assign[i];
      let st = statuses[i];
      if (a.ref >= 0 && nameCounts[newNames[i]] > 1 && st === 'ok') st = 'dup';
      statuses[i] = st;
      html += '<tr class="s-' + STATUS_CLASS[st] + '"><td class="num">' + (i + 1) + '</td>' +
        '<td>' + esc(f.name) + '</td>' +
        '<td><select data-file="' + i + '"><option value="-1">— pilih pasien —</option>' +
        state.patients.map((p, j) => '<option value="' + j + '"' + (a.ref === j ? ' selected' : '') + '>' +
          esc(p.no + '. ' + p.nama) + '</option>').join('') +
        '</select></td>' +
        '<td class="newname">' + esc(newNames[i]) + '</td>' +
        '<td class="st">' + STATUS_LABEL[st] + '</td></tr>';
    });
    html += '</tbody>';
    $('previewTable').innerHTML = html;
    $('previewTable').querySelectorAll('select').forEach((s) => s.addEventListener('change', (e) => {
      const i = Number(e.target.dataset.file);
      const ref = Number(e.target.value);
      state.assign[i] = ref < 0 ? { ref: -1, kind: 'none' } : { ref, kind: 'manual' };
      renderPreview();
    }));

    const cnt = { ok: 0, mirip: 0, kembar: 0, none: 0, dup: 0 };
    statuses.forEach((s) => cnt[s]++);
    $('summary').innerHTML =
      '<span class="pill ok">' + cnt.ok + ' cocok</span>' +
      (cnt.mirip ? '<span class="pill warn">' + cnt.mirip + ' mirip, mohon dicek</span>' : '') +
      (cnt.kembar ? '<span class="pill warn">' + cnt.kembar + ' nama kembar, cek urutannya</span>' : '') +
      (cnt.none ? '<span class="pill bad">' + cnt.none + ' tidak cocok</span>' : '') +
      (cnt.dup ? '<span class="pill bad">' + cnt.dup + ' ganda</span>' : '');

    const usedRefs = new Set(state.assign.filter((a) => a.ref >= 0).map((a) => a.ref));
    const unused = state.patients.filter((_, j) => !usedRefs.has(j));
    $('unusedBox').hidden = unused.length === 0;
    $('unusedList').innerHTML = unused.map((p) => '<li>' + esc(p.no + '. ' + p.nama + ' (' + p.pelayanan + ')') + '</li>').join('');

    const ready = (cnt.ok + cnt.mirip + cnt.kembar) > 0 && cnt.dup === 0;
    $('zipBtn').disabled = !ready;
    $('folderBtn').disabled = !ready || !window.showDirectoryPicker;
    $('folderHint').textContent = window.showDirectoryPicker
      ? 'Tombol "Simpan langsung ke folder" menyalin file hasil ke folder pilihan Anda (file asli tidak dihapus).'
      : 'Simpan langsung ke folder hanya tersedia di Chrome/Edge. Gunakan tombol ZIP.';
    state._ready = { statuses, newNames };
  }

  function buildPlan() {
    const { statuses, newNames } = state._ready;
    const matched = [], leftover = [];
    state.files.forEach((f, i) => {
      if (['ok', 'mirip', 'kembar'].includes(statuses[i])) matched.push({ file: f, name: newNames[i] });
      else leftover.push(f);
    });
    return { matched, leftover };
  }

  function confirmUnsure() {
    if (state._red) {
      if (!confirm(state._red + ' No Kunjungan di tabel pasien masih bertanda merah (belum dicek). Nama file hasil bisa salah. Tetap lanjutkan?')) return false;
    }
    const n = state._ready.statuses.filter((s) => s === 'mirip' || s === 'kembar').length;
    if (!n) return true;
    return confirm(n + ' file berstatus kuning (nama mirip atau kembar). Sudah dicek dan benar?');
  }

  $('zipBtn').addEventListener('click', async () => {
    if (!confirmUnsure()) return;
    const { matched, leftover } = buildPlan();
    const msg = $('resultMsg');
    setStatus(msg, 'Membuat ZIP…');
    try {
      const zip = new JSZip();
      matched.forEach((m) => zip.file(m.name, m.file));
      leftover.forEach((f) => zip.file('belum-cocok/' + f.name, f));
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hasil-rename.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setStatus(msg, matched.length + ' file di-rename dan dimasukkan ke ZIP.' +
        (leftover.length ? ' ' + leftover.length + ' file yang belum cocok ada di folder "belum-cocok" dengan nama asli.' : ''), 'ok');
    } catch (err) {
      console.error(err);
      setStatus(msg, 'Gagal membuat ZIP: ' + err.message, 'bad');
    }
  });

  $('folderBtn').addEventListener('click', async () => {
    if (!confirmUnsure()) return;
    const { matched } = buildPlan();
    const msg = $('resultMsg');
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      let n = 0;
      for (const m of matched) {
        const fh = await dir.getFileHandle(m.name, { create: true });
        const w = await fh.createWritable();
        await w.write(m.file);
        await w.close();
        n++;
      }
      setStatus(msg, n + ' file disimpan ke folder "' + dir.name + '".', 'ok');
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err);
      setStatus(msg, 'Gagal menyimpan ke folder: ' + err.message + '. Gunakan tombol ZIP.', 'bad');
    }
  });
})();
