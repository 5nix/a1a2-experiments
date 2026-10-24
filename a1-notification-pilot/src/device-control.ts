import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, HttpError } from './store.ts';
import { RayNeoGlassesAdapter } from './adapters/rayneo-glasses.ts';
import { VoiceOverlayGuard } from './voice-overlay-guard.ts';
import type { ImageAdapter, GlassesEvent, GlassesRequest, GlassesReceipt } from './device-contracts.ts';
import type { Material } from './protocol.ts';

type Runner = (file: string, args: string[]) => Promise<string>;
export interface ImageRecord {
  request_id: string; kind: 'manual' | 'formal'; session_id: string | null; attempt_id: string | null;
  material_id: string; image_sha256: string; device_id: string; request: GlassesRequest;
  status: string; error: string | null; created_at: string; events: GlassesEvent[]; receipt?: GlassesReceipt;
}
/** 沿用原上位机的串行互斥、恢复限频、保护窗口与权限备份；通知不重发。 */
export class DeviceControl {
  readonly store: Store;
  readonly packageName = 'link.ironip.a1.rayneo';
  adapter: ImageAdapter;
  private serial: string;
  private adb: string;
  private scrcpy: string;
  private assetRoot: string;
  private run: Runner;
  private factory: (serial: string) => ImageAdapter;
  private guard: VoiceOverlayGuard;
  private hostEnabled: boolean;
  private working = false;
  private closed = false;
  private polling = false;
  private pollTask?: Promise<void>;
  private task?: Promise<unknown>;
  private lastAttempt = 0;
  private mirror?: ChildProcess;
  private error: string | null = null;
  constructor(store: Store, assetRoot: string, options: { serial?: string; adb?: string; scrcpy?: string; run?: Runner; adapterFactory?: (serial: string) => ImageAdapter; hostEnabled?: boolean } = {}) {
    this.store = store; this.assetRoot = assetRoot;
    this.serial = options.serial ?? store.setting<string>('a1_device_serial') ?? '';
    this.adb = options.adb ?? 'adb'; this.scrcpy = options.scrcpy ?? 'scrcpy';
    this.run = options.run ?? (async (file, args) => (await promisify(execFile)(file, args, { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout);
    this.factory = options.adapterFactory ?? (serial => new RayNeoGlassesAdapter(serial, { adb: this.adb, run: this.run }));
    this.adapter = this.factory(this.serial);
    this.guard = this.makeGuard(); this.hostEnabled = store.setting<boolean>('a1_host_enabled') ?? options.hostEnabled ?? true;
    for (const r of this.records()) if (['sending', 'accepted', 'drawn'].includes(r.status)) { r.status = 'unknown'; r.error = '服务重启，结果待核查，不自动重发。'; this.save(r); }
    store.db.exec('CREATE TABLE IF NOT EXISTS device_seen(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  }
  private makeGuard() { return new VoiceOverlayGuard(this.store, { serial: this.serial, adb: this.adb, run: this.run, now: Date.now, audit: (action, detail) => this.audit(action, detail) }); }
  private audit(action: string, detail: unknown) { this.store.db.prepare('INSERT INTO device_audit(data) VALUES (?)').run(JSON.stringify({ action, detail, timestamp: new Date().toISOString() })); }
  records(): ImageRecord[] { return (this.store.db.prepare('SELECT data FROM device_requests ORDER BY rowid DESC LIMIT 100').all() as { data: string }[]).map(r => JSON.parse(r.data)); }
  private record(id: string) { const row = this.store.db.prepare('SELECT data FROM device_requests WHERE id=?').get(id) as { data: string } | undefined; return row ? JSON.parse(row.data) as ImageRecord : undefined; }
  private save(r: ImageRecord) { this.store.db.prepare('INSERT INTO device_requests VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(r.request_id, JSON.stringify(r)); }
  private activeTask() { return this.store.all().some(s => s.phase === 'RUNNING'); }
  protected() { return !!this.adapter.getStatus().busy || this.records().some(r => !r.events.some(e => e.kind === 'hidden') && Date.now() - Date.parse(r.created_at) < r.request.duration_ms + 7000); }
  status() {
    const adapter = this.adapter.getStatus();
    return { adapter, serial: this.serial, package_name: this.packageName, working: this.working, enabled: this.hostEnabled,
      error: this.error, voice_guard: this.guard.status(), scrcpy: { running: !!this.mirror && this.mirror.exitCode === null, crop: '640:480:0:0' },
      image_ready: !!adapter.connected && !!adapter.ready && !!adapter.image_protocol,
      manual_allowed: !this.activeTask() && !this.working && !this.protected() && !!adapter.connected && !!adapter.ready && !!adapter.image_protocol,
      records: this.records(), audit: (this.store.db.prepare('SELECT data FROM device_audit ORDER BY seq DESC LIMIT 30').all() as { data: string }[]).map(r => JSON.parse(r.data)) };
  }
  async devices() {
    try {
      const output = await this.run(this.adb, ['devices', '-l']);
      return output.split(/\r?\n/).slice(1).map(line => /^(\S+)\s+(device|unauthorized|offline)\b(.*)$/.exec(line)).filter(Boolean).map(m => ({ serial: m![1], state: m![2], description: m![3].trim() }));
    } catch { throw new HttpError(503, 'ADB不可用，请安装platform-tools或设置A1_ADB_PATH。'); }
  }
  private async exclusive<T>(action: string, work: () => Promise<T>): Promise<T> {
    if (this.closed || this.working) throw new HttpError(409, '设备控制正忙或正在关闭。');
    this.working = true;
    const promise = work(); this.task = promise;
    try { const result = await promise; this.error = null; this.audit(action, { ok: true }); return result; }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); this.audit(action, { ok: false, error: this.error }); if (error instanceof HttpError) throw error; throw new HttpError(503, this.error); }
    finally { this.working = false; }
  }
  async configure(serial: string) {
    return this.exclusive('configure', async () => {
      if (this.activeTask() || this.protected() || this.store.all().some(s => s.snapshot.delivery_mode === 'rayneo' && !['COMPLETED', 'ABORTED'].includes(s.phase))) throw new HttpError(409, '存在任务或已绑定的真机会话，不能切换设备。');
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(serial) || !(await this.devices()).some(d => d.serial === serial && d.state === 'device')) throw new HttpError(422, '请选择已连接且已授权的ADB设备。');
      if (this.guard.hasBackup()) { await this.guard.sync(false); if (this.guard.hasBackup()) throw new HttpError(409, '原设备权限尚未恢复，保留备份，暂不切换。'); }
      await this.adapter.close(); this.mirror?.kill(); this.mirror = undefined;
      this.serial = serial; this.adapter = this.factory(serial); this.guard = this.makeGuard(); this.store.setSetting('a1_device_serial', serial);
      await this.adapter.probe(); return this.status();
    });
  }
  async action(action: string, enabled?: boolean) {
    return this.exclusive(action, async () => {
      if (!this.serial) throw new HttpError(409, '请先扫描并选择眼镜设备。');
      if (!['probe', 'open', 'reconnect', 'host', 'scrcpy'].includes(action)) throw new HttpError(422, '设备操作无效。');
      if (['open', 'reconnect', 'host'].includes(action) && (this.activeTask() || this.protected())) throw new HttpError(409, '主任务或图片展示期间禁止切前台、重连或改权限。');
      if (action === 'host') {
        if (typeof enabled !== 'boolean') throw new HttpError(422, '守护开关无效。');
        this.hostEnabled = enabled; this.store.setSetting('a1_host_enabled', enabled); await this.guard.sync(enabled);
      } else if (action === 'scrcpy') await this.openMirror();
      else if (action === 'open') await this.recover();
      else if (action === 'reconnect') { await this.adapter.reconnect(); this.requireConnected(); }
      else { await this.adapter.probe(); this.requireConnected(); }
      return this.status();
    });
  }
  private requireConnected() { const s = this.adapter.getStatus(); if (!s.connected) throw new HttpError(503, `连接未恢复：${s.error ?? '设备未上线'}。请确认已安装A1图片显示APK并授权USB调试。`); }
  private async recover() {
    const state = (await this.run(this.adb, ['-s', this.serial, 'get-state'])).trim();
    if (state !== 'device') throw new Error('ADB未连接或未授权。');
    await this.guard.sync(this.hostEnabled); if (this.closed) return;
    await this.run(this.adb, ['-s', this.serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']); if (this.closed) return;
    await this.run(this.adb, ['-s', this.serial, 'shell', 'cmd', 'statusbar', 'collapse']).catch(() => {}); if (this.closed) return;
    const output = await this.run(this.adb, ['-s', this.serial, 'shell', 'am', 'start', '-n', `${this.packageName}/link.ironip.a5.rayneo.MainActivity`]);
    if (/Error|Exception/.test(output)) throw new Error('无法打开A1图片显示程序，请先安装A1 APK。');
    if (this.closed) return;
    const windows = await this.run(this.adb, ['-s', this.serial, 'shell', 'dumpsys', 'window']).catch(() => '');
    const focus = windows.split(/\r?\n/).find(l => l.includes('mCurrentFocus=')) ?? '';
    const app = windows.split(/\r?\n/).find(l => l.includes('mFocusedApp=')) ?? '';
    if (app.includes(this.packageName) && focus.includes('com.ffalconxr.mercury.launcher')) await this.run(this.adb, ['-s', this.serial, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS']);
    if (this.closed) return;
    // 首次冷启动需要创建窗口与USB监听；仅重试状态探测，不补发刺激。
    for (let i = 0; i < 10 && !this.closed; i++) {
      await this.adapter.probe();
      if (this.adapter.getStatus().connected && this.adapter.getStatus().ready) break;
      await delay(150);
    }
    this.requireConnected();
  }
  private async openMirror() {
    if (this.mirror && this.mirror.exitCode === null) return;
    const child = spawn(this.scrcpy, ['--serial', this.serial, '--crop', '640:480:0:0', '--no-audio', '--window-title', 'A1 眼镜画面 · 左眼'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, ADB: this.adb } });
    this.mirror = child; child.stderr?.on('data', () => {});
    child.on('exit', code => { if (code) this.error = 'scrcpy已退出，请检查设备或A1_SCRCPY_PATH。'; });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => { this.mirror = undefined; reject(new Error('无法启动scrcpy，请安装或设置A1_SCRCPY_PATH。')); }); });
  }
  private ready() { const s = this.adapter.getStatus(); if (!s.connected || !s.ready || !s.image_protocol || s.device_info?.app_package !== this.packageName) throw new HttpError(409, 'A1图片显示端未就绪；原A5文字APK不能接收图片，请连接并打开A1 APK。'); return s; }
  async prepare(material: Material) {
    return this.exclusive('prepare_image', async () => {
      this.ready(); if (this.protected()) throw new HttpError(409, '上一张图片尚未结束。');
      if (!material.render_image || !/^[123]N-[12]L-\d{2}\.png$/.test(material.render_image) || !material.image_sha256) throw new HttpError(422, '材料没有可验证的PNG。');
      await this.adapter.prepareImage(join(this.assetRoot, material.render_image), material.image_sha256, this.packageName);
    });
  }
  async manual(material: Material, requestId: string, duration: number) {
    if (!/^[a-f0-9-]{36}$/.test(requestId) || !Number.isInteger(duration) || duration < 1000 || duration > 15000) throw new HttpError(422, '请求编号或图片时长无效。');
    if (this.activeTask()) throw new HttpError(409, '2-back运行期间不能插入手动通知。');
    const prior = this.record(requestId);
    if (prior) { if (prior.kind !== 'manual' || prior.material_id !== material.id || prior.request.duration_ms !== duration || prior.image_sha256 !== material.image_sha256) throw new HttpError(409, '相同请求编号不能更换图片或时长。'); return prior; }
    await this.prepare(material);
    return this.send(material, requestId, duration, null, null, 'manual');
  }
  async send(material: Material, requestId: string, duration: number, sessionId: string | null, attemptId: string | null, kind: 'manual' | 'formal') {
    return this.exclusive('send_image', async () => {
      const prior = this.record(requestId);
      if (prior) { if (prior.material_id !== material.id || prior.request.duration_ms !== duration || prior.attempt_id !== attemptId || prior.kind !== kind) throw new HttpError(409, '请求编号与已记录图片冲突。'); return prior; }
      if (!/^[a-f0-9-]{36}$/.test(requestId) || !Number.isInteger(duration) || duration < 1000 || duration > 15000) throw new HttpError(422, '请求编号或图片时长无效。');
      if (this.protected() || kind === 'manual' && this.activeTask()) throw new HttpError(409, '设备忙碌，不覆盖、不排队。');
      const state = this.ready();
      const request: GlassesRequest = { request_id: requestId, session_id: sessionId ?? `manual:${randomUUID()}`, participant_id: sessionId ? this.store.get(sessionId).participant_id : 'DEVICE_DEBUG', stage_id: attemptId ?? 'DEVICE_DEBUG', message_id: material.id, text: material.text_lines.join('\n'), duration_ms: duration, display_mode: 'legacy_8500', device_id: state.device_id, image_sha256: material.image_sha256, image_width_px: 284 };
      const record: ImageRecord = { request_id: requestId, kind, session_id: sessionId, attempt_id: attemptId, material_id: material.id, image_sha256: material.image_sha256!, device_id: state.device_id!, request, created_at: new Date().toISOString(), status: 'sending', error: null, events: [] };
      this.save(record); // 发送意图先落盘，未知结果不补发。
      try { record.receipt = await this.adapter.sendImage(request); record.status = record.receipt.status; record.error = record.receipt.error; }
      catch (error) { record.status = 'unknown'; record.error = error instanceof Error ? error.message : String(error); }
      const events = this.record(requestId)?.events ?? []; record.events = events;
      if (events.some(e => e.kind === 'failed')) record.status = 'failed'; else if (events.some(e => e.kind === 'hidden')) record.status = 'hidden'; else if (events.some(e => e.kind === 'drawn')) record.status = 'drawn';
      this.save(record);
      if (sessionId) this.store.log(sessionId, attemptId, 'device_image_sent', { request_id: requestId, status: record.status, image_sha256: record.image_sha256 });
      return record;
    });
  }
  private receive(event: GlassesEvent) {
    const r = this.record(event.request_id); if (!r) return;
    if (event.device_id !== r.device_id) throw new Error('device_event_binding_mismatch');
    const prior = this.store.db.prepare('SELECT data FROM device_seen WHERE id=?').get(event.event_id) as { data: string } | undefined;
    if (prior) { if (prior.data !== JSON.stringify(event)) throw new Error('device_event_content_conflict'); return; }
    this.store.tx(() => {
      this.store.db.prepare('INSERT INTO device_seen VALUES (?,?)').run(event.event_id, JSON.stringify(event));
      r.events.push(event);
      r.status = r.events.some(e => e.kind === 'failed') ? 'failed' : r.events.some(e => e.kind === 'hidden') ? 'hidden' : r.events.some(e => e.kind === 'drawn') ? 'drawn' : 'accepted';
      if (event.error) r.error = event.error; this.save(r);
      if (r.session_id) this.store.log(r.session_id, r.attempt_id, 'device_image_event', { event });
    });
  }
  async poll() {
    if (this.polling || this.closed || !this.serial) return;
    this.polling = true;
    try { this.pollTask = this.adapter.pollEvents(event => this.receive(event)); await this.pollTask; }
    catch (e) { this.error = e instanceof Error ? e.message : String(e); }
    finally { this.polling = false; }
  }
  tick() {
    try { this.tickGuard(); } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
  }
  private tickGuard() {
    void this.poll();
    if (this.closed || !this.serial || this.working || this.activeTask() || this.protected() || Date.now() - this.lastAttempt < 5000) return;
    const s = this.adapter.getStatus();
    if (this.hostEnabled && (!s.connected || !s.ready)) { this.lastAttempt = Date.now(); void this.action('open').catch(() => {}); }
    else if (this.guard.due(this.hostEnabled)) { this.lastAttempt = Date.now(); void this.exclusive('voice_guard', () => this.guard.sync(this.hostEnabled)).catch(() => {}); }
  }
  async close() {
    this.closed = true; await this.task?.catch(() => {}); await this.pollTask?.catch(() => {}); this.mirror?.kill();
    for (let waited = 0; this.protected() && waited < 15000; waited += 250) { if (this.serial) await this.adapter.pollEvents(e => this.receive(e)).catch(() => {}); await delay(250); }
    if (!this.protected()) await this.guard.sync(false); else this.audit('restore_deferred', { reason: 'display_busy', backup_preserved: true });
    await this.adapter.close();
    if (this.serial && !this.protected()) await this.run(this.adb, ['-s', this.serial, 'shell', 'am', 'force-stop', 'link.ironip.a1.rayneo']).catch(error => this.audit('display_close_failed', { error: String(error) }));
  }
}
