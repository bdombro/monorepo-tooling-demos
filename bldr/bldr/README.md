# bldr

To install dependencies:

```bash
bun install
```

To run:

```bash
bun src/bldr-cli.ts
or
npm run watch & node dist/src/bldr-cli.ts
```

bun vs node - bun is faster, has instant start, requires no compile, and control over child_process' stdout behaves better. node is better at debugging bc bun gets confused with sourcemaps and stack traces sometimes. That will likely get better as bun matures though.

Benchmarks:
build all this repo
bun -- 36s
node -- 53s

build two large react apps + 6+ deps
bun - 8m50s
node - 12m05s