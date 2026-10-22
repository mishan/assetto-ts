/**
 * What the car's own Custom Shaders Patch config does to the model.
 *
 * A kn5 is not the whole car. `extension/ext_config.ini` beside it can hide
 * meshes with a MODEL_REPLACEMENT section, and cars converted from ACC use it
 * heavily: the NSX GT3 models four sets of number plates on one door, all
 * hidden by default, one un-hidden by the skin that wears it. Read from the
 * model alone, those plates are geometry like any other, and anything that
 * draws or measures the car counts meshes the game never draws.
 *
 * This only reads: it never decides anything, and it names what it could not
 * match rather than dropping it, because a HIDE entry that matches nothing
 * here may still match something in CSP and the difference is worth a line.
 *
 * The rules are CSP's, from its wiki (General – Model replacements, General –
 * Filtering), not guessed:
 *
 *   * HIDE lists MESHES OR NODES. A node hides everything beneath it.
 *   * `?` is the wildcard, and it means "any symbols in any quantity": the
 *     Windows `*`, spelled `?` for compatibility. There is no single-char one.
 *   * A property is matched with a prefix: `texture:X.dds`, `material:M`,
 *     `shader:S`, `parent:N`. A bare `Foo.dds` is therefore a NAME, and on a
 *     car with no mesh called that it hides nothing, whatever the author of
 *     the config meant by it. The NSX GT3 carries two such lines.
 *   * `{ ... }` is an extended filter with boolean logic. Not read here;
 *     reported as unmatched so nobody mistakes "not understood" for "no".
 *   * ACTIVE = 0 switches a section off. SKINS = ... limits it to some skins,
 *     which is a fact about a skin and not about the car; those are collected
 *     separately and not applied.
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { Kn5Material, Kn5Mesh } from "./kn5.js"

/** Where a car's CSP config sits, relative to the folder holding its kn5. */
export const CAR_CONFIG = join("extension", "ext_config.ini")

/** How a hidden mesh was reached: its own name, a node above it, or a property. */
export type HiddenBy = "name" | "node" | "texture" | "material" | "shader" | "parent"

export interface HiddenMeshes {
  /** Each hidden mesh's name, with the first pattern that reached it and how. */
  hidden: Map<string, { by: HiddenBy; pattern: string }>
  /** Patterns that matched nothing in the model, or that this reader does not understand. */
  unmatched: string[]
}

/**
 * The HIDE patterns that apply to `modelFile`, from the ini text.
 *
 * A MODEL_REPLACEMENT section names the kn5 files it applies to in FILE and
 * the meshes to hide in HIDE, both comma-separated. One without FILE is read
 * as applying to every model; that is CSP's default and also the safe reading,
 * since the failure the other way is a hidden mesh reported as visible.
 *
 * Case-insensitive throughout: Windows never cared, and neither do the people
 * writing these files.
 *
 * `skinOnly` collects the patterns from sections carrying a SKINS filter, so a
 * caller can say "these are hidden for some skins" without pretending to know
 * which skin will be worn.
 */
export function hidePatterns(
  iniText: string,
  modelFile: string,
  { skinOnly = null }: { skinOnly?: string[] | null } = {},
): string[] {
  const want = String(modelFile).toLowerCase()
  const patterns: string[] = []
  let inReplacement = false
  let files: string[] | null = null
  let hides: string[] = []
  let active = true
  let skins: string[] | null = null

  const flush = (): void => {
    if (inReplacement && active && (files === null || files.includes(want))) {
      if (skins) skinOnly?.push(...hides)
      else patterns.push(...hides)
    }
    inReplacement = false
    files = null
    hides = []
    active = true
    skins = null
  }

  for (const raw of String(iniText).split(/\r?\n/)) {
    // `;` and `//` both comment in CSP configs, and a value can carry one.
    const line = raw.replace(/\s*(;|\/\/).*$/, "").trim()
    if (!line) continue
    const section = line.match(/^\[([^\]]+)\]/)
    if (section) {
      flush()
      inReplacement = /^MODEL_REPLACEMENT(_|\.\.\.|$)/i.test(section[1]!.trim())
      continue
    }
    if (!inReplacement) continue
    const kv = line.match(/^([A-Za-z_][\w]*)\s*=\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]!.toUpperCase()
    const values = kv[2]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    if (key === "FILE") files = values.map((f) => f.toLowerCase())
    else if (key === "HIDE") hides.push(...values)
    else if (key === "ACTIVE") active = values[0] !== "0"
    else if (key === "SKINS") skins = values
  }
  flush()
  return patterns
}

/** CSP's mask as a regex: `?` is any run of characters, everything else is literal. */
function mask(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\*]/g, "\\$&").replace(/\?/g, ".*")}$`, "i")
}

/**
 * Resolve HIDE patterns against a parsed model.
 *
 * Each pattern is tried against every mesh, and a mesh records the FIRST
 * pattern that reached it and how (by its own name, by a node above it, or by
 * a property) so a caller can show its working.
 *
 * Returns every hidden mesh name, and every pattern that matched nothing.
 * Matching nothing is not an error: it is what a name pattern spelled like a
 * texture does, and it is worth a line rather than a silence.
 */
export function hiddenMeshes(
  model: {
    meshes?: readonly (Pick<Kn5Mesh, "name" | "materialId"> & { path?: string })[]
    materials?: readonly Kn5Material[]
  },
  patterns: readonly string[],
): HiddenMeshes {
  const hidden: HiddenMeshes["hidden"] = new Map()
  const unmatched: string[] = []
  const meshes = model.meshes ?? []
  type Mesh = (typeof meshes)[number]
  const material = (m: Mesh): Kn5Material | undefined => model.materials?.[m.materialId]
  // Every node above a mesh, from its path. The root is a node too.
  const ancestors = (m: Mesh): string[] => (m.path ?? "").split("/").slice(0, -1)

  for (const pattern of patterns) {
    let hit = 0
    const claim = (m: Mesh, by: HiddenBy): void => {
      if (!hidden.has(m.name)) hidden.set(m.name, { by, pattern })
      hit++
    }

    if (/^\{/.test(pattern)) {
      // Extended filtering: `{ a & !shader:x }`. Reading that properly means
      // a boolean parser, and half of one would hide the wrong things.
      unmatched.push(pattern)
      continue
    }

    const prop = pattern.match(/^(\w+):(.*)$/)
    if (prop) {
      const key = prop[1]!
      const re = mask(prop[2]!)
      for (const m of meshes) {
        const mat = material(m)
        switch (key.toLowerCase()) {
          case "texture":
            if (Object.values(mat?.slots ?? {}).some((t) => re.test(t))) claim(m, "texture")
            break
          case "material":
            if (re.test(mat?.name ?? "")) claim(m, "material")
            break
          case "shader":
            if (re.test(mat?.shader ?? "")) claim(m, "shader")
            break
          case "parent":
            if (ancestors(m).some((n) => re.test(n))) claim(m, "parent")
            break
          default:
            // A property this reader does not know (`insideInterior:yes`,
            // `alphaBlend:yes`, ...). Left unmatched and named, below.
            break
        }
      }
    } else {
      const re = mask(pattern)
      for (const m of meshes) {
        if (re.test(m.name)) claim(m, "name")
        else if (ancestors(m).some((n) => re.test(n))) claim(m, "node")
      }
    }
    if (!hit) unmatched.push(pattern)
  }
  return { hidden, unmatched }
}

/**
 * The car's config, read from beside the model. Absent is the common case and
 * is not an error: most cars have no extension folder at all.
 *
 * ABSENT, though, and nothing else. A config that exists and cannot be read
 * (no permission, a bad mount, an I/O error) is a car whose hidden meshes are
 * unknown, and treating that as "no config" reports every hidden plate as
 * visible with no sign that anything went wrong. So only "there is no such
 * file" is swallowed and everything else is thrown at the caller.
 */
export async function carConfigBeside(
  kn5Path: string,
): Promise<{ path: string; text: string } | null> {
  const at = join(dirname(kn5Path), CAR_CONFIG)
  const raw = await readFile(at).catch((e: NodeJS.ErrnoException) => {
    // ENOTDIR is the same answer as ENOENT with a directory in the path: a
    // car with a FILE called `extension`, or no extension folder at all.
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null
    throw new Error(
      `${at} exists but could not be read (${e.code ?? e.message}). ` +
        "That config may hide meshes, so the model read without it would show parts the game does not.",
      { cause: e },
    )
  })
  if (raw === null) return null
  // Some of these were saved by tools that write UTF-16 with a BOM, where a
  // NUL between every character matches nothing; others carry a UTF-8 BOM.
  const text =
    raw[0] === 0xff && raw[1] === 0xfe
      ? raw.subarray(2).toString("utf16le")
      : raw.toString("utf8").replace(/^﻿/, "")
  return { path: at, text }
}
