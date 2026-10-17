import { BoxParser, DataStream, createFile } from './vendor/mp4box/mp4box.all.mjs';

const FRAGMENT_SAMPLES = 256;
const INVALID_RECORDING = 'MP4 오디오 정보를 읽지 못했습니다. 전체 파일을 저장하거나 다시 녹음해 주세요.';

/**
 * MP4Box 2.4.1 accumulates fragment durations and ignores later tfdt values.
 * MediaRecorder writes an explicit decode timestamp on every fragment, so
 * restore those timestamps before measuring or selecting the recording.
 */
function restoreFragmentTimestamps(file, track) {
  let index = track.samples.findIndex((sample) => sample.moof_number !== undefined);
  if (index < 0) return;
  for (const moof of file.moofs) {
    for (const fragment of moof.trafs) {
      if (fragment.tfhd.track_id !== track.tkhd.track_id) continue;
      let dts = fragment.tfdt?.baseMediaDecodeTime ?? track.samples[index]?.dts;
      for (const run of fragment.truns) {
        for (let i = 0; i < run.sample_count; i += 1) {
          const sample = track.samples[index++];
          if (!sample || !Number.isFinite(dts)) throw new Error(INVALID_RECORDING);
          sample.cts += dts - sample.dts;
          sample.dts = dts;
          dts += sample.duration;
        }
      }
    }
  }
}

async function parseRecording(blob) {
  try {
    const buffer = await blob.arrayBuffer();
    buffer.fileStart = 0;
    const file = createFile();
    let parseError = null;
    file.onError = (error) => { parseError = error; };
    file.appendBuffer(buffer);
    file.flush();
    if (parseError || !file.moov) throw new Error(INVALID_RECORDING);
    const info = file.getInfo();
    if (info.audioTracks.length !== 1 || info.tracks.length !== 1) throw new Error(INVALID_RECORDING);
    const trackInfo = info.audioTracks[0];
    const track = file.getTrackById(trackInfo.id);
    const entries = track.mdia.minf.stbl.stsd.entries;
    const entry = entries[0];
    if (entries.length !== 1 || !['mp4a', 'Opus'].includes(entry?.type)
      || !Number.isFinite(trackInfo.timescale) || trackInfo.timescale <= 0
      || !track.samples.length) throw new Error(INVALID_RECORDING);
    restoreFragmentTimestamps(file, track);

    // Native recordings have no edit list. Also support a single normal edit
    // (commonly used for AAC encoder priming) without shifting the selected range.
    const edits = track.edts?.elst?.entries;
    let origin = 0;
    let limit = Infinity;
    if (edits?.length) {
      if (edits.length !== 1 || edits[0].media_time < 0
        || edits[0].media_rate_integer !== 1 || edits[0].media_rate_fraction !== 0) {
        throw new Error(INVALID_RECORDING);
      }
      origin = edits[0].media_time;
      limit = origin + edits[0].segment_duration * trackInfo.timescale / info.timescale;
    }
    let end = origin;
    for (const sample of track.samples) {
      if (!Number.isFinite(sample.cts) || !Number.isFinite(sample.dts)
        || !Number.isFinite(sample.duration) || sample.duration <= 0
        || !Number.isSafeInteger(sample.offset) || !Number.isSafeInteger(sample.size)
        || sample.offset < 0 || sample.size <= 0 || sample.offset + sample.size > buffer.byteLength
        || sample.description_index !== 0) throw new Error(INVALID_RECORDING);
      end = Math.max(end, sample.cts + sample.duration);
    }
    end = Math.min(end, limit);
    const durationSeconds = (end - origin) / trackInfo.timescale;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(INVALID_RECORDING);
    return { buffer, trackInfo, track, entry, origin, end, durationSeconds };
  } catch {
    throw new Error(INVALID_RECORDING);
  }
}

/** Measure the complete sample timeline, including all MediaRecorder fragments. */
export async function inspectMp4(blob) {
  const { durationSeconds } = await parseRecording(blob);
  return { durationSeconds };
}

/**
 * Copy encoded audio packets into a new audio-only MP4, entirely on-device.
 * Boundaries include overlapping packets; actual bounds are returned to callers.
 * No decoding, re-encoding, microphone permission, or large PCM buffer is needed.
 */
export async function trimMp4(blob, startSeconds, endSeconds) {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
    || startSeconds < 0 || endSeconds <= startSeconds) {
    throw new Error('시작과 끝 시간을 확인해 주세요. 끝 시간은 시작 시간보다 뒤여야 합니다.');
  }
  const source = await parseRecording(blob);
  const { buffer, trackInfo, track, entry, origin, durationSeconds } = source;
  if (startSeconds >= durationSeconds || endSeconds > durationSeconds + 0.001) {
    throw new Error('잘라낼 구간은 녹음 시간 안에 있어야 합니다.');
  }
  endSeconds = Math.min(endSeconds, durationSeconds);
  if (startSeconds === 0 && endSeconds === durationSeconds) {
    return { blob, durationSeconds, startSeconds: 0, endSeconds: durationSeconds };
  }
  const timescale = trackInfo.timescale;
  const from = origin + startSeconds * timescale;
  const until = origin + endSeconds * timescale;
  const selected = track.samples.filter((sample) => sample.cts + sample.duration > from
    && sample.cts < until);
  if (!selected.length) throw new Error('선택한 구간에 저장할 소리가 없습니다. 다른 구간을 선택해 주세요.');
  const baseDts = selected[0].dts;
  const firstCts = selected[0].cts;
  let lastEnd = firstCts;
  for (const sample of selected) lastEnd = Math.max(lastEnd, sample.cts + sample.duration);
  const mediaDuration = lastEnd - baseDts;

  const output = createFile();
  output.init({ timescale, duration: mediaDuration, brands: ['isom', 'iso6', 'mp41'] });
  // MP4Box 2.4.1 initializes this as fixed-point 256, but its writer shifts
  // again and overflows to zero. Use unity so players do not mute the movie.
  output.moov.mvhd.volume = 1;
  const id = output.addTrack({
    type: entry.type,
    hdlr: 'soun',
    timescale,
    duration: mediaDuration,
    media_duration: mediaDuration,
    samplerate: entry.samplerate,
    channel_count: entry.channel_count,
    samplesize: entry.samplesize,
    language: trackInfo.language || 'und',
    name: 'Without Mic audio',
  });
  const outputTrack = output.getTrackById(id);
  outputTrack.tkhd.width = 0;
  outputTrack.tkhd.height = 0;
  // Preserve the actual codec initialization (AAC esds or Opus dOps), channel
  // mapping, and every other sample-entry field instead of guessing codec data.
  outputTrack.mdia.minf.stbl.stsd.entries = [entry];
  // Encoder priming belongs only to the original beginning. Applying it again
  // after removing that beginning would discard part of the requested audio.
  if (entry.dOps && selected[0] !== track.samples[0]) entry.dOps.PreSkip = 0;
  const parts = [output.getBuffer().buffer];

  for (let offset = 0; offset < selected.length;) {
    let next = offset + 1;
    // Keep timeline gaps at fragment boundaries rather than flattening them.
    while (next < selected.length && next - offset < FRAGMENT_SAMPLES
      && selected[next].dts === selected[next - 1].dts + selected[next - 1].duration) next += 1;
    const group = selected.slice(offset, next).map((sample) => ({
      ...sample, track_id: id, cts: sample.cts - baseDts, dts: sample.dts - baseDts,
    }));
    const fragment = output.createMoof(group);
    fragment.computeSize();
    fragment.trafs[0].truns[0].data_offset = fragment.size + 8;
    const mdat = new BoxParser.box.mdat();
    mdat.data = new Uint8Array(group.reduce((size, sample) => size + sample.size, 0));
    let dataOffset = 0;
    for (const sample of group) {
      mdat.data.set(new Uint8Array(buffer, sample.offset, sample.size), dataOffset);
      dataOffset += sample.size;
    }
    const stream = new DataStream();
    fragment.write(stream);
    mdat.write(stream);
    parts.push(stream.buffer);
    offset = next;
    // A long recording must still allow status polling in the offscreen document.
    if (offset < selected.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    blob: new Blob(parts, { type: 'audio/mp4' }),
    durationSeconds: mediaDuration / timescale,
    startSeconds: Math.max(0, (firstCts - origin) / timescale),
    endSeconds: Math.min(durationSeconds, (lastEnd - origin) / timescale),
  };
}
