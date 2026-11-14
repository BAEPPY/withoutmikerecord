import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFile } from '../extension/vendor/mp4box/mp4box.all.mjs';
import { MP4_TRACK_MAX_BYTES, selectMp4Tracks } from '../extension/mp4-tracks.js';

async function fixture(name = 'av-fragmented.mp4') {
  return new Blob([await readFile(new URL(`fixtures/${name}`, import.meta.url))], { type: 'video/mp4' });
}

async function parse(blob) {
  const buffer = await blob.arrayBuffer();
  buffer.fileStart = 0;
  const file = createFile();
  file.appendBuffer(buffer);
  file.flush();
  return { buffer, file, info: file.getInfo() };
}

function track(parsed, type) {
  const info = type === 'audio' ? parsed.info.audioTracks[0] : parsed.info.videoTracks[0];
  return parsed.file.getTrackById(info.id);
}

function packetBytes(parsed, sample) {
  return Buffer.from(parsed.buffer, sample.offset, sample.size);
}

function assertPacketsEqual(input, output, type) {
  const before = track(input, type), after = track(output, type);
  assert.equal(after.samples.length, before.samples.length);
  for (let i = 0; i < before.samples.length; i++) {
    assert.deepEqual(packetBytes(output, after.samples[i]), packetBytes(input, before.samples[i]), `encoded ${type} packet ${i}`);
    assert.equal(after.samples[i].duration, before.samples[i].duration);
    assert.equal(after.samples[i].cts - after.samples[i].dts, before.samples[i].cts - before.samples[i].dts);
    assert.equal(after.samples[i].is_sync, before.samples[i].is_sync);
  }
}

for (const filename of ['av-fragmented.mp4', 'av-edited.mp4']) {
  test(`${filename}: video-only output retains all H.264 packets and contains no audio`, async () => {
    const original = await fixture(filename);
    const originalBytes = await original.arrayBuffer();
    const progress = [];
    const result = await selectMp4Tracks(original, 'video', { onProgress: (value) => progress.push(value) });
    const input = await parse(original), output = await parse(result.blob);
    assert.equal(result.content, 'video');
    assert.equal(result.kind, 'video');
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(result.blob.type, 'video/mp4');
    assert.equal(result.width, 64);
    assert.equal(result.height, 48);
    assert.ok(result.durationSeconds > 2 && result.durationSeconds < 2.2);
    assert.equal(output.info.tracks.length, 1);
    assert.equal(output.info.audioTracks.length, 0);
    assert.equal(output.info.videoTracks[0].codec, input.info.videoTracks[0].codec);
    assertPacketsEqual(input, output, 'video');
    const sourceTrack = track(input, 'video'), outputTrack = track(output, 'video');
    const sourceEntry = sourceTrack.mdia.minf.stbl.stsd.entries[0], outputEntry = outputTrack.mdia.minf.stbl.stsd.entries[0];
    assert.deepEqual(outputEntry.avcC.SPS, sourceEntry.avcC.SPS);
    assert.deepEqual(outputEntry.avcC.PPS, sourceEntry.avcC.PPS);
    assert.deepEqual(outputTrack.tkhd.matrix, sourceTrack.tkhd.matrix);
    assert.deepEqual(outputTrack.edts?.elst?.entries, sourceTrack.edts?.elst?.entries);
    assert.deepEqual(await original.arrayBuffer(), originalBytes);
    assert.equal(progress[0], 0);
    assert.equal(progress.at(-1), 1);
    assert.ok(progress.some((value) => value > 0 && value < 1));
  });

  test(`${filename}: audio-only output retains AAC packets, codec data and edits without video`, async () => {
    const original = await fixture(filename);
    const result = await selectMp4Tracks(original, 'audio');
    const input = await parse(original), output = await parse(result.blob);
    assert.equal(output.file.moov.mvhd.volume, 1, 'audio extraction must not set playback volume to zero');
    assert.equal(result.content, 'audio');
    assert.equal(result.kind, 'audio');
    assert.equal(result.mimeType, 'audio/mp4');
    assert.equal(result.width, undefined);
    assert.equal(result.height, undefined);
    assert.equal(output.info.tracks.length, 1);
    assert.equal(output.info.videoTracks.length, 0);
    assert.equal(output.info.audioTracks[0].codec, input.info.audioTracks[0].codec);
    assertPacketsEqual(input, output, 'audio');
    const sourceTrack = track(input, 'audio'), outputTrack = track(output, 'audio');
    assert.deepEqual(outputTrack.mdia.minf.stbl.stsd.entries[0].esds.data, sourceTrack.mdia.minf.stbl.stsd.entries[0].esds.data);
    assert.deepEqual(outputTrack.edts?.elst?.entries, sourceTrack.edts?.elst?.entries);
    assert.equal(outputTrack.tkhd.width, 0);
    assert.equal(outputTrack.tkhd.height, 0);
    assert.equal(outputTrack.tkhd.volume, sourceTrack.tkhd.volume);
  });
}

test('both keeps the exact original recording after validating its video and audio', async () => {
  const original = await fixture();
  const result = await selectMp4Tracks(original, 'both');
  assert.equal(result.blob, original);
  assert.equal(result.content, 'both');
  assert.equal(result.kind, 'video');
  assert.equal(result.width, 64);
  assert.equal(result.height, 48);
});

test('native Opus fragment gaps and encoder priming survive whole-track extraction', async () => {
  const original = await fixture('chrome-opus-fragmented.mp4');
  const result = await selectMp4Tracks(original, 'audio');
  const input = await parse(original), output = await parse(result.blob);
  assert.equal(output.file.moov.mvhd.volume, 1, 'Opus extraction must preserve audible movie volume');
  assert.ok(Math.abs(result.durationSeconds - 2.1890833333333333) < 0.000001);
  assertPacketsEqual(input, output, 'audio');
  const sourceTrack = track(input, 'audio'), outputTrack = track(output, 'audio');
  assert.equal(outputTrack.mdia.minf.stbl.stsd.entries[0].dOps.PreSkip, sourceTrack.mdia.minf.stbl.stsd.entries[0].dOps.PreSkip);
  const fragmentStarts = (file) => file.moofs.flatMap((moof) => moof.trafs.map((traf) => traf.tfdt.baseMediaDecodeTime));
  assert.deepEqual(fragmentStarts(output.file), fragmentStarts(input.file));
});

test('missing requested tracks return a clear error without discarding available media', async () => {
  const audio = await fixture('aac-fragmented.mp4');
  for (const content of ['both', 'video']) await assert.rejects(selectMp4Tracks(audio, content), /영상 트랙이 없어요/);
  const video = (await selectMp4Tracks(await fixture(), 'video')).blob;
  for (const content of ['both', 'audio']) await assert.rejects(selectMp4Tracks(video, content), /소리 트랙이 없어요/);
  assert.ok((await selectMp4Tracks(audio, 'audio')).blob.size > 0);
  assert.ok((await selectMp4Tracks(video, 'video')).blob.size > 0);
});

test('invalid formats, corrupted samples and over-limit files are rejected before exporting', async () => {
  const source = await fixture();
  await assert.rejects(selectMp4Tracks(source, 'anything'), /저장할 구성/);
  for (const value of [null, new Blob(), new Blob(['not an MP4']), source.slice(0, 200)]) {
    await assert.rejects(selectMp4Tracks(value, 'video'), /MP4/);
  }
  await assert.rejects(selectMp4Tracks(source.slice(0, source.size - 2000), 'both'), /MP4/);
  const large = new Blob(['small backing store'], { type: 'video/mp4' });
  Object.defineProperty(large, 'size', { value: MP4_TRACK_MAX_BYTES + 1 });
  large.arrayBuffer = () => { throw new Error('over-limit bytes must not be loaded'); };
  await assert.rejects(selectMp4Tracks(large, 'video'), /128 MiB/);
});

test('cancellation before read and between fragment copies never publishes a partial file', async () => {
  const original = await fixture('chrome-opus-fragmented.mp4');
  const originalBytes = await original.arrayBuffer();
  const early = new AbortController(); early.abort();
  await assert.rejects(selectMp4Tracks(original, 'audio', { signal: early.signal }), { name: 'AbortError' });
  const during = new AbortController();
  let progressCalled = false;
  await assert.rejects(selectMp4Tracks(original, 'audio', {
    signal: during.signal,
    onProgress: (value) => { if (value > 0.1 && value < 0.95) { progressCalled = true; during.abort(); } },
  }), { name: 'AbortError' });
  assert.equal(progressCalled, true);
  assert.deepEqual(await original.arrayBuffer(), originalBytes);
});
