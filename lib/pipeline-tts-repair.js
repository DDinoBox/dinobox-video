import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync, writeFileSync } from 'node:fs';
import { stableCanonicalStringify, hashPipelineInputSnapshot } from './pipeline-contract.js';
import { applyNarrationPatch, scriptRepairHash } from './pipeline-script-repair.js';

const MAX_WAV_BYTES = 256 * 1024 * 1024;
const MAX_CHUNKS = 10000;
const fail = reason => { throw Error(`tts_repair:${reason}`); };

function boundedRead(file) {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_WAV_BYTES) fail('invalid_wav_size');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) fail('wav_truncated');
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) fail('wav_size_changed');
    return bytes;
  } finally { closeSync(fd); }
}

/** Strict RIFF PCM only. Durations are sample frames / sample rate, not metadata estimates. */
export function readPcmWav(file) {
  const bytes = boundedRead(file);
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('invalid_riff_header');
  let format, data, offset = 12, chunks = 0;
  while (offset < bytes.length) {
    if (++chunks > MAX_CHUNKS || bytes.length - offset < 8) fail('invalid_chunk_header');
    const name = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size, next = end + size % 2;
    if (end > bytes.length || next > bytes.length) fail('chunk_out_of_bounds');
    if (name === 'fmt ') {
      if (format || data || (size !== 16 && size !== 18)) fail('unsupported_pcm_format');
      format = bytes.subarray(start, end);
      if (size === 18 && format.readUInt16LE(16) !== 0) fail('unsupported_pcm_extension');
    } else if (name === 'data') {
      if (!format || data || size === 0) fail('invalid_data_chunk');
      data = bytes.subarray(start, end);
    }
    offset = next;
  }
  if (!format || !data) fail('missing_fmt_or_data');
  const tag = format.readUInt16LE(0), channels = format.readUInt16LE(2);
  const sampleRate = format.readUInt32LE(4), byteRate = format.readUInt32LE(8);
  const blockAlign = format.readUInt16LE(12), bitsPerSample = format.readUInt16LE(14);
  if (tag !== 1 || ![8, 16, 24, 32].includes(bitsPerSample) || !channels || !sampleRate
    || blockAlign !== channels * bitsPerSample / 8 || byteRate !== sampleRate * blockAlign) fail('unsupported_pcm_format');
  if (data.length % blockAlign) fail('unaligned_pcm_data');
  return { durationSec: data.length / blockAlign / sampleRate, sampleRate, channels, bitsPerSample, blockAlign,
    format: Buffer.from(format), data: Buffer.from(data), contentHash: createHash('sha256').update(bytes).digest('hex') };
}

function wavChunk(name, bytes) {
  const chunk = Buffer.alloc(8 + bytes.length + bytes.length % 2);
  chunk.write(name, 0, 4, 'ascii');
  chunk.writeUInt32LE(bytes.length, 4);
  bytes.copy(chunk, 8);
  return chunk;
}

/** Caller owns staged-path confinement. Exclusive creation never overwrites segments. */
export function concatenatePcmWavs(paths, outputPath, { gapSec = 0.25 } = {}) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_CHUNKS) fail('invalid_segment_paths');
  if (typeof gapSec !== 'number' || !Number.isFinite(gapSec) || gapSec < 0) fail('invalid_gap');
  const segments = [];
  let totalBytes = 0;
  for (const file of paths) {
    const segment = readPcmWav(file);
    if (segments.length && !segments[0].format.equals(segment.format)) fail('incompatible_pcm_format');
    totalBytes += segment.data.length;
    if (totalBytes > MAX_WAV_BYTES) fail('concatenation_too_large');
    segments.push(segment);
  }
  const first = segments[0];
  // Quantize only the silent gap to whole sample frames; never resample speech.
  const gapFrames = Math.round(gapSec * first.sampleRate);
  const gapBytes = gapFrames * first.blockAlign;
  const dataBytes = totalBytes + gapBytes * (segments.length - 1);
  const fileBytes = 12 + 8 + first.format.length + 8 + dataBytes + dataBytes % 2;
  if (!Number.isSafeInteger(gapBytes) || !Number.isSafeInteger(fileBytes) || fileBytes > MAX_WAV_BYTES) fail('concatenation_too_large');
  const parts = [];
  const silence = segments.length > 1 ? Buffer.alloc(gapBytes, first.bitsPerSample === 8 ? 128 : 0) : null;
  for (const segment of segments) {
    if (parts.length) parts.push(silence);
    parts.push(segment.data);
  }
  const body = Buffer.concat([Buffer.from('WAVE'), wavChunk('fmt ', first.format), wavChunk('data', Buffer.concat(parts, dataBytes))]);
  const header = Buffer.alloc(8);
  header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  writeFileSync(outputPath, Buffer.concat([header, body]), { flag: 'wx' });
  return readPcmWav(outputPath);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validateAudioMetadata(transition) {
  for (const key of ['beforeAudio', 'afterAudio']) {
    const audio = transition?.[key];
    if (!exactKeys(audio, ['path', 'contentHash', 'durationSec']) || typeof audio.path !== 'string' || !audio.path.trim()
      || typeof audio.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(audio.contentHash)
      || typeof audio.durationSec !== 'number' || !Number.isFinite(audio.durationSec) || audio.durationSec <= 0) fail('invalid_audio_metadata');
  }
  if (transition.beforeAudio.durationSec <= 4.01 || transition.afterAudio.durationSec > 4.01) fail('invalid_repair_duration');
}

/** Pure CAS validation. This does not replace independent narration review or audio rereads. */
export function validateTtsRepairTransition(beforeSnapshot, transition) {
  if (beforeSnapshot?.stage !== 'tts') fail('invalid_snapshot_stage');
  if (!exactKeys(transition, ['type', 'fromRevision', 'toSnapshot', 'rowIndex', 'narration', 'beforeAudio', 'afterAudio'])
    || transition.type !== 'measured_tts_narration_repair') fail('invalid_transition');
  if (transition.fromRevision !== hashPipelineInputSnapshot(beforeSnapshot)) fail('stale_revision');
  validateAudioMetadata(transition);
  const expected = JSON.parse(stableCanonicalStringify(beforeSnapshot));
  const target = { beforeHash: scriptRepairHash(expected.script), rowIndex: transition.rowIndex, field: 'narration' };
  expected.script = applyNarrationPatch(expected.script, { ...target, newValue: transition.narration }, target);
  // The revision hash intentionally excludes providerContext, so compare full JSON
  // as well: no hidden snapshot changes may accompany a narration-only transition.
  if (stableCanonicalStringify(expected) !== stableCanonicalStringify(transition.toSnapshot)) fail('unexpected_snapshot_change');
  return hashPipelineInputSnapshot(expected);
}

/** Invoke after promotion against current paths; the overrun source must be retained. */
export function validateMeasuredRepairAudio(transition) {
  validateAudioMetadata(transition);
  const result = {};
  for (const key of ['beforeAudio', 'afterAudio']) {
    const expected = transition[key], actual = readPcmWav(expected.path);
    if (actual.contentHash !== expected.contentHash) fail(`${key}_hash_mismatch`);
    if (actual.durationSec !== expected.durationSec) fail(`${key}_duration_mismatch`);
    result[key] = actual;
  }
  return result;
}
