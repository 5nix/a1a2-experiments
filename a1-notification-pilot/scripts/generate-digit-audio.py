#!/usr/bin/env python3
"""Rebuild offline Mandarin digit clips with macOS Tingting, without playback.

Usage: python3 scripts/generate-digit-audio.py
Requires only Python's standard library, /usr/bin/say and /usr/bin/afconvert.
TTS is rendered to a file, converted to PCM, trimmed only outside a conservative
signal threshold, padded, and peak normalized. Speech is never time stretched or
cut to fit: clips with excessive active duration are synthesized again faster.
The OS/voice implementation can affect synthesized bytes; manifest hashes record
exact outputs and the generator source used for each build.
"""
from __future__ import annotations

import argparse
from array import array
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import wave

ALPHABET = [str(digit) for digit in range(1, 10)]
SPOKEN_TEXT = list('一二三四五六七八九')
VOICE = 'Tingting'
SAMPLE_RATE = 24000
DURATION_MS = 500
FRAME_COUNT = SAMPLE_RATE * DURATION_MS // 1000
PADDING_MS = 25
PADDING_FRAMES = SAMPLE_RATE * PADDING_MS // 1000
PEAK_TARGET = 0.8
# Detect even very quiet consonant/release tails, retaining extra padding around
# detected signal. Below-threshold samples inside the padded interval are kept.
SILENCE_THRESHOLD_RATIO = 0.001


def run(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_pcm(path: Path) -> array:
    with wave.open(str(path), 'rb') as source:
        if (source.getframerate(), source.getnchannels(), source.getsampwidth(), source.getcomptype()) != (SAMPLE_RATE, 1, 2, 'NONE'):
            raise RuntimeError(f'Unexpected PCM format: {path}')
        samples = array('h', source.readframes(source.getnframes()))
    if sys.byteorder != 'little':
        samples.byteswap()
    return samples


def write_pcm(path: Path, samples: array) -> None:
    if len(samples) != FRAME_COUNT:
        raise RuntimeError('Output does not have exactly 500 ms of samples')
    payload = array('h', samples)
    if sys.byteorder != 'little':
        payload.byteswap()
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(payload.tobytes())


def build_clip(symbol: str, digit: int, destination: Path, scratch: Path) -> dict:
    trials = []
    for rate in range(180, 351, 10):
        aiff, pcm = scratch / f'{digit}.aiff', scratch / f'{digit}-source.wav'
        # Explicit Chinese 一 is passed literally, rather than the Arabic numeral
        # 1 whose contextual pronunciation could be 幺.
        run('/usr/bin/say', '-v', VOICE, '-r', str(rate), '-o', str(aiff), symbol)
        run('/usr/bin/afconvert', '-f', 'WAVE', '-d', f'LEI16@{SAMPLE_RATE}', '-c', '1', str(aiff), str(pcm))
        source = read_pcm(pcm)
        peak = max((abs(s) for s in source), default=0)
        if not peak:
            raise RuntimeError(f'TTS produced silence for {symbol}')
        threshold = max(1, round(peak * SILENCE_THRESHOLD_RATIO))
        active = [i for i, sample in enumerate(source) if abs(sample) >= threshold]
        first, last = active[0], active[-1] + 1
        active_frames = last - first
        trials.append({'say_rate': rate, 'active_duration_ms': active_frames * 1000 / SAMPLE_RATE})
        if active_frames + 2 * PADDING_FRAMES > FRAME_COUNT:
            continue
        left, right = max(0, first - PADDING_FRAMES), min(len(source), last + PADDING_FRAMES)
        speech = source[left:right]
        # Place detected speech 25 ms after start. Preserve source samples from
        # the padding intervals, using zeros only where the source has ended.
        before = PADDING_FRAMES - (first - left)
        after = FRAME_COUNT - before - len(speech)
        gain = round(32767 * PEAK_TARGET) / peak
        output = array('h', [0] * before)
        output.extend(round(sample * gain) for sample in speech)
        output.extend([0] * after)
        path = destination / f'{digit}.wav'
        write_pcm(path, output)
        with wave.open(str(path), 'rb') as checked:
            if (checked.getnframes(), checked.getframerate(), checked.getnchannels(), checked.getsampwidth()) != (FRAME_COUNT, SAMPLE_RATE, 1, 2):
                raise RuntimeError(f'Output metadata mismatch for {symbol}')
        return {'symbol': str(digit), 'spoken_text': symbol, 'digit': digit, 'url': f'/audio/digits/{digit}.wav',
                'sha256': sha256(path), 'duration_ms': DURATION_MS,
                'sample_rate_hz': SAMPLE_RATE, 'channels': 1, 'pcm_bits': 16,
                'frames': FRAME_COUNT, 'format': 'WAV PCM signed 16-bit little-endian',
                'say_rate': rate, 'source_duration_ms': len(source) * 1000 / SAMPLE_RATE,
                'speech_detected_duration_ms': active_frames * 1000 / SAMPLE_RATE,
                'speech_start_ms': PADDING_MS,
                'speech_end_ms': (PADDING_FRAMES + active_frames) * 1000 / SAMPLE_RATE,
                'trailing_margin_ms': (FRAME_COUNT - PADDING_FRAMES - active_frames) * 1000 / SAMPLE_RATE,
                'peak_amplitude': max(abs(s) for s in output) / 32767,
                'gain': gain, 'source_pcm_sha256': sha256(pcm),
                'generation_attempts': trials}
    raise RuntimeError(f'{symbol}: speech cannot fit 500 ms with margins; no truncated clip was written')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'public/audio/digits')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('Generation requires macOS say + afconvert and installed Tingting voice')
    voices = run('/usr/bin/say', '-v', '?')
    if not any(line.split()[:1] == [VOICE] for line in voices.splitlines()):
        raise RuntimeError('Install the Mandarin Tingting voice before generation')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='a1-digit-audio-') as temp:
        clips = [build_clip(symbol, digit, args.output_dir, Path(temp)) for digit, symbol in enumerate(SPOKEN_TEXT, 1)]
    manifest = {'version': 'a1-mandarin-digits-v1', 'alphabet': ALPHABET, 'clips': clips,
                'voice': {'name': VOICE, 'language': 'zh-CN', 'spoken_one': '一', 'engine': 'macOS say'},
                'generation': {'created_at': datetime.now(timezone.utc).isoformat(),
                    'generator': 'scripts/generate-digit-audio.py',
                    'generator_sha256': sha256(Path(__file__)),
                    'macos_version': run('/usr/bin/sw_vers', '-productVersion'),
                    'macos_build': run('/usr/bin/sw_vers', '-buildVersion'),
                    'python_version': platform.python_version(),
                    'conversion': 'afconvert -f WAVE -d LEI16@24000 -c 1',
                    'duration_ms': DURATION_MS, 'padding_minimum_ms': PADDING_MS,
                    'peak_target': PEAK_TARGET, 'silence_threshold_relative_to_peak': SILENCE_THRESHOLD_RATIO,
                    'say_rate_candidates': list(range(180, 351, 10)),
                    'fit_rule': 'Resynthesize at increasing rate until active speech + 25 ms on each side fits; never truncate or time stretch speech',
                    'rebuild': 'python3 scripts/generate-digit-audio.py',
                    'playback_performed': False}}
    (args.output_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for clip in clips:
        print(f"{clip['digit']} {clip['symbol']}: {clip['duration_ms']} ms, {clip['sample_rate_hz']} Hz mono PCM{clip['pcm_bits']}, speech {clip['speech_detected_duration_ms']:.1f} ms, rate {clip['say_rate']}, SHA256 {clip['sha256']}")


if __name__ == '__main__':
    main()
