/** Seeded 2D compensatory tracking. No animation or input listeners are installed here. */
function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function positive(value, fallback, name) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid tracking ${name}`);
  return number;
}

export class TrackingTask {
  constructor(canvas, config = {}, seed = 0) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new Error('Tracking canvas is required');
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    if (!this.context) throw new Error('Canvas 2D is unavailable');
    this.width = positive(config.width ?? canvas.clientWidth, 800, 'width');
    this.height = positive(config.height ?? canvas.clientHeight, 600, 'height');
    this.dpr = positive(config.device_pixel_ratio ?? globalThis.devicePixelRatio, 1, 'device pixel ratio');
    // 输入映射的归一化尺寸。未指定时等于显示尺寸（旧行为）；指定时显示可放大而鼠标→归一化位置的映射保持不变。
    this.inputWidth = positive(config.input_reference_width ?? this.width, this.width, 'input reference width');
    this.inputHeight = positive(config.input_reference_height ?? this.height, this.height, 'input reference height');
    this.config = Object.freeze({
      model: config.model ?? 'compensatory-2d-v1',
      input_gain: positive(config.input_gain, 1, 'input gain'),
      disturbance_rms: positive(config.disturbance_rms, 0.16, 'disturbance RMS'),
      disturbance_hz: positive(config.disturbance_hz, 0.22, 'disturbance frequency'),
      target_radius: positive(config.target_radius, 0.075, 'target radius'),
      sample_interval_ms: positive(config.sample_interval_ms, 50, 'sample interval'),
      cursor_radius: positive(config.cursor_radius, 0.025, 'cursor radius'),
      background: config.background ?? '#fafafa',
      target_color: config.target_color ?? '#9ca3af',
      cursor_color: config.cursor_color ?? '#161616',
      // 仅表现层：圈内时目标圈加深（练习用）。几何与扰动参数不受影响。
      highlight_within: config.highlight_within === true,
      within_color: config.within_color ?? '#121212',
      center_mark: config.center_mark === true,
    });
    this.seed = Number(seed) >>> 0;
    const random = seededRandom(this.seed);
    // Three equal components give the requested theoretical per-axis RMS. Position remains bounded.
    this.components = ['x', 'y'].map(() => [0, 1, 2].map(i => ({
      amplitude: this.config.disturbance_rms * Math.sqrt(2 / 3), phase: random() * Math.PI * 2,
      frequency: this.config.disturbance_hz * [0.65, 1.13, 1.81][i] * (0.9 + random() * 0.2),
    })));
    canvas.width = Math.round(this.width * this.dpr);
    canvas.height = Math.round(this.height * this.dpr);
    this.started = false;
    this.startPerformance = null;
    this.controlX = 0; this.controlY = 0;
    this.inputSeq = 0; this.pendingDx = 0; this.pendingDy = 0; this.pendingCount = 0;
    this.lastInputPerformance = null;
  }

  begin(startPerf) {
    if (!Number.isFinite(startPerf)) throw new Error('Tracking start time must be finite');
    this.startPerformance = startPerf;
    this.controlX = 0; this.controlY = 0;
    this.inputSeq = 0; this.pendingDx = 0; this.pendingDy = 0; this.pendingCount = 0;
    this.lastInputPerformance = null;
    this.started = true;
  }

  /** Pass relative movement only. Pointer lock / drag ownership is handled by the caller. */
  move(event) {
    if (!this.started) return null;
    const dx = Number(event.movementX), dy = Number(event.movementY);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Tracking input requires finite relative deltas');
    const received = performance.now();
    const now = Number.isFinite(event.timeStamp) && Math.abs(event.timeStamp - received) < 60000 ? event.timeStamp : received;
    if (now < this.startPerformance) return null;
    this.controlX += dx / (this.inputWidth / 2) * this.config.input_gain;
    this.controlY += dy / (this.inputHeight / 2) * this.config.input_gain;
    this.pendingDx += dx; this.pendingDy += dy; this.pendingCount++;
    this.lastInputPerformance = now;
    return {
      input_seq: ++this.inputSeq, mouse_dx: dx, mouse_dy: dy,
      control_x: this.controlX, control_y: this.controlY,
      input_performance_ms: now, elapsed_ms: now - this.startPerformance,
    };
  }

  /** Each sample consumes pending pixel deltas; cumulative control and input_seq remain intact. */
  advance(now, consumeInput = true) {
    if (!this.started || !Number.isFinite(now)) throw new Error('Tracking task is not running or time is invalid');
    const elapsed = Math.max(0, now - this.startPerformance);
    const t = elapsed / 1000;
    const disturbance = this.components.map(axis => axis.reduce((sum, part) => sum + part.amplitude * Math.sin(2 * Math.PI * part.frequency * t + part.phase), 0));
    const x = this.controlX + disturbance[0], y = this.controlY + disturbance[1];
    const sample = {
      performance_ms: now, elapsed_ms: elapsed,
      x, y, error: Math.hypot(x, y), target_x: 0, target_y: 0,
      disturbance_x: disturbance[0], disturbance_y: disturbance[1],
      control_x: this.controlX, control_y: this.controlY,
      input_seq: this.inputSeq, mouse_dx: this.pendingDx, mouse_dy: this.pendingDy,
      input_count_since_sample: this.pendingCount,
      last_input_performance_ms: this.lastInputPerformance,
      within_target: Math.hypot(x, y) <= this.config.target_radius,
      outside_canvas: Math.abs(x) > 1 || Math.abs(y) > 1,
      canvas_width_css_px: this.width, canvas_height_css_px: this.height, input_reference_width_css_px: this.inputWidth, input_reference_height_css_px: this.inputHeight,
      device_pixel_ratio: this.dpr, model: this.config.model, params: this.config, model_version: 'seeded_multisine_position_v1', seed: this.seed,
    };
    if (consumeInput) { this.pendingDx = 0; this.pendingDy = 0; this.pendingCount = 0; }
    this.draw(sample);
    return sample;
  }

  draw(sample) {
    const ctx = this.context, cx = this.width / 2, cy = this.height / 2;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = this.config.background;
    ctx.fillRect(0, 0, this.width, this.height);
    const inside = this.config.highlight_within && sample.within_target;
    ctx.strokeStyle = inside ? this.config.within_color : this.config.target_color; ctx.lineWidth = inside ? 2.5 : 1.5;
    ctx.beginPath(); ctx.ellipse(cx, cy, this.config.target_radius * cx, this.config.target_radius * cy, 0, 0, Math.PI * 2); ctx.stroke();
    // 中心标记：误差按圆点中心到此点的距离计算，标出瞄准点。
    if (this.config.center_mark) { ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(cx, cy, 1.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = this.config.cursor_color;
    ctx.beginPath(); ctx.ellipse(cx + sample.x * cx, cy + sample.y * cy, this.config.cursor_radius * cx, this.config.cursor_radius * cy, 0, 0, Math.PI * 2); ctx.fill();
  }

  stop() { this.started = false; }
}
