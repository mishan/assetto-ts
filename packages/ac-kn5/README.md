# ac-kn5

Reads an Assetto Corsa car model, a `.kn5`: its meshes, materials, embedded
textures and node transforms, with each vertex's position and UV, so where a
texture lands on the car is read rather than estimated. Also reads the car's
Custom Shaders Patch config, which can hide meshes the model contains.

```ts
import { axesFromWheels, carConfigBeside, hiddenMeshes, hidePatterns, parseKn5, vertex } from "ac-kn5"

const path = "/path/to/assettocorsa/content/cars/abarth500/abarth500.kn5"
const model = await parseKn5(path)
const mesh = model.meshes[0]!
vertex(model, mesh, 0) // { x, y, z, nx, ny, nz, tx, ty, tz, u, v }, world space
axesFromWheels(model)  // { left: 1, front: 1, trackWidth, wheelbase, ... }

const config = await carConfigBeside(path)
if (config) hiddenMeshes(model, hidePatterns(config.text, "abarth500.kn5")).hidden
```

- **Exact parse:** the format is reverse-engineered, so the reader must end
  on the file's last byte, and throws when it doesn't rather than hand back a
  partial model.
- **Encrypted models:** some mod cars ship textures as 1x1 placeholders with
  the real ones in an encrypted CSP blob. The geometry is read and
  `model.encrypted` says so; nothing is decrypted.
- **UVs:** `v` comes out in texture space (y down, 1 + the stored value), and
  an island stored on another copy of the sheet is read back on [0, 1].
- **Axes:** from the `WHEEL_LF`/`RF`/`LR`/`RR` nodes every drivable car has.
  `vertex` reads lazily from the buffer, so a 50 MB model is never copied.
- **Materials:** `blends`, `alphaTest`, `discardsClear`, `detailLayer`,
  `baseNormal` and the rest answer how the game draws a material, from what
  the model states rather than from shader names, where it states it.
- **Hidden meshes:** `MODEL_REPLACEMENT` `HIDE` entries in
  `extension/ext_config.ini`, by CSP's matching rules. A pattern that
  matches nothing, or an extended `{ ... }` filter, comes back in `unmatched`.

Node only: it reads with `Buffer`.
