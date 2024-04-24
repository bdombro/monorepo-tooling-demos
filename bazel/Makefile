.DEFAULT_GOAL := usage
usage:
	@echo "Usage: make <target>"
	@echo "Targets:"
	@echo "  all: Build all pkgs"
	@echo "  clean: Remove generated output in packages/*/[pkg]"
	@echo "  clean-hard: Everything we've touched
	@echo "  <pkg>: Build a specific pkg"

PKGS_DIR := packages

all:
	@make install
	bazel build //packages/react-app:build --explain=build.log --verbose_failures

install:
	@if [ ! -n "$$(command -v yarn)" ]; then echo "yarn not ready"; exit 1; fi;
	@if [ ! -n "$$(command -v bazel)" ]; then echo "bazel not ready"; exit 1; fi;
	@if [ ! -n "$$(command -v git)" ]; then echo "git not ready"; exit 1; fi;
	@if [ ! -n "$$(command -v jq)" ]; then echo "jq not ready"; exit 1; fi;
	@if [ ! -d ~/.bun ]; then echo "installing bun"; curl -fsSL https://bun.sh/install | bash; fi;
	@if [ ! -n "$$(command -v bun)" ]; then export PATH="$$HOME/.bun/bin:$$PATH"; fi;
	@# linking for bazel worker to be able to find this ws dir
	@if [ ! -f ~/bazel ]; then rm -f ~/bazel; fi
	@ln -s $(PWD) ~/bazel

clean:
	rm -rf .bazel
	rm -rf bazel-*
	@# rm -rf $(PKGS_DIR)/*/node_modules
	rm -rf $(PKGS_DIR)/*/node_modules/@app
	rm -rf $(PKGS_DIR)/*/dist
	rm -rf $(PKGS_DIR)/*/build
	rm -rf $(PKGS_DIR)/*/package.tgz

clean-hard:
	sudo rm -rf /private/var/tmp/_bazel_`whoami`
	sudo mkdir /var/tmp/_bazel_`whoami`
	sudo chown -R `whoami`:staff /var/tmp/_bazel_`whoami`
	cp .tool-versions /private/var/tmp/_bazel_`whoami`/
	bazel clean --expunge
	make clean

openBuilds:
	code $(PKGS_DIR)/*/BUILD.bazel


%:
	@make install
	bazel build //packages/$@:build