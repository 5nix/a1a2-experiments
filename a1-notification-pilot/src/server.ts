import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import qrcode from 'qrcode-generator';
import { Store, HttpError, type ClientEvent } from './store.ts';
import { Engine } from './engine.ts';
import { buildPlan, type Material } from './protocol.ts';
import { bundle, analyze } from './export.ts';
import { lanAddresses } from '../../scripts/network.mjs';

const root = resolve(import.meta.dirname, '..'), port = Number(process.env.PORT ?? 5189);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效。');
if (process.env.A1_GLASSES_MODE && process.env.A1_GLASSES_MODE !== 'mock') throw new Error('当前A1版本只支持显式Mock，真机时长与链路尚未接入；不能以Mock冒充真机。');
const materials = JSON.parse(await readFile(join(root, 'content/materials.json'), 'utf8')) as Material[];
const runtime = resolve(process.env.A1_RUNTIME_DIR ?? join(root, 'runtime'));
const exportsRoot = resolve(process.env.A1_EXPORT_DIR ?? join(root, 'exports'));
await mkdir(runtime, { recursive: true });
const store = new Store(join(runtime, 'experiment.sqlite')), engine = new Engine(store);
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
    if (method === 'GET' && path === '/api/health') { json({ ok: true, experiment_id: 'a1-notification-pilot', mode: 'mock', synthetic: true }); return; }
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
        if (!['quick', 'sop'].includes(String(preset)) || !Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295 || !['round1', 'round2'].includes(String(input.pilot_round))) throw new HttpError(422, '预设、轮次或随机种子无效。');
        const created = store.create(participant, buildPlan(materials, String(preset), seed, String(input.pilot_round)));
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
    const participant = /^\/api\/participant\/sessions\/([a-f0-9-]+)(?:\/(start|events|finish|answer|next|interrupt))?$/.exec(path);
    if (participant) {
      const s = store.auth(participant[1], request.headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (method === 'GET' && !participant[2]) { json(engine.view(s)); return; }
      if (method === 'POST') {
        const input = await body(request), action = participant[2];
        if (action === 'events') { store.append(s, input.attempt_id, input.owner, input.events as ClientEvent[]); json({ saved: true }); return; }
        if (action === 'start') { json(engine.start(s, input.owner)); return; }
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
server.listen(port, process.env.HOST ?? '0.0.0.0', () => { console.log(`A1视觉2-back后台：http://127.0.0.1:${port}/admin`); console.log('模式：Mock工程预演；通知为合成材料，未连接真机眼镜。'); });
let closing = false;
function shutdown() { if (closing) return; closing = true; server.closeIdleConnections(); server.close(() => { store.db.close(); if (process.connected) process.disconnect?.(); }); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'a5:shutdown') shutdown(); });
if (process.connected) process.on('disconnect', shutdown);
