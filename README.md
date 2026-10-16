# assetto-ts

TypeScript for Assetto Corsa's files and network protocol, and for Assetto
Server Manager, as separate npm packages:

| Package | What it does |
| --- | --- |
| [`acreplay`](packages/acreplay) | Writes `.acreplay` files the game opens, from car positions, with each car's wheels placed from its own data. |
| [`ac-spectator`](packages/ac-spectator) | Joins a server as a car and hands you everything it sends: positions, laps, sessions, chat. Also receives the server's UDP plugin feed, collisions included. |
| [`ac-ai-line`](packages/ac-ai-line) | Reads a track's AI line (`fast_lane.ai`) and places any position on the lap: distance round, off the line, past the edge, which corner. |
| [`acsm-race-control`](packages/acsm-race-control) | Assetto Server Manager's live timing feed: collisions, drivers joining and leaving, and the session, with no UDP plugin needed. |

They were written for [acsm-champctl](https://github.com/mishan/acsm-champctl),
which records a league's races and stewards their incidents, and are used
there every race night.

## Development

```sh
npm install
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

Node 22 or later. Each package is published on its own: bump its `version`,
then push a tag naming the package and that version, such as `acreplay@0.1.1`.
npm trusts `.github/workflows/publish.yml` in the `npm` environment to publish
them, so there's no token to keep. A new package needs a placeholder published
once and its trusted publisher set up on npmjs.com, and its tag pattern added
to the workflow and to the `npm` environment.

MIT licensed.
