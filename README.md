

## Comparisons

Legend: 🟢 is supported; ⭕️ is not supported

### npm workspaces

- Dependency Management
  - 🟢 Cross-reference: can depend on other workspaces
  - ⭕️ yarn.lock v1 compat
  - 🟢 {root}/package.json::override support
  - ⭕️ {package}/package.json::override support
  - ⭕️ constraints: enforce dependency rules (similar to syncpack)
  - ⭕️ support private npm repositories
  - 🟢 hoisting
  - ⭕️ hoisting: configurable
  - 🟢 bootstrap speed: 9s
- Global scripts
  - 🟢 Run in multiple workspaces
  - ⭕️ Run in glob workspaces
  - ⭕️ Run in git-changed workspaces
  - ⭕️ Run in workspace + upstream workspaces which depend on it
  - ⭕️ Run in workspace + downstream workspaces which depend on it
  - ⭕️ Execute arbitrary terminal commands in multiple workspaces
  - ⭕️ Concurrancy
  - 🟢 Observability: Print the package's script command before running (i.e. `react-scripts build`)
  - ⭕️ Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - ⭕️ Remote caching: strongly supports


### yarn workspaces

- Dependency Management
  - 🟢 Cross-reference: can depend on other workspaces
  - ⭕️ yarn.lock v1 compat
  - 🟢 {root}/package.json::override support
  - ⭕️ {package}/package.json::override support
  - 🟢 constraints: enforce dependency rules (similar to syncpack)
  - 🟢 support private npm repositories
  - 🟢 hoisting
  - 🟢 hoisting: configurable
  - 🟢 bootstrap speed: 6.5s
- Global scripts
  - 🟢 Run in multiple workspaces
  - 🟢 Run in glob workspaces
  - 🟢 Run in git-changed workspaces
  - 🟢 Run in workspace + upstream workspaces which depend on it
  - ⭕️ Run in workspace + downstream workspaces which depend on it
  - 🟢 Execute arbitrary terminal commands in multiple workspaces
  - 🟢 Concurrancy
  - ⭕️ Observability: Print the package's script command before running (i.e. `react-scripts build`)
  - ⭕️ Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - ⭕️ Remote caching: strongly supports


### lerna 2.x w/ yarn 1.22

- Dependency Management
  - 🟢 Cross-reference: can depend on other workspaces
  - 🟠 yarn.lock v1 compat - caveat: hoisting must be disabled
  - ⭕️ {root}/package.json::override support
  - 🟢 {package}/package.json::override support
  - ⭕️ constraints: enforce dependency rules (similar to syncpack)
  - 🟢 support private npm repositories
  - 🟢 hoisting
  - 🟢 hoisting: configurable
  - 🟢 bootstrap speed: 8.2s
- Global scripts
  - 🟢 Run in multiple workspaces
  - 🟢 Run in glob workspaces
  - 🟢 Run in git-changed workspaces
  - 🟢 Run in workspace + upstream workspaces which are dependencies
  - 🟢 Run in workspace + downstream workspaces which depend on it
  - 🟢 Execute arbitrary terminal commands in multiple workspaces
  - 🟢 Concurrancy
  - 🟢 Observability: Print the workspace's script command before running (i.e. `react-scripts build`)
  - ⭕️ Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - ⭕️ Remote caching: strongly supports

### lerna 7.x

- Dependency Management
  - 🟢 Cross-reference: can depend on other workspaces
  - ⭕️ yarn.lock v1 compat
  - 🟢 {root}/package.json::override support
  - ⭕️ {package}/package.json::override support
  - 🟢 constraints: enforce dependency rules (similar to syncpack)
  - 🟢 support private npm repositories
  - 🟢 hoisting
  - 🟢 hoisting: configurable
  - 🟢 bootstrap speed: 9s
- Global scripts
  - 🟢 Run in multiple workspaces
  - 🟢 Run in glob workspaces
  - 🟢 Run in git-changed workspaces
  - 🟢 Run in workspace + upstream workspaces which are dependencies
  - 🟢 Run in workspace + downstream workspaces which depend on it
  - 🟢 Execute arbitrary terminal commands in multiple workspaces
  - 🟢 Concurrancy
  - 🟢 Observability: Print the workspace's script command before running (i.e. `react-scripts build`)
  - 🟢 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🟢 Remote caching: strongly supports

### lerna 7.x w/ yarn 1.22 & legacy mode

- Dependency Management
  - 🟢 Cross-reference: can depend on other workspaces
  - 🟠 yarn.lock v1 compat - caveat: hoisting must be disabled
  - ⭕️ {root}/package.json::override support
  - 🟢 {package}/package.json::override support
  - ⭕️ constraints: enforce dependency rules (similar to syncpack)
  - 🟢 support private npm repositories
  - 🟢 hoisting
  - 🟢 hoisting: configurable
  - 🟢 bootstrap speed: 9.3s
- Global scripts
  - 🟢 Run in multiple workspaces
  - 🟢 Run in glob workspaces
  - 🟢 Run in git-changed workspaces
  - 🟢 Run in workspace + upstream workspaces which are dependencies
  - 🟢 Run in workspace + downstream workspaces which depend on it
  - 🟢 Execute arbitrary terminal commands in multiple workspaces
  - 🟢 Concurrancy
  - 🟢 Observability: Print the workspace's script command before running (i.e. `react-scripts build`)
  - 🟢 Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🟢 Remote caching: strongly supports

### Template

- Dependency Management
  - 🟢⭕️ Cross-reference: can depend on other workspaces
  - 🟢⭕️ yarn.lock v1 compat
  - 🟢⭕️ {root}/package.json::override support
  - 🟢⭕️ {package}/package.json::override support
  - 🟢⭕️ constraints: enforce dependency rules (similar to syncpack)
  - 🟢⭕️ support private npm repositories
  - 🟢⭕️ hoisting
  - 🟢⭕️ hoisting: configurable
- Global scripts
  - 🟢⭕️ Run in multiple workspaces
  - 🟢⭕️ Run in glob workspaces
  - 🟢⭕️ Run in git-changed workspaces
  - 🟢⭕️ Run in workspace + upstream workspaces which depend on it
  - 🟢⭕️ Run in workspace + downstream workspaces which depend on it
  - 🟢⭕️ Execute arbitrary terminal commands in multiple workspaces
  - 🟢⭕️ Concurrancy
  - 🟢⭕️ Observability: Print the package's script command before running (i.e. `react-scripts build`)
  - 🟢⭕️ Local caching: scripts will skip workspaces that haven't changed and upstream also hasn't changed
  - 🟢⭕️ Remote caching: strongly supports