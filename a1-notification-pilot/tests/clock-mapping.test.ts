import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibration, resolveNotificationTiming } from '../src/clock-mapping.ts';
function sample(phase: 'pre' | 'post', device: number, offset = 100, rtt = 4, clock = 'boot1') {
  return calibration(phase, Array.from({ length: 7 }, (_, i) => ({ sample_id: `${phase}${i}`, browser_before_ms: device + offset - rtt / 2, browser_after_ms: device + offset + rtt / 2, device_monotonic_ms: device, clock_id: clock })), 123456);
}
const event = (kind: string, t: number, clock = 'boot1') => ({ type: 'device_image_event', data: { event: { request_id: 'r', kind, device_monotonic_ms: t, clock_id: clock } } });
const calEvent = (c: unknown) => ({ type: 'device_clock_calibration', data: c as Record<string, unknown> });
test('verified software mapping brackets device display and preserves uncertainty', () => {
 const result = resolveNotificationTiming([calEvent(sample('pre', 1000)), event('drawn', 2000), event('hidden', 6000), calEvent(sample('post', 7000))]);
 assert.equal(result.onset, 2100); assert.equal(result.offset, 6100); assert.equal(result.uncertainty_ms, 3);
 assert.equal(result.timing_qc, 'device_clock_mapping_verified_software');
});
test('missing, high latency, clock change, drift, device failure and out-of-bracket evidence never score', () => {
 const good = [calEvent(sample('pre', 1000)), event('drawn', 2000), event('hidden', 6000), calEvent(sample('post', 7000))];
 for (const events of [good.slice(0,3), [calEvent(sample('pre',1000,100,50)), ...good.slice(1)], [...good.slice(0,3),calEvent(sample('post',7000,100,4,'boot2'))], [...good.slice(0,3),calEvent(sample('post',7000,200))], [...good,event('failed',3000)], [good[0],event('drawn',500),...good.slice(2)]]) {
   assert.equal(resolveNotificationTiming(events).onset,null);
 }
});
test('clock samples reject invalid intervals and require seven independent raw samples', () => {
 assert.throws(()=>calibration('pre',[],123));
 assert.equal(sample('pre',1000,100,45).verified,false);
});
