path = `${process.argv[2]}/package.json`;
fs = require("fs");
js = JSON.parse(fs.readFileSync(path), "utf8");
rm = (deps = {}) =>
  Object.entries(deps)
    .filter(([d, v]) => v.startsWith("../"))
    .forEach(([d, v]) => delete deps[d]);
rm(js.dependencies);
rm(js.devDependencies);
rm(js.peerDependencies);
fs.writeFileSync(path, JSON.stringify(js, null, 2), "utf8");
