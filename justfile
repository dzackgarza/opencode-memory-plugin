
# Install JavaScript dependencies
setup:
    bun install

# Setup npm trusted publisher (one-time manual setup)
setup-npm-trust:
    #!/usr/bin/env bash
    set -euo pipefail
    npm trust github --repository "dzackgarza/$(basename "{{justfile_directory()}}")" --file publish.yml

# Manual publish from local (requires 2FA)
publish:
    npm publish

# Run the Bun integration suite
test *ARGS:
    direnv exec {{justfile_directory()}} bun test {{ARGS}}

# Run TypeScript typecheck
typecheck:
    direnv exec {{justfile_directory()}} bun run typecheck

# Run the preferred local verification workflow
check:
    just typecheck
    just test
