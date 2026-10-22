// Why Assetto Corsa would mishandle a texture. AC is a DX9 engine, and every
// problem here produces a file that installs, loads and is wrong, with no
// error anywhere: the only symptom is a car that looks wrong in the game.

import { mipCount } from "./encode.js"

export interface DdsInfo {
  width: number
  height: number
  /** The header's mip count, as stored: 0 and 1 both mean no chain. */
  mips: number
  /** The pixel format's fourCC, such as DXT1, or null for an uncompressed one. */
  fourCC: string | null
  alpha: boolean
  /** A DX10 extended header, which a DX9 game cannot read. */
  dx10: boolean
}

const DDPF_ALPHAPIXELS = 0x1
const DDPF_FOURCC = 0x4

/** The 128-byte header of a DDS, or null when `bytes` is not one or is shorter. */
export function ddsInfo(bytes: Uint8Array): DdsInfo | null {
  if (bytes.length < 128) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, 128)
  if (view.getUint32(0, true) !== 0x20534444) return null // 'DDS '
  const pfFlags = view.getUint32(80, true)
  const fourCC =
    pfFlags & DDPF_FOURCC ? String.fromCharCode(...bytes.subarray(84, 88)).replace(/\0/g, "") : null
  return {
    width: view.getUint32(16, true),
    height: view.getUint32(12, true),
    mips: view.getUint32(28, true),
    fourCC,
    // DXT3/DXT5 carry alpha; DXT1 may via 1-bit, but treat it as opaque.
    alpha:
      fourCC === "DXT3" || fourCC === "DXT5" || (!fourCC && (pfFlags & DDPF_ALPHAPIXELS) !== 0),
    dx10: fourCC === "DX10",
  }
}

export type DdsProblemCode = "not-dds" | "dx10" | "not-power-of-two" | "mip-chain" | "truncated"

export interface DdsProblem {
  code: DdsProblemCode
  message: string
}

const BLOCK_BYTES: Record<string, number> = { DXT1: 8, DXT3: 16, DXT5: 16 }
const isPowerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0

/** Every reason Assetto Corsa would mishandle this texture; empty when there is none. */
export function ddsProblems(bytes: Uint8Array): DdsProblem[] {
  const info = ddsInfo(bytes)
  if (!info) {
    return [
      {
        code: "not-dds",
        message:
          "This is not a DDS texture, so the game cannot load it and draws the surface without it.",
      },
    ]
  }
  const { width, height, mips, fourCC } = info
  const size = `${width}x${height}`
  const problems: DdsProblem[] = []
  if (info.dx10) {
    problems.push({
      code: "dx10",
      message:
        "It has a DX10 header, which Assetto Corsa as a DX9 game silently ignores without Custom Shaders Patch, so there the surface is drawn without it, often plain white.",
    })
  }
  if (!isPowerOfTwo(width) || !isPowerOfTwo(height)) {
    problems.push({
      code: "not-power-of-two",
      message: `Its size, ${size}, is not a power of two on each side, and a DX9 game cannot be trusted to keep the mipmaps of such a texture, so it may shimmer at a distance.`,
    })
  }
  // Counted to the LONGER edge: a 2048x512 texture needs 12 levels, not 10.
  const needed = mipCount(width, height)
  const levels = Math.max(1, mips)
  if (levels < needed) {
    problems.push({
      code: "mip-chain",
      message: `${levels === 1 ? "It has no mipmaps" : `It has ${levels} mip levels`} where ${size} needs ${needed}, so it shimmers badly at a distance.`,
    })
  }
  const block = fourCC ? BLOCK_BYTES[fourCC] : undefined
  if (block) {
    let need = 128
    // Past the 1x1 level there is nothing more a texture can hold, and the
    // count is the file's word: four billion of them took fifteen seconds.
    for (let l = 0, w = width, h = height; l < Math.min(levels, needed); l++) {
      need += Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * block
      w = Math.max(1, w >> 1)
      h = Math.max(1, h >> 1)
    }
    if (bytes.length < need) {
      problems.push({
        code: "truncated",
        message: `It is ${bytes.length} bytes where its ${levels} ${fourCC} mip levels need ${need}, so the game reads past its end and draws garbage or nothing.`,
      })
    }
  }
  return problems
}

/**
 * Groups of filenames that differ only in case. They coexist on ext4 but are
 * one file on NTFS, where the second to extract wins, so which texture the
 * game gets depends on archive order.
 */
export function caseCollisions(names: string[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const key = name.toLowerCase()
    const group = groups.get(key)
    if (!group) groups.set(key, [name])
    else if (!group.includes(name)) group.push(name)
  }
  return [...groups.values()].filter((g) => g.length > 1)
}
