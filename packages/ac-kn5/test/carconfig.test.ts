import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

import { carConfigBeside, hiddenMeshes, hidePatterns } from "../src/carconfig.js"
import { parseKn5Buffer } from "../src/kn5.js"
import { buildKn5, vert } from "./support/synthetic-kn5.js"

const NSX_STYLE = `
[MODEL_REPLACEMENT_...]
FILE = car.kn5, car_lod_b.kn5 ; the LODs share the plates
HIDE = IGT_NUMBERPLATE_LEFT, IGT_NUMBERPLATE_RIGHT, Blancpain_Silver2_Colour.dds

[MODEL_REPLACEMENT_...]
FILE = other_car.kn5
HIDE = NOT_THIS_ONE

[MODEL_REPLACEMENT_...]
HIDE = SPOTTER_?

[MODEL_REPLACEMENT_...]
ACTIVE = 0
HIDE = SWITCHED_OFF

[MODEL_REPLACEMENT_...]
SKINS = red?
HIDE = ONLY_FOR_SOME_SKINS

[LIGHT_HEADLIGHTS_0]
HIDE = a_key_in_another_section
`

describe("hidePatterns", () => {
  it("takes HIDE patterns from MODEL_REPLACEMENT sections that apply to this model", () => {
    // The section for another model is skipped; one with no FILE applies to
    // all; ACTIVE=0 is off; a SKINS filter means "some skins, not the car";
    // HIDE outside MODEL_REPLACEMENT is some other feature's key.
    const skinOnly: string[] = []
    expect(hidePatterns(NSX_STYLE, "CAR.kn5", { skinOnly })).toEqual([
      "IGT_NUMBERPLATE_LEFT",
      "IGT_NUMBERPLATE_RIGHT",
      "Blancpain_Silver2_Colour.dds",
      "SPOTTER_?",
    ])
    expect(skinOnly).toEqual(["ONLY_FOR_SOME_SKINS"])
    expect(hidePatterns(NSX_STYLE, "other_car.kn5")).toEqual(["NOT_THIS_ONE", "SPOTTER_?"])
    expect(hidePatterns("", "car.kn5")).toEqual([])
  })

  it("reads a line of a hundred thousand spaces in linear time", () => {
    // The config is whatever the car shipped. Regexes that backtracked over
    // a run of spaces took this from milliseconds to minutes.
    const pad = " ".repeat(100_000)
    const ini = `[MODEL_REPLACEMENT_0]\nHIDE${pad}=${pad}PLATE${pad};${pad}\nA=${pad}\n;${";".repeat(100_000)}`
    const started = performance.now()
    expect(hidePatterns(ini, "car.kn5")).toEqual(["PLATE"])
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe("hiddenMeshes", () => {
  it("resolves patterns the way CSP's filtering page says, and says how", () => {
    // CSP's wildcard is `?`, meaning any symbols in any quantity, and a HIDE
    // entry names a mesh OR a node. Properties take a prefix, so a bare
    // `Foo.dds` is a NAME, and with no mesh called that it hides nothing.
    const tri = [vert(0, 0, 0, 0, 0), vert(1, 0, 0, 1, 0), vert(0, 1, 0, 0, 1)]
    const model = parseKn5Buffer(
      buildKn5({
        extraMeshes: [
          { name: "IGT_NUMBERPLATE_LEFT", verts: tri, indices: [0, 1, 2] },
          { name: "SPOTTER_L", verts: tri, indices: [0, 1, 2] },
          { name: "SPOTTER_R", verts: tri, indices: [0, 1, 2] },
        ],
      }),
    )
    const { hidden, unmatched } = hiddenMeshes(model, [
      "igt_numberplate_left",
      "SPOTTER_?",
      "NOWHERE",
      "body.dds",
      "texture:BODY.dds",
      "shader:ksPerPixel",
    ])
    expect(hidden.get("IGT_NUMBERPLATE_LEFT")?.by).toBe("name")
    expect(hidden.get("SPOTTER_L")?.by).toBe("name")
    expect(hidden.get("SPOTTER_R")?.by).toBe("name")
    // First match wins the label: body_mesh is reached by texture: before shader:.
    expect(hidden.get("body_mesh")).toEqual({ by: "texture", pattern: "texture:BODY.dds" })
    expect(unmatched, "a bare .dds is a name pattern, and there is no such mesh").toEqual([
      "NOWHERE",
      "body.dds",
    ])
  })

  it("hides every mesh beneath a named node", () => {
    // Every mesh sits under `root`, so `root` is the node and everything hides;
    // `parent:root` says the same thing the property way.
    const model = parseKn5Buffer(buildKn5())
    expect(hiddenMeshes(model, ["ROOT"]).hidden.get("body_mesh")?.by).toBe("node")
    expect(hiddenMeshes(model, ["parent:ro?"]).hidden.get("body_mesh")?.by).toBe("parent")
    // An extended `{ ... }` filter is beyond this reader and is reported as
    // unmatched rather than half-understood.
    expect(hiddenMeshes(model, ["{ body_mesh & !shader:ksPerPixel }"]).unmatched).toEqual([
      "{ body_mesh & !shader:ksPerPixel }",
    ])
  })
})

describe("carConfigBeside", () => {
  const dirs: string[] = []
  const carDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-kn5-cfg-"))
    dirs.push(dir)
    await writeFile(join(dir, "car.kn5"), buildKn5())
    return dir
  }
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  })

  it("reads the config beside the model, and absent is not an error", async () => {
    const dir = await carDir()
    expect(await carConfigBeside(join(dir, "car.kn5"))).toBeNull()

    await mkdir(join(dir, "extension"))
    const ini = "[MODEL_REPLACEMENT_...]\nHIDE=PLATE_L\n"
    await writeFile(join(dir, "extension", "ext_config.ini"), ini)
    expect(await carConfigBeside(join(dir, "car.kn5"))).toEqual({
      path: join(dir, "extension", "ext_config.ini"),
      text: ini,
    })
  })

  it("refuses a config that exists and cannot be read, rather than calling it absent", async () => {
    // Unreadable is a different fact wearing the same clothes: the car has
    // hide rules and they were not applied. A directory in place of the file
    // is an EISDIR, which is any read failure that is not "no such file".
    const dir = await carDir()
    await mkdir(join(dir, "extension", "ext_config.ini"), { recursive: true })
    await expect(carConfigBeside(join(dir, "car.kn5"))).rejects.toThrow(/could not be read/)
  })
})
