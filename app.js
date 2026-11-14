const SUPABASE_URL = 'https://yacnpsjhofestqrgsfvf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhY25wc2pob2Zlc3RxcmdzZnZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2MzA5NzgsImV4cCI6MjExMDIwNjk3OH0.8pQdGTiL_KZYI_l2JYvt_7WfpceLpXIJn8rcU60yWsg';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
                        ctx.fillStyle = ds.label === 'Belum Diisi' ? '#1e293b' : '#ffffff';
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
        ? (validYears.reduce((sum, d) => sum + (2026 - d.tahun_pembuatan), 0) / validYears.length).toFixed(1)
        : 0;

    let oldestText = 'Tertua: -';
    if (validYears.length > 0) {
        const oldest = [...validYears].sort((a, b) => a.tahun_pembuatan - b.tahun_pembuatan)[0];
        oldestText = `Tertua: ${oldest.nomor_alat} · ${2026 - oldest.tahun_pembuatan} th (${oldest.terminal.toUpperCase()})`;
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

    const dermagaArr = TERMINALS.map(t => baseData.filter(d => d.terminal === t && d.kategori4 === 'Alat Utama Dermaga').length);
    const lapanganArr = TERMINALS.map(t => baseData.filter(d => d.terminal === t && d.kategori4 === 'Alat Utama Lapangan').length);
    const pendukungArr = TERMINALS.map(t => baseData.filter(d => d.terminal === t && d.kategori4 === 'Alat Pendukung').length);
    const angkutArr = TERMINALS.map(t => baseData.filter(d => d.terminal === t && d.kategori4 === 'Alat Angkut').length);

    const datasets = [
        { label: 'Alat Utama Dermaga', data: dermagaArr, backgroundColor: '#1e3a8a', borderRadius: 2 },
        { label: 'Alat Utama Lapangan', data: lapanganArr, backgroundColor: '#3b82f6', borderRadius: 2 }
    ];
    if (chartMode === 'semua') {
        datasets.push({ label: 'Alat Pendukung', data: pendukungArr, backgroundColor: '#94a3b8', borderRadius: 2 });
        datasets.push({ label: 'Alat Angkut', data: angkutArr, backgroundColor: '#0f766e', borderRadius: 2 });
    }

    const totalArmadaChart = datasets.reduce((sum, ds) => sum + ds.data.reduce((a, b) => a + b, 0), 0);
    document.getElementById('chartTotalFooter').innerText = `Total armada: ${totalArmadaChart} unit`;

    if (barChartInstance) barChartInstance.destroy();
    barChartInstance = new Chart(document.getElementById('terminalChart'), {
        type: 'bar',
        data: { labels: TERMINALS, datasets },
        plugins: [barDataLabelsPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 24 } },
            onClick: (e, elements) => {
                if (elements.length > 0) {
                    const idx = elements[0].index;
                    selectBranch(selectedBranch === TERMINALS[idx] ? 'Semua' : TERMINALS[idx]);
                }
            },
            plugins: { legend: { position: 'top', labels: { boxWidth: 10, font: { size: 11 } } } },
            scales: {
                x: { stacked: true, grid: { display: false } },
                y: { stacked: true, beginAtZero: true, grid: { color: '#f1f5f9' } }
            }
        }
    });

    let u1_10 = 0, u10_15 = 0, u20plus = 0, trulyAbove20 = 0;
    validYears.forEach(d => {
        const age = 2026 - d.tahun_pembuatan;
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
            const age = 2026 - item.tahun_pembuatan;
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
        const age = item.tahun_pembuatan ? (2026 - item.tahun_pembuatan) : null;
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
            actionHtml += `<button onclick='openEditModal(${JSON.stringify(item)})' class="text-blue-600 hover:text-blue-800 mr-2 cursor-pointer" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>`;
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
    document.getElementById('modalTitle').innerText = 'Edit Data Alat';
    document.getElementById('modalForm').classList.remove('hidden');
    document.getElementById('modalForm').classList.add('flex');
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
    const baseData = getActiveDataset();
    const headers = ['Terminal', 'Kategori', 'Jenis', 'Nomor Alat', 'Brand', 'Tahun Pembuatan', 'Sumber Energi', 'Status'];
    const rows = baseData.map(d => [d.terminal, d.kategori4, d.jenis, d.nomor_alat, d.brand, d.tahun_pembuatan || '', d.sumber_energi || '', d.status]);
    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Database_SIMALAT_IPCTPK_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
}

window.onload = checkSession;
