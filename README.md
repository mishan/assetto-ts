# assetto-ts

TypeScript for Assetto Corsa's files and network protocol, as separate npm
packages:

| Package | What it does |
| --- | --- |
| [`acreplay`](packages/acreplay) | Writes `.acreplay` files the game opens, from car positions, with each car's wheels placed from its own data. |
| [`ac-spectator`](packages/ac-spectator) | Joins a server as a car and hands you everything it sends: positions, laps, sessions, chat. Also receives the server's UDP plugin feed, collisions included. |
| [`ac-ai-line`](packages/ac-ai-line) | Reads a track's AI line (`fast_lane.ai`) and places any position on the lap: distance round, off the line, past the edge, which corner. |

They were written for [acsm-champctl](https://github.com/mishan/acsm-champctl),
which records a league's races and stewards their incidents, and are used
there every race night.

## Development

```sh
npm install
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

Node 22 or later. Each package is published on its own by pushing a tag that
names it, `acreplay@0.1.0`, `ac-spectator@0.1.0` or `ac-ai-line@0.1.0`, with the package's
`version` bumped to match. npm trusts `.github/workflows/publish.yml` in the
`npm` environment to publish them, so there's no token to keep.

MIT licensed.
