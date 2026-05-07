import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const svgPath = resolve(root, 'public', 'favicon.svg');
const icoPath = resolve(root, 'public', 'favicon.ico');

const svg = await readFile(svgPath);

const sizes = [16, 32, 48, 64];
const pngs = await Promise.all(
  sizes.map((size) =>
    sharp(svg, { density: 384 })
      .resize(size, size)
      .png()
      .toBuffer()
  )
);

const ico = await pngToIco(pngs);
await writeFile(icoPath, ico);

console.log(`generated favicon.ico (${ico.length} bytes) from favicon.svg`);
