install:
	@echo "Installing bldr"
	@if [ ! -d ~/.bun ]; then curl -fsSL https://bun.sh/install | bash; fi
	@if [ ! -d node_modules ]; then bun install; fi
	@bun build src/bldr-cli.ts --outfile dist/bldr --compile
	@xattr -w version "${jq -r '.version' package.json}" dist/bldr
	@chmod +x dist/bldr
	@cp dist/bldr /usr/local/bin/bldr

uninstall:
	@echo "Uninstalling bldr"
	@rm -f /usr/local/bin/bldr

dev:
	@if ! command -v fswatch &> /dev/null; then brew install fswatch; fi
	@make install
	@echo "Watching for changes..."
	@fswatch -o ./src/*.ts | xargs -n1 -I{} make install