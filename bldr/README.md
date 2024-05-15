# bldr

## About

A monorepo CLI and lib that bootstraps and builds JS applications in a monorepo, with careful handling of crosslinks to mimic the install behavior of published npm packages.

### Motivation

1. Existing monorepo tools mismanage crosslinks in a monorepo by linking them via a basic symlink. This causes many issues, such as:
    1. Deeply nested `node_modules` folders.
    2. `devDependencies` of the crosslinks being installed.
    3. Dependencies being in different places compared to if installed as an npm package.
    4. Symlink issues related to the way that Node resolves modules.
2. Existing monorepo tools don't allow for each package to have its own package manager and lock file, which dramatically decreases flexibility while dramatically increasing the cost of adoption.

#### Example Crosslink Conflicts in Existing Tools

- A React app may have dependencies that have devDependencies with different versions of React. This causes TypeScript and bundlers to include multiple versions of React, which blows up the bundle size, causes runtime errors, and TypeScript errors.
- Symlink resolution conflict: if "libA" depends on lodash, and "libB" depends on lodash and "libA", nested libA will use its own copy of lodash instead of libB's.

### Goal

De-conflict nested dependencies.


## Get started

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