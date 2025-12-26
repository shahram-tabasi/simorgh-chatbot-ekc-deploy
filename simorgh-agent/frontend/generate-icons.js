#!/usr/bin/env node

/**
 * Icon Generator Script for Simorgh AI
 *
 * This script generates PNG icons from the Simorgh SVG logo.
 *
 * Requirements:
 * - sharp: npm install sharp
 *
 * Usage:
 * node generate-icons.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generateIcons() {
  try {
    // Dynamic import for sharp
    const sharp = (await import('sharp')).default;

    const publicDir = path.join(__dirname, 'public');
    const svgPath = path.join(publicDir, 'simorgh.svg');

    if (!fs.existsSync(svgPath)) {
      console.error('❌ Error: simorgh.svg not found in public directory');
      process.exit(1);
    }

    console.log('📦 Generating PNG icons with solid background from simorgh.svg...\n');

    // App background color (dark blue-black from theme)
    const backgroundColor = { r: 10, g: 14, b: 39 };

    const sizes = [
      { name: 'apple-touch-icon-180.png', size: 180 },
      { name: 'apple-touch-icon-167.png', size: 167 },
      { name: 'apple-touch-icon-152.png', size: 152 },
      { name: 'icon-192.png', size: 192 },
      { name: 'icon-512.png', size: 512 }
    ];

    for (const { name, size } of sizes) {
      const outputPath = path.join(publicDir, name);

      // Create a solid background and composite the logo on top
      // This ensures iOS doesn't show a white icon
      await sharp({
        create: {
          width: size,
          height: size,
          channels: 4,
          background: backgroundColor
        }
      })
      .composite([
        {
          input: await sharp(svgPath)
            .resize(size, size, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .toBuffer()
        }
      ])
      .png()
      .toFile(outputPath);

      console.log(`✅ Created ${name} (${size}x${size}) with solid background`);
    }

    console.log('\n🎉 All icons generated successfully!');
    console.log('\nℹ️  iOS users can now add the app to their Home Screen and see the Simorgh logo.');
    console.log('ℹ️  Icons have a solid dark background to prevent iOS white icon issue.');

  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      console.log('❌ Error: "sharp" package not found.\n');
      console.log('To generate icons, please run:');
      console.log('  npm install sharp --save-dev');
      console.log('  node generate-icons.js\n');
      console.log('Alternatively, manually export simorgh.svg to PNG in these sizes:');
      console.log('  - apple-touch-icon-180.png (180x180)');
      console.log('  - apple-touch-icon-167.png (167x167)');
      console.log('  - apple-touch-icon-152.png (152x152)');
      console.log('  - icon-192.png (192x192)');
      console.log('  - icon-512.png (512x512)');
      console.log('\nPlace them in the public/ directory.');
      process.exit(1);
    }
    throw error;
  }
}

generateIcons().catch(console.error);
