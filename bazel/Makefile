PKGS_DIR := packages
PKGS := $(notdir $(wildcard $(PKGS_DIR)/*))
PKGS_REVERSED := $(shell echo $(PKGS) | tr ' ' '\n' | tac | tr '\n' ' ')

# PARAMETERS
# You can pass parameters to Makefile via ENV var or as an arg like
# `make <target> PARAM=value` 
# 
# NC: set this to 1 to clear cache before building
# CI: set this to 1 to run in CI mode
#  - 1. set wsroot="" : tells bazel build to use the default tmp folder
#       for building instead of the current workspace folder
wsroot := $(shell if [ "$(CI)" = "1" ]; then echo ""; else echo "$(PWD)"; fi)

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
	@echo CLEAN
	@make clean-bazel-cache &\
	make clean-yarn-cache &\
	rm -rf $(PKGS_DIR)/*/node_modules/@app &\
	rm -rf $(PKGS_DIR)/*/dist &\
	rm -rf $(PKGS_DIR)/*/build &\
	rm -rf $(PKGS_DIR)/*/package.json.bak &\
	rm -rf $(PKGS_DIR)/*/package.tgz &
	wait

clean-bazel-cache:
	@echo CLEANING BAZEL CACHE
	@bazel clean --expunge &\
	rm -rf .bazel/bazel-* .bazel/cache &\
	rm -rf /private/var/tmp/_bazel_`whoami`/*; \
	wait

clean-yarn-cache:
	@echo CLEANING YARN CACHE
	@$(foreach PKG,$(PKGS),yarn cache clean @app/$(PKG) &)\
	find `yarn cache dir`/.tmp -name package.json -exec grep -sl\
		$(foreach PKG,$(PKGS), -e @app/$(PKG)) {} \; \
  	| xargs dirname | xargs rm -rf &\
	wait
	
install:
	@#echo CHECKING DEPENDENCIES
	@if [ ! -n "$$(command -v yarn)" ]; then echo "yarn not ready"; exit 1; fi;
	@if [ ! -n "$$(command -v bazel)" ]; then echo "bazel not ready"; exit 1; fi;
	@if [ ! -n "$$(command -v git)" ]; then echo "git not ready"; exit 1; fi;
	@if [ ! -n "$$(command -v jq)" ]; then echo "jq not ready"; exit 1; fi;
	@#echo INSTALL BUN IF NOT
	@if [ ! -d ~/.bun ]; then echo "installing bun"; curl -fsSL https://bun.sh/install | bash; fi;
	@if [ ! -n "$$(command -v bun)" ]; then export PATH="$$HOME/.bun/bin:$$PATH"; fi;
	@# linking for bazel worker to be able to find this ws dir
	@if [ "$(CI)" = "1" ]; then rm -f ~/.bazel-current; \
	else ln -sf $(PWD) ~/.bazel-current; fi
	@#echo "INSTALLING CLI TOOLS: pkg and ws"
	@ln -sf $(PWD)/util/yarn_rules/pkg-cli.ts /usr/local/bin/pkg; fi
	@ln -sf $(PWD)/util/yarn_rules/ws.ts /usr/local/bin/ws; fi
	@#echo "UPDATING CONFIGS"
	@d=/private/var/tmp/_bazel_`whoami` && if [ ! -d $$d ]; then \
		sudo mkdir $$d && sudo chown -R `whoami`:staff $$d; fi;
	@d=/private/var/tmp/_bazel_`whoami` && cp .tool-versions $$d/	;


openBuilds:
	code $(PKGS_DIR)/*/BUILD.bazel

restore-all-build-artifacts:
	@echo "Restoring all build artifacts"
	@$(foreach PKG,$(PKGS),make restore-pkg-from-cache PKG=$(PKG);)
	@echo "Done"

# Restores the build artifacts for a target from the bazel cache to the local folder
restore-pkg-from-cache:
	@if [ -z "$(PKG)" ]; then echo "PKG not set" && exit 1; fi;
	$(eval EXISTS:=$(shell stat .bazel/bazel-bin/$(WD)/package.tgz 2> /dev/null | cut -c1))
	@if [ -z "$(EXISTS)" ]; then echo "No cache found for $(PKG)" && exit 1; fi;

	@#echo "Restoring $(PKG)"
	$(eval WD:=$(PKGS_DIR)/$(PKG))
	@# Clean old artificats
	@rm -rf $(WD)/package.tgz $(WD)/dist $(WD)/build
	@# Restore from cache
	@rsync .bazel/bazel-bin/$(WD)/package.tgz $(WD)/package.tgz

define addPkgRule
$(eval 
$1:
	$(eval WD:=$(PKGS_DIR)/$1)
	@make install
	@if [ "$(NC)" = "1" ];then make clean-bazel-cache; fi
	bazel build //$(WD):build --define=wsroot=$(wsroot)
	@# TODO: Need to restore all dependents too.
	@if [ ! -f "$(WD)/package.tgz" ]; then make restore-pkg-from-cache PKG=$1; fi
)
endef
$(foreach P,$(PKGS),$(call addPkgRule,$P))
