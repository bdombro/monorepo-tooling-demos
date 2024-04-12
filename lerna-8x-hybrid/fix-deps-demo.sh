#!/bin/zsh

NODELAY=$1 # set to 1 to disable delays

sleepnd() {
  # [[ -z $NODELAY ]] && return;
  sleep $1;
}
echo-slowN() {
  local delay=$1
  local input=$2
  
  for (( i = 1; i <= ${#input}; i++ )); do
      echo -n "${input[$i]}"
      sleepnd $delay
  done
  sleepnd 1
  echo
}
echo-slow1() { echo-slowN 0.01 "$*"; }
echo-slow2() { echo-slowN 0.02 "$*"; }
echo-slow3() { echo-slowN 0.03 "$*"; }
echo-run-nopause() { echo "> $*"; eval "$*"; echo; }
echo-run() { echo "> $*"; sleepnd 1; eval "$*"; echo; }

echo
sleepnd 1
echo-slow2 DEMO!
sleepnd 2
echo-slow2 "# This demo shows how fex-deps.mjs fixes cross-linked deps when focusing on ./packages/lib3 in a workspace named \"@app\""
echo
sleepnd 2

echo-slow2 "# first, reset the workspace:"
sleepnd 1
echo-run rm -rf packages/lib3/node_modules/@app
echo-run-nopause yarn lerna bootstrap
sleepnd 1

echo-slow2 "# show that lib3 depends on lib2:"
sleepnd 1
echo-run grep -B 1 '\"@app/lib2\"' packages/lib3/package.json
sleepnd 2

echo-slow2 "# show that lib2 depends on lib:"
sleepnd 1
echo-run grep -B 1 '\"@app/lib\"' packages/lib2/package.json
sleepnd 2

echo-slow2 "# show that lib has lodash as a devDependency:"
sleepnd 1
echo-run grep -B 2 lodash packages/lib/package.json
sleepnd 2

echo-slow2 "# show that lib3 has a symlink to lib2:"
sleepnd 2
echo-run ls -la packages/lib3/node_modules/@app
sleepnd 2
echo-slow2 "# show that lib2 has a symlink to lib:"
sleepnd 2
echo-run ls -la packages/lib3/node_modules/@app/lib2/node_modules/@app
sleepnd 2

echo-slow2 "# also, lib has lodash, which is a devDependency (bad):"
sleepnd 1
echo-run ls packages/lib3/node_modules/@app/lib2/node_modules/@app/lib/node_modules
sleepnd 3

echo-slow2 "# also, for posterity, show all the places lodash is installed from the root of the workspace:"
sleepnd 1
echo-run find -L . -name lodash
sleepnd 3

echo-slow2 "# calling fex-deps.mjs installs cross-linked libs as if they were external:"
sleepnd 1
echo-run node fix-deps.mjs packages/lib3
sleepnd 2

echo-slow2 "# show that lib1 and lib2 are now installed like ext deps in lib3:"
sleepnd 2
echo-run ls -la packages/lib3/node_modules/@app
sleepnd 2

echo-slow2 "# and confirming no more lodash:"
sleepnd 1
echo-run find -L packages/lib3/node_modules -name lodash
sleepnd 2
echo-slow2 "# done!"
echo

echo-slow2 "# finally, confirm that lib3 can build without errors:"
sleepnd 1
echo-run cd packages/lib3; yarn build; cd -
sleepnd 2
echo-slow2 "# done!"
echo
