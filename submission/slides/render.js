const puppeteer = require('/home/ben_ben/automata2/asv_swarm_dt/.devtools/node_modules/puppeteer');
const path = require('path');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve('deck.html'), { waitUntil: 'networkidle0' });
  // PDF（フォーム提出用）
  await page.pdf({ path: 'deck.pdf', width: '1280px', height: '720px', printBackground: true, pageRanges: '' });
  // 各スライドPNG（GIF用）
  const slides = await page.$$('.slide');
  for (let i = 0; i < slides.length; i++) {
    await slides[i].screenshot({ path: `slide-${String(i + 1).padStart(2, '0')}.png` });
  }
  console.log('slides rendered:', slides.length);
  await browser.close();
})();
