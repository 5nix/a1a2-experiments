const $ = s => document.querySelector(s), main = $('#main');
const params = new URLSearchParams(location.hash.slice(1)), session = params.get('session'), token = params.get('token');
const endpoint = `/api/participant/sessions/${session}`;
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
let current, running = null, rendered = '', breakTimer, pollBusy = false;
function el(tag, text, attrs = {}) { const n = document.createElement(tag); if (text != null) n.textContent = text; for (const [key, value] of Object.entries(attrs)) n[key] = value; return n; }
function message(text) { $('#status').textContent = text; }
async function api(action = '', value) {
  const r = await fetch(endpoint + (action ? '/' + action : ''), { method: value === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  const data = await r.json(); if (!r.ok) { const e = new Error(data.error); e.status = r.status; throw e; } return data;
}
const localKey = `a1-pending:${session}`;
function readPending() { try { return JSON.parse(localStorage.getItem(localKey) || 'null'); } catch { throw new Error('本地待上传记录损坏，请保留页面并联系主试。'); } }
function persist(r) {
  try { localStorage.setItem(localKey, JSON.stringify({ attempt_id: r.attempt_id, owner: r.owner, events: r.queue })); }
  catch { r.persistenceFailed = true; message('本地记录空间不足，本段已中止，请联系主试。'); throw new Error('本地事件保存失败。'); }
}
function event(r, type, data = {}, at = performance.now()) {
  r.queue.push({ id: uuid(), type, at, seq: r.seq++, data }); persist(r);
}
async function flush(r) {
  if (r.uploading) return r.uploading;
  r.uploading = (async () => {
    while (r.queue.length) {
      const batch = r.queue.slice(0, 100);
      await api('events', { attempt_id: r.attempt_id, owner: r.owner, events: batch });
      r.queue.splice(0, batch.length); persist(r);
    }
  })();
  try { await r.uploading; message('记录已同步'); } finally { r.uploading = null; }
}
function button(text, work, primary = true) {
  const b = el('button', text, { className: primary ? 'primary' : '' });
  b.addEventListener('click', async () => { b.disabled = true; try { await work(); } catch (error) { message(error.message); } finally { if (b.isConnected) b.disabled = false; } }); return b;
}
async function load() { const view = await api(); current = view; render(view); }
function hideNotice() { $('#notice').hidden = true; }
function render(view) {
  if (running) return;
  const signature = `${view.phase}:${view.index}:${view.attempt_id}`;
  if (signature === rendered) return;
  rendered = signature; clearInterval(breakTimer); hideNotice(); main.className = 'task-shell'; main.replaceChildren();
  $('#progress').textContent = `任务 ${Math.min(view.index + 1, view.total_blocks)} / ${view.total_blocks}`;
  if (view.phase === 'READY') {
    const practice = view.block.kind === 'practice';
    main.append(el('h1', practice ? '大写字母 2-back' : '准备下一段任务'));
    if (practice) {
      main.append(el('p', '判断当前字母是否与前两个字母相同。相同就点击鼠标左键或按空格，不同则不操作。两种输入任选一种即可。'), el('div', 'B → F → B', { className: 'instruction-example' }), el('p', '第三个 B 与前两个字母中的 B 相同，此时响应。每段的前两个字母用于记忆，不评分。'), el('p', '通知出现时继续按原规则做字母任务，不需要关闭通知。通知结束后字母也不会重新开始。练习结束后不做问卷。'));
    } else main.append(el('p', '字母会持续按固定节奏出现。保持注意；仅在当前字母与前两个相同时点击鼠标左键或按空格。任务结束后再回答问题。'));
    main.append(el('p', '工程预演：通知暂时显示在屏幕右侧的“模拟眼镜”区域，使用合成材料；这不是正式眼镜呈现实验。', { className: 'preview-note' }));
    main.append(button(practice ? '开始练习' : '开始本段', begin));
  } else if (view.phase === 'RUNNING') {
    main.append(el('h1', '本段任务尚未正常结束'), el('p', '可能发生了页面刷新或另一个页面正在运行。本页不会自动续播或覆盖原始记录。若原页面仍在运行，请返回原页面。'));
    const pending = readPending();
    if (pending?.attempt_id === view.attempt_id) main.append(button('保留记录并中断本段', async () => {
      try { await flush({ ...pending, uploading: null, queue: pending.events }); } catch (error) { message(`原事件未上传：${error.message}；请保持本页并联系主试。`); return; }
      await api('interrupt', { owner: pending.owner }); localStorage.removeItem(localKey); rendered = ''; await load();
    }, false));
    else main.append(el('p', '请主试在后台中断本段后再开始。'));
  } else if (['RECALL', 'PROBE', 'EFFORT_GENERAL', 'EFFORT_RECOVERY'].includes(view.phase)) renderQuestion(view);
  else if (view.phase === 'BREAK') {
    main.append(el('h1', '本段已完成'), el('p', view.block.kind === 'practice' ? '练习结束，接下来进入正式任务。相同按鼠标或空格，不同不操作。' : '休息一下，准备好后继续。'));
    const counter = el('div', '', { className: 'large-number' }), until = performance.now() + view.break_remaining_ms;
    const tick = () => { counter.textContent = `${Math.max(0, Math.ceil((until - performance.now()) / 1000))} 秒`; }; tick(); breakTimer = setInterval(tick, 250);
    main.append(counter, button('继续／提前结束休息', async () => { await api('next', {}); await load(); }));
  } else main.append(el('h1', view.phase === 'COMPLETED' ? '本次实验已完成' : '本次会话已结束'), el('p', '感谢参与，请联系主试。已采集记录已保留。'));
}
function renderQuestion(view) {
  const shown = performance.now(), form = el('form'); let input;
  if (view.phase === 'RECALL') {
    form.append(el('h1', '请复述刚才的通知'), el('p', '请尽可能完整地回忆通知内容，不要求逐字一致。不记得也可以留空提交。'));
    input = el('textarea', null, { rows: 6, maxLength: 10000, ariaLabel: '通知复述' }); form.append(input);
  } else if (view.phase === 'PROBE') {
    form.append(el('h1', '通知理解'), el('p', view.question.text)); const options = el('div', null, { className: 'options' });
    view.question.options.forEach((text, i) => { const label = el('label'); label.append(el('input', null, { type: 'radio', name: 'answer', value: String(i), required: true }), el('span', text)); options.append(label); }); form.append(options);
  } else {
    const recovery = view.phase === 'EFFORT_RECOVERY';
    form.append(el('h1', recovery ? '恢复任务的心理努力' : '完成任务的心理努力'), el('p', recovery ? '通知消失之后，为了重新回到 2-back 任务的节奏并克服通知带来的干扰，你额外投入了多少心理努力？' : '完成刚才这段 2-back 任务，你投入了多少心理努力？'), el('p', '1＝非常非常低，9＝非常非常高；请选择最符合实际感受的一项。'));
    const choices = el('div', null, { className: 'score-options' });
    for (let i = 1; i <= 9; i++) { const label = el('label'); label.append(el('input', null, { type: 'radio', name: 'answer', value: String(i), required: true }), el('span', String(i))); choices.append(label); } form.append(choices);
  }
  const submit = el('button', '提交并继续', { type: 'submit', className: 'primary' }); form.append(submit);
  form.addEventListener('submit', async e => {
    e.preventDefault(); submit.disabled = true;
    const at = performance.now(), answer = input ? input.value : Number(new FormData(form).get('answer'));
    try { await api('answer', { phase: view.phase, answer, timing: { shown_at: shown, submitted_at: at, time_origin: performance.timeOrigin } }); await load(); }
    catch (error) { message(error.message); submit.disabled = false; }
  }); main.append(form);
}
async function begin() {
  if (innerWidth < 1000 || innerHeight < 600) throw new Error('请在电脑上打开并放大窗口至至少1000×600，避免通知遮挡字母。');
  const pending = readPending();
  if (pending?.events?.length) { await flush({ ...pending, queue: pending.events, uploading: null }); localStorage.removeItem(localKey); }
  const owner = uuid(); const plan = await api('start', { owner });
  const r = { ...plan, owner, seq: 0, queue: [], uploading: null, index: -1, itemOnset: null, responded: false, visible: false, noticeOn: false, noticeDone: false, cancelled: false, finishing: false, start: performance.now() + 800, frame: 0 };
  running = r; persist(r);
  main.className = 'task-running';
  const letter = el('div', '', { className: 'letter', ariaLabel: '当前字母' });
  const hint = el('div', '相同：鼠标左键或空格　不同：不操作', { className: 'task-hint' });
  const practice = el('div', '', { className: 'practice-feedback' });
  const stop = button('中断本段', async () => { if (!confirm('中断本段？该尝试会保留并标记无效。')) return; await interruptRun(r); }, false); stop.className = 'interrupt-control'; stop.dataset.control = 'true';
  main.replaceChildren(letter, hint, practice, stop); r.letter = letter; r.practice = practice;
  event(r, 'run_start', { time_origin: performance.timeOrigin, planned_start: r.start, stimulus_ms: r.block.stimulus_ms, soa_ms: r.block.soa_ms, history_across_notification: 'carry', viewport: { width: innerWidth, height: innerHeight }, source: 'browser_mock' });
  const showNext = now => {
    if (r.cancelled) return;
    try {
      const b = r.block, notifyAt = r.start + b.baseline_count * b.soa_ms, notifyOff = notifyAt + b.notification_ms;
      if (b.kind !== 'practice' && !r.noticeOn && now >= notifyAt) {
        r.noticeOn = true;
        if (b.kind === 'notification') { $('#notice-text').textContent = r.notification.text_lines.join('\n'); $('#notice').hidden = false; }
        event(r, b.kind === 'notification' ? 'notification_onset' : 'sham_onset', { material_id: b.material_id, planned_at: notifyAt, source: 'browser_mock', line_count: r.notification?.text_lines.length ?? 0 }, now);
      }
      if (r.noticeOn && !r.noticeDone && now >= notifyOff) {
        r.noticeDone = true; hideNotice(); event(r, b.kind === 'notification' ? 'notification_offset' : 'sham_offset', { planned_at: notifyOff, source: 'browser_mock', reason: 'fixed_duration' }, now);
      }
      const next = Math.floor((now - r.start) / b.soa_ms);
      if (next > r.index) {
        if (next > r.index + 1) { event(r, 'timing_gap', { skipped_from: r.index + 1, skipped_to: next - 1 }, now); failTiming(r); return; }
        if (r.index >= 0) closeItem(r, now);
        if (next >= b.letters.length) { finishRun(r, now); return; }
        r.index = next; r.responded = false; r.visible = true;
        const planned = r.start + next * b.soa_ms;
        if (now - planned > 100) event(r, 'timing_gap', { index: next, late_ms: now - planned }, now);
        letter.textContent = b.letters[next]; r.itemOnset = now;
        event(r, 'stimulus_onset', { index: next, letter: b.letters[next], planned_at: planned, target: next >= 2 && b.letters[next] === b.letters[next - 2] }, now);
      }
      if (r.visible && now >= r.start + r.index * b.soa_ms + b.stimulus_ms) {
        letter.textContent = ''; r.visible = false; event(r, 'stimulus_offset', { index: r.index, planned_at: r.start + r.index * b.soa_ms + b.stimulus_ms }, now);
      }
      r.frame = requestAnimationFrame(showNext);
    } catch (error) { r.cancelled = true; hideNotice(); letter.textContent = ''; message(error.message + ' 请联系主试中断并保留数据。'); }
  };
  r.frame = requestAnimationFrame(showNext);
}
function closeItem(r, at) {
  if (r.visible) { event(r, 'stimulus_offset', { index: r.index, late: true }, at); r.visible = false; }
  event(r, 'item_end', { index: r.index }, at);
  if (r.block.kind === 'practice') {
    const target = r.index >= 2 && r.block.letters[r.index] === r.block.letters[r.index - 2];
    r.practice.textContent = r.index < 2 ? '前两项不评分' : target === r.responded ? '上一项：正确' : target ? '上一项：漏报' : '上一项：误报';
  }
}
function respond(source, repeat = false) {
  const r = running; if (!r || r.cancelled || r.finishing) return;
  const at = performance.now(), before = r.index < 0, late = r.index >= 0 && at >= r.start + (r.index + 1) * r.block.soa_ms;
  const accepted = !before && !late && r.index >= 2 && !repeat && !r.responded;
  event(r, 'response', { index: r.index, source, repeat, accepted, reason: before ? 'before_start' : late ? 'outside_item_window' : r.index < 2 ? 'warmup' : repeat ? 'held_key' : r.responded ? 'extra_response' : 'first_response' }, at);
  if (accepted) r.responded = true;
}
document.addEventListener('keydown', e => { if (e.code !== 'Space' || !running || running.finishing || running.cancelled) return; e.preventDefault(); try { respond('space', e.repeat); } catch (error) { message(error.message); } });
document.addEventListener('pointerdown', e => { if (e.button !== 0 || e.pointerType !== 'mouse' || e.target.closest('[data-control]')) return; try { respond('mouse_left'); } catch (error) { message(error.message); } });
addEventListener('blur', () => { if (running && !running.finishing && !running.cancelled) try { event(running, 'window_blur'); } catch {} });
document.addEventListener('visibilitychange', () => { if (running && !running.finishing && !running.cancelled) try { event(running, document.hidden ? 'visibility_hidden' : 'visibility_visible'); } catch {} });
addEventListener('resize', () => { if (running && !running.finishing && !running.cancelled) try { event(running, 'viewport_changed', { width: innerWidth, height: innerHeight }); if (innerWidth < 1000 || innerHeight < 600) { event(running, 'timing_gap', { reason: 'viewport_too_small' }); failTiming(running); } } catch {} });
async function failTiming(r) { r.cancelled = true; r.letter.textContent = ''; hideNotice(); message('任务时序被打断，请中断本段后重新开始；原始记录保留。'); }
async function interruptRun(r) {
  r.cancelled = true; cancelAnimationFrame(r.frame); hideNotice(); r.letter.textContent = '';
  try { await flush(r); await api('interrupt', { owner: r.owner }); localStorage.removeItem(localKey); running = null; rendered = ''; await load(); }
  catch (error) { message(`中断未完成：${error.message}。本地记录保留，请重试。`); }
}
async function finishRun(r, now) {
  r.finishing = true; hideNotice(); r.letter.textContent = ''; event(r, 'run_end', { planned_at: r.start + r.block.letters.length * r.block.soa_ms }, now);
  main.className = 'task-shell'; main.replaceChildren(el('h1', '正在保存本段记录'));
  const commit = async () => { await flush(r); await api('finish', { owner: r.owner }); localStorage.removeItem(localKey); running = null; rendered = ''; await load(); };
  try { await commit(); } catch (error) { message(error.message); main.append(el('p', '事件仍保存在本机，请保持页面，恢复网络后重试。'), button('重试保存', commit)); }
}
setInterval(() => { if (running?.queue.length && !running.uploading) flush(running).catch(error => { message(`尚未同步：${error.message}；本地记录已保留。`); }); }, 500);
setInterval(async () => {
  if (pollBusy) return; pollBusy = true;
  try {
    const view = await api();
    if (running && (view.phase === 'ABORTED' || view.phase === 'READY' && view.attempt_id !== running.attempt_id)) {
      running.cancelled = true; cancelAnimationFrame(running.frame); hideNotice(); running.letter.textContent = ''; running = null; rendered = '';
      message('主试已中断本段；本地未上传事件保留。请联系主试后再开始。');
    }
    current = view; render(view);
  } catch (error) { message(error.message); } finally { pollBusy = false; }
}, 1500);
if (!session || !token) { main.append(el('h1', '请从主试后台打开被试入口')); }
else load().catch(error => { main.append(el('h1', '无法打开会话'), el('p', error.message)); });
