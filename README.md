# assetto-ts

TypeScript for Assetto Corsa's files and network protocol, as separate npm
packages:

| Package | What it does |
| --- | --- |
| [`acreplay`](packages/acreplay) | Writes `.acreplay` files the game opens, from car positions, with each car's wheels placed from its own data. |
| [`ac-spectator`](packages/ac-spectator) | Joins a server as a car and hands you everything it sends: positions, laps, sessions, chat. Also receives the server's UDP plugin feed, collisions included. |

They were written for [acsm-champctl](https://github.com/mishan/acsm-champctl),
which records a league's races and stewards their incidents, and are used
there every race night.

## Development

```sh
npm install
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

Node 22 or later. Each package is published on its own, from a tag naming it:
`acreplay@0.1.0` or `ac-spectator@0.1.0`.

MIT licensed.
