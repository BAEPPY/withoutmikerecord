"""Save-time quality integration: real popup, native MP4/GIF encoders and clipboard.

The source is a local synthetic 1080p moving test pattern with 440 Hz sound.
Chrome messaging/download APIs are bridged; no microphone, upload, extension
installation policy changes or real tab capture is involved. ffprobe/ffmpeg
independently inspect the saved bytes, including duration, tracks and sound.
"""
import asyncio
import base64
import functools
import hashlib
import json
import math
import os
from array import array
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import threading

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'dist'
OUTPUT.mkdir(exist_ok=True)
RANGE = {'startSeconds': 0.4, 'endSeconds': 1.6}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def fixture(name, size):
    path = OUTPUT / name
    subprocess.run([
        'ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', f'testsrc2=size={size}:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '2.4', '-vf', 'noise=alls=10:allf=t+u:all_seed=17', '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '8000k', '-c:a', 'aac',
        '-b:a', '128k', '-movflags', '+faststart', str(path),
    ], check=True)
    return path


def probe(path):
    return json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', str(path),
    ]))


def tone(path):
    samples = array('f')
    samples.frombytes(subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(path), '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-',
    ]))
    samples = samples[len(samples) // 5:len(samples) * 4 // 5]
    rms = math.sqrt(sum(value * value for value in samples) / len(samples))
    crossings = sum(left <= 0 < right for left, right in zip(samples, samples[1:]))
    frequency = crossings * 48000 / len(samples)
    assert abs(frequency - 440) < 20 and rms > 0.03, (path.name, frequency, rms)
    return round(frequency, 1)


def validate(path, *, scope, quality, content='both', gif=False, source_duration=2.4, small_source=False):
    info = probe(path)
    tracks = sorted(stream['codec_type'] for stream in info['streams'])
    expected_tracks = ['video'] if gif or content == 'video' else ['audio'] if content == 'audio' else ['audio', 'video']
    assert tracks == expected_tracks, (path.name, tracks)
    expected_duration = RANGE['endSeconds'] - RANGE['startSeconds'] if scope == 'range' else source_duration
    duration = float(info['format']['duration'])
    assert abs(duration - expected_duration) < (0.011 if gif else 0.22), (path.name, duration, expected_duration)
    summary = {'bytes': path.stat().st_size, 'duration': round(duration, 3), 'tracks': tracks}
    if 'video' in tracks:
        video = next(stream for stream in info['streams'] if stream['codec_type'] == 'video')
        dimensions = [video['width'], video['height']]
        if gif:
            expected = {'original': [640, 360], 'balanced': [480, 270], 'small': [320, 180]}[quality]
            max_fps = {'original': 10, 'balanced': 8, 'small': 6}[quality]
        else:
            expected = {'original': [1920, 1080], 'balanced': [1280, 720], 'small': [852, 480]}[quality]
            max_fps = {'original': 30, 'balanced': 24, 'small': 15}[quality]
        if small_source:
            expected = [320, 180]
        assert dimensions == expected, (path.name, dimensions, expected)
        frames = int(video['nb_read_frames'])
        measured_fps = frames / duration
        # Native MediaRecorder emits a variable-rate startup/final frame. Check
        # decoded frame count over the actual duration rather than r_frame_rate,
        # which ffprobe can report as a timestamp-denominator for native MP4.
        assert 2 < measured_fps <= max_fps + 2, (path.name, measured_fps, max_fps)
        if gif:
            assert frames == math.ceil(expected_duration * max_fps), (path.name, frames)
        summary.update({'dimensions': dimensions, 'frames': frames, 'fps': round(measured_fps, 2)})
    if 'audio' in tracks:
        summary['toneHz'] = tone(path)
    return summary


async def main():
    source = fixture('quality-source.mp4', '1920x1080')
    fixture('quality-small-source.mp4', '320x180')
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    summaries = {}
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True,
                args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
            )
            context = await browser.new_context(permissions=['clipboard-read', 'clipboard-write'])
            owner = await context.new_page()
            await owner.goto(f'http://127.0.0.1:{server.server_port}/extension/')
            original = await owner.evaluate('''async () => {
              const {TabAudioRecorder} = await import('./recorder.js');
              const {createController} = await import('./controller.js');
              const {inspectVideo} = await import('./video-trim.js');
              const source = await (await fetch('../dist/quality-source.mp4')).blob();
              const metadata = await inspectVideo(source);
              window.recorder = new TabAudioRecorder();
              recorder.originalBlob = source;
              Object.assign(recorder.state, {status:'ready',mode:'video',
                result:{url:URL.createObjectURL(source),filename:'quality-source.mp4',bytes:source.size,
                  mimeType:'video/mp4',kind:'video',trimError:null,...metadata},
                selection:{startSeconds:0,endSeconds:metadata.durationSeconds}});
              window.downloaded=[];window.requests=[];
              window.controller=createController({
                runtime:{getURL:path=>location.origin+'/extension/'+path,getContexts:async()=>[{}],
                  sendMessage:message=>{requests.push(message);return recorder.handle(message);}},
                action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
                downloads:{download:async options=>{downloaded.push(options);return downloaded.length;},
                  search:async()=>[{state:'complete'}]}
              });
              return recorder.getState().result;
            }''')

            async def bridge(message):
                return await owner.evaluate('(message)=>controller.handle(message)', message)

            popup = await context.new_page()
            await popup.set_viewport_size({'width': 380, 'height': 760})
            await popup.expose_function('testBridge', bridge)
            await popup.add_init_script('window.chrome={runtime:{sendMessage:message=>window.testBridge(message)}}')
            await popup.goto(f'http://127.0.0.1:{server.server_port}/extension/popup.html')
            await popup.wait_for_selector('#save-quality:visible')
            assert await popup.input_value('#save-quality') == 'original'
            await popup.fill('#trim-start', str(RANGE['startSeconds']))
            await popup.fill('#trim-end', str(RANGE['endSeconds']))
            await popup.locator('#trim-end').blur()

            async def save_url(url, name):
                encoded = await owner.evaluate('''async url => {
                  const bytes=new Uint8Array(await(await fetch(url)).arrayBuffer());let text='';
                  for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
                  return btoa(text);
                }''', url)
                path = OUTPUT / name
                path.write_bytes(base64.b64decode(encoded))
                return path

            async def save(scope, quality, content='both', gif=False):
                await popup.select_option('#save-format', 'gif' if gif else 'mp4')
                if not gif:
                    # Set quality before audio hides the quality field. Audio
                    # must normalize it and leave its sound untouched.
                    await popup.select_option('#save-content', 'both')
                await popup.select_option('#save-quality', quality)
                if not gif:
                    await popup.select_option('#save-content', content)
                expected_count = await owner.evaluate('downloaded.length + 1')
                await popup.click('#save-range-button' if scope == 'range' else '#save-button')
                await owner.wait_for_function('(count)=>downloaded.length === count', arg=expected_count, timeout=60000)
                await popup.wait_for_function("!document.querySelector('#save-button').disabled")
                state = await owner.evaluate('recorder.getState()')
                assert state['result']['url'] == original['url'], 'Original was replaced by an export'
                output_url = await owner.evaluate('downloaded.at(-1).url')
                key = f'{scope}-{quality}-{content}' + ('-gif' if gif else '')
                path = await save_url(output_url, f'quality-{key}.{"gif" if gif else "mp4"}')
                summaries[key] = validate(path, scope=scope, quality=quality, content=content, gif=gif,
                                          source_duration=original['durationSeconds'])
                if not gif and scope == 'whole' and quality == 'original' and content == 'both':
                    assert output_url == original['url']
                    assert path.read_bytes() == source.read_bytes()
                return path

            for scope in ['whole', 'range']:
                for quality in ['original', 'balanced', 'small']:
                    await save(scope, quality)
                await save(scope, 'small', 'video')
                await save(scope, 'small', 'audio')
                assert await popup.locator('#save-quality').is_hidden()
                await popup.select_option('#save-content', 'both')
                assert await popup.input_value('#save-quality') == 'small'
                for quality in ['original', 'balanced', 'small']:
                    await save(scope, quality, gif=True)

            # Actual copied animated bytes must match the selected quality,
            # including after the cached GIF was created at another quality.
            copied = {}
            for scope, quality in [('whole', 'balanced'), ('range', 'small')]:
                await popup.select_option('#save-quality', quality)
                before = await owner.evaluate('downloaded.length')
                await popup.click('#copy-range-gif-button' if scope == 'range' else '#copy-gif-button')
                await popup.wait_for_function("document.querySelector('#copy-status').textContent.includes('복사 완료')")
                clipboard = await popup.evaluate('''async () => {
                  const [item]=await navigator.clipboard.read();
                  const bytes=await(await item.getType('web image/gif')).arrayBuffer();
                  return {hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))),
                    html:(await(await item.getType('text/html')).text()).includes('data:image/gif;base64,')};
                }''')
                state = await owner.evaluate('recorder.getState()')
                output = state['rangeGifResult' if scope == 'range' else 'gifResult']
                assert output['quality'] == quality, output
                copied_path = await save_url(output['url'], f'quality-copy-{scope}-{quality}.gif')
                assert clipboard['hash'] == list(hashlib.sha256(copied_path.read_bytes()).digest()) and clipboard['html']
                assert await owner.evaluate('downloaded.length') == before
                copied[scope] = validate(copied_path, scope=scope, quality=quality, gif=True,
                                        source_duration=original['durationSeconds'])

            # Native cancellation must leave the prior successful variant and
            # original usable, even while changing the quality cache key.
            await popup.select_option('#save-format', 'mp4')
            await popup.select_option('#save-content', 'both')
            await popup.select_option('#save-quality', 'balanced')
            old_state = await owner.evaluate('recorder.getState()')
            count = await owner.evaluate('downloaded.length')
            await popup.click('#save-button')
            await owner.wait_for_function("recorder.getState().status === 'trimming'")
            await popup.click('#cancel-export-button')
            await owner.wait_for_function("recorder.getState().status === 'ready'")
            await popup.wait_for_function("!document.querySelector('#save-button').disabled")
            cancelled = await owner.evaluate('recorder.getState()')
            assert cancelled['result']['url'] == original['url']
            assert cancelled['videoExportResult']['url'] == old_state['videoExportResult']['url']
            assert await owner.evaluate('downloaded.length') == count
            await popup.locator('#ready-controls').screenshot(path=str(OUTPUT / 'quality-options.png'))

            small = await owner.evaluate('''async () => {
              const {trimVideo} = await import('./video-trim.js');
              const {exportGif} = await import('./gif-export.js');
              const source=await(await fetch('../dist/quality-small-source.mp4')).blob();
              const outputs={};
              for(const quality of ['balanced','small']){
                for(const type of ['mp4','gif']){
                  const result=type==='mp4'?await trimVideo(source,0,undefined,{quality}):await exportGif(source,{quality});
                  outputs[quality+'-'+type]={url:URL.createObjectURL(result.blob),duration:result.durationSeconds};
                }
              }
              return outputs;
            }''')
            no_upscale = {}
            for name, output in small.items():
                quality, kind = name.split('-')
                path = await save_url(output['url'], f'quality-no-upscale-{name}.{kind}')
                no_upscale[name] = validate(path, scope='whole', quality=quality, gif=kind == 'gif', small_source=True,
                                           source_duration=2.4)
            await browser.close()

        # This detailed-motion fixture demonstrates a reduction; no promise is
        # made that re-encoding every possible simple source will be smaller.
        for scope in ['whole', 'range']:
            for suffix in ['', '-gif']:
                sizes = [summaries[f'{scope}-{quality}-both{suffix}']['bytes']
                         for quality in ['original', 'balanced', 'small']]
                assert sizes[0] > sizes[1] > sizes[2], (scope, suffix, sizes)
        print(json.dumps({'result': 'passed', 'exports': summaries, 'clipboard': copied, 'noUpscale': no_upscale,
                          'originalRetained': True, 'cancelledWithoutDownload': True,
                          'scope': 'real popup/native MP4/GIF/clipboard; synthetic local source and Chrome API bridge'}))
    finally:
        server.shutdown()


asyncio.run(main())
