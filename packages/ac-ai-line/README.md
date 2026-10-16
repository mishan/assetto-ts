# ac-ai-line

Reads an Assetto Corsa track's AI line, `ai/fast_lane.ai`, and answers
questions about positions on it: how far round the lap a car is, how far off
the racing line and toward which edge, whether it's past the edge, and which
corner it's at.

```ts
import { readFile } from "node:fs/promises"
import { parseFastLane, Track } from "ac-ai-line"

const track = new Track(parseFastLane(await readFile("content/tracks/imola/ai/fast_lane.ai")))
track.length // meters round the lap
track.corners // T1, T2, … with entry, apex, exit and tightest radius

const p = track.project([x, y, z]) // a car's world position
p.s // meters from the start line
p.offTrack // meters past the edge, 0 when on track
track.where(p.s) // "T3, 40 m before the apex"
```

- **Points:** each has its position, distance along the line, the AI's target
  speed, and the distance to the track edge on either side.
- **Projecting:** pass the previous result's `index` as `near` when following
  a car, so it stays on its own part of the track where the circuit passes
  close to itself, under a bridge for instance.
- **Corners:** found from the line's curvature: tighter than 200 m, at least
  15 m long, with same-direction turns closer than 20 m merged. They're named
  in lap order.
- **`gap(a, b)`:** distance along the line the short way round, across the
  start line where that's shorter.

The layout was measured on Autopolis International (version 7): a 16-byte
header, 20 bytes per point, then 72 bytes of extras per point, of which this
reads the target speed and the two edge distances. One open-source parser reads
32-byte points, which misplaces every point after the first. Other versions are
refused rather than guessed at.
