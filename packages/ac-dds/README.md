# ac-dds

Writes DDS textures Assetto Corsa reads correctly, decodes them back to RGBA
in Node or a browser, and says why the game would mishandle one. AC is a DX9
engine, and a texture it cannot use still installs and loads: the only symptom
is a car that looks wrong.

```ts
import { caseCollisions, ddsInfo, ddsProblems, decodeDds, encodeDds } from "ac-dds"

const dds = encodeDds(rgba, 2048, 2048, { alpha: true }) // a Buffer: DXT5, 12 mip levels
decodeDds(dds.buffer.slice(dds.byteOffset, dds.byteOffset + dds.length)) // { width, height, pixels }

ddsInfo(bytes)     // { width, height, mips, fourCC, alpha, dx10 }, or null
ddsProblems(bytes) // [{ code: "mip-chain", message: "It has no mipmaps where ..." }]
caseCollisions(["Body.dds", "body.dds", "rim.dds"]) // [["Body.dds", "body.dds"]]
```

- **Encoder:** BC1 (DXT1) or, with `alpha`, BC3 (DXT5), with every mip
  level down to 1x1 and the classic DX9 header, never DX10. The chain is
  counted to the longer edge, so 2048x512 gets 12 levels, and each level is
  averaged weighted by alpha, so a cut-out's clear black never darkens its
  edges at a distance. Flat colors come back within one step of themselves.
- **Decoder:** DXT1, DXT3 and DXT5, the same behind a DX10 header, BC7, and
  uncompressed RGB, RGBA and luminance read through the header's channel
  masks. Top level only, and null for anything else rather than a guess.
- **Checker:** `ddsProblems` reports `not-dds`, `dx10` (ignored by the game,
  the classic white car), `not-power-of-two` (a DX9 game may drop the mip
  chain), `mip-chain` (too few levels: shimmers at a distance) and
  `truncated` (shorter than its declared levels need), each with a one-line
  message. `caseCollisions` finds names that are one file on NTFS, where the
  second to extract wins.

`ac-dds/decode` is the decoder alone, with no imports at all, so a browser
can load it straight from `node_modules` through an import map. The rest uses
`Buffer` and is Node only.
