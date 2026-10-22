const $ = s => document.querySelector(s);
function node(tag, text) { const n = document.createElement(tag); if (text != null) n.textContent = text; return n; }
async function api(path, value) { const r = await fetch('/api/admin/' + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) }); const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; }
let selected = null, entries = [], listSignature = '', noticeTimer;
let deviceState = null, deviceBusy = false, imageDraft = null, deviceMaterials = [], checkVisible = false;
const requestId = () => crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
for (const view of ['sessions', 'check']) $('#tab-' + view).addEventListener('click', () => {
  checkVisible = view === 'check'; $('#session-panel').hidden = checkVisible; $('#check-panel').hidden = !checkVisible;
  $('#tab-sessions').setAttribute('aria-pressed', String(!checkVisible)); $('#tab-check').setAttribute('aria-pressed', String(checkVisible));
  if (checkVisible) loadDevice().catch(e => feedback(e.message));
});
function renderDevice() {
  const d = deviceState; if (!d) return; const a = d.adapter, busy = deviceBusy || d.working;
  $('#device-badge').textContent = d.image_ready ? 'A1眼镜图片端就绪' : a.connected ? '已连接 · 显示端未就绪' : '眼镜未连接 · 可用Mock';
  $('#device-status').textContent = `设备：${d.serial || '尚未选择'} · ${a.connected ? 'USB通道已连接' : 'USB通道未连接'} · ${a.ready ? '显示端就绪' : '显示端未就绪'} · ${a.image_protocol ? '支持图片协议' : '尚未确认图片能力'}${a.busy ? ' · 正在显示' : ''}`;
  const diagnostic = d.error || a.error || '';
  $('#device-diagnostic').textContent = { device_serial_missing: '尚未选择眼镜，请扫描并连接已授权的ADB设备。', device_not_probed: '设备尚未探测，请刷新连接状态。', device_disconnected: 'USB显示通道已断开，请检查连接并重试。' }[diagnostic] ?? diagnostic;
  $('#host-state').textContent = `上位机守护：${d.enabled ? a.connected ? '已开启' : '已设置开启（待设备连接）' : '已关闭'} · 语音悬浮窗：${{ protected: '已限制', restored: '已恢复', pending: '待核对', error: '失败' }[d.voice_guard.state]} · scrcpy：${d.scrcpy.running ? '运行中' : '未启动'}`;
  $('#host-toggle').textContent = d.enabled ? '关闭上位机守护' : '开启上位机守护';
  $('#send-image').disabled = busy || !d.manual_allowed;
  for (const b of document.querySelectorAll('[data-device-action],#host-toggle,#bind-device,#scan-devices')) b.disabled = busy;
  const signature = JSON.stringify(d.records.map(r => [r.request_id, r.status, r.error, r.events.length]));
  if ($('#device-records').dataset.signature !== signature) {
    $('#device-records').dataset.signature = signature;
    $('#device-records').replaceChildren(...d.records.slice(0, 15).map(r => {
      const box = node('div'); box.className = 'device-record';
      const drawn = r.events.find(e => e.kind === 'drawn'), hidden = r.events.find(e => e.kind === 'hidden');
      const ms = drawn && hidden && drawn.clock_id === hidden.clock_id ? hidden.device_monotonic_ms - drawn.device_monotonic_ms : null;
      box.append(node('strong', `${r.kind === 'manual' ? '手动调试' : '实验通知'} · ${r.material_id} · ${{ sending: '发送中', accepted: '已接受，等待绘制证据', drawn: '双眼已绘制', hidden: '双眼已绘制并清屏', failed: '失败', unknown: '结果待核查', unacknowledged: '未收到接受回执' }[r.status] ?? r.status}`), node('p', `${r.events.map(e => e.kind).join(' → ') || '尚无设备绘制事件'}${ms == null ? '' : ` · 设备绘制间隔 ${ms}ms`}`));
      if (r.error) box.append(node('p', r.error)); return box;
    }));
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
for (const b of document.querySelectorAll('[data-device-action]')) b.addEventListener('click', async () => { try { await deviceAction('device/control', { action: b.dataset.deviceAction }); feedback('控制操作已完成，请核对当前设备状态。'); } catch (e) { feedback(e.message); } });
$('#host-toggle').addEventListener('click', async () => { try { await deviceAction('device/control', { action: 'host', enabled: !deviceState.enabled }); } catch (e) { feedback(e.message); } });
$('#image-material').addEventListener('change', () => { imageDraft = null; const m = deviceMaterials.find(m => m.id === $('#image-material').value); if (m) { $('#image-preview').src = '/api/admin/device/images/' + encodeURIComponent(m.render_image); $('#image-preview').alt = m.text_lines.join(' '); } });
$('#image-notify').addEventListener('submit', async e => {
  e.preventDefault(); const material = $('#image-material').value, duration = Number($('#image-duration').value);
  if (!imageDraft || imageDraft.material_id !== material || imageDraft.duration_ms !== duration) imageDraft = { request_id: requestId(), material_id: material, duration_ms: duration };
  try { const record = await deviceAction('device/notify', imageDraft); imageDraft = null; feedback(record.status === 'accepted' ? '显示请求已接受，请等待双眼drawn与hidden证据。' : `当前结果：${record.status}，请查看设备记录。`); } catch (e) { feedback(e.message); }
});
function feedback(message) { $('#feedback').textContent = message; $('#feedback').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('#feedback').hidden = true; }, 8000); }
const phaseNames = { READY: '等待开始', RUNNING: '字母任务进行中', RECALL: '文本复述', PROBE: '理解题', EFFORT_GENERAL: '通用努力评分', EFFORT_RECOVERY: '恢复努力评分', BREAK: '休息', COMPLETED: '已完成', ABORTED: '已结束' };
const windows = { pre: '通知前', during: '通知期间', post: '通知后', boundary: '边界项', practice: '练习' };
async function network() {
  const info = await api('network'); const options = info.addresses.length ? info.addresses : [{ base_url: info.local_url, name: '本机', address: '127.0.0.1' }];
  $('#address').replaceChildren(...options.map(o => new Option(`${o.address} · ${o.name}`, o.base_url)));
  const saved = sessionStorage.getItem('a1-share-origin'); if (options.some(o => o.base_url === saved)) $('#address').value = saved;
  updateAddress();
}
function updateAddress() { const url = $('#address').value + '/admin'; $('#admin-url').value = url; $('#qr').src = '/api/admin/qr?text=' + encodeURIComponent(url); sessionStorage.setItem('a1-share-origin', $('#address').value); }
$('#address').addEventListener('change', updateAddress);
$('#copy-address').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#admin-url').value); feedback('主试地址已复制。'); } catch { $('#admin-url').select(); feedback('地址已选中，请复制。'); } });
$('#create').addEventListener('submit', async e => {
  e.preventDefault(); const button = e.submitter; button.disabled = true;
  try { const input = Object.fromEntries(new FormData(e.target)); const created = await api('sessions', input); selected = created.session_id; await refresh(); feedback('已创建，请在电脑打开被试页面。'); }
  catch (error) { feedback(error.message); } finally { button.disabled = false; }
});
async function refresh() {
  const data = await api('sessions'); entries = data.sessions;
  const signature = JSON.stringify(entries.map(s => [s.id, s.phase, s.index, s.participant_id, selected]));
  if (signature !== listSignature) {
    listSignature = signature;
    $('#sessions').replaceChildren(...entries.map(s => { const b = node('button', `${s.participant_id} · ${phaseNames[s.phase]} · ${Math.min(s.index + 1, s.total_blocks)}/${s.total_blocks}`); b.setAttribute('aria-pressed', String(s.id === selected)); b.addEventListener('click', () => { selected = s.id; refresh().catch(error => feedback(error.message)); }); return b; }));
  }
  if (!selected) return;
  const detail = await api('sessions/' + selected), entry = entries.find(s => s.id === selected);
  $('#empty').hidden = true; $('#selected').hidden = false;
  $('#title').textContent = `被试 ${detail.participant_id}`;
  $('#state').textContent = `${phaseNames[detail.phase]} · ${Math.min(detail.index + 1, detail.total_blocks)}/${detail.total_blocks} · ${{ quick: '快速预演', sop: '12条子集', pool: '18条全部材料' }[detail.preset]} · ${detail.synthetic ? '旧版合成材料' : '来源材料库'}`;
  $('#open').href = entry.participant_url; $('#export').href = '/api/admin/export?session_id=' + selected;
  $('#interrupt').disabled = detail.phase !== 'RUNNING'; $('#stop').disabled = ['COMPLETED', 'ABORTED'].includes(detail.phase);
  const rows = detail.summaries.filter(r => r.eligible > 0);
  $('#summary').replaceChildren(...rows.map(r => {
    const pre = rows.find(x => x.attempt_id === r.attempt_id && x.window === 'pre');
    const diff = pre && ['during', 'post'].includes(r.window) ? (r.accuracy - pre.accuracy) * 100 : null;
    const tr = node('tr'); const values = [r.block_id, windows[r.window], r.eligible, `${(r.accuracy * 100).toFixed(1)}%`, r.hit_rt_mean_ms == null ? '—' : `${Math.round(r.hit_rt_mean_ms)} ms`, diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff.toFixed(1)} 个百分点`];
    tr.append(...values.map(v => node('td', v))); return tr;
  }));
  $('#events').textContent = detail.recent_events.map(e => `${e.type} ${e.at ?? ''}\n${JSON.stringify(e.data)}`).join('\n');
}
for (const action of ['stop', 'interrupt']) $('#' + action).addEventListener('click', async () => { if (!selected || !confirm(action === 'stop' ? '结束此会话并保留已采集数据？' : '中断本段并保留无效尝试？重新开始会再次使用本段材料。')) return; try { await api(`sessions/${selected}/${action}`, { reason: '主试后台操作' }); await refresh(); } catch (error) { feedback(error.message); } });
$('#note').addEventListener('submit', async e => { e.preventDefault(); try { await api(`sessions/${selected}/notes`, { reason: $('#note-text').value }); $('#note-text').value = ''; feedback('备注已保存。'); } catch (error) { feedback(error.message); } });
let refreshing = false;
async function poll() { if (refreshing || document.hidden) return; refreshing = true; try { if (checkVisible) await loadDevice(); else await refresh(); } catch (e) { feedback(e.message); } finally { refreshing = false; } }
await network().catch(e => feedback(e.message));
try { const library = await api('materials'); $('#materials-info').textContent = `材料库 ${library.count} 条：${library.levels.map(l => `N${l.n} ${l.count}条`).join('，')}。原图保留换行；来源编码差异${library.warnings.length}项。`; } catch (e) { feedback(e.message); }
try { const data = await api('device/materials'); deviceMaterials = data.materials; $('#image-material').replaceChildren(...deviceMaterials.map(m => new Option(`${m.id} · ${m.source_label}`, m.id))); $('#image-material').dispatchEvent(new Event('change')); await loadDevice(); } catch (e) { feedback(e.message); }
await poll(); setInterval(poll, 1500);
