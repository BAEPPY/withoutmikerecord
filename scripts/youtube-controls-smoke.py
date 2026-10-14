"""Check YouTube control styles in Chromium using a fully intercepted fixture.

No request reaches YouTube. Requires Python Playwright, Pillow and Chromium.
"""
import asyncio
from io import BytesIO
import os
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parent.parent
SOURCE = (ROOT / 'extension' / 'youtube-controls.js').read_text()
FIXTURE = '''<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; }
  .html5-video-player { position: relative; width: 320px; height: 240px; background: rgb(20,30,90); }
  video { width: 100%; height: 100%; }
  .ytp-chrome-bottom { position: absolute; bottom: 0; width: 100%; height: 40px;
    background: rgb(220,20,30); opacity: 1; transition: opacity 0.4s; }
  .ytp-caption-window-container { position: absolute; left: 20px; top: 160px;
    width: 280px; height: 30px; background: rgb(20,180,40); color: white; }
</style>
<div class="html5-video-player" tabindex="0">
  <video muted playsinline></video>
  <div class="ytp-caption-window-container"><span class="caption-visual-line">자막 유지</span></div>
  <div class="ytp-chrome-bottom"><button id="play">Play</button></div>
</div>
<iframe srcdoc="<div class='html5-video-player'><div class='ytp-chrome-bottom'>frame controls</div><div class='ytp-caption-window-container'>frame captions</div></div>"></iframe>
<script>
  window.chrome = { runtime: { id: 'fixture-extension', getManifest: () => ({version:'test'}) } };
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
  const paint = () => { const c = canvas.getContext('2d'); c.fillStyle = 'rgb(20,30,90)'; c.fillRect(0,0,320,240); };
  paint(); window.fixturePaint = setInterval(paint, 50);
  window.fixtureVideo = document.querySelector('video'); fixtureVideo.srcObject = canvas.captureStream(20);
  window.fixtureCaption = document.querySelector('.ytp-caption-window-container');
  const toggle = () => fixtureVideo.paused ? fixtureVideo.play() : fixtureVideo.pause();
  document.querySelector('#play').addEventListener('click', toggle);
  fixtureVideo.addEventListener('click', toggle);
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space' || event.key === 'k') { event.preventDefault(); toggle(); }
  });
</script>'''


def pixel(screenshot, point):
    return Image.open(BytesIO(screenshot)).convert('RGB').getpixel(point)


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
            headless=True, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        context = await browser.new_context(viewport={'width': 400, 'height': 400}, device_scale_factor=1)
        # Route before navigation: the hostname is real for the scope check,
        # while every document and resource comes from this local fixture.
        await context.route('**/*', lambda route: route.fulfill(content_type='text/html', body=FIXTURE))
        page = await context.new_page()
        await page.goto('https://www.youtube.com/watch?v=local-fixture')
        await page.locator('iframe').wait_for()
        await page.evaluate(SOURCE)
        before = await page.screenshot()
        assert pixel(before, (300, 220)) == (220, 20, 30)
        assert pixel(before, (290, 180)) == (20, 180, 40)
        assert await page.evaluate("__withoutMikeYouTubeControls.hide('video-a')") is True
        assert await page.locator('.ytp-chrome-bottom').evaluate('(node) => getComputedStyle(node).opacity') == '0'
        assert await page.locator('.ytp-caption-window-container').evaluate('(node) => getComputedStyle(node).opacity') == '1'
        assert await page.frame_locator('iframe').locator('.ytp-chrome-bottom').evaluate('(node) => getComputedStyle(node).opacity') == '0'
        # Hiding the pixels must not disable the player's native hit targets.
        await page.locator('#play').click()
        await page.wait_for_function('!fixtureVideo.paused && fixtureVideo.readyState >= 2')
        hidden = await page.screenshot()
        assert pixel(hidden, (300, 220)) == (20, 30, 90), pixel(hidden, (300, 220))
        assert pixel(hidden, (290, 180)) == (20, 180, 40)
        await page.keyboard.press('Space')
        assert await page.evaluate('fixtureVideo.paused') is True
        await page.keyboard.press('k')
        await page.wait_for_function('!fixtureVideo.paused')
        await page.locator('video').click(position={'x': 100, 'y': 100})
        assert await page.evaluate('fixtureVideo.paused') is True
        assert await page.evaluate('fixtureVideo === document.querySelector("video") && fixtureCaption === document.querySelector(".ytp-caption-window-container")')
        await page.evaluate('window.originalControlStyle = document.querySelector("[data-withoutmike-youtube-controls]")')
        await page.evaluate(SOURCE)
        assert await page.evaluate('originalControlStyle === document.querySelector("[data-withoutmike-youtube-controls]")')
        assert await page.evaluate("__withoutMikeYouTubeControls.restore('old-session')") is False
        assert await page.locator('.ytp-chrome-bottom').evaluate('(node) => getComputedStyle(node).opacity') == '0'
        assert await page.evaluate("__withoutMikeYouTubeControls.restore('video-a')") is True
        # The site's original fade-in transition may resume after restoration.
        await page.wait_for_function('getComputedStyle(document.querySelector(".ytp-chrome-bottom")).opacity === "1"')
        restored = await page.screenshot()
        assert pixel(restored, (300, 220)) == (220, 20, 30)
        assert pixel(restored, (290, 180)) == (20, 180, 40)
        assert await page.evaluate("__withoutMikeYouTubeControls.hide('video-b')") is True
        await page.evaluate('() => { chrome.runtime.getManifest = () => { throw Error("Extension context invalidated."); }; }')
        await page.wait_for_function('!document.querySelector("[data-withoutmike-youtube-controls]")')
        await page.goto('https://youtube.com.example.test/watch?v=local-fixture')
        await page.evaluate(SOURCE)
        assert await page.evaluate("__withoutMikeYouTubeControls.hide('wrong-host')") is False
        assert await page.locator('.ytp-chrome-bottom').evaluate('(node) => getComputedStyle(node).opacity') == '1'
        await browser.close()
        print('YouTube controls smoke passed: clean pixels, captions, Play/Space/K/click, frames, reinjection, restore and host scope.')


asyncio.run(main())
