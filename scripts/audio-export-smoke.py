"""Native audio-only MP4 export regression with local AAC/Opus video fixtures.

Exercises the real popup, controller, recorder and MP4 packet-copy pipeline.
Chrome messaging/download APIs are bridged; no microphone, real tab capture,
user media upload or extension-installation policy changes are involved.
"""
import asyncio
import base64
import functools
import json
import math
import os
import struct
import subprocess
import threading
from array import array
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'dist'
OUTPUT.mkdir(exist_ok=True)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def fixture(codec):
    path = OUTPUT / f'audio-export-{codec}-source.mp4'
    # The video deliberately ends after its audio, as native recordings can.
    subprocess.run([
        'ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i',
        'testsrc2=size=320x180:rate=25:duration=3.2', '-f', 'lavfi', '-i',
        f'sine=frequency=660:sample_rate={44100 if codec == "aac" else 48000}:duration=3.15',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac' if codec == 'aac' else 'libopus', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart' if codec == 'aac' else '+frag_keyframe+empty_moov', str(path),
    ], check=True)
    return path


def probe(path):
    return json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))


def packet_hashes(path):
    info = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_packets',
        '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json', str(path)]))
    return [packet['data_hash'] for packet in info['packets']]


def movie_volume(path):
    data = path.read_bytes()

    def boxes(start, end):
        while start + 8 <= end:
            size, kind = struct.unpack_from('>I4s', data, start)
            header = 8
            if size == 1:
                size = struct.unpack_from('>Q', data, start + 8)[0]
                header = 16
            elif size == 0:
                size = end - start
            assert size >= header and start + size <= end
            yield kind, start + header, start + size
            start += size

    for kind, start, end in boxes(0, len(data)):
        if kind == b'moov':
            for child, payload, _ in boxes(start, end):
                if child == b'mvhd':
                    offset = 24 if data[payload] == 0 else 36
                    return struct.unpack_from('>H', data, payload + offset)[0] / 256
    raise AssertionError('Missing MP4 movie header')


def validate(path, source_hashes, codec, complete):
    info = probe(path)
    assert len(info['streams']) == 1 and info['streams'][0]['codec_type'] == 'audio', info
    assert info['streams'][0]['codec_name'] == codec, info
    hashes = packet_hashes(path)
    assert hashes, path
    if complete:
        assert hashes == source_hashes, (path.name, len(hashes), len(source_hashes))
    else:
        assert len(hashes) < len(source_hashes)
        assert any(source_hashes[index:index + len(hashes)] == hashes
                   for index in range(len(source_hashes) - len(hashes) + 1)), path.name
    assert movie_volume(path) == 1, (path.name, movie_volume(path))
    pcm = array('f', subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(path), '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']))
    assert pcm, path
    # Exclude codec priming and packet-overlap edges from the tone measurement.
    segment = pcm[len(pcm) // 5:len(pcm) * 4 // 5]
    rms = math.sqrt(sum(value * value for value in segment) / len(segment))
    frequency = sum(left < 0 <= right for left, right in zip(segment, segment[1:])) * 48000 / len(segment)
    assert rms > 0.03 and abs(frequency - 660) < 12, (path.name, rms, frequency)
    return {'codec': codec, 'packets': len(hashes), 'duration': info['format']['duration'],
            'rms': round(rms, 5), 'toneHz': round(frequency, 2), 'movieVolume': movie_volume(path)}


async def main():
    fixtures = {codec: fixture(codec) for codec in ['aac', 'opus']}
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    summaries = {}
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True,
                args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            for codec, source_path in fixtures.items():
                context = await browser.new_context(viewport={'width': 380, 'height': 760})
                owner = await context.new_page()
                await owner.goto(f'http://127.0.0.1:{server.server_port}/extension/')
                original = await owner.evaluate('''async filename => {
                  const {TabAudioRecorder} = await import('./recorder.js');
                  const {createController} = await import('./controller.js');
                  const {inspectVideo} = await import('./video-trim.js');
                  const source = await (await fetch('../dist/'+filename)).blob();
                  const metadata = await inspectVideo(source);
                  window.encoderCalls=0;
                  const forbiddenEncoder=()=>{encoderCalls++;throw Error('Audio export invoked an encoder');};
                  window.recorder = new TabAudioRecorder({trimVideo:forbiddenEncoder,
                    MediaRecorder:forbiddenEncoder,AudioContext:forbiddenEncoder});
                  recorder.originalBlob=source;
                  Object.assign(recorder.state,{status:'ready',mode:'video',
                    result:{url:URL.createObjectURL(source),filename,bytes:source.size,
                      mimeType:'video/mp4',kind:'video',trimError:null,...metadata},
                    selection:{startSeconds:0,endSeconds:metadata.durationSeconds}});
                  window.downloaded=[];
                  window.controller=createController({
                    runtime:{getURL:path=>location.origin+'/extension/'+path,getContexts:async()=>[{}],
                      sendMessage:message=>recorder.handle(message)},
                    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
                    downloads:{download:async options=>{downloaded.push(options);return downloaded.length;},
                      search:async()=>[{state:'complete'}]}
                  });
                  return recorder.getState().result;
                }''', source_path.name)

                async def bridge(message):
                    return await owner.evaluate('(message)=>controller.handle(message)', message)

                popup = await context.new_page()
                await popup.expose_function('testBridge', bridge)
                await popup.add_init_script('window.chrome={runtime:{sendMessage:message=>window.testBridge(message)}}')
                await popup.goto(f'http://127.0.0.1:{server.server_port}/extension/popup.html')
                await popup.wait_for_selector('#save-content:visible')
                await popup.select_option('#save-content', 'audio')
                assert await popup.locator('#save-quality-field').is_hidden()
                source_hashes = packet_hashes(source_path)

                async def save(button, name):
                    count = await owner.evaluate('downloaded.length')
                    await popup.click(button)
                    await owner.wait_for_function('(count)=>downloaded.length === count+1', arg=count)
                    await popup.wait_for_function('document.querySelector("#save-button").disabled === false')
                    data = await owner.evaluate('''async()=>{
                      const buffer=await(await fetch(downloaded.at(-1).url)).arrayBuffer();
                      return btoa(String.fromCharCode(...new Uint8Array(buffer)));
                    }''')
                    path = OUTPUT / f'audio-export-{codec}-{name}.mp4'
                    path.write_bytes(base64.b64decode(data))
                    assert await owner.evaluate('encoderCalls') == 0
                    assert await owner.evaluate('recorder.getState().result.url') == original['url']
                    return path

                whole = await save('#save-button', 'whole')
                whole_metadata = await owner.evaluate('recorder.getState().videoExportResult')
                summaries[f'{codec}-whole'] = validate(whole, source_hashes, codec, True)
                await popup.fill('#trim-start', '0.51')
                await popup.fill('#trim-end', '1.73')
                await popup.locator('#trim-end').blur()
                clipped = await save('#save-range-button', 'range')
                summaries[f'{codec}-range'] = validate(clipped, source_hashes, codec, False)
                assert abs(float(probe(clipped)['format']['duration']) - 1.22) < 0.09
                # The UI's full video endpoint is later than the last audio
                # sample; audio extraction must clamp that endpoint and succeed.
                assert original['durationSeconds'] > whole_metadata['durationSeconds'], (original, whole_metadata)
                end = math.floor(original['durationSeconds'] * 100) / 100
                assert end > whole_metadata['durationSeconds'], (end, whole_metadata)
                await popup.fill('#trim-start', '0.00')
                await popup.fill('#trim-end', f'{end:.2f}')
                await popup.locator('#trim-end').blur()
                full_range = await save('#save-range-button', 'full-range')
                summaries[f'{codec}-full-range'] = validate(full_range, source_hashes, codec, True)
                exported = await owner.evaluate('recorder.getState().exportResult')
                assert abs(exported['durationSeconds'] - whole_metadata['durationSeconds']) < 0.001, exported
                assert exported['endSeconds'] <= whole_metadata['durationSeconds'] + 0.001, exported
                await context.close()
            print(json.dumps({'exports': summaries,
                              'checks': 'AAC/Opus whole and range audio packet identity, audible PCM, unity movie volume, later video endpoint clamp, no encoder, original preserved',
                              'scope': 'real popup/controller/recorder and local MP4 packets; Chrome API bridge, synthetic fixtures'}, ensure_ascii=False))
            await browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    asyncio.run(main())
