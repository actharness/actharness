#!/bin/sh
# Probe #9: this must run even when the main entrypoint failed.
echo "post_ran=true" >> "$GITHUB_OUTPUT"
