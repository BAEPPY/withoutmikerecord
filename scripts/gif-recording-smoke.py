"""Native region GIF and consecutive-capture regression.

Actual keys, selector, canvas, MediaRecorder, GIF encoder and popup run in Chromium.
Tab capture and download APIs use synthetic local sources; no microphone, upload,
real tabCapture permission or extension-installation policy changes are involved.
"""
import asyncio
import functools
import json
import os
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'dist'
OUTPUT.mkdir(exist_ok=True)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def probe(path):
    return json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-count_frames', '-show_streams',
        '-show_format', '-of', 'json', str(path)]))


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0),
        functools.partial(QuietHandler, directory=str(ROOT / 'extension')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    summaries = {}
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                headless=True, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            context = await browser.new_context(viewport={'width': 640, 'height': 360},
                permissions=['clipboard-read', 'clipboard-write'])
            owner = await context.new_page()
            await owner.goto(f'http://127.0.0.1:{server.server_port}/')
            await owner.evaluate('''async () => {
              const {TabAudioRecorder} = await import('./recorder.js');
              const {createController} = await import('./controller.js');
              document.body.style.margin='0';
              document.body.innerHTML='<canvas id="source" style="position:fixed;inset:0;width:100vw;height:100vh"></canvas>';
              const canvas=document.querySelector('#source');canvas.width=640;canvas.height=360;
              const drawing=canvas.getContext('2d');
              let frame=0;
              const draw=()=>{
                drawing.fillStyle='blue';drawing.fillRect(0,0,640,360);
                drawing.fillStyle=frame++%10<5?'#ef2626':'#26ef26';
                drawing.fillRect(160,90,320,180);
              };
              draw();window.sourceTimer=setInterval(draw,50);
              const video=canvas.captureStream(20);
              const sourceContext=new AudioContext();
              const oscillator=sourceContext.createOscillator();oscillator.frequency.value=440;
              const gain=sourceContext.createGain();gain.gain.value=.15;
              const destination=sourceContext.createMediaStreamDestination();
              oscillator.connect(gain).connect(destination);oscillator.start();await sourceContext.resume();
              window.captures=[];window.audioContexts=0;window.downloaded=[];window.downloadStates={};
              window.downloadMode='complete';window.pageListeners=[];window.commands=[];
              class CountedAudioContext extends AudioContext {
                constructor(){super();audioContexts++;}
              }
              window.recorder=new TabAudioRecorder({
                AudioContext:CountedAudioContext,
                mediaDevices:{getUserMedia:async constraints=>{
                  captures.push(structuredClone(constraints));
                  const tracks=[];
                  if(constraints.video!==false)tracks.push(...video.getVideoTracks());
                  if(constraints.audio!==false)tracks.push(...destination.stream.getAudioTracks());
                  return new MediaStream(tracks.map(track=>track.clone()));
                }},
              });
              const tab={id:1,active:true,windowId:1,url:'https://example.test/gif',title:'GIF regression'};
              window.chrome={
                runtime:{id:'test-extension',getManifest:()=>({version:'1.9.0'}),
                  getURL:path=>location.origin+'/'+path,getContexts:async()=>[{}],
                  onMessage:{addListener:listener=>pageListeners.push(listener),
                    removeListener:listener=>{pageListeners=pageListeners.filter(item=>item!==listener);}},
                  sendMessage:async message=>{
                    if(message.target==='offscreen')return recorder.handle(message);
                    commands.push(message);
                    const type=message.type==='PAGE_SHORTCUT'
                      ?({1:'START',2:'PAGE_STOP',3:'BEGIN_VIDEO',4:'STOP_VIDEO',5:'BEGIN_GIF',6:'STOP_GIF'})[message.key]
                      :message.type==='VIDEO_REGION_SELECTED'?'START_VIDEO'
                      :message.type==='CANCEL_VIDEO_SELECTION'?'CANCEL_VIDEO'
                      :message.type==='VIDEO_VIEWPORT_CHANGED'?'VIDEO_VIEWPORT_CHANGED':null;
                    if(!type)throw Error('Unexpected page command: '+message.type);
                    return controller.handle({...message,type,targetTabId:1});
                  }},
                tabs:{query:async()=>[tab],get:async()=>tab,
                  captureVisibleTab:async()=>canvas.toDataURL('image/png'),
                  sendMessage:async(id,message)=>new Promise(resolve=>{
                    let replied=false;const respond=value=>{if(!replied){replied=true;resolve(value);}};
                    for(const listener of [...pageListeners])listener(message,{id:chrome.runtime.id},respond);
                    setTimeout(()=>respond(null),500);
                  })},
                scripting:{executeScript:async options=>{
                  for(const file of options.files)new Function(await(await fetch('./'+file)).text())();
                }},
                tabCapture:{getMediaStreamId:async()=> 'synthetic-region'},
                action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
                downloads:{download:async options=>{
                  const id=downloaded.length+1;downloaded.push({...options,id});
                  downloadStates[id]=downloadMode;return id;
                },search:async({id})=>[{state:downloadStates[id]||'complete'}]},
              };
              window.controller=createController(chrome);
              await controller.handle({type:'ARM_SHORTCUTS'});
            }''')

            async def bridge(message):
                return await owner.evaluate('(message)=>controller.handle(message)', message)

            async def open_popup():
                popup = await context.new_page()
                await popup.expose_function('testBridge', bridge)
                await popup.add_init_script('''window.chrome={
                  runtime:{sendMessage:message=>window.testBridge(message)},
                  commands:{getAll:async()=>[
                    {name:'start-recording',shortcut:'Alt+Shift+1'},
                    {name:'stop-recording',shortcut:'Alt+Shift+2'},
                    {name:'start-video',shortcut:'Alt+Shift+3'},
                    {name:'stop-video',shortcut:'Alt+Shift+4'},
                    {name:'start-gif',shortcut:''},{name:'stop-gif',shortcut:''}]},
                  tabs:{create:async()=>({id:99})}};''')
                await popup.goto(f'http://127.0.0.1:{server.server_port}/popup.html')
                await popup.wait_for_function("document.querySelector('#status-label').textContent !== ''")
                return popup

            async def status():
                return (await bridge({'type': 'STATUS'}))['state']

            async def select_region(key):
                await owner.bring_to_front()
                await owner.keyboard.press(key)
                await owner.wait_for_selector('dialog[open]')
                await owner.mouse.move(160, 90)
                await owner.mouse.down()
                await owner.mouse.move(480, 270, steps=8)
                await owner.mouse.up()
                await owner.wait_for_function("recorder.getState().status==='recording'")

            async def save_blob(url, name):
                path = OUTPUT / name
                data = await owner.evaluate('''async url => Array.from(new Uint8Array(
                    await(await fetch(url)).arrayBuffer()))''', url)
                path.write_bytes(bytes(data))
                return path

            async def save(popup, button='#save-button', name='region-gif.gif'):
                count = await owner.evaluate('downloaded.length')
                await popup.click(button)
                await owner.wait_for_function('(count)=>downloaded.length>count', arg=count, timeout=60000)
                await popup.wait_for_function("!document.querySelector('#save-button').disabled")
                current = await status()
                item = await owner.evaluate('downloaded.at(-1)')
                return current, item, await save_blob(item['url'], name)

            # 5 immediately followed by 6 must cancel without acquiring a stream.
            await owner.keyboard.press('5')
            await owner.keyboard.press('6')
            await owner.wait_for_function("recorder.getState().status==='idle'")
            await asyncio.sleep(.15)
            assert await owner.evaluate('captures.length') == 0
            assert await owner.locator('dialog[open]').count() == 0

            await select_region('5')
            assert (await status())['mode'] == 'gif'
            assert await owner.evaluate('captures.at(-1).audio===false')
            assert await owner.evaluate('audioContexts') == 0
            # Other modes' stop keys must not stop GIF capture.
            await owner.keyboard.press('2')
            await owner.keyboard.press('4')
            await asyncio.sleep(.15)
            assert (await status())['status'] == 'recording'
            await asyncio.sleep(1.3)
            await owner.keyboard.press('6')
            await owner.wait_for_function("recorder.getState().status==='ready'")
            original = (await status())['result']
            assert original['kind'] == 'video'
            raw = await save_blob(original['url'], 'gif-capture-silent-source.mp4')
            raw_info = probe(raw)
            assert [track['codec_type'] for track in raw_info['streams']] == ['video']
            assert raw_info['streams'][0]['width'] == 320 and raw_info['streams'][0]['height'] == 180

            popup = await open_popup()
            await popup.wait_for_selector('#video-preview:visible')
            assert await popup.input_value('#save-format') == 'gif'
            assert await popup.locator('#save-content-field').is_hidden()
            state, first, whole = await save(popup, name='gif-mode-whole.gif')
            whole_info = probe(whole)
            assert [track['codec_type'] for track in whole_info['streams']] == ['video']
            assert whole_info['streams'][0]['codec_name'] == 'gif'
            assert int(whole_info['streams'][0]['nb_read_frames']) > 2
            pixels = subprocess.check_output(['ffmpeg','-v','error','-i',str(whole),'-pix_fmt','rgb24','-f','rawvideo','-'])
            frame_bytes = 320*180*3
            assert len(pixels) > frame_bytes and len({pixels[i:i+3] for i in range(0,len(pixels),frame_bytes)}) > 1
            await popup.wait_for_selector('#start-gif-button:enabled')
            assert state['result']['url'] == original['url'], 'saved result retained until next capture'
            summaries['gif'] = {'frames':whole_info['streams'][0]['nb_read_frames'],
                'dimensions':[320,180], 'rawTracks':['video'], 'recordingAudioContexts':0}

            # A pending or interrupted save is not permission to discard/restart.
            await popup.fill('#trim-start', '0.20')
            await popup.fill('#trim-end', '0.90')
            await popup.locator('#trim-end').blur()
            await owner.evaluate("downloadMode='in_progress'")
            count = await owner.evaluate('downloaded.length')
            await popup.click('#save-range-button')
            await owner.wait_for_function('(count)=>downloaded.length>count', arg=count, timeout=60000)
            await owner.bring_to_front()
            for key in ['1','3','5']:
                await owner.keyboard.press(key)
                await asyncio.sleep(.08)
                assert (await status())['result']['url'] == original['url']
                assert (await status())['status'] == 'ready'
            pending = await owner.evaluate('downloaded.at(-1).id')
            await owner.evaluate('''async id=>{
                downloadStates[id]='interrupted';
                await controller.onDownloadChanged({id,state:{current:'interrupted'}});
            }''', pending)
            assert (await status())['download']['status'] == 'interrupted'
            await owner.keyboard.press('5')
            await asyncio.sleep(.1)
            assert (await status())['result']['url'] == original['url']
            await owner.evaluate("downloadMode='complete'")
            await popup.bring_to_front()
            state, item, partial = await save(popup, '#save-range-button', 'gif-mode-range.gif')
            partial_info = probe(partial)
            assert abs(float(partial_info['format']['duration'])-.7)<.011
            assert int(partial_info['streams'][0]['nb_read_frames']) > 2
            assert state['result']['url'] == original['url']
            last_id = item['id']
            await popup.close()

            # Successful download enables a new GIF start without DISCARD.
            await select_region('5')
            assert (await status())['mode'] == 'gif'
            await asyncio.sleep(.5)
            await owner.keyboard.press('6')
            await owner.wait_for_function("recorder.getState().status==='ready'")
            popup = await open_popup()
            await popup.wait_for_selector('#save-button:enabled')
            await save(popup, name='gif-mode-second.gif')
            await popup.close()

            # Switch directly to audio, then video after completed downloads.
            await owner.bring_to_front()
            await owner.keyboard.press('1')
            await owner.wait_for_function("recorder.getState().status==='recording' && recorder.getState().mode==='audio'")
            assert await owner.evaluate('captures.at(-1).video===false')
            await owner.evaluate('id=>controller.onDownloadChanged({id,state:{current:"complete"}})', last_id)
            assert (await status())['status'] == 'recording', 'old completion must not reset next session'
            await owner.keyboard.press('6')
            assert (await status())['status'] == 'recording'
            await asyncio.sleep(.6)
            await owner.keyboard.press('2')
            await owner.wait_for_function("recorder.getState().status==='ready'")
            popup = await open_popup()
            await popup.wait_for_selector('#audio-preview:visible')
            state, _, audio = await save(popup, name='gif-next-audio.mp4')
            assert [track['codec_type'] for track in probe(audio)['streams']] == ['audio']
            await popup.close()

            await select_region('3')
            assert (await status())['mode'] == 'video'
            await owner.keyboard.press('6')
            assert (await status())['status'] == 'recording'
            await asyncio.sleep(.6)
            await owner.keyboard.press('4')
            await owner.wait_for_function("recorder.getState().status==='ready'")
            popup = await open_popup()
            await popup.wait_for_selector('#video-preview:visible')
            assert await popup.input_value('#save-format') == 'mp4'
            state, _, combined = await save(popup, name='gif-next-video.mp4')
            assert sorted(track['codec_type'] for track in probe(combined)['streams']) == ['audio','video']
            summaries['nextCapture'] = ['gif','gif','audio','video']
            summaries['guards'] = ['quick 5/6 cancel','mode-specific stop','pending save','interrupted save',
                'saved result retained','old completion ignored']
            summaries['scope'] = 'real keys, region selector, popup, codecs and packets; synthetic tabCapture/download APIs'
            print(json.dumps(summaries), flush=True)
            await browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    asyncio.run(main())
