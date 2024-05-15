build:
	@make build-bun
	@make build-node

build-bun:
	@echo "Building bun"
	@rm -rf dist-bun
	@bun build src/bldr-cli.ts --outfile dist-bun/bldr --compile
	@xattr -w version "`jq -r '.version' package.json`" dist-bun/bldr

build-node:
	@echo "Building node"
	@./scripts/build-node.sh


install:
	@if [ ! -d ~/.bun ]; then curl -fsSL https://bun.sh/install | bash; fi
	@bun install
	
install-to-path:
	build-bun
	@echo "Installing to usr/local/bin"
	@rm -f /usr/local/bin/bldr
	@cp dist-bun/bldr /usr/local/bin/bldr

clean:
	@echo "Clean"
	rm -f /usr/local/bin/bldr
	rm -rf dist*

dev:
	@if ! command -v fswatch &> /dev/null; then brew install fswatch; fi
	@make install
	@echo "Watching for changes..."
	@fswatch -o ./src/*.ts | xargs -n1 -I{} make install-to-path

.DEFAULT_GOAL := build