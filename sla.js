// =====================================================================
// SIMALAT · Availability & Biaya SLA  (file terpisah — dimuat setelah app.js)
// Tabel Supabase: sla_band, kontrak_unit, availability_bulanan
// Aturan kontrak:
//   • Faktor bayar per unit per bulan mengikuti band SLA (tabel sla_band).
//   • Availability 0% tiga bulan berturut-turut → bulan ke-3 dst. faktor 0
//     (bulan ke-1 dan ke-2 tetap dibayar sesuai band, yaitu 50%).
//   • Bulan tanpa data availability tidak ditagihkan (Rp 0) dan tidak
//     dihitung dalam nilai penuh maupun rata-rata.
// =====================================================================

const SLA_BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const SLA_BULAN_PANJANG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const SLA_DEFAULT_BANDS = [{ batas: 0, faktor: 0.5 }, { batas: 0.35, faktor: 0.65 }, { batas: 0.64, faktor: 0.85 }, { batas: 0.85, faktor: 1 }];
const SLA_ZERO_LIMIT = 3; // bulan ke-3 berturut-turut 0% → tidak dibayar
// Utilisasi = jam alat dipakai ÷ jam alat tersedia. Hanya ditampilkan sebagai persen,
// tidak memakai target/SLA dan tidak memengaruhi biaya kontrak.
const SLA_KATEGORI = ['Alat Utama Dermaga', 'Alat Utama Lapangan', 'Alat Pendukung', 'Alat Angkut'];
const SLA_KAT_SHORT = { 'Alat Utama Dermaga': 'Dermaga', 'Alat Utama Lapangan': 'Lapangan', 'Alat Pendukung': 'Pendukung', 'Alat Angkut': 'Angkut' };
const SLA_KAT_COLOR = { 'Alat Utama Dermaga': '#1e3a8a', 'Alat Utama Lapangan': '#3b82f6', 'Alat Pendukung': '#94a3b8', 'Alat Angkut': '#0f766e' };

let slaBands = SLA_DEFAULT_BANDS.slice();
let slaUnits = [];
let slaAv = new Map();            // `${unit_id}|${tahun}|${bulan}` → baris availability_bulanan
let slaState = { tahun: null, bulan: null, mode: 'bulan', view: 'both', ready: false, error: null };
let slaChartInstance = null;

const slaKey = (u, y, m) => `${u}|${y}|${m}`;
const slaEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slaPct = (v, d = 1) => v === null || v === undefined || isNaN(v) ? '–' : (v * 100).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%';
const slaRp = v => 'Rp ' + Math.round(v || 0).toLocaleString('id-ID');
function slaRpShort(v) {
    const a = Math.abs(v || 0);
    if (a >= 1e9) return 'Rp ' + (v / 1e9).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + ' M';
    if (a >= 1e6) return 'Rp ' + (v / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' Jt';
    return slaRp(v);
}
const slaCanEdit = () => typeof userRole !== 'undefined' && (userRole === 'admin' || userRole === 'editor');
const slaIsAdmin = () => typeof userRole !== 'undefined' && userRole === 'admin';
const slaBranch = () => (typeof selectedBranch !== 'undefined' ? selectedBranch : 'Semua');

// ---------- Kaitan ke app.js (tanpa mengubah app.js) ----------
(function hookApp() {
    if (typeof setupUserAccess === 'function') {
        const orig = setupUserAccess;
        setupUserAccess = async function (user) { await orig(user); await slaLoad(); };
    }
    if (typeof selectBranch === 'function') {
        const origSel = selectBranch;
        selectBranch = function (b) { origSel(b); slaRender(); };
    }
})();

// ---------- Ambil data ----------
async function slaFetchAll(table, orderCol) {
    const out = [], size = 1000;
    for (let from = 0; ; from += size) {
        const { data, error } = await supabaseClient.from(table).select('*').order(orderCol, { ascending: true }).range(from, from + size - 1);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < size) break;
    }
    return out;
}

async function slaLoad() {
    const host = document.getElementById('slaSection');
    if (!host) return;
    try {
        const [bands, units, avs] = await Promise.all([
            slaFetchAll('sla_band', 'batas'), slaFetchAll('kontrak_unit', 'id'), slaFetchAll('availability_bulanan', 'id')]);
        if (bands.length) slaBands = bands.map(b => ({ batas: +b.batas, faktor: +b.faktor })).sort((a, b) => a.batas - b.batas);
        slaUnits = units.map(u => ({ ...u, harga_bulanan: +u.harga_bulanan || 0 }))
            .sort((a, b) => (a.urutan ?? 1e9) - (b.urutan ?? 1e9) || a.id - b.id);
        slaAv = new Map();
        avs.forEach(r => slaAv.set(slaKey(r.unit_id, r.tahun, r.bulan), {
            ...r, availability: r.availability === null ? null : +r.availability, utilisasi: r.utilisasi === null ? null : +r.utilisasi }));
        slaState.error = null;
        if (!slaState.tahun) {
            const last = slaLatestPeriod();
            slaState.tahun = last.tahun; slaState.bulan = last.bulan;
        }
    } catch (e) {
        console.error(e);
        slaState.error = e.message || String(e);
    }
    slaState.ready = true;
    slaRender();
}

function slaLatestPeriod() {
    // Bulan terakhir yang sudah diisi oleh sebagian besar unit (≥ 50% dari bulan terlengkap),
    // supaya dashboard tidak membuka bulan yang baru diisi satu terminal.
    const cnt = new Map();
    slaAv.forEach(r => { if (r.availability !== null) { const k = r.tahun * 12 + r.bulan - 1; cnt.set(k, (cnt.get(k) || 0) + 1); } });
    if (!cnt.size) { const now = new Date(); return { tahun: now.getFullYear(), bulan: now.getMonth() + 1 }; }
    const max = Math.max(...cnt.values());
    const k = Math.max(...[...cnt.entries()].filter(([, n]) => n >= max * 0.5).map(([k]) => k));
    return { tahun: Math.floor(k / 12), bulan: (k % 12) + 1 };
}

// ---------- Perhitungan ----------
function slaBandFactor(av) {
    let f = slaBands[0] ? slaBands[0].faktor : 0;
    for (const b of slaBands) if (av >= b.batas - 1e-12) f = b.faktor;
    return f;
}
function slaAvOf(unitId, y, m) {
    const r = slaAv.get(slaKey(unitId, y, m));
    return r && r.availability !== null && r.availability !== undefined ? r.availability : null;
}
function slaUtOf(unitId, y, m) {
    const r = slaAv.get(slaKey(unitId, y, m));
    return r && r.utilisasi !== null && r.utilisasi !== undefined ? r.utilisasi : null;
}
// Kategori unit kontrak: ikut data alat SIMALAT bila tertaut, selain itu dari kode jenis.
function slaKategori(u) {
    if (u.peralatan_id && typeof rawData !== 'undefined') {
        const a = rawData.find(d => d.id === u.peralatan_id);
        if (a && a.kategori4) return a.kategori4;
    }
    const j = String(u.jenis || '').toUpperCase();
    if (['QCC', 'GLC', 'GJC', 'FJC'].includes(j)) return 'Alat Utama Dermaga';
    if (['RTG', 'RMGC'].includes(j)) return 'Alat Utama Lapangan';
    if (['HDT', 'TTR'].includes(j)) return 'Alat Angkut';
    return 'Alat Pendukung';
}
function slaUtTone(ut) {
    return ut === null || ut === undefined ? 'color:#94a3b8' : 'color:#0f766e';
}
function slaPrev(y, m) { return m === 1 ? [y - 1, 12] : [y, m - 1]; }

// Hasil satu unit pada satu bulan, atau null bila belum ada data.
function slaCell(unit, y, m) {
    const av = slaAvOf(unit.id, y, m);
    if (av === null) return null;
    let faktor = slaBandFactor(av), nolBeruntun = 0;
    if (av === 0) {
        nolBeruntun = 1;
        let [py, pm] = slaPrev(y, m);
        while (nolBeruntun < SLA_ZERO_LIMIT && slaAvOf(unit.id, py, pm) === 0) { nolBeruntun++; [py, pm] = slaPrev(py, pm); }
        if (nolBeruntun >= SLA_ZERO_LIMIT) faktor = 0;
    }
    const r = slaAv.get(slaKey(unit.id, y, m));
    const harga = unit.harga_bulanan;
    return { av, util: r.utilisasi, faktor, nolBeruntun, harga, biaya: harga * faktor, penuh: harga, potongan: harga * (1 - faktor) };
}

function slaMonthsOfPeriod() {
    return slaState.mode === 'kumulatif' ? Array.from({ length: slaState.bulan }, (_, i) => i + 1) : [slaState.bulan];
}
function slaUnitsInScope(branch = slaBranch()) {
    return slaUnits.filter(u => u.aktif !== false && (branch === 'Semua' || u.terminal === branch));
}

// Ringkasan sekumpulan unit pada sekumpulan bulan.
function slaSummarize(units, y, months) {
    const s = { unit: units.length, unitData: 0, nCell: 0, sumAv: 0, nUt: 0, sumUt: 0, unitUt: 0, biaya: 0, penuh: 0, potongan: 0, bawahTarget: 0, tidakDibayar: 0, nolSeri: 0 };
    units.forEach(u => {
        let has = false, uSum = 0, uN = 0, tSum = 0, tN = 0;
        months.forEach(m => {
            const ut = slaUtOf(u.id, y, m);
            if (ut !== null) { s.nUt++; s.sumUt += ut; tSum += ut; tN++; }
            const c = slaCell(u, y, m);
            if (!c) return;
            has = true; uSum += c.av; uN++;
            s.nCell++; s.sumAv += c.av; s.biaya += c.biaya; s.penuh += c.penuh; s.potongan += c.potongan;
            if (c.faktor === 0) s.tidakDibayar++;
            if (c.av === 0 && c.nolBeruntun >= 2 && c.faktor > 0) s.nolSeri++;
        });
        if (has) { s.unitData++; if (uSum / uN < 0.85 - 1e-12) s.bawahTarget++; }
        if (tN) s.unitUt++;
    });
    s.avgAv = s.nCell ? s.sumAv / s.nCell : null;
    s.avgUt = s.nUt ? s.sumUt / s.nUt : null;
    s.pctPotongan = s.penuh ? s.potongan / s.penuh : null;
    return s;
}

function slaYears() {
    const ys = new Set([new Date().getFullYear()]);
    slaAv.forEach(r => ys.add(r.tahun));
    if (slaState.tahun) ys.add(slaState.tahun);
    return [...ys].sort((a, b) => b - a);
}

function slaTone(av, faktor) {
    if (av === null || av === undefined) return 'background:#f1f5f9;color:#94a3b8';
    if (faktor === 0) return 'background:#7f1d1d;color:#fff';
    if (av >= 0.85 - 1e-12) return 'background:#dcfce7;color:#14532d';
    if (av >= 0.64 - 1e-12) return 'background:#fef9c3;color:#713f12';
    if (av >= 0.35 - 1e-12) return 'background:#ffedd5;color:#9a3412';
    return 'background:#fee2e2;color:#991b1b';
}

// ---------- Tampilan ----------
function slaRender() {
    const host = document.getElementById('slaSection');
    if (!host || !slaState.ready) return;
    const branch = slaBranch();
    const head = `
        <div class="section-head flex-wrap">
            <span class="no">5</span>
            <h2>Availability &amp; Biaya SLA</h2>
            <span class="ml-auto text-xs font-bold text-slate-700">${branch === 'Semua' ? 'Seluruh terminal' : slaEsc(branch)}</span>
        </div>`;

    if (slaState.error) {
        host.innerHTML = head + `<div class="card p-4 text-xs text-slate-600">
            <p class="font-bold text-rose-700 mb-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Data SLA belum dapat dimuat.</p>
            <p>Pastikan file <b>simalat_sla_availability.sql</b> sudah dijalankan di Supabase › SQL Editor. Pesan: <span class="font-mono">${slaEsc(slaState.error)}</span></p></div>`;
        return;
    }
    if (!slaUnits.length) {
        host.innerHTML = head + `<div class="card p-4 text-xs text-slate-600">Belum ada unit kontrak. Jalankan <b>simalat_sla_availability.sql</b> di Supabase.</div>`;
        return;
    }

    const y = slaState.tahun, months = slaMonthsOfPeriod();
    const units = slaUnitsInScope(branch);
    const S = slaSummarize(units, y, months);
    const periodText = slaState.mode === 'kumulatif'
        ? `Jan – ${SLA_BULAN[slaState.bulan - 1]} ${y}` : `${SLA_BULAN_PANJANG[slaState.bulan - 1]} ${y}`;

    const yearOpts = slaYears().map(t => `<option value="${t}" ${t === y ? 'selected' : ''}>${t}</option>`).join('');
    const monthOpts = SLA_BULAN_PANJANG.map((b, i) => `<option value="${i + 1}" ${i + 1 === slaState.bulan ? 'selected' : ''}>${b}</option>`).join('');

    const toolbar = `
        <div class="card px-4 py-3 mb-3 flex flex-wrap items-center gap-2">
            <span class="eyebrow mr-1">Periode</span>
            <select id="slaTahun" onchange="slaSetPeriod()" class="control">${yearOpts}</select>
            <select id="slaBulan" onchange="slaSetPeriod()" class="control">${monthOpts}</select>
            <div class="inline-flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
                <button onclick="slaSetMode('bulan')" class="px-3 py-1.5 cursor-pointer ${slaState.mode === 'bulan' ? 'tab-active' : 'tab-inactive'}">Bulan ini</button>
                <button onclick="slaSetMode('kumulatif')" class="px-3 py-1.5 cursor-pointer ${slaState.mode === 'kumulatif' ? 'tab-active' : 'tab-inactive'}">Kumulatif Jan–${SLA_BULAN[slaState.bulan - 1]}</button>
            </div>
            <div class="ml-auto flex gap-2">
                ${slaCanEdit() ? `<button id="btnSlaInput" onclick="slaOpenInput()" class="bg-blue-700 hover:bg-blue-800 text-white px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"><i class="fa-solid fa-pen-to-square mr-1.5"></i>Input Availability</button>` : ''}
                <button id="btnSlaExcel" onclick="slaExportExcel(this)" class="bg-emerald-700 hover:bg-emerald-800 text-white px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"><i class="fa-solid fa-file-excel mr-1.5"></i>Excel SLA ${y}</button>
            </div>
        </div>`;

    const kpi = (label, value, sub, tone = 'text-slate-900', icon = '') => `
        <div class="card p-4">
            <div class="flex justify-between items-start"><p class="eyebrow">${label}</p>${icon}</div>
            <h3 class="text-2xl font-extrabold num mt-2 ${tone}">${value}</h3>
            <p class="text-[11px] text-slate-500 mt-1 num">${sub}</p>
        </div>`;
    const avTone = S.avgAv === null ? 'text-slate-400' : S.avgAv >= 0.85 ? 'text-emerald-700' : S.avgAv >= 0.64 ? 'text-amber-600' : 'text-rose-700';
    const kpis = `
        <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-3">
            ${kpi('Rata-rata availability', slaPct(S.avgAv), `${periodText} · target ≥ 85%`, avTone, '<i class="fa-solid fa-gauge-high text-slate-400"></i>')}
            ${kpi('Rata-rata utilisasi', slaPct(S.avgUt), S.nUt ? `${periodText} · ${S.unitUt} unit berdata` : 'belum diisi — isi lewat Input Availability', S.avgUt === null ? 'text-slate-400' : '', '<i class="fa-solid fa-gears text-slate-400"></i>').replace('num mt-2 ">', `num mt-2" style="${slaUtTone(S.avgUt)}">`)}
            ${kpi('Unit di bawah 85%', `${S.bawahTarget}<span class="text-sm font-semibold text-slate-400"> / ${S.unitData}</span>`, `unit berdata · ${S.unit} unit kontrak`, S.bawahTarget ? 'text-amber-600' : 'text-slate-900', '<i class="fa-solid fa-arrow-trend-down text-slate-400"></i>')}
            ${kpi('Biaya dibayar', slaRpShort(S.biaya), `dari nilai penuh ${slaRpShort(S.penuh)}`, 'text-slate-900', '<i class="fa-solid fa-money-bill-wave text-slate-400"></i>')}
            ${kpi('Potongan SLA', slaRpShort(S.potongan), `${slaPct(S.pctPotongan, 2)} dari nilai penuh`, S.potongan ? 'text-rose-700' : 'text-slate-900', '<i class="fa-solid fa-scissors text-slate-400"></i>')}
            ${kpi('Tidak dibayar (0%)', `${S.tidakDibayar}`, S.nolSeri ? `${S.nolSeri} unit-bulan sudah 0% 2× beruntun` : `unit-bulan 0% ke-${SLA_ZERO_LIMIT} beruntun`, S.tidakDibayar ? 'text-rose-800' : 'text-slate-900', '<i class="fa-solid fa-ban text-slate-400"></i>')}
        </div>`;

    host.innerHTML = head + toolbar + kpis + `
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-3 mb-3">
            <div class="card p-4 ${branch === 'Semua' ? 'lg:col-span-3' : 'lg:col-span-5'} overflow-x-auto">${branch === 'Semua' ? slaAreaTable(y, months) : slaUnitTable(units, y, months)}</div>
            <div class="card p-4 ${branch === 'Semua' ? 'lg:col-span-2' : 'lg:col-span-5'}">
                <p class="eyebrow mb-2">Biaya &amp; potongan per bulan · ${branch === 'Semua' ? 'seluruh terminal' : slaEsc(branch)} · ${y}</p>
                <div style="height:${branch === 'Semua' ? 300 : 240}px"><canvas id="slaChart"></canvas></div>
            </div>
        </div>
        <div class="card p-4 mb-3">${slaKategoriCard(units, y, months)}</div>
        ${branch === 'Semua' ? `<div class="card p-4 overflow-x-auto mb-3">${slaHeatmapAreas(y)}</div>` : ''}
        <details class="card px-4 py-3 text-xs text-slate-600">
            <summary class="font-bold text-slate-800 cursor-pointer">Aturan perhitungan SLA (sesuai kontrak)</summary>
            <ul class="mt-2 space-y-1 list-disc pl-5">
                <li><b>Faktor bayar</b> per unit per bulan: ${slaBands.slice().reverse().map(b => `availability ≥ ${slaPct(b.batas, 0)} → ${slaPct(b.faktor, 0)}`).join(' · ')}.</li>
                <li><b>Biaya dibayar</b> = harga unit per bulan × faktor bayar. <b>Potongan</b> = nilai penuh − biaya dibayar.</li>
                <li><b>Availability 0%</b> tiga bulan berturut-turut: bulan ke-1 dan ke-2 tetap dibayar 50%, bulan ke-3 dan seterusnya <b>tidak dibayar</b> (faktor 0) sampai availability kembali di atas 0%.</li>
                <li>Bulan yang belum diisi tidak ditagihkan dan tidak dihitung dalam rata-rata maupun nilai penuh.</li>
                <li>Rata-rata availability = rata-rata sederhana seluruh unit-bulan yang berdata pada periode terpilih.</li>
                <li><b>Utilisasi</b> = jam alat dipakai ÷ jam alat tersedia, ditampilkan sebagai persen saja (tanpa target SLA) dan tidak memengaruhi biaya kontrak. Rata-rata utilisasi = rata-rata sederhana unit-bulan yang sudah diisi.</li>
            </ul>
        </details>`;

    slaDrawChart(units, y);
}

function slaAreaTable(y, months) {
    const rows = TERMINALS.map(t => ({ t, s: slaSummarize(slaUnitsInScope(t), y, months) }));
    const tot = slaSummarize(slaUnitsInScope('Semua'), y, months);
    const tr = (name, s, click, bold) => `
        <tr class="${click ? 'cursor-pointer hover:bg-blue-50/60' : 'bg-slate-50 font-bold'}" ${click ? `onclick="selectBranch('${name}')" title="Lihat detail unit ${slaEsc(name)}"` : ''}>
            <td class="px-2 py-2 ${bold ? '' : 'font-semibold text-slate-800'}">${slaEsc(name)}</td>
            <td class="px-2 py-2 text-center num">${s.unitData}/${s.unit}</td>
            <td class="px-2 py-2 text-center num"><span class="px-1.5 py-0.5 rounded" style="${slaTone(s.avgAv, 1)}">${slaPct(s.avgAv)}</span></td>
            <td class="px-2 py-2 text-center num font-semibold" style="${slaUtTone(s.avgUt)}">${slaPct(s.avgUt)}</td>
            <td class="px-2 py-2 text-center num">${s.bawahTarget}</td>
            <td class="px-2 py-2 text-right num whitespace-nowrap">${slaRp(s.biaya)}</td>
            <td class="px-2 py-2 text-right num whitespace-nowrap ${s.potongan ? 'text-rose-700' : ''}">${slaRp(s.potongan)}</td>
            <td class="px-2 py-2 text-right num">${slaPct(s.pctPotongan, 2)}</td>
        </tr>`;
    return `
        <p class="eyebrow mb-2">Rekap per area · klik baris untuk detail unit · nilai penuh ada di Excel SLA</p>
        <table class="w-full text-xs border-collapse">
            <thead class="text-[10.5px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                <tr><th class="px-2 py-2 text-left">Area</th><th class="px-2 py-2">Unit berdata</th><th class="px-2 py-2">Avail.</th><th class="px-2 py-2">Util.</th><th class="px-2 py-2">&lt; 85%</th>
                    <th class="px-2 py-2 text-right">Dibayar</th><th class="px-2 py-2 text-right">Potongan</th><th class="px-2 py-2 text-right">%</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-100">${rows.map(r => tr(r.t, r.s, true)).join('')}${tr('Total', tot, false, true)}</tbody>
        </table>`;
}

function slaKategoriCard(units, y, months) {
    const rows = SLA_KATEGORI.map(k => ({ k, s: slaSummarize(units.filter(u => slaKategori(u) === k), y, months) })).filter(r => r.s.unit);
    const tot = slaSummarize(units, y, months);
    const bar = (v, color, label) => `
        <div class="flex items-center gap-2">
            <span class="w-16 text-[10px] text-slate-500">${label}</span>
            <div class="flex-1 h-2.5 rounded-full bg-slate-100 overflow-hidden relative">
                <div class="h-full rounded-full" style="width:${v === null ? 0 : Math.min(100, v * 100)}%;background:${color}"></div>
                ${label === 'Availability' ? '<div class="absolute top-0 bottom-0 w-px bg-slate-900/40" style="left:85%"></div>' : ''}
            </div>
            <span class="w-12 text-right text-[11px] font-bold num" style="${label === 'Availability' ? '' : slaUtTone(v)}">${slaPct(v)}</span>
        </div>`;
    const tr = (name, s, color, isTot) => `
        <tr class="${isTot ? 'bg-slate-50 font-bold' : ''}">
            <td class="px-2 py-2.5 whitespace-nowrap"><span class="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle" style="background:${color}"></span><span class="font-semibold text-slate-800">${name}</span>
                <div class="text-[10.5px] text-slate-500 font-normal num pl-4">${s.unit} unit kontrak</div></td>
            <td class="px-2 py-2.5 min-w-[260px] space-y-1">${bar(s.avgAv, '#1e3a8a', 'Availability')}${bar(s.avgUt, '#0d9488', 'Utilisasi')}</td>
            <td class="px-2 py-2.5 text-[11px] num">${s.avgAv !== null && s.avgUt !== null ? `<span class="font-bold">${((s.avgAv - s.avgUt) * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 })} poin</span><div class="text-[10px] text-slate-500">kapasitas siap belum terpakai</div>` : '–'}</td>
            <td class="px-2 py-2.5 text-right num whitespace-nowrap">${slaRp(s.biaya)}</td>
            <td class="px-2 py-2.5 text-right num whitespace-nowrap ${s.potongan ? 'text-rose-700' : 'text-slate-400'}">${slaRp(s.potongan)}</td>
        </tr>`;
    return `
        <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
            <p class="eyebrow">Availability vs utilisasi per kategori alat · ${slaBranch() === 'Semua' ? 'seluruh terminal' : slaEsc(slaBranch())}</p>
            <span class="text-[10.5px] text-slate-500">Garis tipis = target availability 85%</span>
        </div>
        <div class="overflow-x-auto"><table class="w-full text-xs border-collapse">
            <thead class="text-[10.5px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                <tr><th class="px-2 py-2 text-left">Kategori</th><th class="px-2 py-2 text-left">Rata-rata availability &amp; utilisasi</th><th class="px-2 py-2 text-left">Selisih</th>
<th class="px-2 py-2 text-right">Dibayar</th><th class="px-2 py-2 text-right">Potongan</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-100">${rows.map(r => tr(r.k, r.s, SLA_KAT_COLOR[r.k], false)).join('')}${tr('Rata-rata semua kategori', tot, '#0f172a', true)}</tbody>
        </table></div>`;
}

// ---------- Sel grid (dipakai peta area & detail unit) ----------
// Tampilan: 'av' = availability, 'ut' = utilisasi, 'both' = keduanya (dua baris rapi, tinggi sama).
function slaUtFill(ut) {
    if (ut === null || ut === undefined) return 'background:#f1f5f9;color:#94a3b8';
    const steps = [[0.8, '#14b8a6', '#fff'], [0.6, '#5eead4', '#134e4a'], [0.4, '#99f6e4', '#134e4a'], [0.2, '#ccfbf1', '#134e4a'], [0, '#f0fdfa', '#134e4a']];
    const [, bg, fg] = steps.find(([b]) => ut >= b - 1e-12);
    return `background:${bg};color:${fg}`;
}
function slaGridCell({ av, faktor = 1, ut, tip, click }) {
    const view = slaState.view;
    const act = click ? `onclick="${click}" role="button" tabindex="0"` : '';
    const base = `sla-cell num${click ? ' sla-cell-edit' : ''}`;
    if (view === 'ut') {
        return `<td class="${base}" style="${slaUtFill(ut)}" title="${slaEsc(tip)}" ${act}><span class="sla-v">${ut === null || ut === undefined ? '' : slaPct(ut, 0)}</span></td>`;
    }
    const top = av === null || av === undefined ? '' : `<span class="sla-v">${slaPct(av, 0)}</span>`;
    if (view === 'av') return `<td class="${base}" style="${slaTone(av, faktor)}" title="${slaEsc(tip)}" ${act}>${top}</td>`;
    const has = (av !== null && av !== undefined) || (ut !== null && ut !== undefined);
    const w = ut === null || ut === undefined ? 0 : Math.max(2, Math.min(100, ut * 100));
    const sub = ut === null || ut === undefined ? '' : `<span class="sla-u">U ${slaPct(ut, 0)}</span><span class="sla-bar"><i style="width:${w}%"></i></span>`;
    return `<td class="${base} sla-both" style="${slaTone(av, faktor)}" title="${slaEsc(tip)}" ${act}>${top || (has ? '<span class="sla-v opacity-40">–</span>' : '')}${sub}</td>`;
}
function slaViewToggle() {
    const b = (v, t) => `<button onclick="slaSetView('${v}')" class="px-2.5 py-1 cursor-pointer ${slaState.view === v ? 'tab-active' : 'tab-inactive'}">${t}</button>`;
    return `<div class="inline-flex rounded-lg border border-slate-200 overflow-hidden text-[11px] font-semibold">${b('av', 'Availability')}${b('ut', 'Utilisasi')}${b('both', 'Keduanya')}</div>`;
}
function slaSetView(v) { slaState.view = v; slaRender(); }

function slaHeatmapAreas(y) {
    const cells = TERMINALS.map(t => {
        const us = slaUnitsInScope(t);
        const tds = SLA_BULAN.map((_, i) => {
            const s = slaSummarize(us, y, [i + 1]);
            return slaGridCell({ av: s.avgAv, ut: s.avgUt, tip: `${t} · ${SLA_BULAN_PANJANG[i]}: availability ${slaPct(s.avgAv, 2)} · utilisasi ${slaPct(s.avgUt, 2)} · dibayar ${slaRp(s.biaya)}` });
        }).join('');
        return `<tr class="cursor-pointer sla-row" onclick="selectBranch('${t}')" title="Lihat detail unit ${slaEsc(t)}"><td class="px-2 text-xs font-semibold text-slate-800 whitespace-nowrap">${slaEsc(t)}</td>${tds}</tr>`;
    }).join('');
    return `
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
            <p class="eyebrow">Peta ${slaViewLabel()} per area per bulan · ${y}</p>
            <div class="flex flex-wrap items-center gap-3">${slaLegend()}${slaViewToggle()}</div>
        </div>
        <table class="w-full sla-grid">
            <thead><tr><th class="w-32"></th>${slaMonthHeads(slaMonthsOfPeriod())}</tr></thead>
            <tbody>${cells}</tbody>
        </table>`;
}
function slaViewLabel() { return { av: 'availability', ut: 'utilisasi', both: 'availability &amp; utilisasi' }[slaState.view]; }
function slaMonthHeads(months) {
    return SLA_BULAN.map((b, i) => `<th><span class="sla-mh ${months.includes(i + 1) ? 'sla-mh-on' : ''}">${b}</span></th>`).join('');
}

function slaLegend() {
    const item = (st, t) => `<span class="inline-flex items-center gap-1.5"><span class="w-3 h-3 rounded inline-block ring-1 ring-black/5" style="${st}"></span>${t}</span>`;
    if (slaState.view === 'ut') {
        return `<div class="flex items-center gap-2 text-[10.5px] text-slate-500">Utilisasi
            <span class="inline-flex rounded overflow-hidden ring-1 ring-black/5">${[0.1, 0.3, 0.5, 0.7, 0.9].map(v => `<span class="w-5 h-3" style="${slaUtFill(v)}"></span>`).join('')}</span>
            <span class="num">0% → 100%</span>${item(slaUtFill(null), 'Belum diisi')}</div>`;
    }
    return `<div class="flex flex-wrap gap-3 text-[10.5px] text-slate-500">
        ${item(slaTone(0.9, 1), '≥ 85%')}${item(slaTone(0.7, 1), '64–85%')}${item(slaTone(0.5, 1), '35–64%')}${item(slaTone(0.1, 1), '< 35%')}${item(slaTone(0, 0), 'Tidak dibayar')}${item(slaTone(null), 'Belum diisi')}
        ${slaState.view === 'both' ? '<span class="inline-flex items-center gap-1.5"><span class="sla-bar inline-block w-6 !static"><i style="width:60%"></i></span>Utilisasi</span>' : ''}</div>`;
}

function slaUnitTable(units, y, months) {
    const edit = slaCanEdit();
    const rows = units.map((u, idx) => {
        let biaya = 0, penuh = 0;
        const tds = SLA_BULAN.map((_, i) => {
            const c = slaCell(u, y, i + 1), ut = slaUtOf(u.id, y, i + 1);
            if (c && months.includes(i + 1)) { biaya += c.biaya; penuh += c.penuh; }
            const tip = (c ? `${SLA_BULAN_PANJANG[i]}: availability ${slaPct(c.av, 2)} · faktor bayar ${slaPct(c.faktor, 0)} · dibayar ${slaRp(c.biaya)}${c.av === 0 ? ` · 0% ke-${c.nolBeruntun} beruntun` : ''}` : `${SLA_BULAN_PANJANG[i]}: availability belum diisi`) + ` · utilisasi ${slaPct(ut, 2)}${edit ? ' · klik untuk edit' : ''}`;
            return slaGridCell({ av: c ? c.av : null, faktor: c ? c.faktor : 1, ut, tip, click: edit ? `slaOpenCellEdit(${u.id},${y},${i + 1})` : '' });
        }).join('');
        const link = u.nomor_alat ? `<span class="font-mono text-[10px] text-slate-500">${slaEsc(u.nomor_alat)}</span>` : '';
        const cek = u.perlu_cek || !u.peralatan_id ? ' <span class="text-[9px] font-bold text-amber-700 bg-amber-100 px-1 rounded" title="Belum tertaut ke database alat">cek</span>' : '';
        return `<tr class="sla-row">
            <td class="px-1.5 text-slate-400 num text-[11px]">${idx + 1}</td>
            <td class="px-1.5"><div class="font-semibold text-slate-800 text-[11.5px] leading-tight max-w-[230px] truncate" title="${slaEsc(u.nama_unit)}">${slaEsc(u.nama_unit)}</div>${link}${cek}</td>
            ${tds}
            <td class="px-2 text-right num whitespace-nowrap text-[11.5px]">${penuh ? slaRp(biaya) : '–'}</td>
            <td class="px-2 text-right num whitespace-nowrap text-[11.5px] ${penuh - biaya > 0 ? 'text-rose-700' : 'text-slate-400'}">${penuh ? slaRp(penuh - biaya) : '–'}</td>
        </tr>`;
    }).join('');
    return `
        <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
            <p class="eyebrow">Detail per unit · ${slaEsc(slaBranch())} · ${y}</p>
            <button onclick="selectBranch('Semua')" class="text-[11px] font-semibold text-blue-700 hover:underline cursor-pointer"><i class="fa-solid fa-arrow-left mr-1"></i>Semua area</button>
        </div>
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">${slaLegend()}${slaViewToggle()}</div>
        <div class="overflow-auto max-h-[560px]">
        <table class="w-full sla-grid">
            <thead class="sticky top-0 bg-white z-10"><tr><th class="w-6 text-left text-[10.5px] text-slate-400 font-semibold">No</th><th class="text-left text-[10.5px] text-slate-400 font-semibold uppercase tracking-wider">Unit kontrak</th>${slaMonthHeads(months)}
                <th class="text-right text-[10.5px] text-slate-400 font-semibold uppercase tracking-wider px-2">Dibayar*</th><th class="text-right text-[10.5px] text-slate-400 font-semibold uppercase tracking-wider px-2">Potongan*</th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div>
        <p class="text-[10.5px] text-slate-400 mt-2">* untuk periode terpilih (bulan bertanda gelap).${edit ? ' Klik kotak bulan untuk mengedit availability &amp; utilisasi unit tersebut.' : ' Arahkan kursor ke kotak bulan untuk faktor bayar.'}</p>`;
}

// ---------- Edit cepat satu unit-bulan (klik kotak) ----------
function slaEnsureCellModal() {
    if (document.getElementById('slaCellModal')) return;
    const st = document.createElement('style');
    st.textContent = '';
    const div = document.createElement('div');
    div.id = 'slaCellModal';
    div.className = 'fixed inset-0 bg-slate-950/50 backdrop-blur-sm z-50 hidden items-center justify-center p-3';
    div.onclick = e => { if (e.target === div) slaCloseCellEdit(); };
    div.innerHTML = `
        <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div class="px-5 py-4 bg-slate-900 text-white flex items-start justify-between gap-3">
                <div><p class="text-[10.5px] font-bold tracking-wider uppercase text-amber-300" id="slaCeWhen"></p>
                    <h3 class="font-extrabold leading-tight mt-0.5" id="slaCeName"></h3>
                    <p class="text-[11px] text-slate-400 font-mono" id="slaCeNo"></p></div>
                <button onclick="slaCloseCellEdit()" class="text-slate-400 hover:text-white cursor-pointer text-lg"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="p-5 space-y-4">
                <div class="grid grid-cols-2 gap-3">
                    <div><label class="field-label" for="slaCeAv">Availability (%)</label>
                        <input id="slaCeAv" inputmode="decimal" class="field num text-right !text-lg !font-bold" placeholder="contoh 95,15" oninput="slaCePreview()"></div>
                    <div><label class="field-label" for="slaCeUt">Utilisasi (%)</label>
                        <input id="slaCeUt" inputmode="decimal" class="field num text-right !text-lg !font-bold" placeholder="opsional" oninput="slaCePreview()"></div>
                </div>
                <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 grid grid-cols-3 gap-2 text-center">
                    <div><p class="eyebrow !text-[9.5px]">Faktor bayar</p><p id="slaCeF" class="font-extrabold text-slate-900 num mt-0.5">–</p></div>
                    <div><p class="eyebrow !text-[9.5px]">Dibayar</p><p id="slaCeB" class="font-extrabold text-slate-900 num mt-0.5">–</p></div>
                    <div><p class="eyebrow !text-[9.5px]">Potongan</p><p id="slaCeP" class="font-extrabold text-rose-700 num mt-0.5">–</p></div>
                </div>
                <p id="slaCeNote" class="text-[11px] text-slate-500"></p>
            </div>
            <div class="px-5 py-3 border-t border-slate-100 flex items-center gap-2">
                <button id="slaCeDel" onclick="slaCellDelete()" class="px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 rounded-lg cursor-pointer"><i class="fa-solid fa-trash-can mr-1"></i>Hapus data bulan ini</button>
                <div class="ml-auto flex gap-2">
                    <button onclick="slaCloseCellEdit()" class="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer">Batal</button>
                    <button id="slaCeSave" onclick="slaCellSave()" class="px-5 py-2 text-xs font-bold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"><i class="fa-solid fa-floppy-disk mr-1"></i>Simpan</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(div);
    div.addEventListener('keydown', e => { if (e.key === 'Enter') slaCellSave(); if (e.key === 'Escape') slaCloseCellEdit(); });
}
let slaCe = null;
function slaOpenCellEdit(unitId, y, m) {
    if (!slaCanEdit()) return;
    slaEnsureCellModal();
    const u = slaUnits.find(x => x.id === unitId), r = slaAv.get(slaKey(unitId, y, m));
    slaCe = { u, y, m, row: r };
    document.getElementById('slaCeWhen').textContent = `${SLA_BULAN_PANJANG[m - 1]} ${y} · ${u.terminal}`;
    document.getElementById('slaCeName').textContent = u.nama_unit;
    document.getElementById('slaCeNo').textContent = (u.nomor_alat || '') + ' · harga ' + slaRp(u.harga_bulanan) + '/bulan';
    document.getElementById('slaCeAv').value = slaFmtIn(r ? r.availability : null);
    document.getElementById('slaCeUt').value = slaFmtIn(r ? r.utilisasi : null);
    document.getElementById('slaCeDel').style.visibility = r ? 'visible' : 'hidden';
    const md = document.getElementById('slaCellModal');
    md.classList.remove('hidden'); md.style.display = 'flex';
    slaCePreview();
    setTimeout(() => { const i = document.getElementById('slaCeAv'); i.focus(); i.select(); }, 30);
}
function slaCloseCellEdit() {
    const md = document.getElementById('slaCellModal');
    if (md) { md.classList.add('hidden'); md.style.display = 'none'; }
}
function slaCePreview() {
    const { u, y, m } = slaCe;
    const av = slaParseIn(document.getElementById('slaCeAv').value), ut = slaParseIn(document.getElementById('slaCeUt').value);
    const set = (id, t) => document.getElementById(id).textContent = t;
    const note = document.getElementById('slaCeNote');
    note.className = 'text-[11px] text-slate-500';
    if (av.error || ut.error) { set('slaCeF', '–'); set('slaCeB', '–'); set('slaCeP', '–'); note.textContent = 'Isi angka 0–100.'; note.className = 'text-[11px] text-rose-600 font-semibold'; return; }
    if (av.empty) { set('slaCeF', '–'); set('slaCeB', 'Rp 0'); set('slaCeP', '–'); note.textContent = 'Availability kosong = belum ada data, bulan ini tidak ditagihkan.'; return; }
    let f = slaBandFactor(av.value), streak = 0;
    if (av.value === 0) {
        streak = 1; let [py, pm] = slaPrev(y, m);
        while (streak < SLA_ZERO_LIMIT && slaAvOf(u.id, py, pm) === 0) { streak++; [py, pm] = slaPrev(py, pm); }
        if (streak >= SLA_ZERO_LIMIT) f = 0;
    }
    set('slaCeF', slaPct(f, 0)); set('slaCeB', slaRpShort(u.harga_bulanan * f)); set('slaCeP', slaRpShort(u.harga_bulanan * (1 - f)));
    note.textContent = av.value === 0 ? (f === 0 ? `0% bulan ke-${streak} berturut-turut → tidak dibayar.` : `0% bulan ke-${streak} berturut-turut → masih dibayar ${slaPct(f, 0)}.`) : '';
}
async function slaCellPersist(fn) {
    const btn = document.getElementById('slaCeSave'), orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>Menyimpan…';
    try { await fn(); slaCloseCellEdit(); await slaLoad(); }
    catch (e) { alert('Gagal menyimpan: ' + (e.message || e)); }
    finally { btn.disabled = false; btn.innerHTML = orig; }
}
function slaCellSave() {
    const { u, y, m, row } = slaCe;
    const av = slaParseIn(document.getElementById('slaCeAv').value), ut = slaParseIn(document.getElementById('slaCeUt').value);
    if (av.error || ut.error) { slaCePreview(); return; }
    if (av.empty && ut.empty) { if (row) slaCellDelete(); else slaCloseCellEdit(); return; }
    slaCellPersist(async () => {
        const { error } = await supabaseClient.from('availability_bulanan').upsert([{ unit_id: u.id, tahun: y, bulan: m, availability: av.empty ? null : av.value, utilisasi: ut.empty ? null : ut.value }], { onConflict: 'unit_id,tahun,bulan' });
        if (error) throw error;
    });
}
function slaCellDelete() {
    const { u, y, m, row } = slaCe;
    if (!row) { slaCloseCellEdit(); return; }
    if (!confirm(`Hapus availability & utilisasi ${u.nama_unit} bulan ${SLA_BULAN_PANJANG[m - 1]} ${y}?`)) return;
    slaCellPersist(async () => {
        const { error } = await supabaseClient.from('availability_bulanan').delete().in('id', [row.id]);
        if (error) throw error;
    });
}

// Gaya grid (disuntikkan sekali, tidak perlu mengubah index.html)
(function slaInjectStyle() {
    const css = `
    .sla-grid { border-collapse: separate; border-spacing: 3px; }
    .sla-grid thead th { font-weight: 600; padding: 0 0 4px; }
    .sla-mh { display: inline-block; min-width: 38px; padding: 3px 6px; border-radius: 6px; font-size: 10.5px; font-weight: 700; color: #64748b; letter-spacing: .02em; }
    .sla-mh-on { background: #0f172a; color: #fbbf24; }
    .sla-cell { height: 34px; min-width: 44px; padding: 0 4px; text-align: center; vertical-align: middle; border-radius: 7px; font-size: 11.5px; transition: box-shadow .12s, transform .12s; }
    .sla-cell .sla-v { font-weight: 700; letter-spacing: -.01em; }
    .sla-cell.sla-both { height: 44px; position: relative; padding-bottom: 6px; }
    .sla-cell.sla-both .sla-v { display: block; line-height: 1.05; }
    .sla-cell .sla-u { display: block; font-size: 9.5px; font-weight: 600; opacity: .72; line-height: 1.2; margin-top: 1px; }
    .sla-bar { position: absolute; left: 6px; right: 6px; bottom: 4px; height: 3px; border-radius: 3px; background: rgba(15,23,42,.10); overflow: hidden; }
    .sla-bar.\\!static { position: relative; left: auto; right: auto; bottom: auto; height: 4px; }
    .sla-bar i { display: block; height: 100%; background: #0d9488; border-radius: 3px; }
    .sla-cell-edit { cursor: pointer; }
    .sla-cell-edit:hover { box-shadow: 0 0 0 2px #2563eb inset; transform: translateY(-1px); }
    .sla-row > td:first-child, .sla-row > td:nth-child(2) { padding-top: 2px; padding-bottom: 2px; }
    tr.sla-row:hover > td.sla-cell { filter: saturate(1.15); }
    `;
    const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el);
})();

function slaDrawChart(units, y) {
    const cv = document.getElementById('slaChart');
    if (!cv || typeof Chart === 'undefined') return;
    if (slaChartInstance) { try { slaChartInstance.destroy(); } catch (e) { } }
    const per = SLA_BULAN.map((_, i) => slaSummarize(units, y, [i + 1]));
    const jt = v => Math.round(v / 1e6 * 10) / 10;
    slaChartInstance = new Chart(cv, {
        type: 'bar',
        data: {
            labels: SLA_BULAN,
            datasets: [
                { type: 'bar', label: 'Dibayar (Rp juta)', data: per.map(s => jt(s.biaya)), backgroundColor: '#1e3a8a', stack: 'b', yAxisID: 'y', borderRadius: 3 },
                { type: 'bar', label: 'Potongan (Rp juta)', data: per.map(s => jt(s.potongan)), backgroundColor: '#e11d48', stack: 'b', yAxisID: 'y', borderRadius: 3 },
                { type: 'line', label: 'Availability', data: per.map(s => s.avgAv === null ? null : Math.round(s.avgAv * 1000) / 10), borderColor: '#f59e0b', backgroundColor: '#f59e0b', yAxisID: 'y2', tension: .3, pointRadius: 3, spanGaps: false },
                { type: 'line', label: 'Utilisasi', data: per.map(s => s.avgUt === null ? null : Math.round(s.avgUt * 1000) / 10), borderColor: '#0d9488', backgroundColor: '#0d9488', borderDash: [5, 4], yAxisID: 'y2', tension: .3, pointRadius: 3, spanGaps: false }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
                tooltip: { callbacks: { label: c => c.dataset.yAxisID === 'y2' ? `${c.dataset.label}: ${c.raw ?? '–'}%` : `${c.dataset.label.replace(' (Rp juta)', '')}: Rp ${(c.raw || 0).toLocaleString('id-ID')} jt` } }
            },
            scales: {
                x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } },
                y: { stacked: true, beginAtZero: true, ticks: { font: { size: 10 }, callback: v => v.toLocaleString('id-ID') }, title: { display: true, text: 'Rp juta', font: { size: 10 } } },
                y2: { position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { font: { size: 10 }, callback: v => v + '%' } }
            }
        }
    });
}

function slaSetPeriod() {
    slaState.tahun = +document.getElementById('slaTahun').value;
    slaState.bulan = +document.getElementById('slaBulan').value;
    slaRender();
}
function slaSetMode(m) { slaState.mode = m; slaRender(); }

// ---------- Input availability (admin / editor) ----------
function slaEnsureModal() {
    if (document.getElementById('slaModal')) return;
    const div = document.createElement('div');
    div.id = 'slaModal';
    div.className = 'fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 hidden items-center justify-center p-3';
    div.innerHTML = `
        <div class="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col">
            <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <div><h3 class="font-extrabold text-slate-900">Input Availability Bulanan</h3>
                <p class="text-[11px] text-slate-500">Isi dalam persen (contoh 95,15). Kosongkan bila belum ada data. Tempel satu kolom dari Excel ke kotak pertama untuk mengisi ke bawah.</p></div>
                <button onclick="slaCloseInput()" class="text-slate-400 hover:text-slate-700 cursor-pointer text-lg"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="px-5 py-3 grid grid-cols-3 gap-2 border-b border-slate-100 bg-slate-50/70">
                <div><label class="field-label" for="slaInTerminal">Terminal</label><select id="slaInTerminal" class="field" onchange="slaFillInputRows()"></select></div>
                <div><label class="field-label" for="slaInTahun">Tahun</label><input id="slaInTahun" type="number" min="2000" max="2100" class="field num" onchange="slaFillInputRows()"></div>
                <div><label class="field-label" for="slaInBulan">Bulan</label><select id="slaInBulan" class="field" onchange="slaFillInputRows()">${SLA_BULAN_PANJANG.map((b, i) => `<option value="${i + 1}">${b}</option>`).join('')}</select></div>
            </div>
            <div class="overflow-auto flex-1 px-5 py-2">
                <table class="w-full text-xs">
                    <thead class="sticky top-0 bg-white text-[10.5px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                        <tr><th class="py-2 text-left w-8">No</th><th class="py-2 text-left">Unit kontrak</th><th class="py-2 text-right">Harga / bulan (Rp)</th>
                            <th class="py-2 w-28">Availability %</th><th class="py-2 w-24">Utilisasi %</th><th class="py-2 text-right w-36">Dibayar</th></tr>
                    </thead>
                    <tbody id="slaInRows" class="divide-y divide-slate-100"></tbody>
                </table>
            </div>
            <div class="px-5 py-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
                <span id="slaInTotal" class="text-xs font-semibold text-slate-700 num"></span>
                <div class="ml-auto flex gap-2">
                    <button onclick="slaCloseInput()" class="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer">Batal</button>
                    <button id="slaBtnSave" onclick="slaSaveInput()" class="px-5 py-2 text-xs font-bold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"><i class="fa-solid fa-floppy-disk mr-1"></i>Simpan</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(div);
}

function slaOpenInput() {
    if (!slaCanEdit()) return;
    slaEnsureModal();
    const branch = slaBranch();
    const terms = TERMINALS.filter(t => slaUnits.some(u => u.terminal === t));
    document.getElementById('slaInTerminal').innerHTML = terms.map(t => `<option ${t === (branch === 'Semua' ? terms[0] : branch) ? 'selected' : ''}>${t}</option>`).join('');
    document.getElementById('slaInTahun').value = slaState.tahun;
    document.getElementById('slaInBulan').value = slaState.bulan;
    slaFillInputRows();
    const m = document.getElementById('slaModal');
    m.classList.remove('hidden'); m.style.display = 'flex';
}
function slaCloseInput() {
    const m = document.getElementById('slaModal');
    if (m) { m.classList.add('hidden'); m.style.display = 'none'; }
}

const slaFmtIn = v => v === null || v === undefined ? '' : String(Math.round(v * 10000) / 100).replace('.', ',');
function slaParseIn(s) {
    s = String(s ?? '').trim().replace('%', '').replace(/\s/g, '');
    if (s === '') return { empty: true };
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '');
    s = s.replace(',', '.');
    const n = Number(s);
    if (!isFinite(n) || n < 0 || n > 100) return { error: true };
    return { value: Math.round(n * 100) / 10000 };   // persen → pecahan, 2 desimal persen
}

function slaFillInputRows() {
    const t = document.getElementById('slaInTerminal').value;
    const y = +document.getElementById('slaInTahun').value, m = +document.getElementById('slaInBulan').value;
    const admin = slaIsAdmin();
    const units = slaUnits.filter(u => u.terminal === t && u.aktif !== false);
    document.getElementById('slaInRows').innerHTML = units.map((u, i) => {
        const r = slaAv.get(slaKey(u.id, y, m));
        return `<tr data-unit="${u.id}">
            <td class="py-1.5 text-slate-400 num">${i + 1}</td>
            <td class="py-1.5 pr-2"><div class="font-semibold text-slate-800 leading-tight">${slaEsc(u.nama_unit)}</div><span class="font-mono text-[10px] text-slate-500">${slaEsc(u.nomor_alat || '')}</span></td>
            <td class="py-1.5 text-right num">${admin ? `<input data-f="harga" type="number" min="0" step="1" value="${Math.round(u.harga_bulanan * 100) / 100}" class="control w-36 text-right num" oninput="slaPreviewInput()">` : slaRp(u.harga_bulanan)}</td>
            <td class="py-1.5 px-1"><input data-f="av" inputmode="decimal" value="${slaFmtIn(r ? r.availability : null)}" class="control w-full text-right num" oninput="slaPreviewInput()" onpaste="slaPasteColumn(event,'av')"></td>
            <td class="py-1.5 px-1"><input data-f="util" inputmode="decimal" value="${slaFmtIn(r ? r.utilisasi : null)}" class="control w-full text-right num" oninput="slaPreviewInput()" onpaste="slaPasteColumn(event,'util')"></td>
            <td class="py-1.5 text-right num text-[11px]" data-f="out"></td>
        </tr>`;
    }).join('');
    slaPreviewInput();
}

function slaPasteColumn(ev, field) {
    const text = (ev.clipboardData || window.clipboardData).getData('text');
    const vals = text.split(/\r?\n/).map(s => s.split('\t')[0]).filter((s, i, a) => !(i === a.length - 1 && s === ''));
    if (vals.length < 2) return;
    ev.preventDefault();
    const rows = [...document.querySelectorAll('#slaInRows tr')];
    const start = rows.indexOf(ev.target.closest('tr'));
    vals.forEach((v, k) => { const row = rows[start + k]; if (row) row.querySelector(`[data-f="${field}"]`).value = v.trim(); });
    slaPreviewInput();
}

// Membaca isian modal → daftar perubahan, sekaligus menampilkan pratinjau biaya.
function slaReadInput() {
    const y = +document.getElementById('slaInTahun').value, m = +document.getElementById('slaInBulan').value;
    const rows = [...document.querySelectorAll('#slaInRows tr')];
    const out = { y, m, upserts: [], deletes: [], harga: [], errors: [] };
    rows.forEach(tr => {
        const id = +tr.dataset.unit, u = slaUnits.find(x => x.id === id);
        const av = slaParseIn(tr.querySelector('[data-f="av"]').value);
        const ut = slaParseIn(tr.querySelector('[data-f="util"]').value);
        const hEl = tr.querySelector('[data-f="harga"]');
        const harga = hEl ? Number(hEl.value) : u.harga_bulanan;
        if (av.error) out.errors.push(`${u.nama_unit}: availability harus 0–100`);
        if (ut.error) out.errors.push(`${u.nama_unit}: utilisasi harus 0–100`);
        if (hEl && (!isFinite(harga) || harga < 0 || hEl.value === '')) out.errors.push(`${u.nama_unit}: harga tidak valid`);
        if (hEl && isFinite(harga) && Math.abs(harga - u.harga_bulanan) > 0.005) out.harga.push({ id, harga_bulanan: harga });
        const old = slaAv.get(slaKey(id, y, m));
        if (av.empty && ut.empty) { if (old) out.deletes.push(old.id); }
        else if (!av.error && !ut.error) {
            const nv = av.empty ? null : av.value, nu = ut.empty ? null : ut.value;
            if (!old || old.availability !== nv || old.utilisasi !== nu) out.upserts.push({ unit_id: id, tahun: y, bulan: m, availability: nv, utilisasi: nu });
        }
        tr._preview = { u, av, harga };
    });
    return out;
}

function slaPreviewInput() {
    const r = slaReadInput();
    let tot = 0, full = 0, n = 0;
    document.querySelectorAll('#slaInRows tr').forEach(tr => {
        const { u, av, harga } = tr._preview, cell = tr.querySelector('[data-f="out"]');
        if (av.empty || av.error) { cell.innerHTML = av.error ? '<span class="text-rose-600 font-semibold">0–100</span>' : '<span class="text-slate-300">–</span>'; return; }
        // pratinjau memakai aturan 0% beruntun dari bulan-bulan sebelumnya
        let f = slaBandFactor(av.value), streak = 0;
        if (av.value === 0) {
            streak = 1; let [py, pm] = slaPrev(r.y, r.m);
            while (streak < SLA_ZERO_LIMIT && slaAvOf(u.id, py, pm) === 0) { streak++; [py, pm] = slaPrev(py, pm); }
            if (streak >= SLA_ZERO_LIMIT) f = 0;
        }
        const h = isFinite(harga) ? harga : 0;
        tot += h * f; full += h; n++;
        cell.innerHTML = `<span class="px-1 rounded" style="${slaTone(av.value, f)}">${slaPct(f, 0)}</span> ${slaRpShort(h * f)}`;
    });
    document.getElementById('slaInTotal').textContent = n ? `${n} unit diisi · dibayar ${slaRp(tot)} · potongan ${slaRp(full - tot)}` : 'Belum ada isian';
}

async function slaSaveInput() {
    const r = slaReadInput();
    if (r.errors.length) { alert('Periksa isian:\n• ' + r.errors.slice(0, 8).join('\n• ')); return; }
    if (!r.upserts.length && !r.deletes.length && !r.harga.length) { slaCloseInput(); return; }
    const btn = document.getElementById('slaBtnSave'); const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>Menyimpan…';
    try {
        if (r.upserts.length) {
            const { error } = await supabaseClient.from('availability_bulanan').upsert(r.upserts, { onConflict: 'unit_id,tahun,bulan' });
            if (error) throw error;
        }
        if (r.deletes.length) {
            const { error } = await supabaseClient.from('availability_bulanan').delete().in('id', r.deletes);
            if (error) throw error;
        }
        for (const h of r.harga) {
            const { error } = await supabaseClient.from('kontrak_unit').update({ harga_bulanan: h.harga_bulanan }).eq('id', h.id);
            if (error) throw error;
        }
        slaState.tahun = r.y; slaState.bulan = r.m;
        slaCloseInput();
        await slaLoad();
    } catch (e) {
        alert('Gagal menyimpan: ' + (e.message || e));
    } finally {
        btn.disabled = false; btn.innerHTML = orig;
    }
}

// ---------- Ekspor Excel (format kontrak, dengan rumus) ----------
async function slaExportExcel(btn) {
    const orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Menyiapkan…'; }
    try {
        const ExcelJS = await loadExcelJS();
        const wb = new ExcelJS.Workbook();
        slaBuildSheet(wb, slaState.tahun, slaUnitsInScope());
        const buf = await wb.xlsx.writeBuffer();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        const scope = slaBranch() === 'Semua' ? 'Semua' : slaBranch().replace(/\s+/g, '');
        a.download = `SIMALAT_SLA_${slaState.tahun}_${scope}.xlsx`;
        document.body.appendChild(a); a.click(); a.remove();
    } catch (e) {
        console.error(e); alert('Ekspor Excel SLA gagal: ' + (e.message || e));
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    }
}

function slaColL(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

function slaBuildSheet(wb, y, units) {
    const NAVY = 'FF0F1F3D', NAVY2 = 'FF1E3A6E', GOLD = 'FFE8B84A', INK = 'FF1E293B', MUTED = 'FF64748B', LINE = 'FFE2E8F0', ZEBRA = 'FFF7F9FC', INPUT = 'FF0000FF';
    const solid = c => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: c } });
    const thin = { style: 'thin', color: { argb: LINE } };
    const box = { top: thin, left: thin, bottom: thin, right: thin };
    const font = (o = {}) => ({ name: 'Calibri', size: 10, color: { argb: INK }, ...o });
    const RP = '#,##0;(#,##0);"-"', PCT = '0.00%;-0.00%;0.00%', PCT0 = '0%';
    if (wb.calcProperties) wb.calcProperties.fullCalcOnLoad = true;

    const ws = wb.addWorksheet('Availability & Biaya SLA', { properties: { tabColor: { argb: GOLD } }, views: [{ showGridLines: false, zoomScale: 85 }] });
    const set = (r, c, v, o = {}) => {
        const cell = ws.getCell(r, c); cell.value = v;
        cell.font = font(o.font || {}); if (o.fill) cell.fill = solid(o.fill);
        if (o.fmt) cell.numFmt = o.fmt; cell.alignment = { vertical: 'middle', ...(o.align || {}) };
        if (o.border !== false) cell.border = box;
        return cell;
    };
    const F = (formula, result) => ({ formula, result });

    // Kolom detail unit
    const C = { no: 1, term: 2, kat: 3, grup: 4, nama: 5, nomor: 6, harga: 7, avPrev: 8 };   // H,I = Nov & Des tahun lalu
    C.av1 = 10; C.u1 = C.av1 + 12; C.f1 = C.u1 + 12; C.b1 = C.f1 + 12; C.penuh = C.b1 + 12; C.biaya = C.penuh + 1; C.pot = C.biaya + 1; C.rata = C.pot + 1; C.rataUt = C.rata + 1;
    const last = C.rataUt;
    const L = slaColL;

    // Judul
    ws.mergeCells(1, 1, 1, 12);
    set(1, 1, `Availability & Biaya SLA Peralatan — Tahun ${y}`, { font: { size: 16, bold: true, color: { argb: 'FFFFFFFF' } }, fill: NAVY, border: false });
    ws.mergeCells(2, 1, 2, 12);
    const now = new Date();
    set(2, 1, `PT IPC Terminal Petikemas · ${slaBranch() === 'Semua' ? 'Seluruh terminal' : slaBranch()} · ${units.length} unit kontrak · diekspor dari SIMALAT ${now.toLocaleString('id-ID')}`, { font: { color: { argb: 'FFCBD5E1' } }, fill: NAVY, border: false });
    for (let c = 13; c <= last; c++) { ws.getCell(1, c).fill = solid(NAVY); ws.getCell(2, c).fill = solid(NAVY); }

    // A. Parameter SLA (C6:C9 = batas, E6:E9 = faktor — sama dengan kontrak)
    const secHead = (r, text) => { ws.mergeCells(r, 1, r, 12); set(r, 1, text, { font: { bold: true, size: 11, color: { argb: NAVY } }, border: false }); ws.getCell(r, 1).border = { bottom: { style: 'medium', color: { argb: GOLD } } }; };
    secHead(4, 'A. Parameter SLA (sesuai kontrak) — sel biru boleh diubah');
    set(5, 2, 'Band', { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: NAVY2 });
    set(5, 3, 'Availability ≥', { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: NAVY2, align: { horizontal: 'center' } });
    set(5, 4, 's.d.', { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: NAVY2, align: { horizontal: 'center' } });
    set(5, 5, 'Faktor bayar', { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: NAVY2, align: { horizontal: 'center' } });
    const bands = slaBands.slice(0, 4);
    while (bands.length < 4) bands.push({ batas: 1, faktor: 1 });
    bands.forEach((b, i) => {
        const r = 6 + i;
        set(r, 2, `Band ${i + 1}`);
        set(r, 3, b.batas, { fmt: PCT0, font: { color: { argb: INPUT } }, align: { horizontal: 'center' } });
        set(r, 4, i < 3 ? F(`C${r + 1}`, bands[i + 1].batas) : 1, { fmt: PCT0, align: { horizontal: 'center' } });
        set(r, 5, b.faktor, { fmt: PCT0, font: { color: { argb: INPUT } }, align: { horizontal: 'center' } });
    });
    ws.mergeCells(10, 2, 10, 12);
    set(10, 2, `Aturan 0%: availability 0% tiga bulan berturut-turut → bulan ke-3 dan seterusnya faktor 0 (tidak dibayar). Bulan kosong = belum ada data, tidak ditagihkan.`, { font: { italic: true, color: { argb: MUTED } }, border: false });
    const BAT = '$C$6:$C$9', FAK = '$E$6:$E$9';

    // Hitung posisi blok
    const areas = TERMINALS.filter(t => units.some(u => u.terminal === t));
    const kats = SLA_KATEGORI.filter(k => units.some(u => slaKategori(u) === k));
    const areaTop = 12, areaFirst = areaTop + 2, areaTot = areaFirst + areas.length;
    const katTop = areaTot + 2, katFirst = katTop + 2, katTot = katFirst + kats.length;
    const bulanTop = katTot + 2, bulanHdr = bulanTop + 1, bulanFirst = bulanHdr + 1, bulanTot = bulanFirst + 12;
    const detTop = bulanTot + 2, detHdr1 = detTop + 1, detHdr2 = detHdr1 + 1, d0 = detHdr2 + 1, d1 = d0 + Math.max(units.length, 1) - 1;
    const rng = col => `$${L(col)}$${d0}:$${L(col)}$${d1}`;
    const rngBlock = (c0, c1) => `$${L(c0)}$${d0}:$${L(c1)}$${d1}`;
    const AVB = rngBlock(C.av1, C.av1 + 11), UTB = rngBlock(C.u1, C.u1 + 11);

    // Nilai terhitung (untuk 'result' rumus)
    const avg = a => a.length ? a.reduce((p, q) => p + q, 0) / a.length : null;
    const calc = units.map(u => {
        const cells = SLA_BULAN.map((_, i) => slaCell(u, y, i + 1));
        const uts = SLA_BULAN.map((_, i) => slaUtOf(u.id, y, i + 1));
        const biaya = cells.reduce((s, c) => s + (c ? c.biaya : 0), 0), penuh = cells.reduce((s, c) => s + (c ? c.penuh : 0), 0);
        return { u, kat: slaKategori(u), cells, uts, biaya, penuh, rata: avg(cells.filter(Boolean).map(c => c.av)), rataUt: avg(uts.filter(v => v !== null)) };
    });
    const allAv = cs => cs.flatMap(x => x.cells.filter(Boolean).map(c => c.av));
    const allUt = cs => cs.flatMap(x => x.uts.filter(v => v !== null));
    const blank = v => (v === null ? '' : v);

    const hdr = (r, c, t, o = {}) => set(r, c, t, { font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 9.5 }, fill: NAVY2, align: { horizontal: 'center', wrapText: true }, ...o });
    const center = { align: { horizontal: 'center' } };

    // B & C. Rekap per area / per kategori (kolom B–J)
    const rekapGroup = (top, title, firstLabel, names, keyCol, keyOf) => {
        secHead(top, title);
        const h = top + 1, first = top + 2, totR = first + names.length;
        [firstLabel, 'Jumlah unit', 'Rata-rata availability', 'Rata-rata utilisasi', 'Unit < 85%', 'Nilai penuh (Rp)', 'Biaya dibayar (Rp)', 'Potongan (Rp)', '% potongan'].forEach((t, i) => hdr(h, 2 + i, t, i === 3 ? { fill: 'FF0F766E' } : {}));
        ws.getRow(h).height = 30;
        names.forEach((n, i) => {
            const r = first + i, cs = calc.filter(x => keyOf(x) === n), zebra = i % 2 ? ZEBRA : undefined;
            const pen = cs.reduce((s, x) => s + x.penuh, 0), bi = cs.reduce((s, x) => s + x.biaya, 0);
            const K = `(${rng(keyCol)}=$B${r})`;
            set(r, 2, n, { font: { bold: true }, fill: zebra });
            set(r, 3, F(`COUNTIF(${rng(keyCol)},$B${r})`, cs.length), { fill: zebra, ...center });
            set(r, 4, F(`IFERROR(SUMPRODUCT(${K}*${AVB})/SUMPRODUCT(${K}*(${AVB}<>"")),"")`, blank(avg(allAv(cs)))), { fmt: PCT, fill: zebra, ...center });
            set(r, 5, F(`IFERROR(SUMPRODUCT(${K}*${UTB})/SUMPRODUCT(${K}*(${UTB}<>"")),"")`, blank(avg(allUt(cs)))), { fmt: PCT, fill: zebra, ...center, font: { bold: true, color: { argb: 'FF0F766E' } } });
            set(r, 6, F(`COUNTIFS(${rng(keyCol)},$B${r},${rng(C.rata)},"<0.85")`, cs.filter(x => x.rata !== null && x.rata < 0.85 - 1e-12).length), { fill: zebra, ...center });
            set(r, 7, F(`SUMIF(${rng(keyCol)},$B${r},${rng(C.penuh)})`, pen), { fmt: RP, fill: zebra });
            set(r, 8, F(`SUMIF(${rng(keyCol)},$B${r},${rng(C.biaya)})`, bi), { fmt: RP, fill: zebra });
            set(r, 9, F(`G${r}-H${r}`, pen - bi), { fmt: RP, fill: zebra, font: { color: { argb: 'FFBE123C' } } });
            set(r, 10, F(`IFERROR(I${r}/G${r},0)`, pen ? (pen - bi) / pen : 0), { fmt: PCT, fill: zebra, ...center });
        });
        const r = totR, a = first, b = totR - 1, tot = { font: { bold: true }, fill: 'FFFDF3D8' };
        const pen = calc.reduce((s, x) => s + x.penuh, 0), bi = calc.reduce((s, x) => s + x.biaya, 0);
        set(r, 2, 'TOTAL', tot);
        set(r, 3, F(`SUM(C${a}:C${b})`, units.length), { ...tot, ...center });
        set(r, 4, F(`IFERROR(SUMPRODUCT(${AVB})/SUMPRODUCT(--(${AVB}<>"")),"")`, blank(avg(allAv(calc)))), { ...tot, fmt: PCT, ...center });
        set(r, 5, F(`IFERROR(SUMPRODUCT(${UTB})/SUMPRODUCT(--(${UTB}<>"")),"")`, blank(avg(allUt(calc)))), { ...tot, fmt: PCT, ...center });
        set(r, 6, F(`SUM(F${a}:F${b})`, calc.filter(x => x.rata !== null && x.rata < 0.85 - 1e-12).length), { ...tot, ...center });
        set(r, 7, F(`SUM(G${a}:G${b})`, pen), { ...tot, fmt: RP });
        set(r, 8, F(`SUM(H${a}:H${b})`, bi), { ...tot, fmt: RP });
        set(r, 9, F(`G${r}-H${r}`, pen - bi), { ...tot, fmt: RP });
        set(r, 10, F(`IFERROR(I${r}/G${r},0)`, pen ? (pen - bi) / pen : 0), { ...tot, fmt: PCT, ...center });
    };
    rekapGroup(areaTop, `B. Rekap per area — Tahun ${y} (bulan berdata)`, 'Area', areas, C.term, x => x.u.terminal);
    rekapGroup(katTop, `C. Rekap per kategori alat — Tahun ${y}`, 'Kategori alat', kats, C.kat, x => x.kat);

    // D. Rekap per bulan
    secHead(bulanTop, `D. Rekap per bulan — Tahun ${y} (availability & utilisasi bersanding)`);
    ['Bulan', 'Unit berdata', 'Rata-rata availability', 'Rata-rata utilisasi', 'Unit-bulan tidak dibayar', 'Nilai penuh (Rp)', 'Biaya dibayar (Rp)', 'Potongan (Rp)', '% potongan'].forEach((t, i) => hdr(bulanHdr, 2 + i, t, i === 3 ? { fill: 'FF0F766E' } : {}));
    ws.getRow(bulanHdr).height = 30;
    SLA_BULAN_PANJANG.forEach((b, i) => {
        const r = bulanFirst + i, av = L(C.av1 + i), ut = L(C.u1 + i), f = L(C.f1 + i), bi = L(C.b1 + i);
        const cs = calc.map(x => x.cells[i]).filter(Boolean), us = calc.map(x => x.uts[i]).filter(v => v !== null);
        const pen = cs.reduce((s, c) => s + c.penuh, 0), byr = cs.reduce((s, c) => s + c.biaya, 0);
        const zebra = i % 2 ? ZEBRA : undefined;
        set(r, 2, b, { font: { bold: true }, fill: zebra });
        set(r, 3, F(`COUNT($${av}$${d0}:$${av}$${d1})`, cs.length), { fill: zebra, ...center });
        set(r, 4, F(`IFERROR(AVERAGE($${av}$${d0}:$${av}$${d1}),"")`, blank(avg(cs.map(c => c.av)))), { fmt: PCT, fill: zebra, ...center });
        set(r, 5, F(`IFERROR(AVERAGE($${ut}$${d0}:$${ut}$${d1}),"")`, blank(avg(us))), { fmt: PCT, fill: zebra, ...center, font: { bold: true, color: { argb: 'FF0F766E' } } });
        set(r, 6, F(`COUNTIF($${f}$${d0}:$${f}$${d1},0)`, cs.filter(c => c.faktor === 0).length), { fill: zebra, ...center });
        set(r, 7, F(`SUMPRODUCT(${rng(C.harga)},--($${av}$${d0}:$${av}$${d1}<>""))`, pen), { fmt: RP, fill: zebra });
        set(r, 8, F(`SUM($${bi}$${d0}:$${bi}$${d1})`, byr), { fmt: RP, fill: zebra });
        set(r, 9, F(`G${r}-H${r}`, pen - byr), { fmt: RP, fill: zebra, font: { color: { argb: 'FFBE123C' } } });
        set(r, 10, F(`IFERROR(I${r}/G${r},0)`, pen ? (pen - byr) / pen : 0), { fmt: PCT, fill: zebra, ...center });
    });
    {
        const r = bulanTot, a = bulanFirst, b = bulanTot - 1, tot = { font: { bold: true }, fill: 'FFFDF3D8' };
        const pen = calc.reduce((s, x) => s + x.penuh, 0), bi = calc.reduce((s, x) => s + x.biaya, 0);
        set(r, 2, 'TOTAL', tot);
        set(r, 3, F(`SUM(C${a}:C${b})`, allAv(calc).length), { ...tot, ...center });
        set(r, 4, F(`D${areaTot}`, blank(avg(allAv(calc)))), { ...tot, fmt: PCT, ...center });
        set(r, 5, F(`E${areaTot}`, blank(avg(allUt(calc)))), { ...tot, fmt: PCT, ...center });
        set(r, 6, F(`SUM(F${a}:F${b})`, calc.reduce((s, x) => s + x.cells.filter(c => c && c.faktor === 0).length, 0)), { ...tot, ...center });
        set(r, 7, F(`SUM(G${a}:G${b})`, pen), { ...tot, fmt: RP });
        set(r, 8, F(`SUM(H${a}:H${b})`, bi), { ...tot, fmt: RP });
        set(r, 9, F(`G${r}-H${r}`, pen - bi), { ...tot, fmt: RP });
        set(r, 10, F(`IFERROR(I${r}/G${r},0)`, pen ? (pen - bi) / pen : 0), { ...tot, fmt: PCT, ...center });
    }

    // E. Detail per unit
    secHead(detTop, `E. Detail per unit — availability & utilisasi (input, biru), faktor bayar & biaya per bulan`);
    const fixedHdr = [[C.no, 'No'], [C.term, 'Terminal'], [C.kat, 'Kategori alat'], [C.grup, 'Grup kontrak'], [C.nama, 'Nama unit (kontrak)'], [C.nomor, 'Nomor alat SIMALAT'], [C.harga, 'Harga / unit / bulan (Rp)']];
    fixedHdr.forEach(([c, t]) => { ws.mergeCells(detHdr1, c, detHdr2, c); hdr(detHdr1, c, t); });
    ws.mergeCells(detHdr1, C.avPrev, detHdr1, C.avPrev + 1); hdr(detHdr1, C.avPrev, `Avail. ${y - 1}`, { fill: 'FF475569' });
    hdr(detHdr2, C.avPrev, 'Nov', { fill: 'FF475569' }); hdr(detHdr2, C.avPrev + 1, 'Des', { fill: 'FF475569' });
    [[C.av1, `Availability ${y}`, NAVY2], [C.u1, `Utilisasi ${y}`, 'FF0F766E'], [C.f1, 'Faktor bayar', 'FF475569'], [C.b1, 'Biaya dibayar (Rp)', 'FF1E3A8A']].forEach(([c0, t, col]) => {
        ws.mergeCells(detHdr1, c0, detHdr1, c0 + 11); hdr(detHdr1, c0, t, { fill: col });
        SLA_BULAN.forEach((b, i) => hdr(detHdr2, c0 + i, b, { fill: col }));
    });
    [[C.penuh, 'Nilai penuh (Rp)'], [C.biaya, 'Total dibayar (Rp)'], [C.pot, 'Potongan (Rp)'], [C.rata, 'Rata-rata avail.'], [C.rataUt, 'Rata-rata util.']].forEach(([c, t]) => { ws.mergeCells(detHdr1, c, detHdr2, c); hdr(detHdr1, c, t, { fill: NAVY }); });

    calc.forEach((x, i) => {
        const r = d0 + i, u = x.u, zebra = i % 2 ? ZEBRA : undefined;
        set(r, C.no, i + 1, { fill: zebra, ...center });
        set(r, C.term, u.terminal, { fill: zebra });
        set(r, C.kat, x.kat, { fill: zebra });
        set(r, C.grup, u.grup || '', { fill: zebra });
        set(r, C.nama, u.nama_unit, { fill: zebra });
        set(r, C.nomor, u.nomor_alat || '', { fill: zebra, font: { color: { argb: u.peralatan_id ? INK : 'FFB45309' } } });
        set(r, C.harga, u.harga_bulanan, { fmt: RP, fill: zebra, font: { color: { argb: INPUT } } });
        [[11, y - 1], [12, y - 1]].forEach(([m, yy], k) => {
            const v = slaAvOf(u.id, yy, m);
            set(r, C.avPrev + k, v === null ? null : v, { fmt: PCT, fill: 'FFF1F5F9', font: { color: { argb: INPUT } }, ...center });
        });
        for (let m = 0; m < 12; m++) {
            const c = x.cells[m];
            const avA = `${L(C.av1 + m)}${r}`, p1 = `${L(C.av1 + m - 1)}${r}`, p2 = `${L(C.av1 + m - 2)}${r}`;
            set(r, C.av1 + m, c ? c.av : null, { fmt: PCT, fill: zebra, font: { color: { argb: INPUT } }, ...center });
            set(r, C.u1 + m, x.uts[m], { fmt: PCT, fill: zebra, font: { color: { argb: INPUT } }, ...center });
            set(r, C.f1 + m, F(`IF(${avA}="","",IF(AND(${avA}=0,${p1}<>"",${p2}<>"",N(${p1})=0,N(${p2})=0),0,LOOKUP(${avA},${BAT},${FAK})))`, c ? c.faktor : ''),
                { fmt: PCT0, fill: c && c.faktor === 0 ? 'FFFECACA' : zebra, ...center });
            set(r, C.b1 + m, F(`IF(${L(C.f1 + m)}${r}="","",$${L(C.harga)}${r}*${L(C.f1 + m)}${r})`, c ? c.biaya : ''), { fmt: RP, fill: zebra });
        }
        set(r, C.penuh, F(`$${L(C.harga)}${r}*COUNT(${L(C.av1)}${r}:${L(C.av1 + 11)}${r})`, x.penuh), { fmt: RP, fill: zebra });
        set(r, C.biaya, F(`SUM(${L(C.b1)}${r}:${L(C.b1 + 11)}${r})`, x.biaya), { fmt: RP, fill: zebra, font: { bold: true } });
        set(r, C.pot, F(`${L(C.penuh)}${r}-${L(C.biaya)}${r}`, x.penuh - x.biaya), { fmt: RP, fill: zebra, font: { color: { argb: 'FFBE123C' } } });
        set(r, C.rata, F(`IFERROR(AVERAGE(${L(C.av1)}${r}:${L(C.av1 + 11)}${r}),"")`, blank(x.rata)), { fmt: PCT, fill: zebra, ...center });
        set(r, C.rataUt, F(`IFERROR(AVERAGE(${L(C.u1)}${r}:${L(C.u1 + 11)}${r}),"")`, blank(x.rataUt)), { fmt: PCT, fill: zebra, ...center, font: { bold: true, color: { argb: 'FF0F766E' } } });
    });

    // Lebar kolom & tampilan
    const widths = { [C.no]: 5, [C.term]: 20, [C.kat]: 18, [C.grup]: 18, [C.nama]: 40, [C.nomor]: 18, [C.harga]: 16, [C.penuh]: 16, [C.biaya]: 16, [C.pot]: 15, [C.rata]: 11, [C.rataUt]: 11 };
    for (let c = 1; c <= last; c++) ws.getColumn(c).width = widths[c] || (c >= C.b1 && c < C.b1 + 12 ? 13 : 8.5);
    ws.getRow(detHdr1).height = 18; ws.getRow(detHdr2).height = 18;
    ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    return { ws, d0, d1, C, areaFirst, areaTot, katFirst, katTot, bulanFirst, bulanTot };
}
