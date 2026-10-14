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
VIEWPORT_WIDTH = int(os.environ.get('VIDEO_VIEWPORT_WIDTH', '640'))
VIEWPORT_HEIGHT = int(os.environ.get('VIDEO_VIEWPORT_HEIGHT', '360'))
CAPTURE_WIDTH = int(os.environ.get('VIDEO_CAPTURE_WIDTH', str(VIEWPORT_WIDTH)))
CAPTURE_HEIGHT = int(os.environ.get('VIDEO_CAPTURE_HEIGHT', str(VIEWPORT_HEIGHT)))
CASE_SUFFIX = '-' + os.environ['VIDEO_CASE'] if os.environ.get('VIDEO_CASE') else ''
assert min(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, CAPTURE_WIDTH, CAPTURE_HEIGHT) >= 64
CONTAIN_SCALE = min(CAPTURE_WIDTH / VIEWPORT_WIDTH, CAPTURE_HEIGHT / VIEWPORT_HEIGHT)
CONTENT_WIDTH = round(VIEWPORT_WIDTH * CONTAIN_SCALE)
CONTENT_HEIGHT = round(VIEWPORT_HEIGHT * CONTAIN_SCALE)
EXPECTED_CROP = (int(CONTENT_WIDTH / 4) * 2, int(CONTENT_HEIGHT / 4) * 2)


def assert_cropped_pixels(path, width, height):
    """Check decoded pixels, including every corner, rather than frame averages."""
    # Only this raw-pixel check normalizes timestamps. ffprobe independently
    # checks original MP4/GIF durations below; no decoded frames are dropped.
    pixels = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(path), '-an',
        '-vf', 'setpts=N/30/TB', '-fps_mode', 'passthrough',
        '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])
    frame_bytes = width * height * 3
    assert len(pixels) % frame_bytes == 0 and len(pixels) > frame_bytes, len(pixels)
    red, green, blue = pixels[0::3], pixels[1::3], pixels[2::3]
    assert max(blue) < 60, f'{path.name}: blue from outside the selected region'
    assert all(max(r, g) > 130 for r, g in zip(red, green)), f'{path.name}: black padding in the selected region'
    assert max(red) > 180 and max(green) > 180, f'{path.name}: animation colors did not change'
    corners = (0, (width - 1) * 3, (height - 1) * width * 3, frame_bytes - 3)
    for offset in range(0, len(pixels), frame_bytes):
        for corner in corners:
            r, g, b = pixels[offset + corner:offset + corner + 3]
            assert b < 60 and max(r, g) > 130, (path.name, offset // frame_bytes, corner, (r, g, b))
    return len(pixels) // frame_bytes

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'extension')))
threading.Thread(target=server.serve_forever, daemon=True).start()

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
            headless=True, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        # Clipboard read permission is only for assertions in this test; the
        # extension itself requests write permission only.
        context = await browser.new_context(viewport={'width': VIEWPORT_WIDTH, 'height': VIEWPORT_HEIGHT},
            permissions=['clipboard-read','clipboard-write'])
        owner = await context.new_page()
        await owner.goto(f'http://127.0.0.1:{server.server_port}/')
        await owner.evaluate('''async ({viewportWidth, viewportHeight, captureWidth, captureHeight}) => {
          const {TabAudioRecorder} = await import('./recorder.js');
          const {createController} = await import('./controller.js');
          document.body.style.margin = '0';
          document.body.innerHTML = '<canvas id="source" style="position:fixed;inset:0;width:100vw;height:100vh"></canvas>';
          const canvas = document.querySelector('#source');
          canvas.width = viewportWidth; canvas.height = viewportHeight;
          const ctx = canvas.getContext('2d');
          // Model Chromium's capture output separately from the visible page:
          // the encoded frame may contain black bars around the CSS viewport.
          const encoded = document.createElement('canvas');
          encoded.width = captureWidth; encoded.height = captureHeight;
          const encodedContext = encoded.getContext('2d');
          const containScale = Math.min(captureWidth / viewportWidth, captureHeight / viewportHeight);
          const contentWidth = Math.round(viewportWidth * containScale);
          const contentHeight = Math.round(viewportHeight * containScale);
          const contentX = Math.floor((captureWidth - contentWidth) / 2);
          const contentY = Math.floor((captureHeight - contentHeight) / 2);
          let frame = 0;
          const draw = () => {
            ctx.fillStyle = '#0000ff'; ctx.fillRect(0,0,viewportWidth,viewportHeight);
            ctx.fillStyle = Math.floor(frame++ / 10) % 2 ? '#ff0000' : '#00ff00';
            ctx.fillRect(viewportWidth / 4,viewportHeight / 4,viewportWidth / 2,viewportHeight / 2);
            encodedContext.fillStyle = '#000000'; encodedContext.fillRect(0,0,captureWidth,captureHeight);
            encodedContext.drawImage(canvas,contentX,contentY,contentWidth,contentHeight);
          };
          draw(); window.sourceTimer = setInterval(draw, 33);
          const video = encoded.captureStream(30);
          const ac = new AudioContext();
          const oscillator = ac.createOscillator(); oscillator.frequency.value = 440;
          const gain = ac.createGain(); gain.gain.value = 0.15;
          const audio = ac.createMediaStreamDestination();
          oscillator.connect(gain).connect(audio); oscillator.start(); await ac.resume();
          const source = new MediaStream([...video.getVideoTracks(),...audio.stream.getAudioTracks()]);
          window.captureCount = 0; window.commands = []; window.downloaded = []; window.pageListeners = [];
          window.recorder = new TabAudioRecorder({mediaDevices:{getUserMedia:async(constraints)=>{
            if(constraints.audio.mandatory.chromeMediaSource !== 'tab' || constraints.video.mandatory.chromeMediaSource !== 'tab') throw Error('Wrong capture source');
            captureCount++;
            return new MediaStream(source.getTracks().map(track=>track.clone()));
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
                  : message.type === 'CANCEL_VIDEO_SELECTION' ? 'CANCEL_VIDEO'
                  : message.type === 'VIDEO_VIEWPORT_CHANGED' ? 'VIDEO_VIEWPORT_CHANGED' : null;
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
        }''', {'viewportWidth':VIEWPORT_WIDTH,'viewportHeight':VIEWPORT_HEIGHT,
              'captureWidth':CAPTURE_WIDTH,'captureHeight':CAPTURE_HEIGHT})
        async def select_region():
            await owner.keyboard.press('3')
            await owner.wait_for_selector('dialog[open]')
            await owner.mouse.move(VIEWPORT_WIDTH / 4, VIEWPORT_HEIGHT / 4)
            await owner.mouse.down()
            await owner.mouse.move(VIEWPORT_WIDTH * 3 / 4, VIEWPORT_HEIGHT * 3 / 4, steps=8)
            await owner.mouse.up()
            await owner.wait_for_function("recorder.getState().status === 'recording'")
        # Escape cancels the frozen selection without acquiring any stream.
        await owner.keyboard.press('3')
        await owner.wait_for_selector('dialog[open]')
        await owner.keyboard.press('Escape')
        await owner.wait_for_function("recorder.getState().status === 'idle'")
        assert await owner.evaluate('captureCount') == 0
        # The screenshot remains over the live source until mouseup, then capture starts.
        await owner.keyboard.press('3')
        await owner.wait_for_selector('dialog[open]')
        await owner.screenshot(path=str(OUTPUT / f'video-region-selector{CASE_SUFFIX}.png'))
        await owner.mouse.move(VIEWPORT_WIDTH / 4, VIEWPORT_HEIGHT / 4)
        await owner.mouse.down()
        await owner.mouse.move(VIEWPORT_WIDTH * 3 / 4, VIEWPORT_HEIGHT * 3 / 4,steps=8)
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
        assert (state['result']['width'],state['result']['height']) == EXPECTED_CROP, state
        async def save_blob(expression, path):
            data = await owner.evaluate(f'async()=>Array.from(new Uint8Array(await(await fetch({expression})).arrayBuffer()))')
            path.write_bytes(bytes(data))
        video_path = OUTPUT / f'test-region-video{CASE_SUFFIX}.mp4'
        await save_blob('recorder.getState().result.url', video_path)
        def probe(path):
            return json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(path)]))
        video_probe = probe(video_path)
        assert sorted(s['codec_type'] for s in video_probe['streams']) == ['audio','video'], video_probe
        video_stream = next(s for s in video_probe['streams'] if s['codec_type']=='video')
        assert (video_stream['width'],video_stream['height']) == EXPECTED_CROP
        # Every selected pixel is red or green, while all pixels outside were blue.
        video_frames = assert_cropped_pixels(video_path, *EXPECTED_CROP)
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
        assert await popup.locator('#audio-trim-controls').is_visible()
        assert await popup.locator('#save-range-button').is_visible()
        assert state['selection']['startSeconds'] == 0
        assert state['result']['trimError'] is None
        await popup.fill('#trim-start','0.35')
        await popup.fill('#trim-end','1.25')
        await popup.locator('#trim-end').blur()
        await owner.wait_for_function("recorder.getState().selection.endSeconds === 1.25")
        assert await popup.input_value('#trim-start') == '0.35'
        assert await popup.input_value('#trim-end') == '1.25'
        await popup.click('#preview-range')
        await popup.wait_for_function("document.querySelector('#video-preview').paused && document.querySelector('#video-preview').currentTime >= 1.2")
        assert await popup.locator('#video-preview').evaluate('(video)=>video.currentTime') < 1.4
        await popup.click('#save-range-button')
        await owner.wait_for_function('downloaded.length === 1',timeout=60000)
        await popup.wait_for_function("!document.querySelector('#save-range-button').disabled")
        clip_state = await owner.evaluate('recorder.getState()')
        assert clip_state['result']['url'] == state['result']['url']
        assert clip_state['exportResult']['kind'] == 'video'
        clip_path = OUTPUT / f'test-region-clip{CASE_SUFFIX}.mp4'
        await save_blob('recorder.getState().exportResult.url',clip_path)
        clip_probe = probe(clip_path)
        assert sorted(s['codec_type'] for s in clip_probe['streams']) == ['audio','video']
        assert abs(float(clip_probe['format']['duration'])-0.9) < 0.15, clip_probe
        clip_frames = assert_cropped_pixels(clip_path,*EXPECTED_CROP)
        await popup.select_option('#save-format','gif')
        await popup.click('#save-button')
        await owner.wait_for_function('downloaded.length === 2',timeout=60000)
        await popup.wait_for_function("!document.querySelector('#save-button').disabled")
        gif_state = await owner.evaluate('recorder.getState()')
        assert gif_state['gifResult']['mimeType'] == 'image/gif'
        assert gif_state['result']['url'] == state['result']['url']
        assert await owner.evaluate('downloaded.at(-1).filename.endsWith(".gif")')
        gif_path = OUTPUT / f'test-region-video{CASE_SUFFIX}.gif'
        await save_blob('recorder.getState().gifResult.url',gif_path)
        gif_probe = probe(gif_path)
        assert len(gif_probe['streams'])==1 and gif_probe['streams'][0]['codec_name']=='gif',gif_probe
        assert int(gif_probe['streams'][0]['nb_frames'])>1
        gif_stream = gif_probe['streams'][0]
        gif_frames = assert_cropped_pixels(gif_path, gif_stream['width'], gif_stream['height'])
        assert abs(float(gif_probe['format']['duration'])-float(video_probe['format']['duration'])) < 0.12
        await popup.click('#save-range-button')
        await owner.wait_for_function('downloaded.length === 3',timeout=60000)
        await popup.wait_for_function("!document.querySelector('#save-range-button').disabled")
        range_gif_state = await owner.evaluate('recorder.getState()')
        assert range_gif_state['gifResult']['url'] == gif_state['gifResult']['url']
        assert range_gif_state['result']['url'] == state['result']['url']
        assert abs(range_gif_state['rangeGifResult']['durationSeconds']-0.9) < 0.001
        range_gif_path = OUTPUT / f'test-region-clip{CASE_SUFFIX}.gif'
        await save_blob('recorder.getState().rangeGifResult.url',range_gif_path)
        range_gif_probe = probe(range_gif_path)
        assert len(range_gif_probe['streams']) == 1 and range_gif_probe['streams'][0]['codec_name'] == 'gif'
        assert abs(float(range_gif_probe['format']['duration'])-0.9) < 0.011
        range_gif_frames = assert_cropped_pixels(range_gif_path,*EXPECTED_CROP)
        for button, result_key in [('copy-gif-button','gifResult'),('copy-range-gif-button','rangeGifResult')]:
            await popup.click('#'+button)
            await popup.wait_for_function("!document.querySelector('#copy-gif-button').disabled && document.querySelector('#copy-status').textContent.includes('복사 완료')")
            assert await popup.locator('#copy-status').get_attribute('data-mode') == 'html-gif'
            copied = await popup.evaluate('''async()=>{
              const [item] = await navigator.clipboard.read();
              const bytes = await (await item.getType('web image/gif')).arrayBuffer();
              const hash = await crypto.subtle.digest('SHA-256',bytes);
              const html = await (await item.getType('text/html')).text();
              return {hash:Array.from(new Uint8Array(hash)),animatedHtml:html.includes('data:image/gif;base64,'),types:item.types};
            }''')
            expected_hash = await owner.evaluate('''async(key)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
              await(await fetch(recorder.getState()[key].url)).arrayBuffer())))''',result_key)
            assert copied['hash'] == expected_hash and copied['animatedHtml'], copied
            assert 'image/png' not in copied['types']
            assert await owner.evaluate('downloaded.length') == 3
        await popup.select_option('#save-format','mp4')
        await popup.click('#save-button')
        await owner.wait_for_function('downloaded.length === 4')
        await popup.wait_for_function("document.querySelector('#save-button').disabled === false")
        assert await owner.evaluate('downloaded.at(-1).url === recorder.getState().result.url')
        await popup.locator('body').screenshot(path=str(OUTPUT / f'video-popup-ready{CASE_SUFFIX}.png'))
        # A different native trim can be cancelled without deleting either the
        # original, previous clip, or previously created whole/range GIFs.
        await popup.fill('#trim-start','0.05')
        await popup.fill('#trim-end','1.90')
        await popup.locator('#trim-end').blur()
        await popup.click('#save-range-button')
        await owner.wait_for_function("recorder.getState().status === 'trimming'")
        await popup.click('#cancel-export-button')
        await owner.wait_for_function("recorder.getState().status === 'ready'")
        await popup.wait_for_function("!document.querySelector('#save-range-button').disabled")
        cancelled = await owner.evaluate('recorder.getState()')
        assert cancelled['result']['url'] == state['result']['url']
        assert cancelled['exportResult']['url'] == clip_state['exportResult']['url']
        assert '취소' in cancelled['notice']
        assert await owner.evaluate('downloaded.length') == 4
        assert await popup.locator('#error-message').is_hidden()
        await popup.close()
        await owner.bring_to_front()
        await owner.evaluate("controller.handle({type:'DISCARD'})")
        # The source layout can resize even though capture remains the same
        # encoded dimensions. The page listener must stop this second session.
        await select_region()
        await asyncio.sleep(0.5)
        await owner.set_viewport_size({'width':VIEWPORT_WIDTH + 100,'height':VIEWPORT_HEIGHT + 40})
        await owner.wait_for_function("recorder.getState().status === 'ready'")
        resized = await owner.evaluate('recorder.getState()')
        assert '화면 크기' in resized['notice'], resized
        assert resized['result']['kind'] == 'video' and resized['result']['bytes'] > 0
        assert await owner.evaluate("commands.some(message=>message.type === 'VIDEO_VIEWPORT_CHANGED')")
        print(json.dumps({'videoCodecs':[s['codec_name'] for s in video_probe['streams']],
          'viewport':[VIEWPORT_WIDTH,VIEWPORT_HEIGHT],'captureFrame':[CAPTURE_WIDTH,CAPTURE_HEIGHT],
          'region':[video_stream['width'],video_stream['height']], 'duration':video_probe['format']['duration'],
          'audioFrequency':frequency,
          'gifFrames':gif_probe['streams'][0]['nb_frames'],'gifDuration':gif_probe['format']['duration'],
          'checkedPixels':{'videoFrames':video_frames,'gifFrames':gif_frames,'clipFrames':clip_frames,'rangeGifFrames':range_gif_frames,'allCorners':True},
          'clipDuration':clip_probe['format']['duration'],'rangeGifDuration':range_gif_probe['format']['duration'],
          'verified':'3 frozen selector, Escape cancel, letterboxed drag crop, 4 stop, audio/video MP4, every cropped pixel, silent GIF, hundredths video editor/preview, selected MP4/GIF, whole/range animated GIF clipboard bytes, native trim cancellation, original/cache preservation, viewport resize stops recording',
          'scope':'real keyboard, selector, native media/canvas/worker/UI; synthetic tabCapture and download APIs'},ensure_ascii=False))
        await browser.close()

try:
    asyncio.run(main())
finally:
    server.shutdown()
