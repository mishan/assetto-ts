// The encoder, checked against this package's decoder.
//
// It replaces ImageMagick, whose failures here were all quiet: a DX10 header
// Assetto Corsa ignores, a mip chain of one from a define it could not parse,
// DXT1 when asked for DXT5. So the format is checked byte by byte, and the
// pictures by decoding them again and measuring how far they moved.

import { createHash } from "node:crypto"
import { expect, it } from "vitest"

import { decodeDds } from "../src/decode.js"
import { encodeDds, halve, mipCount } from "../src/encode.js"

const image = (w: number, h: number, f: (x: number, y: number) => number[]) => {
  const px = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(f(x, y), (y * w + x) * 4)
  return px
}
const decode = (buf: Buffer) => {
  const img = decodeDds(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  )
  if (!img) throw new Error("did not decode")
  return img
}
const psnr = (a: Uint8Array, b: Uint8Array, channels: number[]) => {
  let se = 0,
    n = 0
  for (let i = 0; i < a.length; i += 4)
    for (const c of channels) {
      se += (a[i + c]! - b[i + c]!) ** 2
      n++
    }
  return 10 * Math.log10((255 * 255) / (se / n || 1e-9))
}

it("writes the DX9 header Assetto Corsa reads, with a full mip chain", () => {
  const cases: [number, number, boolean, string, number][] = [
    [2048, 512, false, "DXT1", 8],
    [64, 64, true, "DXT5", 16],
    [4, 1024, false, "DXT1", 8],
  ]
  for (const [w, h, alpha, fourcc, block] of cases) {
    const dds = encodeDds(new Uint8Array(w * h * 4), w, h, { alpha })
    expect(dds.toString("latin1", 0, 4)).toBe("DDS ")
    expect(dds.readUInt32LE(4)).toBe(124)
    expect(dds.readUInt32LE(12)).toBe(h)
    expect(dds.readUInt32LE(16)).toBe(w)
    expect(dds.readUInt32LE(28), `${w}x${h}: log2 of the LONGER edge, plus one`).toBe(
      mipCount(w, h),
    )
    expect(dds.toString("latin1", 84, 88), "never DX10, which AC ignores").toBe(fourcc)
    let size = 128
    for (
      let l = 0, lw = w, lh = h;
      l < mipCount(w, h);
      l++, lw = Math.max(1, lw >> 1), lh = Math.max(1, lh >> 1)
    ) {
      size += Math.ceil(lw / 4) * Math.ceil(lh / 4) * block
    }
    expect(dds.length, `${w}x${h}: every level present, nothing after`).toBe(size)
  }
})

it("keeps a picture through the round trip, color and alpha", () => {
  // A gradient field with a hard-edged block in it. Measured at 47 dB. On
  // real sheets ImageMagick's DXT1 scored 41 to 53, never above this encoder;
  // the floors leave room.
  const w = 128,
    h = 64
  const art = image(w, h, (x, y) =>
    x > 40 && x < 90 && y > 16 && y < 48
      ? [0, 240, 255, 255]
      : [18 + x, 32 + y, 58, Math.round((255 * x) / (w - 1))],
  )
  const rgb = decode(encodeDds(art, w, h, { alpha: false }))
  expect(rgb.width).toBe(w)
  expect(psnr(art, rgb.pixels, [0, 1, 2]), "DXT1 PSNR").toBeGreaterThan(44)
  expect(
    rgb.pixels.every((v, i) => i % 4 !== 3 || v === 255),
    "DXT1 without alpha is opaque",
  ).toBe(true)

  const rgba = decode(encodeDds(art, w, h, { alpha: true }))
  expect(psnr(art, rgba.pixels, [0, 1, 2]), "DXT5 color").toBeGreaterThan(44)
  expect(psnr(art, rgba.pixels, [3]), "DXT5 alpha PSNR").toBeGreaterThan(50)
})

it("brings a flat color back within one step of itself", () => {
  // Flat fields of color are common, and the nearest 5:6:5 color is up to four
  // steps off in red and blue: a visible band where two regions meet.
  let worst = 0
  for (let v = 0; v < 256; v++) {
    const want = [v, 255 - v, (v * 7) & 255]
    const out = decode(
      encodeDds(
        image(4, 4, () => [...want, 255]),
        4,
        4,
        { alpha: false },
      ),
    ).pixels
    for (let i = 0; i < out.length; i += 4)
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out[i + c]! - want[c]!))
  }
  expect(worst).toBeLessThanOrEqual(1)
})

it("makes each mip level the average of the four texels above it, color weighted by alpha", () => {
  const px = image(4, 2, (x) => (x % 2 ? [200, 100, 0, 255] : [0, 100, 200, 55]))
  const { pixels, width, height } = halve(px, 4, 2)
  expect([width, height]).toEqual([2, 1])
  expect([...pixels.slice(0, 4)]).toEqual([165, 100, 35, 155])
  expect(halve(new Uint8Array(4 * 4), 1, 4).width, "a 1-wide level stays 1 wide").toBe(1)
})

it("keeps two colors of equal brightness two colors", () => {
  // The block's principal axis was found by power iteration from [1, 1, 1],
  // which a red and green checker is perpendicular to: the iteration had
  // nothing to grow, every texel projected to the mean, and the edge came
  // out one muddy olive.
  const art = image(4, 4, (x, y) => ((x + y) % 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]))
  const out = decode(encodeDds(art, 4, 4, { alpha: false })).pixels
  expect(psnr(art, out, [0, 1, 2])).toBeGreaterThan(40)
})

it("lends no color from a transparent texel to the mip level above it", () => {
  // A cut-out's clear area is usually black at alpha 0. Averaged as it is,
  // that black darkens every edge from the first mip down, and mips are what
  // the game draws at a distance.
  const px = image(2, 2, (x) => (x ? [0, 0, 0, 0] : [255, 128, 0, 255]))
  const { pixels } = halve(px, 2, 2)
  expect([...pixels.slice(0, 3)], "the color of what can be seen").toEqual([255, 128, 0])
  expect(pixels[3], "and half its alpha").toBe(128)
  expect(
    [
      ...halve(
        image(2, 2, () => [9, 9, 9, 0]),
        2,
        2,
      ).pixels,
    ],
    "all clear stays as it was",
  ).toEqual([9, 9, 9, 0])
})

it("decodes a DXT block format behind a DX10 header like the classic one", () => {
  // 257 stock textures in a 254-car sample carry the DX10 extension header
  // around a format the decoder already reads.
  const art = image(8, 8, (x, y) => [x * 30, y * 30, 128, 64 + x * 20])
  const classic = encodeDds(art, 8, 8, { alpha: true })
  const ext = Buffer.alloc(20)
  ext.writeUInt32LE(77, 0) // DXGI_FORMAT_BC3_UNORM
  ext.writeUInt32LE(3, 4) // a 2D texture
  const dx10 = Buffer.concat([classic.subarray(0, 128), ext, classic.subarray(128)])
  dx10.write("DX10", 84, "latin1")
  expect(decode(dx10).pixels).toEqual(decode(classic).pixels)
})

it("decodes BC7 as ImageMagick decodes it, in every mode", () => {
  // About 240 stock sheets in a 254-car sample are BC7. The blocks are random
  // bytes, seeded, with the mode bits set so each of the eight modes is a
  // sixteenth of them; any 128 bits are a valid BC7 block, so this reaches
  // every partition and every rotation the format has. The hash is of
  // ImageMagick's own decode of the same file.
  let seed = 20261016
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return (seed >>> 16) & 255
  }
  const w = 128,
    h = 64,
    blocks = Buffer.alloc((w / 4) * (h / 4) * 16)
  for (let b = 0; b < blocks.length / 16; b++) {
    for (let k = 0; k < 16; k++) blocks[b * 16 + k] = rnd()
    const mode = b % 8
    blocks[b * 16] = (blocks[b * 16]! & ~((2 << mode) - 1)) | (1 << mode)
  }
  const head = Buffer.alloc(148)
  head.write("DDS ", 0, "latin1")
  head.writeUInt32LE(124, 4)
  head.writeUInt32LE(h, 12)
  head.writeUInt32LE(w, 16)
  head.writeUInt32LE(1, 28)
  head.write("DX10", 84, "latin1")
  head.writeUInt32LE(98, 128) // DXGI_FORMAT_BC7_UNORM
  const img = decode(Buffer.concat([head, blocks]))
  expect(createHash("sha256").update(img.pixels).digest("hex")).toBe(
    "8e2df30d53f49e6541bd70cb131a8dba62e8e8ff3f44eae89db2bb57a2de23ea",
  )
})
