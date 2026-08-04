#!/usr/bin/env bash
# Builds the Yoke Docker images.
#   slim: compiled binary only
#   full: + build toolchains (git, gcc, node, python, deno, ...)
#
# Usage: ./scripts/docker-build.sh [tag]   (default tag: latest)
set -euo pipefail
TAG="${1:-latest}"

docker build --target slim -t "yoke:slim-${TAG}" .
docker build --target full -t "yoke:full-${TAG}" .

echo
echo "Built:"
echo "  yoke:slim-${TAG}"
echo "  yoke:full-${TAG}"
echo
echo "Run: docker run --rm -p 8080:8080 -v \"\$(pwd)/workspace:/workspace\" -e DEEPSEEK_API_KEY=... yoke:full-${TAG}"
echo "Create a user: docker run --rm -v yoke-data:/data yoke:full-${TAG} create-user <username> <password>"
