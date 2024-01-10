_turbo() {
    local i cur prev opts cmd
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    cmd=""
    opts=""

    for i in ${COMP_WORDS[@]}
    do
        case "${cmd},${i}" in
            ",$1")
                cmd="turbo"
                ;;
            turbo,bin)
                cmd="turbo__bin"
                ;;
            turbo,completion)
                cmd="turbo__completion"
                ;;
            turbo,daemon)
                cmd="turbo__daemon"
                ;;
            turbo,generate)
                cmd="turbo__generate"
                ;;
            turbo,info)
                cmd="turbo__info"
                ;;
            turbo,link)
                cmd="turbo__link"
                ;;
            turbo,login)
                cmd="turbo__login"
                ;;
            turbo,logout)
                cmd="turbo__logout"
                ;;
            turbo,prune)
                cmd="turbo__prune"
                ;;
            turbo,run)
                cmd="turbo__run"
                ;;
            turbo,telemetry)
                cmd="turbo__telemetry"
                ;;
            turbo,unlink)
                cmd="turbo__unlink"
                ;;
            turbo__daemon,clean)
                cmd="turbo__daemon__clean"
                ;;
            turbo__daemon,restart)
                cmd="turbo__daemon__restart"
                ;;
            turbo__daemon,start)
                cmd="turbo__daemon__start"
                ;;
            turbo__daemon,status)
                cmd="turbo__daemon__status"
                ;;
            turbo__daemon,stop)
                cmd="turbo__daemon__stop"
                ;;
            turbo__generate,run)
                cmd="turbo__generate__run"
                ;;
            turbo__generate,workspace)
                cmd="turbo__generate__workspace"
                ;;
            turbo__telemetry,disable)
                cmd="turbo__telemetry__disable"
                ;;
            turbo__telemetry,enable)
                cmd="turbo__telemetry__enable"
                ;;
            turbo__telemetry,status)
                cmd="turbo__telemetry__status"
                ;;
            *)
                ;;
        esac
    done

    case "${cmd}" in
        turbo)
            opts="-v -F -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --cache-dir --cache-workers --concurrency --continue --dry-run --go-fallback --single-package --filter --force --framework-inference --global-deps --graph --env-mode --ignore --include-dependencies --no-cache --[no-]daemon --no-daemon --no-deps --output-logs --log-order --only --parallel --pkg-inference-root --profile --anon-profile --remote-only --remote-cache-read-only --scope --since --summarize --log-prefix --experimental-space-id --help [TASKS]... [PASS_THROUGH_ARGS]... bin completion daemon generate telemetry info link login logout prune run unlink"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 1 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cache-dir)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cache-workers)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --concurrency)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --dry-run)
                    COMPREPLY=($(compgen -W "text json" -- "${cur}"))
                    return 0
                    ;;
                --filter)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -F)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --force)
                    COMPREPLY=($(compgen -W "true false" -- "${cur}"))
                    return 0
                    ;;
                --framework-inference)
                    COMPREPLY=($(compgen -W "true false" -- "${cur}"))
                    return 0
                    ;;
                --global-deps)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --graph)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --env-mode)
                    COMPREPLY=($(compgen -W "infer loose strict" -- "${cur}"))
                    return 0
                    ;;
                --ignore)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --output-logs)
                    COMPREPLY=($(compgen -W "full none hash-only new-only errors-only" -- "${cur}"))
                    return 0
                    ;;
                --log-order)
                    COMPREPLY=($(compgen -W "auto stream grouped" -- "${cur}"))
                    return 0
                    ;;
                --pkg-inference-root)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --profile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --anon-profile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-only)
                    COMPREPLY=($(compgen -W "true false" -- "${cur}"))
                    return 0
                    ;;
                --remote-cache-read-only)
                    COMPREPLY=($(compgen -W "true false" -- "${cur}"))
                    return 0
                    ;;
                --scope)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --since)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --summarize)
                    COMPREPLY=($(compgen -W "true false" -- "${cur}"))
                    return 0
                    ;;
                --log-prefix)
                    COMPREPLY=($(compgen -W "auto none task" -- "${cur}"))
                    return 0
                    ;;
                --experimental-space-id)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__bin)
            opts="-v -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__completion)
            opts="-v -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help bash elvish fish powershell zsh"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__daemon)
            opts="-v -h --idle-time --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help restart start status stop clean"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --idle-time)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__daemon__clean)
            opts="-v -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__daemon__restart)
            opts="-v -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__daemon__start)
            opts="-v -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__daemon__status)
            opts="-v -h --json --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__daemon__stop)
            opts="-v -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__generate)
            opts="-c -r -a -v -h --tag --config --root --args --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help [GENERATOR_NAME] workspace run"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --tag)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --config)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -c)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --root)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -r)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --args)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -a)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__generate__run)
            opts="-c -r -a -v -h --config --root --args --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help [GENERATOR_NAME]"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --config)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -c)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --root)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -r)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --args)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -a)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__generate__workspace)
            opts="-n -b -c -d -t -r -p -v -h --name --empty --copy --destination --type --root --example-path --show-all-dependencies --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --name)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -n)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --copy)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -c)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --destination)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -d)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --type)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -t)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --root)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -r)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --example-path)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -p)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__info)
            opts="-v -h --json --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help [WORKSPACE]"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__link)
            opts="-v -h --no-gitignore --target --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --target)
                    COMPREPLY=($(compgen -W "remote-cache spaces" -- "${cur}"))
                    return 0
                    ;;
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__login)
            opts="-v -h --sso-team --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --sso-team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__logout)
            opts="-v -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__prune)
            opts="-v -h --scope --docker --out-dir --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help [SCOPE]..."
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --scope)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --out-dir)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__run)
            opts="-F -v -h --cache-dir --cache-workers --concurrency --continue --dry-run --go-fallback --single-package --filter --force --framework-inference --global-deps --graph --env-mode --ignore --include-dependencies --no-cache --[no-]daemon --no-daemon --no-deps --output-logs --log-order --only --parallel --pkg-inference-root --profile --anon-profile --remote-only --remote-cache-read-only --scope --since --summarize --log-prefix --experimental-space-id --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help [TASKS]... [PASS_THROUGH_ARGS]..."
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --cache-dir)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cache-workers)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --concurrency)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --dry-run)
                    COMPREPLY=($(compgen -W "text json" -- "${cur}"))
                    return 0
                    ;;
                --filter)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                -F)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --force)
                    COMPREPLY=($(compgen -W "true false" -- "${cur}"))
                    return 0
                    ;;
                --framework-inference)
                    COMPREPLY=($(compgen -W "true false" -- "${cur}"))
                    return 0
                    ;;
                --global-deps)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --graph)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --env-mode)
                    COMPREPLY=($(compgen -W "infer loose strict" -- "${cur}"))
                    return 0
                    ;;
                --ignore)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --output-logs)
                    COMPREPLY=($(compgen -W "full none hash-only new-only errors-only" -- "${cur}"))
                    return 0
                    ;;
                --log-order)
                    COMPREPLY=($(compgen -W "auto stream grouped" -- "${cur}"))
                    return 0
                    ;;
                --pkg-inference-root)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --profile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --anon-profile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-only)
                    COMPREPLY=($(compgen -W "true false" -- "${cur}"))
                    return 0
                    ;;
                --remote-cache-read-only)
                    COMPREPLY=($(compgen -W "true false" -- "${cur}"))
                    return 0
                    ;;
                --scope)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --since)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --summarize)
                    COMPREPLY=($(compgen -W "true false" -- "${cur}"))
                    return 0
                    ;;
                --log-prefix)
                    COMPREPLY=($(compgen -W "auto none task" -- "${cur}"))
                    return 0
                    ;;
                --experimental-space-id)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__telemetry)
            opts="-v -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help enable disable status"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__telemetry__disable)
            opts="-v -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__telemetry__enable)
            opts="-v -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__telemetry__status)
            opts="-v -h --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        turbo__unlink)
            opts="-v -h --target --version --skip-infer --no-update-notifier --api --color --cpuprofile --cwd --heap --login --no-color --preflight --remote-cache-timeout --team --token --trace --verbosity --check-for-update --__test-run --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --target)
                    COMPREPLY=($(compgen -W "remote-cache spaces" -- "${cur}"))
                    return 0
                    ;;
                --api)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cpuprofile)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --heap)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --login)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --remote-cache-timeout)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --team)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --token)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --trace)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --verbosity)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
    esac
}

complete -F _turbo -o nosort -o bashdefault -o default turbo
