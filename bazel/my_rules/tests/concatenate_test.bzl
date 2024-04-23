# my_rules/tests/concatenate_test.bzl
load("@bazel_skylib//rules:file_test.bzl", "file_test")
load("//my_rules:defs.bzl", "concatenate")

file_test(
    name = "concatenate_test",
    content = "",
    steps = [
        # Create input files
        ("echo 'Hello, ' > $(location input1)", []),
        ("echo 'world!' > $(location input2)", []),
        # Run the rule
        ("""
        $(BAZEL) build :concatenated_file
        """, [
            ("cat $(location concatenated_file)", "Hello, world!\n"),
        ]),
    ],
)
