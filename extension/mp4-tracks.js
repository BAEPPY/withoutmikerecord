import { DataStream, createFile } from './vendor/mp4box/mp4box.all.mjs';

export const MP4_TRACK_MAX_BYTES = 128 * 1024 * 1024;
const MAX_TRACK_SAMPLES = 500_000;
const FRAGMENT_SAMPLES = 256;
const INVALID_MP4 = 'MP4 트랙 정보를 읽지 못했어요. 전체 원본은 그대로 저장할 수 있어요.';

function checkAbort(signal) {
  if (!signal?.aborted) return;
  const error = new Error('저장 준비를 취소했어요. 원본 녹화는 그대로 남아 있어요.');
  error.name = 'AbortError';
  throw error;
}

function yieldTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// MP4Box 2.4.1 otherwise accumulates fragment durations, losing the explicit
// native MediaRecorder decode timestamps and any gaps between fragments.
function restoreFragmentTimestamps(file, track) {
  let index = track.samples.findIndex((sample) => sample.moof_number !== undefined);
  if (index < 0) return;
  for (const moof of file.moofs) {
    for (const fragment of moof.trafs) {
      if (fragment.tfhd.track_id !== track.tkhd.track_id) continue;
      let dts = fragment.tfdt?.baseMediaDecodeTime ?? track.samples[index]?.dts;
      for (const run of fragment.truns) {
        for (let i = 0; i < run.sample_count; i++) {
          const sample = track.samples[index++];
          if (!sample || !Number.isFinite(dts)) throw new Error(INVALID_MP4);
          sample.cts += dts - sample.dts;
          sample.dts = dts;
          dts += sample.duration;
        }
      }
    }
  }
}

function inspectTrack(file, info, trackInfo, byteLength) {
  const track = file.getTrackById(trackInfo.id);
  const entries = track?.mdia?.minf?.stbl?.stsd?.entries;
  if (entries?.length !== 1 || ['encv', 'enca'].includes(entries[0]?.type)
    || !Number.isFinite(trackInfo.timescale) || trackInfo.timescale <= 0
    || !track.samples?.length || track.samples.length > MAX_TRACK_SAMPLES) throw new Error(INVALID_MP4);
  restoreFragmentTimestamps(file, track);
  let end = 0;
  let decodeEnd = 0;
  for (const sample of track.samples) {
    if (!Number.isSafeInteger(sample.dts) || sample.dts < 0 || !Number.isSafeInteger(sample.cts)
      || !Number.isSafeInteger(sample.duration) || sample.duration <= 0
      || !Number.isSafeInteger(sample.offset) || sample.offset < 0
      || !Number.isSafeInteger(sample.size) || sample.size <= 0
      || sample.offset + sample.size > byteLength || sample.description_index !== 0) throw new Error(INVALID_MP4);
    end = Math.max(end, sample.cts + sample.duration);
    decodeEnd = Math.max(decodeEnd, sample.dts + sample.duration);
  }
  let durationSeconds = end / trackInfo.timescale;
  const edits = track.edts?.elst?.entries;
  if (edits?.length) {
    // Preserve the complete edit list, including encoder priming and empty
    // leading edits. Its durations use the original movie timescale.
    if (edits.some((edit) => !Number.isFinite(edit.segment_duration) || edit.segment_duration < 0
      || !Number.isFinite(edit.media_time) || edit.media_time < -1
      || edit.media_rate_integer !== 1 || edit.media_rate_fraction !== 0)) throw new Error(INVALID_MP4);
    durationSeconds = edits.reduce((sum, edit) => sum + edit.segment_duration, 0) / info.timescale;
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(INVALID_MP4);
  return { track, trackInfo, entry: entries[0], durationSeconds, mediaDuration: Math.max(end, decodeEnd) };
}

function resultMetadata(selected, content) {
  const kind = content === 'audio' ? 'audio' : 'video';
  const video = selected.find(({ trackInfo }) => trackInfo.type === 'video' || trackInfo.video);
  return {
    content, kind, mimeType: kind === 'audio' ? 'audio/mp4' : 'video/mp4',
    durationSeconds: Math.max(...selected.map((item) => item.durationSeconds)),
    ...(video ? { width: video.entry.width, height: video.entry.height } : {}),
  };
}

/**
 * Remove unselected tracks without decoding or re-encoding any media samples.
 * The caller owns the immutable original. Blob slices avoid building a second
 * large JavaScript buffer containing all the copied compressed sample bytes.
 */
export async function selectMp4Tracks(blob, content, { signal, onProgress = () => {} } = {}) {
  checkAbort(signal);
  if (!['both', 'audio', 'video'].includes(content)) throw new Error('저장할 구성을 영상과 소리, 소리만, 영상만 중에서 선택해 주세요.');
  if (!(blob instanceof Blob) || !blob.size) throw new Error('저장할 MP4 녹화 파일이 없습니다.');
  if (blob.size > MP4_TRACK_MAX_BYTES) throw new Error('트랙 분리 한도인 128 MiB를 넘었어요. 더 짧은 구간을 선택하거나 전체 원본을 저장해 주세요.');
  onProgress(0);
  checkAbort(signal);
  let file;
  let info;
  let buffer;
  try {
    buffer = await blob.arrayBuffer();
    checkAbort(signal);
    buffer.fileStart = 0;
    file = createFile();
    let parseError = null;
    file.onError = (error) => { parseError = error; };
    file.appendBuffer(buffer);
    file.flush();
    if (parseError || !file.moov) throw new Error(INVALID_MP4);
    info = file.getInfo();
    if (!Number.isFinite(info.timescale) || info.timescale <= 0) throw new Error(INVALID_MP4);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error(INVALID_MP4);
  }
  checkAbort(signal);
  onProgress(0.1);
  if ((content === 'audio' || content === 'both') && !info.audioTracks.length) {
    throw new Error('이 녹화에는 소리 트랙이 없어요. 영상만 저장해 주세요.');
  }
  if ((content === 'video' || content === 'both') && !info.videoTracks.length) {
    throw new Error('이 녹화에는 영상 트랙이 없어요. 소리만 저장해 주세요.');
  }
  if (info.audioTracks.length > 1 || info.videoTracks.length > 1) throw new Error('여러 트랙이 있는 MP4는 분리할 수 없어요. 전체 원본을 저장해 주세요.');
  const trackInfos = content === 'both' ? [info.videoTracks[0], info.audioTracks[0]]
    : content === 'audio' ? info.audioTracks : info.videoTracks;
  const selected = trackInfos.map((trackInfo) => inspectTrack(file, info, trackInfo, buffer.byteLength));
  const metadata = resultMetadata(selected, content);
  checkAbort(signal);
  if (content === 'both') {
    onProgress(1);
    checkAbort(signal);
    return { ...metadata, blob: /^video\/mp4(?:;|$)/i.test(blob.type) ? blob : blob.slice(0, blob.size, metadata.mimeType) };
  }
  await yieldTask();
  checkAbort(signal);
  const { track, trackInfo, entry, mediaDuration, durationSeconds } = selected[0];
  const output = createFile();
  const movieDuration = Math.round(durationSeconds * info.timescale);
  output.init({ timescale: info.timescale, duration: movieDuration, brands: ['isom', 'iso6', 'mp41'] });
  const id = output.addTrack({
    type: entry.type,
    hdlr: content === 'audio' ? 'soun' : 'vide',
    timescale: trackInfo.timescale,
    duration: movieDuration,
    media_duration: mediaDuration,
    width: entry.width,
    height: entry.height,
    samplerate: entry.samplerate,
    channel_count: entry.channel_count,
    samplesize: entry.samplesize,
    language: trackInfo.language || 'und',
    name: content === 'audio' ? 'Without Mic audio' : 'Without Mic video',
  });
  const outputTrack = output.getTrackById(id);
  if (!outputTrack) throw new Error(INVALID_MP4);
  outputTrack.tkhd.width = content === 'audio' ? 0 : track.tkhd.width;
  outputTrack.tkhd.height = content === 'audio' ? 0 : track.tkhd.height;
  outputTrack.tkhd.matrix = [...track.tkhd.matrix];
  outputTrack.tkhd.volume = track.tkhd.volume;
  outputTrack.mdia.minf.stbl.stsd.entries = [entry];
  if (track.edts) outputTrack.addBox(track.edts);
  const parts = [output.getBuffer().buffer];
  let outputBytes = parts[0].byteLength;
  for (let offset = 0; offset < track.samples.length;) {
    checkAbort(signal);
    let next = offset + 1;
    // A fragment can describe consecutive decode times only. Keep native gaps
    // in separate fragments instead of compressing the recording's timeline.
    while (next < track.samples.length && next - offset < FRAGMENT_SAMPLES
      && track.samples[next].dts === track.samples[next - 1].dts + track.samples[next - 1].duration) next++;
    const group = track.samples.slice(offset, next).map((sample) => ({ ...sample, track_id: id }));
    const fragment = output.createMoof(group);
    const run = fragment.trafs[0].truns[0];
    // B-frame codecs may need signed composition offsets.
    if (group.some((sample) => sample.cts < sample.dts)) run.version = 1;
    fragment.computeSize();
    run.data_offset = fragment.size + 8;
    const stream = new DataStream();
    fragment.write(stream);
    const payloadSize = group.reduce((sum, sample) => sum + sample.size, 0);
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, payloadSize + 8);
    header.set([0x6d, 0x64, 0x61, 0x74], 4);
    outputBytes += stream.buffer.byteLength + header.byteLength + payloadSize;
    if (outputBytes > MP4_TRACK_MAX_BYTES) throw new Error('분리한 파일이 128 MiB를 넘었어요. 더 짧은 구간을 선택해 주세요.');
    parts.push(stream.buffer, header);
    // Coalesce adjacent packets into one slice, without including bytes from
    // the removed track when source packets were interleaved.
    let from = group[0].offset;
    let until = from + group[0].size;
    for (let i = 1; i < group.length; i++) {
      const sample = group[i];
      if (sample.offset === until) until += sample.size;
      else {
        parts.push(blob.slice(from, until));
        from = sample.offset;
        until = from + sample.size;
      }
    }
    parts.push(blob.slice(from, until));
    offset = next;
    onProgress(0.1 + 0.85 * offset / track.samples.length);
    if (offset < track.samples.length) await yieldTask();
  }
  checkAbort(signal);
  const result = new Blob(parts, { type: metadata.mimeType });
  onProgress(1);
  checkAbort(signal);
  return { ...metadata, blob: result };
}
