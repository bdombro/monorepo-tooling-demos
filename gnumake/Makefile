PKG_DIR := packages
YARN_CACHE_DIR := ~/Library/Caches/Yarn/v6

# Define source directories
SOURCE_DIRS := $(wildcard $(PKG_DIR)/*/src)

# Define output directories corresponding to source directories
OUTPUT_DIRS := $(patsubst %/src,%/dist,$(SOURCE_DIRS))

# Define build rule for all output directories
# all: $(OUTPUT_DIRS)

# Rule to build each output directory
$(OUTPUT_DIRS): %/dist:
	@echo "Building $*..."
	cd $(@D) && yarn install
	cd $(@D) && yarn build
	cd $(@D) && yarn pack -f package.tgz &
	cd $(@D) && yarn cache clean $(jq -r '.name' package.json | tr -d '\n')
	@echo "Done building $*"

# Clean rule to remove generated output
clean:
	@rm -rf $(OUTPUT_DIRS) $(patsubst %/src,%/node_modules,$(SOURCE_DIRS)) $(patsubst %/src,%/package.tgz,$(SOURCE_DIRS))

# Define all targets
pkgs := $(patsubst $(PKG_DIR)/%/,%,$(wildcard $(PKG_DIR)/*/))

# Define dependencies between pkgs and their package.json files
$(pkgs): %: $(PKG_DIR)/%/package.json
	@$(MAKE) $(PKG_DIR)/$*/dist

# Define build targets for each pkg
build_pkgs := $(addprefix build_,$(pkgs))
# Define build rule for each pkg
$(build_pkgs): build_%:
	@$(MAKE) $(PKG_DIR)/$*/dist

# Lint rule for each pkg
lint_pkgs := $(addprefix lint_,$(pkgs))
# Define lint rule for each pkg
$(lint_pkgs): lint_%: build_%
	@echo "Linting $*..."
	cd $(PKG_DIR)/$* && yarn lint
	@echo "Linting complete for $*."
# Lint rule
lint: $(lint_pkgs)
	@echo "Linting complete."

.DEFAULT_GOAL := usage
usage:
	@echo "Usage: make -j4 <target>"
	@echo "j4: 4 concurrency when possible"
	@echo "Targets:"
	@echo "  all: Build all pkgs"
	@echo "  clean: Remove generated output"
	@echo "  <pkg>: Build a specific pkg"

# Ensure lib5 depends on lib0, lib1, lib2, and lib3 but can be built in parallel
lib2: lib1
lib3: lib2
lib4: lib1 lib3
lib5: lib0 lib1
react-app: lib4 lib5



