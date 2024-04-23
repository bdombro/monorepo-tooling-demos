# my_rules/defs.bzl
def _concatenate_impl(ctx):
    input1 = ctx.file._input1.path
    input2 = ctx.file._input2.path
    output = ctx.outputs._output.path
    with open(output, "w") as out_file:
        with open(input1, "r") as in_file1:
            out_file.write(in_file1.read())
        with open(input2, "r") as in_file2:
            out_file.write(in_file2.read())
