"""Native MP4 and popup smoke test using synthetic input, not chrome.tabCapture.
Requires Python Playwright, Chromium, ffmpeg and ffprobe.
"""
import asyncio
import functools
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

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'extension')))
threading.Thread(target=server.serve_forever, daemon=True).start()

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
            headless=True, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        context = await browser.new_context(viewport={'width': 380, 'height': 620}, device_scale_factor=2)
        owner = await context.new_page()
        await owner.goto(f'http://127.0.0.1:{server.server_port}/')
        await owner.evaluate('''async () => {
          const {TabAudioRecorder} = await import('./recorder.js');
          window.sourceContext = new AudioContext();
          const oscillator = sourceContext.createOscillator();
          oscillator.frequency.value = 440;
          const gain = sourceContext.createGain(); gain.gain.value = 0.2;
          const output = sourceContext.createMediaStreamDestination();
          oscillator.connect(gain).connect(output); oscillator.start();
          await sourceContext.resume();
          window.recorder = new TabAudioRecorder({mediaDevices:{getUserMedia:async (constraints)=>{
            if (constraints.video !== false || constraints.audio.mandatory.chromeMediaSource !== 'tab')
              throw Error('Unexpected capture source');
            return output.stream;
          }}});
        }''')

        async def bridge(message):
            if message['type'] == 'START':
                message = {**message, 'streamId': 'synthetic-tab-test', 'tab': {'id': 1, 'title': '테스트 음원 · 440 Hz'}}
            reply = await owner.evaluate('(message)=>recorder.handle(message)', message)
            if message['type'] != 'STATUS':
                print(message['type'], json.dumps(reply, ensure_ascii=False), flush=True)
            return reply

        async def popup_page():
            popup = await context.new_page()
            await popup.expose_function('testBridge', bridge)
            await popup.add_init_script('window.chrome={runtime:{sendMessage:(message)=>window.testBridge(message)}}')
            await popup.goto(f'http://127.0.0.1:{server.server_port}/popup.html')
            return popup

        popup = await popup_page()
        await popup.wait_for_selector('#start-button:enabled')
        await popup.locator('body').screenshot(path=str(OUTPUT / 'popup-idle.png'))
        await popup.click('#start-button')
        await popup.wait_for_function("document.querySelector('#status-label').textContent === '녹음 중'")
        await asyncio.sleep(1.2)
        recording = await bridge({'type': 'STATUS'})
        assert recording['state']['level'] > 0, recording
        await popup.locator('body').screenshot(path=str(OUTPUT / 'popup-recording.png'))
        await popup.click('#pause-button')
        await popup.wait_for_function("document.querySelector('#status-label').textContent === '일시 정지'")
        paused = (await bridge({'type': 'STATUS'}))['state']['elapsedMs']
        await asyncio.sleep(0.4)
        assert (await bridge({'type': 'STATUS'}))['state']['elapsedMs'] == paused
        await popup.click('#pause-button')
        await popup.wait_for_function("document.querySelector('#status-label').textContent === '녹음 중'")
        await popup.close()
        await asyncio.sleep(0.6)
        assert (await bridge({'type': 'STATUS'}))['state']['status'] == 'recording'
        popup = await popup_page()
        await popup.wait_for_selector('#stop-button:visible')
        await popup.click('#stop-button')
        await popup.wait_for_function("document.querySelector('#status-label').textContent === '녹음 완료'")
        state = (await bridge({'type': 'STATUS'}))['state']
        assert state['result']['mimeType'].startswith('audio/mp4'), state
        assert state['result']['filename'].endswith('.mp4'), state
        assert '.mp4' in await popup.locator('#save-button').inner_text()
        await popup.locator('body').screenshot(path=str(OUTPUT / 'popup-ready.png'))
        payload = await owner.evaluate('''async () => Array.from(new Uint8Array(
          await (await fetch(recorder.getState().result.url)).arrayBuffer()))''')
        sample = OUTPUT / 'test-recording.mp4'
        sample.write_bytes(bytes(payload))
        probe = json.loads(subprocess.check_output([
            'ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(sample)]))
        assert len(probe['streams']) == 1 and probe['streams'][0]['codec_type'] == 'audio', probe
        assert 'mp4' in probe['format']['format_name'], probe
        assert float(probe['format']['duration']) > 1.5, probe
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(sample), '-f', 'null', '-'], check=True)
        print(json.dumps({'container': probe['format']['format_name'],
                          'codec': probe['streams'][0]['codec_name'],
                          'duration': probe['format']['duration'], 'bytes': sample.stat().st_size,
                          'ui': 'start, pause, resume, close/reopen, stop passed',
                          'scope': 'synthetic input; native MP4 encoder and popup UI'}, ensure_ascii=False))
        await browser.close()

try:
    asyncio.run(main())
finally:
    server.shutdown()
