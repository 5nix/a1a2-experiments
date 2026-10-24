import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { RayNeoGlassesAdapter } from '../src/adapters/rayneo-glasses.ts';

test('真实TCP模拟：图片哈希回执、持久连接、设备事件回收及关闭隧道', async () => {
  let connections = 0, showCount = 0; const commands: string[] = [];
  let requestId = '';
  const server = createServer(socket => {
    connections++; let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const input = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); commands.push(input.command);
        const response: Record<string, unknown> = { protocol: 'a1-rayneo/1', id: input.id, ok: true };
        if (input.command === 'status') Object.assign(response, { ready: true, busy: false, ledger_id: 'fixture-ledger', image_protocol: true, device_info: { app_package: 'link.ironip.a1.rayneo' } });
        if (input.command === 'image_storage') response.storage_ready = true;
        if (input.command === 'prepare_image') response.image_sha256 = input.payload.image_sha256;
        if (input.command === 'show_image') { showCount++; requestId = input.payload.request_id; Object.assign(response, { request_id: requestId, image_sha256: input.payload.image_sha256 }); }
        if (input.command === 'events') Object.assign(response, { ledger_id: 'fixture-ledger', events: [{ seq: 1, event: { event_id: 'event-1', request_id: requestId, device_id: 'adb:fixture', kind: 'drawn', device_wall_ms: 10, device_monotonic_ms: 20, clock_id: 'fixture-clock', error: null } }] });
        socket.write(JSON.stringify(response) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port, adb: string[][] = [];
  const adapter = new RayNeoGlassesAdapter('fixture', { run: async (_file, args) => { adb.push(args); return args.includes('tcp:0') ? String(port) : ''; } });
  try {
    const path = resolve('a1-notification-pilot/content/assets/notifications/1N-1L-01.png'), sha = createHash('sha256').update(await readFile(path)).digest('hex');
    await adapter.probe(); assert.equal(adapter.getStatus().image_protocol, true);
    await adapter.prepareImage(path, sha, 'link.ironip.a1.rayneo');
    const receipt = await adapter.sendImage({ request_id: randomUUID(), session_id: 's', participant_id: '000', stage_id: 'B01', message_id: '1N-1L-01', text: '剩余电量20%', duration_ms: 4000, image_sha256: sha, image_width_px: 284, device_id: 'adb:fixture' });
    assert.equal(receipt.status, 'accepted'); assert.equal(receipt.t_display, null);
    const events: unknown[] = []; await adapter.pollEvents(e => events.push(e));
    assert.equal(events.length, 1); assert.equal(connections, 1); assert.equal(showCount, 1);
    assert.ok(adb.some(args => args.includes('localabstract:a1-rayneo-v1'))); assert.ok(adb.some(args => args.includes('push')));
    await assert.rejects(adapter.prepareImage(path, '0'.repeat(64), 'link.ironip.a1.rayneo'), /hash_mismatch/);
  } finally { await adapter.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.ok(adb.some(args => args.includes('--remove')));
});
