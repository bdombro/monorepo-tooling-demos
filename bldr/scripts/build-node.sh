
build_tsc() {
  bun ./node_modules/.bin/tsc
}
prebuild_cp_src() {
  cp -r src src.bak
}
postbuild_restore_src() {
  rm -rf src
  mv src.bak src
}
# typescript disallows private properties in classes when declaration=true, so we just remove them when building.
prebuild_rm_privates() {
  find ./src -type f -name "*.ts" -exec sed -i '' 's/private //g' {} \;
}
# we don't leave this enabled all the time bc makes typescript strict on private properties
prebuild_enable_declaration() {
  sed -i '' 's/\/\/ "declaration": true/"declaration": true/g' tsconfig.json
}
build() {
  prebuild_cp_src
  prebuild_rm_privates
  build_tsc
  postbuild_restore_src
}

build

