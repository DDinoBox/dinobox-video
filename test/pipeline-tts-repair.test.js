import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readPcmWav, concatenatePcmWavs, validateTtsRepairTransition, validateMeasuredRepairAudio } from '../lib/pipeline-tts-repair.js';
import { hashPipelineInputSnapshot } from '../lib/pipeline-contract.js';

function root() { mkdirSync('tmp', { recursive: true }); return mkdtempSync(path.resolve('tmp/tts-repair-')); }
function chunk(name, body) {
  const result = Buffer.alloc(8 + body.length + body.length % 2);
  result.write(name); result.writeUInt32LE(body.length, 4); body.copy(result, 8); return result;
}
function wav({ bits = 16, channels = 1, rate = 100, frames = 10, fill = 7, tag = 1, extra = [] } = {}) {
  const fmt = Buffer.alloc(16), align = channels * bits / 8;
  fmt.writeUInt16LE(tag, 0); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * align, 8); fmt.writeUInt16LE(align, 12); fmt.writeUInt16LE(bits, 14);
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), ...extra, chunk('data', Buffer.alloc(frames * align, fill))]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body]);
}
function save(dir, name, bytes) { const file = path.join(dir, name); writeFileSync(file, bytes); return file; }
function snapshot() {
  return { schemaVersion: 1, topicId: 1, stage: 'tts', fact: { id: 2 }, brief: null,
    script: { id: 3, productionScript: [
      { narration: '화면 속 물이 수로를 따라 흐릅니다.', visualStateId: 'flow', claimRefs: ['c1'], order: 1 },
      { narration: '바퀴가 회전합니다.', visualStateId: 'wheel', claimRefs: ['c2'], order: 2 }
    ], ttsText: '화면 속 물이 수로를 따라 흐릅니다. 바퀴가 회전합니다.' },
    providerContext: { preserved: true } };
}
function transition(before = snapshot()) {
  const toSnapshot = structuredClone(before), narration = '수로를 따라 물이 흐릅니다.';
  toSnapshot.script.productionScript[0].narration = narration;
  toSnapshot.script.ttsText = toSnapshot.script.productionScript.map(row => row.narration).join(' ');
  return { type: 'measured_tts_narration_repair', fromRevision: hashPipelineInputSnapshot(before), toSnapshot, rowIndex: 1, narration,
    beforeAudio: { path: 'old.wav', contentHash: 'a'.repeat(64), durationSec: 4.02 },
    afterAudio: { path: 'new.wav', contentHash: 'b'.repeat(64), durationSec: 4.01 } };
}

for (const bits of [8, 16, 24, 32]) test(`measure PCM ${bits}-bit from frames, preserving bytes`, () => {
  const dir = root(), bytes = wav({ bits, channels: 2, frames: 13, extra: [chunk('JUNK', Buffer.from([1]))] });
  const file = save(dir, 'source.wav', bytes), result = readPcmWav(file);
  assert.equal(result.durationSec, 0.13); assert.equal(result.sampleRate, 100);
  assert.equal(result.channels, 2); assert.equal(result.bitsPerSample, bits); assert.equal(result.blockAlign, bits / 8 * 2);
  assert.equal(result.format.length, 16); assert.deepEqual(result.data, Buffer.alloc(13 * result.blockAlign, 7));
  assert.equal(result.contentHash, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(readFileSync(file), bytes);
});

test('reject malformed RIFF, truncated chunks, invalid sample format/rates/alignment', () => {
  const dir = root();
  const invalid = [Buffer.alloc(4), wav().subarray(0, -1), Buffer.concat([wav(), Buffer.from([0])]), wav({ tag: 3 })];
  for (const [offset, value, width] of [[0, 0, 4], [8, 0, 4], [4, 0, 4], [16, 0xffffffff, 4], [22, 0, 2], [24, 0, 4], [28, 1, 4], [32, 1, 2], [34, 12, 2], [40, 3, 4]]) {
    const bytes = wav(); bytes[width === 2 ? 'writeUInt16LE' : 'writeUInt32LE'](value, offset); invalid.push(bytes);
  }
  invalid.push(wav({ frames: 0 }));
  for (const offset of [0, 8, 12, 36]) { const bytes = wav(); bytes[offset] |= 128; invalid.push(bytes); }
  const unaligned = wav({ bits: 8, frames: 3 });
  unaligned.writeUInt16LE(16, 34); unaligned.writeUInt16LE(2, 32); unaligned.writeUInt32LE(200, 28); invalid.push(unaligned);
  invalid.push(wav({ extra: Array.from({ length: 10000 }, () => chunk('JUNK', Buffer.alloc(0))) }));
  invalid.forEach((bytes, index) => assert.throws(() => readPcmWav(save(dir, `${index}.wav`, bytes))));
});

test('reject duplicate fmt/data chunks and missing odd-chunk padding', () => {
  const dir = root(), fmt = wav().subarray(20, 36);
  for (const [name, extra] of [['fmt', chunk('fmt ', fmt)], ['data', chunk('data', Buffer.from([0, 0]))]]) {
    assert.throws(() => readPcmWav(save(dir, `${name}.wav`, wav({ extra: [extra] }))));
  }
  const bytes = wav({ bits: 8, frames: 1 }).subarray(0, -1);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  assert.throws(() => readPcmWav(save(dir, 'padding.wav', bytes)));
});

for (const bits of [8, 16, 24, 32]) test(`concatenate PCM ${bits}-bit without changing any segment sample`, () => {
  const dir = root(), first = save(dir, 'first.wav', wav({ bits, frames: 11, fill: 42 }));
  const second = save(dir, 'second.wav', wav({ bits, frames: 17, fill: 73 }));
  const firstBytes = readFileSync(first), secondBytes = readFileSync(second);
  const output = path.join(dir, 'joined.wav'), result = concatenatePcmWavs([first, second], output);
  assert.equal(result.durationSec, 0.53);
  assert.deepEqual(result.data, Buffer.concat([readPcmWav(first).data, Buffer.alloc(25 * bits / 8, bits === 8 ? 128 : 0), readPcmWav(second).data]));
  assert.deepEqual(readFileSync(first), firstBytes); assert.deepEqual(readFileSync(second), secondBytes);
  assert.throws(() => concatenatePcmWavs([first], output), /EEXIST/);
  assert.throws(() => concatenatePcmWavs([first], first), /EEXIST/);
  assert.deepEqual(readFileSync(first), firstBytes);
});

test('concat rejects incompatible fmt and invalid gaps; zero gap preserves data', () => {
  const dir = root(), first = save(dir, 'first.wav', wav());
  const second = save(dir, 'second.wav', wav({ rate: 200 }));
  assert.throws(() => concatenatePcmWavs([first, second], path.join(dir, 'bad.wav')), /format/);
  for (const gapSec of [-1, NaN, Infinity, '0']) assert.throws(() => concatenatePcmWavs([first], path.join(dir, 'bad-gap.wav'), { gapSec }));
  assert.throws(() => concatenatePcmWavs([], path.join(dir, 'empty.wav')));
  assert.deepEqual(concatenatePcmWavs([first, first], path.join(dir, 'zero.wav'), { gapSec: 0 }).data, Buffer.concat([readPcmWav(first).data, readPcmWav(first).data]));
});

test('transition is exact single narration patch plus ttsText; inputs immutable', () => {
  const before = snapshot(), tr = transition(before), savedBefore = JSON.stringify(before), savedTr = JSON.stringify(tr);
  assert.equal(validateTtsRepairTransition(before, tr), hashPipelineInputSnapshot(tr.toSnapshot));
  assert.equal(JSON.stringify(before), savedBefore); assert.equal(JSON.stringify(tr), savedTr);
});

test('reject stale revision, wrong stage/type/index, unknown fields, or insufficient measured repair', () => {
  const before = snapshot();
  for (const edits of [{ fromRevision: '0'.repeat(64) }, { type: 'other' }, { rowIndex: 0 }, { rowIndex: 2 }, { rowIndex: '1' }, { extra: true },
    { beforeAudio: { path: 'a', contentHash: 'a'.repeat(64), durationSec: 4.01 } },
    ...[0, -1, 4.01001, NaN, Infinity, '4'].map(durationSec => ({ afterAudio: { path: 'b', contentHash: 'b'.repeat(64), durationSec } })),
    { afterAudio: { path: 'b', contentHash: 'bad', durationSec: 3 } },
    { afterAudio: { path: '', contentHash: 'b'.repeat(64), durationSec: 3 } }]) {
    assert.throws(() => validateTtsRepairTransition(before, { ...transition(before), ...edits }));
  }
  const wrong = snapshot(); wrong.stage = 'shotlist';
  assert.throws(() => validateTtsRepairTransition(wrong, transition(wrong)));
});

test('reject all collateral snapshot changes, including hash-excluded providerContext', () => {
  for (const mutate of [s => { s.fact.id++; }, s => { s.script.productionScript.reverse(); },
    s => { s.script.productionScript[0].claimRefs.push('c9'); }, s => { s.script.productionScript[1].narration = '다른 문장'; },
    s => { s.script.ttsText = 'bad'; }, s => { s.extra = 1; }, s => { s.providerContext.preserved = false; }]) {
    const before = snapshot(), tr = transition(before); mutate(tr.toSnapshot);
    assert.throws(() => validateTtsRepairTransition(before, tr), /snapshot/);
  }
});

test('transition retains narration numerical and conditional guards', () => {
  for (const narration of ['물이 2초 흐릅니다.', '물이 내려오면 흐릅니다.']) {
    const before = snapshot(), tr = transition(before); tr.narration = narration;
    assert.throws(() => validateTtsRepairTransition(before, tr), /numeric|condition/);
  }
});

test('measured validation rereads retained before/after files and rejects metadata drift', () => {
  const dir = root(), before = save(dir, 'before.wav', wav({ frames: 402 })), after = save(dir, 'after.wav', wav({ frames: 401 }));
  const metadata = file => { const { contentHash, durationSec } = readPcmWav(file); return { path: file, contentHash, durationSec }; };
  const tr = transition(); tr.beforeAudio = metadata(before); tr.afterAudio = metadata(after);
  const result = validateMeasuredRepairAudio(tr);
  assert.equal(result.beforeAudio.durationSec, 4.02); assert.equal(result.afterAudio.durationSec, 4.01);
  const altered = structuredClone(tr); altered.afterAudio.durationSec = 4;
  assert.throws(() => validateMeasuredRepairAudio(altered), /duration/);
  writeFileSync(after, wav({ frames: 401, fill: 8 }));
  assert.throws(() => validateMeasuredRepairAudio(tr), /hash/);
  assert.deepEqual(readFileSync(before), wav({ frames: 402 }));
});
