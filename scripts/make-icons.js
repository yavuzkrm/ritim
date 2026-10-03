#!/usr/bin/env node
// Renders the app icons in assets/icons/ with headless Chrome.
// The motif is the app's weekly pill organizer: seven compartments, filling up.
//
// Usage: node scripts/make-icons.js   (needs Chrome; see tests/browser.js for CHROME_PATH)

const path = require('path');
const fs = require('fs');
const { launch } = require('../tests/browser');

const OUT = path.resolve(__dirname, '..', 'assets', 'icons');
const FILLS = [100, 85, 100, 62, 100, 40, 18];

const svg = (pad, radius) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${radius}" fill="#2F55E4"/>
  <g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 512})">
    ${FILLS.map((h, k) => {
      const x = 74 + k * 54;
      return `<rect x="${x}" y="130" width="40" height="252" rx="20" fill="#fff" fill-opacity=".22"/>
              <rect x="${x}" y="${130 + 252 * (1 - h / 100)}" width="40" height="${252 * h / 100}" rx="20" fill="#fff"/>`;
    }).join('')}
  </g></svg>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage();
  const shot = async (file, size, pad, radius) => {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<body style="margin:0">${svg(pad, radius).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
    await page.screenshot({ path: path.join(OUT, file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };
  await shot('icon-192.png', 192, 0, 112);
  await shot('icon-512.png', 512, 0, 112);
  await shot('maskable-512.png', 512, 60, 0);   // safe zone padding for Android adaptive icons
  await shot('apple-touch-icon.png', 180, 0, 0); // iOS rounds the corners itself
  await browser.close();
  console.log('icons written to assets/icons/');
})();
