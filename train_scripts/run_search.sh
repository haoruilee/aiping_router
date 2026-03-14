#!/usr/bin/env bash
# =============================================================================
# run_search.sh — Entry point for the genetic parameter search
#
# Prerequisites (on your 8-GPU server):
#   apt install -y python3-pip git curl
#   pip install uv modelscope pyyaml
#   curl -fsSL https://ollama.com/install.sh | sh
#   ollama serve &
#   npm install -g openclaw@latest
#   openclaw plugins install @aiping.cn/model_router
#
# Usage:
#   export AIPING_KEY=QC-your-key
#   ./train_scripts/run_search.sh                      # full search
#   ./train_scripts/run_search.sh --dry-run            # preview population
#   ./train_scripts/run_search.sh --resume results/generation_003.json
#   ./train_scripts/run_search.sh --config my_config.yaml
#
# The script will:
#   1. Validate prerequisites
#   2. Clone/update PinchBench skill
#   3. Start gateway (unless already running)
#   4. Run genetic_search.py with all args forwarded
#   5. Print the best configuration found
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$SCRIPT_DIR/search_config.yaml"
RESULTS_DIR="$SCRIPT_DIR/results"
SKILL_DIR="/tmp/pinchbench-skill"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()  { echo -e "${CYAN}ℹ${RESET}  $*"; }
ok()    { echo -e "${GREEN}✅${RESET} $*"; }
warn()  { echo -e "${YELLOW}⚠️${RESET}  $*"; }
err()   { echo -e "${RED}❌${RESET} $*" >&2; exit 1; }

# ── Validate ──────────────────────────────────────────────────────────────────
[[ -z "${AIPING_KEY:-}" ]] && err "AIPING_KEY not set. Run: export AIPING_KEY=QC-..."
for cmd in python3 uv ollama openclaw; do
  command -v "$cmd" &>/dev/null || err "Missing: $cmd"
done
python3 -c "import yaml" 2>/dev/null || { pip install pyyaml -q && ok "Installed pyyaml"; }
python3 -c "import modelscope" 2>/dev/null || { pip install modelscope -q && ok "Installed modelscope"; }

# ── Clone/update PinchBench ───────────────────────────────────────────────────
if [[ ! -d "$SKILL_DIR/.git" ]]; then
  info "Cloning PinchBench skill…"
  git clone --depth 1 https://github.com/pinchbench/skill.git "$SKILL_DIR"
else
  info "Updating PinchBench skill…"
  git -C "$SKILL_DIR" pull --ff-only 2>/dev/null || true
fi
ok "PinchBench ready at $SKILL_DIR"

# Update skill_dir in config if needed
python3 - <<PYEOF
import yaml, pathlib
cfg_path = pathlib.Path('$CONFIG')
cfg = yaml.safe_load(cfg_path.read_text())
cfg['benchmark']['skill_dir'] = '$SKILL_DIR'
cfg_path.write_text(yaml.dump(cfg, default_flow_style=False))
PYEOF

# ── Start gateway if not running ──────────────────────────────────────────────
if ! curl -sf "http://localhost:$GATEWAY_PORT/aiping/health" &>/dev/null; then
  info "Starting OpenClaw gateway on port $GATEWAY_PORT…"
  openclaw gateway --port "$GATEWAY_PORT" --allow-unconfigured > "/tmp/gw-search.log" 2>&1 &
  sleep 8
  if curl -sf "http://localhost:$GATEWAY_PORT/aiping/health" &>/dev/null; then
    ok "Gateway started"
  else
    warn "Gateway health check failed, search will restart it per-eval"
  fi
else
  ok "Gateway already running"
fi

# ── Start Ollama if not running ───────────────────────────────────────────────
if ! ollama list &>/dev/null; then
  info "Starting Ollama service…"
  ollama serve > /tmp/ollama-search.log 2>&1 &
  sleep 4
fi
ok "Ollama ready"

# ── GPU info ──────────────────────────────────────────────────────────────────
if command -v nvidia-smi &>/dev/null; then
  GPU_COUNT=$(nvidia-smi --list-gpus | wc -l)
  info "Detected $GPU_COUNT GPU(s)"
  export CUDA_VISIBLE_DEVICES="$(seq -s, 0 $((GPU_COUNT-1)))"
  export OLLAMA_NUM_GPU="$GPU_COUNT"
fi

# ── Print search plan ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  🧬 Genetic Parameter Search${RESET}"
echo -e "  Config      : $CONFIG"
echo -e "  Results dir : $RESULTS_DIR"
python3 - <<PYEOF
import yaml, pathlib
cfg = yaml.safe_load(pathlib.Path('$CONFIG').read_text())
ga = cfg['genetic']
bm = cfg['benchmark']
print(f"  Population  : {ga['population_size']}  |  Generations : {ga['generations']}")
print(f"  Suite       : {bm['suite']}  |  Runs/task : {bm['runs_per_task']}")
print(f"  Local models: {len(cfg['local_models'])}  |  Cloud models: {len(cfg['cloud_models'])}")
total_evals = ga['population_size'] * ga['generations']
print(f"  Max evals   : ~{total_evals} (with caching, fewer unique)")
PYEOF
echo ""

# ── Run genetic search ────────────────────────────────────────────────────────
mkdir -p "$RESULTS_DIR"
cd "$REPO_DIR"

exec python3 "$SCRIPT_DIR/genetic_search.py" \
  --config   "$CONFIG" \
  --results-dir "$RESULTS_DIR" \
  "$@"
