const $ = s => document.querySelector(s);
function node(tag, text) { const n = document.createElement(tag); if (text != null) n.textContent = text; return n; }
async function api(path, value) { const r = await fetch('/api/admin/' + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) }); const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; }
let selected = null, entries = [], listSignature = '', noticeTimer;
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
    $('#sessions').replaceChildren(...entries.map(s => { const b = node('button', `${s.participant_id} · ${phaseNames[s.phase]} · ${s.index + 1}/${s.total_blocks}`); b.setAttribute('aria-pressed', String(s.id === selected)); b.addEventListener('click', () => { selected = s.id; refresh().catch(error => feedback(error.message)); }); return b; }));
  }
  if (!selected) return;
  const detail = await api('sessions/' + selected), entry = entries.find(s => s.id === selected);
  $('#empty').hidden = true; $('#selected').hidden = false;
  $('#title').textContent = `被试 ${detail.participant_id}`;
  $('#state').textContent = `${phaseNames[detail.phase]} · ${Math.min(detail.index + 1, detail.total_blocks)}/${detail.total_blocks} · ${detail.preset === 'quick' ? '快速预演' : '完整结构预演'}`;
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
async function poll() { if (refreshing || document.hidden) return; refreshing = true; try { await refresh(); } catch (e) { feedback(e.message); } finally { refreshing = false; } }
await network().catch(e => feedback(e.message)); await poll(); setInterval(poll, 1500);
