# assetto-ts

TypeScript for Assetto Corsa's files and network protocol, and for Assetto
Server Manager, as separate npm packages:

| Package | npm | What it does |
| --- | --- | --- |
| [`acreplay`](packages/acreplay) | [npm](https://www.npmjs.com/package/acreplay) | Writes `.acreplay` files the game opens, from car positions, with each car's wheels placed from its own data. |
| [`ac-spectator`](packages/ac-spectator) | [npm](https://www.npmjs.com/package/ac-spectator) | Joins a server as a car and hands you everything it sends: positions, laps, sessions, chat. Also receives the server's UDP plugin feed, collisions included. |
| [`ac-cardata`](packages/ac-cardata) | [npm](https://www.npmjs.com/package/ac-cardata) | Reads a car's own data, its `data/` folder or `data.acd`: files, `car.ini`, the driver's eyes and the wheels' positions. |
| [`ac-kn5`](packages/ac-kn5) | [npm](https://www.npmjs.com/package/ac-kn5) | Reads a car's 3D model (`.kn5`): meshes, materials, textures, where each vertex lands on its texture, which way the car faces, and which meshes its Custom Shaders Patch config hides. |
| [`ac-dds`](packages/ac-dds) | [npm](https://www.npmjs.com/package/ac-dds) | Writes DDS textures the game reads correctly, with a full mip chain, decodes them to RGBA in Node or a browser, and says why the game would mishandle one: DX10 headers, missing mipmaps, odd sizes. |
| [`ac-ai-line`](packages/ac-ai-line) | [npm](https://www.npmjs.com/package/ac-ai-line) | Reads a track's AI line (`fast_lane.ai`) and places any position on the lap: distance round, off the line, past the edge, which corner. |
| [`acsm-race-control`](packages/acsm-race-control) | [npm](https://www.npmjs.com/package/acsm-race-control) | Assetto Server Manager's live timing feed: collisions, drivers joining and leaving, and the session, with no UDP plugin needed. |

They were written for two projects, and are used by them:

- [acsm-champctl](https://github.com/mishan/acsm-champctl) records a league's
  races and stewards their incidents, every race night, with `ac-spectator`,
  `acsm-race-control`, `ac-ai-line` and `acreplay`. It checks drivers'
  uploaded liveries with `ac-dds`.
- [liverykit](https://github.com/mishan/liverykit) generates car liveries from
  code. It reads the car with `ac-kn5` and `ac-cardata`, and writes and
  previews its textures with `ac-dds`.

## Development

```sh
npm install
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

Node 22 or later. Each package is published on its own: bump its `version`,
then push a tag naming the package and that version, such as `acreplay@0.1.1`.
npm trusts `.github/workflows/publish.yml` in the `npm` environment to publish
them, so there's no token to keep. A new package needs:

1. A placeholder published to npm, which claims the name.
2. Its trusted publisher set up on npmjs.com: repository `mishan/assetto-ts`,
   workflow `publish.yml`, environment `npm`.
3. Its tag pattern added to the workflow's `tags` and to the `npm`
   environment's deployment tag rules:

   ```sh
   gh api -X POST repos/mishan/assetto-ts/environments/npm/deployment-branch-policies \
     -f name='<pkg>@*' -f type=tag
   ```
4. Patience on its first release, which sits in npm's staging window for a few
   minutes before it appears. The workflow waits for it.

MIT licensed.
