# yarn workspaces

This folder is a demonstration of yarn workspaces.

- Dependency Management
  - 🟢 Cross-reference resolutions
  - ⭕️ package.json::resolutions support
- Global scripts
  - 🟢 Run in all packages
  - 🟢 Run in glob packages
  - 🟢 Run in git-changed packages
  - 🟢 Concurrancy
  - 🟢 Concurrancy with limits
  - ⭕️ Concurrancy with buffered outputs (non-interlacing)
  - ⭕️ Observability: Print the package's script command before frunning (i.e. `react-scripts build`)
  - ⭕️ Build minimum producers for a package
  - ⭕️ Build minimum consumers for a package
- Performance
  - 🟢 Shared dependencies
  