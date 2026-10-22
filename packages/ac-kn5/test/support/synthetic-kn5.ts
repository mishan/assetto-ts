/**
 * Synthetic kn5 models, written in the layout the reader expects, so no test
 * reads a real car: a car's kn5 is somebody else's artwork. A fixture states
 * its own dimensions and UV layout in source, so a test can assert exact
 * numbers.
 *
 * Vertices are 11 floats: position, normal, UV, then the tangent. V IS STORED
 * NEGATIVE, AC's convention where image y is 1 + v, so `vert()` takes the
 * image coordinate you mean and does the flip.
 */

export type Vert = number[]

export interface MeshSpec {
  name: string
  verts: Vert[]
  indices?: number[]
  materialId?: number
}

export interface NodeSpec {
  name: string
  meshes?: MeshSpec[]
  children?: NodeSpec[]
}

export interface MaterialSpec {
  name?: string
  shader?: string
  slots?: Record<string, string>
  props?: Record<string, number>
  alphaBlendMode?: number
  alphaTested?: number
}

export interface Kn5Spec {
  version?: number
  extraMeshes?: MeshSpec[]
  dummies?: { name: string; at: [number, number, number] }[]
  placeholderTexture?: boolean
  encrypted?: boolean
  bodyMesh?: MeshSpec | null
  /** Meshes under named nodes, for rules that read a mesh's path rather than its name. */
  wrapped?: NodeSpec[]
  /** The one material, when `materials` is empty. txDiffuse defaults to the texture. */
  material?: MaterialSpec
  materials?: MaterialSpec[]
  textureName?: string
  textureBytes?: number
  extraTextures?: { name: string; width?: number; height?: number }[]
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const f32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeFloatLE(n)
  return b
}
const str = (s: string): Buffer =>
  Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, "utf8")])

/** A vertex, taking the UV you mean rather than the one the file stores. */
export const vert = (
  x: number,
  y: number,
  z: number,
  u: number,
  v: number,
  n: [number, number, number] = [0, 1, 0],
): Vert => [x, y, z, n[0], n[1], n[2], u, v - 1, 0, 0, 0]

/** A 4x4 translation, as the file stores node transforms: translation in elements 12-14. */
const translation = (x: number, y: number, z: number): Buffer =>
  Buffer.concat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1].map(f32))

const IDENTITY = translation(0, 0, 0)

/** A root dummy over one body mesh, plus whatever the spec adds. */
export function buildKn5({
  version = 6,
  extraMeshes = [],
  dummies = [],
  placeholderTexture = false,
  encrypted = false,
  bodyMesh = null,
  wrapped = [],
  material = {},
  materials = [],
  textureName = "body.dds",
  textureBytes = 128,
  extraTextures = [],
}: Kn5Spec = {}): Buffer {
  const parts: Buffer[] = []

  parts.push(Buffer.from("sc6969", "ascii"), u32(version))
  if (version > 5) parts.push(u32(0))

  // One null slot (type 0, no further fields), then one real DDS.
  const dds = Buffer.alloc(Math.max(128, textureBytes))
  dds.write("DDS ", 0, "ascii")
  // An encrypted model substitutes a 1x1 image for every texture.
  dds.writeUInt32LE(placeholderTexture ? 1 : 64, 12) // height
  dds.writeUInt32LE(placeholderTexture ? 1 : 32, 16) // width
  parts.push(u32(2 + extraTextures.length), u32(0), u32(1), str(textureName), u32(dds.length), dds)
  for (const t of extraTextures) {
    const extra = Buffer.alloc(128)
    extra.write("DDS ", 0, "ascii")
    extra.writeUInt32LE(t.height ?? 64, 12)
    extra.writeUInt32LE(t.width ?? 64, 16)
    parts.push(u32(1), str(t.name), u32(extra.length), extra)
  }

  const mats = materials.length ? materials : [material]
  parts.push(u32(mats.length))
  for (const m of mats) {
    const slots = { txDiffuse: textureName, ...(m.slots ?? {}) }
    const props = m.props ?? {}
    parts.push(
      str(m.name ?? "BodyMat"),
      str(m.shader ?? "ksPerPixel"),
      Buffer.from([m.alphaBlendMode ?? 0, m.alphaTested ?? 0]),
      u32(0), // depthMode
      u32(Object.keys(props).length),
      ...Object.entries(props).map(([k, v]) => Buffer.concat([str(k), f32(v), Buffer.alloc(36)])),
      u32(Object.keys(slots).length),
      ...Object.entries(slots).map(([k, v]) => Buffer.concat([str(k), u32(0), str(v)])),
    )
  }

  const children = 1 + extraMeshes.length + dummies.length + wrapped.length
  parts.push(u32(1), str("root"), u32(children), Buffer.from([1]), IDENTITY)

  const body = bodyMesh ?? {
    name: "body_mesh",
    verts: [vert(0, 0, 0, 0.25, 0.25), vert(1, 0, 0, 0.75, 0.25), vert(0, 0, 1, 0.25, 0.75)],
    indices: [0, 1, 2],
  }
  parts.push(mesh(body))
  for (const em of extraMeshes) parts.push(mesh(em))

  const wrap = (w: NodeSpec): void => {
    const kids = w.children ?? []
    const own = w.meshes ?? []
    parts.push(u32(1), str(w.name), u32(own.length + kids.length), Buffer.from([1]), IDENTITY)
    for (const m of own) parts.push(mesh(m))
    for (const k of kids) wrap(k)
  }
  for (const w of wrapped) wrap(w)

  for (const d of dummies) {
    parts.push(
      u32(1),
      str(d.name),
      u32(0),
      Buffer.from([1]),
      translation(d.at[0], d.at[1], d.at[2]),
    )
  }

  // Custom Shaders Patch appends the protected payload after the node tree and
  // ends the file with a length-prefixed marker.
  if (encrypted) {
    const marker = "__AC_SHADERS_PATCH_KN5ENC_v1__"
    parts.push(
      Buffer.alloc(4096, 0xab),
      u32(marker.length),
      Buffer.from(marker, "ascii"),
      Buffer.from([0x44, 0x0a, 0x01]),
      u32(1),
    )
  }
  return Buffer.concat(parts)
}

/** One mesh node: header, vertices, indices, then the 33-byte trailer. */
function mesh({ name, verts, indices = [], materialId = 0 }: MeshSpec): Buffer {
  const idxBuf = Buffer.alloc(indices.length * 2)
  for (const [i, v] of indices.entries()) idxBuf.writeUInt16LE(v, i * 2)
  return Buffer.concat([
    u32(2),
    str(name),
    u32(0),
    Buffer.from([1]),
    Buffer.from([1, 1, 0]),
    u32(verts.length),
    ...verts.map((v) => Buffer.concat(v.map(f32))),
    u32(indices.length),
    idxBuf,
    u32(materialId), // first of the 33-byte trailer
    Buffer.alloc(29), // layer, lodIn, lodOut, bounding sphere, isRenderable
  ])
}
