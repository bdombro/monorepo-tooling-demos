.DEFAULT_GOAL := usage
usage:
	@echo "Usage: make -j4 <target>"
	@echo "Targets:"
	@echo "  all: Build all pkgs"
	@echo "  clean: Remove generated output"
	@echo "  <pkg>: Build a specific pkg"

define buildPkg
	@echo "Building $1"
	cd $1 && rm -rf package.tgz dist build
	[ -f $1/yarn.lock ] && sed -i '' -n '/@app\/lib/,/^$$$$/!p' $1/yarn.lock
	@# TODO: add nested crosslinks to package.json
	cd $1 && yarn --mutex file install
	cd $1 && yarn build
	cd $1 && yarn pack -f package.tgz
	export pkgName=`jq -r '.name' $1/package.json | tr -d '\n'` && \
		yarn cache clean $$$$pkgName && \
		find `yarn cache dir`/.tmp -name package.json -exec grep -l $$$$pkgName {} + | xargs dirname | xargs rm -rf
	@echo "Done building $1"
endef

# Creates a packages/{pkg}/package.tgz rule for a package
define addPkgRule
$(eval 
$(PKGS_DIR)/$1/package.tgz: $(shell find $(PKGS_DIR)/$1/src -type f)
	$(call buildPkg,$(PKGS_DIR)/$1)
)
endef

PKGS_DIR := packages
pkgs := $(notdir $(wildcard $(PKGS_DIR)/*))

all: $(pkgs)
	@echo "Building all: $(pkgs)"
	$(foreach p,$(pkgs),$(eval make $p))

clean:
	rm -rf $(PKGS_DIR)/*/node_modules/@app
	rm -rf $(PKGS_DIR)/*/dist
	rm -rf $(PKGS_DIR)/*/build
	rm -rf $(PKGS_DIR)/*/package.tgz

# Create packages/{pkg}/package.tgz rules for each package
$(foreach p,$(pkgs),$(call addPkgRule,$p))

%:
	@make $(PKGS_DIR)/$@/package.tgz

# Declare dependencies
lib2: lib1
lib3: lib2
lib4: lib1 lib3
lib5: lib0 lib1
react-app: lib4 lib5
