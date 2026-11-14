"""Real local-file audio extraction UI with native Chromium and FFmpeg checks.

Only chrome.downloads is simulated. File selection, media decoding, MP4 packet
copying, WebM audio encoding, cancellation and the extraction page are real. No
extension policy is bypassed, and Chromium uses its normal autoplay policy.
All input footage and audio are generated locally; no network upload is used.
"""
import asyncio
from array import array
import functools
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'dist'
OUTPUT.mkdir(exist_ok=True)
DURATION = 2.4


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def ffmpeg(*args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *map(str, args)], check=True)


def fixtures():
    paths = {name: OUTPUT / f'file-audio-input-{name}' for name in [
        'av.mp4', 'av.webm', 'no-audio.mp4', 'no-audio.webm', 'silent-audio.mp4']}
    color = f'color=c=red:s=160x90:r=20:d={DURATION}'
    tone = f'sine=frequency=660:sample_rate=48000:duration={DURATION}'
    ffmpeg('-f', 'lavfi', '-i', color, '-f', 'lavfi', '-i', tone,
           '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', paths['av.mp4'])
    ffmpeg('-f', 'lavfi', '-i', color, '-f', 'lavfi', '-i', tone,
           '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
           '-c:a', 'libopus', '-b:a', '96k', paths['av.webm'])
    ffmpeg('-i', paths['av.mp4'], '-map', '0:v:0', '-c', 'copy', paths['no-audio.mp4'])
    ffmpeg('-i', paths['av.webm'], '-map', '0:v:0', '-c', 'copy', paths['no-audio.webm'])
    ffmpeg('-f', 'lavfi', '-i', color, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
           '-t', DURATION, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', paths['silent-audio.mp4'])
    return paths


def probe(path):
    return json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))


def audio_packets(path):
    result = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_packets',
        '-show_data_hash', 'sha256', '-of', 'json', str(path)]))
    return result['packets']


def decoded_audio(path):
    return subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(path), '-vn', '-ac', '1', '-ar', '48000',
        '-f', 'f32le', '-'])


def assert_audio(path, *, silent=False):
    info = probe(path)
    assert [stream['codec_type'] for stream in info['streams']] == ['audio'], info
    duration = float(info['format']['duration'])
    assert abs(duration - DURATION) < 0.3, (path.name, duration)
    samples = array('f', decoded_audio(path))
    assert len(samples) > 48000
    peak = max(abs(value) for value in samples)
    if silent:
        assert peak < 0.0001, peak
        frequency = 0
    else:
        portion = samples[len(samples) // 4:len(samples) * 3 // 4]
        frequency = sum(a <= 0 < b for a, b in zip(portion, portion[1:])) * 48000 / len(portion)
        assert abs(frequency - 660) < 20 and peak > 0.05, (path.name, frequency, peak)
    return {'codec': info['streams'][0]['codec_name'], 'durationSeconds': duration,
            'toneHz': round(frequency, 2), 'peak': round(peak, 4)}


DOWNLOAD_BRIDGE = '''(() => {
  window.__downloads = [];
  window.__downloadState = new Map();
  window.__downloadListeners = new Set();
  window.__downloadMode = 'complete';
  window.__runtimeMessages = [];
  window.__microphoneCalls = 0;
  window.__recorders = [];
  window.__recorderStarts = 0;
  window.__speakerConnections = 0;
  window.__revokedUrls = [];
  const NativeRecorder = window.MediaRecorder;
  window.MediaRecorder = class extends NativeRecorder {
    constructor(...args) { super(...args); __recorders.push(this); }
    start(...args) { __recorderStarts++; return super.start(...args); }
  };
  const originalConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(destination, ...args) {
    if (destination instanceof AudioDestinationNode) __speakerConnections++;
    return originalConnect.call(this, destination, ...args);
  };
  navigator.mediaDevices.getUserMedia = async () => {
    __microphoneCalls++; throw Error('Local extraction must not capture a microphone or tab');
  };
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = url => { __revokedUrls.push(url); revoke(url); };
  window.__finishDownload = (id, state) => {
    __downloadState.set(id, {id, state, ...(state === 'interrupted' ? {error:'USER_CANCELED'} : {})});
    for (const listener of __downloadListeners) listener({id,state:{current:state},
      ...(state === 'interrupted' ? {error:{current:'USER_CANCELED'}} : {})});
  };
  window.chrome = {
    runtime: {
      getURL: path => location.origin + '/' + path,
      sendMessage: async message => { __runtimeMessages.push(message); throw Error('Unexpected recorder command'); }
    },
    downloads: {
      download: async options => {
        const id = __downloads.length + 1;
        __downloads.push({...options, id});
        if (__downloadMode === 'cancel') throw Error('User cancelled');
        __downloadState.set(id, {id,state:__downloadMode === 'pending' ? 'in_progress' : 'complete'});
        return id;
      },
      search: async ({id}) => __downloadState.has(id) ? [__downloadState.get(id)] : [],
      onChanged: {
        addListener: listener => __downloadListeners.add(listener),
        removeListener: listener => __downloadListeners.delete(listener)
      }
    }
  };
})();'''


async def main():
    sources = fixtures()
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(
        QuietHandler, directory=str(ROOT / 'extension')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    summary = {}
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                headless=True, args=['--no-sandbox'])
            context = await browser.new_context(viewport={'width': 1000, 'height': 850})
            page = await context.new_page()
            page_errors = []
            requests = []
            confirmations = []
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            page.on('request', lambda request: requests.append(request.url))
            async def accept_replacement(dialog):
                confirmations.append({'type': dialog.type, 'message': dialog.message})
                await dialog.accept()
            page.on('dialog', accept_replacement)
            await page.add_init_script(DOWNLOAD_BRIDGE)
            origin = f'http://127.0.0.1:{server.server_port}'
            await page.goto(origin + '/extract.html')

            async def choose(path):
                await page.set_input_files('#source-file', str(path))
                await page.wait_for_function("!document.querySelector('#extract-button').disabled")

            async def extract():
                await page.click('#extract-button')
                await page.wait_for_function("""(() => {
                  const audio = document.querySelector('#result-audio');
                  return audio.src.startsWith('blob:') && !document.querySelector('#save-extracted-button').disabled &&
                    document.querySelector('#extract-status').textContent === '소리 추출 완료';
                })()""", timeout=30000)
                await page.wait_for_function("""(() => {
                  const audio = document.querySelector('#result-audio');
                  return audio.readyState >= 1 && !audio.error;
                })()""")
                return await page.locator('#result-audio').get_attribute('src')

            async def save_result(name):
                path = OUTPUT / f'file-audio-output-{name}.mp4'
                data = await page.evaluate('''async () => Array.from(new Uint8Array(await (
                  await fetch(document.querySelector('#result-audio').src)).arrayBuffer()))''')
                path.write_bytes(bytes(data))
                return path

            async def wait_save_enabled():
                await page.wait_for_function("!document.querySelector('#save-extracted-button').disabled")

            await choose(sources['av.mp4'])
            mp4_url = await extract()
            mp4_path = await save_result('copied-aac')
            summary['mp4Copy'] = assert_audio(mp4_path)
            before, after = audio_packets(sources['av.mp4']), audio_packets(mp4_path)
            assert len(before) == len(after) > 0
            for index, (original, copied) in enumerate(zip(before, after)):
                assert original['data_hash'] == copied['data_hash'], (index, 'AAC packet changed')
                # FFprobe infers a full final AAC frame duration for fragmented
                # MP4 even when its stored sample duration is shorter. Compare
                # timestamps and the complete decoded audio instead.
                for field in ['pts_time', 'dts_time']:
                    if field in original and field in copied:
                        assert abs(float(original[field]) - float(copied[field])) < 0.000002, (index, field)
            summary['mp4Copy']['packetsPreserved'] = len(after)
            source_pcm, extracted_pcm = decoded_audio(sources['av.mp4']), decoded_audio(mp4_path)
            assert source_pcm == extracted_pcm, 'Copied MP4 changed decoded audio'
            summary['mp4Copy']['decodedSha256'] = hashlib.sha256(extracted_pcm).hexdigest()
            assert await page.evaluate('__recorderStarts') == 0, 'MP4 should copy existing encoded audio'

            # A cancelled native save dialog must leave the result available.
            await page.evaluate("__downloadMode = 'cancel'")
            await page.click('#save-extracted-button')
            await page.wait_for_function('__downloads.length === 1')
            await wait_save_enabled()
            assert await page.locator('#result-audio').get_attribute('src') == mp4_url
            assert not await page.evaluate('(url) => __revokedUrls.includes(url)', mp4_url)
            await page.evaluate("__downloadMode = 'complete'")
            await page.click('#save-extracted-button')
            await page.wait_for_function('__downloads.length === 2')
            await wait_save_enabled()
            download = await page.evaluate('__downloads.at(-1)')
            assert download['url'] == mp4_url and download['filename'].endswith('.mp4'), download
            assert download['saveAs'] is True, download
            summary['saveDialogCancelRetry'] = True

            # Cancel after native recording actually starts, then retry the same
            # selected WebM under Chromium's standard autoplay policy.
            await choose(sources['av.webm'])
            await page.click('#extract-button')
            await page.wait_for_function('__recorders.some(recorder => recorder.state === "recording")', timeout=15000)
            await page.click('#cancel-extract-button')
            await page.wait_for_function("!document.querySelector('#extract-button').disabled")
            assert await page.evaluate('__recorders.every(recorder => recorder.state === "inactive")')
            assert await page.locator('#result-audio').get_attribute('src') == mp4_url
            assert not await page.evaluate('(url) => __revokedUrls.includes(url)', mp4_url)
            assert await page.evaluate('__downloads.length') == 2
            webm_url = await extract()
            assert webm_url != mp4_url
            webm_path = await save_result('encoded-webm')
            summary['webmEncode'] = assert_audio(webm_path)
            summary['encodingCancelRetry'] = True
            assert await page.evaluate('__recorderStarts') >= 2
            await page.screenshot(path=str(OUTPUT / 'file-audio-extract.png'), full_page=True)
            await page.set_viewport_size({'width': 380, 'height': 820})
            await page.screenshot(path=str(OUTPUT / 'file-audio-extract-narrow.png'), full_page=True)
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            await page.set_viewport_size({'width': 1000, 'height': 850})

            # Downloads may be interrupted after the save dialog. Keep the
            # result URL and prevent replacing its source while the save is live.
            await page.evaluate("__downloadMode = 'pending'")
            await page.click('#save-extracted-button')
            await page.wait_for_function('__downloads.length === 3')
            assert await page.locator('#source-file').is_disabled()
            assert await page.locator('#result-audio').get_attribute('src') == webm_url
            assert await page.evaluate('(url) => fetch(url).then(response => response.ok)', webm_url)
            await page.evaluate("__finishDownload(3, 'interrupted')")
            await wait_save_enabled()
            assert await page.locator('#result-audio').get_attribute('src') == webm_url
            await page.evaluate("__downloadMode = 'complete'")
            await page.click('#save-extracted-button')
            await page.wait_for_function('__downloads.length === 4')
            await wait_save_enabled()
            assert await page.evaluate('__downloads.at(-1).url') == webm_url
            summary['interruptedDownloadRetry'] = True

            # Having a silent audio track is different from having no audio.
            await choose(sources['silent-audio.mp4'])
            silent_url = await extract()
            silent_name = await page.locator('#result-name').inner_text()
            summary['silentAudioAccepted'] = assert_audio(await save_result('silent-audio'), silent=True)
            rejected = []
            for name in ['no-audio.mp4', 'no-audio.webm']:
                await choose(sources[name])
                await page.click('#extract-button')
                await page.wait_for_function("""!document.querySelector('#extract-button').disabled &&
                  document.querySelector('#extract-error').textContent.trim().length > 0""", timeout=30000)
                assert await page.locator('#result-audio').get_attribute('src') == silent_url, name
                assert await page.locator('#result-name').inner_text() == silent_name
                assert not await page.evaluate('(url) => __revokedUrls.includes(url)', silent_url)
                rejected.append({'file': name, 'error': await page.locator('#extract-error').inner_text()})
            await page.set_input_files('#source-file', {'name': 'broken.mp4', 'mimeType': 'video/mp4',
                                                       'buffer': b'This is not a video or audio file.'})
            await page.click('#extract-button')
            await page.wait_for_function("""!document.querySelector('#extract-button').disabled &&
              document.querySelector('#extract-error').textContent.trim().length > 0""", timeout=30000)
            assert await page.locator('#result-audio').get_attribute('src') == silent_url
            assert await page.locator('#result-name').inner_text() == silent_name
            rejected.append({'file': 'broken.mp4', 'error': await page.locator('#extract-error').inner_text()})
            await choose(sources['av.mp4'])
            await extract()
            assert await page.locator('#extract-error').inner_text() == ''
            summary['rejectedInputs'] = rejected
            summary['failureRecovery'] = True
            assert len(confirmations) == 4, confirmations
            assert all(item['type'] == 'confirm' and '새 추출이 성공하면' in item['message'] for item in confirmations)
            summary['unsavedResultPreservedOnFailure'] = True

            assert await page.evaluate('__runtimeMessages.length') == 0, 'Import must not mutate the recorder'
            assert await page.evaluate('__microphoneCalls') == 0
            assert await page.evaluate('__speakerConnections') == 0, 'Extraction must not play sound through speakers'
            assert await page.evaluate('__recorders.every(recorder => recorder.state === "inactive")')
            assert await page.evaluate('__recorders.every(recorder => recorder.stream.getTracks().every(track => track.readyState === "ended"))')
            assert not page_errors, page_errors
            assert all(url.startswith((origin + '/', 'blob:' + origin + '/', 'data:')) for url in requests), requests
            summary['isolation'] = {'backgroundMessages': 0, 'captureCalls': 0, 'speakerConnections': 0, 'externalRequests': 0}
            await browser.close()
        print(json.dumps({'result': 'passed', **summary}, ensure_ascii=False))
    finally:
        server.shutdown()


asyncio.run(main())
