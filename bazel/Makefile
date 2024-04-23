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
	bazel build --explain=build.log --verbose_failures //packages/react-app:build

clean:
	rm -rf bazel-*
	rm -rf $(PKGS_DIR)/*/node_modules
	#rm -rf $(PKGS_DIR)/*/node_modules/@app
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

%:
	bazel build --explain=build.log --verbose_failures //packages/$@:build