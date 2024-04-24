set -e

# Builds a package for bazel by:
# 1. Preparing package.json and yarn.lock for yarn install
# 2. Running yarn install
# 3. Running yarn build
# 4. Preparing package.json for yarn pack
# 5. Running yarn pack
# 8. Bundling the package
# 9. Copying the output to the output directory
#
# usage:
# bash .bazel/util/yarn_rules/build.sh `pwd` packages/lib1 /tmp/bundle.tgz
#


# Abs path to current workspace root. Rel paths are resolved from here
wsDir=$1
# Rel path to the target package directory
pkgDir=$2
# Abs path to the output tgz file. In mode=ci, this will be in a tmp dir
# Bazel assumes the task is a success if the tgz file is present at the end
tgzOut=$3
# Rel path to the preinstall script
preinstallTs=.bazel/util/yarn_rules/preinstall.ts
# Rel path to the prepack script
prepackTs=.bazel/util/yarn_rules/prepack.ts

echo build.sh at `date`

cd $wsDir/$pkgDir

# Clean up previous build
rm -rf bundle.tgz package.tgz dist build

# Prepare package.json and yarn.lock for yarn install by adding
# nested crosslinks and converting them to relative paths
# 1. remove cls from yarn.lock so yarn fresh installs
[ -f yarn.lock ] && sed -i '' -n '/@..\//,/^$/!p' yarn.lock
# 2. upsert cls (incl nested) as ../[pkg]/package.tgz to package.json
cp package.json package.json.bak
bun $wsDir/$preinstallTs

# Install and build
echo "yarn install $pkgDir"
yarn install --mutex file
echo "yarn build $pkgDir"
yarn build

# Prepare package for packing and pack
# Remove all crosslinks from package.json
bun $wsDir/$prepackTs
yarn pack -f package.tgz

# Bundle it up
bundle=package.tgz
[ -d "dist" ] && bundle="$bundle dist"
[ -d "build" ] && bundle="$bundle build"
tar -zcf bundle.tgz $bundle

# clear yarn cache for this package
export pkgName=`jq -r '.name' package.json | tr -d '\n'`
# TODO: rimrafing the cache may be faster than calling yarn clean {pkg}. Would need to test though.
yarn cache clean $pkgName
find `yarn cache dir`/.tmp -name package.json -exec grep -sl $pkgName {{}} \; \
  | xargs dirname | xargs rm -rf

# cleanup
sed -i '' -n '/@..\//,/^$/!p' yarn.lock
mv package.json.bak package.json

# Copy the output to the output directory
cp bundle.tgz $tgzOut

echo "build.sh done"