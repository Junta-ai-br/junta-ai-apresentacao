import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

const out = new URL('../artifacts/', import.meta.url);
await mkdir(out, { recursive: true });
const html = await readFile(new URL('../index.html', import.meta.url));
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width:1280,height:720 }, deviceScaleFactor:2 });
  await context.route('https://**/*', async route => {
    const u = new URL(route.request().url());
    let path;
    if (u.hostname === 'cdn.jsdelivr.net') {
      path = u.pathname.replace('/npm/reveal.js@5.1.0/', 'reveal.js/').replace('/npm/three@0.160.0/', 'three/');
    } else if (u.hostname === 'fonts.googleapis.com') {
      const css = (await Promise.all([400,500,700,800].map(w => readFile(new URL(`../node_modules/@fontsource/noto-sans/latin-${w}.css`, import.meta.url), 'utf8')))).join('\n').replaceAll('./files/', 'https://fonts.gstatic.com/');
      return route.fulfill({contentType:'text/css',body:css});
    } else if (u.hostname === 'fonts.gstatic.com') path = `@fontsource/noto-sans/files${u.pathname}`;
    if (!path || path.includes('..')) return route.abort();
    const body = await readFile(new URL(`../node_modules/${path}`, import.meta.url));
    return route.fulfill({body, contentType:path.endsWith('.css')?'text/css':path.endsWith('.js')?'application/javascript':'font/woff2', headers:{'Access-Control-Allow-Origin':'*'} });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Seed only the export browser, leaving the production document untouched.
  await page.addInitScript(() => {
    let seed = 20261123;
    Math.random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = cb => raf(t => { if (!window.__freezeExport) cb(t); });
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.Reveal?.isReady());
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (!document.fonts.check('800 34px "Noto Sans"')) throw Error('Noto Sans unavailable');
  });
  assert.equal(await page.locator('.slides > section').count(), 7);
  // Verify the actual native mode before choosing screen capture.
  const native = await context.newPage();
  await native.goto(`${url}?print-pdf`, { waitUntil: 'networkidle' });
  await native.waitForSelector('.pdf-page');
  const nativeInfo = await native.evaluate(() => ({ pages: document.querySelectorAll('.pdf-page').length,
    separateFragments: Reveal.getConfig().pdfSeparateFragments,
    canvasOutsideSlides: !document.querySelector('.slides').contains(document.querySelector('#bg')) }));
  await native.pdf({ path: fileURLToPath(new URL('native-before.pdf', out)), printBackground: true, preferCSSPageSize: true });
  await native.close();
  // Exercise unchanged interactive behavior, including incremental fragments.
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => Reveal.getIndices().h), 1);
  assert.equal(await page.locator('.present .fragment.visible').count(), 0);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.present .fragment.visible').count(), 1);
  const pdf = await PDFDocument.create();
  const checks = [];
  const thumbs = [];
  for (let i = 0; i < 7; i++) {
    // Reload gives each slide its own live WebGL renderer and initial target.
    await page.goto(`${url}?export-slide=${i}#/${i}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.Reveal?.isReady());
    await page.evaluate(async i => {
      await document.fonts.ready;
      Reveal.slide(i, 0, 999);
    }, i);
    await page.waitForTimeout(1800);
    await page.evaluate(() => {
      document.getAnimations().forEach(a => { a.pause(); a.currentTime = 1800; });
      window.__freezeExport = true;
    });
    await page.waitForTimeout(100);
    const bounds = await page.evaluate(() => {
      const s = Reveal.getCurrentSlide();
      const elements = [...s.querySelectorAll('h1,h2,h3,p,.card,.architecture-diagram svg,.qr,.live,.eyebrow,.formula,.tag,.brand,.motto')];
      return elements.filter(e => !e.closest('.notes')).map(e => {
        const r = e.getBoundingClientRect();
        return { element: e.className?.baseVal ?? e.className, x:r.x,y:r.y,right:r.right,bottom:r.bottom };
      });
    });
    assert(bounds.every(r => r.x >= -1 && r.y >= -1 && r.right <= 1281 && r.bottom <= 721), `Slide ${i+1} overflow`);
    const hidden = await page.locator('.present .fragment:not(.visible)').count();
    assert.equal(hidden, 0);
    await page.screenshot({ path: fileURLToPath(new URL(`reference-${i+1}.png`, out)) });
    await page.addStyleTag({ content: '.reveal .controls,.reveal .progress,.reveal .slide-number {display:none!important}' });
    const png = await page.screenshot({ path: fileURLToPath(new URL(`slide-${i+1}.png`, out)) });
    const stats = await sharp(png).stats();
    assert(stats.channels.some(c => c.stdev > 10), 'Blank slide');
    const image = await pdf.embedPng(png);
    const sheet = pdf.addPage([960, 540]);
    sheet.drawImage(image, { x:0,y:0,width:960,height:540 });
    // Keep the real external links clickable over the rasterized content.
    const links = await page.locator('.present a[href]').evaluateAll(as => as.map(a => {
      const r = a.getBoundingClientRect(); return {href:a.href,x:r.x,y:r.y,w:r.width,h:r.height};
    }));
    const { PDFString } = await import('pdf-lib');
    for (const a of links) {
      const annotation = pdf.context.obj({ Type:'Annot', Subtype:'Link', Rect:[a.x*.75,(720-a.y-a.h)*.75,(a.x+a.w)*.75,(720-a.y)*.75], Border:[0,0,0], A:{Type:'Action',S:'URI',URI:PDFString.of(a.href)} });
      sheet.node.addAnnot(pdf.context.register(annotation));
    }
    checks.push({ slide:i+1, bounds, hiddenFragments:hidden, links });
    thumbs.push({ input:await sharp(png).resize(640,360).toBuffer(), left:(i%2)*640, top:Math.floor(i/2)*360 });
  }
  assert.deepEqual(errors, []);
  const bytes = await pdf.save();
  const parsed = await PDFDocument.load(bytes);
  assert.equal(parsed.getPageCount(), 7);
  assert(parsed.getPages().every(p => p.getWidth()/p.getHeight() === 16/9));
  await writeFile(new URL('Junta-ai_Apresentacao_Oficial.pdf', out), bytes);
  // Independently rasterize the saved PDF, then compare every page to its source.
  const rendered = await getDocument({ data: new Uint8Array(bytes), disableFontFace: true }).promise;
  assert.equal(rendered.numPages, 7);
  for (let i=1; i<=7; i++) {
    const p = await rendered.getPage(i);
    const viewport = p.getViewport({ scale: 8/3 });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    await p.render({ canvasContext:canvas.getContext('2d'), viewport }).promise;
    const png = canvas.toBuffer('image/png');
    await writeFile(new URL(`pdf-page-${i}.png`, out), png);
    const a = await sharp(png).removeAlpha().raw().toBuffer();
    const b = await sharp(await readFile(new URL(`slide-${i}.png`, out))).removeAlpha().raw().toBuffer();
    assert.equal(a.length, b.length);
    let delta=0;
    for(let j=0;j<a.length;j++) delta+=Math.abs(a[j]-b[j]);
    checks[i-1].pdfMeanAbsolutePixelError = delta/a.length;
    assert(delta/a.length < 1, `PDF page ${i} differs from capture`);
  }
  await sharp({create:{width:1280,height:1440,channels:3,background:'#0b0d12'}}).composite(thumbs).png().toFile(fileURLToPath(new URL('contact-sheet.png', out)));
  await writeFile(new URL('validation.json', out), JSON.stringify({ nativeInfo, pages:7, pageSize:[960,540], captureSize:[2560,1440], errors, checks }, null, 2));
  console.log(`PDF e evidências: ${fileURLToPath(out)}`);
} finally {
  await browser?.close();
  server.close();
}
