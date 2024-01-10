

## Comparisons

Legend: 🌕 is supported; 🌗 is semi-supported, 🌑 is not supported

### npm workspaces

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌑 yarn.lock v1 compat
  - 🌕 {root}/package.json::override support
  - 🌑 {package}/package.json::override support
  - 🌑 constraints: enforce dependency rules (similar to syncpack)
  - 🌑 support private npm repositories
  - 🌕 hoisting
  - 🌑 hoisting: configurable
  - 🌕 bootstrap speed: 9s
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


### yarn workspaces

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

### pnpm workspaces

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


### lerna 2.x w/ yarn 1.22

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌗 yarn.lock v1 compat - caveat: hoisting must be disabled
  - 🌑 {root}/package.json::override support
  - 🌕 {package}/package.json::override support
  - 🌑 constraints: enforce dependency rules (similar to syncpack)
  - 🌕 support private npm repositories
  - 🌕 hoisting
  - 🌕 hoisting: configurable
  - 🌕 bootstrap speed: 8.2s
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

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌑 yarn.lock v1 compat
  - 🌕 {root}/package.json::override support
  - 🌑 {package}/package.json::override support
  - 🌕 constraints: enforce dependency rules (similar to syncpack)
  - 🌕 support private npm repositories
  - 🌕 hoisting
  - 🌕 hoisting: configurable
  - 🌕 bootstrap speed: 9s
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

lerna 7.x was designed to extend yarn workspaces, but can be configured to support yarn v1 via an unmaintained plugin.

- Dependency Management
  - 🌕 Cross-reference: can depend on other workspaces
  - 🌗 yarn.lock v1 compat - caveat: hoisting must be disabled
  - 🌑 {root}/package.json::override support
  - 🌕 {package}/package.json::override support
  - 🌑 constraints: enforce dependency rules (similar to syncpack)
  - 🌕 support private npm repositories
  - 🌕 hoisting
  - 🌕 hoisting: configurable
  - 🌕 bootstrap speed: 9.3s
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

### rush (pnpm)

Rush seems to basically be the lerna for pnpm, but sadly breaks some features that pnpm provided.

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

- Dependency Management
  - 🤷‍♂️ Cross-reference: can depend on other workspaces
  - 🤷‍♂️ yarn.lock v1 compat
  - 🌑 {root}/package.json::override support
  - 🤷‍♂️ {package}/package.json::override support
  - 🤷‍♂️ constraints: enforce dependency rules (similar to syncpack)
  - 🌕 support private npm repositories
  - 🌑 hoisting
  - 🌕 hoisting: configurable
  - 🌕 bootstrap speed: ?
- Global scripts
  - 🌑 Install minimal dependencies for workspace + upstream workspaces which depend on it
  - 🌗 Run in multiple workspaces*
  - 🌗 Run in glob workspaces
  - 🌗 Run in git-changed workspaces
  - 🌗 Run in workspace + upstream workspaces which depend on it
  - 🌗 Run in workspace + downstream workspaces which depend on it
  - 🌑 Execute arbitrary terminal commands in multiple workspaces
  - 🌑 Concurrancy
  - 🌕 Observability: Print the package's script command before running (i.e. `react-scripts build`)
  - 🌕 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🌕 Remote caching: strongly supports

* Only the `build` operation is supported

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