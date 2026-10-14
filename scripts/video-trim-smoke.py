"""Native Chromium video trim checks: selected colors/audio, silence and abort cleanup.
Uses synthetic native MP4 input; does not access a microphone or tabCapture.
Requires Python Playwright, Chromium, ffmpeg and ffprobe.
"""
import asyncio
import base64
import functools
import json
import math
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


def audio(path):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
    values = array('f')
    values.frombytes(raw)
    return values


def dominant_tone(values):
    # Ignore the short encoder startup/end tails when measuring the stable tone.
    values = values[len(values) // 5:len(values) * 4 // 5]
    rms = math.sqrt(sum(value * value for value in values) / len(values))
    crossings = sum(left <= 0 < right for left, right in zip(values, values[1:]))
    return crossings * 48000 / len(values), rms


def frame_colors(path, width=320, height=180):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-an', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])
    frame_bytes = width * height * 3
    assert len(raw) % frame_bytes == 0 and len(raw) > frame_bytes
    return [tuple(raw[offset:offset + 3]) for offset in range(0, len(raw), frame_bytes)]


async def main():
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                headless=True, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            page = await browser.new_page(viewport={'width': 640, 'height': 360})
            await page.goto(f'http://127.0.0.1:{server.server_port}/')
            data = await page.evaluate('''async () => {
              const {trimVideo, inspectVideo, createVideoTrimmer} = await import('./video-trim.js');
              const mimeType = ['video/mp4;codecs=avc1.420028,mp4a.40.2','video/mp4;codecs=vp9,opus','video/mp4']
                .find(type => MediaRecorder.isTypeSupported(type));
              if(!mimeType) throw Error('Native MP4 unavailable');
              async function original(duration, silent=false) {
                const canvas = document.createElement('canvas'); canvas.width=320;canvas.height=180;
                const drawing=canvas.getContext('2d');drawing.fillStyle='#ff0000';drawing.fillRect(0,0,320,180);
                const video=canvas.captureStream(30);
                const context=new AudioContext();const oscillator=context.createOscillator();
                const gain=context.createGain();gain.gain.value=silent?0:0.15;
                const output=context.createMediaStreamDestination();oscillator.connect(gain).connect(output);
                oscillator.frequency.value=440;oscillator.start();await context.resume();
                const stream=new MediaStream([...video.getTracks(),...output.stream.getTracks()]);
                const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:1000000,audioBitsPerSecond:128000});
                const chunks=[];recorder.ondataavailable=({data})=>{if(data.size)chunks.push(data);};
                const done=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=reject;});
                recorder.start(250);const began=performance.now();let switched=false;
                const timer=setInterval(()=>{
                  const second=(performance.now()-began)/1000;
                  drawing.fillStyle=second>=2?'#00ff00':'#ff0000';drawing.fillRect(0,0,320,180);
                  if(second>=2&&!switched){switched=true;oscillator.frequency.setValueAtTime(880,context.currentTime);}
                },16);
                await new Promise(resolve=>setTimeout(resolve,duration*1000));recorder.stop();await done;
                clearInterval(timer);for(const track of stream.getTracks())track.stop();oscillator.stop();await context.close();
                return new Blob(chunks,{type:mimeType});
              }
              async function encoded(blob){const bytes=new Uint8Array(await blob.arrayBuffer());let text='';
                for(let offset=0;offset<bytes.length;offset+=8192)text+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
                return btoa(text);}
              const full=await original(4);
              const metadata=await inspectVideo(full);
              const lateProgress=[];
              const late=await trimVideo(full,2.3,3.3,{onProgress:value=>lateProgress.push(value)});
              const crossing=await trimVideo(full,1.5,2.5);
              const silentSource=await original(1.5,true);
              const silent=await trimVideo(silentSource,0.25,1.05);
              const urls=new Set(),contexts=[],streams=[],videos=[];
              class TrackedContext extends AudioContext {constructor(){super();contexts.push(this);}}
              class TrackedStream extends MediaStream {constructor(tracks){super(tracks);streams.push(this);}}
              const instrumented=createVideoTrimmer({AudioContext:TrackedContext,MediaStream:TrackedStream,
                document:{createElement:tag=>{const element=document.createElement(tag);if(tag==='video')videos.push(element);return element;}},
                url:{createObjectURL:blob=>{const url=URL.createObjectURL(blob);urls.add(url);return url;},
                  revokeObjectURL:url=>{urls.delete(url);URL.revokeObjectURL(url);}}});
              const controller=new AbortController();let cancelled=false;
              try{await instrumented.trimVideo(full,0.25,3.25,{signal:controller.signal,onProgress:value=>{if(value>0.05)controller.abort();}});}
              catch(error){if(error.name!=='AbortError')throw error;cancelled=true;}
              if(!cancelled||urls.size||contexts.some(context=>context.state!=='closed')
                ||streams.some(stream=>stream.getTracks().some(track=>track.readyState!=='ended'))
                ||videos.some(video=>!video.paused||video.hasAttribute('src')))throw Error('Cancellation leaked media resources');
              if(lateProgress.at(-1)!==1||!lateProgress.some(value=>value>0&&value<1))throw Error('Missing conversion progress');
              return {mimeType,metadata,late:{...late,blob:undefined},crossing:{...crossing,blob:undefined},silent:{...silent,blob:undefined},cancelled,
                files:{original:await encoded(full),late:await encoded(late.blob),crossing:await encoded(crossing.blob),silent:await encoded(silent.blob)}};
            }''')
            await browser.close()
        paths = {}
        for name, encoded in data.pop('files').items():
            path = OUTPUT / f'video-trim-smoke-{name}.mp4'
            path.write_bytes(base64.b64decode(encoded))
            paths[name] = path
        for name, expected in [('late', 1.0), ('crossing', 1.0), ('silent', 0.8)]:
            info = probe(paths[name])
            streams = info['streams']
            assert {stream['codec_type'] for stream in streams} == {'audio', 'video'}, streams
            duration = float(info['format']['duration'])
            assert abs(duration - expected) < 0.2, (name, duration, expected)
            assert abs(duration - data[name]['durationSeconds']) < 0.12, (name, duration, data[name])
            durations = [float(stream['duration']) for stream in streams if 'duration' in stream]
            assert max(durations) - min(durations) < 0.15, (name, durations)
        late_colors = frame_colors(paths['late'])
        assert all(g > 180 and r < 70 and b < 70 for r, g, b in late_colors), late_colors
        crossing_colors = frame_colors(paths['crossing'])
        assert crossing_colors[0][0] > 180 and crossing_colors[0][1] < 70, crossing_colors[0]
        assert crossing_colors[-1][1] > 180 and crossing_colors[-1][0] < 70, crossing_colors[-1]
        frequency, rms = dominant_tone(audio(paths['late']))
        assert abs(frequency - 880) < 15 and rms > 0.01, (frequency, rms)
        cross_audio = audio(paths['crossing'])
        first_frequency, first_rms = dominant_tone(cross_audio[:len(cross_audio) // 3])
        last_frequency, last_rms = dominant_tone(cross_audio[len(cross_audio) * 2 // 3:])
        assert abs(first_frequency - 440) < 20 and abs(last_frequency - 880) < 20, (first_frequency, last_frequency)
        assert min(first_rms, last_rms) > 0.01
        silent = audio(paths['silent'])
        assert max(abs(value) for value in silent) < 0.0001
        print(json.dumps({**data, 'lateToneHz': round(frequency, 2), 'lateRms': round(rms, 4),
            'crossingTonesHz': [round(first_frequency, 2), round(last_frequency, 2)],
            'silentPeak': max(abs(value) for value in silent), 'result': 'passed'}, ensure_ascii=False))
    finally:
        server.shutdown()


asyncio.run(main())
