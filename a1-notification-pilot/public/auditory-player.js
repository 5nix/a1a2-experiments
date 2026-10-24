/** Fixed decoded audio only. All reported times are software estimates, not acoustic measurements. */
export class AuditoryPlayer {
  constructor(onError = () => {}) {
    this.onError = onError;
    this.context = null;
    this.clips = new Map();
    this.sources = new Set();
    this.active = false;
    this.lastMapping = null;
    this.generation = 0;
  }

  // Call directly from a user gesture, before awaiting network work.
  async unlock() {
    if (!this.context) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('当前浏览器不支持 Web Audio。');
      this.context = new Context({ latencyHint: 'interactive' });
      this.context.addEventListener('statechange', () => {
        if (this.active && this.context.state !== 'running') {
          const state = this.context.state;
          this.stop();
          this.onError(new Error(`音频上下文已${state}；当前排程已停止，不能自动重播。`));
        }
      });
    }
    await this.context.resume();
    if (this.context.state !== 'running') throw new Error('音频尚未解锁，请重新点击开始。');
    return this.metadata();
  }

  async prepare(manifest) {
    const clips = Array.isArray(manifest) ? manifest : manifest?.clips;
    if (!this.context) throw new Error('请先在用户点击时调用 unlock()。');
    if (!Array.isArray(clips) || !clips.length) throw new Error('音频清单为空。');
    if (!globalThis.crypto?.subtle) throw new Error('请用本机127.0.0.1地址打开被试页面，以完成数字录音校验。');
    const symbols = new Set();
    for (const clip of clips) {
      if (clip.symbol == null || typeof clip.url !== 'string' || !/^[a-f0-9]{64}$/i.test(clip.sha256 ?? '') || !(clip.duration_ms > 0)) throw new Error('音频清单字段无效。');
      const symbol = String(clip.symbol);
      if (symbols.has(symbol)) throw new Error(`音频符号重复：${symbol}`);
      symbols.add(symbol);
    }
    // Commit only a complete, verified manifest; failed preparation preserves the old clips.
    const prepared = await Promise.all(clips.map(async clip => {
      const response = await fetch(clip.url, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`音频加载失败：${clip.symbol} (${response.status})`);
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (sha256 !== clip.sha256.toLowerCase()) throw new Error(`音频 SHA-256 不一致：${clip.symbol}`);
      const buffer = await this.context.decodeAudioData(bytes.slice(0));
      if (!(buffer.duration > 0)) throw new Error(`音频长度无效：${clip.symbol}`);
      if (Math.abs(buffer.duration * 1000 - Number(clip.duration_ms)) > 100) throw new Error(`音频时长与清单不一致：${clip.symbol}`);
      return [String(clip.symbol), { buffer, sha256, duration_ms: buffer.duration * 1000, manifest_duration_ms: Number(clip.duration_ms) }];
    }));
    this.clips = new Map(prepared);
    return this.metadata();
  }

  mapping() {
    const c = this.context;
    const now = performance.now();
    if (typeof c.getOutputTimestamp === 'function') {
      const stamp = c.getOutputTimestamp();
      if (Number.isFinite(stamp.contextTime) && Number.isFinite(stamp.performanceTime) && stamp.contextTime > 0 && stamp.performanceTime > 0 && Math.abs(now - stamp.performanceTime) < 2000 && Math.abs(c.currentTime - stamp.contextTime) < 2) {
        return { clock_mapping_method: 'getOutputTimestamp', clock_mapping_verified: true, audio_context_time: stamp.contextTime, performance_time_ms: stamp.performanceTime };
      }
    }
    const latency = Math.max(0, Number(c.baseLatency) || 0) + Math.max(0, Number(c.outputLatency) || 0);
    return { clock_mapping_method: 'currentTime_plus_latency_estimate', clock_mapping_verified: false, audio_context_time: c.currentTime, performance_time_ms: now + latency * 1000 };
  }

  schedule(symbols, soaMs, startPerformanceMs) {
    const c = this.context;
    if (!c || c.state !== 'running') throw new Error('音频上下文未运行。');
    if (this.active || this.sources.size) throw new Error('已有音频排程，请先停止。');
    if (!Array.isArray(symbols) || !symbols.length || !Number.isFinite(soaMs) || soaMs <= 0 || !Number.isFinite(startPerformanceMs)) throw new Error('音频排程参数无效。');
    const clips = symbols.map(symbol => {
      const clip = this.clips.get(String(symbol));
      if (!clip) throw new Error(`音频尚未准备：${symbol}`);
      if (clip.duration_ms > soaMs) throw new Error(`音频长度超过 SOA：${symbol}`);
      return clip;
    });
    const mapping = this.mapping();
    const contextStart = mapping.audio_context_time + (startPerformanceMs - mapping.performance_time_ms) / 1000;
    if (contextStart < c.currentTime + 0.02) throw new Error('音频排程起点过近或已过去，请使用更晚的开始时间。');
    const generation = ++this.generation;
    const items = symbols.map((symbol, index) => ({
      index, symbol: String(symbol),
      onset_performance_ms: startPerformanceMs + index * soaMs,
      offset_performance_ms: startPerformanceMs + index * soaMs + clips[index].duration_ms,
      audio_context_time: contextStart + index * soaMs / 1000,
      audio_context_offset_time: contextStart + index * soaMs / 1000 + clips[index].buffer.duration,
      sha256: clips[index].sha256,
      duration_ms: clips[index].duration_ms,
    }));
    this.lastMapping = mapping;
    this.active = true;
    try {
      for (const item of items) {
        const source = c.createBufferSource();
        source.buffer = clips[item.index].buffer;
        source.connect(c.destination);
        this.sources.add(source);
        source.onended = () => {
          source.disconnect(); this.sources.delete(source);
          if (generation === this.generation && !this.sources.size) this.active = false;
        };
        source.start(item.audio_context_time);
      }
    } catch (error) { this.stop(); throw error; }
    return { items, metadata: this.metadata() };
  }

  metadata() {
    const c = this.context;
    return {
      state: c?.state ?? 'uninitialized', active: this.active,
      sample_rate: c?.sampleRate ?? null,
      base_latency_ms: Number.isFinite(c?.baseLatency) ? c.baseLatency * 1000 : null,
      output_latency_ms: Number.isFinite(c?.outputLatency) ? c.outputLatency * 1000 : null,
      clock_mapping_method: this.lastMapping?.clock_mapping_method ?? 'not_scheduled',
      clock_mapping_verified: this.lastMapping?.clock_mapping_verified ?? false,
      clock_mapping: this.lastMapping ? { ...this.lastMapping } : null,
      acoustic_timing_verified: false,
      timing_basis: 'software_estimated_output',
      prepared_symbols: [...this.clips.keys()],
    };
  }

  stop() {
    this.active = false;
    this.generation++;
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
    }
    this.sources.clear();
  }
}
