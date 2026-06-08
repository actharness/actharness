#!/bin/sh
# STATE_cache_key is set from GITHUB_STATE written in pre-entrypoint
echo "restored=$STATE_cache_key" >> "$GITHUB_OUTPUT"
