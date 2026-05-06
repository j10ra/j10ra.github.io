#!/usr/bin/env node
/**
 * Generates public/og-image.png from public/og-image.svg.
 * Run after editing the SVG: `node scripts/generate-og.mjs`
 *
 * Facebook/Messenger require PNG for og:image; the SVG is the editable source.
 */
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "..", "public", "og-image.svg");
const OUT = resolve(__dirname, "..", "public", "og-image.png");

const svg = readFileSync(SRC);

await sharp(svg, { density: 144 })
  .resize(1200, 630, { fit: "contain", background: "#0a0908" })
  .png({ compressionLevel: 9, quality: 90 })
  .toFile(OUT);

console.log(`[generate-og] ✓ ${OUT}`);
