import { describe, expect, it } from "vitest"

import { caseCollisions, ddsInfo, ddsProblems } from "../src/check.js"
import { encodeDds } from "../src/encode.js"

/** A DDS header, and `data` bytes after it, with the fields the checks read. */
const header = (
  width: number,
  height: number,
  { mips = 1, fourCC = "DXT1", data = 0 }: { mips?: number; fourCC?: string; data?: number } = {},
): Uint8Array => {
  const bytes = new Uint8Array(128 + data)
  const view = new DataView(bytes.buffer)
  bytes.set([0x44, 0x44, 0x53, 0x20]) // 'DDS '
  view.setUint32(4, 124, true)
  view.setUint32(12, height, true)
  view.setUint32(16, width, true)
  view.setUint32(28, mips, true)
  view.setUint32(76, 32, true)
  view.setUint32(80, 0x4, true) // fourCC present
  bytes.set(
    [...fourCC].map((c) => c.charCodeAt(0)),
    84,
  )
  return bytes
}
const codes = (bytes: Uint8Array) => ddsProblems(bytes).map((p) => p.code)

describe("ddsInfo", () => {
  it("reads the header, and says when it is DX10", () => {
    expect(ddsInfo(header(256, 128, { mips: 9, fourCC: "DXT5" }))).toEqual({
      width: 256,
      height: 128,
      mips: 9,
      fourCC: "DXT5",
      alpha: true,
      dx10: false,
    })
    expect(ddsInfo(header(256, 256, { fourCC: "DX10" }))?.dx10).toBe(true)
  })

  it("is null for anything that is not a whole DDS header", () => {
    expect(ddsInfo(header(4, 4).subarray(0, 127))).toBeNull()
    const png = header(4, 4)
    png.set([0x89, 0x50, 0x4e, 0x47])
    expect(ddsInfo(png)).toBeNull()
  })
})

describe("ddsProblems", () => {
  it("finds nothing wrong with what encodeDds writes", () => {
    for (const [w, h, alpha] of [
      [2048, 512, false],
      [64, 64, true],
      [1, 1, false],
    ] as const) {
      expect(
        ddsProblems(encodeDds(new Uint8Array(w * h * 4), w, h, { alpha })),
        `${w}x${h}`,
      ).toEqual([])
    }
  })

  it.each([
    ["not-dds", header(4, 4).subarray(0, 100)],
    ["dx10", header(4, 4, { mips: 3, fourCC: "DX10", data: 64 })],
    ["not-power-of-two", header(12, 12, { mips: 4, data: 9 * 8 + 4 * 8 + 8 + 8 })],
    // 2048x512 needs 12: the chain runs to the longer edge's 1px, not the shorter's.
    ["mip-chain", header(2048, 512, { mips: 10, data: 1 << 20 })],
    ["mip-chain", header(4, 4, { mips: 0, data: 8 })],
    // One 8x8 DXT5 level is four 16-byte blocks; one short.
    ["truncated", header(8, 8, { mips: 4, fourCC: "DXT5", data: 64 + 16 + 16 + 16 - 1 })],
  ])("reports %s", (code, bytes) => {
    expect(codes(bytes)).toEqual([code])
    for (const p of ddsProblems(bytes)) expect(p.message).toMatch(/^[A-Z].*\.$/)
  })

  it("counts at least one block per dimension at every level", () => {
    // 4x1 levels of a 4x16 DXT1 are still a whole block each, not a quarter.
    expect(codes(header(4, 16, { mips: 5, data: 4 * 8 + 2 * 8 + 8 + 8 + 8 }))).toEqual([])
    expect(codes(header(4, 16, { mips: 5, data: 4 * 8 + 2 * 8 + 8 + 8 + 7 }))).toEqual([
      "truncated",
    ])
  })
})

describe("caseCollisions", () => {
  it("groups the names that are one file on a case-insensitive disk", () => {
    expect(
      caseCollisions([
        "Suit_DIFF.dds",
        "body.dds",
        "SUIT_DIFF.dds",
        "Body.DDS",
        "rim.dds",
        "body.dds",
      ]),
    ).toEqual([
      ["Suit_DIFF.dds", "SUIT_DIFF.dds"],
      ["body.dds", "Body.DDS"],
    ])
  })
})
