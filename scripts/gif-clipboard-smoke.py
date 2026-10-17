"""Real browser GIF clipboard roundtrip and Ctrl+V into an HTML editor.
Clipboard read permission is granted only to this test context. Product code
requests write access and does not read or upload clipboard contents.
"""
import asyncio
import base64
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
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                headless=True, args=['--no-sandbox'])
            context = await browser.new_context(permissions=['clipboard-read', 'clipboard-write'])
            page = await context.new_page()
            await page.goto(f'http://127.0.0.1:{server.server_port}/')
            await page.add_script_tag(path=str(ROOT / 'extension/gif-clipboard.js'))
            await page.evaluate('''async () => {
              const {GIFEncoder} = await import('./vendor/gifenc/gifenc.esm.js');
              const encoder = GIFEncoder();const palette=[[255,0,0],[0,255,0]];
              encoder.writeFrame(new Uint8Array(32*32).fill(0),32,32,{palette,delay:200,repeat:0});
              encoder.writeFrame(new Uint8Array(32*32).fill(1),32,32,{palette,delay:200,repeat:0});
              encoder.finish();window.fixture=new Blob([encoder.bytesView()],{type:'image/gif'});
              document.body.innerHTML='<button id="copy">GIF 복사</button><div id="paste" contenteditable="true" style="min-height:100px;border:1px solid gray"></div>';
              document.querySelector('#copy').addEventListener('click',async()=>{
                try{window.copyResult=await __withoutMikeCopyGif(fixture);}catch(error){window.copyError=error.message;}
              });
              window.pasteTypes=[];document.querySelector('#paste').addEventListener('paste',event=>{pasteTypes=[...event.clipboardData.types];});
            }''')
            await page.click('#copy')
            await page.wait_for_function('window.copyResult || window.copyError')
            error = await page.evaluate('window.copyError || null')
            assert error is None, error
            result = await page.evaluate('''async () => {
              const items=await navigator.clipboard.read();const item=items[0];
              const expected=new Uint8Array(await fixture.arrayBuffer());
              const equal=(bytes)=>bytes.length===expected.length&&bytes.every((value,index)=>value===expected[index]);
              let html=null,rawPreserved=null;
              if(item.types.includes('text/html'))html=await(await item.getType('text/html')).text();
              if(item.types.includes('web image/gif'))rawPreserved=equal(new Uint8Array(await(await item.getType('web image/gif')).arrayBuffer()));
              if(item.types.includes('image/gif'))rawPreserved=equal(new Uint8Array(await(await item.getType('image/gif')).arrayBuffer()));
              return{mode:copyResult.mode,types:item.types,htmlContainsGif:html?.includes('data:image/gif;base64,')??false,rawPreserved,
                nativeSupported:ClipboardItem.supports('image/gif'),customSupported:ClipboardItem.supports('web image/gif')};
            }''')
            assert result['mode'] in ['native-gif', 'html-gif']
            if result['mode'] == 'html-gif':
                assert result['htmlContainsGif'], result
            if result['customSupported'] or result['nativeSupported']:
                assert result['rawPreserved'] is True, result
            assert 'image/png' not in result['types'] and 'text/plain' not in result['types'], result
            await page.click('#paste')
            await page.keyboard.press('Control+V')
            await page.wait_for_selector('#paste img', timeout=10000)
            pasted = await page.evaluate('''async () => {
              const image=document.querySelector('#paste img');
              await image.decode();
              const blob=await(await fetch(image.src)).blob();
              const bytes=new Uint8Array(await blob.arrayBuffer());
              const expected=new Uint8Array(await fixture.arrayBuffer());
              const preserved=bytes.length===expected.length&&bytes.every((value,index)=>value===expected[index]);
              let encoded='';for(let i=0;i<bytes.length;i+=8192)encoded+=String.fromCharCode(...bytes.subarray(i,i+8192));
              return{preserved,srcKind:image.src.slice(0,22),width:image.naturalWidth,height:image.naturalHeight,pasteTypes,base64:btoa(encoded)};
            }''')
            assert pasted['preserved'], pasted
            path = OUTPUT / 'gif-clipboard-pasted.gif'
            path.write_bytes(base64.b64decode(pasted.pop('base64')))
            info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-of', 'json', str(path)]))
            stream = info['streams'][0]
            assert stream['codec_name'] == 'gif' and int(stream['nb_read_frames']) == 2, stream
            await page.screenshot(path=str(OUTPUT / 'gif-clipboard-paste.png'))
            await browser.close()
        print(json.dumps({**result, 'paste': pasted, 'animationFrames': 2, 'result': 'passed'}, ensure_ascii=False))
    finally:
        server.shutdown()


asyncio.run(main())
