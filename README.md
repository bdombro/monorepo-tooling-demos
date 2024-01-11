

## Comparisons

Legend: 🌕 is supported; 🌗 is semi-supported, 🌑 is not supported


### lerna 2.x

lerna is a node application to manage JS monorepos. Version 2x is package-manager agnostic and not maintained.

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌗 yarn.lock v1 compat - caveat: hoisting must be disabled
  - 🌑 {root}/package.json::override support
  - 🌕 {package}/package.json::override support
  - 🌑 constraints: enforce dependency rules (similar to syncpack)
  - 🌕 support private npm repositories
  - 🌗 hoisting - not available except npm package manager
  - 🌕 hoisting: configurable
  - 🌑 bootstrap speed: 
- Global scripts
  - 🌕 Install minimal dependencies for workspace + upstream workspaces which depend on it
  - 🌕 Run in multiple workspaces
  - 🌕 Run in glob workspaces
  - 🌕 Run in git-changed workspaces
  - 🌕 Run in workspace + upstream workspaces which are dependencies
  - 🌕 Run in workspace + downstream workspaces which depend on it
  - 🌕 Execute arbitrary terminal commands in multiple workspaces
  - 🌕 Concurrancy
  - 🌕 Observability: Print the workspace's script command before running (i.e. `react-scripts build`)
  - 🌑 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🌑 Remote caching: strongly supports

### lerna 7.x

lerna is a node application to manage JS monorepos that extends features of yarn-workspaces (see section), namely with caching.

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌑 yarn.lock v1 compat
  - 🌕 {root}/package.json::override support
  - 🌑 {package}/package.json::override support
  - 🌕 constraints: enforce dependency rules (similar to syncpack)
  - 🌕 support private npm repositories
  - 🌕 hoisting
  - 🌕 hoisting: configurable
  - 🌕 bootstrap speed: 
- Global scripts
  - 🌕 Install minimal dependencies for workspace + upstream workspaces which depend on it
  - 🌕 Run in multiple workspaces
  - 🌕 Run in glob workspaces
  - 🌕 Run in git-changed workspaces
  - 🌕 Run in workspace + upstream workspaces which are dependencies
  - 🌕 Run in workspace + downstream workspaces which depend on it
  - 🌕 Execute arbitrary terminal commands in multiple workspaces
  - 🌕 Concurrancy
  - 🌕 Observability: Print the workspace's script command before running (i.e. `react-scripts build`)
  - 🌕 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🌕 Remote caching: strongly supports


### lerna 7.x w/ yarn 1.22 & legacy mode

lerna is a node application to manage JS monorepos. lerna 7.x was designed to extend yarn workspaces, but can be configured to support yarn v1 via an minimally maintained plugin.

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌕 yarn.lock v1 compat
  - 🌑 {root}/package.json::override support
  - 🌕 {package}/package.json::override support
  - 🌑 constraints: enforce dependency rules (similar to syncpack)
  - 🌕 support private npm repositories
  - 🌑 hoisting
  - 🌕 hoisting: configurable
  - 🌕 bootstrap speed: 
- Global scripts
  - 🌕 Install minimal dependencies for workspace + upstream workspaces which depend on it
  - 🌕 Run in multiple workspaces
  - 🌕 Run in glob workspaces
  - 🌕 Run in git-changed workspaces
  - 🌕 Run in workspace + upstream workspaces which are dependencies
  - 🌕 Run in workspace + downstream workspaces which depend on it
  - 🌕 Execute arbitrary terminal commands in multiple workspaces
  - 🌕 Concurrancy
  - 🌕 Observability: Print the workspace's script command before running (i.e. `react-scripts build`)
  - 🌕 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🌕 Remote caching: strongly supports


### npm workspaces

Built-in features for the default package manager in node (npm). Very light on features.

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌑 yarn.lock v1 compat
  - 🌕 {root}/package.json::override support
  - 🌑 {package}/package.json::override support
  - 🌑 constraints: enforce dependency rules (similar to syncpack)
  - 🌑 support private npm repositories
  - 🌕 hoisting
  - 🌑 hoisting: configurable
  - 🌕 bootstrap speed:
- Global scripts
  - 🌑 Install minimal dependencies for workspace + upstream workspaces which depend on it
  - 🌕 Run in multiple workspaces
  - 🌑 Run in glob workspaces
  - 🌑 Run in git-changed workspaces
  - 🌑 Run in workspace + upstream workspaces which depend on it
  - 🌑 Run in workspace + downstream workspaces which depend on it
  - 🌑 Execute arbitrary terminal commands in multiple workspaces
  - 🌑 Concurrancy
  - 🌕 Observability: Print the package's script command before running (i.e. `react-scripts build`)
  - 🌑 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🌑 Remote caching: strongly supports


### pnpm workspaces

Built-in features for the pnpm package manager.

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌑 yarn.lock v1 compat
  - 🌕 {root}/package.json::override support
  - 🌕 {package}/package.json::override support
  - 🌕 constraints: enforce dependency rules (similar to syncpack)
  - 🌕 support private npm repositories
  - 🌕 hoisting
  - 🌕 hoisting: configurable
  - 🌕 bootstrap speed: 5.3s
- Global scripts
  - 🌕 Install minimal dependencies for workspace + upstream workspaces which depend on it
  - 🌕 Run in multiple workspaces
  - 🌕 Run in glob workspaces
  - 🌕 Run in git-changed workspaces
  - 🌕 Run in workspace + upstream workspaces which depend on it
  - 🌕 Run in workspace + downstream workspaces which depend on it
  - 🌕 Execute arbitrary terminal commands in multiple workspaces
  - 🌕 Concurrancy
  - 🌕 Observability: Print the package's script command before running (i.e. `react-scripts build`)
  - 🌑 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🌑 Remote caching: strongly supports


### rush (pnpm)

rush is a node application to manage JS monorepos that uses pnpm under the hood. I don't love how heavy it is.

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌑 yarn.lock v1 compat
  - 🌕 {root}/package.json::override support
  - 🌕 {package}/package.json::override support
  - 🌕 constraints: enforce dependency rules (similar to syncpack)
  - 🌕 support private npm repositories
  - 🌕 hoisting
  - 🌕 hoisting: configurable 
  - 🌕 bootstrap speed: 12.1s
- Global scripts
  - 🌕 Install minimal dependencies for workspace + upstream workspaces which depend on it
  - 🌑 Run in multiple workspaces
  - 🌑 Run in glob workspaces
  - 🌑 Run in git-changed workspaces
  - 🌑 Run in workspace + upstream workspaces which depend on it
  - 🌑 Run in workspace + downstream workspaces which depend on it
  - 🌑 Execute arbitrary terminal commands in multiple workspaces
  - 🌑 Concurrancy
  - 🌕 Observability: Print the package's script command before running (i.e. `react-scripts build`)
  - 🌕 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🌕 Remote caching: strongly supports


### rush + yarn v1 (unsupported)

pnpm is the default package manager, but it's possible to configure rush to use yarn v1. However, pnpm is the only officially supported and there are bugs.


### turbo + pnpm

turbo is a node application to manage a monorepo, and is compatible with modern versions of npm, yarn and pnpm. It adds more features on top of the package manager, namely caching. Pnpm is my favorite flavor, bc pnpm has more features than the others.

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌑 yarn.lock v1 compat
  - 🌕 {root}/package.json::override support
  - 🌕 {package}/package.json::override support
  - 🌕 constraints: enforce dependency rules (similar to syncpack)
  - 🌕 support private npm repositories
  - 🌕 hoisting
  - 🌕 hoisting: configurable
  - 🌕 bootstrap speed: 5.3s
- Global scripts
  - 🌕 Install minimal dependencies for workspace + upstream workspaces which depend on it
  - 🌕 Run in multiple workspaces
  - 🌕 Run in glob workspaces
  - 🌕 Run in git-changed workspaces
  - 🌕 Run in workspace + upstream workspaces which depend on it
  - 🌕 Run in workspace + downstream workspaces which depend on it
  - 🌕 Execute arbitrary terminal commands in multiple workspaces
  - 🌕 Concurrancy
  - 🌕 Observability: Print the package's script command before running (i.e. `react-scripts build`)
  - 🌕 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🌕 Remote caching: strongly supports


### yarn workspaces

Built-in features for the yarn package manager

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌑 yarn.lock v1 compat
  - 🌕 {root}/package.json::override support
  - 🌑 {package}/package.json::override support
  - 🌕 constraints: enforce dependency rules (similar to syncpack)
  - 🌕 support private npm repositories
  - 🌕 hoisting
  - 🌕 hoisting: configurable
  - 🌕 bootstrap speed: 6.5s
- Global scripts
  - 🌕 Install minimal dependencies for workspace + upstream workspaces which depend on it
  - 🌕 Run in multiple workspaces
  - 🌕 Run in glob workspaces
  - 🌕 Run in git-changed workspaces
  - 🌕 Run in workspace + upstream workspaces which depend on it
  - 🌑 Run in workspace + downstream workspaces which depend on it
  - 🌕 Execute arbitrary terminal commands in multiple workspaces
  - 🌕 Concurrancy
  - 🌑 Observability: Print the package's script command before running (i.e. `react-scripts build`)
  - 🌑 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🌑 Remote caching: strongly supports


### Template

- Dependency Management
  - 🌕🌗🌑 Cross-reference: can depend on other workspaces
  - 🌕🌗🌑 yarn.lock v1 compat
  - 🌕🌗🌑 {root}/package.json::override support
  - 🌕🌗🌑 {package}/package.json::override support
  - 🌕🌗🌑 constraints: enforce dependency rules (similar to syncpack)
  - 🌕🌗🌑 support private npm repositories
  - 🌕🌗🌑 hoisting
  - 🌕🌗🌑 hoisting: configurable
- Global scripts
  - 🌕🌗🌑 Install minimal dependencies for workspace + upstream workspaces which depend on it
  - 🌕🌗🌑 Run in multiple workspaces
  - 🌕🌗🌑 Run in glob workspaces
  - 🌕🌗🌑 Run in git-changed workspaces
  - 🌕🌗🌑 Run in workspace + upstream workspaces which depend on it
  - 🌕🌗🌑 Run in workspace + downstream workspaces which depend on it
  - 🌕🌗🌑 Execute arbitrary terminal commands in multiple workspaces
  - 🌕🌗🌑 Concurrancy
  - 🌕🌗🌑 Observability: Print the package's script command before running (i.e. `react-scripts build`)
  - 🌕🌗🌑 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🌕🌗🌑 Remote caching: strongly supports