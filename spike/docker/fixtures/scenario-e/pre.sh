#!/bin/sh
# H6: write state in pre-entrypoint; post-entrypoint reads it via STATE_cache_key env var
echo "cache_key=abc" >> "$GITHUB_STATE"
