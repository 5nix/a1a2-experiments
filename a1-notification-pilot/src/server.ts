import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import qrcode from 'qrcode-generator';
import { Store, HttpError, type ClientEvent } from './store.ts';
import { Engine } from './engine.ts';
import { buildPlan, type Material } from './protocol.ts';
import { bundle, analyze } from './export.ts';
import { lanAddresses } from '../../scripts/network.mjs';
import { createHash } from 'node:crypto';
import { DeviceControl } from './device-control.ts';

const root = resolve(import.meta.dirname, '..'), port = Number(process.env.PORT ?? 5189);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效。');
const materials = JSON.parse(await readFile(join(root, 'content/materials.json'), 'utf8')) as Material[];
const runtime = resolve(process.env.A1_RUNTIME_DIR ?? join(root, 'runtime'));
const exportsRoot = resolve(process.env.A1_EXPORT_DIR ?? join(root, 'exports'));
await mkdir(runtime, { recursive: true });
const store = new Store(join(runtime, 'experiment.sqlite')), engine = new Engine(store);
const device = new DeviceControl(store, join(root, 'content/assets/notifications'), { serial: process.env.A1_RAYNEO_SERIAL, adb: process.env.A1_ADB_PATH ?? process.env.A5_ADB_PATH, scrcpy: process.env.A1_SCRCPY_PATH ?? process.env.A5_SCRCPY_PATH, hostEnabled: process.env.A1_HOST_MODE !== 'off' });
const deviceTicker = setInterval(() => device.tick(), 250); deviceTicker.unref();
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
    const staticFiles: Record<string, string> = { '/': 'admin.html', '/admin': 'admin.html', '/experiment': 'experiment.html', '/admin.js': 'admin.js', '/experiment.js': 'experiment.js', '/app.css': 'app.css' };
    if (method === 'GET' && staticFiles[path]) { const file = staticFiles[path]; response.writeHead(200, { 'Content-Type': types[file.slice(file.lastIndexOf('.'))] }); response.end(await readFile(join(root, 'public', file))); return; }
    if (method === 'GET' && path === '/api/health') { json({ ok: true, experiment_id: 'a1-notification-pilot', default_mode: 'mock', adapter: device.adapter.getStatus(), synthetic: materials.every(m => m.synthetic !== false), material_count: materials.length }); return; }
    if (method === 'GET' && path === '/api/admin/device/records') { response.setHeader('Content-Disposition', 'attachment; filename="a1-device-records.json"'); json({ records: device.records(), audit: device.status().audit }); return; }
    if (method === 'GET' && path === '/api/admin/materials') { json({ version: 'a1-library-2026-10-22', count: materials.length, levels: [1, 2, 3].map(n => ({ n, count: materials.filter(m => m.n_count === n).length })), warnings: materials.filter(m => m.source_warnings?.length).map(m => ({ id: m.id, warnings: m.source_warnings })) }); return; }
    if (method === 'GET' && path === '/api/admin/device') { json(device.status()); return; }
    if (method === 'GET' && path === '/api/admin/device/apk') {
      let bytes;
      try { bytes = await readFile(join(root, 'rayneo-display/app/build/outputs/apk/debug/app-debug.apk')); } catch { throw new HttpError(404, 'APK尚未构建，请按设备说明运行assembleDebug。'); }
      response.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="a1-rayneo-images-0.1.0.apk"' }); response.end(bytes); return;
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
      if (method === 'GET') { json({ sessions: store.all().map(s => ({ ...engine.view(s), participant_url: store.entry(s.id) })) }); return; }
      if (method === 'POST') {
        const input = await body(request), participant = input.participant_id, preset = input.preset, seed = Number(input.seed);
        if (typeof participant !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(participant)) throw new HttpError(422, '编号使用1—40位字母、数字、下划线或连字符。');
        if (!['quick', 'sop', 'pool'].includes(String(preset)) || !Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295 || !['round1', 'round2'].includes(String(input.pilot_round))) throw new HttpError(422, '预设、轮次或随机种子无效。');
        const delivery = input.delivery_mode ?? 'mock';
        if (delivery !== 'mock' && delivery !== 'rayneo') throw new HttpError(422, '呈现设备无效。');
        if (delivery === 'rayneo') {
          if (!device.status().image_ready) throw new HttpError(409, '请先在准备与检查连接A1图片显示端。');
          if (store.all().some(s => s.snapshot.delivery_mode === 'rayneo' && !['COMPLETED', 'ABORTED'].includes(s.phase))) throw new HttpError(409, '同一副眼镜已有未结束的真机会话。');
        }
        const created = store.create(participant, buildPlan(materials, String(preset), seed, String(input.pilot_round), delivery, delivery === 'rayneo' ? device.adapter.getStatus().device_id : undefined));
        json(created, 201); return;
      }
    }
    if (method === 'GET' && path === '/api/admin/export') {
      const id = url.searchParams.get('session_id'), sessions = id ? [store.get(id)] : store.all(), bytes = bundle(store, sessions);
      const name = `a1-${Date.now()}.zip`; await mkdir(exportsRoot, { recursive: true }); await writeFile(join(exportsRoot, name), bytes);
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` }); response.end(bytes); return;
    }
    const admin = /^\/api\/admin\/sessions\/([a-f0-9-]+)(?:\/(stop|interrupt|notes))?$/.exec(path);
    if (admin) {
      const s = store.get(admin[1]);
      if (method === 'GET' && !admin[2]) { const a = analyze(store, s); json({ ...engine.view(s), summaries: a.summaries, attempts: a.attempts, recent_events: a.events.slice(-20) }); return; }
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
    const participant = /^\/api\/participant\/sessions\/([a-f0-9-]+)(?:\/(start|notice|events|finish|answer|next|interrupt))?$/.exec(path);
    if (participant) {
      const s = store.auth(participant[1], request.headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (method === 'GET' && !participant[2]) { json(engine.view(s)); return; }
      if (method === 'POST') {
        const input = await body(request), action = participant[2];
        if (action === 'events') { store.append(s, input.attempt_id, input.owner, input.events as ClientEvent[]); json({ saved: true }); return; }
        if (action === 'start') {
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
        if (action === 'next') { json(engine.next(s)); return; }
        if (action === 'interrupt' && s.phase === 'RUNNING') { store.requireOwner(s, input.owner); json(engine.interrupt(s, '被试页面主动中断')); return; }
      }
    }
    throw new HttpError(404, '接口不存在。');
  } catch (error) { json({ error: error instanceof HttpError ? error.message : '服务处理失败，请查看终端。' }, error instanceof HttpError ? error.status : 500); if (!(error instanceof HttpError)) console.error(error); }
});
server.listen(port, process.env.HOST ?? '0.0.0.0', () => { console.log(`A1视觉2-back后台：http://127.0.0.1:${port}/admin`); console.log(`模式：Mock；材料库${materials.length}条，使用来源卡片图，未连接真机眼镜。`); });
let closing = false;
function shutdown() { if (closing) return; closing = true; clearInterval(deviceTicker); server.closeIdleConnections(); const closedDevice = device.close(); server.close(() => { void closedDevice.finally(() => { store.db.close(); if (process.connected) process.disconnect?.(); }); }); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'a5:shutdown') shutdown(); });
if (process.connected) process.on('disconnect', shutdown);
