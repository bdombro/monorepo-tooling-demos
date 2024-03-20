#!/bin/zsh

echo-slowN() {
  local delay=$1
  local input=$2
  
  for (( i = 1; i <= ${#input}; i++ )); do
      echo -n "${input[$i]}"
      sleep $delay
  done
  sleep 1
  echo
}
echo-slow1() { echo-slowN 0.01 "$*"; }
echo-slow2() { echo-slowN 0.02 "$*"; }
echo-slow3() { echo-slowN 0.03 "$*"; }
echo-run-nopause() { echo "> $*"; eval "$*"; echo; }
echo-run() { echo "> $*"; sleep 1; eval "$*"; echo; }

echo
sleep 1
echo-slow2 DEMO!
sleep 2
echo-slow2 "# This demo shows how rmNestedDevDependencies.mjs removes nested devDependencies when focusing on ./packages/lib2 in a workspace named \"@mydomain\""
echo
sleep 2

echo-slow2 "# show that lib2 depends on lib:"
sleep 1
echo-run grep -B 1 '\"@mydomain/lib\"' packages/lib2/package.json
sleep 2

echo-slow2 "# show that lib has typescript as a devDependency:"
sleep 1
echo-run grep -B 2 typescript packages/lib/package.json
sleep 2

echo-slow2 "# running lerna bootstrap to install dependencies and devDependencies and symlinks the local packages:"
sleep 1
echo-run-nopause yarn lerna bootstrap
sleep 1
echo-slow2 "# show that lib2 has a symlink to lib:"
sleep 2
echo-run ls -la packages/lib2/node_modules/@mydomain
sleep 2

echo-slow2 "# also, lib2 now has 2 copies of typescript when it ideally wouldn't:"
sleep 1
echo-run find -L packages/lib2/node_modules -name tsc
sleep 3

echo-slow2 "# also, for posterity, show all the places tsc is installed from the root of the workspace:"
sleep 1
echo-run find -L . -name tsc
sleep 3

echo-slow2 "# calling rmNestedDevDependencies.mjs removes nested devDependencies:"
sleep 1
echo-run node rmNestedDevDependencies.mjs packages/lib2
sleep 2

echo-slow2 "# confirming they're removed:"
sleep 1
echo-run find -L packages/lib2/node_modules -name tsc
sleep 2
echo-slow2 "# done!"
echo