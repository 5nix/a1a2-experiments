const $ = s => document.querySelector(s);
function node(tag, text, className) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; }
function svgNode(tag, attrs = {}) { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; }
async function api(path, value) { const r = await fetch('/api/admin/' + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) }); const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; }
let shuttingDown = false;
$('#shutdown-system').addEventListener('click', async e => {
  if (!confirm('关闭实验服务和本系统启动的 scrcpy？运行中的任务会中断，已有数据保留。')) return;
  e.currentTarget.disabled = true;
  try { await api('shutdown', {}); shuttingDown = true; document.title = 'A1 已关闭'; document.body.replaceChildren(node('main', '实验系统已关闭。下次双击“开启实验.command”重新启动。')); }
  catch (error) { e.currentTarget.disabled = false; feedback(error.message); }
});
let selected = null, entries = [], listSignature = '', detailSignature = '', noticeTimer, creating = false;
let deviceState = null, deviceBusy = false, imageDraft = null, deviceMaterials = [], checkVisible = false;
const requestId = () => crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

/* ---------- 顶栏：标签、设备状态、二维码 ---------- */
function showTab(view) {
  checkVisible = view === 'check'; $('#session-panel').hidden = checkVisible; $('#check-panel').hidden = !checkVisible;
  $('#tab-sessions').setAttribute('aria-pressed', String(!checkVisible)); $('#tab-check').setAttribute('aria-pressed', String(checkVisible));
  if (checkVisible) loadDevice().catch(e => feedback(e.message));
}
for (const view of ['sessions', 'check']) $('#tab-' + view).addEventListener('click', () => showTab(view));
$('#device-pill').addEventListener('click', () => showTab('check'));
function toggleQr(open = $('#qr-pop').hidden) { $('#qr-pop').hidden = !open; $('#qr-toggle').setAttribute('aria-expanded', String(open)); }
$('#qr-toggle').addEventListener('click', e => { e.stopPropagation(); toggleQr(); });
document.addEventListener('click', e => { if (!$('#qr-pop').hidden && !e.target.closest('#qr-pop')) toggleQr(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { toggleQr(false); document.querySelectorAll('details.more[open]').forEach(d => d.open = false); } });
document.addEventListener('click', e => { for (const d of document.querySelectorAll('details.more[open]')) if (!d.contains(e.target)) d.open = false; });

/* ---------- 设备 ---------- */
function step(id, state, text) { $('#' + id).className = state; $('#' + id + '-s').textContent = text; }
function renderDevice() {
  const d = deviceState; if (!d) return; const a = d.adapter, busy = deviceBusy || d.working;
  const level = d.image_ready ? 'ok' : a.connected ? 'warn' : '';
  $('#device-dot').className = 'dot ' + (a.busy ? 'live' : level);
  $('#device-badge').textContent = d.image_ready ? '眼镜就绪' : a.connected ? '显示端未就绪' : '仅 Mock';
  $('#device-status').textContent = `设备：${d.serial || '尚未选择'} · ${a.connected ? 'USB通道已连接' : 'USB通道未连接'} · ${a.ready ? '显示端就绪' : '显示端未就绪'} · ${a.image_protocol ? '支持图片协议' : '尚未确认图片能力'}${a.busy ? ' · 正在显示' : ''}`;
  const chain = [Boolean(d.serial), Boolean(a.connected), Boolean(a.ready), Boolean(a.image_protocol)];
  const firstOpen = chain.indexOf(false);
  const cls = i => chain[i] ? 'ok' : i === firstOpen ? 'now' : '';
  step('step-select', cls(0), d.serial || '未选择');
  step('step-usb', cls(1), a.connected ? '已连接' : '未连接');
  step('step-display', cls(2), a.ready ? (a.busy ? '就绪 · 正在显示' : '就绪') : '未就绪');
  step('step-image', cls(3), a.image_protocol ? '已确认' : '待确认');
  const diagnostic = d.error || a.error || '';
  $('#device-diagnostic').textContent = { device_serial_missing: '尚未选择眼镜，请扫描并连接已授权的ADB设备。', device_not_probed: '设备尚未探测，请刷新连接状态。', device_disconnected: 'USB显示通道已断开，请检查连接并重试。' }[diagnostic] ?? diagnostic;
  $('#host-state').textContent = `上位机守护 ${d.enabled ? a.connected ? '开启' : '已设置（待设备）' : '关闭'} · 语音悬浮窗 ${{ protected: '已限制', restored: '已恢复', pending: '待核对', error: '失败' }[d.voice_guard.state]} · scrcpy ${d.scrcpy.running ? '运行中' : '未启动'}`;
  $('#host-toggle').textContent = d.enabled ? '关闭上位机守护' : '开启上位机守护';
  $('#send-image').disabled = busy || !d.manual_allowed;
  for (const b of document.querySelectorAll('[data-device-action],#host-toggle,#bind-device,#scan-devices')) b.disabled = busy;
  const signature = JSON.stringify(d.records.map(r => [r.request_id, r.status, r.error, r.events.length]));
  if ($('#device-records').dataset.signature !== signature) {
    $('#device-records').dataset.signature = signature;
    $('#device-records').replaceChildren(...(d.records.length ? d.records.slice(0, 15).map(r => {
      const box = node('div', null, 'device-record');
      const drawn = r.events.find(e => e.kind === 'drawn'), hidden = r.events.find(e => e.kind === 'hidden');
      const ms = drawn && hidden && drawn.clock_id === hidden.clock_id ? hidden.device_monotonic_ms - drawn.device_monotonic_ms : null;
      box.append(node('strong', `${r.kind === 'manual' ? '试发' : '实验'} · ${r.material_id} · ${{ sending: '发送中', accepted: '已接受，等待绘制证据', drawn: '双眼已绘制', hidden: '双眼已绘制并清屏', failed: '失败', unknown: '结果待核查', unacknowledged: '未收到接受回执' }[r.status] ?? r.status}`), node('p', `${r.events.map(e => e.kind).join(' → ') || '尚无设备绘制事件'}${ms == null ? '' : ` · ${ms} ms`}`));
      if (r.error) box.append(node('p', r.error)); return box;
    }) : [node('p', '—', 'muted')]));
  }
  $('#device-audit').textContent = d.audit.map(e => `${e.timestamp} ${e.action}\n${JSON.stringify(e.detail)}`).join('\n');
}
async function loadDevice() { deviceState = await api('device'); renderDevice(); }
async function deviceAction(path, payload) {
  deviceBusy = true; renderDevice();
  try { const result = await api(path, payload); await loadDevice(); return result; }
  finally { deviceBusy = false; renderDevice(); }
}
$('#scan-devices').addEventListener('click', async () => { try { const list = await api('device/list'); $('#device-serial').replaceChildren(new Option(list.devices.length ? '请选择设备' : '未发现ADB设备', ''), ...list.devices.map(d => new Option(`${d.serial} · ${d.state}${d.state === 'unauthorized' ? '（请在眼镜上授权USB调试）' : ''}`, d.serial))); } catch (e) { feedback(e.message); } });
$('#bind-device').addEventListener('click', async () => { try { await deviceAction('device/config', { serial: $('#device-serial').value }); feedback('已保存设备选择，请唤醒并打开A1图片显示端。'); } catch (e) { feedback(e.message); } });
for (const b of document.querySelectorAll('[data-device-action]')) b.addEventListener('click', async () => { try { await deviceAction('device/control', { action: b.dataset.deviceAction }); feedback('操作完成，请核对设备状态。'); } catch (e) { feedback(e.message); } });
$('#host-toggle').addEventListener('click', async () => { try { await deviceAction('device/control', { action: 'host', enabled: !deviceState.enabled }); } catch (e) { feedback(e.message); } });
$('#image-material').addEventListener('change', () => { imageDraft = null; const m = deviceMaterials.find(m => m.id === $('#image-material').value); if (m) { $('#image-preview').src = '/api/admin/device/images/' + encodeURIComponent(m.render_image); $('#image-preview').alt = m.text_lines.join(' '); } });
$('#image-notify').addEventListener('submit', async e => {
  e.preventDefault(); const material = $('#image-material').value, duration = Number($('#image-duration').value);
  if (!imageDraft || imageDraft.material_id !== material || imageDraft.duration_ms !== duration) imageDraft = { request_id: requestId(), material_id: material, duration_ms: duration };
  try { const record = await deviceAction('device/notify', imageDraft); imageDraft = null; feedback(record.status === 'accepted' ? '已接受，请等待双眼 drawn 与 hidden 证据。' : `当前结果：${record.status}，请查看显示证据。`); } catch (e) { feedback(e.message); }
});
function feedback(message) { if (!$('#feedback')) return; $('#feedback').textContent = message; $('#feedback').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('#feedback').hidden = true; }, 8000); }
const phaseNames = { READY: '待开始', RUNNING: '进行中', RECALL: '复述', PROBE: '问卷', EFFORT_GENERAL: '问卷', EFFORT_RECOVERY: '问卷', BREAK: '休息', COMPLETED: '已完成', ABORTED: '已结束' };
const windows = { pre: 'Pre', during: 'During', post: 'Post', post_early: 'Post 早期', post_late: 'Post 后期', boundary: '边界', unknown: '未知', practice: '练习' };

/* ---------- 网络与二维码 ---------- */
async function network() {
  const info = await api('network'); const options = info.addresses.length ? info.addresses : [{ base_url: info.local_url, name: '本机', address: '127.0.0.1' }];
  $('#address').replaceChildren(...options.map(o => new Option(`${o.address} · ${o.name}`, o.base_url)));
  const saved = sessionStorage.getItem('a1-share-origin'); if (options.some(o => o.base_url === saved)) $('#address').value = saved;
  updateAddress();
}
function updateAddress() { const url = $('#address').value + '/admin'; $('#admin-url').value = url; $('#qr').src = '/api/admin/qr?text=' + encodeURIComponent(url); sessionStorage.setItem('a1-share-origin', $('#address').value); }
$('#address').addEventListener('change', updateAddress);
$('#copy-address').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#admin-url').value); feedback('主试地址已复制。'); } catch { $('#admin-url').select(); feedback('地址已选中，请复制。'); } });

/* ---------- 新建会话 ---------- */
function setCreating(open) {
  creating = open; $('#create-panel').hidden = !open; $('#new-session').setAttribute('aria-pressed', String(open));
  if (open) { $('#empty').hidden = true; $('#selected').hidden = true; drawCreateVisuals(); $('#create [name=participant_id]').focus(); }
  else if (!selected) $('#empty').hidden = false;
  listSignature = ''; detailSignature = '';
}
$('#new-session').addEventListener('click', () => { if (creating) { setCreating(false); refresh().catch(e => feedback(e.message)); return; } selected = null; setCreating(true); refresh().catch(e => feedback(e.message)); });
function creationInput() {
  const input = Object.fromEntries(new FormData($('#create')));
  input.timing = {};
  for (const name of ['notification_ms', 'pre_ms', 'post_ms', 'post_early_ms']) { input.timing[name] = Number(input[name]); delete input[name]; }
  input.primary_modality = 'compensatory_tracking';
  input.tracking = {};
  for (const name of ['disturbance_rms', 'disturbance_hz', 'input_gain', 'target_radius', 'cursor_radius', 'display_scale']) { input.tracking[name] = Number(input[name]); delete input[name]; }
  input.debug = $('#create [name=debug]').checked;
  if (input.timing.post_early_ms > input.timing.post_ms) throw new Error('恢复早窗不能超过 Post 长度。');
  return input;
}
// 参数即图：时序条按比例，靶区按画布 1:1 比例（半宽 = 100）。
function drawCreateVisuals() {
  const f = $('#create'), v = name => Math.max(0, Number(f.elements[name].value) || 0);
  const [pre, note, post, early] = [v('pre_ms'), v('notification_ms'), v('post_ms'), Math.min(v('post_early_ms'), v('post_ms'))];
  const bar = $('#timebar').children; bar[0].style.flexGrow = pre; bar[1].style.flexGrow = note; bar[2].style.flexGrow = early; bar[3].style.flexGrow = post - early;
  bar[0].textContent = `PRE ${pre / 1000}s`; bar[1].textContent = `${note / 1000}s`; bar[2].textContent = early ? `早窗 ${early / 1000}s` : ''; bar[3].textContent = `POST ${post / 1000}s`;
  $('#scope-ring').setAttribute('r', Math.min(99, v('target_radius') * 100));
  $('#scope-cursor').setAttribute('r', Math.min(30, v('cursor_radius') * 100));
  $('#scope-rms').setAttribute('r', Math.min(99, v('disturbance_rms') * 100));
  $('#scope-caption').textContent = `圈 ${v('target_radius')}　点 ${v('cursor_radius')}　虚线 RMS ${v('disturbance_rms')}　显示 ×${v('display_scale')}`;
}
$('#create').addEventListener('input', () => { drawCreateVisuals(); if (!$('#plan-preview').hidden) $('#preview-meta').textContent = '参数已修改，请重新预览。'; });
$('#preview-plan').addEventListener('click', async e => {
  if (!$('#create').reportValidity()) return;
  e.currentTarget.disabled = true;
  try { const result = await api('preview', creationInput()); $('#plan-preview').hidden = false; renderPlan($('#preview-content'), result.plan, result.material_precheck); $('#preview-meta').textContent = ''; }
  catch (error) { feedback(error.message); } finally { e.target.disabled = false; }
});
$('#create').addEventListener('submit', async e => {
  e.preventDefault(); const button = e.submitter; button.disabled = true;
  try { const input = creationInput(); const created = await api('sessions', input); selected = created.session_id; setCreating(false); await refresh(); feedback('已创建。点“打开被试页面”。'); }
  catch (error) { feedback(error.message); } finally { button.disabled = false; }
});

/* ---------- 会话列表与详情 ---------- */
async function refresh() {
  const data = await api('sessions'); entries = data.sessions;
  const deleted = data.deleted_sessions ?? [];
  $('#deleted-section').hidden = !deleted.length;
  const deletedSignature = JSON.stringify(deleted);
  if ($('#deleted-sessions').dataset.signature !== deletedSignature) {
    $('#deleted-sessions').dataset.signature = deletedSignature;
    $('#deleted-sessions').replaceChildren(...deleted.map(s => {
      const row = node('div'), restore = node('button', '恢复', 'ghost');
      row.append(node('span', s.participant_id), restore);
      restore.addEventListener('click', async () => { restore.disabled = true; try { await api(`sessions/${s.id}/restore`, {}); await refresh(); } catch (error) { restore.disabled = false; feedback(error.message); } });
      return row;
    }));
  }
  if (selected && !entries.some(s => s.id === selected)) selected = null;
  const signature = JSON.stringify(entries.map(s => [s.id, s.phase, s.index, s.participant_id, selected]));
  if (signature !== listSignature) {
    listSignature = signature;
    $('#sessions').replaceChildren(...entries.map(s => {
      const ended = ['COMPLETED', 'ABORTED'].includes(s.phase), done = ended ? s.total_blocks : s.index;
      const b = node('button', null, 'item'); b.setAttribute('aria-pressed', String(s.id === selected));
      const ph = node('span', s.phase === 'RUNNING' ? '● 进行中' : `${phaseNames[s.phase] ?? s.phase} · ${Math.min(s.index + 1, s.total_blocks)}/${s.total_blocks}`, 'ph' + (s.phase === 'RUNNING' ? ' live' : ''));
      const mini = node('span', null, 'bar-mini'), fill = node('i'); fill.style.width = `${s.total_blocks ? done / s.total_blocks * 100 : 0}%`; mini.append(fill);
      const name = node('b', s.participant_id); if (s.debug) name.append(node('small', ' DEBUG', 'dbg'));
      b.append(name, ph, mini);
      b.addEventListener('click', () => { selected = s.id; setCreating(false); refresh().catch(error => feedback(error.message)); });
      return b;
    }));
  }
  if (creating) return;
  if (!selected) { $('#selected').hidden = true; $('#empty').hidden = false; return; }
  const detail = await api('sessions/' + selected), entry = entries.find(s => s.id === selected);
  $('#empty').hidden = true; $('#selected').hidden = false;
  const tracking = detail.plan?.primary_modality === 'compensatory_tracking';
  $('#title').textContent = detail.participant_id;
  const chips = [[phaseNames[detail.phase] ?? detail.phase, detail.phase === 'RUNNING' ? 'chip alert' : 'chip strong'],
    [{ quick: '快速预演', sop: tracking ? '正式 9＋1' : '正式 10＋2', pool: '全部材料' }[detail.preset] ?? detail.preset, 'chip'],
    [detail.mode === 'rayneo' ? '雷鸟眼镜' : '电脑模拟', 'chip'],
    [detail.plan?.pilot_round === 'round2' ? '第二轮' : '第一轮', 'chip'],
    [`seed ${detail.plan?.seed ?? '—'}`, 'chip'],
    ...(detail.debug ? [['调试被试 · 可选关卡', 'chip alert']] : []),
    ...(detail.material_outdated ? [['旧材料 · 请结束后新建', 'chip alert']] : detail.synthetic ? [['合成材料', 'chip alert']] : [])];
  $('#state').replaceChildren(...chips.map(([t, c]) => node('span', t, c)));
  $('#open').href = entry.participant_url; $('#export').href = '/api/admin/export?session_id=' + selected;
  $('#delete-session').disabled = !['COMPLETED', 'ABORTED'].includes(detail.phase);
  $('#interrupt').hidden = detail.phase !== 'RUNNING'; $('#interrupt').disabled = detail.phase !== 'RUNNING';
  $('#stop').disabled = ['COMPLETED', 'ABORTED'].includes(detail.phase);
  $('#nback-results').hidden = tracking; $('#tracking-results').hidden = !tracking;
  const sig = JSON.stringify([selected, detail.phase, detail.index, (detail.attempts ?? []).map(a => a.status), (detail.tracking_summary ?? []).length, (detail.tracking_recovery ?? []).length, (detail.summaries ?? []).length]);
  if (sig !== detailSignature) {
    detailSignature = sig;
    renderTimeline(detail);
    if (tracking) { renderTracking(detail); renderTrialGrid(detail); }
    renderPlan($('#session-plan'), detail.plan, detail.material_precheck);
    renderPooled(detail.pooled_summaries ?? []);
    const rows = (detail.summaries ?? []).filter(r => r.eligible > 0);
    $('#summary').replaceChildren(...rows.map(r => {
      const pre = rows.find(x => x.attempt_id === r.attempt_id && x.window === 'pre');
      const diff = pre && ['during', 'post'].includes(r.window) ? (r.accuracy - pre.accuracy) * 100 : null;
      const tr = node('tr'); const values = [r.block_id, windows[r.window], r.eligible, percent(r.accuracy), r.hit_rt_mean_ms == null ? '—' : `${Math.round(r.hit_rt_mean_ms)} ms`, diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff.toFixed(1)} pp`];
      tr.append(...values.map(v => node('td', v))); return tr;
    }));
  }
  const timed = [...new Map((detail.summaries ?? []).filter(r => r.block_type === 'notification' && r.timing_qc).map(r => [r.attempt_id, r])).values()];
  const verified = timed.filter(r => r.timing_verified).length;
  $('#timing-qc').textContent = timed.length && verified < timed.length ? `真机时钟校准 ${verified}/${timed.length} · 未验证尝试不输出 During` : '';
  $('#events').textContent = detail.recent_events.map(e => `${e.type} ${e.at ?? ''}\n${JSON.stringify(e.data)}`).join('\n');
}

// 时间线：一段一格；上沿颜色 = 已完成 / 当前 / 未开始；右上角数字 = 被中断的尝试次数。
function renderTimeline(detail) {
  const plan = detail.plan; if (!plan) { $('#timeline').replaceChildren(); return; }
  const ended = ['COMPLETED', 'ABORTED'].includes(detail.phase);
  const invalid = new Map(); for (const a of detail.attempts ?? []) if (a.status === 'invalid') invalid.set(a.block_index, (invalid.get(a.block_index) ?? 0) + 1);
  let formal = 0;
  $('#timeline').replaceChildren(...plan.blocks.map((b, i) => {
    const m = plan.materials.find(m => m.id === b.material_id), n = m?.n_count ?? m?.iu_count;
    const li = node('li', null, b.kind + (i < detail.index || (ended && detail.phase === 'COMPLETED') ? ' done' : i === detail.index && !ended ? ' current' : ''));
    if (b.kind !== 'practice') formal++;
    li.append(node('b', b.kind === 'practice' ? '练习' : b.kind === 'control' ? `${String(formal).padStart(2, '0')} 对照` : `${String(formal).padStart(2, '0')} N${n ?? '?'}`), node('span', b.material_id ?? (b.kind === 'control' ? '无通知' : '—')));
    li.title = `${{ practice: '练习', notification: '通知', control: '对照' }[b.kind]} · ${b.material_id ?? ''} · ${m?.domain ?? ''}`;
    if (invalid.get(i)) { const sup = node('sup', `↻${invalid.get(i)}`); sup.title = `${invalid.get(i)} 次中断的尝试`; li.append(sup); }
    return li;
  }));
}

// 小图：横轴 = Pre | During | 恢复 0–15 s；纵轴 = RMSE；虚线 = 本 Trial Pre 基线。
function renderTrialGrid(detail) {
  const summary = detail.tracking_summary ?? [], recovery = detail.tracking_recovery ?? [];
  const blocks = (detail.plan?.blocks ?? []).filter(b => b.kind !== 'practice');
  const cards = [];
  let formal = 0;
  for (const b of detail.plan?.blocks ?? []) {
    if (b.kind === 'practice') continue; formal++;
    const rows = summary.filter(r => r.block_id === b.id); if (!rows.length) continue;
    const attempt = rows.at(-1).attempt_id, mine = rows.filter(r => r.attempt_id === attempt);
    const get = w => mine.find(r => r.window === w);
    const pre = get('pre'), during = get('during'), post = get('post');
    const rec = recovery.filter(r => r.attempt_id === attempt).sort((x, y) => x.relative_start_ms - y.relative_start_ms);
    const card = node('article', null, 'trial' + (pre?.valid ? '' : ' invalid'));
    const n = rows[0].n_count;
    const head = node('header');
    head.append(node('b', `${String(formal).padStart(2, '0')} · ${b.kind === 'control' ? '对照' : `N${n ?? '?'}`}`), node('span', b.material_id ?? '无通知'));
    card.append(head, sparkline(pre?.rmse, during?.rmse, rec.map(r => r.rmse)));
    const grid = node('dl'); for (const [k, v] of [['PRE', pre], ['DURING', during], ['POST', post]]) { const cell = node('div'); cell.append(node('dt', k), node('dd', decimal(v?.rmse))); grid.append(cell); }
    card.append(grid);
    const foot = node('footer'); const r0 = rows[0];
    if (r0.comprehension_correct != null) foot.append(node('span', r0.comprehension_correct ? '理解 ✓' : '理解 ✗', r0.comprehension_correct ? 'chip' : 'chip alert'));
    if (r0.effort_general != null) foot.append(node('span', `努力 ${r0.effort_general}${r0.effort_recovery != null ? ` / ${r0.effort_recovery}` : ''}`, 'chip'));
    if (!pre?.valid) foot.append(node('span', (pre?.qc_flags ?? []).join('、') || '无有效数据', 'chip alert'));
    if (foot.children.length) card.append(foot);
    cards.push(card);
  }
  $('#trial-grid').replaceChildren(...(cards.length ? cards : [node('p', blocks.length ? '尚无完成的 Trial' : '—', 'muted')]));
}
function sparkline(pre, during, bins) {
  const W = 200, H = 72, pad = 4, slots = 2 + Math.max(bins.length, 1);
  const values = [pre, during, ...bins].filter(v => Number.isFinite(v));
  const svg = svgNode('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'RMSE 走势' });
  if (!values.length) return svg;
  const max = Math.max(...values) * 1.1 || 1, x = i => pad + i * (W - 2 * pad) / (slots - 1), y = v => H - pad - v / max * (H - 2 * pad);
  svg.append(svgNode('rect', { class: 'band', x: x(.5), y: 0, width: x(1.5) - x(.5), height: H }));
  if (Number.isFinite(pre)) svg.append(svgNode('line', { class: 'base', x1: 0, x2: W, y1: y(pre), y2: y(pre) }));
  const pts = bins.map((v, i) => Number.isFinite(v) ? `${x(i + 2).toFixed(1)},${y(v).toFixed(1)}` : null).filter(Boolean);
  if (pts.length) svg.append(svgNode('polyline', { class: 'curve', points: pts.join(' ') }));
  if (Number.isFinite(during)) svg.append(svgNode('circle', { class: 'during', cx: x(1), cy: y(during), r: 3 }));
  return svg;
}

for (const action of ['stop', 'interrupt']) $('#' + action).addEventListener('click', async () => { if (!selected || !confirm(action === 'stop' ? '结束此会话并保留已采集数据？' : '中断本段并保留无效尝试？重新开始会再次使用本段材料。')) return; try { await api(`sessions/${selected}/${action}`, { reason: '主试后台操作' }); await refresh(); } catch (error) { feedback(error.message); } });
$('#delete-session').addEventListener('click', async e => {
  const id = selected, entry = entries.find(s => s.id === id);
  if (!entry || !confirm(`删除被试 ${entry.participant_id} 的这条会话？将从列表和导出中移除，可在“已删除”恢复。`)) return;
  const button = e.currentTarget; button.disabled = true;
  try { await api(`sessions/${id}/delete`, {}); if (selected === id) selected = null; await refresh(); feedback('会话已删除。'); }
  catch (error) { button.disabled = false; feedback(error.message); }
});
$('#note').addEventListener('submit', async e => { e.preventDefault(); try { await api(`sessions/${selected}/notes`, { reason: $('#note-text').value }); $('#note-text').value = ''; feedback('备注已保存。'); } catch (error) { feedback(error.message); } });
function percent(value) { return value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`; }
function table(headers, rows) {
  const wrap = node('div', null, 'table-scroll'); const t = node('table'), head = node('thead'), h = node('tr'), body = node('tbody');
  h.append(...headers.map(v => node('th', v))); head.append(h);
  for (const values of rows) { const row = node('tr'); row.append(...values.map(v => node('td', v ?? '—'))); body.append(row); }
  t.append(head, body); wrap.append(t); return wrap;
}
function renderPlan(container, plan, precheck) {
  if (!plan) { container.replaceChildren(node('p', '该旧会话未提供计划预览。')); return; }
  const formal = plan.blocks.filter(b => b.kind !== 'practice'), counts = [1, 2, 3].map(n => formal.filter(b => b.kind === 'notification' && (plan.materials.find(m => m.id === b.material_id)?.n_count ?? plan.materials.find(m => m.id === b.material_id)?.iu_count) === n).length);
  container.replaceChildren(node('p', `${formal.length} 个正式 Trial：${formal.filter(b => b.kind === 'notification').length} 通知＋${formal.filter(b => b.kind === 'control').length} 对照 · N1/N2/N3 = ${counts.join('/')} · seed ${plan.seed}`));
  if (plan.allocation) container.append(node('p', `配额轮换 ${plan.allocation.index} · 对照位置 ${plan.allocation.control_positions.join('、')}（正式 Trial，从 1 起）`));
  const tracking = plan.primary_modality === 'compensatory_tracking';
  if (tracking) {
    const t = plan.tracking ?? {};
    container.append(node('p', `Pre ${plan.timing.pre_ms} · 通知 ${plan.timing.notification_ms} · Post ${plan.timing.post_ms} ms · 扰动 RMS ${t.disturbance_rms} / ${t.disturbance_hz} Hz · 增益 ${t.input_gain} · 目标半径 ${t.target_radius} · 圆点半径 ${t.cursor_radius ?? '0.025（旧默认）'} · 显示 ×${t.display_scale ?? 1}`));
    container.append(table(['顺序', '类型', '材料 ID', 'N', '业务类别', '时长（ms）', '扰动 seed'], plan.blocks.map((b, i) => { const m = plan.materials.find(m => m.id === b.material_id); return [b.kind === 'practice' ? '练习' : i, { practice: '练习', notification: '通知', control: '对照' }[b.kind], b.material_id ?? '—', m?.n_count ?? m?.iu_count ?? '—', m?.domain ?? '—', b.duration_ms, b.tracking_seed]; })));
    const materials = node('details', null, 'material-review'); materials.append(node('summary', '材料与理解题')); renderMaterialCheck(materials, plan, precheck); container.append(materials);
    return;
  }
  container.append(node('p', plan.primary_modality === 'auditory_digits' ? '主任务：听觉数字1—9 · 声音由被试电脑播放 · 通知期间连续运行' : '主任务：旧版视觉字母，保留原会话设置'));
  if (plan.configuration_status) container.append(node('p', 'Pilot参数尚未冻结；本会话按上列配置保存，修改参数需新建会话。', 'plan-warning'));
  if (plan.timing) container.append(node('p', `通知 ${plan.timing.notification_ms} ms · SOA ${plan.timing.soa_ms} ms · 刺激 ${plan.timing.stimulus_ms} ms · Pre/Post ${plan.timing.pre_ms}/${plan.timing.post_ms} ms · 恢复早窗 ${plan.timing.post_early_ms} ms`));
  container.append(table(['顺序', '类型', '材料 ID', 'N', '业务类别', '目标位置（0起）'], plan.blocks.map((b, i) => { const m = plan.materials.find(m => m.id === b.material_id); return [b.kind === 'practice' ? '练习' : i, { practice: '练习', notification: '通知', control: '对照' }[b.kind], b.material_id ?? '—', m?.n_count ?? m?.iu_count ?? '—', m?.domain ?? '—', b.letters.map((l, j) => j >= 2 && l === b.letters[j - 2] ? j : null).filter(v => v != null).join(', ')]; })));
  const balance = node('div', null, 'plan-section'); balance.append(node('h3', '序列平衡检查'));
  renderBalance(balance, plan.sequence_check); container.append(balance);
  const materials = node('details', null, 'material-review'); materials.append(node('summary', '材料编码、N 单元与答案预检'));
  renderMaterialCheck(materials, plan, precheck); container.append(materials);
}
function renderBalance(container, check) {
  if (!check) { container.append(node('p', '该计划没有保存序列检查。')); return; }
  const warnings = check.warnings ?? [];
  container.append(node('p', warnings.length ? warnings.map(w => typeof w === 'string' ? w.replace(/control/g, '对照').replace(/during targets=(\d+); sparse target denominator/g, '通知期间仅$1个目标，命中率分母较少') : JSON.stringify(w)).join('；') : '未发现超过冻结阈值的序列失衡。', warnings.length ? 'plan-warning' : 'plan-ok'));
  const rows = check.rows ?? check.groups ?? [];
  if (rows.length) container.append(table(['N', '阶段', '目标', '非目标', '目标比例', '目标位置（0起）/前中后分箱'], rows.map(r => [r.n_level ?? r.n ?? '—', windows[r.window ?? r.phase] ?? r.window ?? r.phase, r.targets ?? r.target_count, r.non_targets ?? r.non_target_count, percent(r.target_ratio), `${JSON.stringify(r.target_positions ?? [])} / ${JSON.stringify(r.target_position_bins ?? [])}`])));
  const detail = node('details'); detail.append(node('summary', '完整检查与冻结规则'), node('pre', JSON.stringify(check, null, 2))); container.append(detail);
}
function renderMaterialCheck(container, plan, precheck) {
  if (precheck) { const raw = node('details'); raw.append(node('summary', '材料预检报告'), node('pre', JSON.stringify(precheck, null, 2))); container.append(raw); }
  const ids = new Set(plan.blocks.map(b => b.material_id).filter(Boolean));
  for (const m of plan.materials.filter(m => ids.has(m.id))) {
    const section = node('details'); section.append(node('summary', `${m.id} · N${m.n_count ?? m.iu_count} · ${m.domain} · ${m.source_label ?? ''}`));
    section.append(node('p', m.text_lines.join(' / ')), node('p', `N 单元：${m.n_units?.join('；') || '未标注'}`), node('p', `理解题：${m.question}`));
    const list = node('ul'); list.append(...m.options.map((o, i) => node('li', `${i + 1}. ${o}${i === m.correct ? '（编码答案）' : ''}`))); section.append(list);
    if (m.source_warnings?.length) section.append(node('p', m.source_warnings.join('；'), 'plan-warning'));
    container.append(section);
  }
}
function decimal(value) { return value == null || !Number.isFinite(value) ? '—' : value.toFixed(3); }
function renderTracking(detail) {
  const rows = detail.tracking_summary ?? [];
  $('#tracking-summary').replaceChildren(rows.length ? table(['任务', 'N', '阶段', 'RMSE', '平均误差', '目标内比例', '有效时长（ms）', '质控'], rows.map(r => [r.block_id, r.n_count ?? '—', windows[r.window] ?? r.window, decimal(r.rmse), decimal(r.mean_error), percent(r.in_target_fraction), r.valid_duration_ms ?? 0, r.valid ? '有效' : (r.qc_flags ?? []).join('、') || '无有效数据'])) : node('p', '—', 'muted'));
  const recovery = detail.tracking_recovery ?? [];
  $('#tracking-recovery').replaceChildren(recovery.length ? table(['任务', 'N', '消失后（秒）', 'RMSE', '较基线变化', '平均误差', '目标内比例', '有效时长（ms）'], recovery.map(r => [r.block_id, r.n_count ?? '—', `${r.relative_start_ms / 1000}–${r.relative_end_ms / 1000}`, decimal(r.rmse), decimal(r.rmse_delta), decimal(r.mean_error), percent(r.in_target_fraction), r.valid_duration_ms ?? 0])) : node('p', '—', 'muted'));
}
function renderPooled(rows) {
  $('#pooled-summary').replaceChildren(...rows.map(r => { const tr = node('tr'); tr.append(...[r.block_type === 'control' ? '对照' : `N${r.n_count ?? r.n_level ?? r.n ?? '—'}`, windows[r.window ?? r.phase] ?? r.window ?? r.phase, `${r.eligible ?? 0}/${r.target_n ?? r.targets ?? r.target_count ?? 0}/${r.non_target_n ?? r.non_targets ?? r.non_target_count ?? 0}`, percent(r.accuracy), percent(r.hit_rate), percent(r.false_alarm_rate), percent(r.balanced_accuracy), r.hit_rt_mean_ms == null ? '—' : `${Math.round(r.hit_rt_mean_ms)} / ${Math.round(r.hit_rt_median_ms)} ms / ${r.hit_rt_n ?? r.hit_rt_count ?? 0}`].map(v => node('td', v))); return tr; }));
  if (!rows.length) { const tr = node('tr'), td = node('td', '尚无可合并的完整有效尝试。'); td.colSpan = 8; tr.append(td); $('#pooled-summary').append(tr); }
}
let refreshing = false;
async function poll() { if (shuttingDown || refreshing || document.hidden) return; refreshing = true; try { if (checkVisible) await loadDevice(); else { await refresh(); if (deviceState === null || Date.now() % 6000 < 1500) await loadDevice(); } } catch (e) { feedback(e.message); } finally { refreshing = false; } }
await network().catch(e => feedback(e.message));
try { const library = await api('materials'); $('#materials-info').textContent = `材料库 ${library.count} 条 · ${library.levels.map(l => `N${l.n} ${l.count}`).join(' · ')}${library.warnings.length ? ` · 来源字符差异 ${library.warnings.length}` : ''}`; } catch (e) { feedback(e.message); }
try { const data = await api('device/materials'); deviceMaterials = data.materials; $('#image-material').replaceChildren(...deviceMaterials.map(m => new Option(`${m.id} · ${m.source_label}`, m.id))); $('#image-material').dispatchEvent(new Event('change')); await loadDevice(); } catch (e) { feedback(e.message); }
drawCreateVisuals();
await poll(); setInterval(poll, 1500);
