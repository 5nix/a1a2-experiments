import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import qrcode from 'qrcode-generator';
import { Store, HttpError, type ClientEvent } from './store.ts';
import { Engine } from './engine.ts';
import { buildPlan, checkMaterials, type Material, type PlanOptions, type AudioManifest } from './protocol.ts';
import { bundle, analyze } from './export.ts';
import { lanAddresses } from '../../scripts/network.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { DeviceControl } from './device-control.ts';
import { calibration, type ClockSample } from './clock-mapping.ts';

const root = resolve(import.meta.dirname, '..'), port = Number(process.env.PORT ?? 5189);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效。');
const materials = JSON.parse(await readFile(join(root, 'content/materials.json'), 'utf8')) as Material[];
const materialManifest = JSON.parse(await readFile(join(root, 'content/materials.manifest.json'), 'utf8')) as { material_version: string };
if (materials.some(m => m.material_version !== materialManifest.material_version)) throw new Error('材料与版本清单不一致，请重新导入。');
const audioManifest = JSON.parse(await readFile(join(root, 'public/audio/digits/manifest.json'), 'utf8')) as AudioManifest;
for (const clip of audioManifest.clips) {
  if (!/^\/audio\/digits\/[1-9]\.wav$/.test(clip.url) || createHash('sha256').update(await readFile(join(root, 'public', clip.url))).digest('hex') !== clip.sha256) throw new Error('听觉数字录音与清单不一致，请重新生成资源。');
}
const runtime = resolve(process.env.A1_RUNTIME_DIR ?? join(root, 'runtime'));
const exportsRoot = resolve(process.env.A1_EXPORT_DIR ?? join(root, 'exports'));
await mkdir(runtime, { recursive: true });
const store = new Store(join(runtime, 'experiment.sqlite')), engine = new Engine(store);
const device = new DeviceControl(store, join(root, 'content/assets/notifications'), { serial: process.env.A1_RAYNEO_SERIAL, adb: process.env.A1_ADB_PATH ?? process.env.A5_ADB_PATH, scrcpy: process.env.A1_SCRCPY_PATH ?? process.env.A5_SCRCPY_PATH, hostEnabled: process.env.A1_HOST_MODE !== 'off' });
const deviceTicker = setInterval(() => device.tick(), 250); deviceTicker.unref();
store.db.exec('CREATE TABLE IF NOT EXISTS clock_samples(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
function requestedPlan(input: Record<string, unknown>) {
  const participant = input.participant_id, preset = input.preset ?? 'sop', seed = Number(input.seed);
  if (typeof participant !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(participant)) throw new HttpError(422, '编号使用1—40位字母、数字、下划线或连字符。');
  if (!['quick', 'sop', 'pool'].includes(String(preset)) || !Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295 || !['round1', 'round2'].includes(String(input.pilot_round))) throw new HttpError(422, '预设、轮次或随机种子无效。');
  const delivery = input.delivery_mode ?? 'mock';
  if (delivery !== 'mock' && delivery !== 'rayneo') throw new HttpError(422, '呈现设备无效。');
  if (input.primary_modality !== undefined && input.primary_modality !== 'compensatory_tracking') throw new HttpError(422, 'A1新会话使用动态补偿追踪；旧会话保持原快照。');
  const timing = input.timing;
  if (timing !== undefined && (!timing || typeof timing !== 'object' || Array.isArray(timing))) throw new HttpError(422, '时序配置无效。');
  const allowed = ['notification_ms', 'soa_ms', 'stimulus_ms', 'pre_ms', 'post_ms', 'post_early_ms', 'break_ms', 'practice_break_ms'];
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(timing ?? {})) {
    if (!allowed.includes(key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 300000) throw new HttpError(422, '时序参数必须是有效的毫秒整数。');
    normalized[key] = value;
  }
  if (normalized.notification_ms !== undefined && (normalized.notification_ms < 1000 || normalized.notification_ms > 15000)) throw new HttpError(422, '通知时长范围1000—15000ms。');
  if (normalized.soa_ms !== undefined && (normalized.soa_ms < 500 || normalized.soa_ms > 10000)) throw new HttpError(422, 'SOA范围500—10000ms。');
  const tracking: Record<string, number> = {};
  if (input.tracking !== undefined && (!input.tracking || typeof input.tracking !== 'object' || Array.isArray(input.tracking))) throw new HttpError(422, '追踪配置无效。');
  const bounds: Record<string, [number, number]> = { disturbance_rms: [.01, .5], disturbance_hz: [.03, 1], input_gain: [.1, 3], target_radius: [.02, .3], cursor_radius: [.005, .1], display_scale: [1, 2.5], sample_interval_ms: [50, 50], practice_ms: [1000, 120000] };
  for (const [key, value] of Object.entries(input.tracking ?? {})) {
    const bound = bounds[key];
    if (!bound || typeof value !== 'number' || !Number.isFinite(value) || value < bound[0] || value > bound[1]) throw new HttpError(422, '追踪参数超出允许范围。');
    tracking[key] = value;
  }
  if (input.allocation_index !== undefined && (!Number.isSafeInteger(input.allocation_index) || Number(input.allocation_index) < 0)) throw new HttpError(422, '分配序号无效。');
  try { return buildPlan(materials, String(preset), seed, String(input.pilot_round), delivery, delivery === 'rayneo' ? device.adapter.getStatus().device_id : undefined, { participant_id: participant, timing: normalized, allocation_index: input.allocation_index, primary_modality: 'compensatory_tracking', tracking, debug: input.debug === true } as PlanOptions); }
  catch (error) { throw new HttpError(422, error instanceof Error ? error.message : '配置无效。'); }
}
async function body(request: import('node:http').IncomingMessage) {
  let text = ''; for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 256000) throw new HttpError(413, '请求过大。'); }
  try { return JSON.parse(text || '{}') as Record<string, unknown>; } catch { throw new HttpError(400, 'JSON无效。'); }
}
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = createServer(async (request, response) => {
  const json = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  try {
    const url = new URL(request.url ?? '/', 'http://localhost'), path = url.pathname, method = request.method ?? 'GET';
    if (closing) throw new HttpError(503, '实验系统正在关闭。');
    if (method === 'POST' && path === '/api/admin/shutdown') {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json' || request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) throw new HttpError(403, '请从实验后台退出。');
      await body(request);
      response.once('finish', shutdown);
      json({ closing: true }); return;
    }
    const staticFiles: Record<string, string> = { '/': 'admin.html', '/admin': 'admin.html', '/experiment': 'experiment.html', '/admin.js': 'admin.js', '/experiment.js': 'experiment.js', '/auditory-player.js': 'auditory-player.js', '/tracking-task.js': 'tracking-task.js', '/app.css': 'app.css', '/participant.css': 'participant.css' };
    if (method === 'GET' && /^\/audio\/digits\/[1-9]\.wav$/.test(path)) { response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(await readFile(join(root, 'public', path))); return; }
    if (method === 'GET' && staticFiles[path]) { const file = staticFiles[path]; response.writeHead(200, { 'Content-Type': types[file.slice(file.lastIndexOf('.'))] }); response.end(await readFile(join(root, 'public', file))); return; }
    if (method === 'GET' && path === '/api/health') { json({ ok: true, experiment_id: 'a1-notification-pilot', default_mode: 'mock', primary_modality: 'compensatory_tracking', adapter: device.adapter.getStatus(), synthetic: materials.every(m => m.synthetic !== false), material_count: materials.length }); return; }
    if (method === 'GET' && path === '/api/admin/device/records') { response.setHeader('Content-Disposition', 'attachment; filename="a1-device-records.json"'); json({ records: device.records(), audit: device.status().audit }); return; }
    if (method === 'GET' && path === '/api/admin/materials') { json({ version: materialManifest.material_version, count: materials.length, levels: [1, 2, 3].map(n => ({ n, count: materials.filter(m => m.n_count === n).length })), warnings: materials.filter(m => m.source_warnings?.length).map(m => ({ id: m.id, warnings: m.source_warnings })), precheck: checkMaterials(materials) }); return; }
    if (method === 'POST' && path === '/api/admin/preview') { const plan = requestedPlan(await body(request)); json({ plan, material_precheck: plan.material_precheck }); return; }
    if (method === 'GET' && path === '/api/admin/device') { json(device.status()); return; }
    if (method === 'GET' && path === '/api/admin/device/apk') {
      let bytes;
      try { bytes = await readFile(join(root, 'rayneo-display/app/build/outputs/apk/debug/app-debug.apk')); } catch { throw new HttpError(404, 'APK尚未构建，请按设备说明运行assembleDebug。'); }
      response.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="a1-rayneo-images-0.2.0.apk"' }); response.end(bytes); return;
    }
    if (method === 'GET' && path === '/api/admin/device/list') { json({ devices: await device.devices() }); return; }
    if (method === 'POST' && path === '/api/admin/device/config') { const input = await body(request); json(await device.configure(String(input.serial ?? ''))); return; }
    if (method === 'POST' && path === '/api/admin/device/control') { const input = await body(request); json(await device.action(String(input.action), input.enabled as boolean | undefined)); return; }
    if (method === 'GET' && path === '/api/admin/device/materials') { json({ materials: materials.map(({ id, source_label, text_lines, render_image, n_count, line_count }) => ({ id, source_label, text_lines, render_image, n_count, line_count })) }); return; }
    const preview = /^\/api\/admin\/device\/images\/([123]N-[12]L-\d{2}\.png)$/.exec(path);
    if (method === 'GET' && preview && materials.some(m => m.render_image === preview[1])) { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(await readFile(join(root, 'content/assets/notifications', preview[1]))); return; }
    if (method === 'POST' && path === '/api/admin/device/notify') {
      const input = await body(request), material = materials.find(m => m.id === input.material_id);
      if (!material) throw new HttpError(422, '请选择材料库中的通知图片。');
      json(await device.manual(material, String(input.request_id ?? ''), Number(input.duration_ms))); return;
    }
    if (method === 'GET' && path === '/api/admin/network') { json({ addresses: lanAddresses(port), local_url: `http://127.0.0.1:${port}` }); return; }
    if (method === 'GET' && path === '/api/admin/qr') {
      const text = url.searchParams.get('text') ?? ''; if (!/^https?:\/\//.test(text) || text.length > 1000) throw new HttpError(422, '地址无效。');
      const qr = qrcode(0, 'M'); qr.addData(text); qr.make(); response.writeHead(200, { 'Content-Type': 'image/svg+xml' }); response.end(qr.createSvgTag({ scalable: true, margin: 4 })); return;
    }
    if (path === '/api/admin/sessions') {
      if (method === 'GET') { json({ sessions: store.all().map(s => ({ ...engine.view(s), participant_url: store.entry(s.id) })), deleted_sessions: store.all(true).filter(s => s.deleted_at).map(s => ({ id: s.id, participant_id: s.participant_id, deleted_at: s.deleted_at })) }); return; }
      if (method === 'POST') {
        const input = await body(request), plan = requestedPlan(input), participant = String(input.participant_id), delivery = plan.delivery_mode;
        if (delivery === 'rayneo') {
          if (!device.status().image_ready) throw new HttpError(409, '请先在准备与检查连接A1图片显示端。');
          if (store.all().some(s => s.snapshot.delivery_mode === 'rayneo' && !['COMPLETED', 'ABORTED'].includes(s.phase))) throw new HttpError(409, '同一副眼镜已有未结束的真机会话。');
        }
        const created = store.create(participant, plan);
        json(created, 201); return;
      }
    }
    if (method === 'GET' && path === '/api/admin/export') {
      const id = url.searchParams.get('session_id'), sessions = id ? [store.get(id)] : store.all(), bytes = bundle(store, sessions);
      const name = `a1-${Date.now()}.zip`; await mkdir(exportsRoot, { recursive: true }); await writeFile(join(exportsRoot, name), bytes);
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` }); response.end(bytes); return;
    }
    const admin = /^\/api\/admin\/sessions\/([a-f0-9-]+)(?:\/(stop|interrupt|notes|delete|restore))?$/.exec(path);
    if (admin) {
      if (method === 'POST' && ['delete', 'restore'].includes(admin[2])) {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json' || request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) throw new HttpError(403, '请从实验后台操作。');
        await body(request);
        if (admin[2] === 'delete') store.deleteSession(admin[1]); else store.restoreSession(admin[1]);
        json({ saved: true }); return;
      }
      const s = store.get(admin[1]);
      if (method === 'GET' && !admin[2]) { const a = analyze(store, s); json({ ...engine.view(s), material_outdated: s.snapshot.material_version !== materialManifest.material_version, summaries: a.summaries, pooled_summaries: a.pooled_summaries, tracking_samples: a.tracking_samples, tracking_summary: a.tracking_summary, tracking_recovery: a.tracking_recovery, plan: s.snapshot, sequence_balance: s.snapshot.sequence_check, attempts: a.attempts, recent_events: a.events.slice(-20) }); return; }
      if (method === 'POST') {
        const input = await body(request), reason = typeof input.reason === 'string' ? input.reason.slice(0, 4000) : '';
        if (admin[2] === 'notes') { store.log(s.id, s.attempt_id, 'note_saved', { text: reason }); json({ saved: true }); return; }
        if (['COMPLETED', 'ABORTED'].includes(s.phase)) throw new HttpError(409, '会话已结束。');
        if (admin[2] === 'stop' || admin[2] === 'interrupt' && s.phase === 'RUNNING') { json(engine.interrupt(s, reason, admin[2] === 'stop')); return; }
      }
    }
    const imagePath = /^\/api\/participant\/sessions\/([a-f0-9-]+)\/assets\/([123]N-[12]L-\d{2}\.png)$/.exec(path);
    if (method === 'GET' && imagePath) {
      const s = store.auth(imagePath[1], request.headers.authorization?.replace(/^Bearer /, '') ?? '');
      const material = s.snapshot.materials.find(m => m.id === s.snapshot.blocks[s.index]?.material_id);
      if (s.phase !== 'RUNNING' || material?.render_image !== imagePath[2]) throw new HttpError(403, '当前任务不能读取此卡片。');
      const bytes = await readFile(join(root, 'content/assets/notifications', imagePath[2]));
      if (createHash('sha256').update(bytes).digest('hex') !== material.image_sha256) throw new HttpError(409, '卡片图片与会话快照不一致，请保留记录并重新创建会话。');
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(bytes); return;
    }
    const participant = /^\/api\/participant\/sessions\/([a-f0-9-]+)(?:\/(start|notice|clock-sample|clock-calibration|events|finish|answer|answers|next|jump|interrupt))?$/.exec(path);
    if (participant) {
      const s = store.auth(participant[1], request.headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (method === 'GET' && !participant[2]) { json(engine.view(s)); return; }
      if (method === 'POST') {
        const input = await body(request), action = participant[2];
        if (action === 'clock-sample' || action === 'clock-calibration') {
          if (s.phase !== 'RUNNING' || s.snapshot.delivery_mode !== 'rayneo' || input.attempt_id !== s.attempt_id) throw new HttpError(409, '校准不属于当前真机尝试。');
          store.requireOwner(s, input.owner);
          if (action === 'clock-sample') {
            if (!device.adapter.clockSample || device.adapter.getStatus().device_id !== s.snapshot.device_id) throw new HttpError(409, '当前图片端不支持时钟校准，请更新A1 APK。');
            const before = performance.now(), sample = await device.adapter.clockSample(), after = performance.now();
            const value = { ...sample, sample_id: randomUUID(), attempt_id: s.attempt_id, session_id: s.id, owner: input.owner, issued_at: Date.now(), server_rtt_ms: after - before };
            store.db.prepare('INSERT INTO clock_samples VALUES (?,?)').run(value.sample_id, JSON.stringify(value));
            json(value); return;
          }
          if (!['pre', 'post'].includes(String(input.phase)) || !Array.isArray(input.samples) || input.samples.length !== 7 || !Number.isFinite(input.time_origin)) throw new HttpError(422, '时钟校准需要7个样本及浏览器时间源。');
          const seen = new Set<string>();
          const samples = input.samples.map((raw: Record<string, unknown>) => {
            const row = store.db.prepare('SELECT data FROM clock_samples WHERE id=?').get(String(raw.sample_id)) as { data: string } | undefined;
            if (!row || seen.has(String(raw.sample_id))) throw new HttpError(422, '时钟样本不存在或重复。');
            seen.add(String(raw.sample_id)); const sample = JSON.parse(row.data);
            const before = Number(raw.browser_before_ms), after = Number(raw.browser_after_ms);
            if (sample.session_id !== s.id || sample.attempt_id !== s.attempt_id || sample.owner !== input.owner || Date.now() - sample.issued_at > 60000 || !Number.isFinite(before) || !Number.isFinite(after) || after < before || after - before + 2 < sample.server_rtt_ms) throw new HttpError(422, '时钟样本绑定、有效期或往返时间无效。');
            return { sample_id: sample.sample_id, browser_before_ms: before, browser_after_ms: after, device_monotonic_ms: sample.device_monotonic_ms, clock_id: sample.clock_id } as ClockSample;
          });
          let result;
          try { result = calibration(input.phase as 'pre' | 'post', samples, Number(input.time_origin), typeof input.page_id === 'string' && input.page_id ? input.page_id.slice(0, 64) : null); } catch { throw new HttpError(422, '时钟采样无效。'); }
          const prior = store.events(s.id, s.attempt_id!).find(e => e.type === 'device_clock_calibration' && e.data.phase === input.phase);
          if (prior) { json(prior.data); return; }
          store.log(s.id, s.attempt_id, 'device_clock_calibration', result as unknown as Record<string, unknown>);
          if (input.phase === 'post') await device.poll();
          json(result); return;
        }
        if (action === 'events') { store.append(s, input.attempt_id, input.owner, input.events as ClientEvent[]); json({ saved: true }); return; }
        if (action === 'start') {
          if (s.phase === 'READY' && s.snapshot.material_version !== materialManifest.material_version) throw new HttpError(409, '此会话使用已替换的旧材料。请在后台结束旧会话并新建会话；历史数据仍可导出。');
          if (s.snapshot.delivery_mode === 'rayneo' && s.phase === 'READY') {
            const state = device.status();
            if (!state.image_ready || device.protected() || state.working || state.adapter.device_id !== s.snapshot.device_id) throw new HttpError(409, '绑定的图片显示端未就绪或正忙，不回退Mock。');
            const material = s.snapshot.materials.find(m => m.id === s.snapshot.blocks[s.index].material_id);
            if (material) await device.prepare(material);
          }
          // prepare期间可有主试操作，必须重新读取状态，不能用旧Session覆盖终止状态。
          json(engine.start(store.get(s.id), input.owner)); return;
        }
        if (action === 'notice') {
          if (s.phase !== 'RUNNING' || s.snapshot.delivery_mode !== 'rayneo') throw new HttpError(409, '当前不是真机运行阶段。');
          store.requireOwner(s, input.owner);
          const material = s.snapshot.materials.find(m => m.id === s.snapshot.blocks[s.index].material_id);
          if (!material || input.attempt_id !== s.attempt_id) throw new HttpError(409, '通知不属于当前尝试。');
          json(await device.send(material, s.attempt_id!, s.snapshot.blocks[s.index].notification_ms, s.id, s.attempt_id, 'formal')); return;
        }
        if (action === 'finish') { json(engine.finish(s, input.owner)); return; }
        if (action === 'answer') {
          const times = input.timing as Record<string, unknown> | undefined;
          const finite = (key: string) => typeof times?.[key] === 'number' && Number.isFinite(times[key]) ? times[key] : null;
          json(engine.submit(s, input.phase, input.answer, { shown_at: finite('shown_at'), submitted_at: finite('submitted_at'), time_origin: finite('time_origin') })); return;
        }
        if (action === 'answers') {
          const timing = (raw: unknown) => { const t = (raw ?? {}) as Record<string, unknown>; const pick = (k: string) => typeof t[k] === 'number' && Number.isFinite(t[k]) ? t[k] : null; return { shown_at: pick('shown_at'), first_answered_at: pick('first_answered_at'), last_changed_at: pick('last_changed_at'), change_count: pick('change_count'), submitted_at: pick('submitted_at'), time_origin: pick('time_origin') }; };
          json(engine.submitBatch(s, input.items, timing)); return;
        }
        if (action === 'next') { json(engine.next(s)); return; }
        if (action === 'jump') { json(engine.jump(s, input.index)); return; }
        if (action === 'interrupt' && s.phase === 'RUNNING') { store.requireOwner(s, input.owner); json(engine.interrupt(s, '被试页面主动中断')); return; }
      }
    }
    throw new HttpError(404, '接口不存在。');
  } catch (error) { json({ error: error instanceof HttpError ? error.message : '服务处理失败，请查看终端。' }, error instanceof HttpError ? error.status : 500); if (!(error instanceof HttpError)) console.error(error); }
});
server.listen(port, process.env.HOST ?? '0.0.0.0', () => { console.log(`A1动态补偿追踪后台：http://127.0.0.1:${port}/admin`); console.log(`主任务为鼠标动态补偿追踪；默认通知Mock；材料库${materials.length}条；真机连接状态见后台准备与检查。`); });
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true; clearInterval(deviceTicker);
  for (const session of store.all()) if (session.phase === 'RUNNING') engine.interrupt(session, '实验系统关闭，保留本次尝试并允许重新开始');
  server.closeIdleConnections();
  const closedDevice = device.close().catch(error => { console.error('设备退出清理失败：', error); process.exitCode = 1; });
  server.close(() => { void closedDevice.finally(() => { store.db.close(); if (process.connected) process.disconnect?.(); }); });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'a5:shutdown') shutdown(); });
if (process.connected) process.on('disconnect', shutdown);
