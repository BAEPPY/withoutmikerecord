"""Lossless MP4 track extraction with native Chromium and independent ffmpeg checks.
Synthetic video/audio only; no microphone, tab capture, upload or re-encoding
is used by the track selector. A middle-range source exercises trim integration.
"""
import asyncio
import base64
import functools
import hashlib
import json
import os
from array import array
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


def probe(path):
    return json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))


def packets(path, kind):
    selector = 'a:0' if kind == 'audio' else 'v:0'
    data = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', selector,
        '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', str(path)]))
    return data['packets']


def decoded(path, kind):
    # Raw-video muxing needs monotonic output timestamps. Packet timestamps are
    # independently compared above; this filter preserves all decoded pixels.
    args = ['ffmpeg', '-v', 'error', '-i', str(path)]
    args += ['-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'] if kind == 'audio' else [
        '-an', '-vf', 'setpts=N/30/TB', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']
    return subprocess.check_output(args)


def frequency(raw):
    samples = array('f')
    samples.frombytes(raw)
    portion = samples[len(samples) // 8:len(samples) * 3 // 8]
    crossings = sum(a <= 0 < b for a, b in zip(portion, portion[1:]))
    return crossings * 48000 / len(portion)


async def main():
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                headless=True, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            page = await browser.new_page()
            await page.goto(f'http://127.0.0.1:{server.server_port}/')
            h264 = base64.b64encode((ROOT / 'test/fixtures/av-fragmented.mp4').read_bytes()).decode()
            data = await page.evaluate('''async (h264) => {
              const {selectMp4Tracks} = await import('./mp4-tracks.js');
              const {trimVideo} = await import('./video-trim.js');
              const mimeType=['video/mp4;codecs=avc1.420028,mp4a.40.2','video/mp4;codecs=vp9,opus','video/mp4']
                .find(type=>MediaRecorder.isTypeSupported(type));
              if(!mimeType)throw Error('Native MP4 unavailable');
              const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
              const drawing=canvas.getContext('2d');drawing.fillStyle='#ff0000';drawing.fillRect(0,0,320,180);
              const video=canvas.captureStream(30),context=new AudioContext();
              const oscillator=context.createOscillator(),gain=context.createGain(),audio=context.createMediaStreamDestination();
              oscillator.frequency.value=440;gain.gain.value=0.15;oscillator.connect(gain).connect(audio);oscillator.start();await context.resume();
              const stream=new MediaStream([...video.getTracks(),...audio.stream.getTracks()]);
              const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:1000000,audioBitsPerSecond:128000});
              const chunks=[];recorder.ondataavailable=({data})=>{if(data.size)chunks.push(data);};
              const done=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=reject;});
              recorder.start(250);const began=performance.now();let changed=false;
              const timer=setInterval(()=>{const second=(performance.now()-began)/1000;
                drawing.fillStyle=second>=1.4?'#00ff00':'#ff0000';drawing.fillRect(0,0,320,180);
                if(second>=1.4&&!changed){changed=true;oscillator.frequency.setValueAtTime(880,context.currentTime);}
              },16);
              await new Promise(resolve=>setTimeout(resolve,2800));recorder.stop();await done;
              clearInterval(timer);for(const track of stream.getTracks())track.stop();oscillator.stop();await context.close();
              const native=new Blob(chunks,{type:mimeType});
              const range=(await trimVideo(native,0.7,2.1)).blob;
              const cases={native,range,h264:new Blob([Uint8Array.from(atob(h264),value=>value.charCodeAt(0))],{type:'video/mp4'})};
              const outputs={},metadata={};
              const encode=async(blob)=>{const bytes=new Uint8Array(await blob.arrayBuffer());let text='';
                for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);};
              for(const [name,source] of Object.entries(cases)){
                outputs[name+'-source']=await encode(source);metadata[name]={};
                for(const content of ['both','audio','video']){
                  const progress=[];const result=await selectMp4Tracks(source,content,{onProgress:value=>progress.push(value)});
                  if(progress[0]!==0||progress.at(-1)!==1)throw Error('Missing progress');
                  if(content==='both'&&result.blob!==source)throw Error('Both must reuse original native blob');
                  metadata[name][content]={...result,blob:undefined};outputs[name+'-'+content]=await encode(result.blob);
                }
              }
              const controller=new AbortController();let cancelled=false;
              try{await selectMp4Tracks(native,'audio',{signal:controller.signal,onProgress:value=>{if(value>=0.1)controller.abort();}});}
              catch(error){if(error.name!=='AbortError')throw error;cancelled=true;}
              if(!cancelled)throw Error('Cancellation failed');
              return{mimeType,metadata,outputs,cancelled};
            }''', h264)
            await browser.close()
        paths = {}
        for name, encoded in data.pop('outputs').items():
            paths[name] = OUTPUT / f'mp4-tracks-{name}.mp4'
            paths[name].write_bytes(base64.b64decode(encoded))
        summary = {}
        for name in ['native', 'range', 'h264']:
            source = paths[name + '-source']
            assert paths[name + '-both'].read_bytes() == source.read_bytes()
            summary[name] = {}
            for kind in ['audio', 'video']:
                output = paths[name + '-' + kind]
                info = probe(output)
                assert [track['codec_type'] for track in info['streams']] == [kind], info['streams']
                before, after = packets(source, kind), packets(output, kind)
                assert len(before) == len(after) > 0
                for index, (old, new) in enumerate(zip(before, after)):
                    assert old['data_hash'] == new['data_hash'], (name, kind, index, 'encoded packet changed')
                    for field in ['pts_time', 'dts_time', 'duration_time']:
                        # FFprobe omits packet duration for some native Opus/VP9
                        # fragments. Unit tests also compare stored durations.
                        if field == 'duration_time' and (field not in old or field not in new):
                            continue
                        assert abs(float(old[field]) - float(new[field])) <= 0.000002, (name, kind, index, field, old[field], new[field])
                original_pixels_or_audio = decoded(source, kind)
                extracted_pixels_or_audio = decoded(output, kind)
                assert original_pixels_or_audio == extracted_pixels_or_audio, (name, kind, 'decoded media changed')
                measured_duration = float(info['format']['duration'])
                assert abs(measured_duration - data['metadata'][name][kind]['durationSeconds']) < 0.002
                summary[name][kind] = {'codec': info['streams'][0]['codec_name'], 'packets': len(after),
                    'durationSeconds': measured_duration, 'decodedSha256': hashlib.sha256(extracted_pixels_or_audio).hexdigest()}
                if kind == 'audio':
                    tone = frequency(extracted_pixels_or_audio)
                    expected = 660 if name == 'h264' else 440
                    assert abs(tone - expected) < 20, (name, tone)
                    summary[name][kind]['initialToneHz'] = round(tone, 2)
            if name in ['native', 'range']:
                pixels = decoded(paths[name + '-video'], 'video')
                frame_bytes = 320 * 180 * 3
                colors = [tuple(pixels[i:i+3]) for i in range(0, len(pixels), frame_bytes)]
                assert colors[0][0] > 180 and colors[-1][1] > 180, (name, colors[0], colors[-1])
        print(json.dumps({'nativeMimeType': data['mimeType'], 'cases': summary, 'cancelled': data['cancelled'], 'result': 'passed'}))
    finally:
        server.shutdown()


asyncio.run(main())
