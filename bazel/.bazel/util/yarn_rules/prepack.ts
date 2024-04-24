/**
 * Remove crosslinks from package.json's dependencies
 */
import fs from "fs";
const js = JSON.parse(fs.readFileSync("package.json", "utf8"));
const rm = (deps: Record<string, string> = {}) =>
  Object.entries(deps)
    .filter(([d, v]) => v.startsWith("../"))
    .forEach(([d, v]) => delete deps[d]);
rm(js.dependencies);
rm(js.devDependencies);
rm(js.peerDependencies);
fs.writeFileSync("package.json", JSON.stringify(js, null, 2), "utf8");
