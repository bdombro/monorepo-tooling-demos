
def _impl_build(ctx):
    srcs = ctx.files.srcs
    outs = ctx.outputs.outs

    cmd = """
    set -e

    if [ -z $localWsDir ]; then
        mode=dev
        wsDir=~/bazel # if set, is development mode and choose the local workspace over tmp
        export PATH=~/.bun/bin:$PATH
    else
        mode=ci
        wsDir=`pwd`
    fi
    
    pkgDir=$wsDir/`dirname {0}`
    pkgsDir=$wsDir/`dirname $pkgDir`
    rulesDir=$wsDir/rules
    yarnRulesDir=$rulesDir/yarn_rules
    preinstallTs=$yarnRulesDir/preinstall.ts
    prepackTs=$yarnRulesDir/prepack.ts
    
    echo pkgDir: $pkgDir

    out=`pwd`/{1}
    echo out: $out
    
    cd $pkgDir
    
    # Clean up previous build
    rm -rf package.tgz dist build
    
    # Prepare package.json and yarn.lock for yarn install by adding
    # nested crosslinks and converting them to relative paths
    # 1. remove cls from yarn.lock so yarn fresh installs
	[ -f yarn.lock ] && sed -i '' -n '/@..\\//,/^$/!p' yarn.lock
    # 2. upsert cls (incl nested) as ../[pkg]/package.tgz to package.json
    cp package.json package.json.bak
    bun $preinstallTs
	
    # Install and build
    echo "yarn install $pkgDir"
    yarn install --mutex file
    echo "yarn build $pkgDir"
    yarn build
    
    # Prepare package for packing and pack
    # Remove all crosslinks from package.json
    bun $prepackTs
	yarn pack -f package.tgz
	
    # clear yarn cache for this package
    export pkgName=`jq -r '.name' package.json | tr -d '\\n'`
    yarn cache clean $pkgName
    find `yarn cache dir`/.tmp -name package.json -exec grep -l $pkgName {{}} \\; | xargs dirname | xargs rm -rf

    # cleanup
    sed -i '' -n '/@..\\//,/^$/!p' yarn.lock
    mv package.json.bak package.json
    
    # echo fooooo2 > $out
    cp package.tgz $out

    """.format(srcs[0].path, outs[0].path)+ ctx.attr.cmd

    ctx.actions.run_shell(
        use_default_shell_env = True,
        # TODO: How to let packages get node_modules back?
        outputs = outs,
        inputs = srcs,
        command = 
            cmd
        ,
    )
    
    return [DefaultInfo(files = depset(outs))]


_build = rule(
    implementation = _impl_build,
    attrs = {
        "srcs": attr.label_list(allow_files=True, default=[]),
        "outs": attr.output_list(),
        "cmd": attr.string(default=""),
    },
    doc = """
    
    Prepares a package for packing
    Builds a package using yarn and packs it into a tarball.
""",
)

def build(
    name,
    srcs=[],
    outs=[],
    cmd="",
    **kwargs
    ):
    # prepend package.json and yarn.lock to srcs
    srcs = [src for src in srcs if src != "package.json" and src != "yarn.lock"]
    srcs = [
        "package.json", "yarn.lock",
        "//:.tool-versions",
        "//util/yarn_rules:preinstall.ts", "//util/yarn_rules:prepack.ts",
    ] + srcs
    outs = [out for out in outs if out != "package.tgz"]
    outs = ["package.tgz"] + outs
    outs = [out for out in outs if out != "bundle.tgz"]
    outs = ["bundle.tgz"] + outs
    _build(
        name = name,
        srcs = srcs,
        outs = outs,
        cmd = cmd,
        **kwargs
    )

