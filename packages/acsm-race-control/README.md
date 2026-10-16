# acsm-race-control

Assetto Server Manager's live timing feed, in TypeScript: every collision
between cars or with the scenery, timed, every driver joining and leaving with
their car slot and GUID, and the session. No UDP plugin or admin access is
needed: it's the websocket behind ACSM's public live timing page.

```ts
import { RaceControlFeed } from "acsm-race-control"

const feed = new RaceControlFeed({
  url: "https://acsm.example.org", // the server's ACSM
  onUpdate: (u) => {
    if (u.kind === "collision") console.log(u.carId, "hit", u.otherCarId ?? "the scenery", u.impactSpeed, "km/h")
  },
})
feed.start()
```

- **Collisions** name the cars by slot. ACSM sends GUIDs; the feed keeps track
  of which slot each GUID is in from the status messages and connections.
  `impactSpeed` is km/h, as the game reports it.
- **Drivers already on the server** when the feed opens are announced once,
  as connections, from the first status message.
- **Session** updates come when the track, layout or session changes, not on
  every status message.
- **Reconnects** happen by themselves, backing off from 2 s to 30 s, whether
  ACSM restarts or the connection is refused. Node 22's built-in WebSocket
  reports a refused connection with only an `error` event; this handles that.
- **Timing:** with `now` and `wallClock`, a collision's `receivedAt` is placed
  when the server says it happened, on your clock, unless the two clocks
  disagree by more than a delivery could take.

Unlike the UDP plugin feed, it doesn't say where on the car the contact was.
`RaceControlDecoder` is exported on its own for decoding messages you receive
some other way. Measured on ACSM 2.4.15. Needs Node 22 or later, for its
built-in WebSocket.
