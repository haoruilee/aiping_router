#!/usr/bin/env python3
"""Resolve benchmark parameters from preset or defaults. Writes to GITHUB_ENV."""
import json, os, sys, pathlib

preset   = os.environ.get('INPUT_PRESET', '')
local_m  = os.environ.get('INPUT_LOCAL_MODEL', 'qwen2.5:0.5b')
cloud_m  = os.environ.get('INPUT_CLOUD_MODEL', 'Kimi-K2.5')
threshold = os.environ.get('INPUT_THRESHOLD', '85')
suite    = os.environ.get('INPUT_SUITE', 'automated-only')
runs     = os.environ.get('INPUT_RUNS', '1')

if preset:
    presets_file = pathlib.Path(__file__).parent.parent / 'benchmarks' / 'presets.json'
    if presets_file.exists():
        presets = json.loads(presets_file.read_text())
        p = presets.get(preset)
        if p:
            local_m   = p.get('localModel',  local_m)
            cloud_m   = p.get('cloudModel',  cloud_m)
            threshold = str(p.get('threshold', threshold))
            suite     = p.get('suite',       suite)
            runs      = str(p.get('runs',    runs))
            print(f"Preset '{preset}': {p.get('description', '')}", file=sys.stderr)
        else:
            available = [k for k in presets if not k.startswith('_')]
            print(f"Warning: preset '{preset}' not found. Available: {available}", file=sys.stderr)

# Write to GITHUB_ENV if available, else just print
gh_env = os.environ.get('GITHUB_ENV', '')
lines = [
    f"LOCAL_MODEL={local_m}",
    f"CLOUD_MODEL={cloud_m}",
    f"THRESHOLD={threshold}",
    f"SUITE={suite}",
    f"RUNS={runs}",
]
if gh_env:
    with open(gh_env, 'a') as f:
        f.write('\n'.join(lines) + '\n')

for line in lines:
    print(line)
