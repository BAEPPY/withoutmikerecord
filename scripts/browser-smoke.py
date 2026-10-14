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
          const {createController} = await import('./controller.js');
          window.sourceContext = new AudioContext();
          const oscillator = sourceContext.createOscillator();
          window.syntheticTone = oscillator;
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
          window.downloaded = [];
          window.controller = createController({
            runtime: {getURL: (path)=>location.origin+'/'+path, getContexts:async()=>[{}],
              sendMessage:(message)=>recorder.handle(message)},
            tabs: {query:async()=>[{id:1,url:'https://example.test',title:'테스트 음원 · 440/880 Hz'}]},
            tabCapture: {getMediaStreamId:async()=> 'synthetic-tab-test'},
            action: {setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
            downloads: {download:async(options)=>{downloaded.push(options);return downloaded.length;},
              search:async()=>[{state:'complete'}]},
          });
        }''')

        async def bridge(message):
            if message['type'] == 'START':
                await owner.evaluate('syntheticTone.frequency.setValueAtTime(880, sourceContext.currentTime + 0.6)')
            reply = await owner.evaluate('(message)=>controller.handle(message)', message)
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
        await popup.keyboard.press('1')
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
        await popup.keyboard.press('2')
        await popup.wait_for_function("document.querySelector('#status-label').textContent === '녹음 완료'")
        state = (await bridge({'type': 'STATUS'}))['state']
        assert state['result']['mimeType'].startswith('audio/mp4'), state
        assert state['result']['filename'].endswith('.mp4'), state
        assert '.mp4' in await popup.locator('#save-button').inner_text()
        assert state['result']['durationSeconds'] > 1.5
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
        await popup.fill('#trim-start', '0.90')
        await popup.fill('#trim-end', '1.50')
        await popup.click('#preview-range')
        await popup.wait_for_function("document.querySelector('#audio-preview').paused", timeout=5000)
        position = await popup.locator('#audio-preview').evaluate('(audio)=>audio.currentTime')
        assert 1.45 <= position <= 1.60, position
        await popup.click('#save-range-button')
        await popup.wait_for_function("document.querySelector('#notice-message').textContent.includes('완료')")
        state = (await bridge({'type': 'STATUS'}))['state']
        assert state['exportResult'] and state['result']['url'] != state['exportResult']['url']
        assert (await owner.evaluate('downloaded.at(-1).url')) == state['exportResult']['url']
        clip_bytes = await owner.evaluate('''async()=>Array.from(new Uint8Array(
          await (await fetch(recorder.getState().exportResult.url)).arrayBuffer()))''')
        clip_path = OUTPUT / 'test-trimmed.mp4'
        clip_path.write_bytes(bytes(clip_bytes))
        clip_probe = json.loads(subprocess.check_output([
            'ffprobe','-v','error','-show_format','-show_streams','-of','json',str(clip_path)]))
        assert len(clip_probe['streams']) == 1 and clip_probe['streams'][0]['codec_type'] == 'audio'
        assert abs(float(clip_probe['format']['duration']) - 0.6) < 0.1, clip_probe
        import array
        pcm = array.array('f', subprocess.check_output([
            'ffmpeg','-v','error','-i',str(clip_path),'-ac','1','-ar','48000','-f','f32le','-']))
        crossings = sum(pcm[i-1] < 0 <= pcm[i] for i in range(1, len(pcm)))
        frequency = crossings * 48000 / len(pcm)
        assert 850 <= frequency <= 910, frequency
        await popup.close()
        popup = await popup_page()
        await popup.wait_for_selector('#trim-start:enabled')
        assert float(await popup.input_value('#trim-start')) == 0.9
        assert float(await popup.input_value('#trim-end')) == 1.5
        await popup.click('#save-button')
        await popup.wait_for_function("document.querySelector('#save-button').disabled === false")
        assert await owner.evaluate('downloaded.at(-1).url === recorder.getState().result.url')
        await popup.locator('body').screenshot(path=str(OUTPUT / 'popup-trimmed.png'))
        print(json.dumps({'container': probe['format']['format_name'],
                          'codec': probe['streams'][0]['codec_name'],
                          'duration': probe['format']['duration'], 'bytes': sample.stat().st_size,
                          'trimDuration': clip_probe['format']['duration'], 'trimFrequency': frequency,
                          'ui': 'key1 record, pause, resume, close/reopen, key2 stop, preview, trim, persist range, full save passed',
                          'scope': 'synthetic input; native MP4 encoder and popup UI'}, ensure_ascii=False))
        await browser.close()

try:
    asyncio.run(main())
finally:
    server.shutdown()
