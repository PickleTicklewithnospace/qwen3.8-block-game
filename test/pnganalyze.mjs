// Zero-dependency PNG analysis for headless visual verification.
// The model cannot view images, so screenshots are inspected as stats + ASCII.
//
// Usage:
//   node test/pnganalyze.mjs stats <file.png>
//   node test/pnganalyze.mjs ascii <file.png> [cols]
//
// `stats` prints avg color, non-black %, bright %, and hue-class percentages.
// `ascii` renders the image with a luminance ramp plus color-class markers
// (C=cyan M=magenta Y=yellow R=red G=green B=blue; lowercase = dim).

import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

function decodePNG(buf) {
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bitDepth ' + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 2;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = raw[rp++];
      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('filter ' + filter);
      }
      row[x] = val & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function stats(file) {
  const { width, height, channels, data } = decodePNG(readFileSync(file));
  let nonBlack = 0, bright = 0, cyanish = 0, magentaish = 0, whiteish = 0;
  const total = width * height;
  const sum = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < total; i++) {
    const r = data[i * channels], g = data[i * channels + 1], b = data[i * channels + 2];
    sum.r += r; sum.g += g; sum.b += b;
    if (r + g + b > 30) nonBlack++;
    if (r + g + b > 400) bright++;
    if (b > 140 && g > 140 && r < 110) cyanish++;
    if (r > 140 && b > 140 && g < 110) magentaish++;
    if (r > 200 && g > 200 && b > 200) whiteish++;
  }
  const pct = (n) => (100 * n / total).toFixed(2) + '%';
  console.log(JSON.stringify({
    file, width, height,
    avg: [Math.round(sum.r / total), Math.round(sum.g / total), Math.round(sum.b / total)],
    nonBlack: pct(nonBlack),
    bright: pct(bright),
    cyan: pct(cyanish),
    magenta: pct(magentaish),
    white: pct(whiteish),
  }, null, 1));
}

function ascii(file, cols) {
  cols = Number(cols) || 110;
  const { width, height, channels, data } = decodePNG(readFileSync(file));
  const rows = Math.max(1, Math.round((cols * height) / width / 2)); // 2:1 char aspect
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const ramp = ' .:-=+*#%@';
  let out = '';
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let rx = 0; rx < cols; rx++) {
      // Average a block.
      const x0 = Math.floor((rx * width) / cols), x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * width) / cols));
      const y0 = Math.floor((ry * height) / rows), y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * height) / rows));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * width + x) * channels;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      r /= n; g /= n; b /= n;
      const l = lum(r, g, b);
      if (l < 8) { line += ' '; continue; }
      let ch = ramp[Math.min(ramp.length - 1, Math.floor((l / 255) * ramp.length))];
      // Color class markers override dim chars.
      if (b > 150 && g > 150 && r < 120) ch = 'C';        // cyan
      else if (r > 150 && b > 150 && g < 120) ch = 'M';   // magenta
      else if (r > 150 && g > 150 && b < 120) ch = 'Y';   // yellow
      else if (r > 150 && g < 110 && b < 110) ch = 'R';   // red
      else if (g > 150 && r < 120 && b < 120) ch = 'G';   // green
      else if (b > 150 && r < 120 && g < 120) ch = 'B';   // blue
      if (l < 60 && 'CMYRGB'.includes(ch)) ch = ch.toLowerCase();
      line += ch;
    }
    out += line + '\n';
  }
  console.log(out);
}

// Per-region grid of avg luminance + dominant color class, to spot hot
// spots and dead zones. Usage: regions <file.png> [cols] [rows]
function regions(file, cols, rows) {
  cols = Number(cols) || 8;
  rows = Number(rows) || 16;
  const { width, height, channels, data } = decodePNG(readFileSync(file));
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const cls = (r, g, b) => {
    if (r + g + b < 30) return '.';
    if (b > 150 && g > 150 && r < 120) return 'C';
    if (r > 150 && b > 150 && g < 120) return 'M';
    if (r > 150 && g > 150 && b < 120) return 'Y';
    if (r > 150 && g < 110 && b < 110) return 'R';
    if (g > 150 && r < 120 && b < 120) return 'G';
    if (b > 150 && r < 120 && g < 120) return 'B';
    if (r > 200 && g > 200 && b > 200) return 'W';
    return 'o';
  };
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor((rx * width) / cols), x1 = Math.floor(((rx + 1) * width) / cols);
      const y0 = Math.floor((ry * height) / rows), y1 = Math.floor(((ry + 1) * height) / rows);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * channels;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      r /= n; g /= n; b /= n;
      const l = Math.round(lum(r, g, b));
      line += String(l).padStart(3) + cls(r, g, b) + ' ';
    }
    console.log(line);
  }
}

const [cmd, file, a, b] = process.argv.slice(2);
if (cmd === 'stats' && file) stats(file);
else if (cmd === 'ascii' && file) ascii(file, a);
else if (cmd === 'regions' && file) regions(file, a, b);
else console.error('usage: pnganalyze.mjs <stats|ascii|regions> <file.png> [extra]');
