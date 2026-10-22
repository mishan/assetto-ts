import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

import { decodeDds } from "../src/decode.js"

/** A DDS of `data`, described by the header fields that decide how to read it. */
const dds = (
  width: number,
  height: number,
  {
    pfFlags,
    fourCC = 0,
    bits = 0,
    masks = [0, 0, 0, 0],
  }: { pfFlags: number; fourCC?: number; bits?: number; masks?: number[] },
  data: Uint8Array,
) => {
  const buf = new ArrayBuffer(128 + data.length)
  const h = new DataView(buf)
  h.setUint32(0, 0x20534444, true) // 'DDS '
  h.setUint32(4, 124, true)
  h.setUint32(12, height, true)
  h.setUint32(16, width, true)
  h.setUint32(28, 1, true) // mipMapCount
  h.setUint32(76, 32, true) // pixelformat size
  h.setUint32(80, pfFlags, true)
  h.setUint32(84, fourCC, true)
  h.setUint32(88, bits, true)
  masks.forEach((m, i) => {
    h.setUint32(92 + i * 4, m, true)
  })
  new Uint8Array(buf, 128).set(data)
  return buf
}
const px = (img: ReturnType<typeof decodeDds>, i: number) => [
  ...img!.pixels.slice(i * 4, i * 4 + 4),
]

it("reads every pixel format stock cars ship", () => {
  // Read through the channel MASKS, not an assumed byte order: the same file
  // format holds BGRA, RGB and luminance-plus-alpha, and guessing turns a red
  // car blue rather than failing.

  // 32-BIT BGRA, as glass and logos ship. Stored blue-first, and the masks
  // are the only thing that says so.
  const bgra = decodeDds(
    dds(
      2,
      1,
      { pfFlags: 0x41, bits: 32, masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000] },
      new Uint8Array([10, 20, 30, 40, 200, 100, 50, 0]),
    ),
  )
  expect([bgra?.width, bgra?.height]).toEqual([2, 1])
  expect(px(bgra, 0), "B,G,R,A on disk comes back R,G,B,A").toEqual([30, 20, 10, 40])
  expect(px(bgra, 1), "including a fully cut-out texel").toEqual([50, 100, 200, 0])

  // 24-BIT BGR, as screens and blurred rims ship. No alpha channel at all,
  // which is opaque rather than transparent: a zero here is how a rim goes
  // invisible.
  const bgr = decodeDds(
    dds(
      1,
      1,
      { pfFlags: 0x40, bits: 24, masks: [0xff0000, 0x00ff00, 0x0000ff, 0] },
      new Uint8Array([1, 2, 3]),
    ),
  )
  expect(px(bgr, 0), "no alpha mask means opaque").toEqual([3, 2, 1, 255])

  // 16-BIT LUMINANCE PLUS ALPHA, as interior glass and brushed metal detail
  // maps ship. One gray value across all three color channels.
  const al = decodeDds(
    dds(
      1,
      1,
      { pfFlags: 0x20001, bits: 16, masks: [0x00ff, 0, 0, 0xff00] },
      new Uint8Array([90, 128]),
    ),
  )
  expect(px(al, 0), "luminance fills R, G and B").toEqual([90, 90, 90, 128])

  // DXT5, the format most of a car is in, through the same door. One block:
  // both alpha endpoints 255, then two identical color endpoints so every
  // interpolation scheme agrees on the answer.
  const red565 = 0xf800
  const block = new Uint8Array(16)
  block[0] = 255
  block[1] = 255 // alpha endpoints
  block[8] = red565 & 0xff
  block[9] = red565 >> 8 // color 0
  block[10] = red565 & 0xff
  block[11] = red565 >> 8 // color 1
  const dxt5 = decodeDds(dds(4, 4, { pfFlags: 0x4, fourCC: 0x35545844 }, block))
  expect([dxt5?.width, dxt5?.height]).toEqual([4, 4])
  expect(px(dxt5, 0)).toEqual([255, 0, 0, 255])
  expect(px(dxt5, 15), "every texel in the block").toEqual([255, 0, 0, 255])
})

it("returns an honest null for what it cannot read", () => {
  // A caller's fallback is a gray surface, and a wrong guess would be worse.
  expect(decodeDds(new ArrayBuffer(8)), "too short to be a header").toBeNull()
  expect(
    decodeDds(
      dds(1, 1, { pfFlags: 0x40, bits: 12, masks: [0xf00, 0xf0, 0xf, 0] }, new Uint8Array([0, 0])),
    ),
    "a bit depth that is not whole bytes",
  ).toBeNull()
  const noMagic = dds(
    1,
    1,
    { pfFlags: 0x40, bits: 24, masks: [0xff0000, 0xff00, 0xff, 0] },
    new Uint8Array([1, 2, 3]),
  )
  new DataView(noMagic).setUint32(0, 0, true)
  expect(decodeDds(noMagic), "not a DDS at all").toBeNull()
})

it("imports nothing, so a browser can load it straight from node_modules", () => {
  // The root tsconfig types Node globals in every file, so typechecking would
  // not catch a Buffer here; a browser would, at load time.
  const source = readFileSync(new URL("../src/decode.ts", import.meta.url), "utf8").replace(
    /\/\/.*$/gm,
    "",
  )
  expect(source).not.toMatch(/^\s*import\b|\bimport\(|\brequire\(|\bBuffer\b|\bprocess\./m)
})
