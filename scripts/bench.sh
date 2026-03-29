#!/usr/bin/env bash
# =============================================================================
# bench.sh — AIPing Model Router agent benchmark runner
#
# Runs an external OpenClaw skill benchmark (hybrid vs cloud-only) and prints
# a side-by-side comparison. The skill repo URL is not hardcoded: set
# BENCH_SKILL_GIT_URL before running, or pass an existing clone with --skill-dir.
#
# Usage:
#   ./scripts/bench.sh [options]
#
# Options:
#   --preset        <name>       Named preset from benchmarks/presets.json
#                                  default | fast | quality-local | cloud-only
#                                  deepseek | llama-local | phi-local | full
#   --local-model   <model>      Ollama model name  (e.g. qwen2.5:4b)
#   --cloud-model   <model>      AIPing cloud model (e.g. Kimi-K2.5)
#   --threshold     <0-100>      Routing threshold  (default: 85)
#   --suite         <tasks>      automated-only | all | task_00,task_04,...
#   --runs          <n>          Runs per task      (default: 1)
#   --aiping-key    <key>        AIPing API key (overrides AIPING_KEY env var)
#   --gateway-port  <port>       OpenClaw gateway port (default: 18789)
#   --skill-dir     <path>       Benchmark skill checkout (cloned if absent)
#   --output-dir    <path>       Results directory (default: /tmp/bench-results)
#   --no-cloud      Run hybrid only, skip cloud-only baseline
#   --upload        Upload benchmark results (when the skill supports it)
#   --help
#
# Environment:
#   BENCH_SKILL_GIT_URL   git clone URL for the benchmark skill (required if skill-dir is empty)
#
# Examples:
#   export BENCH_SKILL_GIT_URL='https://github.com/example/agent-bench-skill.git'
#   ./scripts/bench.sh
#   ./scripts/bench.sh --preset fast
#   AIPING_KEY=QC-xxx ./scripts/bench.sh --local-model qwen2.5:7b --cloud-model DeepSeek-V3.2
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PRESETS_FILE="$REPO_DIR/benchmarks/presets.json"

# ── Defaults ──────────────────────────────────────────────────────────────────
PRESET=""
LOCAL_MODEL=""
CLOUD_MODEL=""
THRESHOLD=""
SUITE="automated-only"
RUNS="1"
AIPING_KEY="${AIPING_KEY:-}"
GATEWAY_PORT="18789"
SKILL_DIR="${SKILL_DIR:-/tmp/agent-bench-skill}"
BENCH_SKILL_GIT_URL="${BENCH_SKILL_GIT_URL:-}"
OUTPUT_BASE="/tmp/bench-results"
NO_CLOUD=false
UPLOAD_FLAG="--no-upload"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()  { echo -e "${CYAN}ℹ ${RESET}$*"; }
ok()    { echo -e "${GREEN}✅${RESET} $*"; }
warn()  { echo -e "${YELLOW}⚠️ ${RESET}$*"; }
err()   { echo -e "${RED}❌${RESET} $*" >&2; }
hr()    { echo -e "${CYAN}$(printf '─%.0s' {1..60})${RESET}"; }

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset)        PRESET="$2";       shift 2 ;;
    --local-model)   LOCAL_MODEL="$2";  shift 2 ;;
    --cloud-model)   CLOUD_MODEL="$2";  shift 2 ;;
    --threshold)     THRESHOLD="$2";    shift 2 ;;
    --suite)         SUITE="$2";        shift 2 ;;
    --runs)          RUNS="$2";         shift 2 ;;
    --aiping-key)    AIPING_KEY="$2";   shift 2 ;;
    --gateway-port)  GATEWAY_PORT="$2"; shift 2 ;;
    --skill-dir)     SKILL_DIR="$2";    shift 2 ;;
    --output-dir)    OUTPUT_BASE="$2";  shift 2 ;;
    --no-cloud)      NO_CLOUD=true;     shift ;;
    --upload)        UPLOAD_FLAG="";    shift ;;
    --help|-h)
      sed -n '/^# Usage:/,/^# ====/p' "$0" | head -45
      exit 0 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Load preset ───────────────────────────────────────────────────────────────
if [[ -n "$PRESET" ]]; then
  if [[ ! -f "$PRESETS_FILE" ]]; then
    err "Presets file not found: $PRESETS_FILE"; exit 1
  fi
  PRESET_JSON=$(python3 -c "
import json, sys
presets = json.load(open('$PRESETS_FILE'))
if '$PRESET' not in presets:
    print('UNKNOWN', file=sys.stderr)
    sys.exit(1)
p = presets['$PRESET']
print(p.get('localModel',''))
print(p.get('cloudModel',''))
print(p.get('threshold', 85))
print(p.get('suite', 'automated-only'))
print(p.get('runs', 1))
print(p.get('description', ''))
" 2>/dev/null) || { err "Unknown preset: $PRESET"; echo "Available presets:"; python3 -c "import json; [print(f'  {k:20s} — {v[\"description\"]}') for k,v in json.load(open('$PRESETS_FILE')).items() if not k.startswith('_')]"; exit 1; }

  mapfile -t PRESET_VALS <<< "$PRESET_JSON"
  [[ -z "$LOCAL_MODEL" ]] && LOCAL_MODEL="${PRESET_VALS[0]}"
  [[ -z "$CLOUD_MODEL" ]] && CLOUD_MODEL="${PRESET_VALS[1]}"
  [[ -z "$THRESHOLD"   ]] && THRESHOLD="${PRESET_VALS[2]}"
  SUITE="${PRESET_VALS[3]}"
  RUNS="${PRESET_VALS[4]}"
  PRESET_DESC="${PRESET_VALS[5]}"
  info "Preset: ${BOLD}$PRESET${RESET} — $PRESET_DESC"
fi

# ── Apply remaining defaults ──────────────────────────────────────────────────
LOCAL_MODEL="${LOCAL_MODEL:-qwen2.5:4b}"
CLOUD_MODEL="${CLOUD_MODEL:-Kimi-K2.5}"
THRESHOLD="${THRESHOLD:-85}"
RUN_ID="$(date +%Y%m%d_%H%M%S)"
OUTPUT_DIR="$OUTPUT_BASE/$RUN_ID"

# ── Validate ──────────────────────────────────────────────────────────────────
if [[ -z "$AIPING_KEY" ]]; then
  err "AIPING_KEY not set. Use --aiping-key or export AIPING_KEY=QC-..."
  exit 1
fi

hr
echo -e "${BOLD}  AIPing Model Router — agent benchmark${RESET}"
echo -e "  Local  : ${CYAN}$LOCAL_MODEL${RESET}"
echo -e "  Cloud  : ${CYAN}$CLOUD_MODEL${RESET}"
echo -e "  Threshold : ${CYAN}$THRESHOLD${RESET} (≥threshold → cloud)"
echo -e "  Suite  : ${CYAN}$SUITE${RESET}  |  Runs: ${CYAN}$RUNS${RESET}"
echo -e "  Output : $OUTPUT_DIR"
hr

# ── Check dependencies ────────────────────────────────────────────────────────
for cmd in openclaw ollama uv python3 git; do
  if ! command -v "$cmd" &>/dev/null; then
    err "Required command not found: $cmd"
    case "$cmd" in
      openclaw) echo "  Install: npm install -g openclaw" ;;
      ollama)   echo "  Install: curl -fsSL https://ollama.com/install.sh | sh" ;;
      uv)       echo "  Install: curl -LsSf https://astral.sh/uv/install.sh | sh" ;;
    esac
    exit 1
  fi
done

# ── Ensure Ollama has the local model ─────────────────────────────────────────
info "Checking Ollama for model: $LOCAL_MODEL"
if ! ollama list 2>/dev/null | grep -q "^${LOCAL_MODEL%:*}"; then
  warn "Model $LOCAL_MODEL not found locally. Pulling..."
  ollama pull "$LOCAL_MODEL"
fi
ok "Local model ready: $LOCAL_MODEL"

# ── Clone/update benchmark skill ────────────────────────────────────────────
if [[ ! -d "$SKILL_DIR/.git" ]]; then
  if [[ -z "$BENCH_SKILL_GIT_URL" ]]; then
    err "No skill at $SKILL_DIR and BENCH_SKILL_GIT_URL is unset."
    err "Set BENCH_SKILL_GIT_URL to a git URL, or clone a skill repo to --skill-dir."
    exit 1
  fi
  info "Cloning benchmark skill → $SKILL_DIR"
  git clone --depth 1 "$BENCH_SKILL_GIT_URL" "$SKILL_DIR"
else
  info "Updating benchmark skill in $SKILL_DIR"
  git -C "$SKILL_DIR" pull --ff-only 2>/dev/null || true
fi
ok "Benchmark skill ready"

# ── Configure plugin ──────────────────────────────────────────────────────────
info "Configuring @aiping.cn/model_router plugin"
python3 - <<PYEOF
import json, pathlib, os

p = pathlib.Path.home() / '.openclaw' / 'openclaw.json'
if not p.exists():
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('{}')

d = json.loads(p.read_text())

# Plugin config
plugins = d.setdefault('plugins', {})
entries = plugins.setdefault('entries', {})
entry   = entries.setdefault('model_router', {})
cfg     = entry.setdefault('config', {})
cfg['aipingApiKey']      = '$AIPING_KEY'
cfg['localModel']        = '$LOCAL_MODEL'
cfg['localProxyUrl']     = 'http://localhost:11434'
cfg['cloudModel']        = '$CLOUD_MODEL'
cfg['routingThreshold']  = $THRESHOLD
cfg['debugRouting']      = False
cfg['fallbackToCloud']   = True
cfg['workflowHintBoost'] = False

# Disable hot-reload so agent operations don't restart gateway mid-benchmark
d.setdefault('gateway', {}).setdefault('reload', {})['mode'] = 'off'

p.write_text(json.dumps(d, indent=2))
print(f"  Plugin config written: localModel={cfg['localModel']}, cloudModel={cfg['cloudModel']}, threshold={cfg['routingThreshold']}")
PYEOF

# ── Start / restart gateway ───────────────────────────────────────────────────
info "Starting OpenClaw gateway on port $GATEWAY_PORT"
pkill -f "openclaw-gateway" 2>/dev/null || true
sleep 2

openclaw gateway --port "$GATEWAY_PORT" --allow-unconfigured > "/tmp/bench-gateway-$RUN_ID.log" 2>&1 &
GW_PID=$!
echo "$GW_PID" > "/tmp/bench-gateway.pid"

# Wait for gateway to be up
for i in {1..15}; do
  if curl -sf "http://localhost:$GATEWAY_PORT/aiping/health" &>/dev/null; then
    break
  fi
  sleep 1
done

# Read gateway token
GW_TOKEN=$(python3 -c "
import json, pathlib
p = pathlib.Path.home() / '.openclaw' / 'openclaw.json'
d = json.loads(p.read_text())
print(d.get('gateway',{}).get('auth',{}).get('token',''))
")

# Register aiping provider (needs gateway token)
python3 - <<PYEOF
import json, pathlib

p = pathlib.Path.home() / '.openclaw' / 'openclaw.json'
d = json.loads(p.read_text())

models = d.setdefault('models', {})
providers = models.setdefault('providers', {})
providers['aiping'] = {
    'baseUrl': 'http://127.0.0.1:$GATEWAY_PORT/aiping/v1',
    'apiKey': '$GW_TOKEN',
    'auth': 'api-key',
    'api': 'openai-completions',
    'models': [{'id': 'aiping:claw', 'name': 'AIPing Router ($LOCAL_MODEL + $CLOUD_MODEL)'}],
}
agents = d.setdefault('agents', {})
agents.setdefault('defaults', {})['model'] = 'aiping/aiping:claw'

p.write_text(json.dumps(d, indent=2))
print('  aiping provider registered')
PYEOF

# Verify gateway + plugin
HEALTH=$(curl -sf "http://localhost:$GATEWAY_PORT/aiping/health" 2>/dev/null || echo '{}')
ok "Gateway up. Plugin: $(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅' if d.get('ok') else '❌')" 2>/dev/null || echo '?')"

# ── Helper: run one benchmark pass ───────────────────────────────────────────
run_benchmark() {
  local label="$1"
  local out_dir="$2"
  local threshold="$3"

  # Update threshold in config
  python3 -c "
import json, pathlib
p = pathlib.Path.home() / '.openclaw' / 'openclaw.json'
d = json.loads(p.read_text())
d['plugins']['entries']['model_router']['config']['routingThreshold'] = $threshold
p.write_text(json.dumps(d, indent=2))
"
  # Restart gateway so threshold takes effect (reload.mode=off means manual restart needed)
  pkill -f "openclaw-gateway" 2>/dev/null || true
  sleep 2
  openclaw gateway --port "$GATEWAY_PORT" --allow-unconfigured > "/tmp/bench-gateway-${RUN_ID}-${threshold}.log" 2>&1 &
  sleep 8

  mkdir -p "$out_dir"
  info "Running: ${BOLD}$label${RESET} (threshold=$threshold, suite=$SUITE, runs=$RUNS)"
  cd "$SKILL_DIR"
  uv run scripts/benchmark.py \
    --model "aiping/aiping:claw" \
    --suite "$SUITE" \
    --runs "$RUNS" \
    --output-dir "$out_dir" \
    $UPLOAD_FLAG \
    2>&1 | tee "/tmp/bench-${label,,}-$RUN_ID.log"
}

# ── Run benchmarks ────────────────────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"

hr
echo -e "${BOLD}  Run 1/2 — Hybrid (threshold=$THRESHOLD, ~$(python3 -c "print(f'{max(0,min(100,(100-$THRESHOLD)))}')") % cloud)${RESET}"
run_benchmark "hybrid" "$OUTPUT_DIR/hybrid" "$THRESHOLD"

if [[ "$NO_CLOUD" == "false" ]]; then
  hr
  echo -e "${BOLD}  Run 2/2 — Cloud-only (threshold=0, 100% cloud)${RESET}"
  run_benchmark "cloud" "$OUTPUT_DIR/cloud" "0"
fi

# ── Comparison report ─────────────────────────────────────────────────────────
hr
echo -e "${BOLD}  Results${RESET}"
hr

python3 - <<PYEOF
import json, pathlib, sys

def load_dir(d, label):
    files = sorted(pathlib.Path(d).glob('*.json'))
    if not files:
        return None
    data = json.loads(files[0].read_text())
    tasks = data.get('tasks', [])
    scores, rows = [], []
    for t in tasks:
        m = t.get('grading', {}).get('mean', 0.0)
        scores.append(m)
        icon = '✅' if m >= 1.0 else '⚠️' if m > 0 else '❌'
        rows.append((t['task_id'], icon, f"{m*100:.0f}%", t.get('execution_time',0), t.get('timed_out',False)))
    overall = sum(scores)/len(scores)*100 if scores else 0
    return {'label': label, 'overall': overall, 'n': len(tasks), 'rows': rows}

hybrid = load_dir('$OUTPUT_DIR/hybrid', 'Hybrid  (threshold=$THRESHOLD)')
cloud  = load_dir('$OUTPUT_DIR/cloud',  'Cloud   (threshold=0 )')
results = [r for r in [hybrid, cloud] if r]

print()
print('='*68)
print(f'  {" $LOCAL_MODEL":16s} (local)  +  {"$CLOUD_MODEL":12s} (cloud)')
print(f'  Routing threshold: $THRESHOLD  |  Suite: $SUITE  |  Runs: $RUNS')
print('='*68)
print(f"  {'Configuration':<35} {'Score':>8}  {'Tasks':>5}")
print(f"  {'-'*35} {'-'*8}  {'-'*5}")
for r in results:
    print(f"  {r['label']:<35} {r['overall']:>7.1f}%  {r['n']:>5}")

if len(results) == 2:
    diff = results[1]['overall'] - results[0]['overall']
    sign = '+' if diff >= 0 else ''
    print(f"\n  Quality delta (cloud - hybrid): {sign}{diff:.1f}pp")
    r0, r1 = results[0], results[1]
    d0, d1 = {r[0]:r for r in r0['rows']}, {r[0]:r for r in r1['rows']}
    all_tasks = sorted(set(list(d0)+list(d1)))
    print()
    print(f"  {'Task':<38} {'Hybrid':>10}  {'Cloud':>10}  {'Time h/c':>10}")
    print(f"  {'-'*38} {'-'*10}  {'-'*10}  {'-'*10}")
    for tid in all_tasks:
        s0 = d0.get(tid, ('-','-','-',0,False))
        s1 = d1.get(tid, ('-','-','-',0,False))
        t0 = f"{s0[3]:.0f}s" if isinstance(s0[3],(int,float)) and s0[3]>0 else '-'
        t1 = f"{s1[3]:.0f}s" if isinstance(s1[3],(int,float)) and s1[3]>0 else '-'
        to0 = '⏱' if s0[4] else ''
        to1 = '⏱' if s1[4] else ''
        print(f"  {tid:<38} {s0[1]+' '+s0[2]+to0:>10}  {s1[1]+' '+s1[2]+to1:>10}  {t0+'/'+t1:>10}")

# Save summary
summary = {
    'run_id': '$RUN_ID',
    'local_model': '$LOCAL_MODEL',
    'cloud_model': '$CLOUD_MODEL',
    'threshold': $THRESHOLD,
    'suite': '$SUITE',
    'results': [{'label': r['label'], 'score': r['overall'], 'tasks': r['n']} for r in results]
}
pathlib.Path('$OUTPUT_DIR/summary.json').write_text(json.dumps(summary, indent=2))
print()
print('='*68)
print(f"  Results saved: $OUTPUT_DIR/")
PYEOF

ok "Benchmark complete → $OUTPUT_DIR/"
