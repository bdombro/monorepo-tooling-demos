
def _impl_build(ctx):
    srcs = ctx.files.srcs
    outs = ctx.outputs.outs

    cmd = """
    set -e

    pkgJsonSrcPathRel={0}
    tgzOutAbsRel={1}

    localWsDirSymLink=~/bazel
    if [ -L $localWsDirSymLink ]; then
        echo "mode:dev"
        mode=dev
        wsDir=~/bazel # if set, is development mode and choose the local workspace over tmp
        export PATH=~/.bun/bin:$PATH
    else
        echo "mode:ci"
        mode=ci
        wsDir=`pwd`
    fi

    pkgDir=`dirname $pkgJsonSrcPathRel`
    pkgsDir=`dirname $pkgDir`
    yarnRulesDir=.bazel/util/yarn_rules
    buildSh=$yarnRulesDir/build.sh
    preinstallTs=$yarnRulesDir/preinstall.ts
    prepackTs=$yarnRulesDir/prepack.ts
    tgzOut=`pwd`/$tgzOutAbsRel

    bash $buildSh $wsDir $pkgDir $tgzOut $preinstallTs $prepackTs
    
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
        "//.bazel/util/yarn_rules:build.sh", "//.bazel/util/yarn_rules:preinstall.ts", "//.bazel/util/yarn_rules:prepack.ts",
    ] + srcs
    outs = [out for out in outs if out != "bundle.tgz"]
    outs = ["bundle.tgz"] + outs
    _build(
        name = name,
        srcs = srcs,
        outs = outs,
        cmd = cmd,
        **kwargs
    )

