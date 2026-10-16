# acreplay

Writes Assetto Corsa `.acreplay` files (version 16), which the game opens from
its replay menu, from car positions you already have: from
[`ac-spectator`](../ac-spectator), the UDP plugin feed or anything else.

```ts
import { writeReplay } from "acreplay"

const summary = await writeReplay(
  [
    { t: "session", at: 0, track: "imola", trackConfig: "", name: "Race" },
    { t: "car", at: 0, carId: 1, model: "ks_mazda_mx5_cup", skin: "red", driver: "Ana" },
    { t: "pos", at: 0, car: { carId: 1, timestamp: 0, pos: [0, 0, 0], rot: [0, 0, 0], vel: [0, 0, 0], steer: 0, rpm: 3000, gear: 3, statusFlags: 0 } },
    // ...
  ],
  "race.acreplay",
  { carsDir: "/path/to/assettocorsa/content/cars" },
)
```

Events can be an array or an async iterable, so a long session streams rather
than sitting in memory. Each car's samples are spooled to a temporary file and
the replay is written under a `.part` name until it's complete.

- **Clock:** an event's `at` and a sample's `timestamp` are the same millisecond
  clock. Timestamps may wrap at 2^32, as the game protocol's do; `at` mustn't.
- **Clips:** `window: { fromMs, toMs }` writes only that stretch, counted from
  the session event's `at`.
- **Wheels:** the network carries no wheel positions. With `carsDir`, each
  car's come from its own `data.acd` (or `data/` folder); otherwise a Nissan
  R32's stand in. `summary.cars[].ownWheels` says which.
- **Laps and drop-outs:** `lap` events give the replay's standings, and a
  `connection` event with `connected: false` takes a car out of the replay
  where its driver left, as the game does.

Checked against a 26-car race replay the game itself wrote. Sun angle, wing
data and track objects are written as zero and none, which the game accepts.

Errors that mean there's nothing to write are a `ReplayError` with a `code`:
`no-session` or `no-cars`.
