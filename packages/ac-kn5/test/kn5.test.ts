import { describe, expect, it } from "vitest"

import {
  additive,
  alphaTest,
  axesFromWheels,
  baseNormal,
  blends,
  cockpitLod,
  detailLayer,
  discardsClear,
  type Kn5Dummy,
  type MaterialLike,
  motionBlurMesh,
  motionBlurOnly,
  parseKn5Buffer,
  placeOnSheet,
  trustworthyDiffuse,
  vertex,
} from "../src/kn5.js"
import { buildKn5, type MeshSpec, vert } from "./support/synthetic-kn5.js"

describe("parseKn5Buffer", () => {
  it("parses a well-formed file to the exact final byte", () => {
    const m = parseKn5Buffer(buildKn5())
    expect(m.version).toBe(6)
    expect(m.textures.length, "the type-0 null slot must not become a texture").toBe(1)
    expect(m.textures[0]!.name).toBe("body.dds")
    expect(m.materials[0]!.slots.txDiffuse).toBe("body.dds")
    expect(m.meshes.length).toBe(1)
    expect(m.meshes[0]!.vertexCount).toBe(3)
  })

  it("negates V, because AC stores it that way", () => {
    // Stored v = -0.75 must surface as texture-space y = 0.25. Getting this
    // wrong flips every island vertically and still looks plausible.
    const m = parseKn5Buffer(buildKn5())
    expect(Math.round(vertex(m, m.meshes[0]!, 0).v * 1000) / 1000).toBe(0.25)
    expect(vertex(m, m.meshes[0]!, 0).u).toBe(0.25)
  })

  it("rejects a trailing-byte file rather than half-parsing it", () => {
    const good = buildKn5()
    expect(() => parseKn5Buffer(Buffer.concat([good, Buffer.alloc(4)]))).toThrow(/finished at byte/)
    expect(() => parseKn5Buffer(Buffer.from("nope!!"), {})).toThrow(/not a kn5/)
  })

  it("reads an encrypted model, not rejecting it, and never decrypts it", () => {
    // Some mod authors ship a kn5 whose geometry is intact but whose textures
    // are 1x1 placeholders, with the real ones in a Custom Shaders Patch blob
    // appended to the file. Three cars in a 235-car install were built this
    // way, and an exact-length check alone refuses all three as corrupt.
    const plain = parseKn5Buffer(buildKn5())
    expect(plain.encrypted, "an ordinary model is not flagged").toBeNull()

    const enc = parseKn5Buffer(buildKn5({ encrypted: true }))
    expect(enc.encrypted?.scheme).toBe("csp-kn5enc-v1")
    expect(enc.encrypted!.bytes).toBeGreaterThan(4000)
    expect(enc.meshes.length, "the geometry reads identically").toBe(plain.meshes.length)
    expect(enc.materials).toEqual(plain.materials)
  })

  it("still refuses a genuinely truncated file", () => {
    // The encryption check must not become a way for any short parse to pass.
    // It only excuses trailing bytes that carry the marker.
    const buf = Buffer.concat([buildKn5(), Buffer.alloc(4096, 0xab)])
    expect(() => parseKn5Buffer(buf)).toThrow(/parser finished at byte/)
  })

  it("builds each mesh's path from the nodes it hangs under", () => {
    // A mesh's own name is whatever the artist typed (the Abarth 500's steering
    // wheel is Geometry81_SUB0 through SUB7); the node above it, STEER_HR, is
    // where the model states what it is.
    const tri = [vert(0, 0, 0, 0.1, 0.1), vert(1, 0, 0, 0.2, 0.1), vert(0, 1, 0, 0.1, 0.2)]
    const m = parseKn5Buffer(
      buildKn5({
        wrapped: [
          {
            name: "STEER_HR",
            children: [{ name: "Geometry81", meshes: [{ name: "Geometry81_SUB4", verts: tri }] }],
          },
        ],
      }),
    )
    const mesh = m.meshes.find((x) => x.name === "Geometry81_SUB4")
    expect(mesh?.path).toBe("root/STEER_HR/Geometry81/Geometry81_SUB4")
    expect(mesh?.depth).toBe(3)
  })
})

/** A seat cushion's UV island: `repeat` sheets across, shifted by `shift`. */
function cushion({
  repeat = 1,
  shift = [0, 0],
  name = "SEAT_CUSHION",
}: {
  repeat?: number
  shift?: [number, number]
  name?: string
}): MeshSpec {
  const N = 6
  const verts = []
  const indices = []
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const s = i / N
      const t = j / N
      verts.push(
        vert(
          -0.3 + 0.6 * s,
          0.5,
          -0.3 + 0.6 * t,
          shift[0] + 0.05 + 0.9 * s * repeat,
          shift[1] + 0.05 + 0.9 * t * repeat,
        ),
      )
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i
      indices.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1)
    }
  }
  return { name, verts, indices, materialId: 1 }
}

describe("islands on another copy of the sheet", () => {
  it("moves an island back onto the sheet only when it fits wholly on another copy", () => {
    const model = parseKn5Buffer(
      buildKn5({
        extraMeshes: [
          cushion({ name: "SHIFTED", shift: [0, -1] }),
          // Overhangs [0, 1] by 0.006, which an ordinary unwrap does; stays put.
          cushion({ name: "OVERHANG", shift: [-0.056, 0] }),
          // A sliver hugging the sheet's right edge, u = 0.992 to 0.9965: on
          // the sheet, and stays there, rather than one sheet the wrong way.
          cushion({ name: "RIGHT_EDGE", repeat: 0.005, shift: [0.942, 0] }),
          // Spans 36 sheets: a tiling material, with no one copy to move to.
          cushion({ name: "TILING", repeat: 40 }),
          // Straddles v = 0, which the game wraps across the image's edge.
          cushion({ name: "STRADDLE", shift: [0, -0.5] }),
        ],
        materials: [{ name: "BodyMat" }, { name: "SeatMat", slots: { txDiffuse: "seat.dds" } }],
        extraTextures: [{ name: "seat.dds" }],
      }),
    )
    const mesh = (name: string) => model.meshes.find((m) => m.name === name)!
    const first = (name: string) => vertex(model, mesh(name), 0)

    expect(first("SHIFTED").u).toBeCloseTo(0.05, 6)
    expect(first("SHIFTED").v, "moved from v = -0.95 to the sheet").toBeCloseTo(0.05, 6)
    expect(first("OVERHANG").u, "an overhang by a hair is not a shift").toBeCloseTo(-0.006, 6)
    expect(first("RIGHT_EDGE").u).toBeCloseTo(0.992, 6)
    expect(mesh("RIGHT_EDGE").uvShift, "an island at the sheet's far edge is on it").toBeUndefined()
    expect(first("TILING").v).toBeCloseTo(0.05, 6)
    expect(mesh("TILING").uvShift).toBeUndefined()
    expect(first("STRADDLE").v, "a straddler cannot move whole").toBeCloseTo(-0.45, 6)
    expect(mesh("STRADDLE").straddlers, "and is counted, by its vertices").toEqual([49])
    expect(mesh("TILING").straddlers, "a tiling island is not a straddler").toBeUndefined()
    expect(mesh("body_mesh").uvShift, "nothing to move reads exactly as stored").toBeUndefined()
  })

  it("places any format's vertices by the same rule", () => {
    // Two triangles a sheet below [0, 1], and one straddling u = 1.
    const uvs: [number, number][] = [
      [0.1, -0.9],
      [0.2, -0.9],
      [0.2, -0.8],
      [0.1, -0.8],
      [0.9, 0.5],
      [1.1, 0.5],
      [1.1, 0.6],
    ]
    const { uvShift, straddlers } = placeOnSheet(
      uvs.length,
      [
        [0, 1, 2],
        [0, 2, 3],
        [4, 5, 6],
      ],
      (i) => uvs[i]!,
    )
    expect(Array.from(uvShift!)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0])
    expect(straddlers).toEqual([3])
  })
})

/** Only the dummies matter here; axesFromWheels reads the node translations. */
function wheelCar({
  lf = [0.8, 0.3, 1.3],
  rf = [-0.8, 0.3, 1.3],
  lr = [0.8, 0.3, -1.0],
  rr = [-0.8, 0.3, -1.0],
}: Partial<Record<"lf" | "rf" | "lr" | "rr", [number, number, number]>> = {}) {
  const d = (name: string, [x, y, z]: [number, number, number]): Kn5Dummy => {
    const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1])
    return { name, path: name, depth: 1, world }
  }
  return {
    meshes: [],
    dummies: [d("WHEEL_LF", lf), d("WHEEL_RF", rf), d("WHEEL_LR", lr), d("WHEEL_RR", rr)],
  }
}

describe("axesFromWheels", () => {
  it("says which way is left and which is forward", () => {
    // Assetto Corsa's physics requires WHEEL_LF/RF/LR/RR on every car, so this
    // is a measurement rather than a guess.
    const normal = axesFromWheels(wheelCar())!
    expect(normal.left, "+X is the left of a car whose LF sits at positive X").toBe(1)
    expect(normal.front).toBe(1)
    expect(normal.confident).toBe(true)
    expect(normal.wheelbase).toBeCloseTo(2.3, 6)
    expect(normal.trackWidth).toBeCloseTo(1.6, 6)

    // A mirrored or reversed model has to come out mirrored or reversed, not
    // defaulted to the common case.
    const mirrored = axesFromWheels(
      wheelCar({
        lf: [-0.8, 0.3, 1.3],
        rf: [0.8, 0.3, 1.3],
        lr: [-0.8, 0.3, -1],
        rr: [0.8, 0.3, -1],
      }),
    )
    expect(mirrored?.left).toBe(-1)
    const reversed = axesFromWheels(
      wheelCar({
        lf: [0.8, 0.3, -1.3],
        rf: [-0.8, 0.3, -1.3],
        lr: [0.8, 0.3, 1],
        rr: [-0.8, 0.3, 1],
      }),
    )
    expect(reversed?.front).toBe(-1)
  })

  it("gives no answer for wheels stacked at the origin, rather than a wrong one", () => {
    const flat = wheelCar({ lf: [0, 0, 0], rf: [0, 0, 0], lr: [0, 0, 0], rr: [0, 0, 0] })
    expect(axesFromWheels(flat)).toBeNull()
    expect(axesFromWheels({ meshes: [], dummies: [] }), "no wheels, no answer").toBeNull()
    // A hand-built model missing a collection means "no wheels found".
    expect(axesFromWheels({})).toBeNull()
    expect(axesFromWheels({ meshes: [] })).toBeNull()
    expect(axesFromWheels({ dummies: [] })).toBeNull()
  })

  it("falls back to the geometry under a wheel node, by node and not by mesh name", () => {
    // One car has a mesh called A_Wheel_LF3 under WHEEL_RF; counted as the
    // left front, it shortened the measured wheelbase by 0.7 m. The nodes are
    // left out so the geometry is all there is to go on.
    const at = (x: number, z: number) => [vert(x, 0.3, z, 0.1, 0.1)]
    const model = parseKn5Buffer(
      buildKn5({
        wrapped: [
          { name: "WHEEL_LF", meshes: [{ name: "a", verts: at(0.8, 1.3) }] },
          { name: "WHEEL_RF", meshes: [{ name: "A_Wheel_LF3", verts: at(-0.8, 1.3) }] },
          { name: "WHEEL_LR", meshes: [{ name: "c", verts: at(0.8, -1) }] },
          { name: "WHEEL_RR", meshes: [{ name: "d", verts: at(-0.8, -1) }] },
        ],
      }),
    )
    const axes = axesFromWheels({ meshes: model.meshes, buf: model.buf })!
    expect(axes.left).toBe(1)
    expect(axes.wheelbase).toBeCloseTo(2.3, 6)
    expect(axes.trackWidth).toBeCloseTo(1.6, 6)
  })
})

describe("material predicates", () => {
  it("takes what blends from the model, not from the shader's name", () => {
    const model = parseKn5Buffer(
      buildKn5({
        materials: [
          { name: "CAR_Livrea", shader: "ksPerPixelMultiMap_damage_dirt" },
          { name: "CAR_PLASTICA", shader: "ksPerPixelReflection" },
          { name: "CAR_Vetro", shader: "ksPerPixelReflection", alphaBlendMode: 1 },
          { name: "CAR_Griglia", shader: "ksPerPixelAT_NM", alphaTested: 1 },
          { name: "COVERAGE", shader: "ksPerPixel", alphaBlendMode: 2 },
        ],
      }),
    )
    const [paint, plastic, glass, grille, coverage] = model.materials

    expect(blends(paint)).toBe(false)
    expect(blends(plastic), "the glass's own shader, and the model calls it opaque").toBe(false)
    expect(blends(glass)).toBe(true)
    expect(grille!.alphaTested).toBe(true)
    expect(blends(grille), "alpha test is not alpha blend").toBe(false)
    expect(blends(coverage)).toBe(false)
    expect(blends(undefined), "a material we do not have is opaque").toBe(false)
    expect(blends({ shader: "ksWindscreen" }), "unrecorded means opaque").toBe(false)

    // A clear texel is drawn by none of the three that are not opaque.
    expect([paint, plastic, glass, grille, coverage].map(discardsClear)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ])
    expect(discardsClear(undefined)).toBe(false)
  })

  it("gives an alpha-tested material its stated threshold, and an unset one AC's", () => {
    expect(alphaTest({ shader: "ksPerPixelAT", props: {} }), "not stated is not tested").toBeNull()
    expect(alphaTest(undefined)).toBeNull()
    expect(alphaTest({ alphaTested: true, props: {} }), "AC's own default").toBe(0.5)
    expect(alphaTest({ alphaTested: true, props: { ksAlphaRef: 0 } }), "zero is absent").toBe(0.5)
    expect(alphaTest({ alphaTested: true, props: { ksAlphaRef: 0.24 } })).toBe(0.24)
    expect(alphaTest({ alphaTested: true, props: { ksAlphaRef: 1 } })).toBe(1)

    // Out of a real header, so the byte and the property arrive together.
    const model = parseKn5Buffer(
      buildKn5({ materials: [{ name: "CAR_Griglia", shader: "ksPerPixelAT_NM", alphaTested: 1 }] }),
    )
    expect(alphaTest(model.materials[0])).toBe(0.5)
  })

  it("calls emissive sheets additive, by name and ignoring case", () => {
    expect(additive("IGT_Numberplate_Emissive.dds")).toBe(true)
    expect(additive("honda_emissive.dds")).toBe(true)
    expect(additive("EXT_Glass_Emissive_Headlights.dds")).toBe(true)
    expect(additive("anything_EMISSIVE_uppercase.dds")).toBe(true)
    // The plate itself is NOT additive: it is the thing being lit.
    expect(additive("IGT_Numberplate_Colour.dds")).toBe(false)
    expect(additive("EXT_Skin_Sponsors.dds")).toBe(false)
    expect(additive(undefined)).toBe(false)
  })

  it("tells a motion-blur rim from a real part", () => {
    for (const yes of [
      "EXT_RIM_BLUR_LF",
      "RIM_BLUR",
      "blur",
      "EXT_Rim_Blur_Static_RF",
      "GEO_rimblur1_SUB0",
      "GEO_rimblur_SUB1",
    ]) {
      expect(motionBlurOnly(yes), `${yes} is an alternate`).toBe(true)
    }
    // A pattern loose enough to catch the rims must not eat a part whose name
    // merely contains the letters.
    for (const no of [
      "EXT_RIM_LF",
      "blurton_decal",
      "BLURRED",
      "unblurred",
      "rimblurred",
      "",
      null,
    ]) {
      expect(motionBlurOnly(no), `${JSON.stringify(no)} is a real part`).toBe(false)
    }
    // The Tatuus names its blur rims `polymsh3_SUB1`, and says what they are
    // only in the node AC hides them by.
    const tatuus = "Tatus_Abarth_LOD_0.fbx/SUSP_RR/WHEEL_RR"
    expect(
      motionBlurMesh({
        name: "polymsh3_SUB1",
        path: `${tatuus}/RIM_BLUR_RR/polymsh3/polymsh3_SUB1`,
      }),
    ).toBe(true)
    expect(
      motionBlurMesh({ name: "Geometry45", path: `${tatuus}/RIM_RR/Geometry45/Geometry45` }),
    ).toBe(false)
    expect(motionBlurMesh({ name: "GEO_rimblur1_SUB0" })).toBe(true)
  })

  it("reads a two-layer material only when all of it is there", () => {
    const multi = {
      shader: "ksPerPixelMultiMap",
      slots: { txDiffuse: "bake.dds", txDetail: "carbon.dds", txNormalDetail: "carbon_nm.dds" },
      props: { useDetail: 1, detailUVMultiplier: 377, detailNormalBlend: 2 },
    }
    expect(trustworthyDiffuse(multi.shader), "a MultiMap diffuse is an atlas").toBe(false)
    expect(detailLayer(multi)).toEqual({
      diffuse: "bake.dds",
      detail: "carbon.dds",
      mult: 377,
      normal: "carbon_nm.dds",
      normalBlend: 2,
    })

    const without = (patch: MaterialLike) => detailLayer({ ...multi, ...patch })
    expect(without({ props: { ...multi.props, useDetail: 0 } }), "it has to ask").toBeNull()
    expect(without({ shader: "ksPerPixel" }), "a diffuse that IS the surface").toBeNull()
    expect(
      without({ slots: { ...multi.slots, txDetail: "NULL.dds" } }),
      "NULL.dds is none",
    ).toBeNull()
    expect(without({ slots: { ...multi.slots, txDiffuse: "" } })).toBeNull()
    expect(without({ props: { ...multi.props, detailUVMultiplier: 0 } })).toBeNull()
    expect(without({ props: { ...multi.props, detailUVMultiplier: Number.NaN } })).toBeNull()
    expect(detailLayer(null), "a mesh with no material at all").toBeNull()

    // The normal map is optional; the color half still stands without it.
    const noNormal = without({ slots: { txDiffuse: "bake.dds", txDetail: "carbon.dds" } })
    expect(noNormal?.detail).toBe("carbon.dds")
    expect(noNormal?.normal).toBeNull()
  })

  it("reads a part's own relief where the shader says it is, and nowhere else", () => {
    expect(
      baseNormal({
        shader: "ksPerPixelNM",
        slots: { txDiffuse: "plastic.dds", txNormal: "flat_nm.dds" },
      }),
    ).toBe("flat_nm.dds")
    expect(
      baseNormal({
        shader: "ksPerPixelMultiMap_NMDetail",
        slots: { txDiffuse: "INT_HR_Occlusion.dds", txNormal: "INT_HR_Occlusion_NM.dds" },
      }),
    ).toBe("INT_HR_Occlusion_NM.dds")
    expect(
      baseNormal({ shader: "ksPerPixelAT_NM", slots: { txNormal: "EXT_Decals_NM.dds" } }),
    ).toBe("EXT_Decals_NM.dds")
    // The carpaint's normal slot holds the relief of a CRASHED panel.
    expect(
      baseNormal({
        shader: "ksPerPixelMultiMap_damage_dirt",
        slots: { txDiffuse: "EXT_Skin_Sponsors.dds", txNormal: "EXT_Damage_NM.dds" },
      }),
      "a damage map is not the shape of the part",
    ).toBeNull()
    expect(
      baseNormal({ shader: "ksPerPixelMultiMap", slots: { txNormal: "Lumirank_3_slots_NM.dds" } }),
      "the shader name is what says the slot is read",
    ).toBeNull()
    expect(
      baseNormal({
        shader: "ksPerPixelNM",
        props: { nmObjectSpace: 1 },
        slots: { txNormal: "EXT_Lights_NM.dds" },
      }),
    ).toBeNull()
    expect(baseNormal({ shader: "ksPerPixelNM", slots: { txNormal: "NULL.dds" } })).toBeNull()
    expect(baseNormal({ shader: "ksPerPixelNM", slots: {} })).toBeNull()
    expect(baseNormal(null)).toBeNull()
  })

  it("places a mesh in a cockpit by the node it hangs under", () => {
    expect(cockpitLod({ path: "root/COCKPIT_HR/dash" })).toBe("HR")
    expect(cockpitLod({ path: "cockpit_lr" })).toBe("LR")
    expect(
      cockpitLod({ path: "root/COCKPIT_HR_OLD/dash" }),
      "a name that merely starts so",
    ).toBeNull()
    expect(cockpitLod({})).toBeNull()
  })
})
