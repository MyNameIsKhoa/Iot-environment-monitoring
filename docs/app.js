import {firebaseConfig} from './config.js';

const $ = id => document.getElementById(id);
const ROOT = 'devices/warehouse01';
const STATUS = {
  SAFE: ['AN TOÀN', 'Các cảm biến đang hoạt động bình thường.'],
  DANGER: ['NGUY HIỂM', 'Buzzer tại ESP8266 đang cảnh báo.'],
  ERROR: ['LỖI CẢM BIẾN', 'Kiểm tra DHT22 hoặc đường đo bụi.'],
  CALIBRATING: ['ĐANG HIỆU CHUẨN', 'Đang lấy mốc bụi sau khi khởi động.'],
  PARTIAL: ['THIẾU CẢM BIẾN', 'Đo bụi đang tắt trong firmware.'],
  OFFLINE: ['MẤT KẾT NỐI', 'ESP8266 chưa gửi dữ liệu mới.']
};
const DUST = {LOW: 'ÍT', MEDIUM: 'VỪA', HIGH: 'NHIỀU', CALIBRATING: 'ĐANG CHỜ', ERROR: 'LỖI', DISABLED: 'ĐÃ TẮT'};
const METRICS = {temperatureC: ['Nhiệt độ', '°C'], humidityPct: ['Độ ẩm', '%'], dustAdc: ['Tín hiệu bụi', 'ADC'], dustDeltaAdc: ['Bụi so với mốc', 'ΔADC'], smokeDoHigh: ['Tín hiệu khói DO', 'LOW/HIGH']};
const RANGE_LABELS = {'1': '1 giờ', '6': '6 giờ', '24': '1 ngày', '168': '1 tuần', '720': '1 tháng'};
let db, auth, sdk, latest = null, history = [], stats = [], recent = [];
let cursor = null, historyDone = false, busy = false, unsubs = [];
let generation = 0, pendingReset = false;

const fmtTime = ms => Number.isFinite(Number(ms)) && ms ? new Date(Number(ms)).toLocaleString('vi-VN') : '—';
const val = (n, digits = 1) => n != null && Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : '—';
export const formatAge = ms => {
  if (!Number.isFinite(ms)) return 'không rõ thời điểm';
  const age = Math.max(0, ms);
  if (age < 5000) return 'vừa cập nhật';
  if (age < 60000) return `${Math.floor(age / 1000)} giây trước`;
  if (age < 3600000) return `${Math.floor(age / 60000)} phút trước`;
  if (age < 86400000) return `${Math.floor(age / 3600000)} giờ trước`;
  return `${Math.floor(age / 86400000)} ngày trước`;
};
const status = s => STATUS[s] ? s : 'ERROR';
const rowOrder = (a, b) => Number(a.timestamp) - Number(b.timestamp) || a.key.localeCompare(b.key);
export function splitAtGaps(values) {
  if (!values.length) return [];
  const intervals = values.slice(1).map((point, i) => point.t - values[i].t).filter(ms => ms > 0 && ms < 300000).sort((a, b) => a - b);
  const usualInterval = intervals.length ? intervals[Math.floor((intervals.length - 1) / 2)] : 15000;
  const gapThreshold = Math.max(45000, usualInterval * 2.5);
  const segments = [[values[0]]];
  for (let i = 1; i < values.length; i++) {
    if (values[i].t - values[i - 1].t > gapThreshold) segments.push([]);
    segments.at(-1).push(values[i]);
  }
  return segments;
}
function yAxis(values, field) {
  if (field === 'smokeDoHigh') return {lower: 0, upper: 1, labels: ['HIGH', '', '', '', 'LOW']};
  const minimum = Math.min(...values), maximum = Math.max(...values);
  const isAdc = field.startsWith('dust');
  const defaultStep = isAdc ? 5 : field === 'humidityPct' ? 1 : 0.5;
  const spread = maximum - minimum;
  const rawStep = spread ? spread / 3 : defaultStep;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = Math.max(isAdc ? 1 : 0, ([1, 2, 5, 10].find(n => n * magnitude >= rawStep) || 10) * magnitude);
  const lower = Math.floor(minimum / step) * step - (spread ? 0 : 2 * step);
  const upper = lower + 4 * step;
  const decimals = isAdc ? 0 : Math.max(0, Math.min(2, -Math.floor(Math.log10(step))));
  const formatter = new Intl.NumberFormat('vi-VN', {minimumFractionDigits: decimals, maximumFractionDigits: decimals});
  return {lower, upper, labels: Array.from({length: 5}, (_, i) => `${formatter.format(lower + (4 - i) * step)} ${METRICS[field][1]}`)};
}
export const rowsFrom = snap => {
  const rows = [];
  // Firebase stops forEach when the callback returns true; Array.push returns a truthy length.
  snap.forEach(child => { rows.push({key: child.key, ...child.val()}); });
  return rows.sort(rowOrder);
};
const dayBounds = () => {
  const d = $('historyDate').value;
  if (!d) return [0, Date.now()];
  const [y, m, day] = d.split('-').map(Number);
  return [new Date(y, m - 1, day).getTime(), new Date(y, m - 1, day + 1).getTime() - 1];
};
function setConnection(label, offline = false) {
  $('connection').textContent = label;
  $('connection').classList.toggle('offline', offline);
}
export function renderOverview() {
  // Firmware uploads every 15 s; allow two missed uploads before OFFLINE.
  const ageMs = latest && Number(latest.timestamp) > 0 ? Date.now() - Number(latest.timestamp) : NaN;
  const online = Number.isFinite(ageMs) && ageMs < 45000;
  const s = online ? status(latest.status) : 'OFFLINE';
  $('statusValue').textContent = STATUS[s][0];
  const alarm = s === 'DANGER' ? `${latest.temperatureAlarm ? 'Nhiệt độ cao. ' : ''}${latest.humidityAlarmHigh ? 'Độ ẩm cao. ' : ''}${latest.humidityAlarmLow ? 'Độ ẩm thấp. ' : ''}${latest.dustAlarm ? 'Bụi tăng mạnh. ' : ''}${latest.smokeDetected ? 'Phát hiện khói. ' : ''}` : '';
  $('statusDetail').textContent = `${s} · ${alarm}${STATUS[s][1]}${latest && !online ? ' Số đo trên thẻ là dữ liệu cũ.' : ''}`;
  $('statusValue').parentElement.className = `status-card ${s === 'DANGER' ? 'danger' : s === 'SAFE' ? '' : s === 'OFFLINE' ? 'offline' : 'error'}`;
  $('metrics').classList.toggle('stale', !!latest && !online);
  $('nodeBadge').textContent = `ESP8266: ${online ? 'đang gửi' : 'offline'}`;
  $('gatewayBadge').textContent = online && Number.isFinite(Number(latest.wifiRssiDbm)) ? `Wi-Fi: ${latest.wifiRssiDbm} dBm` : 'Wi-Fi: chưa rõ';
  $('temperature').textContent = latest?.dhtOK ? val(latest.temperatureC) : '—';
  $('humidity').textContent = latest?.dhtOK ? val(latest.humidityPct) : '—';
  const humidity = online && latest?.dhtOK && latest.humidityPct != null
    ? Number(latest.humidityPct)
    : NaN;
  const humidityHigh = Number(latest?.humidityHighThresholdPct ?? 80);
  const humidityLow = Number(latest?.humidityLowThresholdPct ?? 40);
  const humidityWarning = Number.isFinite(humidity) && humidity >= humidityHigh
    ? `Độ ẩm cao: ${val(humidity)}% · chạm/vượt ngưỡng ${val(humidityHigh, 0)}%.`
    : Number.isFinite(humidity) && humidity <= humidityLow
      ? `Độ ẩm thấp: ${val(humidity)}% · chạm/thấp hơn ngưỡng ${val(humidityLow, 0)}%.`
      : '';
  $('humidityWarning').textContent = humidityWarning;
  $('humidityWarning').classList.toggle('hidden', !humidityWarning);
  $('humidityDetail').textContent = humidityWarning ? `CẢNH BÁO · Ngưỡng ${val(humidityLow, 0)}–${val(humidityHigh, 0)}%` : `Phần trăm (%) · ngưỡng ${val(humidityLow, 0)}–${val(humidityHigh, 0)}%`;
  $('humidityDetail').classList.toggle('alert', !!humidityWarning);
  $('dust').textContent = latest ? (DUST[latest.dustLevel] || '—') : '—';
  $('dustDetail').textContent = latest?.dustOK ? `ADC: ${val(latest.dustAdc, 0)} · ΔADC: ${val(latest.dustDeltaAdc, 0)}` : 'ADC: —';
  $('smoke').textContent = latest?.smokeDetected == null ? '—' : latest.smokeDetected ? 'DETECTED' : 'NOT DETECTED';
  $('smokeDetail').textContent = latest?.smokeDoHigh == null ? 'DO: —' : `DO: ${latest.smokeDoHigh ? 'HIGH' : 'LOW'}`;
  $('fan').textContent = latest?.fanOn == null ? '—' : latest.fanOn ? 'ON' : 'OFF';
  $('fanDetail').textContent = latest?.fanOn == null ? 'Trạng thái relay: —' : 'Trạng thái relay';
  $('updatedAt').textContent = latest ? `${online ? 'Cập nhật' : 'Dữ liệu cũ'}: ${formatAge(ageMs)} · ${fmtTime(latest.timestamp)}` : 'Chưa có dữ liệu';
  $('updatedAt').classList.toggle('stale', !!latest && !online);
}
function renderStats() {
  const field = $('metric').value, [title, unit] = METRICS[field];
  const since = Date.now() - Number($('range').value) * 3600000;
  const rowsInRange = stats.filter(r => r.timestamp >= since);
  const values = rowsInRange.filter(r => field === 'smokeDoHigh' ? r.smokeDoHigh != null : field.startsWith('dust') ? r.dustOK : r.dhtOK)
    .map(r => ({t: Number(r.timestamp), v: r[field] == null ? NaN : Number(r[field])}))
    .filter(x => Number.isFinite(x.v) && Number.isFinite(x.t));
  $('chartTitle').textContent = `${title} · ${unit}`;
  $('chartCount').textContent = `${values.length}/${rowsInRange.length} mẫu hợp lệ trong ${RANGE_LABELS[$('range').value] || 'khoảng đã chọn'} (tối đa ${Number($('range').value) >= 168 ? '5.000' : '1.500'} bản ghi gần nhất)`;
  $('statCount').textContent = String(values.length);
  const stateValue = v => v >= 0.5 ? 'HIGH' : 'LOW';
  $('statMin').textContent = values.length ? (field === 'smokeDoHigh' ? stateValue(Math.min(...values.map(x => x.v))) : `${val(Math.min(...values.map(x => x.v)))} ${unit}`) : '—';
  $('statMax').textContent = values.length ? (field === 'smokeDoHigh' ? stateValue(Math.max(...values.map(x => x.v))) : `${val(Math.max(...values.map(x => x.v)))} ${unit}`) : '—';
  $('statAvg').textContent = values.length ? (field === 'smokeDoHigh' ? `HIGH ${val(values.reduce((sum, x) => sum + x.v, 0) / values.length * 100, 0)}%` : `${val(values.reduce((sum, x) => sum + x.v, 0) / values.length)} ${unit}`) : '—';
  $('chartStart').textContent = values.length ? fmtTime(values[0].t) : '';
  $('chartEnd').textContent = values.length ? fmtTime(values.at(-1).t) : '';
  for (let i = 1; i <= 3; i++) $('chartTick' + i).textContent = values.length > 1 ? new Date(values[0].t + (values.at(-1).t - values[0].t) * i / 4).toLocaleTimeString('vi-VN', {hour: '2-digit', minute: '2-digit'}) : '';
  if (!values.length) { $('chart').innerHTML = '<div class="chart-empty">Chưa có mẫu hợp lệ trong khoảng này.</div>'; return; }
  const {lower: lo, upper: hi, labels} = yAxis(values.map(p => p.v), field);
  const first = values[0].t, span = Math.max(1, values.at(-1).t - first);
  const pointX = p => 2 + (p.t - first) / span * 996;
  const pointY = p => 240 - (p.v - lo) / (hi - lo) * 220;
  const lines = splitAtGaps(values).map(segment => segment.length > 1
    ? field === 'smokeDoHigh'
      ? `<path class="chart-step" d="${segment.map((p, i) => `${i ? `H ${pointX(p).toFixed(1)} V ${pointY(p).toFixed(1)}` : `M ${pointX(p).toFixed(1)} ${pointY(p).toFixed(1)}`}`).join(' ')}"/>`
      : `<polyline points="${segment.map(p => `${pointX(p).toFixed(1)},${pointY(p).toFixed(1)}`).join(' ')}"/>`
    : `<circle class="chart-single" cx="${pointX(segment[0]).toFixed(1)}" cy="${pointY(segment[0]).toFixed(1)}" r="5"/>`).join('');
  const grid = [20, 75, 130, 185, 240].map(y => `<line x1="0" y1="${y}" x2="1000" y2="${y}"/>`).join('');
  $('chart').innerHTML = `<div class="chart-plot"><div class="chart-y-axis" aria-hidden="true">${labels.map(label => `<span>${label}</span>`).join('')}</div><svg viewBox="0 0 1000 260" preserveAspectRatio="none" aria-hidden="true">${grid}${lines}<line class="chart-cursor" y1="20" y2="240" style="display:none"/><circle class="chart-point" r="5" style="display:none"/></svg><div class="chart-tooltip" hidden><strong></strong><small></small></div></div>`;
  $('chart').setAttribute('aria-label', `${title}: ${values.length} mẫu, từ ${labels.at(-1)} đến ${labels[0]}; thấp nhất ${val(Math.min(...values.map(x => x.v)))} ${unit}, cao nhất ${val(Math.max(...values.map(x => x.v)))} ${unit}`);
  const plot = $('chart').querySelector?.('.chart-plot'), svg = plot?.querySelector('svg');
  if (!svg) return;
  const tooltip = plot.querySelector('.chart-tooltip'), cursor = plot.querySelector('.chart-cursor'), dot = plot.querySelector('.chart-point');
  const hideTooltip = () => { tooltip.hidden = true; cursor.style.display = 'none'; dot.style.display = 'none'; };
  const showTooltip = event => {
    const rect = svg.getBoundingClientRect(), plotRect = plot.getBoundingClientRect();
    const time = first + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * span;
    let left = 0, right = values.length;
    while (left < right) { const mid = (left + right) >> 1; if (values[mid].t < time) left = mid + 1; else right = mid; }
    const point = values[Math.max(0, left > 0 && (left === values.length || time - values[left - 1].t <= values[left].t - time) ? left - 1 : left)];
    const x = pointX(point), y = pointY(point);
    cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.style.display = '';
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.style.display = '';
    tooltip.querySelector('strong').textContent = field === 'smokeDoHigh' ? stateValue(point.v) : `${val(point.v, field.startsWith('dust') ? 0 : 1)} ${unit}`;
    tooltip.querySelector('small').textContent = fmtTime(point.t);
    tooltip.style.left = `${Math.max(82, Math.min(plotRect.width - 82, rect.left - plotRect.left + x / 1000 * rect.width))}px`;
    tooltip.style.top = `${y / 260 * rect.height}px`;
    tooltip.classList.toggle('below', y < 80);
    tooltip.hidden = false;
  };
  svg.addEventListener('pointermove', showTooltip);
  svg.addEventListener('pointerdown', showTooltip);
  svg.addEventListener('pointerleave', hideTooltip);
  svg.addEventListener('pointercancel', hideTooltip);
}
function renderHistory() {
  const filter = $('historyStatus').value;
  const rows = history.filter(r => filter === 'ALL' || r.status === filter).sort((a, b) => -rowOrder(a, b));
  const body = $('historyRows'); body.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
    const dust = r.dustOK ? `${val(r.dustAdc, 0)} ADC · ${val(r.dustDeltaAdc, 0)} ΔADC` : '—';
    for (const value of [fmtTime(r.timestamp), r.dhtOK ? `${val(r.temperatureC)} °C` : '—', r.dhtOK ? `${val(r.humidityPct)} %` : '—', dust, r.smokeDetected == null ? '—' : r.smokeDetected ? 'DETECTED' : 'NOT DETECTED', r.fanOn == null ? '—' : r.fanOn ? 'ON' : 'OFF']) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    const td = document.createElement('td'), badge = document.createElement('span');
    badge.className = `badge ${status(r.status)}`; badge.textContent = STATUS[status(r.status)][0]; td.append(badge); tr.append(td); body.append(tr);
  }
  if (!rows.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 7; td.textContent = 'Chưa có bản ghi phù hợp trong các trang đã tải.'; tr.append(td); body.append(tr); }
  $('historyHint').textContent = `Đã tải ${history.length} bản ghi; lọc trạng thái và CSV áp dụng trên các trang đã tải.`;
  $('loadMore').disabled = historyDone || busy;
  $('loadMore').textContent = historyDone ? 'Đã hết dữ liệu' : busy ? 'Đang tải…' : 'Tải thêm 50 bản ghi';
}
function renderEvents() {
  const events = recent.filter((r, i) => i && (r.status !== recent[i - 1].status || r.temperatureAlarm !== recent[i - 1].temperatureAlarm || r.dustAlarm !== recent[i - 1].dustAlarm || r.smokeDetected !== recent[i - 1].smokeDetected || r.fanOn !== recent[i - 1].fanOn));
  const list = $('eventList'); list.replaceChildren();
  for (const e of events.reverse().slice(0, 20)) {
    const s = status(e.status), article = document.createElement('article');
    const mark = document.createElement('span'); mark.className = `event-mark ${s}`;
    const div = document.createElement('div'), strong = document.createElement('strong'), small = document.createElement('small');
    strong.textContent = s === 'DANGER' ? `Cảnh báo: ${e.temperatureAlarm ? 'nhiệt độ ' : ''}${e.dustAlarm ? 'bụi ' : ''}${e.smokeDetected ? 'khói ' : ''}` : STATUS[s][0];
    small.textContent = `${fmtTime(e.timestamp)} · Khói ${e.smokeDetected == null ? '—' : e.smokeDetected ? 'DETECTED' : 'NOT DETECTED'} · Quạt ${e.fanOn == null ? '—' : e.fanOn ? 'ON' : 'OFF'}`;
    div.append(strong, small); article.append(mark, div); list.append(article);
  }
  if (!events.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Chưa có lần đổi trạng thái trong 100 log gần nhất.'; list.append(p); }
}
function mergeRecentIntoViews() {
  const since = Date.now() - Number($('range').value) * 3600000;
  const byKey = new Map(stats.map(r => [r.key, r]));
  for (const row of recent) if (row.timestamp >= since) byKey.set(row.key, row);
  const chartLimit = Number($('range').value) >= 168 ? 5000 : 1500;
  stats = [...byKey.values()].filter(r => r.timestamp >= since).sort(rowOrder).slice(-chartLimit);
  renderStats();

  if (!history.length) return;
  const [start, end] = dayBounds();
  const newest = history.reduce((a, b) => rowOrder(a, b) > 0 ? a : b);
  const added = recent.filter(r => r.timestamp >= start && r.timestamp <= end && rowOrder(r, newest) > 0);
  if (added.length) { history.push(...added); renderHistory(); }
}
export function applyLiveLogs(rows) {
  recent = rows;
  renderEvents();
  mergeRecentIntoViews();
}
async function fetchLogs(start, end, endKey, size) {
  const q = sdk.query(sdk.ref(db, `${ROOT}/logs`), sdk.orderByChild('timestamp'), sdk.startAt(start), endKey ? sdk.endAt(end, endKey) : sdk.endAt(end), sdk.limitToLast(size));
  return rowsFrom(await sdk.get(q));
}
async function loadHistory(reset = false) {
  if (busy) { if (reset) pendingReset = true; return; }
  if (reset) { history = []; cursor = null; historyDone = false; }
  if (historyDone) { renderHistory(); return; }
  const requestGeneration = generation;
  busy = true; renderHistory();
  try {
    const [start, end] = dayBounds();
    const raw = await fetchLogs(start, cursor?.timestamp ?? end, cursor?.key, cursor ? 52 : 51);
    if (requestGeneration === generation) {
      const withoutCursor = cursor ? raw.filter(r => r.key !== cursor.key) : raw;
      const page = withoutCursor.slice(-50);
      history.unshift(...page); cursor = page[0] ? {timestamp: page[0].timestamp, key: page[0].key} : cursor;
      historyDone = withoutCursor.length <= 50;
    }
  } catch (e) { if (requestGeneration === generation) setConnection(`Lỗi lịch sử: ${e.code || e.message}`, true); }
  busy = false; renderHistory();
  mergeRecentIntoViews();
  if (pendingReset) { pendingReset = false; loadHistory(true); }
}
async function loadStats() {
  const requestGeneration = generation;
  const since = Date.now() - Number($('range').value) * 3600000;
  const limit = Number($('range').value) >= 168 ? 5000 : 1500;
  try { const rows = await fetchLogs(since, Date.now(), null, limit); if (requestGeneration === generation) { stats = rows.filter(r => r.timestamp >= since); mergeRecentIntoViews(); } }
  catch (e) { if (requestGeneration === generation) setConnection(`Lỗi thống kê: ${e.code || e.message}`, true); }
}
function exportCsv() {
  const filter = $('historyStatus').value;
  const rows = history.filter(r => filter === 'ALL' || r.status === filter).sort(rowOrder);
  const csv = [['timestampUtc','temperatureC','humidityPct','dustAdc','dustBaselineAdc','dustDeltaAdc','dustLevel','smokeDetected','smokeDoHigh','fanOn','status','temperatureAlarm','dustAlarm'],
    ...rows.map(r => [new Date(r.timestamp).toISOString(), r.dhtOK ? r.temperatureC : '', r.dhtOK ? r.humidityPct : '', r.dustOK ? r.dustAdc : '', r.dustBaselineAdc ?? '', r.dustDeltaAdc ?? '', r.dustLevel, r.smokeDetected ?? '', r.smokeDoHigh ?? '', r.fanOn ?? '', status(r.status), !!r.temperatureAlarm, !!r.dustAlarm])]
    .map(row => row.join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff', csv], {type: 'text/csv;charset=utf-8'}));
  const a = document.createElement('a'); a.href = url; a.download = 'warehouse01-logs.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function live() {
  if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('YOUR_') || firebaseConfig.appId.startsWith('PASTE_')) {
    setConnection('Cần cấu hình Firebase', true); $('authPanel').classList.remove('hidden');
    $('loginForm').classList.add('hidden'); $('loginError').textContent = 'Điền cấu hình appId trong docs/config.js (Firebase Console → Project settings → Your apps).'; return;
  }
  try {
    const [app, database, authentication] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js'),
      import('https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js')]);
    sdk = database; const instance = app.initializeApp(firebaseConfig);
    db = database.getDatabase(instance); auth = authentication.getAuth(instance);
    $('loginForm').addEventListener('submit', async e => {
      e.preventDefault(); $('loginError').textContent = '';
      try { await authentication.signInWithEmailAndPassword(auth, $('email').value, $('password').value); $('password').value = ''; }
      catch (error) { $('loginError').textContent = `Đăng nhập thất bại: ${error.code}`; }
    });
    $('logoutButton').addEventListener('click', () => authentication.signOut(auth));
    authentication.onAuthStateChanged(auth, user => {
      generation++;
      unsubs.forEach(stop => stop()); unsubs = [];
      latest = null; history = []; stats = []; recent = []; renderOverview(); renderStats(); renderHistory(); renderEvents();
      if (!user) {
        pendingReset = false;
        $('authPanel').classList.remove('hidden'); $('logoutButton').classList.add('hidden'); setConnection('Cần đăng nhập', true); return;
      }
      $('authPanel').classList.add('hidden'); $('logoutButton').classList.remove('hidden'); setConnection('Firebase realtime');
      unsubs.push(database.onValue(database.ref(db, `${ROOT}/latest`), snap => { latest = snap.val(); renderOverview(); }, e => setConnection(`Lỗi latest: ${e.code}`, true)));
      unsubs.push(database.onValue(database.query(database.ref(db, `${ROOT}/logs`), database.orderByChild('timestamp'), database.limitToLast(100)),
        snap => applyLiveLogs(rowsFrom(snap)), e => setConnection(`Lỗi logs: ${e.code}`, true)));
      loadHistory(true); loadStats();
    });
  } catch (e) { setConnection(`Không tải được Firebase: ${e.message}`, true); }
}
$('range').addEventListener('change', loadStats);
$('metric').addEventListener('change', renderStats);
$('historyDate').addEventListener('change', () => { generation++; loadHistory(true); });
$('historyStatus').addEventListener('change', renderHistory);
$('loadMore').addEventListener('click', () => loadHistory());
$('exportCsv').addEventListener('click', exportCsv);
const sectionLinks = [...document.querySelectorAll('.rail nav a')];
function updateActiveSection() {
  const marker = window.innerHeight * 0.35;
  const sections = sectionLinks
    .map(link => ({link, section: document.querySelector(link.hash)}))
    .filter(item => item.section);
  const current = sections.find(({section}) => {
    const rect = section.getBoundingClientRect();
    return rect.top <= marker && rect.bottom > marker;
  }) || sections.reduce((nearest, item) =>
    Math.abs(item.section.getBoundingClientRect().top - marker) <
      Math.abs(nearest.section.getBoundingClientRect().top - marker) ? item : nearest);
  sectionLinks.forEach(link => link.classList.toggle('active', link === current?.link));
}
sectionLinks.forEach(link => link.addEventListener('click', () => {
  sectionLinks.forEach(item => item.classList.toggle('active', item === link));
}));
window.addEventListener('scroll', updateActiveSection, {passive: true});
window.addEventListener('hashchange', updateActiveSection);
updateActiveSection();
setInterval(renderOverview, 5000);
live();
