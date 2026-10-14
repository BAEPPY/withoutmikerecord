"""Native MP4 and popup smoke test using synthetic input, not chrome.tabCapture.
Requires Python Playwright, Chromium, ffmpeg and ffprobe.
"""
import asyncio
import functools
import json
import os
import re
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
          window.pageCommands = [];
          const sourceTab = {id:1,active:true,url:'https://example.test',title:'테스트 음원 · 440/880 Hz'};
          window.chrome = {
            runtime: {id:'test-extension',getURL: (path)=>location.origin+'/'+path, getContexts:async()=>[{}],
              sendMessage:(message)=>{
                if (message.target === 'offscreen') return recorder.handle(message);
                if (message.type !== 'PAGE_SHORTCUT') throw Error('Unexpected page request');
                pageCommands.push(message);
                if (message.key === '1') syntheticTone.frequency.setValueAtTime(880, sourceContext.currentTime + 0.6);
                return controller.handle({type:message.key === '1' ? 'START' : 'PAGE_STOP',targetTabId:1});
              }},
            tabs: {query:async()=>[sourceTab],get:async(id)=>{
              if(id !== 1) throw Error('Missing source tab'); return sourceTab;
            }},
            scripting: {executeScript:async(options)=>{
              if(options.target.tabId !== 1) throw Error('Wrong injection target');
              for (const file of options.files) new Function(await (await fetch('./'+file)).text())();
            }},
            tabCapture: {getMediaStreamId:async()=> 'synthetic-tab-test'},
            action: {setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
            downloads: {download:async(options)=>{downloaded.push(options);return downloaded.length;},
              search:async()=>[{state:'complete'}]},
          };
          window.controller = createController(chrome);
          document.body.innerHTML = '<input id="page-input"><button id="page-play">재생</button><video id="page-video" tabindex="0"></video><div id="shadow-editor"></div>';
          const shadow = document.querySelector('#shadow-editor').attachShadow({mode:'open'});
          shadow.innerHTML = '<input id="shadow-input">';
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
        await popup.wait_for_selector('#shortcut-status[data-status="connected"]')
        await popup.locator('body').screenshot(path=str(OUTPUT / 'popup-idle.png'))
        await popup.close()
        # A real trusted key event reaches the injected page listener after the
        # popup has closed. Editable fields, shadow inputs and synthetic events
        # must not start a recording or steal typed digits.
        await owner.bring_to_front()
        await owner.click('#page-input')
        await owner.keyboard.type('12')
        assert await owner.input_value('#page-input') == '12'
        await owner.locator('#shadow-input').fill('')
        await owner.keyboard.type('12')
        assert await owner.locator('#shadow-input').input_value() == '12'
        await owner.click('#page-play')
        await owner.keyboard.press('Alt+1')
        await owner.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'1',bubbles:true,cancelable:true}))")
        assert await owner.evaluate('pageCommands.length') == 0
        await owner.keyboard.down('1')
        await owner.wait_for_function("recorder.getState().status === 'recording'")
        await owner.keyboard.down('1')  # auto-repeat must not issue another START
        await owner.keyboard.up('1')
        assert await owner.evaluate('pageCommands.length') == 1
        popup = await popup_page()
        await popup.wait_for_function("document.querySelector('#status-label').textContent === '녹음 중'")
        assert re.fullmatch(r'\d{2}:\d{2}\.\d{2}', await popup.locator('#timer').inner_text())
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
        # Focus on a player must still allow STOP. Reopening the popup above
        # reinjects the script; exactly one request proves injection is idempotent.
        await owner.bring_to_front()
        await owner.locator('#page-video').focus()
        await owner.keyboard.press('2')
        await owner.wait_for_function("recorder.getState().status === 'ready'")
        assert await owner.evaluate('pageCommands.map(command=>command.key)') == ['1', '2']
        popup = await popup_page()
        await popup.wait_for_function("document.querySelector('#status-label').textContent === '녹음 완료'")
        state = (await bridge({'type': 'STATUS'}))['state']
        assert state['result']['mimeType'].startswith('audio/mp4'), state
        assert state['result']['filename'].endswith('.mp4'), state
        assert '.mp4' in await popup.locator('#save-button').inner_text()
        assert state['result']['durationSeconds'] > 1.5
        assert await popup.input_value('#trim-start') == '0.00'
        assert re.fullmatch(r'\d+\.\d{2}', await popup.input_value('#trim-end'))
        assert re.fullmatch(r'00:00\.00 / \d{2}:\d{2}\.\d{2}', await popup.locator('#preview-position').inner_text())
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
        await popup.fill('#trim-start', '0.91')
        await popup.fill('#trim-end', '1.51')
        await popup.click('#preview-range')
        await popup.wait_for_function("document.querySelector('#audio-preview').paused", timeout=5000)
        position = await popup.locator('#audio-preview').evaluate('(audio)=>audio.currentTime')
        assert 1.45 <= position <= 1.60, position
        assert (await popup.locator('#preview-position').inner_text()).startswith('00:01.51 / ')
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
        assert await popup.input_value('#trim-start') == '0.91'
        assert await popup.input_value('#trim-end') == '1.51'
        await popup.click('#save-button')
        await popup.wait_for_function("document.querySelector('#save-button').disabled === false")
        assert await owner.evaluate('downloaded.at(-1).url === recorder.getState().result.url')
        await popup.locator('body').screenshot(path=str(OUTPUT / 'popup-trimmed.png'))
        print(json.dumps({'container': probe['format']['format_name'],
                          'codec': probe['streams'][0]['codec_name'],
                          'duration': probe['format']['duration'], 'bytes': sample.stat().st_size,
                          'trimDuration': clip_probe['format']['duration'], 'trimFrequency': frequency,
                          'ui': 'popup closed: page1 record, pause, resume, page2 stop with player focus; input guards, idempotent injection, hundredths, preview, trim, persist range, full save passed',
                          'scope': 'synthetic input and Chrome API bridge; real page keys, MP4 encoder and popup UI'}, ensure_ascii=False))
        await browser.close()

try:
    asyncio.run(main())
finally:
    server.shutdown()
