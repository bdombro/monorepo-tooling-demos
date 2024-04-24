PKGS_DIR := packages
PKGS := $(notdir $(wildcard $(PKGS_DIR)/*))
PKGS_REVERSED := $(shell echo $(PKGS) | tr ' ' '\n' | tac | tr '\n' ' ')

.DEFAULT_GOAL := usage
usage:
	@echo "Usage: make <target>"
	@echo "Targets:"
	@echo "  all: Build all PKGS"
	@echo "  clean: Remove generated output in packages/*/[pkg]"
	@echo "  clean-hard: Everything we've touched
	@echo "  <pkg>: Build a specific pkg"
	@echo "   --> $(PKGS)"

all:
	@echo "Building all"
	$(foreach PKG,$(PKGS_REVERSED),make $(PKG);)

clean:
	rm -rf .bazel/bazel-* .bazel/cache &\
	rm -rf $(PKGS_DIR)/*/node_modules &\
	rm -rf $(PKGS_DIR)/*/dist &\
	rm -rf $(PKGS_DIR)/*/build &\
	rm -rf $(PKGS_DIR)/*/package.json.bak &\
	rm -rf $(PKGS_DIR)/*/package.tgz &\
	rm -rf $(PKGS_DIR)/*/bundle.tgz &\
	$(foreach PKG,$(PKGS),yarn cache clean @app/$(PKG) &)\
	find `yarn cache dir`/.tmp -name package.json -exec grep -sl\
		$(foreach PKG,$(PKGS), -e @app/$(PKG)) {} \; \
  	| xargs dirname | xargs rm -rf &\
	wait

clean-hard:
	sudo rm -rf /private/var/tmp/_bazel_`whoami`
	sudo mkdir /var/tmp/_bazel_`whoami` &\
	sudo chown -R `whoami`:staff /var/tmp/_bazel_`whoami` &\
	cp .tool-versions /private/var/tmp/_bazel_`whoami`/ &\
	bazel clean --expunge &\
	make clean &\
	wait
	
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

openBuilds:
	code $(PKGS_DIR)/*/BUILD.bazel

restore-all-build-artifacts:
	@echo "Restoring all build artifacts"
	@$(foreach PKG,$(PKGS),make restore-pkg-from-cache PKG=$(PKG);)
	@echo "Done"

# Restores the build artifacts for a target from the bazel cache to the local folder
restore-pkg-from-cache:
	@if [ -z "$(PKG)" ]; then echo "PKG not set" && exit 1; fi;
	$(eval EXISTS:=$(shell stat .bazel/bazel-bin/$(WD)/bundle.tgz 2> /dev/null | cut -c1))
	@if [ -z "$(EXISTS)" ]; then echo "No cache found for $(PKG)" && exit 1; fi;

	@#echo "Restoring $(PKG)"
	$(eval WD:=$(PKGS_DIR)/$(PKG))
	@# Clean old artificats
	@rm -rf $(WD)/package.tgz $(WD)/dist $(WD)/build
	@# Restore from cache
	@rsync .bazel/bazel-bin/$(WD)/bundle.tgz $(WD)/bundle.tgz
	@tar -xzf $(WD)/bundle.tgz -C $(WD)

test:
	@echo "Testing"
	@if [ ! -n "$$(command -v bazel)" ]; then $(eval FOO=BAR) printf ''; fi;
	@echo $(FOO)

define addPkgRule
$(eval 
$1:
	$(eval WD:=$(PKGS_DIR)/$1)
	@make install
	bazel build //$(WD):build
	rm -rf $(WD)/bundle.tgz
	@# TODO: Need to restore all dependents too.
	@if [ ! -f "$(WD)/bundle.tgz" ]; then make restore-pkg-from-cache PKG=$1; fi
)
endef
$(foreach P,$(PKGS),$(call addPkgRule,$P))
