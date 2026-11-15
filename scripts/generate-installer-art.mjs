// Installer artwork from assets/brand (replaces the default WiX/NSIS images):
//   build/installer/msi-banner.bmp   493×58   top banner of the MSI wizard pages
//   build/installer/msi-dialog.bmp   493×312  welcome / finish page background (left 164 px is the panel)
// Run: npm run icons (also writes the app icons)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'

const icon = readFileSync('assets/brand/icon.svg')
const INK = '#0E110F'
const GREEN = '#3FCF8E'

/** Uncompressed 24-bit BMP (what WiX and NSIS expect). */
function bmp({ data, info }) {
  const { width, height, channels } = info
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const buf = Buffer.alloc(54 + rowSize * height)
  buf.write('BM', 0)
  buf.writeUInt32LE(buf.length, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(rowSize * height, 34)
  buf.writeInt32LE(2835, 38)
  buf.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize // bottom-up
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      buf[row + x * 3] = data[i + 2]
      buf[row + x * 3 + 1] = data[i + 1]
      buf[row + x * 3 + 2] = data[i]
    }
  }
  return buf
}

async function canvas(width, height, background, layers) {
  const composites = await Promise.all(
    layers.map(async (l) => ({ input: l.svg ? Buffer.from(l.svg) : await sharp(icon, { density: 300 }).resize(l.size, l.size).png().toBuffer(), left: l.left, top: l.top }))
  )
  return sharp({ create: { width, height, channels: 3, background } }).composite(composites).removeAlpha().raw().toBuffer({ resolveWithObject: true })
}

// A soft green "K" stroke pattern for the dark panels.
const strokes = (w, h) => `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <g stroke="${GREEN}" stroke-linecap="round" fill="none" opacity="0.10">
    <path d="M${w * 0.55} ${h * 0.72} L${w * 1.1} ${h * 0.42}" stroke-width="${w * 0.16}"/>
    <path d="M${w * 0.55} ${h * 0.72} L${w * 1.1} ${h * 1.02}" stroke-width="${w * 0.16}" opacity="0.6"/>
  </g></svg>`

mkdirSync('build/installer', { recursive: true })
const out = (name, img) => writeFileSync(`build/installer/${name}`, bmp(img))

// MSI banner: light, title text sits on the left, logo on the right (where WiX had its red disc).
out('msi-banner.bmp', await canvas(493, 58, '#FFFFFF', [{ size: 44, left: 493 - 44 - 8, top: 7 }]))
// MSI welcome/finish: dark panel with the logo on the left, white where WiX draws the text.
out(
  'msi-dialog.bmp',
  await canvas(493, 312, '#FFFFFF', [
    { svg: `<svg width="164" height="312" xmlns="http://www.w3.org/2000/svg"><rect width="164" height="312" fill="${INK}"/></svg>`, left: 0, top: 0 },
    { svg: strokes(164, 312), left: 0, top: 0 },
    { size: 96, left: 34, top: 60 }
  ])
)
// NSIS welcome/finish sidebar and page header.
console.log('Installer artwork written to build/installer/')
