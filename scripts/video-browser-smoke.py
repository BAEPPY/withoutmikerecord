"""Real video crop/MP4/GIF/UI smoke with synthetic tab capture and Chrome API bridge."""
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
        browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
            headless=True, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        context = await browser.new_context(viewport={'width': 640, 'height': 360})
        owner = await context.new_page()
        await owner.goto(f'http://127.0.0.1:{server.server_port}/')
        await owner.evaluate('''async () => {
          const {TabAudioRecorder} = await import('./recorder.js');
          const {createController} = await import('./controller.js');
          document.body.style.margin = '0';
          document.body.innerHTML = '<canvas id="source" width="640" height="360" style="position:fixed;inset:0;width:100vw;height:100vh"></canvas>';
          const canvas = document.querySelector('#source');
          const ctx = canvas.getContext('2d');
          let frame = 0;
          const draw = () => {
            ctx.fillStyle = '#0000ff'; ctx.fillRect(0,0,640,360);
            ctx.fillStyle = Math.floor(frame++ / 10) % 2 ? '#ff0000' : '#00ff00';
            ctx.fillRect(160,90,320,180);
          };
          draw(); window.sourceTimer = setInterval(draw, 33);
          const video = canvas.captureStream(30);
          const ac = new AudioContext();
          const oscillator = ac.createOscillator(); oscillator.frequency.value = 440;
          const gain = ac.createGain(); gain.gain.value = 0.15;
          const audio = ac.createMediaStreamDestination();
          oscillator.connect(gain).connect(audio); oscillator.start(); await ac.resume();
          const source = new MediaStream([...video.getVideoTracks(),...audio.stream.getAudioTracks()]);
          window.captureCount = 0; window.commands = []; window.downloaded = []; window.pageListeners = [];
          window.recorder = new TabAudioRecorder({mediaDevices:{getUserMedia:async(constraints)=>{
            if(constraints.audio.mandatory.chromeMediaSource !== 'tab' || constraints.video.mandatory.chromeMediaSource !== 'tab') throw Error('Wrong capture source');
            captureCount++; return source;
          }}});
          const tab = {id:1,active:true,windowId:1,url:'https://example.test/video',title:'영역 녹화 테스트'};
          window.chrome = {
            runtime:{id:'test-extension',getURL:path=>location.origin+'/'+path,getContexts:async()=>[{}],
              onMessage:{addListener:listener=>pageListeners.push(listener)},
              sendMessage:async(message)=>{
                if(message.target === 'offscreen') return recorder.handle(message);
                commands.push(message);
                const type = message.type === 'PAGE_SHORTCUT' ? ({1:'START',2:'PAGE_STOP',3:'BEGIN_VIDEO',4:'STOP_VIDEO'})[message.key]
                  : message.type === 'VIDEO_REGION_SELECTED' ? 'START_VIDEO'
                  : message.type === 'CANCEL_VIDEO_SELECTION' ? 'CANCEL_VIDEO' : null;
                if(!type) throw Error('Unexpected page command');
                return controller.handle({...message,type,targetTabId:1});
              }},
            tabs:{query:async()=>[tab],get:async()=>tab,
              captureVisibleTab:async()=>canvas.toDataURL('image/png'),
              sendMessage:async(id,message)=>new Promise(resolve=>{
                for(const listener of pageListeners) listener(message,{id:chrome.runtime.id},resolve);
              })},
            scripting:{executeScript:async(options)=>{
              for(const file of options.files) new Function(await(await fetch('./'+file)).text())();
            }},
            tabCapture:{getMediaStreamId:async()=> 'synthetic-video'},
            action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
            downloads:{download:async(options)=>{downloaded.push(options);return downloaded.length;},search:async()=>[{state:'complete'}]},
          };
          window.controller = createController(chrome);
          await controller.handle({type:'ARM_SHORTCUTS'});
        }''')
        # Escape cancels the frozen selection without acquiring any stream.
        await owner.keyboard.press('3')
        await owner.wait_for_selector('dialog[open]')
        await owner.keyboard.press('Escape')
        await owner.wait_for_function("recorder.getState().status === 'idle'")
        assert await owner.evaluate('captureCount') == 0
        # The screenshot remains over the live source until mouseup, then capture starts.
        await owner.keyboard.press('3')
        await owner.wait_for_selector('dialog[open]')
        await owner.screenshot(path=str(OUTPUT / 'video-region-selector.png'))
        await owner.mouse.move(160,90)
        await owner.mouse.down()
        await owner.mouse.move(480,270,steps=8)
        assert await owner.evaluate('captureCount') == 0
        await owner.mouse.up()
        await owner.wait_for_function("recorder.getState().status === 'recording'")
        assert await owner.locator('dialog').count() == 0
        await asyncio.sleep(2.1)
        # Audio's stop key must not end the video session.
        await owner.keyboard.press('2')
        assert await owner.evaluate('recorder.getState().status') == 'recording'
        await owner.keyboard.press('4')
        await owner.wait_for_function("recorder.getState().status === 'ready'")
        state = await owner.evaluate('recorder.getState()')
        assert state['result']['kind'] == 'video'
        assert (state['result']['width'],state['result']['height']) == (320,180), state
        async def save_blob(expression, path):
            data = await owner.evaluate(f'async()=>Array.from(new Uint8Array(await(await fetch({expression})).arrayBuffer()))')
            path.write_bytes(bytes(data))
        video_path = OUTPUT / 'test-region-video.mp4'
        await save_blob('recorder.getState().result.url', video_path)
        def probe(path):
            return json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(path)]))
        video_probe = probe(video_path)
        assert sorted(s['codec_type'] for s in video_probe['streams']) == ['audio','video'], video_probe
        video_stream = next(s for s in video_probe['streams'] if s['codec_type']=='video')
        assert (video_stream['width'],video_stream['height']) == (320,180)
        # Every selected pixel is red or green, while all pixels outside were blue.
        pixels = subprocess.check_output(['ffmpeg','-v','error','-i',str(video_path),'-an','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','-'])
        assert len(pixels)>6 and max(pixels[2::3]) < 35, list(pixels[:30])
        assert max(pixels[0::3]) > 180 and max(pixels[1::3]) > 180, list(pixels[:30])
        import array
        pcm = array.array('f', subprocess.check_output([
            'ffmpeg','-v','error','-i',str(video_path),'-vn','-ac','1','-ar','48000','-f','f32le','-']))
        crossings = sum(pcm[i-1] < 0 <= pcm[i] for i in range(1,len(pcm)))
        frequency = crossings * 48000 / len(pcm)
        assert 420 <= frequency <= 460 and max(abs(value) for value in pcm) > 0.05, frequency

        async def bridge(message):
            return await owner.evaluate('(message)=>controller.handle(message)', message)
        popup = await context.new_page()
        await popup.set_viewport_size({'width':380,'height':620})
        await popup.expose_function('testBridge',bridge)
        await popup.add_init_script('window.chrome={runtime:{sendMessage:message=>window.testBridge(message)}}')
        await popup.goto(f'http://127.0.0.1:{server.server_port}/popup.html')
        await popup.wait_for_selector('#video-preview:visible')
        assert await popup.locator('#audio-trim-controls').is_hidden()
        assert await popup.locator('#save-range-button').is_hidden()
        await popup.select_option('#save-format','gif')
        await popup.click('#save-button')
        await popup.wait_for_function("document.querySelector('#notice-message').textContent.includes('완료')",timeout=60000)
        gif_state = await owner.evaluate('recorder.getState()')
        assert gif_state['gifResult']['mimeType'] == 'image/gif'
        assert gif_state['result']['url'] == state['result']['url']
        assert await owner.evaluate('downloaded.at(-1).filename.endsWith(".gif")')
        gif_path = OUTPUT / 'test-region-video.gif'
        await save_blob('recorder.getState().gifResult.url',gif_path)
        gif_probe = probe(gif_path)
        assert len(gif_probe['streams'])==1 and gif_probe['streams'][0]['codec_name']=='gif',gif_probe
        assert int(gif_probe['streams'][0]['nb_frames'])>1
        assert abs(float(gif_probe['format']['duration'])-float(video_probe['format']['duration'])) < 0.12
        await popup.select_option('#save-format','mp4')
        await popup.click('#save-button')
        await popup.wait_for_function("document.querySelector('#save-button').disabled === false")
        assert await owner.evaluate('downloaded.at(-1).url === recorder.getState().result.url')
        await popup.locator('body').screenshot(path=str(OUTPUT / 'video-popup-ready.png'))
        print(json.dumps({'videoCodecs':[s['codec_name'] for s in video_probe['streams']],
          'region':[video_stream['width'],video_stream['height']], 'duration':video_probe['format']['duration'],
          'audioFrequency':frequency,
          'gifFrames':gif_probe['streams'][0]['nb_frames'],'gifDuration':gif_probe['format']['duration'],
          'verified':'3 frozen selector, Escape cancel, drag crop, 4 stop, audio/video MP4, changing cropped pixels, silent GIF, original MP4 save',
          'scope':'real keyboard, selector, native media/canvas/worker/UI; synthetic tabCapture and download APIs'},ensure_ascii=False))
        await browser.close()

try:
    asyncio.run(main())
finally:
    server.shutdown()
