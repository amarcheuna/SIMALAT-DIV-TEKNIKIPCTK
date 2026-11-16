const SUPABASE_URL = 'https://yacnpsjhofestqrgsfvf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhY25wc2pob2Zlc3RxcmdzZnZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2MzA5NzgsImV4cCI6MjExMDIwNjk3OH0.8pQdGTiL_KZYI_l2JYvt_7WfpceLpXIJn8rcU60yWsg';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Tahun acuan usia alat = tahun berjalan (otomatis berganti setiap 1 Januari).
// Untuk mengunci ke tahun tertentu (mis. laporan RKAP), ganti menjadi angka, contoh: const BASE_YEAR = 2026;
const BASE_YEAR = new Date().getFullYear();

let rawData = [];
let userRole = 'viewer';
let selectedBranch = 'Semua';
let chartMode = 'semua';
let includePassive = false;
let barChartInstance = null;
let pieChartInstance = null;
let energyPieInstance = null;
let energyCatBarInstance = null;

const TERMINALS = ['Tanjung Priok', 'Panjang', 'Jambi', 'Teluk Bayur', 'Palembang', 'Pontianak'];
const CATEGORIES_4 = ['Alat Utama Dermaga', 'Alat Utama Lapangan', 'Alat Pendukung', 'Alat Angkut'];

function getFourCategory(item) {
    if (item.area === 'Alat Utama Dermaga') return 'Alat Utama Dermaga';
    if (item.area === 'Alat Utama Lapangan') return 'Alat Utama Lapangan';
    if (item.jenis === 'HDT' || item.jenis === 'TTR') return 'Alat Angkut';
    return 'Alat Pendukung';
}

function isPassiveEquipment(item) {
    return item.jenis === 'CHS' || item.jenis === 'SPREADER' || item.sumber_energi === 'Non-Engine';
}

function getActiveDataset() {
    return includePassive ? rawData : rawData.filter(d => !isPassiveEquipment(d));
}

async function checkSession() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) await setupUserAccess(session.user);
}

async function handleLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    const btn = document.getElementById('btnLoginSubmit');
    errEl.classList.add('hidden');
    btn.innerText = 'Memverifikasi...';

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    btn.innerText = 'Masuk ke Dashboard';
    if (error) {
        errEl.innerText = 'Login gagal: ' + error.message;
        errEl.classList.remove('hidden');
        return;
    }
    await setupUserAccess(data.user);
}

async function handleLogout() {
    await supabaseClient.auth.signOut();
    location.reload();
}

async function setupUserAccess(user) {
    const { data } = await supabaseClient.from('user_roles').select('role').eq('user_id', user.id).single();
    userRole = data ? data.role : 'viewer';

    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appScreen').classList.remove('hidden');
    document.getElementById('userEmailDisplay').innerText = user.email;
    document.getElementById('roleBadge').innerText = userRole;

    const bannerEl = document.getElementById('modeBannerText');
    if (userRole === 'admin') {
        document.getElementById('btnAddTop').classList.remove('hidden');
        bannerEl.innerHTML = '<b>Mode Admin:</b> akses penuh untuk menambah, mengedit dan menghapus data alat.';
    } else if (userRole === 'editor') {
        document.getElementById('btnAddTop').classList.remove('hidden');
        bannerEl.innerHTML = '<b>Mode Editor:</b> dapat menambah dan memperbarui data operasional alat.';
    } else {
        document.getElementById('colAksiHeader').classList.add('hidden');
        bannerEl.innerHTML = '<b>Mode Viewer:</b> akses pemantauan eksekutif dan ekspor laporan (hanya baca).';
    }

    await loadData();
}

async function loadData() {
    const { data, error } = await supabaseClient.from('peralatan').select('*').order('id', { ascending: true });
    if (error) {
        alert('Gagal memuat data: ' + error.message);
        return;
    }
    rawData = (data || []).map(d => ({ ...d, kategori4: getFourCategory(d) }));
    renderBranchTabs();
    updateDashboard();
    renderTable();
}

function onTogglePassive() {
    includePassive = document.getElementById('chkIncludePassive').checked;
    renderBranchTabs();
    updateDashboard();
    renderTable();
}

function renderBranchTabs() {
    const baseData = getActiveDataset();
    const container = document.getElementById('branchTabs');
    let html = `<span class="text-[11px] font-bold text-slate-400 mr-1"><i class="fa-solid fa-location-dot text-rose-500 mr-1"></i>CABANG</span>`;
    
    const isAll = selectedBranch === 'Semua';
    html += `<button onclick="selectBranch('Semua')" class="px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer transition ${isAll ? 'tab-active' : 'tab-inactive'}">Semua <span class="ml-1 opacity-75">${baseData.length}</span></button>`;

    TERMINALS.forEach(t => {
        const count = baseData.filter(d => d.terminal === t).length;
        const active = selectedBranch === t;
        html += `<button onclick="selectBranch('${t}')" class="px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition ${active ? 'tab-active' : 'tab-inactive'}">${t} <span class="ml-1 text-[10px] opacity-70">${count}</span></button>`;
    });
    container.innerHTML = html;
}

function selectBranch(branch) {
    selectedBranch = branch;
    renderBranchTabs();
    updateDashboard();
    renderTable();
}

function setChartMode(mode) {
    chartMode = mode;
    document.getElementById('btnModeSemua').className = mode === 'semua' 
        ? 'px-2.5 py-1 rounded-md bg-white text-slate-900 shadow-2xs cursor-pointer transition' 
        : 'px-2.5 py-1 rounded-md text-slate-500 hover:text-slate-900 cursor-pointer transition';
    document.getElementById('btnModeUtama').className = mode === 'utama' 
        ? 'px-2.5 py-1 rounded-md bg-white text-slate-900 shadow-2xs cursor-pointer transition' 
        : 'px-2.5 py-1 rounded-md text-slate-500 hover:text-slate-900 cursor-pointer transition';
    updateDashboard();
}

const barDataLabelsPlugin = {
    id: 'barDataLabels',
    afterDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save();
        ctx.font = 'bold 10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const meta0 = chart.getDatasetMeta(0);
        if (!meta0 || !meta0.data) return;

        for (let i = 0; i < meta0.data.length; i++) {
            let total = 0;
            let topY = chart.chartArea.bottom;
            let xPos = meta0.data[i].x;

            chart.data.datasets.forEach((ds, dsIdx) => {
                const meta = chart.getDatasetMeta(dsIdx);
                if (!meta.hidden && ds.data[i] > 0) {
                    total += ds.data[i];
                    const bar = meta.data[i];
                    const barHeight = Math.abs(bar.base - bar.y);
                    if (bar.y < topY) topY = bar.y;
                    if (barHeight > 13) {
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(ds.data[i], bar.x, bar.y + barHeight / 2);
                    }
                }
            });

            if (total > 0) {
                const boxW = 24, boxH = 16;
                ctx.fillStyle = '#0f172a';
                ctx.beginPath();
                ctx.roundRect(xPos - boxW / 2, topY - boxH - 4, boxW, boxH, 4);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.fillText(total, xPos, topY - boxH / 2 - 4);
            }
        }
        ctx.restore();
    }
};

const horizontalBarLabelsPlugin = {
    id: 'horizontalBarLabels',
    afterDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save();
        ctx.font = 'bold 10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const meta0 = chart.getDatasetMeta(0);
        if (!meta0 || !meta0.data) return;

        for (let i = 0; i < meta0.data.length; i++) {
            let total = 0;
            let rightX = chart.chartArea.left;
            let yPos = meta0.data[i].y;

            chart.data.datasets.forEach((ds, dsIdx) => {
                const meta = chart.getDatasetMeta(dsIdx);
                if (!meta.hidden && ds.data[i] > 0) {
                    total += ds.data[i];
                    const bar = meta.data[i];
                    const barWidth = Math.abs(bar.x - bar.base);
                    if (bar.x > rightX) rightX = bar.x;
                    if (barWidth > 14) {
                        ctx.fillStyle = (ds.label === 'Belum Diisi' || ds.label === 'Non Operasional') ? '#1e293b' : '#ffffff';
                        ctx.fillText(ds.data[i], bar.base + barWidth / 2, yPos);
                    }
                }
            });

            if (total > 0) {
                const boxW = 26, boxH = 18;
                ctx.fillStyle = '#0f172a';
                ctx.beginPath();
                ctx.roundRect(rightX + 8, yPos - boxH / 2, boxW, boxH, 5);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.fillText(total, rightX + 8 + boxW / 2, yPos);
            }
        }
        ctx.restore();
    }
};

const pieDataLabelsPlugin = {
    id: 'pieDataLabels',
    afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const ds = chart.data.datasets[0];
        const meta = chart.getDatasetMeta(0);
        const total = ds.data.reduce((a, b) => a + b, 0);
        if (total === 0) return;

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';

        meta.data.forEach((arc, i) => {
            const val = ds.data[i];
            const pct = Math.round((val / total) * 100);
            if (val > 0 && pct >= 6) {
                const pos = arc.tooltipPosition();
                ctx.font = 'bold 11px Inter, sans-serif';
                ctx.fillText(val, pos.x, pos.y - 6);
                ctx.font = '10px Inter, sans-serif';
                ctx.fillText(pct + '%', pos.x, pos.y + 7);
            }
        });
        ctx.restore();
    }
};

function summarizeTypes(list, orderTypes) {
    const counts = {};
    list.forEach(d => { counts[d.jenis] = (counts[d.jenis] || 0) + 1; });
    const keys = orderTypes ? orderTypes.filter(k => counts[k]) : Object.keys(counts);
    Object.keys(counts).forEach(k => { if (!keys.includes(k)) keys.push(k); });
    return keys.length ? keys.map(k => `${k} ${counts[k]}`).join(' · ') : '-';
}

function updateDashboard() {
    const baseData = getActiveDataset();
    const scopeData = selectedBranch === 'Semua' ? baseData : baseData.filter(d => d.terminal === selectedBranch);
    const totScope = scopeData.length;

    document.getElementById('scopeSummaryBadge').innerText = selectedBranch === 'Semua' 
        ? `Seluruh 6 terminal · ${totScope} unit` 
        : `Cabang ${selectedBranch} · ${totScope} unit`;
    document.getElementById('totalAlatLabel').innerText = `Total ${totScope} alat`;

    const dDermaga = scopeData.filter(d => d.kategori4 === 'Alat Utama Dermaga');
    const dLapangan = scopeData.filter(d => d.kategori4 === 'Alat Utama Lapangan');
    const dPendukung = scopeData.filter(d => d.kategori4 === 'Alat Pendukung');
    const dAngkut = scopeData.filter(d => d.kategori4 === 'Alat Angkut');

    const pct = (n) => totScope > 0 ? Math.round((n / totScope) * 100) : 0;

    document.getElementById('kpiDermaga').innerText = dDermaga.length;
    document.getElementById('kpiDermagaPct').innerText = `unit · ${pct(dDermaga.length)}%`;
    document.getElementById('subDermaga').innerText = summarizeTypes(dDermaga, ['QCC', 'GLC', 'FJC', 'GJC']);
    document.getElementById('opsDermaga').innerText = `${dDermaga.filter(d => d.status === 'Operasional').length} operasional`;

    document.getElementById('kpiLapangan').innerText = dLapangan.length;
    document.getElementById('kpiLapanganPct').innerText = `unit · ${pct(dLapangan.length)}%`;
    document.getElementById('subLapangan').innerText = summarizeTypes(dLapangan, ['RTG', 'RMGC']);
    document.getElementById('opsLapangan').innerText = `${dLapangan.filter(d => d.status === 'Operasional').length} operasional`;

    document.getElementById('kpiPendukung').innerText = dPendukung.length;
    document.getElementById('kpiPendukungPct').innerText = `unit · ${pct(dPendukung.length)}%`;
    document.getElementById('subPendukung').innerText = summarizeTypes(dPendukung, ['RST', 'FLT', 'SIL']);
    document.getElementById('opsPendukung').innerText = `${dPendukung.filter(d => d.status === 'Operasional').length} operasional`;

    document.getElementById('kpiAngkut').innerText = dAngkut.length;
    document.getElementById('kpiAngkutPct').innerText = `unit · ${pct(dAngkut.length)}%`;
    document.getElementById('subAngkut').innerText = summarizeTypes(dAngkut, ['HDT', 'TTR']);
    document.getElementById('opsAngkut').innerText = `${dAngkut.filter(d => d.status === 'Operasional').length} operasional`;

    const ops = scopeData.filter(d => d.status === 'Operasional').length;
    const nonOps = scopeData.filter(d => d.status === 'Non Operasional').length;
    const belumIsi = scopeData.filter(d => !d.status || d.status === 'Belum Diisi').length;
    const opsPct = totScope > 0 ? ((ops / totScope) * 100).toFixed(1) : 0;

    document.getElementById('kpiOperasional').innerText = ops;
    document.getElementById('kpiOpsPct').innerText = `${opsPct}% siap`;
    document.getElementById('opsProgressBar').style.width = `${opsPct}%`;
    document.getElementById('kpiNonOps').innerText = `● Non-ops ${nonOps}`;
    document.getElementById('kpiBelumIsi').innerText = `● Belum diisi ${belumIsi}`;

    const validYears = scopeData.filter(d => d.tahun_pembuatan && d.tahun_pembuatan > 1950);
    const avgAge = validYears.length > 0 
        ? (validYears.reduce((sum, d) => sum + (BASE_YEAR - d.tahun_pembuatan), 0) / validYears.length).toFixed(1)
        : 0;

    let oldestText = 'Tertua: -';
    if (validYears.length > 0) {
        const oldest = [...validYears].sort((a, b) => a.tahun_pembuatan - b.tahun_pembuatan)[0];
        oldestText = `Tertua: ${oldest.nomor_alat} · ${BASE_YEAR - oldest.tahun_pembuatan} th (${oldest.terminal.toUpperCase()})`;
    }
    document.getElementById('kpiRataUsia').innerText = avgAge;
    document.getElementById('kpiTertua').innerText = oldestText;

    const poweredUnits = scopeData.filter(d => !isPassiveEquipment(d));
    const cBBM = poweredUnits.filter(d => (d.sumber_energi || 'BBM') === 'BBM').length;
    const cListrik = poweredUnits.filter(d => d.sumber_energi === 'Listrik').length;
    const cHybrid = poweredUnits.filter(d => d.sumber_energi === 'Hybrid').length;
    const cEmpty = poweredUnits.filter(d => d.sumber_energi === 'Belum Diisi').length;
    const totPowered = poweredUnits.length;
    const pctBBM = totPowered > 0 ? Math.round((cBBM / totPowered) * 100) : 0;

    document.getElementById('kpiEnergiBBM').innerText = cBBM;
    document.getElementById('kpiEnergiBBMPct').innerText = `alat BBM · ${pctBBM}%`;
    document.getElementById('cntListrik').innerText = cListrik;
    document.getElementById('cntHybrid').innerText = cHybrid;
    document.getElementById('cntEnergiEmpty').innerText = cEmpty;

    document.getElementById('barBBM').style.width = totPowered ? `${(cBBM / totPowered) * 100}%` : '0%';
    document.getElementById('barListrik').style.width = totPowered ? `${(cListrik / totPowered) * 100}%` : '0%';
    document.getElementById('barHybrid').style.width = totPowered ? `${(cHybrid / totPowered) * 100}%` : '0%';
    document.getElementById('barEnergiEmpty').style.width = totPowered ? `${(cEmpty / totPowered) * 100}%` : '0%';

    const enPct = (v) => totPowered > 0 ? Math.round((v / totPowered) * 100) + '%' : '0%';
    document.getElementById('lblEnBBM').innerText = cBBM;
    document.getElementById('pctEnBBM').innerText = enPct(cBBM);
    document.getElementById('lblEnListrik').innerText = cListrik;
    document.getElementById('pctEnListrik').innerText = enPct(cListrik);
    document.getElementById('lblEnHybrid').innerText = cHybrid;
    document.getElementById('pctEnHybrid').innerText = enPct(cHybrid);
    document.getElementById('lblEnEmpty').innerText = cEmpty;
    document.getElementById('pctEnEmpty').innerText = enPct(cEmpty);

    if (selectedBranch === 'Semua') renderFleetChartAll(baseData);
    else renderFleetChartBranch(scopeData);

    let u1_10 = 0, u10_15 = 0, u20plus = 0, trulyAbove20 = 0;
    validYears.forEach(d => {
        const age = BASE_YEAR - d.tahun_pembuatan;
        if (age <= 10) u1_10++;
        else if (age <= 15) u10_15++;
        else {
            u20plus++;
            if (age > 20) trulyAbove20++;
        }
    });

    const totalGrouped = u1_10 + u10_15 + u20plus;
    document.getElementById('lblAge1').innerText = u1_10;
    document.getElementById('pctAge1').innerText = totalGrouped ? Math.round((u1_10 / totalGrouped) * 100) + '%' : '0%';
    document.getElementById('lblAge2').innerText = u10_15;
    document.getElementById('pctAge2').innerText = totalGrouped ? Math.round((u10_15 / totalGrouped) * 100) + '%' : '0%';
    document.getElementById('lblAge3').innerText = u20plus;
    document.getElementById('pctAge3').innerText = totalGrouped ? Math.round((u20plus / totalGrouped) * 100) + '%' : '0%';

    const midOlder = u20plus - trulyAbove20;
    document.getElementById('ageSummaryNote').innerHTML = `<b>${u20plus} unit</b> berada di kelompok <b>Di Atas 20 Tahun</b> (${trulyAbove20} unit benar-benar > 20 th, sisanya ${midOlder} unit 16–20 th) dan menjadi prioritas peremajaan. <b>${u1_10} unit</b> masih berusia 1–10 tahun.`;

    if (pieChartInstance) pieChartInstance.destroy();
    pieChartInstance = new Chart(document.getElementById('agePieChart'), {
        type: 'doughnut',
        data: {
            labels: ['1–10 Tahun', '10–15 Tahun', 'Di Atas 20 Tahun'],
            datasets: [{
                data: [u1_10, u10_15, u20plus],
                backgroundColor: ['#059669', '#2563eb', '#e11d48'],
                borderWidth: 2,
                borderColor: '#ffffff'
            }]
        },
        plugins: [pieDataLabelsPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '48%',
            plugins: { legend: { display: false } }
        }
    });

    if (energyPieInstance) energyPieInstance.destroy();
    energyPieInstance = new Chart(document.getElementById('energyPieChart'), {
        type: 'doughnut',
        data: {
            labels: ['BBM', 'Listrik', 'Hybrid', 'Belum Diisi'],
            datasets: [{
                data: [cBBM, cListrik, cHybrid, cEmpty],
                backgroundColor: ['#c2410c', '#0284c7', '#7c3aed', '#e2e8f0'],
                borderWidth: 2,
                borderColor: '#ffffff'
            }]
        },
        plugins: [pieDataLabelsPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '48%',
            onClick: (e, elements) => {
                if (elements.length > 0) {
                    const labels = ['BBM', 'Listrik', 'Hybrid', 'Belum Diisi'];
                    filterByEnergy(labels[elements[0].index]);
                }
            },
            plugins: { legend: { display: false } }
        }
    });

    const catBBM = CATEGORIES_4.map(c => poweredUnits.filter(d => d.kategori4 === c && (d.sumber_energi || 'BBM') === 'BBM').length);
    const catListrik = CATEGORIES_4.map(c => poweredUnits.filter(d => d.kategori4 === c && d.sumber_energi === 'Listrik').length);
    const catHybrid = CATEGORIES_4.map(c => poweredUnits.filter(d => d.kategori4 === c && d.sumber_energi === 'Hybrid').length);
    const catEmpty = CATEGORIES_4.map(c => poweredUnits.filter(d => d.kategori4 === c && d.sumber_energi === 'Belum Diisi').length);

    if (energyCatBarInstance) energyCatBarInstance.destroy();
    energyCatBarInstance = new Chart(document.getElementById('energyCategoryChart'), {
        type: 'bar',
        data: {
            labels: CATEGORIES_4,
            datasets: [
                { label: 'BBM', data: catBBM, backgroundColor: '#c2410c', borderRadius: 3 },
                { label: 'Listrik', data: catListrik, backgroundColor: '#0284c7', borderRadius: 3 },
                { label: 'Hybrid', data: catHybrid, backgroundColor: '#7c3aed', borderRadius: 3 },
                { label: 'Belum Diisi', data: catEmpty, backgroundColor: '#e2e8f0', borderRadius: 3 }
            ]
        },
        plugins: [horizontalBarLabelsPlugin],
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { right: 44 } },
            plugins: {
                legend: {
                    position: 'top',
                    align: 'end',
                    labels: { boxWidth: 10, usePointStyle: true, pointStyle: 'rectRounded', font: { size: 11 } }
                }
            },
            scales: {
                x: { stacked: true, beginAtZero: true, grid: { color: '#f8fafc' }, border: { display: false } },
                y: { stacked: true, grid: { display: false }, ticks: { font: { weight: 'bold', size: 11 }, color: '#334155' } }
            }
        }
    });
}

// ---------- Grafik sebaran armada ----------
const FLEET_CAT_COLOR = { 'Alat Utama Dermaga': '#1e3a8a', 'Alat Utama Lapangan': '#3b82f6', 'Alat Pendukung': '#94a3b8', 'Alat Angkut': '#0f766e' };
function setFleetChartTitle(text) {
    const card = document.getElementById('terminalChart').closest('.card');
    const h = card && card.querySelector('h3');
    if (h) h.innerHTML = text;
}

// Semua cabang: batang bertumpuk per cabang (tampilan lama).
function renderFleetChartAll(baseData) {
    const cats = chartMode === 'semua' ? CATEGORIES_4 : CATEGORIES_4.slice(0, 2);
    const datasets = cats.map(c => ({
        label: c, backgroundColor: FLEET_CAT_COLOR[c], borderRadius: 2,
        data: TERMINALS.map(t => baseData.filter(d => d.terminal === t && d.kategori4 === c).length)
    }));
    const total = datasets.reduce((sum, ds) => sum + ds.data.reduce((a, b) => a + b, 0), 0);
    setFleetChartTitle('Jumlah alat per cabang &amp; kategori');
    document.getElementById('chartTotalFooter').innerText = `Total armada: ${total} unit`;

    if (barChartInstance) barChartInstance.destroy();
    barChartInstance = new Chart(document.getElementById('terminalChart'), {
        type: 'bar',
        data: { labels: TERMINALS, datasets },
        plugins: [barDataLabelsPlugin],
        options: {
            responsive: true, maintainAspectRatio: false,
            layout: { padding: { top: 24 } },
            onClick: (e, elements) => { if (elements.length > 0) selectBranch(TERMINALS[elements[0].index]); },
            plugins: { legend: { position: 'top', labels: { boxWidth: 10, font: { size: 11 } } } },
            scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, grid: { color: '#f1f5f9' } } }
        }
    });
}

// Satu cabang: batang horizontal per jenis alat, warna = kategori, bagian pucat = non operasional.
function renderFleetChartBranch(scopeData) {
    const cats = chartMode === 'semua' ? CATEGORIES_4 : CATEGORIES_4.slice(0, 2);
    const data = scopeData.filter(d => cats.includes(d.kategori4));
    const order = (typeof JENIS_ORDER !== 'undefined') ? JENIS_ORDER : [];
    const rank = j => { const i = order.indexOf(j); return i < 0 ? 999 : i; };
    const groups = {};
    data.forEach(d => {
        const k = d.jenis || '-';
        (groups[k] ||= { jenis: k, kat: d.kategori4, ops: 0, non: 0, kosong: 0 });
        if (d.status === 'Operasional') groups[k].ops++;
        else if (d.status === 'Non Operasional') groups[k].non++;
        else groups[k].kosong++;
    });
    const rows = Object.values(groups).sort((a, b) => cats.indexOf(a.kat) - cats.indexOf(b.kat) || rank(a.jenis) - rank(b.jenis));
    const nama = j => (typeof NAMA_JENIS !== 'undefined' && NAMA_JENIS[j]) ? NAMA_JENIS[j] : j;
    const alpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
    const col = r => FLEET_CAT_COLOR[r.kat];

    const opsTot = data.filter(d => d.status === 'Operasional').length;
    setFleetChartTitle(`Komposisi alat · <span class="text-blue-700">${selectedBranch}</span>`);
    document.getElementById('chartTotalFooter').innerHTML =
        `<span class="font-normal text-slate-500 mr-3"><button onclick="selectBranch('Semua')" class="text-blue-700 font-semibold hover:underline cursor-pointer">← Bandingkan semua cabang</button></span>` +
        `Total ${selectedBranch}: ${data.length} unit · ${opsTot} operasional`;

    const canvas = document.getElementById('terminalChart');
    if (barChartInstance) barChartInstance.destroy();
    if (!rows.length) { barChartInstance = null; canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); return; }

    const presentCats = cats.filter(c => rows.some(r => r.kat === c));
    barChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: rows.map(r => [r.jenis, nama(r.jenis)]),
            datasets: [
                { label: 'Operasional', data: rows.map(r => r.ops), backgroundColor: rows.map(col), borderRadius: 4, borderSkipped: false, barPercentage: 0.72, categoryPercentage: 0.9 },
                { label: 'Non Operasional', data: rows.map(r => r.non), backgroundColor: rows.map(r => alpha(col(r), 0.28)), borderColor: rows.map(col), borderWidth: 1, borderRadius: 4, borderSkipped: false, barPercentage: 0.72, categoryPercentage: 0.9 },
                { label: 'Belum Diisi', data: rows.map(r => r.kosong), backgroundColor: '#e2e8f0', borderRadius: 4, borderSkipped: false, barPercentage: 0.72, categoryPercentage: 0.9 }
            ]
        },
        plugins: [horizontalBarLabelsPlugin],
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            layout: { padding: { right: 44, top: 4 } },
            onClick: (e, el) => { if (el.length) filterByCategory(rows[el[0].index].kat); },
            plugins: {
                legend: {
                    position: 'top', align: 'start',
                    labels: {
                        boxWidth: 10, boxHeight: 10, font: { size: 11 }, padding: 12,
                        generateLabels: () => [
                            ...presentCats.map(c => ({ text: c, fillStyle: FLEET_CAT_COLOR[c], strokeStyle: FLEET_CAT_COLOR[c], lineWidth: 0, hidden: false, datasetIndex: -1 })),
                            { text: 'Pucat = non operasional', fillStyle: 'rgba(100,116,139,.25)', strokeStyle: '#64748b', lineWidth: 1, hidden: false, datasetIndex: -1 }
                        ]
                    },
                    onClick: () => { }
                },
                tooltip: {
                    callbacks: {
                        title: items => { const r = rows[items[0].dataIndex]; return `${r.jenis} · ${nama(r.jenis)}`; },
                        label: c => ` ${c.dataset.label}: ${c.raw} unit`,
                        footer: items => { const r = rows[items[0].dataIndex]; return `${r.kat} · total ${r.ops + r.non + r.kosong} unit`; }
                    }
                }
            },
            scales: {
                x: { stacked: true, beginAtZero: true, grid: { color: '#f1f5f9' }, border: { display: false }, ticks: { precision: 0, font: { size: 10 }, color: '#94a3b8' } },
                y: {
                    stacked: true, grid: { display: false }, border: { display: false },
                    ticks: {
                        autoSkip: false, font: ctx => ({ size: ctx.index === undefined ? 11 : 11, weight: '600' }), color: '#0f172a',
                        callback: function (v, i) { const r = rows[i]; return [r.jenis, nama(r.jenis)]; }
                    }
                }
            }
        }
    });
}

function filterByCategory(cat) {
    document.getElementById('filterCategory').value = cat;
    renderTable();
}

function filterByAgeGroup(grp) {
    document.getElementById('filterAge').value = grp;
    renderTable();
}

function filterByEnergy(en) {
    document.getElementById('filterEnergy').value = en;
    renderTable();
}

function resetFilters() {
    selectedBranch = 'Semua';
    document.getElementById('searchInput').value = '';
    document.getElementById('filterCategory').value = '';
    document.getElementById('filterAge').value = '';
    document.getElementById('filterEnergy').value = '';
    renderBranchTabs();
    updateDashboard();
    renderTable();
}

function renderTable() {
    const baseData = getActiveDataset();
    const q = document.getElementById('searchInput').value.toLowerCase();
    const catFilter = document.getElementById('filterCategory').value;
    const ageFilter = document.getElementById('filterAge').value;
    const energyFilter = document.getElementById('filterEnergy').value;
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    const filtered = baseData.filter(item => {
        if (selectedBranch !== 'Semua' && item.terminal !== selectedBranch) return false;
        if (catFilter && item.kategori4 !== catFilter) return false;
        if (energyFilter && (item.sumber_energi || 'BBM') !== energyFilter) return false;

        if (ageFilter) {
            if (!item.tahun_pembuatan) return false;
            const age = BASE_YEAR - item.tahun_pembuatan;
            if (ageFilter === '1-10' && age > 10) return false;
            if (ageFilter === '10-15' && (age <= 10 || age > 15)) return false;
            if (ageFilter === '20+' && age <= 15) return false;
        }

        if (q) {
            const match = (item.nomor_alat || '').toLowerCase().includes(q) ||
                          (item.jenis || '').toLowerCase().includes(q) ||
                          (item.brand || '').toLowerCase().includes(q) ||
                          (item.terminal || '').toLowerCase().includes(q);
            if (!match) return false;
        }
        return true;
    });

    document.getElementById('tableCountBadge').innerText = `Menampilkan ${filtered.length} dari ${baseData.length} unit`;

    filtered.forEach((item, idx) => {
        const age = item.tahun_pembuatan ? (BASE_YEAR - item.tahun_pembuatan) : null;
        let ageBadge = '<span class="text-slate-400">-</span>';
        if (age !== null) {
            if (age > 20) ageBadge = `<span class="px-2 py-0.5 bg-rose-100 text-rose-800 rounded font-bold text-[10px]">${age} th</span>`;
            else if (age > 15) ageBadge = `<span class="px-2 py-0.5 bg-amber-100 text-amber-800 rounded font-bold text-[10px]">${age} th</span>`;
            else ageBadge = `<span class="px-2 py-0.5 bg-slate-100 text-slate-700 rounded font-semibold text-[10px]">${age} th</span>`;
        }

        const en = item.sumber_energi || 'BBM';
        let energyBadge = `<span class="px-2 py-0.5 bg-orange-50 text-orange-700 rounded text-[10px] font-semibold">${en}</span>`;
        if (en === 'Listrik') energyBadge = `<span class="px-2 py-0.5 bg-sky-50 text-sky-700 rounded text-[10px] font-semibold">Listrik</span>`;
        else if (en === 'Hybrid') energyBadge = `<span class="px-2 py-0.5 bg-purple-50 text-purple-700 rounded text-[10px] font-semibold">Hybrid</span>`;
        else if (en === 'Non-Engine' || en === 'Belum Diisi') energyBadge = `<span class="px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-[10px]">${en}</span>`;

        let statusBadge = `<span class="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full text-[10px]">${item.status || 'Belum Diisi'}</span>`;
        if (item.status === 'Operasional') statusBadge = `<span class="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-full font-semibold text-[10px]">Operasional</span>`;
        else if (item.status === 'Non Operasional') statusBadge = `<span class="px-2 py-0.5 bg-rose-100 text-rose-800 rounded-full font-semibold text-[10px]">Non Operasional</span>`;

        let actionHtml = '';
        if (userRole === 'admin' || userRole === 'editor') {
            actionHtml += `<button onclick="openEditModalById(${item.id})" class="text-blue-600 hover:text-blue-800 mr-2 cursor-pointer" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>`;
        }
        if (userRole === 'admin') {
            actionHtml += `<button onclick="deleteAlat(${item.id})" class="text-rose-600 hover:text-rose-800 cursor-pointer" title="Hapus"><i class="fa-solid fa-trash-can"></i></button>`;
        }

        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-50 transition';
        tr.innerHTML = `
            <td class="p-3 font-medium text-slate-400">${idx + 1}</td>
            <td class="p-3 font-semibold text-slate-800">${item.terminal}</td>
            <td class="p-3">${item.kategori4}</td>
            <td class="p-3 font-bold text-slate-700">${item.jenis}</td>
            <td class="p-3 font-bold text-blue-900">${item.nomor_alat}</td>
            <td class="p-3">${item.brand || '-'}</td>
            <td class="p-3 text-center">${item.tahun_pembuatan || '-'}</td>
            <td class="p-3 text-center">${ageBadge}</td>
            <td class="p-3">${energyBadge}</td>
            <td class="p-3">${statusBadge}</td>
            ${userRole !== 'viewer' ? `<td class="p-3 text-center">${actionHtml}</td>` : ''}
        `;
        tbody.appendChild(tr);
    });
}

function openModal() {
    document.getElementById('editId').value = '';
    document.getElementById('inJenis').value = '';
    document.getElementById('inNomor').value = '';
    document.getElementById('inBrand').value = '';
    document.getElementById('inTahun').value = '';
    document.getElementById('inEnergi').value = 'BBM';
    setSpecInputs({});
    document.getElementById('modalTitle').innerText = 'Tambah Data Alat Baru';
    document.getElementById('modalForm').classList.remove('hidden');
    document.getElementById('modalForm').classList.add('flex');
}

function openEditModal(item) {
    document.getElementById('editId').value = item.id;
    document.getElementById('inTerminal').value = item.terminal;
    document.getElementById('inArea').value = item.area;
    document.getElementById('inJenis').value = item.jenis;
    document.getElementById('inNomor').value = item.nomor_alat;
    document.getElementById('inBrand').value = item.brand || '';
    document.getElementById('inTahun').value = item.tahun_pembuatan || '';
    document.getElementById('inEnergi').value = item.sumber_energi || 'BBM';
    document.getElementById('inStatus').value = item.status || 'Operasional';
    setSpecInputs(item);
    document.getElementById('modalTitle').innerText = `Edit Data Alat: ${item.nomor_alat}`;
    document.getElementById('modalForm').classList.remove('hidden');
    document.getElementById('modalForm').classList.add('flex');
}

function openEditModalById(id) {
    const item = rawData.find(d => String(d.id) === String(id));
    if (item) openEditModal(item);
}

// ---------- Spesifikasi teknis (size type, span, outreach, SWL) ----------
const SPEC_FIELDS = [
    ['inSize', 'size_type', 'text'],
    ['inSpan', 'span', 'num'],
    ['inOutreach', 'outreach', 'num'],
    ['inSwl', 'swl', 'num']
];

function setSpecInputs(item) {
    SPEC_FIELDS.forEach(([elId, col]) => {
        const el = document.getElementById(elId);
        if (el) el.value = (item[col] === null || item[col] === undefined) ? '' : item[col];
    });
}

// Mengembalikan { data } atau { error } bila angka tidak valid
function readSpecInputs() {
    const out = {};
    for (const [elId, col, type] of SPEC_FIELDS) {
        const el = document.getElementById(elId);
        if (!el) continue;
        const raw = el.value.trim();
        if (type === 'text') { out[col] = raw ? raw.toUpperCase() : null; continue; }
        if (raw === '') { out[col] = null; continue; }
        const n = parseFloat(raw.replace(',', '.'));
        if (!Number.isFinite(n) || n < 0) return { error: `${el.dataset.label || col} harus berupa angka ≥ 0.` };
        out[col] = n;
    }
    return { data: out };
}

function closeModal() {
    document.getElementById('modalForm').classList.add('hidden');
    document.getElementById('modalForm').classList.remove('flex');
}

async function saveAlat() {
    const id = document.getElementById('editId').value;
    const payload = {
        terminal: document.getElementById('inTerminal').value,
        area: document.getElementById('inArea').value,
        jenis: document.getElementById('inJenis').value.trim().toUpperCase(),
        nomor_alat: document.getElementById('inNomor').value.trim(),
        brand: document.getElementById('inBrand').value.trim() || '-',
        tahun_pembuatan: parseInt(document.getElementById('inTahun').value) || null,
        sumber_energi: document.getElementById('inEnergi').value,
        status: document.getElementById('inStatus').value
    };

    if (!payload.jenis || !payload.nomor_alat) {
        alert('Jenis alat dan nomor alat wajib diisi.');
        return;
    }

    const spec = readSpecInputs();
    if (spec.error) { alert(spec.error); return; }
    Object.assign(payload, spec.data);

    const res = id 
        ? await supabaseClient.from('peralatan').update(payload).eq('id', id)
        : await supabaseClient.from('peralatan').insert([payload]);

    if (res.error) {
        alert('Gagal menyimpan data: ' + res.error.message);
        return;
    }
    closeModal();
    await loadData();
}

async function deleteAlat(id) {
    if (!confirm('Hapus permanen data alat ini dari database Supabase?')) return;
    const { error } = await supabaseClient.from('peralatan').delete().eq('id', id);
    if (error) {
        alert('Gagal menghapus (Hanya Admin yang diizinkan): ' + error.message);
        return;
    }
    await loadData();
}

function exportCSV() {
    const rows = (typeof getExportRows === 'function') ? getExportRows() : getActiveDataset();
    const headers = ['Terminal', 'Kategori', 'Jenis', 'Nomor Alat', 'Brand', 'Tahun Pembuatan', 'Sumber Energi', 'Status', 'Size Type', 'Span (m)', 'Outreach (m)', 'SWL (ton)'];
    const val = v => (v === null || v === undefined ? '' : v);
    const lines = rows.map(d => [d.terminal, d.kategori4, d.jenis, d.nomor_alat, d.brand, d.tahun_pembuatan, d.sumber_energi, d.status, d.size_type, d.span, d.outreach, d.swl]
        .map(v => `"${String(val(v)).replace(/"/g, '""')}"`).join(','));
    const csv = '\uFEFF' + [headers.join(','), ...lines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Database_SIMALAT_IPCTPK_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
}

function applyBaseYear() {
    document.querySelectorAll('.base-year').forEach(el => { el.textContent = BASE_YEAR; });
    const inTahun = document.getElementById('inTahun');
    if (inTahun) inTahun.max = BASE_YEAR;
}

window.onload = () => { applyBaseYear(); checkSession(); };
// =====================================================================
//  EKSPOR EXCEL (.xlsx) — sheet "Ringkasan Eksekutif" + "Database Alat"
//  Mengikuti data yang sedang tampil di tabel (cabang & filter aktif).
// =====================================================================
const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const NAMA_JENIS = {
    QCC: 'Quay Container Crane', GLC: 'Gantry Luffing Crane', GJC: 'Gantry Jib Crane', FJC: 'Fixed Jib Crane',
    RTG: 'Rubber Tyred Gantry', RMGC: 'Rail Mounted Gantry Crane', RST: 'Reach Stacker', SIL: 'Side Loader',
    FLT: 'Forklift', HDT: 'Head Truck', TTR: 'Terminal Tractor', CHS: 'Chassis', SPREADER: 'Spreader'
};
const JENIS_ORDER = ['QCC', 'GLC', 'GJC', 'FJC', 'RTG', 'RMGC', 'RST', 'SIL', 'FLT', 'HDT', 'TTR', 'CHS', 'SPREADER'];
const AGE_LABELS = ['1–10 Tahun', '10–15 Tahun', 'Di Atas 20 Tahun'];
const AGE_UNSET = 'Tahun Belum Diisi';
const XL_CAT_COLOR = { 'Alat Utama Dermaga': '#1e3a8a', 'Alat Utama Lapangan': '#3b82f6', 'Alat Pendukung': '#94a3b8', 'Alat Angkut': '#0f766e' };
const XL_EN_COLOR = { 'BBM': '#c2410c', 'Listrik': '#0284c7', 'Hybrid': '#7c3aed', 'Belum Diisi': '#cbd5e1', 'Non-Engine': '#64748b' };

const energiOf = (d) => d.sumber_energi || 'BBM';
const usiaOf = (d) => (d.tahun_pembuatan && d.tahun_pembuatan > 1950 ? BASE_YEAR - d.tahun_pembuatan : null);
function kelompokUsia(d) {
    const u = usiaOf(d);
    if (u === null) return AGE_UNSET;
    return u <= 10 ? AGE_LABELS[0] : u <= 15 ? AGE_LABELS[1] : AGE_LABELS[2];
}

// Data yang sama dengan isi tabel saat ini
function getExportRows() {
    const q = document.getElementById('searchInput').value.toLowerCase();
    const catFilter = document.getElementById('filterCategory').value;
    const ageFilter = document.getElementById('filterAge').value;
    const energyFilter = document.getElementById('filterEnergy').value;
    const ageKey = { '1-10': AGE_LABELS[0], '10-15': AGE_LABELS[1], '20+': AGE_LABELS[2] };
    return getActiveDataset().filter(item => {
        if (selectedBranch !== 'Semua' && item.terminal !== selectedBranch) return false;
        if (catFilter && item.kategori4 !== catFilter) return false;
        if (energyFilter && energiOf(item) !== energyFilter) return false;
        if (ageFilter && kelompokUsia(item) !== ageKey[ageFilter]) return false;
        if (q && ![item.nomor_alat, item.jenis, item.brand, item.terminal].some(v => String(v || '').toLowerCase().includes(q))) return false;
        return true;
    });
}
function describeExportScope() {
    const parts = [selectedBranch === 'Semua' ? 'Seluruh 6 terminal' : `Cabang ${selectedBranch}`];
    const cat = document.getElementById('filterCategory').value;
    const age = document.getElementById('filterAge').value;
    const en = document.getElementById('filterEnergy').value;
    const q = document.getElementById('searchInput').value.trim();
    if (cat) parts.push(cat);
    if (age) parts.push(`Usia ${age.replace('20+', 'di atas 20')} th`);
    if (en) parts.push(`Energi ${en}`);
    if (q) parts.push(`Cari "${q}"`);
    if (includePassive) parts.push('termasuk chassis & spreader');
    return parts.join(' · ');
}

function loadExcelJS() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = EXCELJS_URL;
        s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('ExcelJS tidak tersedia')));
        s.onerror = () => reject(new Error('Gagal memuat pustaka Excel'));
        document.head.appendChild(s);
    });
}

function chartToImage(config, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.style.cssText = 'position:fixed;left:-10000px;top:0;';
    document.body.appendChild(canvas);
    const whiteBg = { id: 'whiteBg', beforeDraw(c) { const x = c.ctx; x.save(); x.globalCompositeOperation = 'destination-over'; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.restore(); } };
    config.options = { ...(config.options || {}), responsive: false, maintainAspectRatio: false, animation: false, devicePixelRatio: 2 };
    config.plugins = [...(config.plugins || []), whiteBg];
    const chart = new Chart(canvas, config);
    const url = chart.toBase64Image('image/png', 1);
    chart.destroy(); canvas.remove();
    return url;
}

async function exportExcel(btn) {
    const data = getExportRows();
    if (!data.length) { alert('Tidak ada data untuk diekspor (cek filter).'); return; }
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Menyiapkan…'; }
    try {
        const ExcelJS = await loadExcelJS();
        await buildExcel(ExcelJS, data);
    } catch (err) {
        console.error(err);
        alert('Ekspor Excel gagal (' + err.message + '). File CSV diunduh sebagai gantinya.');
        exportCSV();
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
}

function statsOf(list) {
    const aged = list.filter(d => usiaOf(d) !== null);
    return {
        total: list.length,
        ops: list.filter(d => d.status === 'Operasional').length,
        non: list.filter(d => d.status === 'Non Operasional').length,
        age: AGE_LABELS.map(a => list.filter(d => kelompokUsia(d) === a).length),
        ageUnset: list.filter(d => usiaOf(d) === null).length,
        avg: aged.length ? Math.round((aged.reduce((s, d) => s + usiaOf(d), 0) / aged.length) * 100) / 100 : 0,
        oldest: aged.sort((a, b) => usiaOf(b) - usiaOf(a))[0] || null,
        strict20: aged.filter(d => usiaOf(d) > 20).length
    };
}

async function buildExcel(ExcelJS, data) {
    const NAVY = 'FF0F1F3D', NAVY2 = 'FF1E3A6E', GOLD = 'FFE8B84A', INK = 'FF1E293B', MUTED = 'FF64748B', LINE = 'FFE2E8F0', ZEBRA = 'FFF7F9FC', RED = 'FFBE123C';
    const now = new Date(), p2 = n => String(n).padStart(2, '0');
    const stampText = `${p2(now.getDate())}-${p2(now.getMonth() + 1)}-${now.getFullYear()} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
    const stampFile = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}`;
    const scopeText = describeExportScope();
    const S = statsOf(data);
    const energies = ['BBM', 'Listrik', 'Hybrid', 'Belum Diisi', ...(data.some(d => energiOf(d) === 'Non-Engine') ? ['Non-Engine'] : [])];
    const argb = hex => 'FF' + hex.replace('#', '').toUpperCase();
    const solid = c => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: c } });
    const thin = (c = LINE) => ({ style: 'thin', color: { argb: c } });
    const font = (o = {}) => ({ name: 'Calibri', size: 10, color: { argb: INK }, ...o });
    const fx = (formula, result) => ({ formula, result });
    const q = v => String(v).replace(/"/g, '""');
    const pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIMALAT (Sistem Manajemen Alat)';
    wb.company = 'PT IPC Terminal Petikemas';
    wb.created = now;
    wb.calcProperties.fullCalcOnLoad = true;
    const sm = wb.addWorksheet('Ringkasan Eksekutif', { properties: { tabColor: { argb: GOLD } }, views: [{ showGridLines: false, zoomScale: 90 }], pageSetup,
        headerFooter: { oddFooter: '&L&8SIMALAT — Ringkasan Eksekutif&R&8Halaman &P dari &N' } });
    const db = wb.addWorksheet('Database Alat', { properties: { tabColor: { argb: NAVY2 } }, pageSetup,
        headerFooter: { oddFooter: '&L&8SIMALAT (Sistem Manajemen Alat) — PT IPC Terminal Petikemas&C&8Halaman &P dari &N&R&8Dicetak &D' } });

    // ================= DATABASE ALAT =================
    const COLS = [['No', 6], ['Terminal', 16], ['Kategori Alat', 20], ['Kode Jenis', 10], ['Nama Jenis Alat', 24], ['Nomor Alat', 18], ['Brand / Tipe', 26],
        ['Tahun Pembuatan', 11], ['Usia (th)', 9], ['Kelompok Usia', 17], ['Status Alat', 16], ['Sumber Energi', 14], ['Size Type', 15], ['Span (m)', 10], ['Outreach (m)', 11], ['SWL (ton)', 10]];
    const NC = COLS.length, lastL = db.getColumn(NC).letter;
    COLS.forEach(([, w], i) => { db.getColumn(i + 1).width = w; });
    db.mergeCells(`A1:${lastL}1`);
    db.getCell('A1').value = 'DATABASE PERALATAN — PT IPC TERMINAL PETIKEMAS';
    db.getCell('A1').font = font({ size: 16, bold: true, color: { argb: 'FFFFFFFF' } });
    db.getCell('A1').alignment = { vertical: 'middle', indent: 1 };
    db.getRow(1).height = 30;
    db.mergeCells(`A2:${lastL}2`);
    db.getCell('A2').value = `Cakupan: ${scopeText}   ·   ${data.length} unit   ·   Tahun acuan usia ${BASE_YEAR}   ·   Diekspor ${stampText}`;
    db.getCell('A2').font = font({ size: 9, italic: true, color: { argb: 'FFDBE4F3' } });
    db.getCell('A2').alignment = { vertical: 'middle', indent: 1 };
    db.getRow(2).height = 18;
    for (let c = 1; c <= NC; c++) { db.getCell(1, c).fill = solid(NAVY); db.getCell(2, c).fill = solid(NAVY2); db.getCell(3, c).fill = solid(GOLD); }
    db.getRow(3).height = 3;

    const sorted = [...data].sort((a, b) =>
        TERMINALS.indexOf(a.terminal) - TERMINALS.indexOf(b.terminal) ||
        CATEGORIES_4.indexOf(a.kategori4) - CATEGORIES_4.indexOf(b.kategori4) ||
        JENIS_ORDER.indexOf(a.jenis) - JENIS_ORDER.indexOf(b.jenis) ||
        String(a.nomor_alat).localeCompare(String(b.nomor_alat), 'id', { numeric: true }));
    const nn = v => (v === null || v === undefined || v === '' || v === '-' ? null : v);
    const HDR = 5;
    db.addTable({
        name: 'tblAlat', ref: `A${HDR}`, headerRow: true, totalsRow: false,
        style: { theme: 'TableStyleMedium2', showRowStripes: true },
        columns: COLS.map(([name]) => ({ name, filterButton: true })),
        rows: sorted.map((d, i) => [i + 1, d.terminal, d.kategori4, d.jenis, NAMA_JENIS[d.jenis] || d.jenis, d.nomor_alat, nn(d.brand),
            nn(d.tahun_pembuatan), usiaOf(d), kelompokUsia(d), d.status || 'Belum Diisi', energiOf(d), nn(d.size_type),
            nn(d.span) === null ? null : Number(d.span), nn(d.outreach) === null ? null : Number(d.outreach), nn(d.swl) === null ? null : Number(d.swl)])
    });
    const hdr = db.getRow(HDR);
    hdr.height = 32;
    hdr.eachCell(c => {
        c.font = font({ bold: true, size: 9.5, color: { argb: 'FFFFFFFF' } });
        c.fill = solid(NAVY);
        c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        c.border = { left: thin('FF2A3F66'), right: thin('FF2A3F66') };
    });
    const center = new Set([1, 4, 8, 9, 10, 11, 12, 13]);
    const ageFill = { [AGE_LABELS[0]]: ['FFE7F6EE', 'FF047857'], [AGE_LABELS[1]]: ['FFE6EEFB', 'FF1D4ED8'], [AGE_LABELS[2]]: ['FFFDE8EC', RED] };
    const statFill = { 'Operasional': ['FFE7F6EE', 'FF047857'], 'Non Operasional': ['FFFDE8EC', RED], 'Belum Diisi': ['FFF1F5F9', MUTED] };
    sorted.forEach((d, i) => {
        const r = db.getRow(HDR + 1 + i);
        r.height = 17;
        for (let c = 1; c <= NC; c++) {
            const cell = r.getCell(c);
            cell.font = font({ size: 9.5 });
            cell.alignment = { vertical: 'middle', horizontal: center.has(c) ? 'center' : (c >= 14 ? 'right' : 'left') };
            cell.border = { bottom: thin() };
        }
        r.getCell(6).font = font({ size: 9.5, bold: true, color: { argb: NAVY } });
        r.getCell(3).font = font({ size: 9.5, bold: true, color: { argb: argb(d.kategori4 === 'Alat Pendukung' ? '#475569' : (XL_CAT_COLOR[d.kategori4] || '#334155')) } });
        const a = ageFill[kelompokUsia(d)];
        if (a) { r.getCell(10).fill = solid(a[0]); r.getCell(10).font = font({ size: 9.5, bold: true, color: { argb: a[1] } }); }
        else r.getCell(10).font = font({ size: 9.5, italic: true, color: { argb: 'FF94A3B8' } });
        const st = statFill[d.status || 'Belum Diisi'];
        if (st) { r.getCell(11).fill = solid(st[0]); r.getCell(11).font = font({ size: 9.5, bold: true, color: { argb: st[1] } }); }
        r.getCell(12).font = font({ size: 9.5, bold: true, color: { argb: argb(energiOf(d) === 'Belum Diisi' ? '#94a3b8' : (XL_EN_COLOR[energiOf(d)] || '#334155')) } });
        if (usiaOf(d) !== null && usiaOf(d) > 20) r.getCell(9).font = font({ size: 9.5, bold: true, color: { argb: RED } });
        r.getCell(8).numFmt = '0';
        [14, 15].forEach(c => { r.getCell(c).numFmt = '#,##0.00;-#,##0.00;;@'; });
        r.getCell(16).numFmt = '#,##0.0;-#,##0.0;;@';
    });
    db.views = [{ state: 'frozen', xSplit: 0, ySplit: HDR, topLeftCell: `A${HDR + 1}`, activeCell: `A${HDR + 1}`, showGridLines: false }];
    db.pageSetup.printTitlesRow = `${HDR}:${HDR}`;

    // ================= RINGKASAN EKSEKUTIF =================
    const LASTC = 14, LC = sm.getColumn(LASTC).letter;
    sm.getColumn(1).width = 2; sm.getColumn(2).width = 26;
    for (let c = 3; c <= LASTC; c++) sm.getColumn(c).width = 11.5;
    sm.getColumn(LASTC + 1).width = 2;
    const band = (row, text, size, fg, bg, height) => {
        sm.mergeCells(`B${row}:${LC}${row}`);
        const c = sm.getCell(`B${row}`);
        c.value = text; c.font = font({ size, bold: size >= 14, italic: size < 11, color: { argb: fg } });
        c.alignment = { vertical: 'middle', indent: 1 };
        for (let col = 1; col <= LASTC + 1; col++) sm.getCell(row, col).fill = solid(bg);
        sm.getRow(row).height = height;
    };
    band(1, '', 8, 'FFFFFFFF', NAVY, 8);
    band(2, 'RINGKASAN EKSEKUTIF PERALATAN', 18, 'FFFFFFFF', NAVY, 30);
    band(3, 'SIMALAT (Sistem Manajemen Alat) · PT IPC Terminal Petikemas · Tanjung Priok · Panjang · Jambi · Teluk Bayur · Palembang · Pontianak', 10, 'FFC9D3E6', NAVY, 18);
    band(4, `Cakupan: ${scopeText}  ·  Tahun acuan usia ${BASE_YEAR}  ·  Diekspor ${stampText}  ·  Sumber: sheet "Database Alat"`, 9, 'FFFFFFFF', NAVY2, 18);
    for (let col = 1; col <= LASTC + 1; col++) sm.getCell(5, col).fill = solid(GOLD);
    sm.getRow(5).height = 3;

    const R = col => `'Database Alat'!$${col}$${HDR + 1}:$${col}$5000`;
    const rT = R('B'), rK4 = R('C'), rJ = R('D'), rN = R('F'), rU = R('I'), rKU = R('J'), rS = R('K'), rE = R('L'), rW = R('P');

    // Kartu KPI
    const cats = CATEGORIES_4;
    const kpis = [
        ['TOTAL ALAT', fx(`COUNTIFS(${rN},"<>")`, S.total), '#,##0', NAVY, `${S.ops} operasional (${S.total ? Math.round(S.ops / S.total * 100) : 0}%)`],
        ...cats.map(c => { const n = data.filter(d => d.kategori4 === c).length; return [c.toUpperCase(), fx(`COUNTIFS(${rK4},"${q(c)}")`, n), '#,##0', argb(c === 'Alat Pendukung' ? '#475569' : XL_CAT_COLOR[c]), `${S.total ? Math.round(n / S.total * 100) : 0}% dari total`]; }),
        ['RATA-RATA USIA', fx(`IFERROR(AVERAGE(${rU}),0)`, S.avg), '0.0" th"', NAVY2, S.oldest ? `tertua ${S.oldest.nomor_alat} (${usiaOf(S.oldest)} th)` : '–'],
        ['DI ATAS 20 TH (KELOMPOK)', fx(`COUNTIFS(${rKU},"${AGE_LABELS[2]}")`, S.age[2]), '#,##0', RED, `${S.strict20} unit benar-benar > 20 th`]
    ];
    let col = 2; const KR = 7;
    kpis.forEach(([label, val, fmt, color, sub], i) => {
        const span = i === 0 ? 1 : 2, c1 = col, c2 = col + span - 1;
        if (c2 > LASTC) return;
        const L1 = sm.getColumn(c1).letter, L2 = sm.getColumn(c2).letter;
        if (span > 1) [KR, KR + 1, KR + 2].forEach(r => sm.mergeCells(`${L1}${r}:${L2}${r}`));
        const l = sm.getCell(KR, c1), v = sm.getCell(KR + 1, c1), t = sm.getCell(KR + 2, c1);
        l.value = label; l.font = font({ size: 8, bold: true, color: { argb: MUTED } });
        v.value = val; v.numFmt = fmt; v.font = font({ size: 20, bold: true, color: { argb: color } });
        t.value = sub; t.font = font({ size: 8, color: { argb: MUTED } });
        [l, v, t].forEach(c => { c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, shrinkToFit: true }; });
        for (let r = KR; r <= KR + 2; r++) for (let cc = c1; cc <= c2; cc++) {
            const cell = sm.getCell(r, cc);
            cell.fill = solid('FFF4F6FA');
            const bd = {};
            if (cc === c1) bd.left = { style: 'thick', color: { argb: color } };
            if (cc === c2) bd.right = { style: 'thin', color: { argb: 'FFFFFFFF' } };
            cell.border = bd;
        }
        col = c2 + 1;
    });
    sm.getRow(KR).height = 18; sm.getRow(KR + 1).height = 30; sm.getRow(KR + 2).height = 16;

    const section = (row, text) => {
        sm.mergeCells(`B${row}:${LC}${row}`);
        const c = sm.getCell(`B${row}`);
        c.value = text; c.font = font({ size: 11.5, bold: true, color: { argb: NAVY } });
        for (let cc = 2; cc <= LASTC; cc++) sm.getCell(row, cc).border = { bottom: { style: 'medium', color: { argb: NAVY } } };
        sm.getRow(row).height = 20;
    };
    const headRow = (row, labels) => {
        labels.forEach((lab, i) => {
            const c = sm.getCell(row, 2 + i);
            c.value = lab; c.font = font({ size: 9, bold: true, color: { argb: 'FFFFFFFF' } });
            c.fill = solid(NAVY2); c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            c.border = { right: thin('FF3B5486') };
        });
        sm.getRow(row).height = 32;
    };
    const cellB = (row, cc, value, fmt, o = {}) => {
        const c = sm.getCell(row, cc);
        c.value = value; if (fmt) c.numFmt = fmt;
        c.font = font({ size: 9.5, bold: !!o.bold, color: { argb: o.color || INK } });
        c.alignment = { horizontal: cc === 2 ? 'left' : 'center', vertical: 'middle', indent: cc === 2 ? 1 : 0 };
        c.border = o.total ? { bottom: thin(), top: { style: 'thin', color: { argb: NAVY } } } : { bottom: thin() };
        if (o.total) c.fill = solid('FFDCE6F2'); else if (o.zebra) c.fill = solid(ZEBRA);
    };
    const DASH = '#,##0;-#,##0;"–"';
    const totalRow = (r, first, fromCol, toCol, extra = {}) => {
        cellB(r, 2, 'TOTAL', null, { total: true, bold: true });
        for (let cc = 3; cc <= toCol; cc++) {
            if (cc < fromCol || extra[cc] === null) { cellB(r, cc, '', null, { total: true }); continue; }
            if (extra[cc]) { cellB(r, cc, extra[cc][0], extra[cc][1], { total: true, bold: true }); continue; }
            const L = sm.getColumn(cc).letter;
            let sum = 0;
            for (let k = first; k < r; k++) { const v = sm.getCell(k, cc).value; sum += (v && v.result) || 0; }
            cellB(r, cc, fx(`SUM(${L}${first}:${L}${r - 1})`, sum), '#,##0', { total: true, bold: true });
        }
    };
    const short = c => c.replace('Alat Utama ', '').replace('Alat ', '');

    // A. per terminal
    let row = KR + 4;
    section(row, 'A. REKAP ALAT PER TERMINAL & KATEGORI');
    row += 1;
    const colsA = ['Terminal', 'Total Alat', ...cats.map(short), 'Operasional', 'Non Ops', ...AGE_LABELS, 'Tahun Belum Diisi', 'Rata-rata Usia (th)'];
    headRow(row, colsA);
    const fA = row + 1;
    TERMINALS.forEach((t, k) => {
        const r = fA + k, d = data.filter(x => x.terminal === t), st = statsOf(d), c = `${rT},"${q(t)}"`, z = { zebra: k % 2 === 1 };
        let cc = 2;
        cellB(r, cc++, t, null, z);
        cellB(r, cc++, fx(`COUNTIFS(${c},${rN},"<>")`, st.total), '#,##0', { ...z, bold: true });
        cats.forEach(cat => cellB(r, cc++, fx(`COUNTIFS(${c},${rK4},"${q(cat)}")`, d.filter(x => x.kategori4 === cat).length), DASH, z));
        cellB(r, cc++, fx(`COUNTIFS(${c},${rS},"Operasional")`, st.ops), DASH, z);
        cellB(r, cc++, fx(`COUNTIFS(${c},${rS},"Non Operasional")`, st.non), DASH, { ...z, color: st.non ? RED : INK });
        AGE_LABELS.forEach((g, j) => cellB(r, cc++, fx(`COUNTIFS(${c},${rKU},"${g}")`, st.age[j]), DASH, { ...z, color: j === 2 && st.age[2] ? RED : INK, bold: j === 2 }));
        cellB(r, cc++, fx(`COUNTIFS(${c},${rKU},"${AGE_UNSET}")`, st.ageUnset), DASH, z);
        cellB(r, cc++, fx(`IFERROR(AVERAGEIFS(${rU},${c}),0)`, st.avg), '0.0', z);
    });
    const endA = 1 + colsA.length;
    totalRow(fA + TERMINALS.length, fA, 3, endA, { [endA]: [fx(`IFERROR(AVERAGE(${rU}),0)`, S.avg), '0.0'] });

    // B. per kategori × energi
    row = fA + TERMINALS.length + 3;
    section(row, 'B. REKAP PER KATEGORI ALAT & SUMBER ENERGI');
    row += 1;
    const colsB = ['Kategori Alat', 'Total Alat', 'Operasional', '% Operasional', ...energies, 'Di Atas 20 Tahun', 'Rata-rata Usia (th)'];
    headRow(row, colsB);
    const fB = row + 1;
    cats.forEach((cat, k) => {
        const r = fB + k, d = data.filter(x => x.kategori4 === cat), st = statsOf(d), c = `${rK4},"${q(cat)}"`, z = { zebra: k % 2 === 1 };
        let cc = 2;
        cellB(r, cc++, cat, null, z);
        cellB(r, cc++, fx(`COUNTIFS(${c})`, st.total), '#,##0', { ...z, bold: true });
        cellB(r, cc++, fx(`COUNTIFS(${c},${rS},"Operasional")`, st.ops), DASH, z);
        cellB(r, cc++, fx(`IFERROR(D${r}/C${r},0)`, st.total ? st.ops / st.total : 0), '0.0%', z);
        energies.forEach(e => cellB(r, cc++, fx(`COUNTIFS(${c},${rE},"${e}")`, d.filter(x => energiOf(x) === e).length), DASH, z));
        cellB(r, cc++, fx(`COUNTIFS(${c},${rKU},"${AGE_LABELS[2]}")`, st.age[2]), DASH, { ...z, color: st.age[2] ? RED : INK, bold: true });
        cellB(r, cc++, fx(`IFERROR(AVERAGEIFS(${rU},${c}),0)`, st.avg), '0.0', z);
    });
    const tB = fB + cats.length, endB = 1 + colsB.length;
    totalRow(tB, fB, 3, endB, { 5: [fx(`IFERROR(D${tB}/C${tB},0)`, S.total ? S.ops / S.total : 0), '0.0%'], [endB]: [fx(`IFERROR(AVERAGE(${rU}),0)`, S.avg), '0.0'] });

    // C. per jenis
    row = tB + 3;
    section(row, 'C. REKAP ALAT PER JENIS & SPESIFIKASI');
    row += 1;
    const colsC = ['Jenis Alat', 'Kode', 'Kategori', 'Total', 'Operasional', 'Non Ops', ...AGE_LABELS, 'Tahun Belum Diisi', 'Rata-rata Usia (th)', 'SWL Maks (ton)', 'Size Type'];
    headRow(row, colsC);
    const fC = row + 1;
    const jenisList = [...JENIS_ORDER, ...new Set(data.map(d => d.jenis).filter(j => !JENIS_ORDER.includes(j)))].filter(j => data.some(d => d.jenis === j));
    jenisList.forEach((j, k) => {
        const r = fC + k, d = data.filter(x => x.jenis === j), st = statsOf(d), c = `${rJ},"${q(j)}"`, z = { zebra: k % 2 === 1 };
        const swls = d.map(x => Number(x.swl)).filter(v => Number.isFinite(v) && v > 0);
        const sizes = [...new Set(d.map(x => x.size_type).filter(Boolean))].join(', ');
        let cc = 2;
        cellB(r, cc++, NAMA_JENIS[j] || j, null, z);
        cellB(r, cc++, j, null, z);
        cellB(r, cc++, short(d[0].kategori4), null, z);
        cellB(r, cc++, fx(`COUNTIFS(${c},${rN},"<>")`, st.total), '#,##0', { ...z, bold: true });
        cellB(r, cc++, fx(`COUNTIFS(${c},${rS},"Operasional")`, st.ops), DASH, z);
        cellB(r, cc++, fx(`COUNTIFS(${c},${rS},"Non Operasional")`, st.non), DASH, z);
        AGE_LABELS.forEach((g, i) => cellB(r, cc++, fx(`COUNTIFS(${c},${rKU},"${g}")`, st.age[i]), DASH, { ...z, color: i === 2 && st.age[2] ? RED : INK, bold: i === 2 }));
        cellB(r, cc++, fx(`COUNTIFS(${c},${rKU},"${AGE_UNSET}")`, st.ageUnset), DASH, z);
        cellB(r, cc++, fx(`IFERROR(AVERAGEIFS(${rU},${c}),0)`, st.avg), '0.0', z);
        cellB(r, cc++, fx(`IFERROR(_xlfn.MAXIFS(${rW},${c}),0)`, swls.length ? Math.max(...swls) : 0), '#,##0.0;-#,##0.0;"–"', z);
        cellB(r, cc++, sizes || '–', null, z);
    });
    const tC = fC + jenisList.length, endC = 1 + colsC.length;
    totalRow(tC, fC, 5, endC, { 12: [fx(`IFERROR(AVERAGE(${rU}),0)`, S.avg), '0.0'], 13: null, 14: null });

    // D. grafik (gambar)
    row = tC + 3;
    section(row, 'D. GRAFIK');
    const legendRight = { display: true, position: 'right', labels: { usePointStyle: true, font: { size: 12, weight: '600' }, color: '#334155' } };
    const title = text => ({ display: true, text, color: '#0f1f3d', font: { size: 15, weight: '700' }, padding: { bottom: 6 } });
    const stackedOpts = (t, horizontal) => ({
        indexAxis: horizontal ? 'y' : 'x',
        plugins: { title: title(t), legend: { position: 'bottom', labels: { usePointStyle: true, font: { size: 11 } } } },
        scales: { x: { stacked: true, grid: { display: !horizontal ? false : true, color: '#eef2f7' }, ticks: { precision: 0 } }, y: { stacked: true, beginAtZero: true, grid: { display: horizontal ? false : true, color: '#eef2f7' }, ticks: { precision: 0 } } },
        layout: { padding: horizontal ? { right: 44 } : { top: 24 } }
    });
    const donut = (labels, vals, colors, t) => ({ type: 'doughnut', data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderColor: '#fff', borderWidth: 3 }] }, plugins: [pieDataLabelsPlugin], options: { cutout: '48%', plugins: { title: title(t), legend: legendRight } } });
    const images = [
        chartToImage({ type: 'bar', data: { labels: TERMINALS, datasets: cats.map(c => ({ label: c, data: TERMINALS.map(t => data.filter(d => d.terminal === t && d.kategori4 === c).length), backgroundColor: XL_CAT_COLOR[c], borderRadius: 2 })) }, plugins: [barDataLabelsPlugin], options: stackedOpts('Jumlah Alat per Terminal & Kategori', false) }, 760, 400),
        chartToImage(donut(AGE_LABELS, S.age, ['#059669', '#2563eb', '#e11d48'], 'Komposisi Kelompok Usia'), 560, 400),
        chartToImage({ type: 'bar', data: { labels: cats, datasets: energies.map(e => ({ label: e, data: cats.map(c => data.filter(d => d.kategori4 === c && energiOf(d) === e).length), backgroundColor: XL_EN_COLOR[e], borderRadius: 2 })) }, plugins: [horizontalBarLabelsPlugin], options: stackedOpts('Sumber Energi per Kategori Alat', true) }, 760, 400),
        chartToImage(donut(energies, energies.map(e => data.filter(d => energiOf(d) === e).length), energies.map(e => XL_EN_COLOR[e]), 'Komposisi Sumber Energi'), 560, 400)
    ];
    const slots = [[1.1, row + 0.4, 640, 336], [8.6, row + 0.4, 470, 336], [1.1, row + 18.4, 640, 336], [8.6, row + 18.4, 470, 336]];
    images.forEach((b64, i) => {
        const id = wb.addImage({ base64: b64, extension: 'png' });
        const [c0, r0, w, h] = slots[i];
        sm.addImage(id, { tl: { col: c0, row: r0 }, ext: { width: w, height: h } });
    });
    const noteRow = row + 37;
    sm.mergeCells(`B${noteRow}:${LC}${noteRow}`);
    sm.getCell(`B${noteRow}`).value = `Catatan: kelompok "Di Atas 20 Tahun" mencakup alat berusia 16 tahun ke atas (${S.strict20} unit benar-benar > 20 th). Tabel A–C berisi rumus yang membaca sheet "Database Alat"; grafik adalah gambar saat ekspor.`;
    sm.getCell(`B${noteRow}`).font = font({ size: 8.5, italic: true, color: { argb: MUTED } });
    sm.getCell(`B${noteRow}`).alignment = { wrapText: true, vertical: 'top' };
    sm.getRow(noteRow).height = 28;

    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `SIMALAT_IPC_TPK_${stampFile}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
