
def _impl_build(ctx):
    srcs = ctx.files.srcs
    outs = ctx.outputs.outs
    cmdExtra = ctx.attr.cmd
    
    # you can set this var on cmd line via --define wsroot=/path/to/ws
    # If set, it will be used as the workspace root for the build
    wsroot = ctx.var.get("wsroot", "")

    cmd = """
    set -e

    
    export PATH=~/.bun/bin:$PATH

    pkgJsonSrcPathRel={0}
    tgzOutAbsRel={1}
    wsroot={2}

    if [ -n "$wsroot" ]; then
        echo "mode:dev"
        mode=dev
    else
        echo "mode:ci"
        mode=ci
        wsroot=`pwd`
    fi

    pkgDir=`dirname $pkgJsonSrcPathRel`
    pkgsDir=`dirname $pkgDir`
    bzCliDir=util/bz-cli
    pkgTs=$bzCliDir/pkg-cli.ts
    tgzOut=`pwd`/$tgzOutAbsRel

    LOG=5 bun $pkgTs build $wsroot/$pkgDir

    cp $pkgDir/package.tgz $tgzOut
    
    """.format(srcs[0].path, outs[0].path, wsroot)+ cmdExtra

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
        "//util/bz-cli:pkg-cli.ts",
    ] + srcs
    outs = [out for out in outs if out != "package.tgz"]
    outs = ["package.tgz"] + outs
    _build(
        name = name,
        srcs = srcs,
        outs = outs,
        cmd = cmd,
        **kwargs
    )

