## Intro

This repo hosts demonstrations of popular JS monorepo tools with the same set of child applications (aka workspaces). The intent is to share learnings and feature comparisons.


## Context

JS Monorepo tooling emerged in the 2010s, for their many maintenance benefits for larger teams. They make managing multiple apps significantly easier, performant, and reliable.

Starting out, package managers offered little as far as monorepo features goes, leaving a large opportunity for tools like Lerna to gain popularity. As Lerna became more popular, package managers took notice and started incorporating the best features of Lerna. Armed with most of Lerna's features, package manager's basically killed Lerna's appeal and popularity sank. Meanwhile, the community and maintainers of Lerna also sunk. As a result, monorepo tools like Nx, Rush and Turbo started poping up which extended package managers with enterprise features such as cloud caching and CI/CD integrations.

A few years later, Nrwl (the maintainer of Nx) took over maintenance of Lerna and basically turned Lerna into Nx with backward compatibility for Lerna projects.

## Package managers

A package manager is a tool to download an app's dependencies and facilitate scripting.

One critical feature of package managers is "resolving" which version of each dependency to install, where to install, how, and dedupe shared dependencies when possible. They create a "lock" file, which is a map of what resolutions were made. Lock files are critical to ensure that the exact same resolutions are made between developers and CI/CD. Without them, JS apps would be terribly unreliable.

An unfortunate consiquence of manager-specific resolution is lock-in -- many issues arrise with differing resolutions.

These days, all JS package managers support the following features:

- cross-reference: workspaces can depend on other workspaces and the tooling connects them
- install dependencies for a specific workspace without installing all workspaces (aka scoping)
- execute arbitrary terminal commands in multiple workspaces
- cross-reference aware scripting (except npm)
- support private npm repositories
- hoisting: multiple applications can share dependencies, thereby boosting install performance and reducing disk usage. Sadly, hoisting can break some libraries which were written without hoisting
  support.

At the same time, non of the package managers support an upgrade path from single app to monorepo without reseting lock files.

### npm

npm is the default package manager for node, and is the least-featured and least-flexible. While testing on an enterprise monorepo, we noticed major limitations.

What's great
- Comes with nodejs
- Super lean and lightweight
- Compatibility is very high when not using monorepo features

What's not
- monorepo tooling features are lacking vs others
- sometimes resolves a dependency poorly vs others
- does mysterious hoisting: hoisting seems to be automatically applied with the monorepo features, and is unpredictable,
   non-configurable and undocumented
- no global cache features


### yarn

yarn is the first and most popular alternative to npm. It gained and remains favor due to reliability, rich feature set and configurability.

yarn v2 introduced unstable and breaking changes, so many teams are still on v1 (aka legacy), which is minimally supported. yarn is now on v4 and mostly stable, but sadly is not backward compatible with v1.

What's great
- Good balance of stable and features
- Leader in hoisting features
- Leader in configurability
- Is the most popular alternative to npm
- Superb performance features

What's not
- Backwards compat was broken between v1 and v2


### pnpm

pnpm is the newest package manager, and gained popularity due to performance features such as caching and hoisting, which actually inspired many features in newer versions of yarn. These days, it boasts mostly the same features of yarn but is architecturally different, which is why some libraries are compatible with one and not the other.

What's great
- More helpful features than NPM
- Superb performance features

What's not
- Is popular, but substantially less
- Is more likely to have incompatabilities with dependencies


## monorepo tools

As mentioned earlier, modern monorepo tools focus on extending the monorepo features of package managers. An unfortunate consequence is loss of flexibility and lacking of legacy package-manager support (ie yarn v1). If absolute flexibility, interoperability, and compatibility is required, Lerna (with the legacy plugin) is the only option.


### Lerna

Lerna is a node application to manage JS monorepos. Lerna is configurable to use npm, yarn or pnpm as the package manager, and mostly extends them with CI/CD performance features like build artifact caching. Lerna maintenance and development hit a slump a few years back, until a company called Nrwl adopted it, who are also the creators of the Nx monorepo tool (see next section). For better and worse, Nrwl's motivation to take over Lerna was likely to promote Nrwl's cloud services.

As the first popular JS monorepo tool, Lerna has hugely inspired monorepo features in modern package managers. Because many of the features were eventually adopted into those package managers, the Lerna maintainers decided to stop improving overlapping features and extract them into a plugin called 'legacy-package-management'. Thanks to the legacy features, Lerna is the only modern monorepo tool that supports per-app package manager configuration.


What's great
- flexibility of package managers and lock files. It's even possible to incrementally adopt yarn workspaces -- see lerna-8x-hybrid folder.

What's not
- somewhat awkward integration and relationship with Nx
- CI/CD support is weak for non-Nrwl cloud


### Nx

Nx is a mixed-language application to manage JS monorepos. Like Lerna, Nx is configurable to use npm, yarn or pnpm as the package manager, and mostly extends them with CI/CD performance features like build artifact caching. Nx was created and is maintained by Nrwl, who's motivation is to promote Nrwl's cloud services.

What's great
- Very lightweight and easy to learn
- Possibly the best cache validation/invalidation to be more DRY ((ref)[https://github.com/vsavkin/large-monorepo])
- (Beta) Distribute sub-tasks across machines with nx-agents ((ref)[https://nx.dev/ci/features/nx-agents])

What's not
- CI/CD support is weak for non-Nrwl cloud


### Rush

Rush is a node application to manage JS monorepos that uses pnpm under the hood. The website claims it supports npm and yarn, but the github issues suggest support is weak. It was created and is maintained by Microsoft, whos motivation is likely to use the tool internally.

Like Lerna, Rush extends pnpm's monorepo features with CI/CD performance features. When comparing Rush to other tools, Rush is more opinionated, more feature rich, and less flexible for better and worse.

What's great
- Very flexible
- Tons of features and golden paths

What's not
- Likely bloated and overkill for smaller teams
- Moves package-manager config and caches in weird folders. Results in learning curve and possible lock-in
- Is less good at concurancy than others -- but can be combined with (Lage)[https://microsoft.github.io/lage/docs/Introduction/#level-1-legacy-workspace-runners] to boost


### Turbo

Turbo is a mixed-language application to manage JS monorepos. like Lerna+Nx, Turbo is configurable to use npm, yarn or pnpm as the package manager, and mostly extends them with CI/CD performance features like build artifact caching. It was create and maintained by Vercel -- I suspect with motivation to promote Vercel cloud services, similar to Nextjs.

What's great
- Good balance of features and opinions
- Performance critical parts are written in Rust for speed boost
- Very flexible with cloud options

What's not
- Maybe less hand-holding compared to Rush


## TODO

- Consider (Lage)[https://microsoft.github.io/lage/]
- Consider (wsrun)[https://github.com/hfour/wsrun]
- Consider cache performance more
  - https://github.com/vsavkin/large-monorepo
- Consider other features as described in (monorepo.tools)[https://monorepo.tools/]