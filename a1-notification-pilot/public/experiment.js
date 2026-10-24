import { AuditoryPlayer } from './auditory-player.js';
import { TrackingTask } from './tracking-task.js';
const $ = s => document.querySelector(s), main = $('#main');
const params = new URLSearchParams(location.hash.slice(1)), session = params.get('session'), token = params.get('token');
const endpoint = `/api/participant/sessions/${session}`;
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
let current, running = null, rendered = '', breakTimer, pollBusy = false, imageUrl = null;
let audioConfirmed = false, rulesSeen = false, lastPractice = null, pageKeyHandler = null;
const LEAD_IN_MS = 3000; // 开始前 3-2-1 倒计时；音频从倒计时结束时开始。
const RING = 339.3; // 2πr，r=54（viewBox 120）
const audioPlayer = new AuditoryPlayer(error => {
  if (!running?.auditory || running.cancelled || running.finishing) return;
  try { event(running, 'audio_interrupted', { error: error.message }); } catch {}
  failTiming(running);
});
const isAuditory = view => view.primary_modality === 'auditory_digits';
const isTracking = view => view?.primary_modality === 'compensatory_tracking';
async function prepareAudio(view) {
  await audioPlayer.unlock(); // 用户点击中立即解锁，随后才读取固定录音。
  if (!view.audio_manifest) throw new Error('本会话缺少数字录音清单，请从后台创建新会话。');
  await audioPlayer.prepare(view.audio_manifest);
}

/* ---------- DOM 小工具 ---------- */
function el(tag, text, attrs = {}) { const n = document.createElement(tag); if (text != null) n.textContent = text; for (const [key, value] of Object.entries(attrs)) n[key] = value; return n; }
function box(tag, className, ...children) { const n = document.createElement(tag); if (className) n.className = className; n.append(...children.filter(c => c != null)); return n; }
function svg(markup) { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstElementChild; }
function keys(prefix) { return box('span', 'keys', prefix ? el('span', prefix) : null, el('kbd', '空格'), el('span', '或'), el('kbd', '鼠标左键')); }
function message(text, isError = /失败|无效|错误|异常|不能|请|未|损坏|中止|打断|中断/.test(text)) { const s = $('#status'); s.textContent = text; s.classList.toggle('error', Boolean(text) && isError); }

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
  try { await r.uploading; if (!running || running === r) message(''); } finally { r.uploading = null; }
}
function button(text, work, kind = 'primary', errorTarget) {
  const b = el('button', text, { className: `btn ${kind}`, type: 'button' });
  b.addEventListener('click', async () => {
    b.disabled = true; if (errorTarget) errorTarget.textContent = '';
    try { await work(); } catch (error) { if (errorTarget?.isConnected) errorTarget.textContent = error.message; else message(error.message, true); }
    finally { if (b.isConnected) b.disabled = b.dataset.locked === 'true'; }
  }); return b;
}
async function load() { const view = await api(); current = view; render(view); }
function hideNotice() { $('#notice').hidden = true; }
function setPageKeys(handler) { if (pageKeyHandler) document.removeEventListener('keydown', pageKeyHandler); pageKeyHandler = handler; if (handler) document.addEventListener('keydown', handler); }

/* ---------- 页面渲染 ---------- */
function render(view) {
  if (running) return;
  const signature = `${view.phase}:${view.index}:${view.attempt_id}`;
  if (signature === rendered) return;
  rendered = signature; clearInterval(breakTimer); setPageKeys(null); hideNotice(); document.body.classList.remove('running');
  main.className = 'task-shell'; main.replaceChildren();
  const auditory = isAuditory(view), label = isTracking(view) ? '动态补偿追踪' : auditory ? '听觉数字 2-back' : '视觉字母 2-back';
  document.title = 'A1 ' + label;
  const done = ['COMPLETED', 'ABORTED'].includes(view.phase) ? view.total_blocks : view.index;
  const ended = ['COMPLETED', 'ABORTED'].includes(view.phase);
  $('#progress').replaceChildren(...Array.from({ length: view.total_blocks ?? 0 }, (_, i) => el('li', null, { className: i < done || ended ? 'done' : i === view.index ? 'current' : '' })));
  $('#progress').ariaLabel = `进度 ${Math.min(view.index + 1, view.total_blocks)} / ${view.total_blocks}`;
  $('#mode-badge').textContent = view.mode === 'rayneo' ? '' : 'MOCK';
  renderDebugPicker(view);
  if (view.phase === 'READY') renderReady(view);
  else if (view.phase === 'RUNNING') {
    const card = box('section', 'card narrow', el('div', '需要主试协助', { className: 'eyebrow' }), el('h1', '本段任务尚未正常结束'), el('p', '可能发生了页面刷新，或另一个页面正在运行。本页不会自动续播或覆盖原始记录；若原页面仍在运行，请回到原页面。', { className: 'lead' }));
    const pending = readPending();
    if (pending?.attempt_id === view.attempt_id) card.append(box('div', 'actions', button('保留记录并中断本段', async () => {
      try { await flush({ ...pending, uploading: null, queue: pending.events }); } catch (error) { message(`原事件未上传：${error.message}；请保持本页并联系主试。`); return; }
      await api('interrupt', { owner: pending.owner }); localStorage.removeItem(localKey); rendered = ''; await load();
    }, '')));
    else card.append(el('p', '请主试在后台中断本段后再开始。', { className: 'fineprint' }));
    main.append(card);
  } else if (view.phase === 'RECALL') renderRecall(view);
  else if (['PROBE', 'EFFORT_GENERAL', 'EFFORT_RECOVERY'].includes(view.phase)) renderQuestions(view);
  else if (view.phase === 'BREAK') renderBreak(view);
  else { main.className = ''; main.append(box('section', 'rest', el('h1', view.phase === 'COMPLETED' ? '完成' : '已结束', { className: 'display' }), el('p', view.phase === 'COMPLETED' ? '谢谢参与，请告知主试。' : '请告知主试。'))); }
}

/* ---------- 动态追踪：共用小部件 ---------- */
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>';
function go(text, work, errorTarget) {
  const b = button(text, work, '', errorTarget); b.className = 'go'; b.append(svg(ARROW)); return b;
}
const pad = n => String(n).padStart(2, '0');
// 通知指导语：练习页与正式开始页使用完全相同的两行。
function noticeCue() {
  return box('div', 'cue', el('i', null, { ariaHidden: 'true' }), box('span', 'cue-lines', el('span', '通知出现时继续追踪'), el('span', '请阅读通知内容，以便后续回答问题')));
}
// 调试被试：鼠标未锁定时（任务外）可直接选择关卡。正式被试不出现。
function renderDebugPicker(view) {
  let picker = $('#debug-picker');
  if (!view.debug || !view.debug_blocks) { picker?.remove(); return; }
  if (!picker) { picker = box('label', 'debug-picker', el('span', 'DEBUG'), el('select', null, { ariaLabel: '调试：选择关卡' })); picker.id = 'debug-picker'; $('.topbar').append(picker); }
  const select = picker.querySelector('select');
  let formal = 0;
  select.replaceChildren(...view.debug_blocks.map((b, i) => {
    if (b.kind !== 'practice') formal++;
    return new Option(b.kind === 'practice' ? '练习' : `${pad(formal)} · ${b.kind === 'control' ? '对照' : `N${b.n_count ?? '?'} · ${b.material_id}`}`, String(i));
  }));
  select.value = String(view.index);
  select.onchange = async () => {
    select.disabled = true;
    try { await api('jump', { index: Number(select.value) }); rendered = ''; await load(); }
    catch (error) { message(error.message, true); select.value = String(view.index); }
    finally { select.disabled = false; }
  };
}

function demo(auditory) {
  const [a, b] = auditory ? ['1', '4'] : ['B', 'F'];
  const chip = (t, note, match) => box('div', 'chip' + (match ? ' match' : ''), document.createTextNode(t), note ? el('small', note) : null);
  return box('div', 'demo',
    svg('<svg class="demo-arc" viewBox="0 0 236 44" aria-hidden="true"><path d="M32 42 C 60 2, 176 2, 204 42"/></svg>'),
    chip(a, auditory ? '听到' : ''), chip(b, ''), chip(a, '与前两个相同', true),
    box('div', 'demo-key', el('kbd', '按')));
}

function renderReady(view) {
  if (isTracking(view)) { renderTrackingReady(view); return; }
  const practice = view.block.kind === 'practice', auditory = isAuditory(view);
  const needRules = practice && !rulesSeen, needSound = auditory && !audioConfirmed;
  const card = box('section', 'card');
  card.append(el('div', practice ? '练习' : `正式任务 · 第 ${view.index + 1} 段`, { className: 'eyebrow' }),
    el('h1', practice ? (auditory ? '听数字，找“隔一个相同”' : '看字母，找“隔一个相同”') : '准备好就开始下一段'),
    el('p', practice ? '先花一分钟熟悉规则和声音，然后做一段带提示的练习。' : (auditory ? '和练习一样：听到与前两个相同的数字就按，不同则不动。通知出现时继续听，不需要处理它。' : '和练习一样：字母与前两个相同就按，不同则不动。'), { className: 'lead' }));

  const stepNames = [], sections = [];
  const addStep = (name, title, body, isDone) => { stepNames.push(name); const s = box('div', 'step', box('div', 'step-head', el('h2', title), el('span', '', { className: 'state' })), box('div', 'step-body', ...body)); s.dataset.done = isDone ? 'true' : ''; sections.push(s); return s; };

  if (practice || needRules) {
    const ok = button('我明白了', async () => { rulesSeen = true; update(); }, 'primary');
    addStep('规则', '规则', [demo(auditory),
      el('p', auditory ? '电脑会以固定节奏播放数字 1—9。当听到的数字与它前面第二个数字相同时，按一下；不同时什么都不用做。' : '屏幕会依次出现字母。当前字母与它前面第二个字母相同时，按一下；不同时什么都不用做。'),
      el('p', auditory ? '屏幕中央只有一个注视点，不显示数字。通知出现或消失时任务不会暂停，请继续。' : '通知出现或消失时任务不会暂停，请继续。'),
      box('div', 'actions', ok, keys('作答键：'))], !needRules);
  }
  if (auditory) {
    const err = el('p', '', { className: 'error-line' });
    const check = box('div', 'sound-check');
    const play = box('button', 'sound-btn', svg('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>')); play.type = 'button'; play.ariaLabel = '播放试听';
    const labelText = box('div', 'sound-label', el('b', '试听：1、4、1'), el('span', '请用实验时的音量和耳机/扬声器'));
    check.append(play, labelText, box('div', 'wave', el('i'), el('i'), el('i'), el('i')));
    play.addEventListener('click', async () => {
      err.textContent = '';
      try {
        await prepareAudio(view); audioPlayer.stop(); audioPlayer.schedule(['1', '4', '1'], 1000, performance.now() + 250);
        check.classList.add('playing'); labelText.lastChild.textContent = '正在播放…';
        setTimeout(() => { check.classList.remove('playing'); check.classList.add('heard'); labelText.lastChild.textContent = '听清楚了吗？'; }, 2900);
      } catch (error) { err.textContent = error.message; }
    });
    const confirm = box('div', 'sound-confirm',
      button('听清了', async () => { audioConfirmed = true; update(); }, 'primary'),
      button('再听一次', async () => play.click(), 'ghost'));
    addStep('声音', '声音检查', [el('p', '数字由这台电脑播放，眼镜不发声。调到舒适且能听清的音量后，本次实验中请不要再改。'), check, confirm, err], !needSound);
  }
  const startErr = el('p', '', { className: 'error-line' });
  const start = button(practice ? '开始练习' : '开始本段', begin, 'primary large', startErr);
  addStep('开始', '开始', [el('p', `点击后有 ${LEAD_IN_MS / 1000} 秒倒计时。任务中请注视屏幕中央。`), box('div', 'actions', start, keys())], false);
  sections.at(-1).classList.add('final');

  const steps = box('ol', 'steps', ...stepNames.map((n, i) => { const li = el('li', n); li.dataset.n = String(i + 1); return li; }));
  if (stepNames.length > 1) card.append(steps);
  card.append(...sections);
  card.append(el('p', view.mode === 'rayneo' ? (auditory ? '通知图片显示在眼镜上，数字由电脑播放。' : '本会话保留旧视觉主任务，通知图片显示在眼镜上。') : (auditory ? '工程预演：通知会显示在屏幕右上角的模拟眼镜区域。' : '工程预演：电脑同时显示字母和模拟通知。'), { className: 'fineprint' }));
  main.append(card);

  function update() {
    if (practice || needRules) sections[0].dataset.done = rulesSeen ? 'true' : '';
    if (auditory) sections[sections.length - 2].dataset.done = audioConfirmed ? 'true' : '';
    let reached = false;
    sections.forEach((s, i) => {
      const isDone = s.dataset.done === 'true' && !s.classList.contains('final');
      const isCurrent = !isDone && !reached; if (isCurrent) reached = true;
      s.classList.toggle('done', isDone); s.classList.toggle('locked', !isDone && !isCurrent);
      s.querySelector('.state').textContent = isDone ? '✓ 已完成' : '';
      steps.children[i].className = isDone ? 'done' : isCurrent ? 'current' : '';
    });
    start.dataset.locked = String(sections.at(-1).classList.contains('locked')); start.disabled = start.dataset.locked === 'true';
    if (!start.disabled) start.focus({ preventScroll: true });
  }
  update();
}

function renderTrackingReady(view) {
  const practice = view.block.kind === 'practice', err = el('p', '', { className: 'err', role: 'alert' });
  main.className = '';
  const intro = box('section', 'intro');
  if (practice) {
    // 演示即说明：同一个"场"里，圆点漂出，鼠标反向移动把它带回圈内。
    intro.append(
      box('div', 'demo-stage', box('div', 'field demo-field', el('span', null, { className: 'ring' }), el('span', null, { className: 'dot' })), el('div', null, { className: 'mouse', ariaHidden: 'true' })),
      el('h1', '移动鼠标，让圆点留在圈内'),
      noticeCue());
  } else {
    intro.append(
      box('div', 'trial-no', el('b', pad(view.index + 1)), el('span', `/ ${pad(view.total_blocks)}`)),
      noticeCue());
  }
  const start = go(practice ? '开始练习' : '开始', begin, err);
  intro.append(box('div', null, start), err);
  main.append(intro);
}

function renderRecall(view) {
  const shown = performance.now(), form = box('form', 'card');
  const input = el('textarea', null, { className: 'recall', rows: 7, maxLength: 10000, ariaLabel: '通知复述', placeholder: '想到什么写什么，可以只写关键词…' });
  const count = el('div', '0 字', { className: 'char-count' });
  input.addEventListener('input', () => { count.textContent = `${input.value.trim().length} 字`; });
  const submit = el('button', '提交，进入下一页', { type: 'submit', className: 'btn primary large' });
  form.append(el('div', '回忆', { className: 'eyebrow' }), el('h1', '刚才的通知写了什么？'), el('p', '请尽量完整地写下你记得的内容，不要求逐字一致。实在不记得可以留空提交。', { className: 'lead' }), input, count, box('div', 'actions', submit, el('span', '提交后不能修改', { className: 'hint' })));
  form.addEventListener('submit', async e => {
    e.preventDefault(); submit.disabled = true;
    try { await api('answer', { phase: 'RECALL', answer: input.value, timing: { shown_at: shown, submitted_at: performance.now(), time_origin: performance.timeOrigin } }); await load(); }
    catch (error) { message(error.message, true); submit.disabled = false; }
  });
  main.append(form); setTimeout(() => input.focus(), 50);
}

function renderQuestions(view) {
  const shown = performance.now();
  const phases = view.phase === 'PROBE' ? ['PROBE', 'EFFORT_GENERAL'] : view.phase === 'EFFORT_GENERAL' ? ['EFFORT_GENERAL'] : [];
  if (view.phase === 'EFFORT_RECOVERY' || view.effort_recovery) phases.push('EFFORT_RECOVERY');
  main.className = '';
  const form = box('form', 'sheet'), list = box('div', 'q-list'), items = [];
  const task = isTracking(view) ? '追踪' : '任务';
  phases.forEach((phase, i) => {
    const item = { phase, value: null, first: null, last: null, changes: 0 };
    const id = `q-${phase}`, title = el('h2', null, { id });
    const fs = box('div', 'q', el('div', pad(i + 1), { className: 'q-num', ariaHidden: 'true' }));
    fs.setAttribute('role', 'radiogroup'); fs.setAttribute('aria-labelledby', id);
    let body;
    if (phase === 'PROBE') {
      title.textContent = view.question?.text ?? '通知理解';
      body = box('div', 'choices', ...(view.question?.options ?? []).map((text, k) => box('label', 'choice', el('input', null, { type: 'radio', name: 'probe', value: String(k) }), el('span', text))));
    } else {
      title.textContent = phase === 'EFFORT_RECOVERY'
        ? `通知消失后，为了重新稳定${task}、克服通知带来的干扰，你额外投入了多少心理努力？`
        : `完成刚才这段${task}，你投入了多少心理努力？`;
      const meter = box('div', 'meter');
      for (let v = 1; v <= 9; v++) meter.append(box('label', '', el('input', null, { type: 'radio', name: phase, value: String(v), ariaLabel: String(v) }), el('span', String(v))));
      body = box('div', '', meter, box('div', 'anchors', el('span', '非常非常低'), el('span', '非常非常高')));
    }
    fs.append(box('div', 'q-main', title, body)); list.append(fs);
    fs.addEventListener('change', e => {
      const t = performance.now(); item.value = Number(e.target.value); item.first ??= t; item.last = t; item.changes++;
      fs.classList.add('answered'); refresh();
    });
    item.fs = fs; items.push(item);
  });
  const submit = el('button', '提交', { type: 'submit', className: 'go' }); submit.append(svg(ARROW));
  const pips = box('div', 'pips', ...items.map(() => el('i'))); pips.ariaHidden = 'true';
  form.append(list, box('div', 'sheet-foot', pips, submit));
  function refresh() { items.forEach((it, k) => pips.children[k].classList.toggle('on', it.value != null)); submit.disabled = items.some(i => i.value == null); }
  refresh();
  setPageKeys(e => {
    if (!/^Digit[1-9]$|^Numpad[1-9]$/.test(e.code) || e.target.matches?.('textarea,input[type=text]')) return;
    const scales = items.filter(i => i.phase !== 'PROBE');
    const target = scales.find(i => i.fs.contains(document.activeElement)) ?? scales.find(i => i.value == null);
    if (!target) return;
    const input = target.fs.querySelector(`input[value="${e.code.slice(-1)}"]`); input.checked = true; input.focus();
    input.dispatchEvent(new Event('change', { bubbles: true })); e.preventDefault();
    const nextItem = scales.find(i => i.value == null); // 键盘作答后自动移到下一题
    if (nextItem) { nextItem.fs.querySelector('input').focus({ preventScroll: true }); nextItem.fs.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    else submit.focus({ preventScroll: true });
  });
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (items.some(i => i.value == null)) return; submit.disabled = true;
    const at = performance.now();
    const payload = items.map(i => ({ phase: i.phase, answer: i.value, timing: { shown_at: shown, first_answered_at: i.first, last_changed_at: i.last, change_count: i.changes, submitted_at: at, time_origin: performance.timeOrigin } }));
    try { await api('answers', { items: payload }); await load(); }
    catch (error) { message(error.message, true); submit.disabled = false; }
  });
  main.append(form);
}

function renderTrackingBreak(view) {
  main.className = '';
  const practice = view.block.kind === 'practice', rest = box('section', 'rest', el('div', practice ? '练习完成' : '休息', { className: 'label' }));
  const total = Math.max(1, view.break_remaining_ms), until = performance.now() + view.break_remaining_ms;
  if (view.break_remaining_ms > 0) {
    const num = el('div', '', { className: 'big', ariaLive: 'off' }), bar = el('i'), line = box('div', 'line', bar);
    const tick = () => { const left = Math.max(0, until - performance.now()); num.textContent = pad(Math.ceil(left / 1000)); bar.style.transform = `scaleX(${left / total})`; };
    tick(); breakTimer = setInterval(tick, 250); rest.append(num, line);
  }
  const next = go('继续', async () => { await api('next', {}); await load(); });
  rest.append(next); main.append(rest);
}
function renderBreak(view) {
  if (isTracking(view)) { renderTrackingBreak(view); return; }
  const practice = view.block.kind === 'practice';
  const card = box('section', 'card narrow center');
  card.append(el('div', practice ? '练习完成' : '本段完成', { className: 'eyebrow' }), el('h1', practice ? '练习结束，接下来是正式任务' : '休息一下'));
  if (practice && lastPractice && !isTracking(view)) {
    const { hit, miss, fa } = lastPractice;
    card.append(box('div', 'stats',
      box('div', 'stat good', el('b', String(hit)), el('span', '按对了')),
      box('div', 'stat' + (miss ? ' warn' : ''), el('b', String(miss)), el('span', '漏按')),
      box('div', 'stat' + (fa ? ' warn' : ''), el('b', String(fa)), el('span', '多按'))));
    const advice = miss > fa ? '漏按偏多：只要当前和“前面第二个”相同就按，不必等完全确定。' : fa > miss ? '多按偏多：只有和“前面第二个”相同才按，和紧挨着的上一个相同不算。' : miss + fa === 0 ? '全部正确，节奏把握得很好。' : '整体不错，保持同样的节奏即可。';
    card.append(el('p', advice + ' 正式任务中不再提示对错。', { className: 'advice' }));
  } else card.append(el('p', practice ? isTracking(view) ? '准备好后继续追踪。' : '正式任务中不再提示对错。' : '放松眼睛和肩膀，准备好就继续。', { className: 'lead' }));
  const total = Math.max(1, view.break_remaining_ms), until = performance.now() + view.break_remaining_ms;
  const ring = box('div', 'break-ring', svg('<svg viewBox="0 0 160 160" aria-hidden="true"><circle class="track" cx="80" cy="80" r="72"/><circle class="bar" cx="80" cy="80" r="72"/></svg>'), box('b', '', el('span'), el('small', '秒')));
  const bar = ring.querySelector('.bar'), num = ring.querySelector('b span');
  const tick = () => { const left = Math.max(0, until - performance.now()); num.textContent = String(Math.ceil(left / 1000)); bar.style.strokeDashoffset = String(452.4 * (1 - left / total)); };
  if (view.break_remaining_ms > 0) { card.append(ring); tick(); breakTimer = setInterval(tick, 250); }
  card.append(box('div', 'actions', button(view.break_remaining_ms > 0 ? '准备好了，继续' : '继续', async () => { await api('next', {}); await load(); }, 'primary large')));
  main.append(card);
}

/* ---------- 运行 ---------- */
async function calibrateClock(r, phase) {
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const before = performance.now();
    const sample = await api('clock-sample', { owner: r.owner, attempt_id: r.attempt_id });
    const after = performance.now();
    samples.push({ sample_id: sample.sample_id, browser_before_ms: before, browser_after_ms: after });
  }
  return api('clock-calibration', { owner: r.owner, attempt_id: r.attempt_id, phase, samples, time_origin: performance.timeOrigin });
}
/* ---------- 追踪区尺寸 ---------- */
// 参考边长沿用原规则（决定鼠标→归一化位置的映射）；显示边长 = 参考 × display_scale，只放大画面。
function trackingGeometry(tracking) {
  const reference = Math.min(500, innerHeight - 210, innerWidth * 0.65), scale = Number(tracking?.display_scale ?? 1);
  return { reference, scale, display: reference * scale, fits: reference * scale <= Math.min(innerHeight, innerWidth) - 40 };
}

/* ---------- Pointer Lock ---------- */
// 必须在"开始"点击的同一手势内请求；锁定成功之前不创建尝试、不设定计时起点。
function acquirePointerLock() {
  return new Promise((resolve, reject) => {
    if (!main.requestPointerLock) { reject(new Error('当前浏览器不支持鼠标锁定，请使用 Chrome 或 Edge。')); return; }
    if (document.pointerLockElement === main) { resolve(); return; }
    const done = ok => { clearTimeout(timer); document.removeEventListener('pointerlockchange', onChange); document.removeEventListener('pointerlockerror', onError); ok ? resolve() : reject(new Error('鼠标锁定失败，任务未开始。请稍候一秒再点开始。')); };
    const onChange = () => { if (document.pointerLockElement === main) done(true); };
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), 2000);
    document.addEventListener('pointerlockchange', onChange); document.addEventListener('pointerlockerror', onError);
    try { const result = main.requestPointerLock(); if (result?.catch) result.catch(() => done(false)); } catch { done(false); }
  });
}
function releasePointerLock() { if (document.pointerLockElement) document.exitPointerLock(); }

async function begin() {
  if (!isTracking(current)) return beginRun();
  if (innerWidth < 1000 || innerHeight < 600) throw new Error('请在电脑上打开并放大窗口至至少1000×600，满足任务显示区域要求。');
  if (!trackingGeometry(current.tracking).fits) throw new Error('窗口放不下放大后的追踪区，请将浏览器全屏（⌃⌘F 或 F11）后再开始。');
  await acquirePointerLock();
  const lockedAt = performance.now();
  try { await beginRun(lockedAt); }
  catch (error) { if (!running) releasePointerLock(); throw error; }
  // 准备期间（上传、校准）若已丢失锁定，按中断处理，保留已创建的尝试记录。
  if (running && document.pointerLockElement !== main && !running.cancelled) lockLost(running, 'lost_during_setup');
}
async function beginRun(lockedAt = null) {
  if (innerWidth < 1000 || innerHeight < 600) throw new Error('请在电脑上打开并放大窗口至至少1000×600，满足任务显示区域要求。');
  const pending = readPending();
  if (pending?.events?.length) { await flush({ ...pending, queue: pending.events, uploading: null }); localStorage.removeItem(localKey); }
  if (isAuditory(current)) {
    if (!audioConfirmed) throw new Error('请先完成声音检查，再开始任务。');
    await prepareAudio(current); audioPlayer.stop();
  }
  const owner = uuid(); const plan = await api('start', { owner });
  if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
  const image = $('#notice-image'); image.hidden = true;
  $('#notice').classList.remove('with-image'); $('#notice-text').hidden = false;
  if (plan.mode !== 'rayneo' && plan.notification?.render_image) {
    try {
      const response = await fetch(endpoint + '/assets/' + encodeURIComponent(plan.notification.render_image), { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('卡片图片加载失败，本段尚未呈现刺激。');
      imageUrl = URL.createObjectURL(await response.blob()); image.src = imageUrl; await image.decode();
      image.alt = plan.notification.text_lines.join(' '); image.hidden = false;
      $('#notice-text').hidden = true; $('#notice').classList.add('with-image');
    } catch (error) { await api('interrupt', { owner }); rendered = ''; await load(); throw error; }
  }
  const practiceRun = plan.block.kind === 'practice';
  const cues = { ack_on_press: true, rhythm_ring: practiceRun, correctness_feedback: practiceRun, lead_in_countdown_ms: LEAD_IN_MS };
  const r = { ...plan, auditory: isAuditory(plan), owner, seq: 0, queue: [], uploading: null, index: -1, itemOnset: null, responded: false, visible: false, noticeOn: false, noticeDone: false, cancelled: false, finishing: false, start: performance.now() + LEAD_IN_MS, frame: 0, cues, tally: { hit: 0, miss: 0, fa: 0, cr: 0 }, pointerLockAt: lockedAt };
  if (r.mode === 'rayneo' && r.block.kind === 'notification') {
    message('正在校准眼镜与电脑时间', false);
    try {
      const result = await calibrateClock(r, 'pre');
      if (!result.verified) throw new Error('时钟往返误差过大，本段尚未开始，请检查连接后重试。');
    } catch (error) { await api('interrupt', { owner }); rendered = ''; await load(); throw error; }
    message('', false);
  }
  r.start = performance.now() + LEAD_IN_MS;
  const duration = isTracking(r) ? r.block.duration_ms : r.block.kind !== 'practice' && r.block.pre_ms != null && r.block.post_ms != null ? r.block.pre_ms + r.block.notification_ms + r.block.post_ms : r.block.letters.length * r.block.soa_ms;
  r.end = r.start + duration;
  running = r; persist(r);
  if (r.auditory) {
    try {
      const scheduled = audioPlayer.schedule(r.block.letters, r.block.soa_ms, r.start);
      r.audioItems = scheduled.items; r.audioMetadata = scheduled.metadata;
      r.start = r.audioItems[0].onset_performance_ms; r.end = r.start + duration;
      for (const item of r.audioItems) event(r, 'audio_scheduled', { index: item.index, symbol: item.symbol, audio_context_time: item.audio_context_time, planned_audio_time: item.audio_context_time, planned_at: item.onset_performance_ms, planned_offset: item.offset_performance_ms, audio_sha256: item.sha256, audio_schedule_evidence: scheduled.metadata });
    } catch (error) {
      event(r, 'audio_schedule_failed', { error: error.message }); audioPlayer.stop();
      await flush(r); await api('interrupt', { owner }); running = null; rendered = ''; await load(); throw error;
    }
  }
  if (isTracking(r)) {
    try { startTrackingRun(r); }
    catch (error) { event(r, 'tracking_render_failed', { error: error.message }); stopTracking(r); await flush(r); await api('interrupt', { owner }); running = null; rendered = ''; await load(); throw error; }
    return;
  }
  buildStage(r);
  event(r, 'run_start', { primary_modality: r.primary_modality ?? 'visual_letters', audio_output: r.auditory ? 'participant_desktop' : null, audio_metadata: r.audioMetadata ?? null, audio_hearing_confirmed: r.auditory ? audioConfirmed : null, time_origin: performance.timeOrigin, planned_start: r.start, stimulus_ms: r.block.stimulus_ms, soa_ms: r.block.soa_ms, history_across_notification: 'carry', viewport: { width: innerWidth, height: innerHeight }, source: r.mode === 'rayneo' ? 'browser_task' : 'browser_mock', pre_ms: r.block.pre_ms ?? r.block.baseline_count * r.block.soa_ms, notification_ms: r.block.notification_ms, post_ms: r.block.post_ms, post_early_ms: r.block.post_early_ms, visual_cues: r.cues });
  let lastCount = null;
  const showNext = now => {
    if (r.cancelled) return;
    try {
      if (now < r.start) {
        const c = Math.ceil((r.start - now) / 1000);
        if (c !== lastCount) { lastCount = c; r.countdown.firstChild.replaceWith(el('span', String(c))); }
      } else if (!r.countdown.hidden) { r.countdown.hidden = true; setTimeout(() => { if (running === r) r.legend.classList.add('dim'); }, 10000); }
      const b = r.block, notifyAt = r.start + (b.pre_ms ?? b.baseline_count * b.soa_ms), notifyOff = notifyAt + b.notification_ms;
      if (b.kind !== 'practice' && !r.noticeOn && now >= notifyAt) {
        r.noticeOn = true;
        if (b.kind === 'notification' && r.mode !== 'rayneo') { $('#notice-text').textContent = r.notification.text_lines.join('\n'); $('#notice').hidden = false; }
        event(r, b.kind === 'notification' ? r.mode === 'rayneo' ? 'notification_requested' : 'notification_onset' : 'sham_onset', { material_id: b.material_id, planned_at: notifyAt, source: r.mode === 'rayneo' ? 'browser_dispatch_intent' : 'browser_mock', line_count: r.notification?.line_count ?? r.notification?.text_lines.length ?? 0, n_count: r.notification?.n_count ?? null, render_image: r.notification?.render_image ?? null }, now);
        if (b.kind === 'notification' && r.mode === 'rayneo') {
          r.noticePromise = api('notice', { owner: r.owner, attempt_id: r.attempt_id }).then(receipt => {
            event(r, 'notification_request_result', { request_id: receipt.request_id, status: receipt.status, error: receipt.error });
            if (!['accepted', 'drawn', 'hidden'].includes(receipt.status)) message('眼镜显示结果待核查；主任务继续，异常已记录。');
          }).catch(error => { event(r, 'device_send_failed', { error: error.message }); message('眼镜通知发送异常；任务继续，异常已记录。'); });
        }
      }
      if (r.noticeOn && !r.noticeDone && now >= notifyOff) {
        r.noticeDone = true; hideNotice(); event(r, b.kind === 'notification' ? r.mode === 'rayneo' ? 'notification_planned_offset' : 'notification_offset' : 'sham_offset', { planned_at: notifyOff, source: r.mode === 'rayneo' ? 'planned_only' : 'browser_mock', reason: 'configured_duration' }, now);
      }
      if (now >= r.end && r.index >= 0) {
        if (r.index < b.letters.length - 1) { event(r, 'timing_gap', { reason: 'unpresented_final_stimulus', from_index: r.index + 1 }, now); failTiming(r); return; }
        if (now - r.end > 100) event(r, 'timing_gap', { reason: 'late_trial_end', late_ms: now - r.end }, now);
        closeItem(r, now); finishRun(r, now); return;
      }
      const next = Math.floor((now - r.start) / b.soa_ms);
      if (next > r.index) {
        if (next > r.index + 1) { event(r, 'timing_gap', { skipped_from: r.index + 1, skipped_to: next - 1 }, now); failTiming(r); return; }
        if (r.index >= 0) closeItem(r, now);
        if (next >= b.letters.length) { finishRun(r, now); return; }
        r.index = next; r.responded = false; r.visible = true;
        const planned = r.start + next * b.soa_ms;
        if (now - planned > 100) event(r, 'timing_gap', { index: next, late_ms: now - planned }, now);
        const item = r.audioItems?.[next];
        r.letter.textContent = r.auditory ? '+' : b.letters[next]; r.itemOnset = item?.onset_performance_ms ?? now;
        if (r.cues.rhythm_ring) restartRhythm(r, now - planned);
        event(r, 'stimulus_onset', { index: next, letter: b.letters[next], symbol: b.letters[next], primary_modality: r.primary_modality ?? 'visual_letters', planned_at: planned, target: next >= 2 && b.letters[next] === b.letters[next - 2], observed_at: now, audio_context_time: item?.audio_context_time ?? null, audio_sha256: item?.sha256 ?? null, audio_schedule_evidence: r.audioMetadata ?? null, acoustic_onset_verified: false }, r.itemOnset);
      }
      if (r.visible && now >= r.start + r.index * b.soa_ms + b.stimulus_ms) {
        r.letter.textContent = r.auditory ? '+' : ''; r.visible = false;
        event(r, 'stimulus_offset', { index: r.index, planned_at: r.start + r.index * b.soa_ms + b.stimulus_ms, observed_at: now, source: r.auditory ? 'audio_software_schedule' : 'browser_visual' }, r.audioItems?.[r.index]?.offset_performance_ms ?? now);
      }
      r.frame = requestAnimationFrame(showNext);
    } catch (error) { r.cancelled = true; audioPlayer.stop(); hideNotice(); r.letter.textContent = ''; message(error.message + ' 请联系主试中断并保留数据。'); }
  };
  r.frame = requestAnimationFrame(showNext);
}

function flushTrackingInputs(r, at) {
  while (r.pendingInputs?.length) event(r, 'tracking_input', { samples: r.pendingInputs.splice(0, 20) }, at);
}
function stopTracking(r) { r.tracker?.stop(); if (isTracking(r)) releasePointerLock(); }
// 运行中丢失锁定（Esc、失焦、切换窗口）：记录原因后中断本次尝试，原始事件全部保留。
function lockLost(r, reason) {
  if (!r || r !== running || r.cancelled || r.finishing || !isTracking(r)) return;
  try { event(r, 'pointer_lock_lost', { reason, observed_at: performance.now(), started: performance.now() >= r.start }); } catch {}
  interruptRun(r, reason).then(() => { if (!running) message('鼠标锁定已解除，本段已中断并保留记录。点击开始可重新进行。', true); });
}
document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement !== main) lockLost(running, 'pointer_lock_exited'); });
document.addEventListener('mousemove', e => {
  const r = running;
  if (!r?.tracker || r.cancelled || r.finishing || document.pointerLockElement !== main) return;
  const now = performance.now(); if (now < r.start || now >= r.end) return;
  try {
    // 相对位移直接进入原有 move()：增益与坐标归一化规则不变。
    const input = r.tracker.move({ movementX: e.movementX, movementY: e.movementY, timeStamp: e.timeStamp });
    if (input) { r.pendingInputs.push(input); if (r.cue && (e.movementX || e.movementY)) { r.cue.classList.add('gone'); r.cue = null; } }
  } catch (error) { event(r, 'tracking_render_failed', { error: error.message }); failTiming(r); }
});
function startTrackingRun(r) {
  document.body.classList.add('running'); main.className = 'tracking-running';
  const practice = r.block.kind === 'practice';
  const canvas = el('canvas', null, { className: 'tracking-canvas', ariaLabel: '动态补偿追踪画布' });
  const countdown = box('div', 'count', el('span', String(LEAD_IN_MS / 1000)));
  const field = box('div', 'field tracking-field pre', canvas, countdown);
  const geometry = trackingGeometry(r.tracking);
  field.style.width = field.style.height = `${geometry.display}px`;
  // 鼠标已锁定、光标隐藏：中断只能通过 Esc（锁定解除即中断），不再放置屏幕按钮。
  const cue = practice ? box('div', 'drag-cue', el('div', null, { className: 'mouse', ariaHidden: 'true' })) : null;
  main.replaceChildren(...[field, cue].filter(Boolean));
  r.canvas = canvas; r.field = field; r.cue = cue; r.letter = el('span', ''); r.countdown = countdown; r.pendingInputs = [];
  // 表现层参数：画布底色与页面同色，使画布"消失"，只留角标定义边界。
  const look = { background: '#f4f3ef', target_color: '#8f8c83', cursor_color: '#121212', within_color: '#121212', highlight_within: practice, center_mark: true };
  // 画布有 1px 透明边框：参考可用宽度 = 参考边长 − 2，与旧版 clientWidth 完全一致。
  r.tracker = new TrackingTask(canvas, { ...r.tracking, ...look, input_reference_width: geometry.reference - 2, input_reference_height: geometry.reference - 2 }, r.block.tracking_seed);
  r.tracker.begin(r.start); r.lastSample = null; r.nextSample = r.start; r.lastFrame = null;
  r.tracker.advance(r.start, false); // 倒计时期间预先画出起始画面（仅绘制，不记录、不消耗输入）
  event(r, 'run_start', { time_origin: performance.timeOrigin, planned_start: r.start, planned_end: r.end, primary_modality: r.primary_modality, tracking: r.tracking, tracking_seed: r.block.tracking_seed, input_source: 'mouse_relative_pointer_lock', pointer_lock: { acquired_at: r.pointerLockAt, element: 'main', unadjusted_movement: false }, viewport: { width: innerWidth, height: innerHeight }, visual_cues: { lead_in_countdown_ms: LEAD_IN_MS, within_target_highlight: practice, move_cue: practice, presentation: look }, geometry: { reference_side_css_px: geometry.reference, display_scale: geometry.scale, display_side_css_px: geometry.display, canvas_client_width_css_px: canvas.clientWidth, input_reference_css_px: geometry.reference - 2 } });
  let lastCount;
  const frame = now => {
    if (r.cancelled || r.finishing) return;
    try {
      if (now < r.start) {
        const count = Math.ceil((r.start - now) / 1000); if (count !== lastCount) { countdown.firstChild.replaceWith(el('span', String(count))); lastCount = count; }
        r.frame = requestAnimationFrame(frame); return;
      }
      if (!countdown.hidden) { countdown.hidden = true; field.classList.remove('pre'); }
      if (r.lastSample === null) { event(r, 'tracking_started', { planned_at: r.start, observed_at: now, tracking_seed: r.block.tracking_seed }, r.start); }
      if ((r.lastFrame !== null && now - r.lastFrame >= 200) || (r.lastFrame === null && now - r.start > 100)) {
        event(r, 'timing_gap', { reason: 'tracking_frame_gap', gap_ms: r.lastFrame === null ? now - r.start : now - r.lastFrame }, now); failTiming(r); return;
      }
      r.lastFrame = now;
      const b = r.block, notifyAt = r.start + b.pre_ms, notifyOff = notifyAt + b.notification_ms;
      if (b.kind !== 'practice' && !r.noticeOn && now >= notifyAt) {
        r.noticeOn = true;
        if (b.kind === 'notification' && r.mode !== 'rayneo') { $('#notice-text').textContent = r.notification.text_lines.join('\n'); $('#notice').hidden = false; }
        event(r, b.kind === 'notification' ? r.mode === 'rayneo' ? 'notification_requested' : 'notification_onset' : 'sham_onset', { material_id: b.material_id, planned_at: notifyAt, source: r.mode === 'rayneo' ? 'browser_dispatch_intent' : 'browser_mock' }, now);
        if (b.kind === 'notification' && r.mode === 'rayneo') r.noticePromise = api('notice', { owner: r.owner, attempt_id: r.attempt_id }).then(receipt => { event(r, 'notification_request_result', { request_id: receipt.request_id, status: receipt.status, error: receipt.error }); if (!['accepted', 'drawn', 'hidden'].includes(receipt.status)) message('眼镜通知结果待核查。', true); }).catch(error => { event(r, 'device_send_failed', { error: error.message }); message('眼镜通知发送异常。', true); });
      }
      if (r.noticeOn && !r.noticeDone && now >= notifyOff) { r.noticeDone = true; hideNotice(); event(r, b.kind === 'notification' ? r.mode === 'rayneo' ? 'notification_planned_offset' : 'notification_offset' : 'sham_offset', { planned_at: notifyOff, reason: 'configured_duration' }, now); }
      const final = now >= r.end;
      if (final && now - r.end > 100) { event(r, 'timing_gap', { reason: 'late_tracking_end', late_ms: now - r.end }, now); failTiming(r); return; }
      const sampleAt = final ? r.end : now;
      const emit = final || r.lastSample === null || sampleAt >= r.nextSample;
      if (emit) { do { r.nextSample += Number(r.tracking.sample_interval_ms); } while (r.nextSample <= sampleAt); }
      const sample = r.tracker.advance(sampleAt, emit);
      if (emit) { flushTrackingInputs(r, sampleAt); event(r, 'tracking_sample', { ...sample, observed_at: now }, sampleAt); r.lastSample = sampleAt; }
      if (final) {
        event(r, 'tracking_ended', { observed_at: now, elapsed_ms: b.duration_ms }, r.end); stopTracking(r); finishRun(r, r.end); return;
      }
      r.frame = requestAnimationFrame(frame);
    } catch (error) { event(r, 'tracking_render_failed', { error: error.message }); failTiming(r); }
  };
  r.frame = requestAnimationFrame(frame);
}

function buildStage(r) {
  document.body.classList.add('running'); main.className = 'task-running';
  const ring = svg(`<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-track" cx="60" cy="60" r="54"/>${r.cues.rhythm_ring ? '<circle class="ring-rhythm" cx="60" cy="60" r="54"/>' : ''}<circle class="ring-ack" cx="60" cy="60" r="54"/></svg>`);
  const letter = el('div', r.auditory ? '+' : '', { className: 'letter' + (r.auditory ? ' cross' : ''), ariaLabel: r.auditory ? '保持注视，听数字' : '当前字母' });
  const fixation = box('div', 'fixation', ring, letter);
  const countdown = box('div', 'countdown', el('span', String(LEAD_IN_MS / 1000)), el('small', r.block.kind === 'practice' ? '练习即将开始' : '即将开始'));
  const practice = el('div', '', { className: 'practice-feedback', ariaLive: 'polite' });
  const legend = box('div', 'key-legend', keys(r.auditory ? '与前面第二个相同时按' : '与前面第二个相同时按'));
  const stop = el('button', '按住 1.5 秒中断本段', { className: 'hold-interrupt', type: 'button' }); stop.dataset.control = 'true';
  let holdTimer;
  const cancelHold = () => { clearTimeout(holdTimer); stop.classList.remove('holding'); };
  stop.addEventListener('pointerdown', e => { e.stopPropagation(); stop.classList.add('holding'); holdTimer = setTimeout(() => { cancelHold(); interruptRun(r); }, 1500); });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) stop.addEventListener(type, cancelHold);
  stop.addEventListener('keydown', e => { if (e.code === 'Space') e.stopPropagation(); });
  main.replaceChildren(fixation, practice, legend, stop, countdown);
  Object.assign(r, { letter, fixation, practice, legend, countdown, rhythm: ring.querySelector('.ring-rhythm') });
}
function restartRhythm(r, lateMs) {
  const c = r.rhythm; if (!c) return;
  c.style.animation = 'none'; void c.getBoundingClientRect();
  c.style.animation = `rhythm ${r.block.soa_ms}ms linear ${-Math.max(0, lateMs)}ms forwards`;
}
function pulse(node, className, ms) { node.classList.remove(className); void node.offsetWidth; node.classList.add(className); clearTimeout(node[`_${className}`]); node[`_${className}`] = setTimeout(() => node.classList.remove(className), ms); }

function closeItem(r, at) {
  if (r.visible) { event(r, 'stimulus_offset', { index: r.index, late: true, observed_at: at }, r.audioItems?.[r.index]?.offset_performance_ms ?? at); r.visible = false; }
  const end = r.auditory ? Math.min(r.start + (r.index + 1) * r.block.soa_ms, r.end) : at;
  event(r, 'item_end', { index: r.index, observed_at: at, partial_response_window: r.end < r.start + (r.index + 1) * r.block.soa_ms - 0.5 }, end);
  if (r.block.kind === 'practice' && r.index >= 2) {
    const target = r.block.letters[r.index] === r.block.letters[r.index - 2];
    const kind = target ? (r.responded ? 'hit' : 'miss') : (r.responded ? 'fa' : 'cr'); r.tally[kind]++;
    const fb = { hit: ['good', '✓ 对了'], miss: ['warn', '刚才那个相同，可以按'], fa: ['warn', '刚才那个不同，不用按'] }[kind];
    if (fb) { r.practice.className = `practice-feedback ${fb[0]}`; r.practice.textContent = fb[1]; pulse(r.fixation, fb[0] === 'good' ? 'fb-good' : 'fb-warn', 700); }
    else { r.practice.className = 'practice-feedback'; r.practice.textContent = ''; }
  }
}
function respond(source, repeat = false) {
  const r = running; if (!r || isTracking(r) || r.cancelled || r.finishing) return;
  const at = performance.now(), before = r.index < 0, late = r.index >= 0 && at >= r.start + (r.index + 1) * r.block.soa_ms;
  const accepted = !before && !late && r.index >= 2 && !repeat && !r.responded;
  event(r, 'response', { index: r.index, source, repeat, accepted, reason: before ? 'before_start' : late ? 'outside_item_window' : r.index < 2 ? 'warmup' : repeat ? 'held_key' : r.responded ? 'extra_response' : 'first_response' }, at);
  if (accepted) r.responded = true;
  // 按键确认：与对错无关，只表示“收到了”。
  if (!before && !repeat && r.cues.ack_on_press) pulse(r.fixation, 'ack', 340);
}
document.addEventListener('keydown', e => { if (e.code !== 'Space' || !running || running.finishing || running.cancelled) return; e.preventDefault(); try { respond('space', e.repeat); } catch (error) { message(error.message); } });
document.addEventListener('pointerdown', e => { if (e.button !== 0 || e.pointerType !== 'mouse' || e.target.closest('[data-control]')) return; try { respond('mouse_left'); } catch (error) { message(error.message); } });
addEventListener('blur', () => { if (running && !running.finishing && !running.cancelled) { try { event(running, 'window_blur'); } catch {} lockLost(running, 'window_blur'); } });
document.addEventListener('visibilitychange', () => { if (running && !running.finishing && !running.cancelled) { try { event(running, document.hidden ? 'visibility_hidden' : 'visibility_visible'); } catch {} if (document.hidden) lockLost(running, 'visibility_hidden'); } });
addEventListener('resize', () => { if (running && !running.finishing && !running.cancelled) try { event(running, 'viewport_changed', { width: innerWidth, height: innerHeight }); if (innerWidth < 1000 || innerHeight < 600) { event(running, 'timing_gap', { reason: 'viewport_too_small' }); failTiming(running); } } catch {} });
async function failTiming(r) { r.cancelled = true; stopTracking(r); audioPlayer.stop(); r.letter.textContent = ''; hideNotice(); message('任务时序被打断，请中断本段后重新开始；原始记录保留。', true); }
async function interruptRun(r, reason = 'participant') {
  if (r.interrupting) return; r.interrupting = true;
  r.cancelled = true; if (isTracking(r)) { flushTrackingInputs(r, performance.now()); event(r, 'tracking_interrupted', { reason }); } stopTracking(r); audioPlayer.stop(); cancelAnimationFrame(r.frame); hideNotice(); r.letter.textContent = '';
  try { await flush(r); await api('interrupt', { owner: r.owner }); localStorage.removeItem(localKey); running = null; rendered = ''; await load(); }
  catch (error) { r.interrupting = false; message(`中断未完成：${error.message}。本地记录保留，请重试。`, true); }
}
async function finishRun(r, now) {
  r.finishing = true; stopTracking(r); audioPlayer.stop(); hideNotice(); r.letter.textContent = ''; event(r, 'run_end', { planned_at: r.end }, now);
  if (r.block.kind === 'practice' && !isTracking(r)) lastPractice = { ...r.tally };
  document.body.classList.remove('running');
  main.className = ''; main.replaceChildren(box('section', 'rest', el('div', '保存中', { className: 'label' }), box('div', 'saving', el('i'))));
  const commit = async () => {
    await r.noticePromise;
    if (r.mode === 'rayneo' && r.block.kind === 'notification' && !r.clockPostDone) {
      try { await calibrateClock(r, 'post'); }
      catch (error) { event(r, 'device_clock_calibration_failed', { phase: 'post', error: error.message }); }
      r.clockPostDone = true;
    }
    await flush(r); await api('finish', { owner: r.owner }); localStorage.removeItem(localKey); running = null; rendered = ''; await load(); };
  try { await commit(); } catch (error) { message(error.message, true); main.firstChild.append(el('p', '事件仍保存在本机，请保持页面，恢复网络后重试。', { className: 'lead' }), box('div', 'actions', button('重试保存', commit))); }
}
addEventListener('pagehide', () => { audioPlayer.stop(); if (running && isTracking(running)) { flushTrackingInputs(running, performance.now()); event(running, 'tracking_interrupted', { reason: 'pagehide' }); stopTracking(running); } });
setInterval(() => { if (running?.queue.length && !running.uploading) flush(running).catch(error => { message(`尚未同步：${error.message}；本地记录已保留。`, true); }); }, 500);
setInterval(async () => {
  if (pollBusy) return; pollBusy = true;
  try {
    const view = await api();
    if (running && (view.phase === 'ABORTED' || view.phase === 'READY' && view.attempt_id !== running.attempt_id)) {
      running.cancelled = true; if (isTracking(running)) { flushTrackingInputs(running, performance.now()); event(running, 'tracking_interrupted', { reason: 'admin_interrupt' }); } stopTracking(running); audioPlayer.stop(); cancelAnimationFrame(running.frame); hideNotice(); running.letter.textContent = ''; running = null; rendered = '';
      message('主试已中断本段；本地未上传事件保留。请联系主试后再开始。', true);
    }
    current = view; render(view);
  } catch (error) { message(error.message, true); } finally { pollBusy = false; }
}, 1500);
if (!session || !token) main.append(box('section', 'card narrow', el('h1', '请从主试后台打开被试入口')));
else load().catch(error => main.append(box('section', 'card narrow', el('h1', '无法打开会话'), el('p', error.message, { className: 'lead' }))));
