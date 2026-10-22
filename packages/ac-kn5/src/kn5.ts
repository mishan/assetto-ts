/**
 * Assetto Corsa's model format, kn5: per vertex, both a 3D position and a UV
 * coordinate, so where each texel of a texture lands on the car is read
 * exactly rather than estimated.
 *
 * THE FORMAT IS REVERSE-ENGINEERED, not documented. Every field below was
 * verified against a real 50 MB car by parsing until the reader consumed the
 * file to its final byte: an off-by-one anywhere desynchronizes everything
 * after it, so an exact-length parse is a strong check that the layout is
 * right. `parseKn5` asserts it, and a failure means "the layout is wrong for
 * this file", not something to paper over.
 *
 * Layout, all little-endian, strings as int32 length + UTF-8 bytes:
 *
 *   header    "sc6969", int32 version, and for version > 5 an extra int32
 *
 *   textures  int32 count, then per texture:
 *               int32 type   (0 means an empty slot with NO further fields)
 *               string name
 *               int32 byteLength
 *               byte[byteLength]   (a DDS or PNG blob)
 *
 *   materials int32 count, then per material:
 *               string name, string shader
 *               byte alphaBlendMode, byte alphaTested, int32 depthMode
 *               int32 propCount, then per property:
 *                 string name, float valueA, vec2 valueB, vec3 valueC, vec4 valueD
 *                 (40 bytes of values)
 *               int32 slotCount, then per slot:
 *                 string sampleName, int32 slot, string textureName
 *
 *   nodes     a tree from a single root. Per node:
 *               int32 type (1 dummy, 2 mesh, 3 skinned mesh)
 *               string name, int32 childCount, byte active
 *               type 1: 64 bytes of 4x4 transform
 *               type 2: 3 flag bytes (castShadows, visible, transparent)
 *                       int32 vertexCount, vertices at 44 bytes each
 *                         (position vec3, normal vec3, uv vec2, tangent vec3)
 *                       int32 indexCount, uint16 indices
 *                       33-byte trailer: int32 materialId, int32 layer,
 *                         float lodIn, float lodOut, 16 bytes bounding sphere,
 *                         byte isRenderable
 *               type 3: 3 flag bytes FIRST, then int32 boneCount and per bone
 *                       a string plus 64 bytes; vertices are 76 bytes each
 *                       (the extra 32 are bone weights/indices); 16-byte trailer
 *             then childCount children.
 *
 * Two traps worth naming:
 *
 *   * V is negative. UVs come out in [-1, 0], and texture-space y is 1 + v.
 *     Getting this wrong flips every island vertically, which looks plausible
 *     enough to ship.
 *   * Type 3 puts its flag bytes BEFORE the bone list, unlike what you would
 *     guess from type 2. Suspension parts are skinned, so a car with any
 *     moving geometry desynchronizes immediately if this is wrong.
 */

import { readFile } from "node:fs/promises"

/** A texture embedded in the model. `data` is kept only on request. */
export interface Kn5Texture {
  name: string
  size: number
  data: Buffer | null
}

export interface Kn5Material {
  name: string
  shader: string
  /** 0 opaque, 1 alpha blend, 2 alpha to coverage. */
  alphaBlendMode: number
  alphaTested: boolean
  /** Texture file name by sampler, such as `txDiffuse`. */
  slots: Record<string, string>
  /** Each property's scalar, valueA. */
  props: Record<string, number>
}

/** A transform node with no geometry of its own. */
export interface Kn5Dummy {
  name: string
  /** Node names from the root, joined with "/". */
  path: string
  depth: number
  /** Accumulated 4x4, row-major, row vectors: p' = p * M, translation in 12-14. */
  world: Float32Array
}

/** A mesh node. Vertex and index data stay in the model's buffer; read them with `vertex` and `triangles`. */
export interface Kn5Mesh {
  name: string
  path: string
  /** 2 mesh, 3 skinned mesh. */
  type: number
  depth: number
  materialId: number
  world: Float32Array
  vertexCount: number
  vertexStart: number
  /** Bytes per vertex: 44 for a mesh, 76 for a skinned mesh. */
  stride: number
  indexCount: number
  indexStart: number
  /** Whole-sheet UV shift per vertex, u then v, for islands stored on another copy of the sheet. */
  uvShift?: Float32Array
  /** The vertex count of each island straddling a sheet boundary, which cannot be moved whole. */
  straddlers?: number[]
}

/** The protected region of an encrypted model. */
export interface Kn5Encryption {
  scheme: "csp-kn5enc-v1"
  start: number
  bytes: number
}

export interface Kn5Model {
  version: number
  textures: Kn5Texture[]
  materials: Kn5Material[]
  meshes: Kn5Mesh[]
  dummies: Kn5Dummy[]
  buf: Buffer
  encrypted: Kn5Encryption | null
}

export interface Kn5ParseOptions {
  /** Keep each texture's bytes, as a view into the model's buffer. */
  keepTextureData?: boolean
  /** Named in error messages. */
  path?: string
}

/** One vertex in world space, with u and v in texture space (y down from the top). */
export interface Kn5Vertex {
  x: number
  y: number
  z: number
  nx: number
  ny: number
  nz: number
  tx: number
  ty: number
  tz: number
  u: number
  v: number
}

/** Which way the model calls left and forward, as signs of x and z, read from its wheels. */
export interface WheelAxes {
  left: number
  front: number
  confident: true
  from: "wheels"
  trackWidth: number
  wheelbase: number
}

/** Which way the model calls left and forward, as signs of x and z, guessed from mesh names. */
export interface AxisHints {
  left: 1 | -1
  front: 1 | -1
  confident: boolean
}

/** A tiling second texture multiplied over a material's diffuse. */
export interface DetailLayer {
  diffuse: string
  detail: string
  mult: number
  normal: string | null
  normalBlend: number
}

/** A material as the predicates read it: one built by hand may lack any field. */
export type MaterialLike = Partial<Kn5Material> | null | undefined

const MAGIC = "sc6969"

class Cursor {
  o = 0
  constructor(readonly b: Buffer) {}
  u8(): number {
    return this.b.readUInt8(this.o++)
  }
  u32(): number {
    const v = this.b.readUInt32LE(this.o)
    this.o += 4
    return v
  }
  f32(): number {
    const v = this.b.readFloatLE(this.o)
    this.o += 4
    return v
  }
  skip(n: number): void {
    this.o += n
  }
  str(): string {
    const n = this.u32()
    const s = this.b.toString("utf8", this.o, this.o + n)
    this.o += n
    return s
  }
}

export async function parseKn5(
  path: string,
  { keepTextureData = false }: { keepTextureData?: boolean } = {},
): Promise<Kn5Model> {
  return parseKn5Buffer(await readFile(path), { keepTextureData, path })
}

export function parseKn5Buffer(
  buf: Buffer,
  { keepTextureData = false, path = "<buffer>" }: Kn5ParseOptions = {},
): Kn5Model {
  const c = new Cursor(buf)

  const magic = buf.toString("ascii", 0, 6)
  if (magic !== MAGIC) {
    throw new Error(`${path} is not a kn5 (expected magic "${MAGIC}", got "${magic}")`)
  }
  c.skip(6)
  const version = c.u32()
  if (version > 5) c.u32()

  const textures: Kn5Texture[] = []
  const texCount = c.u32()
  for (let i = 0; i < texCount; i++) {
    const type = c.u32()
    if (type === 0) continue // empty slot: no name, no blob
    const name = c.str()
    const size = c.u32()
    const start = c.o
    c.skip(size)
    textures.push({ name, size, data: keepTextureData ? buf.subarray(start, start + size) : null })
  }

  const materials: Kn5Material[] = []
  const matCount = c.u32()
  for (let i = 0; i < matCount; i++) {
    const name = c.str()
    const shader = c.str()
    // The model's own answer to whether this material composites: 0 opaque, 1
    // alpha blend, 2 alpha to coverage. `alphaTested` is the hard cutout beside
    // it, which a grille and a badge use and which is not blending. Inferring
    // either from the shader's name is a guess the file makes unnecessary.
    const alphaBlendMode = c.u8()
    const alphaTested = c.u8() !== 0
    c.u32() // depthMode
    // `detailUVMultiplier` lives in here, and without it a tiling detail map is
    // drawn at 1:1: a carbon weave at a 20cm pitch instead of a 2mm one.
    //
    // Only valueA is kept: every property known to matter is the scalar, and
    // the vec2/vec3/vec4 behind it are the remaining 36 bytes of the fixed 40,
    // skipped as one so the arithmetic stays in one place.
    const props: Record<string, number> = {}
    const propCount = c.u32()
    for (let p = 0; p < propCount; p++) {
      const key = c.str()
      props[key] = c.f32()
      c.skip(36)
    }
    const slotCount = c.u32()
    const slots: Record<string, string> = {}
    for (let s = 0; s < slotCount; s++) {
      const sample = c.str()
      c.u32() // slot index
      slots[sample] = c.str()
    }
    materials.push({ name, shader, alphaBlendMode, alphaTested, slots, props })
  }

  // Dummy nodes carry a 4x4 transform and meshes inherit it, so vertex data is
  // in LOCAL space. Skipping the matrices leaves every suspension part sitting
  // at the origin. Transforms are accumulated down the tree here.
  const meshes: Kn5Mesh[] = []
  // Dummies are kept as well as meshes: some positions are defined by a node
  // rather than by geometry, a wheel center for one, which AC places by the
  // WHEEL_xx node's translation.
  const dummies: Kn5Dummy[] = []
  const readNode = (depth: number, parentPath: string, parentMatrix: Float32Array): void => {
    const type = c.u32()
    const name = c.str()
    const childCount = c.u32()
    c.skip(1) // active
    const nodePath = parentPath ? `${parentPath}/${name}` : name
    let world = parentMatrix

    if (type === 1) {
      const m = new Float32Array(16)
      for (let i = 0; i < 16; i++) m[i] = c.f32()
      world = multiply(m, parentMatrix)
      dummies.push({ name, path: nodePath, depth, world })
    } else if (type === 2 || type === 3) {
      c.skip(3) // castShadows, visible, transparent
      let stride = 44
      if (type === 3) {
        const boneCount = c.u32()
        for (let b = 0; b < boneCount; b++) {
          c.str()
          c.skip(64)
        }
        stride = 76 // + bone weights and indices
      }
      const vertexCount = c.u32()
      const vertexStart = c.o
      c.skip(vertexCount * stride)
      const indexCount = c.u32()
      const indexStart = c.o
      c.skip(indexCount * 2)
      // The trailer is 33 bytes for a mesh and 16 for a skinned mesh, and the
      // materialId is the FIRST four of them, not an extra field in front.
      const materialId = c.u32()
      c.skip(type === 2 ? 29 : 12)
      meshes.push({
        name,
        path: nodePath,
        type,
        depth,
        materialId,
        world,
        vertexCount,
        vertexStart,
        stride,
        indexCount,
        indexStart,
      })
    } else {
      throw new Error(`${path}: unknown node type ${type} at byte ${c.o - 4}`)
    }

    for (let i = 0; i < childCount; i++) readNode(depth + 1, nodePath, world)
  }
  readNode(0, "", IDENTITY)

  // An exact-length parse is the whole validation strategy: any misread field
  // shifts every subsequent offset, so finishing precisely at EOF is very
  // unlikely to happen by accident.
  //
  // There is exactly one legitimate reason to finish early: an ENCRYPTED model,
  // where the readable part ends precisely where it should and a protected blob
  // follows it. That is a different situation from a corrupt or unknown layout
  // and deserves a different answer.
  const encrypted = trailingEncryption(buf, c.o)
  if (c.o !== buf.length && !encrypted) {
    throw new Error(
      `${path}: parser finished at byte ${c.o} but the file is ${buf.length} bytes ` +
        `(${buf.length - c.o > 0 ? "short by" : "over by"} ${Math.abs(buf.length - c.o)}).\n` +
        `  The node layout does not match this file — likely a kn5 version this ` +
        `reader hasn't seen. Nothing downstream should trust a partial parse.`,
    )
  }

  const model: Kn5Model = { version, textures, materials, meshes, dummies, buf, encrypted }
  for (const mesh of meshes) placeOnSheet(model, mesh)
  return model
}

/**
 * The widest or tallest an island may be, in sheets, and still map the image
 * once. A little over one, because an unwrap's edge bleeds past the sheet: the
 * Lotus 2-Eleven's leather reaches 1.022 sheets and an Alpine undercarriage
 * 1.047, and neither repeats anything. A repeating island is far wider: the
 * 992 Cup's body islands run 1.3 to 1.9 sheets, and one strip on the mp412c's
 * chassis 1,222.
 *
 * Exported so every question about a sheet's size uses the one figure. With
 * two, 1.05 and 1.02, an island 1.03 sheets tall was one sheet to one measure
 * and neither moved nor counted as straddling by the other, leaving only the
 * 0.015 of it on the sheet.
 */
export const SHEET_SPAN = 1.05

/**
 * How far past a sheet's edge an island may sit and still count as on it: the
 * bleed SHEET_SPAN allows, half at each edge, so nothing wider than one sheet
 * by that measure is ever on one copy of it.
 */
const SHEET_EDGE = (SHEET_SPAN - 1) / 2

/**
 * Bring each UV island that sits wholly on another copy of the sheet back onto
 * the copy in [0, 1], by recording a whole-number shift that `vertex()` applies.
 *
 * Textures are sampled with wrap addressing, so an unwrap shifted by whole
 * sheets draws exactly as one that is not, and exporters shift them freely: the
 * Avensis's body sits one sheet below [0, 1], a 180SX's sixty below. Anything
 * that compares UVs with places on the image (island rectangles, seams,
 * outlines, a renderer sampling the texture, a point picked on the image)
 * would otherwise see such an island somewhere no rectangle reaches; clamped
 * into [0, 1] it collapses, and 13 cars' bodies measured as nothing.
 *
 * Done once, here, so those cannot disagree about where an island is. An
 * island moves only when it fits wholly on another copy, give or take a hair
 * at either edge, and more of it lies there than on [0, 1]: one on [0, 1]
 * stays put; one spanning more than a sheet is a tiling material with no
 * single copy to move to; one straddling a boundary is wrapped across the
 * image's edge by the game and cannot move whole. All three are left exactly
 * as stored, so a model with nothing to move reads as stored, and each
 * straddler's vertex count is kept in `mesh.straddlers` so a caller can say so.
 *
 * An island here is triangles joined through shared vertex indices within one
 * mesh, so a moved island moves whole and a seam in the unwrap is still a seam.
 */
function placeOnSheet(model: Kn5Model, mesh: Kn5Mesh): void {
  const n = mesh.vertexCount
  if (!n) return
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (x: number): number => {
    let a = x
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!
      a = parent[a]!
    }
    return a
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  for (const [a, b, c] of triangles(model, mesh)) {
    union(a, b)
    union(b, c)
  }

  const bounds = new Map<number, [number, number, number, number]>()
  const size = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const o = mesh.vertexStart + i * mesh.stride
    const u = model.buf.readFloatLE(o + 24)
    const v = 1 + model.buf.readFloatLE(o + 28)
    const r = find(i)
    size.set(r, (size.get(r) ?? 0) + 1)
    const b = bounds.get(r)
    if (!b) {
      bounds.set(r, [u, v, u, v])
      continue
    }
    if (u < b[0]) b[0] = u
    if (v < b[1]) b[1] = v
    if (u > b[2]) b[2] = u
    if (v > b[3]) b[3] = v
  }

  // The copy an island fits on, with a little slack at both edges, or null.
  // Only a sliver near an edge fits two, and it goes to the one holding more of
  // it, [0, 1] on a tie. Reading the tile off `floor(lo + slack)`, which keeps a
  // -0.006 overhang home, sent an island lying at u = 0.991 to 0.999 one sheet
  // the wrong way, where it collapsed: four rim islands on the SF15T and six
  // trim islands on the Quattro. Asking [0, 1] first cured that and kept an
  // island lying wholly in the slack past an edge, at u = 1.003 to 1.008, where
  // clamping would have reduced it to nothing; it also split a body one sheet
  // down from the flange strip along its edge, at v = -0.006 to 0, moving only
  // the body.
  const tileOf = (lo: number, hi: number): number | null => {
    let best: number | null = null
    let least = Infinity
    for (let k = Math.ceil(hi - 1 - SHEET_EDGE); k <= Math.floor(lo + SHEET_EDGE); k++) {
      const off = Math.max(0, k - lo) + Math.max(0, hi - k - 1)
      if (off < least || (off === least && k === 0)) {
        best = k
        least = off
      }
    }
    return best
  }
  const moves = new Map<number, [number, number]>()
  // Straddlers are listed here, over every island, because this is where it is
  // decided that they cannot move. Each by its vertex count, so a caller can
  // account for what no rectangle on [0, 1] measures; a line in UV is left out,
  // as it has no area to measure anyway.
  const straddlers: number[] = []
  const sheetSized = (lo: number, hi: number): boolean => hi - lo > 1e-5 && hi - lo <= SHEET_SPAN
  for (const [r, [u0, v0, u1, v1]] of bounds) {
    const ku = tileOf(u0, u1)
    const kv = tileOf(v0, v1)
    if (ku === null || kv === null) {
      if (sheetSized(u0, u1) && sheetSized(v0, v1)) straddlers.push(size.get(r)!)
      continue
    }
    if (ku === 0 && kv === 0) continue
    moves.set(r, [-ku, -kv])
  }
  if (straddlers.length) mesh.straddlers = straddlers
  if (!moves.size) return

  const shift = new Float32Array(2 * n)
  for (let i = 0; i < n; i++) {
    const m = moves.get(find(i))
    if (m) {
      shift[2 * i] = m[0]
      shift[2 * i + 1] = m[1]
    }
  }
  mesh.uvShift = shift
}

const ENC_MARKER = "__AC_SHADERS_PATCH_KN5ENC_v1__"

/**
 * Custom Shaders Patch encrypted models.
 *
 * Some mod authors publish a kn5 whose geometry is intact but whose textures
 * have been replaced with 1x1 placeholders, with the real ones appended in an
 * encrypted blob that CSP decrypts at load. Every such file seen ends with a
 * length-prefixed `__AC_SHADERS_PATCH_KN5ENC_v1__` marker.
 *
 * THIS DOES NOT DECRYPT ANYTHING, AND SHOULD NOT.
 *
 * The encryption is there because the author does not want their artwork
 * extracted, and that is their call to make. It also does not need breaking:
 * the node tree, materials, UV islands and which texture binds to which slot
 * all sit in the readable part. The only casualty is texture DIMENSIONS, and
 * the car's skin folders hold textures of the real sizes.
 *
 * Returns a description of the protected region, or null.
 */
export function trailingEncryption(buf: Buffer, from: number): Kn5Encryption | null {
  if (from >= buf.length) return null
  // The marker sits near the very end: 30 bytes of text, then a few bytes of
  // trailer. Search a small window rather than the whole file, so a texture that
  // happens to contain the string cannot produce a false positive.
  const window = buf.subarray(Math.max(from, buf.length - 128))
  const at = window.indexOf(ENC_MARKER, 0, "latin1")
  if (at < 0) return null
  return {
    scheme: "csp-kn5enc-v1",
    start: from,
    bytes: buf.length - from,
  }
}

// Row-major, row-vector convention: p' = p * M, translation in elements 12-14.
// Verified against a suspension node whose translation matched its name and
// its position on the car.
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[i * 4 + k]! * b[k * 4 + j]!
      out[i * 4 + j] = s
    }
  }
  return out
}

/**
 * Vertex accessor, in WORLD space. Lazy so a 50 MB model is never copied into
 * JS objects: a car has a quarter of a million vertices and almost all
 * analysis is a single pass.
 */
export function vertex(
  model: Pick<Kn5Model, "buf">,
  mesh: Pick<Kn5Mesh, "vertexStart" | "stride" | "world" | "uvShift">,
  i: number,
): Kn5Vertex {
  const o = mesh.vertexStart + i * mesh.stride
  const b = model.buf
  const s = mesh.uvShift
  const x = b.readFloatLE(o)
  const y = b.readFloatLE(o + 4)
  const z = b.readFloatLE(o + 8)
  const nx = b.readFloatLE(o + 12)
  const ny = b.readFloatLE(o + 16)
  const nz = b.readFloatLE(o + 20)
  const m = mesh.world
  // Normals get the rotation but not the translation. Non-uniform scale would
  // want the inverse transpose; car node transforms are rigid in practice, and
  // the result is renormalized anyway.
  const rx = nx * m[0]! + ny * m[4]! + nz * m[8]!
  const ry = nx * m[1]! + ny * m[5]! + nz * m[9]!
  const rz = nx * m[2]! + ny * m[6]! + nz * m[10]!
  const rl = Math.hypot(rx, ry, rz) || 1
  // The TANGENT, which is what turns a normal map into a direction rather
  // than three numbers. It sits behind the UV, so it only exists on a mesh
  // packed wide enough to hold one: a narrower stride answers zero, read as
  // "no tangent frame here" rather than a neighboring vertex's position
  // misread as a direction.
  let tx = 0
  let ty = 0
  let tz = 0
  if (mesh.stride >= 44) {
    const ax = b.readFloatLE(o + 32)
    const ay = b.readFloatLE(o + 36)
    const az = b.readFloatLE(o + 40)
    const wx = ax * m[0]! + ay * m[4]! + az * m[8]!
    const wy = ax * m[1]! + ay * m[5]! + az * m[9]!
    const wz = ax * m[2]! + ay * m[6]! + az * m[10]!
    const wl = Math.hypot(wx, wy, wz)
    if (wl > 1e-6) {
      tx = wx / wl
      ty = wy / wl
      tz = wz / wl
    }
  }

  return {
    x: x * m[0]! + y * m[4]! + z * m[8]! + m[12]!,
    y: x * m[1]! + y * m[5]! + z * m[9]! + m[13]!,
    z: x * m[2]! + y * m[6]! + z * m[10]! + m[14]!,
    nx: rx / rl,
    ny: ry / rl,
    nz: rz / rl,
    tx,
    ty,
    tz,
    // THE ONLY UV SET a kn5 vertex has. A format carrying two puts paint on
    // the second, and a measurement from the wrong one is wrong silently.
    //
    // On the copy of the sheet in [0, 1], for an island stored on another one:
    // see placeOnSheet. A mesh with nothing to move has no `uvShift` and reads
    // exactly as stored.
    u: s ? b.readFloatLE(o + 24) + s[2 * i]! : b.readFloatLE(o + 24),
    // AC stores V negative; texture-space y is 1 + v. Get this wrong and every
    // island is flipped vertically, which looks plausible enough to ship.
    v: s ? 1 + b.readFloatLE(o + 28) + s[2 * i + 1]! : 1 + b.readFloatLE(o + 28),
  }
}

/**
 * Is this mesh parented under the named node?
 *
 * Matching the node NAME rather than a substring of the whole path, because mesh
 * names are not disciplined: one car has a mesh called `A_Wheel_LF3` sitting
 * under `WHEEL_RF`, and a substring test counted it as part of the left front
 * wheel. That dragged the wheel center toward the middle of the car and shortened
 * the measured wheelbase by 0.7 m. The SIGN survived it, which is exactly why it
 * would have gone unnoticed without checking the magnitudes against real cars.
 */
function under(mesh: { path?: string }, nodeName: string): boolean {
  // A mesh out of a kn5 always has a path; one assembled in memory need not,
  // and "under no node at all" is a true answer for it rather than a crash.
  const parts = String(mesh.path ?? "")
    .toUpperCase()
    .split("/")
  // Ancestors only: the last segment is the mesh's own name, and it is the one
  // that lies. A mesh that IS the node is still accepted, but only on an exact
  // match rather than on containing the string.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i]!.startsWith(nodeName)) return true
  }
  return parts[parts.length - 1] === nodeName
}

/**
 * Which way is left, and which way is forward, from the wheels.
 *
 * The usual convention is +X the car's left, +Y up, +Z forward, but a model
 * states its own. Assetto Corsa's physics REQUIRES a car to carry nodes named
 * WHEEL_LF, WHEEL_RF, WHEEL_LR and WHEEL_RR: suspension, tire and drivetrain
 * all attach to them, and a car without them does not run. All 235 cars in one
 * install have all four, including all 91 whose axes the name heuristic in
 * `axisHints` could not determine.
 *
 * So the axes are readable exactly rather than inferred. LF and RF differ only in
 * which side they sit on, and LF and LR only in which end, which makes each axis
 * a subtraction. Returns null when the wheels are missing or degenerate.
 */
export function axesFromWheels(model: {
  dummies?: readonly Kn5Dummy[]
  meshes?: readonly Kn5Mesh[]
  buf?: Buffer
}): WheelAxes | null {
  // Defaulted rather than assumed: a hand-built model missing a collection
  // means "no wheels found", which has an answer, rather than a TypeError.
  const dummies = model.dummies ?? []
  const meshes = model.meshes ?? []

  const at = (which: string): { x: number; y: number; z: number } | null => {
    const key = `WHEEL_${which}`
    // The node's own translation IS the wheel center: that is how AC positions
    // it. Averaging the geometry underneath instead gets close but not exact,
    // because a wheel node also holds motion-blur discs and brake parts that are
    // not centered on the axle. On one car that error was 0.46 m of wheelbase.
    const node =
      dummies.find((d) => d.name.toUpperCase() === key) ??
      dummies.find((d) => d.name.toUpperCase().startsWith(key))
    if (node) return { x: node.world[12]!, y: node.world[13]!, z: node.world[14]! }

    // No such node: fall back to the geometry parented under it.
    let x = 0
    let y = 0
    let z = 0
    let n = 0
    for (const mesh of meshes) {
      if (!under(mesh, key)) continue
      const step = Math.max(1, Math.floor(mesh.vertexCount / 200))
      for (let i = 0; i < mesh.vertexCount; i += step) {
        const v = vertex({ buf: model.buf! }, mesh, i)
        x += v.x
        y += v.y
        z += v.z
        n++
      }
    }
    return n ? { x: x / n, y: y / n, z: z / n } : null
  }

  const lf = at("LF")
  const rf = at("RF")
  const lr = at("LR")
  const rr = at("RR")
  if (!lf || !rf || !lr || !rr) return null

  const track = (lf.x + lr.x) / 2 - (rf.x + rr.x) / 2 // left minus right
  const wheelbase = (lf.z + rf.z) / 2 - (lr.z + rr.z) / 2 // front minus rear

  // Degenerate geometry, every wheel at the origin or a model where the two
  // axes are indistinguishable, is worse than no answer, because it looks like
  // one. A real car's track and wheelbase are both comfortably over 10 cm.
  if (Math.abs(track) < 0.1 || Math.abs(wheelbase) < 0.1) return null

  return {
    left: Math.sign(track),
    front: Math.sign(wheelbase),
    confident: true,
    from: "wheels",
    // Reported so a person can sanity-check the result against a spec sheet.
    trackWidth: Math.abs(track),
    wheelbase: Math.abs(wheelbase),
  }
}

/**
 * Which way is left and forward, guessed from mesh names: a node called
 * LEFT_REAR_SHOCK sits at the car's left, one called SUSP_RR at its rear. A
 * cross-check for models without wheel nodes; `axesFromWheels` is the
 * measurement.
 */
export function axisHints(model: Pick<Kn5Model, "meshes" | "buf">): AxisHints {
  const centroid = (mesh: Kn5Mesh): { x: number; z: number } | null => {
    let x = 0
    let z = 0
    const n = Math.min(mesh.vertexCount, 500)
    const step = Math.max(1, Math.floor(mesh.vertexCount / n))
    let c = 0
    for (let i = 0; i < mesh.vertexCount; i += step) {
      const v = vertex(model, mesh, i)
      x += v.x
      z += v.z
      c++
    }
    return c ? { x: x / c, z: z / c } : null
  }
  let leftSign = 0
  let frontSign = 0
  for (const mesh of model.meshes) {
    const n = mesh.name.toUpperCase()
    const c = centroid(mesh)
    if (!c) continue
    if (/\bLEFT|^L[FR]_|_LF\b|_LR\b/.test(n)) leftSign += Math.sign(c.x)
    if (/\bRIGHT|^R[FR]_|_RF\b|_RR\b/.test(n)) leftSign -= Math.sign(c.x)
    if (/NOSE|FRONT|^FW[-_]/.test(n)) frontSign += Math.sign(c.z)
    if (/REAR|^RW[-_]|DIFFUSER/.test(n)) frontSign -= Math.sign(c.z)
  }
  return {
    left: leftSign >= 0 ? 1 : -1, // sign of X that means the car's left
    front: frontSign >= 0 ? 1 : -1, // sign of Z that means the car's front
    confident: Math.abs(leftSign) > 2 && Math.abs(frontSign) > 2,
  }
}

/** A mesh's triangles as vertex indices, dropping any that index past its vertices. */
export function triangles(
  model: Pick<Kn5Model, "buf">,
  mesh: Pick<Kn5Mesh, "indexCount" | "indexStart" | "vertexCount">,
): [number, number, number][] {
  const out: [number, number, number][] = []
  const b = model.buf
  for (let i = 0; i + 2 < mesh.indexCount; i += 3) {
    const o = mesh.indexStart + i * 2
    const a = b.readUInt16LE(o)
    const c2 = b.readUInt16LE(o + 2)
    const d = b.readUInt16LE(o + 4)
    if (a < mesh.vertexCount && c2 < mesh.vertexCount && d < mesh.vertexCount) out.push([a, c2, d])
  }
  return out
}

/**
 * Whether a surface ADDS light rather than covering what is behind it.
 *
 * An emissive sheet is a glow map: black where nothing glows. Assetto Corsa
 * draws these additively, so the black contributes nothing and you see the
 * surface underneath. Composited with SRC_ALPHA instead, an opaque black
 * texture is simply a black rectangle, standing in front of a number plate.
 *
 * Detected by the texture's NAME, which is weaker than reading a shader and is
 * what the model gives: a plate and its glowing twin are both ksPerPixelAlpha,
 * and the only thing distinguishing them is that one is called `_Emissive`.
 */
export function additive(file: string | null | undefined): boolean {
  return /emissive/i.test(String(file ?? ""))
}

/**
 * Whether a material composites against what is behind it.
 *
 * READ OUT OF THE MODEL rather than inferred from the shader's name. A kn5
 * material states `alphaBlendMode` two bytes after its shader: 0 opaque, 1
 * alpha blend, 2 alpha to coverage. The name is not a substitute for it:
 * `ksPerPixelReflection` draws the Abarth 500's side glass and also its
 * bumpers, its exhaust and its underbody, and taking the name's word for it
 * makes the painted bodywork see-through.
 *
 * Alpha TEST is not alpha blend: a hard cutout neither composites nor needs
 * sorting, and treating it as blended would put grilles and bolt heads into
 * the sorted pass for nothing. Alpha to coverage is the same bargain settled
 * by the multisampler. Neither is 1, so neither is blending here.
 *
 * A material we do not have, or one built by hand without the field, is
 * opaque: a wrongly opaque surface looks solid, and a wrongly blended one can
 * disappear.
 */
export function blends(material: MaterialLike): boolean {
  return material?.alphaBlendMode === 1
}

/**
 * The alpha below which this material's fragments are thrown away, or null
 * where it keeps every texel.
 *
 * A HARD CUTOUT, not a composite: a grille, a stitch line, a badge. It is
 * drawn in the opaque pass, writes depth and needs no sorting, which is the
 * whole point of alpha test, and why `blends` deliberately answers no for it.
 *
 * The model states WHETHER in the byte beside `alphaBlendMode` and the
 * threshold itself as `ksAlphaRef`, and 218 of the 253 alpha-tested materials
 * across the 64 readable cars on one install state that as 0. Zero is the
 * property being absent rather than a request to keep every texel, a threshold
 * nothing can fail, so AC's own default for its AT shaders stands in. The 35
 * that do state one mostly say 0.5 anyway; the rest say 0.2, 0.24, 0.3, 0.4
 * and, once, 1, which keeps only a fully opaque texel.
 *
 * The textures agree that the exact number rarely matters: the Abarth 500's
 * grille is 96% of the way to binary, 49% of its texels below 10% alpha and
 * 47% above 90%, with the remainder an antialiased fringe.
 */
export function alphaTest(material: MaterialLike): number | null {
  if (!material?.alphaTested) return null
  const ref = material.props?.ksAlphaRef
  return ref !== undefined && Number.isFinite(ref) && ref > 0 ? ref : 0.5
}

/**
 * Whether a fully transparent texture on this material draws nothing at all.
 *
 * Wider than `blends`, which is about sorting and depth: a hard cutout throws
 * away every texel under its threshold, and every texel of a clear sheet is at
 * zero, which any threshold `alphaTest` returns will fail. Alpha to coverage
 * keeps no sample of a texel at zero either. Asking `blends` alone reports
 * the NSX GT3's grilles, on ksPerPixelAT_NM, as drawn by a material that
 * ignores alpha.
 *
 * The flag, not the shader's name: every AT shader on three cars checked
 * states `alphaTested`, and the RSS 4 also states it on a ksPerPixelNM_UVMult
 * that no name would have given away.
 */
export function discardsClear(material: MaterialLike): boolean {
  return blends(material) || material?.alphaBlendMode === 2 || alphaTest(material) !== null
}

/**
 * Whether a material is reflective glass, specifically: a narrower question
 * than `blends`, since `ksPerPixelAlpha` composites too (a decal, a number
 * plate) but is not glass and should not go mirror-like at a grazing angle.
 */
const GLASS = new Set(["ksPerPixelReflection", "ksWindscreen", "ksBrokenGlass"])
export function isGlass(shader: string | null | undefined): boolean {
  return GLASS.has(String(shader ?? ""))
}

/**
 * Whether a shader is a damage-only overlay, with nothing to show until the
 * car is actually damaged.
 *
 * `ksBrokenGlass` is that shader by convention: a `DAMAGE_GLASS_*` mesh sits
 * exactly over the real glass it belongs to and is how CSP's damage system
 * draws a crack once a panel is hit, a grid of pre-cut fragment quads,
 * invisible at zero damage.
 *
 * Drawn on an undamaged car, with the same fresnel alpha as real glass, it
 * shows as a faint rectangular lattice across the windscreen that looks like a
 * rendering bug. There is no textured or bare-gray rendering of a crack decal
 * that is correct at zero damage, so a renderer with no damage state should
 * leave it out entirely rather than only keep it out of `isGlass`.
 */
export function damageOnly(shader: string | null | undefined): boolean {
  return String(shader ?? "") === "ksBrokenGlass"
}

/**
 * Whether a mesh is a motion-blur alternate: the wheel as it looks spinning,
 * with nothing to show while the car is standing still.
 *
 * A car may ship THREE rims per corner: `EXT_RIM_LF` is the real one,
 * `EXT_RIM_BLUR_LF` a 288-triangle disc wearing a radial streak texture, and
 * `EXT_RIM_BLUR_STATIC_LF` the low-poly rim that sits behind that disc while it
 * spins. The game swaps between them by wheel speed. Drawing all three at once
 * puts the streak disc over the wheel as a turbine-looking fan, and lands the
 * static rim exactly on top of the real one, where the two z-fight.
 *
 * By NAME, because that is where the distinction lives: the static blur rim
 * shares both its material and its texture with the real rim, so nothing in
 * the material can tell them apart.
 *
 * Not only a word of its own. The Abarth 500's are `GEO_rimblur1_SUB0` and on
 * to `GEO_rimblur3`: joined to the part it blurs and numbered. So "blur" right
 * after rim, wheel, disc or tire, or after a separator, and before digits then
 * a separator or the end, never a word that merely contains it.
 */
export function motionBlurOnly(name: string | null | undefined): boolean {
  return /(^|_|rim|wheel|disc|tyre|tire)blur\d*(_|$)/i.test(String(name ?? ""))
}

/**
 * Whether a mesh is a motion-blur alternate by its own name or any node above
 * it. AC hides the NODE, so a mesh under `RIM_BLUR_RR` is an alternate whatever
 * it is called, and the Tatuus calls its blur rims `polymsh3_SUB1`.
 */
export function motionBlurMesh(mesh: { name?: string | null; path?: string }): boolean {
  return (
    motionBlurOnly(mesh.name) ||
    String(mesh.path ?? "")
      .split("/")
      .some(motionBlurOnly)
  )
}

/**
 * Whether this shader's diffuse texture is a plausible standalone image, safe
 * to show on a part as it is.
 *
 * Most shaders sample txDiffuse directly, so what the kn5 stores IS the
 * surface. The MultiMap family is not: Kunos packs several material variants
 * into one sheet (the NSX GT3's cockpit trim is four unrelated teams' switch
 * panels and decals in one atlas) and blends between them at runtime with a
 * mask. Sampling it raw shows a fragment of every variant stitched together,
 * which reads as a broken texture.
 *
 * Detected by NAME. `ksPerPixelMultiMap_damage_dirt` is also a common car
 * paint shader, so this is a question about the stock texture alone, not
 * about anything drawn over it.
 */
export function trustworthyDiffuse(shader: string | null | undefined): boolean {
  return !/multimap/i.test(String(shader ?? ""))
}

/**
 * The tiling second texture a MultiMap material multiplies over its diffuse,
 * when it has one.
 *
 * `trustworthyDiffuse` is right that these materials' diffuse is not the
 * surface. It does not follow that the surface is unknowable: the NMDetail
 * family is simply TWO layers, and the kn5 carries both. The NSX GT3's door
 * cards and rollcage trim are `INT_HR_Occlusion.dds`, an ambient-occlusion
 * bake with no color in it whatsoever, multiplied by `MAT_Carbon.dds`, which
 * is where the weave and the color actually live; the instrument surround is
 * the same bake against `metal_detail_2.dds`. Given both, a viewer can show
 * what the game shows. Given only the bake it cannot, so this answers `null`
 * rather than a part rendered as a grayscale photograph of its own shadows.
 *
 * Gated on the material's own `useDetail`, not on the presence of a filename.
 * `NULL.dds` is Kunos's written-out empty slot and a real entry in the
 * archive, so a filename test alone finds a texture, fetches it, and
 * multiplies a switch panel by whatever that placeholder happens to hold;
 * `useDetail: 0` says so plainly.
 *
 * The multiplier comes back as recorded and is NOT defaulted to something
 * plausible: it is 500 on the NSX GT3's carbon and 100 on its instrument
 * surround, so a made-up 1 would draw a weave with a 20cm pitch and call it
 * carbon. A material claiming detail without a usable multiplier answers
 * `null` with the rest.
 */
export function detailLayer(material: MaterialLike): DetailLayer | null {
  if (trustworthyDiffuse(material?.shader)) return null
  if (!material?.props?.useDetail) return null

  const named = (f: unknown): string | null =>
    typeof f === "string" && f && f.toLowerCase() !== "null.dds" ? f : null
  const diffuse = named(material?.slots?.txDiffuse)
  const detail = named(material?.slots?.txDetail)
  if (!diffuse || !detail) return null

  const mult = Number(material.props.detailUVMultiplier)
  if (!Number.isFinite(mult) || mult <= 0) return null

  // And the detail's NORMAL map, tiled the same way, which is the half that
  // makes a material read as itself. Alcantara's color is a flat dark gray
  // whichever way you light it; what says "suede" is the nap catching light
  // at a thousand angles, and that lives entirely in its normal map. Without
  // it a matte fabric renders as one broad sheen on a perfectly smooth
  // surface.
  //
  // Optional, because the color detail is useful on its own and a material
  // may state one without the other. `detailNormalBlend` is how hard the
  // material wants it, 0.3 for the NSX GT3's alcantara and carbon and 1.5 for
  // its brushed metal, and a material that gives no usable strength gets 1
  // rather than being dropped, since the map itself is the unambiguous part.
  const normal = named(material?.slots?.txNormalDetail)
  const blend = Number(material.props.detailNormalBlend)
  return {
    diffuse,
    detail,
    mult,
    normal,
    // Clamped, because the stated value is not always a considered one: the
    // NSX GT3's radiator says 1000, which would swing the sampled normal past
    // sideways. The real values sit between 0.2 and 1.5, so 4 is well clear
    // of anything deliberate while still catching a typo.
    normalBlend: Number.isFinite(blend) && blend > 0 ? Math.min(4, blend) : 1,
  }
}

/**
 * The material's OWN normal map: the relief of the part itself (stitching, a
 * panel seam, the molding around a switch) at the diffuse's UV, rather than
 * tiled like the detail grain beside it.
 *
 * Gated on the SHADER NAME. AC's shaders say in their names whether they
 * sample this slot (ksPerPixelNM, ksPerPixelAT_NM, ksPerPixelMultiMap_NMDetail)
 * and a kn5 binding a texture to a slot its shader never reads is ordinary.
 * The NSX GT3 has both kinds:
 *
 *   * the carpaint is `ksPerPixelMultiMap_damage_dirt` and its `txNormal` is
 *     `EXT_Damage_NM.dds`, the relief of a CRASHED panel, which the game
 *     blends in by damage. Sampled unconditionally it puts dents down the side
 *     of an undamaged car.
 *   * `LUMIRANK` binds one to a plain `ksPerPixelMultiMap`, which has no
 *     normal to sample it into at all.
 *
 * Matched case-sensitively, so a mod shader spelling it `nm` gets no base
 * normal. That is the safe direction to fail in: a surface flatter than it
 * should be, rather than a car covered in relief nothing in the game shows.
 *
 * `nmObjectSpace` is the other refusal. Such a map stores its direction in the
 * MODEL'S frame rather than the surface's, so putting it through a tangent
 * basis points every fragment somewhere arbitrary.
 */
export function baseNormal(material: MaterialLike): string | null {
  if (!/NM/.test(material?.shader ?? "")) return null
  if (material?.props?.nmObjectSpace) return null
  const file = material?.slots?.txNormal
  // NULL.dds is Kunos's written-out empty slot and a real entry in the archive.
  if (typeof file !== "string" || !file || file.toLowerCase() === "null.dds") return null
  return file
}

/** Meshes whose material's txDiffuse is `textureName`, ignoring case. */
export function meshesUsingTexture(
  model: Pick<Kn5Model, "meshes" | "materials">,
  textureName: string,
): Kn5Mesh[] {
  const want = textureName.toLowerCase()
  return model.meshes.filter((m) => {
    const mat = model.materials[m.materialId]
    return mat && (mat.slots.txDiffuse ?? "").toLowerCase() === want
  })
}

/**
 * Which of a car's two cockpits a mesh belongs to, 'HR' or 'LR', or null for
 * one in neither. A car carries a high- and a low-detail cockpit, both in the
 * model at once, and the game draws one of them depending on the camera;
 * anything that draws or measures the car from outside should pick one.
 */
export function cockpitLod(m: { path?: string }): "HR" | "LR" | null {
  const path = m.path ?? ""
  if (/(^|\/)COCKPIT_HR(\/|$)/i.test(path)) return "HR"
  if (/(^|\/)COCKPIT_LR(\/|$)/i.test(path)) return "LR"
  return null
}
