import { deflateSync, inflateSync } from "node:zlib";

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const probeWidth = 768;
const probeHeight = 512;
const bytesPerPixel = 3;

const glyphs: Readonly<Record<string, readonly string[]>> = {
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
};

function drawLabel(
  scanlines: Buffer,
  label: string,
  panelStartX: number,
  panelWidth: number,
): void {
  const scale = 8;
  const glyphWidth = 5 * scale;
  const gap = scale;
  const labelWidth = label.length * glyphWidth + (label.length - 1) * gap;
  const startX = panelStartX + Math.floor((panelWidth - labelWidth) / 2);
  const startY = Math.floor((probeHeight - 7 * scale) / 2);
  for (const [characterIndex, character] of [...label].entries()) {
    const glyph = glyphs[character];
    if (glyph === undefined) continue;
    for (const [rowIndex, row] of glyph.entries()) {
      for (const [columnIndex, pixel] of [...row].entries()) {
        if (pixel !== "1") continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x =
              startX +
              characterIndex * (glyphWidth + gap) +
              columnIndex * scale +
              dx;
            const y = startY + rowIndex * scale + dy;
            const offset = y * (1 + probeWidth * bytesPerPixel) + 1 + x * 3;
            scanlines[offset] = 255;
            scanlines[offset + 1] = 255;
            scanlines[offset + 2] = 255;
          }
        }
      }
    }
  }
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBuffer, data])),
    data.length + 8,
  );
  return chunk;
}

function createProbePng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(probeWidth, 0);
  header.writeUInt32BE(probeHeight, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc(
    probeHeight * (1 + probeWidth * bytesPerPixel),
  );
  for (let y = 0; y < probeHeight; y += 1) {
    const rowOffset = y * (1 + probeWidth * bytesPerPixel);
    scanlines[rowOffset] = 0;
    for (let x = 0; x < probeWidth; x += 1) {
      const pixelOffset = rowOffset + 1 + x * bytesPerPixel;
      const section = Math.floor((x * 3) / probeWidth);
      scanlines[pixelOffset] = section === 0 ? 255 : 0;
      scanlines[pixelOffset + 1] = section === 1 ? 255 : 0;
      scanlines[pixelOffset + 2] = section === 2 ? 255 : 0;
    }
  }
  const panelWidth = probeWidth / 3;
  drawLabel(scanlines, "RED", 0, panelWidth);
  drawLabel(scanlines, "GREEN", panelWidth, panelWidth);
  drawLabel(scanlines, "BLUE", panelWidth * 2, panelWidth);
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function isValidImageCapabilityProbeDataUrl(dataUrl: string): boolean {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return false;
  const encoded = dataUrl.slice(prefix.length);
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    return false;
  }
  const png = Buffer.from(encoded, "base64");
  if (png.length < 45 || !png.subarray(0, 8).equals(pngSignature)) {
    return false;
  }

  let offset = pngSignature.length;
  let headerSeen = false;
  let endSeen = false;
  const compressedParts: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > png.length) return false;
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    const storedCrc = png.readUInt32BE(offset + 8 + length);
    if (storedCrc !== crc32(png.subarray(offset + 4, offset + 8 + length))) {
      return false;
    }
    if (type === "IHDR") {
      if (
        headerSeen ||
        offset !== pngSignature.length ||
        length !== 13 ||
        data.readUInt32BE(0) !== probeWidth ||
        data.readUInt32BE(4) !== probeHeight ||
        data[8] !== 8 ||
        data[9] !== 2 ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        return false;
      }
      headerSeen = true;
    } else if (type === "IDAT") {
      compressedParts.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || chunkEnd !== png.length) return false;
      endSeen = true;
    }
    offset = chunkEnd;
    if (endSeen) break;
  }
  if (!headerSeen || !endSeen || compressedParts.length === 0) return false;

  try {
    const scanlines = inflateSync(Buffer.concat(compressedParts));
    if (scanlines.length !== probeHeight * (1 + probeWidth * bytesPerPixel)) {
      return false;
    }
    for (let y = 0; y < probeHeight; y += 1) {
      if (scanlines[y * (1 + probeWidth * bytesPerPixel)] !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const imageCapabilityProbeDataUrl = `data:image/png;base64,${createProbePng().toString("base64")}`;
