import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertStaged, inside, writeWav, blockedCalls } from './pipeline-stage-mock.mjs';

export default async function mockVox(job, { signal }) {
  const dataRoot = path.resolve(process.env.DINOBOX_DATA_DIR);
  assertStaged(dataRoot);
  signal.throwIfAborted();
  assert.equal(job.kind, 'script');
  assert.equal(job.outputs.length, 7, 'Actual buildTtsSegmentsFromScript must produce seven meaningful rows');
  assert.ok(inside(dataRoot, path.resolve(job.referenceAudioPath)), 'Voice reference must be staged');
  assert.ok(fs.readFileSync(job.referenceAudioPath).length > 44);
  const outputs = job.outputs.map((output, index) => {
    assert.equal(output.index, index + 1);
    assert.ok(output.text.trim().length > 0);
    assert.ok(inside(dataRoot, path.resolve(output.path)));
    writeWav(output.path, 4);
    return { ...output, durationSec: 4 };
  });
  assert.ok(inside(dataRoot, path.resolve(job.outputMasterPath)));
  writeWav(job.outputMasterPath, 28);
  fs.writeFileSync(path.join(path.dirname(job.outputMasterPath), 'VOX_MOCK_RECEIPT.json'), JSON.stringify({
    pid: process.pid, dataRoot, actualGenerateTts: true, mockedVoxOnly: true,
    texts: outputs.map(output => output.text), durations: outputs.map(output => output.durationSec)
  }));
  signal.throwIfAborted();
  assert.deepEqual(blockedCalls, []);
  return { outputs, master: { path: job.outputMasterPath, durationSec: 28 } };
}
