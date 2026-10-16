/**
 * What a car's own data says about it: the files in its `data/` folder, or
 * packed into `data.acd`, and the few numbers in them that place things on the
 * car. Read-only and in memory; nothing here writes an archive or keeps what
 * it read.
 */

import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"

export type Vec3 = [number, number, number]

/** Body-local wheel centers, meters: x across (the car's left), y up, z forward. FL, FR, RL, RR. */
export type WheelOffsets = [Vec3, Vec3, Vec3, Vec3]

/** The files inside a car's data archive, by name. */
export type CarFiles = Map<string, Buffer>

/** Kunos's own cars start with this, then one more int, before the first entry. */
const ACD_MARKER = -1111

/**
 * Reads `data.acd`: a run of entries, each an i32 name length, the name, an
 * i32 byte count, then that many i32 slots whose low byte is the file's byte
 * shifted up by the next character of a key made from the car's folder name,
 * the key starting over for each entry.
 */
export function readAcd(buf: Buffer, folder: string): CarFiles {
  const key = acdKey(folder)
  const out: CarFiles = new Map()
  let o = buf.length >= 8 && buf.readInt32LE(0) === ACD_MARKER ? 8 : 0
  while (o + 4 <= buf.length) {
    const nameLen = buf.readInt32LE(o)
    o += 4
    if (nameLen <= 0 || o + nameLen + 4 > buf.length)
      throw new Error(`${folder}/data.acd isn't an archive this reads`)
    const name = buf.subarray(o, o + nameLen).toString("latin1")
    o += nameLen
    const len = buf.readInt32LE(o)
    o += 4
    if (len < 0 || o + len * 4 > buf.length)
      throw new Error(`${folder}/data.acd: ${name} runs past the end`)
    const data = Buffer.alloc(len)
    for (let i = 0; i < len; i++) {
      data[i] = (buf.readUInt8(o + i * 4) - key.charCodeAt(i % key.length)) & 0xff
    }
    o += len * 4
    out.set(name, data)
  }
  return out
}

/**
 * The key for a car's archive, from its folder name: eight checksums of the
 * lowercased name in signed 32-bit arithmetic, each kept to its low byte,
 * joined with "-". Written from a description of the scheme two open-source
 * readers share; it opens all 245 archives on the machine it was checked on.
 */
export function acdKey(folder: string): string {
  const c = [...folder.toLowerCase()].map((ch) => ch.charCodeAt(0))
  const n = c.length
  const at = (i: number): number => c[i]!
  const div = (a: number, b: number): number => Math.trunc(a / b) | 0

  let k1 = 0
  for (let i = 0; i < n; i++) k1 = (k1 + at(i)) | 0

  let k2 = 0
  for (let i = 0; i < n - 1; i += 2) k2 = (Math.imul(k2, at(i)) - at(i + 1)) | 0

  let k3 = 0
  for (let i = 1; i < n - 3; i += 3) {
    k3 = Math.imul(k3, at(i))
    k3 = div(k3, at(i + 1) + 27)
    k3 = (k3 - 27 - at(i - 1)) | 0
  }

  let k4 = 0x1683
  for (let i = 1; i < n; i++) k4 = (k4 - at(i)) | 0

  let k5 = 66
  for (let i = 1; i < n - 4; i += 4)
    k5 = (Math.imul(Math.imul(k5, at(i) + 15), at(i - 1) + 15) + 22) | 0

  let k6 = 101
  for (let i = 0; i < n - 2; i += 2) k6 = (k6 - at(i)) | 0

  let k7 = 171
  for (let i = 0; i < n - 2; i += 2) k7 = k7 % at(i)

  let k8 = 171
  for (let i = 0; i < n - 1; i++) k8 = (div(k8, at(i)) + at(i + 1)) | 0

  return [k1, k2, k3, k4, k5, k6, k7, k8].map((k) => k & 0xff).join("-")
}

/** `[SECTION]` → key → value, values with comments and padding stripped. */
export function parseIni(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  let section = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$|\/\/.*$/, "").trim()
    const head = /^\[(.+)\]$/.exec(line)
    if (head) {
      section = out.get(head[1]!) ?? new Map()
      out.set(head[1]!, section)
    } else {
      const eq = line.indexOf("=")
      if (eq > 0) section.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
    }
  }
  return out
}

/**
 * Wheel centers relative to the car's center of gravity, which is where the
 * game puts a car's position: across by half the track, down by BASEY, and
 * along by the wheelbase split at CG_LOCATION (the share of weight on the
 * front axle). On a Nissan R32 this reproduces the wheels the game stored in
 * a replay to within a centimeter.
 */
export function wheelsFromSuspension(ini: string): WheelOffsets {
  const s = parseIni(ini)
  const num = (section: string, key: string): number => {
    const v = Number(s.get(section)?.get(key))
    if (!Number.isFinite(v)) throw new Error(`suspensions.ini has no usable ${section}.${key}`)
    return v
  }
  const wheelbase = num("BASIC", "WHEELBASE")
  const cg = num("BASIC", "CG_LOCATION")
  const front = { x: num("FRONT", "TRACK") / 2, y: num("FRONT", "BASEY"), z: wheelbase * (1 - cg) }
  const rear = { x: num("REAR", "TRACK") / 2, y: num("REAR", "BASEY"), z: -wheelbase * cg }
  return [
    [front.x, front.y, front.z],
    [-front.x, front.y, front.z],
    [rear.x, rear.y, rear.z],
    [-rear.x, rear.y, rear.z],
  ]
}

/**
 * One file of a car's data, from `<carDir>/data/` when the car is unpacked and
 * from its `data.acd` otherwise; undefined when it has neither or the file is
 * not in them. The archive's key is the folder's name, so `carDir` has to be
 * the car's own folder, named as the game names it.
 */
export async function readCarFile(carDir: string, name: string): Promise<Buffer | undefined> {
  const unpacked = await readFile(join(carDir, "data", name)).catch(() => undefined)
  if (unpacked !== undefined) return unpacked
  const acd = await readFile(join(carDir, "data.acd")).catch(() => undefined)
  return acd ? readAcd(acd, basename(carDir)).get(name) : undefined
}

/**
 * A car's wheel offsets from `<cars>/<model>`, unpacked `data/` first, then
 * `data.acd`; undefined when the car has neither or they can't be read.
 */
export async function carWheels(carsDir: string, model: string): Promise<WheelOffsets | undefined> {
  const ini = await readCarFile(join(carsDir, model), "suspensions.ini")
  return ini ? wheelsFromSuspension(ini.toString("latin1")) : undefined
}

/**
 * Where the driver's eyes are, from `car.ini`'s `[GRAPHICS] DRIVEREYES`: the
 * cockpit camera's position, in the frame of the car's 3D model rather than of
 * its physics, so `[BASIC] GRAPHICS_OFFSET` does not apply to it. +x is to the
 * car's left, +y up, +z forward, as in the model.
 */
export function driverEyes(carIni: string): Vec3 {
  const raw = parseIni(carIni).get("GRAPHICS")?.get("DRIVEREYES")
  const v = (raw ?? "").split(",").map((n) => Number(n.trim()))
  if (v.length !== 3 || !v.every(Number.isFinite)) {
    throw new Error(
      `car.ini has no usable GRAPHICS.DRIVEREYES${raw === undefined ? "" : `: ${JSON.stringify(raw)}`}`,
    )
  }
  return [v[0]!, v[1]!, v[2]!]
}

/** A car's driver's eyes from `<cars>/<model>`; undefined when its data can't be read. */
export async function carDriverEyes(carsDir: string, model: string): Promise<Vec3 | undefined> {
  const ini = await readCarFile(join(carsDir, model), "car.ini")
  return ini ? driverEyes(ini.toString("latin1")) : undefined
}
