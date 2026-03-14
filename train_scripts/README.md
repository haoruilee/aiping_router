# 🧬 Parameter Search — Finding the Optimal Model Router Config

Genetic algorithm that searches for the best combination of:
- **Local model** (from ModelScope GGUF registry)
- **Cloud model** (from AIPing API)
- **Routing threshold** (0-100)
- **Rule scorer weights** (token/code/reasoning/multi-turn multipliers)

Evaluated against [PinchBench](https://github.com/pinchbench/skill) automated tasks.

## Quick Start (on your 8-GPU server)

```bash
# 1. Install deps
pip install uv modelscope pyyaml
npm install -g openclaw@latest
openclaw plugins install @aiping.cn/model_router

# 2. Set your AIPing key
export AIPING_KEY=QC-your-key-here

# 3. Preview the search plan (no models downloaded)
./train_scripts/run_search.sh --dry-run

# 4. Run the full search (~2-8 hours depending on config)
./train_scripts/run_search.sh
```

## File Structure

```
train_scripts/
├── search_config.yaml    ← Edit this: models, GA params, fitness weights
├── genetic_search.py     ← GA implementation (population, crossover, mutation)
├── evaluator.py          ← Runs PinchBench for one config, returns fitness
├── ollama_manager.py     ← Pulls/creates Ollama models from ModelScope GGUFs
├── run_search.sh         ← Entry point (validates deps, starts services)
├── results/              ← Created during search
│   ├── generation_001.json
│   ├── generation_002.json
│   ├── best.json         ← Best config found so far
│   └── history.json      ← Full run history
└── README.md
```

## Configuration (`search_config.yaml`)

### Change which models to search

```yaml
local_models:
  - id: "qwen2.5:7b"
    modelscope: "ggml-org/Qwen2.5-7B-Instruct-GGUF"
    file: "qwen2.5-7b-instruct-q4_k_m.gguf"
    min_vram_gb: 6
  # ... add more
```

All models use the `ggml-org` ModelScope namespace which provides pre-quantised
GGUF files compatible with Ollama. Download command:

```bash
modelscope download --model ggml-org/Qwen2.5-VL-3B-Instruct-GGUF \
  qwen2.5-vl-3b-instruct-q4_k_m.gguf
```

### Tune the genetic algorithm

```yaml
genetic:
  population_size: 16   # candidates per generation (↑ = more thorough, slower)
  generations: 8        # iterations (↑ = more optimization)
  mutation_rate: 0.20   # exploration rate
```

### Tune the fitness function

```yaml
fitness_weights:
  accuracy: 0.60   # PinchBench task score  (most important)
  ttft:     0.20   # time to first token    (penalise slow models)
  tps:      0.10   # tokens per second
  cost:     0.10   # cloud API calls (penalise expensive routing)
```

Increase `accuracy` weight to optimise purely for correctness.  
Increase `ttft` + `tps` weights to optimise for speed.  
Increase `cost` weight to minimise cloud API spend.

## Resuming an interrupted search

```bash
./train_scripts/run_search.sh --resume train_scripts/results/generation_005.json
```

## Reading results

```bash
cat train_scripts/results/best.json | python3 -c "
import json, sys
b = json.load(sys.stdin)
print('Best config:')
print(f'  Local model  : {b[\"local_idx\"]}')  # use local_models[idx]
print(f'  Cloud model  : {b[\"cloud_idx\"]}')  # use cloud_models[idx]
print(f'  Threshold    : {b[\"threshold\"]}')
print(f'  Rule weights : token={b[\"w_token\"]} code={b[\"w_code\"]}')
print(f'  Fitness      : {b[\"fitness\"]:.4f}')
"
```

Then apply it:

```bash
openclaw model-router-setup \
  --local-model "qwen2.5:7b" \
  --cloud-model "DeepSeek-V3.2" \
  --threshold 70
```

## How the GA works

```
Initial population (random + default seeded)
         │
         ▼
┌────────────────────────────┐
│  For each individual:      │
│  1. Pull model from Ollama │
│  2. Configure router       │
│  3. Run PinchBench tasks   │
│  4. Compute fitness        │
└────────────────────────────┘
         │
         ▼
  Sort by fitness
         │
    ┌────┴────┐
    │  Elite  │ ← top 25% survive unchanged
    └────┬────┘
         │
  Tournament selection + crossover + mutation
         │
         ▼
  Next generation
         │
  (repeat for N generations)
         │
         ▼
  best.json ← optimal configuration
```
