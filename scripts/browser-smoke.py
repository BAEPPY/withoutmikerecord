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
          window.captureGate = null;
          window.captureGateEntered = false;
          window.lastCapturedTracks = [];
          window.recorder = new TabAudioRecorder({mediaDevices:{getUserMedia:async (constraints)=>{
            if (constraints.video !== false || constraints.audio.mandatory.chromeMediaSource !== 'tab')
              throw Error('Unexpected capture source');
            if(captureGate) { captureGateEntered=true;await captureGate; }
            const stream = new MediaStream(output.stream.getTracks().map(track=>track.clone()));
            lastCapturedTracks = stream.getTracks();
            return stream;
          }}});
          window.downloaded = [];
          window.pageCommands = [];
          window.popupCommands = [];
          const sourceTab = {id:1,active:true,url:'https://example.test',title:'테스트 음원 · 440/880 Hz'};
          window.chrome = {
            runtime: {id:'test-extension',getManifest:()=>({version:'1.3.2'}),getURL: (path)=>location.origin+'/'+path, getContexts:async()=>[{}],
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
          document.body.innerHTML = '<input id="page-input"><input id="page-volume" type="range"><input id="page-player-input" type="button" value="재생"><button id="page-play">재생</button><video id="page-video" tabindex="0"></video><div id="shadow-editor"></div><iframe id="existing-player" style="height:100px;width:100%"></iframe>';
          const shadow = document.querySelector('#shadow-editor').attachShadow({mode:'open'});
          shadow.innerHTML = '<input id="shadow-input">';
          // Install a realistic site's key handler BEFORE the extension. Its
          // preventDefault must not suppress the recorder's trusted digits.
          window.sitePrevented = 0;
          window.addEventListener('keydown',event=>{
            if(!['1','2'].includes(event.key)) return;
            const editing=event.composedPath().some(node=>node.isContentEditable ||
              node.tagName==='INPUT' && node.type==='text');
            if(!editing) { event.preventDefault(); sitePrevented++; }
          },true);
          window.playerFrameMarkup = `<input id="frame-volume" type="range"><input id="frame-input-button" type="button" value="재생"><button id="frame-play">재생</button><input id="frame-text"><script>
            window.sitePrevented=0;
            window.addEventListener('keydown',event=>{
              if(['1','2'].includes(event.key) && event.target.type!=='text') {
                event.preventDefault(); sitePrevented++;
              }
            },true);
          </script>`;
          const existing = document.querySelector('#existing-player');
          await new Promise(resolve=>{existing.onload=resolve;existing.srcdoc=playerFrameMarkup;});
        }''')

        async def bridge(message):
            if message['type'] == 'START':
                await owner.evaluate('syntheticTone.frequency.setValueAtTime(880, sourceContext.currentTime + 0.6)')
            reply = await owner.evaluate('(message)=>{popupCommands.push(message);return controller.handle(message);}', message)
            if message['type'] != 'STATUS':
                print(message['type'], json.dumps(reply, ensure_ascii=False), flush=True)
            return reply

        async def popup_page():
            popup = await context.new_page()
            await popup.expose_function('testBridge', bridge)
            await popup.add_init_script('''window.openedSettings=[];
              window.chrome={runtime:{sendMessage:(message)=>window.testBridge(message)},
                commands:{getAll:async()=>[
                  {name:'start-recording',shortcut:'Ctrl+Shift+8'},
                  {name:'stop-recording',shortcut:'Alt+Shift+2'},
                  {name:'start-video',shortcut:''},
                  {name:'stop-video',shortcut:'Alt+Shift+4'}]},
                tabs:{create:async(options)=>{openedSettings.push(options);return {id:99};}}};''')
            await popup.goto(f'http://127.0.0.1:{server.server_port}/popup.html')
            return popup

        popup = await popup_page()
        await popup.wait_for_selector('#start-button:enabled')
        await popup.wait_for_selector('#shortcut-status[data-status="connected"]')
        await popup.wait_for_function("document.querySelector('#shortcut-audio-start').textContent === 'Ctrl+Shift+8'")
        assert await popup.locator('#shortcut-video-start').inner_text() == '미지정'
        assert await popup.locator('#shortcut-video-start').get_attribute('data-assigned') == 'false'
        await popup.click('#shortcut-settings')
        assert await popup.evaluate('openedSettings.at(-1).url') == 'chrome://extensions/shortcuts'
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
        await owner.locator('#page-volume').focus()
        await owner.keyboard.down('1')
        await owner.wait_for_function("recorder.getState().status === 'recording'")
        await owner.keyboard.down('1')  # auto-repeat must not issue another START
        await owner.keyboard.up('1')
        assert await owner.evaluate('pageCommands.length') == 1
        assert await owner.evaluate('sitePrevented') > 0
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
        await popup.close()
        await owner.bring_to_front()

        async def player_pair(player, start='#frame-volume', stop='#frame-input-button'):
            """Real trusted keys in a player must route once to its top tab."""
            await owner.evaluate("controller.handle({type:'DISCARD'})")
            before = await owner.evaluate('pageCommands.length')
            text = player.locator('#frame-text')
            await text.fill('')
            await owner.keyboard.type('12')
            assert await text.input_value() == '12'
            assert await owner.evaluate('pageCommands.length') == before
            await player.locator(start).focus()
            await owner.keyboard.press('1')
            await owner.wait_for_function("recorder.getState().status === 'recording'")
            await text.fill('')
            await owner.keyboard.type('2')
            assert await text.input_value() == '2'
            assert await owner.evaluate('recorder.getState().status') == 'recording'
            await asyncio.sleep(0.15)
            await player.locator(stop).focus()
            await owner.keyboard.press('2')
            await owner.wait_for_function("recorder.getState().status === 'ready'")
            assert await owner.evaluate('(before)=>pageCommands.slice(before).map(command=>command.key)',before) == ['1','2']
            assert await player.locator('body').evaluate('()=>window.sitePrevented') >= 2

        # The first iframe existed before injection. Dynamic and reloaded
        # same-origin documents must receive listeners without opening a popup.
        await player_pair(owner.frame_locator('#existing-player'))
        await owner.evaluate('''async()=>{
          const iframe=document.createElement('iframe');iframe.id='dynamic-player';
          iframe.style.cssText='height:100px;width:100%';
          const loaded=new Promise(resolve=>iframe.onload=resolve);
          iframe.srcdoc=playerFrameMarkup;document.body.append(iframe);await loaded;
        }''')
        await player_pair(owner.frame_locator('#dynamic-player'),start='#frame-input-button',stop='#frame-volume')
        await owner.evaluate('''async()=>{
          const iframe=document.querySelector('#dynamic-player');
          await new Promise(resolve=>{iframe.onload=resolve;iframe.srcdoc=playerFrameMarkup+'<p>reloaded</p>';});
        }''')
        await player_pair(owner.frame_locator('#dynamic-player'),start='#frame-play',stop='#frame-volume')

        # A stale installation object must be disposed and replaced, rather
        # than causing the reinjection guard to silently leave dead listeners.
        await owner.evaluate('''async()=>{
          const old=window.__withoutMikePageShortcuts;
          const dispose=old.dispose.bind(old);
          window.staleDisposals=0;
          old.isAlive=()=>false;
          old.dispose=()=>{staleDisposals++;dispose();};
          const reply=await controller.handle({type:'ARM_SHORTCUTS'});
          if(!reply.ok)throw Error(reply.error);
        }''')
        assert await owner.evaluate('staleDisposals') == 1
        await player_pair(owner.frame_locator('#existing-player'))
        await owner.evaluate('''async()=>{
          window.__withoutMikePageShortcuts.dispose();
          window.__withoutMikePageShortcuts=true;
          const reply=await controller.handle({type:'ARM_SHORTCUTS'});
          if(!reply.ok)throw Error(reply.error);
        }''')
        await player_pair(owner.frame_locator('#existing-player'),start='#frame-input-button',stop='#frame-play')

        # A quick stop must reach the background while native capture is still
        # pending. Destroying the popup must not discard its stop intention.
        await owner.evaluate('''async()=>{
          await controller.handle({type:'DISCARD'});
          popupCommands.length=0;captureGateEntered=false;
          captureGate=new Promise(resolve=>window.releaseCaptureGate=resolve);
        }''')
        timing_popup = await popup_page()
        await timing_popup.wait_for_selector('#start-button:enabled')
        await timing_popup.keyboard.press('1')
        await owner.wait_for_function('captureGateEntered')
        await timing_popup.keyboard.press('2')
        await timing_popup.keyboard.press('2')
        await owner.wait_for_function("popupCommands.some(message=>message.type === 'STOP_PENDING')")
        pending = await owner.evaluate("popupCommands.filter(message=>['START','STOP_PENDING'].includes(message.type))")
        assert [message['type'] for message in pending] == ['START','STOP_PENDING'], pending
        assert pending[0]['operationId'] and pending[0]['operationId'] == pending[1]['operationId'], pending
        assert pending[1]['mode'] == 'audio', pending
        assert await owner.evaluate('recorder.getState().status') == 'starting'
        await timing_popup.close()
        # The START promise still has not completed, and no live popup remains
        # to send any later STOP. Only the already-bound request can end it.
        assert await owner.evaluate('recorder.getState().status') == 'starting'
        await owner.evaluate('releaseCaptureGate();captureGate=null')
        await owner.wait_for_function("['ready','error'].includes(recorder.getState().status)")
        assert await owner.evaluate('recorder.stream === null && recorder.mediaRecorder === null')
        assert await owner.evaluate("lastCapturedTracks.length > 0 && lastCapturedTracks.every(track=>track.readyState === 'ended')")
        assert await owner.evaluate("popupCommands.filter(message=>message.type === 'STOP_PENDING').length") == 1
        print(json.dumps({'container': probe['format']['format_name'],
                          'codec': probe['streams'][0]['codec_name'],
                          'duration': probe['format']['duration'], 'bytes': sample.stat().st_size,
                          'trimDuration': clip_probe['format']['duration'], 'trimFrequency': frequency,
                          'ui': 'popup closed: range1 record despite prior preventDefault, pause, resume, player2 stop; input guards, existing/dynamic/reloaded iframe keys, stale/legacy reinjection, actual command assignment/settings, hundredths, preview, trim, persist range, full save; quick popup1→2 sends durable STOP_PENDING before delayed capture and survives popup close',
                          'scope': 'synthetic input and Chrome API bridge; real page keys, MP4 encoder and popup UI'}, ensure_ascii=False))
        await browser.close()

try:
    asyncio.run(main())
finally:
    server.shutdown()
