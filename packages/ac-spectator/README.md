# ac-spectator

Assetto Corsa's game protocol in TypeScript: join a server as a car, the way
the game does, and receive everything it sends to a driver. Positions about 20
times a second, laps, session changes, drivers joining and leaving, chat.

```ts
import { SpectatorClient } from "ac-spectator"

const client = new SpectatorClient({
  host: "203.0.113.5",
  port: 9600, // the server's TCP port, as drivers join it
  acRoot: "/path/to/assettocorsa",
  identity: { guid: "76561198000000001", name: "Race Recorder", team: "", nation: "", car: "ford_transit", password: "" },
  // Somewhere out of sight: other drivers see this car where you put it.
  pose: () => ({ pos: [50_000, -2_000, 50_000], rot: [0, 0, 0], vel: [0, 0, 0] }),
  onPacket: (p) => {
    if (p.kind === "position") for (const car of p.cars) console.log(car.carId, car.pos)
  },
})
const session = await client.connect() // track, layout, session list, the car slot taken
```

What joining takes:

- **A slot:** an entry list slot for the car, with its GUID set to the one you
  join with, as for any driver.
- **The files the server checksums:** `acRoot` laid out as an install, with at
  least `system/data/surfaces.ini`, the track's files and the car's
  `data.acd`. A copy of those is enough; the game needn't be installed.
- **A pose each tick:** every client draws this car, so park it somewhere out
  of sight rather than at the origin, which is on the track at many circuits.

`PluginListener` receives the server's UDP plugin feed: car updates with their
spline position, collisions with the contact point, lap times and session
changes. It accepts the feed only from the server's own address unless told
otherwise.

The lower layers are exported too: `decodeServerPacket`, `encodeHandshake`,
`TcpDeframer`, `WireReader` and the rest, for anyone writing their own client.
