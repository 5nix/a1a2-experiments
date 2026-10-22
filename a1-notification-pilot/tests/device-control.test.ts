import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.ts';
import { DeviceControl } from '../src/device-control.ts';
import { buildPlan, type Material } from '../src/protocol.ts';
import type { ImageAdapter, GlassesStatus, GlassesEvent, GlassesRequest } from '../src/device-contracts.ts';

const material: Material = { id: '1N-1L-01', domain: '设备', text_lines: ['剩余电量20%'], n_count: 1, question: '电量？', options: ['20%', '30%', '40%', '50%'], correct: 0, synthetic: false, render_image: '1N-1L-01.png', image_sha256: 'a'.repeat(64) };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'a1-device-review-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const status: GlassesStatus = { source: 'device', connected: true, ready: true, busy: false, device_id: 'adb:fixture', image_protocol: true, device_info: { app_package: 'link.ironip.a1.rayneo' } };
  const calls: string[] = [], queue: GlassesEvent[] = []; let disconnected = false, unknown = false, voiceMode = 'allow';
  const adapter: ImageAdapter = {
    getStatus: () => ({ ...status }),
    probe: async () => { calls.push('probe'); status.connected = !disconnected; },
    reconnect: async () => { calls.push('reconnect'); status.connected = !disconnected; },
    close: async () => { calls.push('close'); },
    prepareImage: async () => { calls.push('prepare'); },
    sendImage: async (r: GlassesRequest) => { calls.push('send'); if (unknown) throw new Error('timeout_delivery_unknown'); return { request_id: r.request_id, device_id: r.device_id, source: 'device', status: 'accepted', t_send: new Date().toISOString(), t_ack: new Date().toISOString(), t_display: null, t_hide: null, display_time_source: 'unavailable', error: null }; },
    pollEvents: async receive => { for (const e of queue.splice(0)) receive(e); },
  };
  const run = async (_file: string, args: string[]) => {
    calls.push(args.join(' '));
    if (args[0] === 'devices') return 'List of devices attached\nfixture\tdevice product:test\n';
    if (args.includes('get-state')) return disconnected ? 'offline' : 'device';
    if (args.includes('appops') && args.includes('set')) { voiceMode = args.at(-1)!; return ''; }
    if (args.includes('appops')) return `SYSTEM_ALERT_WINDOW: ${voiceMode}`;
    if (args.includes('start')) return 'Starting'; return '';
  };
  const device = new DeviceControl(store, resolve('a1-notification-pilot/content/assets/notifications'), { serial: 'fixture', run, adapterFactory: () => adapter, hostEnabled: false });
  const emit = (id: string, kind: string) => queue.push({ event_id: randomUUID(), request_id: id, device_id: 'adb:fixture', kind, device_wall_ms: 10000, device_monotonic_ms: kind === 'drawn' ? 1000 : 5000, clock_id: 'test-boot', error: kind === 'failed' ? 'render_error' : null });
  const cleanup = async () => {
    // 只清理此用例的临时保护窗口，绝不等待或连接物理设备。
    for (const r of device.records()) { r.created_at = '2000-01-01T00:00:00Z'; store.db.prepare('UPDATE device_requests SET data=? WHERE id=?').run(JSON.stringify(r), r.request_id); }
    status.busy = false; await device.close(); store.db.close(); await rm(dir, { recursive: true, force: true });
  };
  return { store, device, status, calls, queue, emit, cleanup, offline: () => { disconnected = true; }, unknown: () => { unknown = true; } };
}

test('ADB扫描、设备绑定、唤醒与重连；连接失败不能报告成功', async () => {
  const f = await fixture(); try {
    assert.equal((await f.device.devices())[0].serial, 'fixture');
    await f.device.configure('fixture'); await f.device.action('open');
    assert.ok(f.calls.some(c => c.includes('link.ironip.a1.rayneo/link.ironip.a5.rayneo.MainActivity')));
    assert.equal(f.device.status().image_ready, true);
    f.offline(); await assert.rejects(f.device.action('reconnect'), /连接未恢复/);
    assert.match(f.device.status().error!, /连接未恢复/);
  } finally { await f.cleanup(); }
});
test('原文字APK没有图片能力时拒绝准备与发送', async () => {
  const f = await fixture(); try {
    f.status.image_protocol = false;
    await assert.rejects(f.device.manual(material, randomUUID(), 4000), /图片显示端未就绪/);
    assert.ok(!f.calls.includes('send'));
  } finally { await f.cleanup(); }
});
test('图片先准备后发送，同一请求幂等且不能换图或时长', async () => {
  const f = await fixture(); try {
    const id = randomUUID(); await f.device.manual(material, id, 4000); await f.device.manual(material, id, 4000);
    assert.deepEqual(f.calls.filter(c => ['prepare', 'send'].includes(c)), ['prepare', 'send']);
    await assert.rejects(f.device.manual(material, id, 5000), /相同请求编号/);
    assert.equal(f.store.all().length, 0);
  } finally { await f.cleanup(); }
});
test('未知发送结果落盘且不因重试重新发送', async () => {
  const f = await fixture(); try {
    f.unknown(); const id = randomUUID(); const first = await f.device.manual(material, id, 4000);
    assert.equal(first.status, 'unknown'); assert.equal((await f.device.manual(material, id, 4000)).status, 'unknown');
    assert.equal(f.calls.filter(c => c === 'send').length, 1);
  } finally { await f.cleanup(); }
});
test('双眼事件重复回收幂等，失败终态不被迟到drawn覆盖', async () => {
  const f = await fixture(); try {
    const id = randomUUID(); await f.device.manual(material, id, 4000);
    f.emit(id, 'drawn'); const same = { ...f.queue[0] }; f.queue.push(same); f.emit(id, 'hidden'); await f.device.poll();
    assert.equal(f.device.records()[0].status, 'hidden'); assert.equal(f.device.records()[0].events.length, 2);
    f.emit(id, 'failed'); f.emit(id, 'drawn'); await f.device.poll(); assert.equal(f.device.records()[0].status, 'failed');
  } finally { await f.cleanup(); }
});
test('显示期间禁止重连和切换守护，不覆盖或排队', async () => {
  const f = await fixture(); try {
    await f.device.manual(material, randomUUID(), 4000);
    await assert.rejects(f.device.action('reconnect'), /展示期间/);
    await assert.rejects(f.device.action('host', true), /展示期间/);
    await assert.rejects(f.device.manual(material, randomUUID(), 4000), /尚未结束/);
  } finally { await f.cleanup(); }
});
test('2-back运行期间不能手动插入通知或改前台', async () => {
  const f = await fixture(); try {
    const created = f.store.create('000', buildPlan([material], 'quick', 1, 'round1'));
    const s = f.store.get(created.session_id); s.phase = 'RUNNING'; f.store.save(s);
    await assert.rejects(f.device.manual(material, randomUUID(), 4000), /运行期间/);
    await assert.rejects(f.device.action('open'), /主任务/);
    assert.ok(!f.calls.includes('send'));
  } finally { await f.cleanup(); }
});
test('上位机守护限制读回、退出恢复原权限；定时异常被隔离', async () => {
  const f = await fixture(); try {
    await f.device.action('host', true); assert.equal(f.device.status().voice_guard.state, 'protected');
    await f.device.action('host', false); assert.equal(f.device.status().voice_guard.state, 'restored');
    f.store.all = () => { throw new Error('fixture_sync_error'); };
    assert.doesNotThrow(() => f.device.tick());
  } finally { await f.cleanup(); }
});
