## STatus
working but awkward and fragile bc:

1. Bazel forces sandboxes and remote execution support, but that doesn't work great for JS projects bc the way we crosslink dependencies.
1. I made a workaround to pass pwd to the task as an env var, but it has some mild and annoying side-effects
   1. ex. the env var works on the target but not it's dependencies
      1. Workaround: don't use Bazel's dep management
2. Dependency logic seems very fragile, and prevents building fresh from ws root


## Learnings

- Bazel seems to really push sandboxes and remote execution, for job execution but that doesn't work great for JS projects bc the way we crosslink dependencies
- The JS rules (aka features) are from a 3rd party ([Aspect](https://docs.aspect.build/rulesets/aspect_rules_js/)), and they are a HUGE integration effort bc they do not integrate with existing monorepo patterns at all. For ex, they install node_modules and build artifacts in sandbox folders, which makes it really hard to get IDE features working or inspecting generated files.