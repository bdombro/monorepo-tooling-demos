.DEFAULT_GOAL := usage
usage:
	@echo "Usage: make <target>"
	@echo "Targets:"
	@echo "  all: Build all pkgs"
	@echo "  clean: Remove generated output"
	@echo "  <pkg>: Build a specific pkg"

PKGS_DIR := packages

all:
	bazel build --explain=build.log //packages/react-app:yarn_build

clean:
	sudo rm -rf /private/var/tmp/_bazel_brian.dombrowski
	sudo mkdir /var/tmp/_bazel_brian.dombrowski
	sudo chown -R `whoami`:staff /var/tmp/_bazel_brian.dombrowski
	cp .tool-versions /private/var/tmp/_bazel_brian.dombrowski/
	bazel clean --expunge
	rm -rf bazel-*
	rm -rf $(PKGS_DIR)/*/node_modules
	#rm -rf $(PKGS_DIR)/*/node_modules/@app
	rm -rf $(PKGS_DIR)/*/dist
	rm -rf $(PKGS_DIR)/*/build
	rm -rf $(PKGS_DIR)/*/package.tgz

%:
	bazel build --explain=build.log //packages/$@:yarn_build