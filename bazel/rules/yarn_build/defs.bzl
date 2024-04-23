
def _impl_yarn_build(ctx):
    srcs = ctx.files.srcs
    outs = ctx.outputs.outs

    cmd = """
    
    pkgDir=`dirname {0}`
    out=`pwd`/{1}
    
    cd $pkgDir
    
    # Clean up previous build
    rm -rf package.tgz dist build
    
    # Prepare package.json and yarn.lock for yarn install by adding
    # nested crosslinks and converting them to relative paths
    # 1. remove cls from yarn.lock so yarn fresh installs
	[ -f yarn.lock ] && sed -i '' -n '/@..\\//,/^$/!p' yarn.lock
    # TODO: 2. upsert cls (incl nested) as ../[pkg]/package.tgz to package.json
    cp package.json package.json.bak
	
    # Install and build
    echo "yarn install $pkgDir"
    yarn --mutex file install
    echo "yarn build $pkgDir"
    yarn build
    
    # Prepare package for packing and pack
    # Remove all crosslinks from package.json
    bun -e "
        fs = require('fs')
        js = JSON.parse(fs.readFileSync('package.json'), 'utf8')
        rm = (deps = {{}}) => 
            Object.entries(deps).filter(([d,v]) =>
                v.startsWith('../')).forEach(([d,v]) => delete deps[d])
        rm(js.dependencies); rm(js.devDependencies); rm(js.peerDependencies)
        fs.writeFileSync('package.json', JSON.stringify(js, null, 2), 'utf8')
    "
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
        # TODO: How to let packages get node_modules back?
        outputs = outs,
        inputs = srcs,
        command = 
            cmd
        ,
    )
    
    return [DefaultInfo(files = depset(outs))]


_yarn_build = rule(
    implementation = _impl_yarn_build,
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

def yarn_build(
    name,
    srcs=[],
    outs=[],
    cmd="",
    **kwargs
    ):
    # prepend package.json and yarn.lock to srcs
    srcs = [src for src in srcs if src != "package.json" and src != "yarn.lock"]
    srcs = ["package.json", "yarn.lock"] + srcs
    outs = [out for out in outs if out != "package.tgz"]
    outs = ["package.tgz"] + outs
    _yarn_build(
        name = name,
        srcs = srcs,
        outs = outs,
        cmd = cmd,
        **kwargs
    )

