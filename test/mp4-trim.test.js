import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectMp4, trimMp4 } from '../extension/mp4-trim.js';
import { createFile } from '../extension/vendor/mp4box/mp4box.all.mjs';

async function fixture(name) {
  return new Blob([await readFile(new URL(`fixtures/${name}`, import.meta.url))], { type: 'audio/mp4' });
}

async function parse(blob) {
  const buffer = await blob.arrayBuffer();
  buffer.fileStart = 0;
  const file = createFile();
  file.appendBuffer(buffer);
  file.flush();
  const info = file.getInfo();
  const track = file.getTrackById(info.audioTracks[0].id);
  return { buffer, file, info, track };
}

function packetBytes(parsed, sample) {
  return Buffer.from(parsed.buffer, sample.offset, sample.size);
}

// Native Chrome records several fragments with non-contiguous tfdt values.
// This expected value was independently measured with ffprobe, not MP4Box.
test('measures every native Chrome Opus fragment with its own decode timestamp', async () => {
  const { durationSeconds } = await inspectMp4(await fixture('chrome-opus-fragmented.mp4'));
  assert.ok(Math.abs(durationSeconds - 2.1890833333333333) < 0.000001);
});

for (const [filename, codec, channels] of [
  ['aac-fragmented.mp4', 'mp4a.40.2', 1],
  ['chrome-opus-fragmented.mp4', 'Opus', 2],
]) {
  test(`cuts a middle range of ${codec} into a playable MP4 structure without re-encoding`, async () => {
    const source = await fixture(filename);
    const originalBytes = await source.arrayBuffer();
    const clip = await trimMp4(source, 0.4, 1.3);
    assert.equal(clip.blob.type, 'audio/mp4');
    assert.ok(clip.blob.size < source.size);
    assert.ok(clip.startSeconds <= 0.4 && clip.startSeconds > 0.3);
    assert.ok(clip.endSeconds >= 1.3 && clip.endSeconds < 1.4);
    assert.ok(clip.durationSeconds >= 0.9 && clip.durationSeconds < 1.1);
    const output = await parse(clip.blob);
    const input = await parse(source);
    assert.equal(output.info.tracks.length, 1);
    assert.equal(output.info.audioTracks[0].codec, codec);
    assert.equal(output.info.audioTracks[0].audio.channel_count, channels);
    assert.equal(output.info.audioTracks[0].audio.sample_rate, 48000);
    assert.equal(output.track.samples[0].dts, 0);
    assert.ok(output.track.samples.length < input.track.samples.length);
    // Every output packet must be an unchanged, contiguous subsequence of input.
    const first = input.track.samples.findIndex((sample) => packetBytes(input, sample)
      .equals(packetBytes(output, output.track.samples[0])));
    assert.ok(first > 0);
    for (const [index, sample] of output.track.samples.entries()) {
      assert.deepEqual(packetBytes(output, sample), packetBytes(input, input.track.samples[first + index]));
    }
    assert.deepEqual(await source.arrayBuffer(), originalBytes);
    const measured = await inspectMp4(clip.blob);
    assert.ok(Math.abs(measured.durationSeconds - clip.durationSeconds) < 0.000001);
    if (codec === 'Opus') assert.equal(output.track.mdia.minf.stbl.stsd.entries[0].dOps.PreSkip, 0);
    else assert.deepEqual(output.track.mdia.minf.stbl.stsd.entries[0].esds.data,
      input.track.mdia.minf.stbl.stsd.entries[0].esds.data);
  });
}

test('full-range export preserves the original MP4 and encoder priming', async () => {
  const source = await fixture('chrome-opus-fragmented.mp4');
  const { durationSeconds } = await inspectMp4(source);
  const clip = await trimMp4(source, 0, durationSeconds);
  assert.equal(clip.blob, source);
  assert.equal(clip.startSeconds, 0);
  assert.equal(clip.endSeconds, durationSeconds);
});

test('retains original Opus priming when exporting from the beginning', async () => {
  const source = await fixture('chrome-opus-fragmented.mp4');
  const input = await parse(source);
  const output = await parse((await trimMp4(source, 0, 1)).blob);
  assert.equal(output.track.mdia.minf.stbl.stsd.entries[0].dOps.PreSkip,
    input.track.mdia.minf.stbl.stsd.entries[0].dOps.PreSkip);
});

test('allows a very short selection and a range ending at the final sample', async () => {
  const source = await fixture('aac-fragmented.mp4');
  const { durationSeconds } = await inspectMp4(source);
  const clip = await trimMp4(source, durationSeconds - 0.001, durationSeconds);
  const output = await parse(clip.blob);
  assert.equal(output.track.samples.length, 1);
  assert.ok(clip.durationSeconds > 0);
  assert.equal(clip.endSeconds, durationSeconds);
});

test('rejects invalid, reversed, nonnumeric, and out-of-recording ranges', async () => {
  const source = await fixture('aac-fragmented.mp4');
  for (const [start, end] of [[-1, 1], [1, 1], [1.1, 1], [0, NaN], [Infinity, 1], ['0', 1], [0, 9], [9, 10]]) {
    await assert.rejects(trimMp4(source, start, end));
  }
});

test('rejects empty, malformed, and truncated MP4 data', async () => {
  for (const data of [[], ['this is not MP4'], [(await fixture('aac-fragmented.mp4')).slice(0, 100)]]) {
    await assert.rejects(inspectMp4(new Blob(data)), /MP4 오디오 정보를 읽지 못했습니다/);
  }
});
