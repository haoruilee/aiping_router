#!/usr/bin/env python3
"""
genetic_search.py — Genetic Algorithm to find the optimal router configuration.

Genome encoding (one individual):
  [local_model_idx, cloud_model_idx, threshold,
   w_token, w_code, w_reasoning, w_multi_turn]

Fitness = evaluator.evaluate(...).fitness

Usage:
  python genetic_search.py --config search_config.yaml [--resume results/checkpoint.json]

Output:
  results/generation_N.json   — per-generation results
  results/best.json           — overall best configuration found
  results/history.json        — full run history
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import os
import pathlib
import random
import time
from copy import deepcopy
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Tuple

import yaml

from evaluator import RouterConfig, FitnessResult, evaluate
from ollama_manager import ModelSpec, ensure_model_available

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("ga_search.log"),
    ],
)
log = logging.getLogger("ga")


# ── Individual ────────────────────────────────────────────────────────────────

@dataclass
class Individual:
    local_idx:   int
    cloud_idx:   int
    threshold:   int       # 0-100, step 5
    w_token:     float
    w_code:      float
    w_reasoning: float
    w_multi_turn: float
    fitness:     Optional[float] = None
    result:      Optional[FitnessResult] = None

    def to_config(
        self,
        local_models: List[Dict],
        cloud_models: List[str],
    ) -> RouterConfig:
        return RouterConfig(
            local_model  = local_models[self.local_idx]["id"],
            cloud_model  = cloud_models[self.cloud_idx],
            threshold    = self.threshold,
            w_token      = round(self.w_token, 2),
            w_code       = round(self.w_code, 2),
            w_reasoning  = round(self.w_reasoning, 2),
            w_multi_turn = round(self.w_multi_turn, 2),
        )

    def to_dict(self) -> Dict:
        d = asdict(self)
        d.pop("result", None)  # skip large nested object
        return d


# ── Population initialisation ─────────────────────────────────────────────────

def random_individual(cfg: Dict, rng: random.Random) -> Individual:
    n_local  = len(cfg["local_models"])
    n_cloud  = len(cfg["cloud_models"])
    thr_step = cfg["threshold"].get("step", 5)
    steps = list(range(
        cfg["threshold"]["min"],
        cfg["threshold"]["max"] + 1,
        thr_step,
    ))

    def w(key: str) -> float:
        lo = cfg["rule_weights"][key]["min"]
        hi = cfg["rule_weights"][key]["max"]
        return round(rng.uniform(lo, hi), 2)

    return Individual(
        local_idx    = rng.randrange(n_local),
        cloud_idx    = rng.randrange(n_cloud),
        threshold    = rng.choice(steps),
        w_token      = w("token_count"),
        w_code       = w("code_complexity"),
        w_reasoning  = w("reasoning_depth"),
        w_multi_turn = w("multi_turn"),
    )


def seed_defaults(cfg: Dict) -> Individual:
    """One individual at default weights (good starting point)."""
    return Individual(
        local_idx    = 0,  # first local model
        cloud_idx    = 0,  # first cloud model
        threshold    = 85,
        w_token      = cfg["rule_weights"]["token_count"]["default"],
        w_code       = cfg["rule_weights"]["code_complexity"]["default"],
        w_reasoning  = cfg["rule_weights"]["reasoning_depth"]["default"],
        w_multi_turn = cfg["rule_weights"]["multi_turn"]["default"],
    )


def initial_population(cfg: Dict, rng: random.Random) -> List[Individual]:
    pop_size = cfg["genetic"]["population_size"]
    pop = [seed_defaults(cfg)]  # always include defaults
    while len(pop) < pop_size:
        pop.append(random_individual(cfg, rng))
    return pop


# ── Genetic operators ─────────────────────────────────────────────────────────

def tournament_select(
    population: List[Individual],
    k: int,
    rng: random.Random,
) -> Individual:
    """Select best from k random candidates."""
    contestants = rng.sample(population, min(k, len(population)))
    return max(contestants, key=lambda x: x.fitness or -1)


def crossover(a: Individual, b: Individual, rng: random.Random) -> Tuple[Individual, Individual]:
    """Uniform crossover on numeric genes; discrete swap on model indices."""
    def blend(va: float, vb: float) -> float:
        alpha = rng.random()
        return round(alpha * va + (1 - alpha) * vb, 2)

    child_a = Individual(
        local_idx    = a.local_idx if rng.random() < 0.5 else b.local_idx,
        cloud_idx    = a.cloud_idx if rng.random() < 0.5 else b.cloud_idx,
        threshold    = a.threshold if rng.random() < 0.5 else b.threshold,
        w_token      = blend(a.w_token,      b.w_token),
        w_code       = blend(a.w_code,       b.w_code),
        w_reasoning  = blend(a.w_reasoning,  b.w_reasoning),
        w_multi_turn = blend(a.w_multi_turn, b.w_multi_turn),
    )
    child_b = Individual(
        local_idx    = b.local_idx if rng.random() < 0.5 else a.local_idx,
        cloud_idx    = b.cloud_idx if rng.random() < 0.5 else a.cloud_idx,
        threshold    = b.threshold if rng.random() < 0.5 else a.threshold,
        w_token      = blend(b.w_token,      a.w_token),
        w_code       = blend(b.w_code,       a.w_code),
        w_reasoning  = blend(b.w_reasoning,  a.w_reasoning),
        w_multi_turn = blend(b.w_multi_turn, a.w_multi_turn),
    )
    return child_a, child_b


def mutate(ind: Individual, cfg: Dict, rng: random.Random) -> Individual:
    """Gaussian mutation on weights, random swap on model/threshold."""
    mut = cfg["genetic"]["mutation_rate"]
    n_local = len(cfg["local_models"])
    n_cloud = len(cfg["cloud_models"])
    thr_step = cfg["threshold"].get("step", 5)
    thr_steps = list(range(
        cfg["threshold"]["min"], cfg["threshold"]["max"] + 1, thr_step
    ))

    def maybe_mutate_weight(v: float, key: str) -> float:
        if rng.random() < mut:
            lo = cfg["rule_weights"][key]["min"]
            hi = cfg["rule_weights"][key]["max"]
            v += rng.gauss(0, 0.3)
            return round(max(lo, min(hi, v)), 2)
        return v

    m = deepcopy(ind)
    m.fitness = None
    m.result  = None

    if rng.random() < mut:
        m.local_idx = rng.randrange(n_local)
    if rng.random() < mut:
        m.cloud_idx = rng.randrange(n_cloud)
    if rng.random() < mut:
        m.threshold = rng.choice(thr_steps)

    m.w_token      = maybe_mutate_weight(m.w_token,      "token_count")
    m.w_code       = maybe_mutate_weight(m.w_code,       "code_complexity")
    m.w_reasoning  = maybe_mutate_weight(m.w_reasoning,  "reasoning_depth")
    m.w_multi_turn = maybe_mutate_weight(m.w_multi_turn, "multi_turn")

    return m


# ── Evaluation ────────────────────────────────────────────────────────────────

def evaluate_population(
    population: List[Individual],
    cfg: Dict,
    output_base: str,
    generation: int,
) -> List[Individual]:
    """
    Evaluate unevaluated individuals in the population.
    Skips those with cached fitness.
    """
    pending = [ind for ind in population if ind.fitness is None]
    log.info("Generation %d — evaluating %d/%d individuals",
             generation, len(pending), len(population))

    local_models  = cfg["local_models"]
    cloud_models  = cfg["cloud_models"]
    gpu_layers    = cfg["hardware"].get("ollama_gpu_layers", 99)
    skill_dir     = cfg["benchmark"]["skill_dir"]
    suite         = cfg["benchmark"]["suite"]
    runs          = cfg["benchmark"]["runs_per_task"]
    fw            = cfg["fitness_weights"]

    current_local: Optional[str] = None

    for i, ind in enumerate(pending):
        spec = ModelSpec(**{
            k: local_models[ind.local_idx].get(k)
            for k in ("ollama_id", "modelscope", "file", "min_vram_gb")
            if k in local_models[ind.local_idx]
        }, ollama_id=local_models[ind.local_idx]["id"])

        # Only re-pull if model changed (avoid repeated downloads)
        if spec.ollama_id != current_local:
            log.info("  Provisioning local model: %s", spec.ollama_id)
            if not ensure_model_available(spec, gpu_layers=gpu_layers):
                log.error("  Failed to provision %s — skipping", spec.ollama_id)
                ind.fitness = -1.0
                continue
            current_local = spec.ollama_id

        router_cfg = ind.to_config(local_models, cloud_models)
        out_dir = f"{output_base}/gen{generation:03d}/{i:03d}"

        result = evaluate(
            router_cfg,
            skill_dir   = skill_dir,
            suite       = suite,
            runs        = runs,
            fitness_weights = fw,
            output_base = out_dir,
        )
        ind.fitness = result.fitness
        ind.result  = result
        log.info(
            "  [%d/%d] %s → %s",
            i + 1, len(pending), router_cfg.label(), result.summary()
        )

    return population


# ── Checkpoint helpers ────────────────────────────────────────────────────────

def save_checkpoint(
    population: List[Individual],
    generation: int,
    best_ever: Individual,
    history: List[Dict],
    results_dir: pathlib.Path,
) -> None:
    results_dir.mkdir(parents=True, exist_ok=True)
    gen_data = {
        "generation": generation,
        "timestamp":  time.time(),
        "population": [ind.to_dict() for ind in population],
        "best_this_gen": max(
            (ind for ind in population if ind.fitness is not None),
            key=lambda x: x.fitness, default=population[0]
        ).to_dict(),
    }
    (results_dir / f"generation_{generation:03d}.json").write_text(
        json.dumps(gen_data, indent=2)
    )
    (results_dir / "best.json").write_text(json.dumps(best_ever.to_dict(), indent=2))
    history.append(gen_data)
    (results_dir / "history.json").write_text(json.dumps(history, indent=2))
    log.info("  Checkpoint saved → %s/generation_%03d.json", results_dir, generation)


def load_checkpoint(checkpoint_file: str, cfg: Dict) -> Tuple[List[Individual], int, List[Dict]]:
    """Resume from a checkpoint file."""
    data = json.loads(pathlib.Path(checkpoint_file).read_text())
    generation = data["generation"]
    history    = [data]
    population = []
    for d in data["population"]:
        ind = Individual(**{k: d[k] for k in Individual.__dataclass_fields__ if k in d})
        population.append(ind)
    return population, generation, history


# ── Main GA loop ──────────────────────────────────────────────────────────────

def run_genetic_search(
    cfg: Dict,
    results_dir: pathlib.Path,
    resume_from: Optional[str] = None,
) -> Individual:
    ga = cfg["genetic"]
    rng = random.Random(ga["seed"])

    if resume_from:
        population, start_gen, history = load_checkpoint(resume_from, cfg)
        log.info("Resuming from generation %d with %d individuals", start_gen, len(population))
    else:
        population = initial_population(cfg, rng)
        start_gen  = 0
        history    = []

    best_ever: Optional[Individual] = None

    for gen in range(start_gen, ga["generations"]):
        log.info("═" * 60)
        log.info("Generation %d / %d", gen + 1, ga["generations"])
        log.info("═" * 60)

        # Evaluate
        population = evaluate_population(
            population, cfg,
            output_base=str(results_dir / "bench"),
            generation=gen,
        )

        # Sort by fitness descending
        evaluated = sorted(
            (ind for ind in population if ind.fitness is not None),
            key=lambda x: x.fitness,
            reverse=True,
        )

        if not evaluated:
            log.error("No evaluated individuals in generation %d!", gen)
            break

        best_this_gen = evaluated[0]
        if best_ever is None or best_this_gen.fitness > (best_ever.fitness or -1):
            best_ever = deepcopy(best_this_gen)
            log.info(
                "  ★ New best: fitness=%.4f  acc=%.1f%%  config=%s",
                best_ever.fitness,
                best_ever.result.accuracy if best_ever.result else 0,
                best_ever.to_config(cfg["local_models"], cfg["cloud_models"]).label(),
            )

        save_checkpoint(evaluated, gen, best_ever, history, results_dir)

        # Build next generation
        n_elite = max(1, int(len(evaluated) * ga["elite_frac"]))
        next_pop = deepcopy(evaluated[:n_elite])  # elites carry over

        while len(next_pop) < ga["population_size"]:
            if rng.random() < ga["crossover_prob"]:
                p1 = tournament_select(evaluated, ga["tournament_k"], rng)
                p2 = tournament_select(evaluated, ga["tournament_k"], rng)
                c1, c2 = crossover(p1, p2, rng)
                next_pop.extend([mutate(c1, cfg, rng), mutate(c2, cfg, rng)])
            else:
                parent = tournament_select(evaluated, ga["tournament_k"], rng)
                next_pop.append(mutate(deepcopy(parent), cfg, rng))

        population = next_pop[:ga["population_size"]]

    log.info("═" * 60)
    log.info("Search complete. Best configuration found:")
    if best_ever:
        best_config = best_ever.to_config(cfg["local_models"], cfg["cloud_models"])
        log.info("  Local model   : %s", best_config.local_model)
        log.info("  Cloud model   : %s", best_config.cloud_model)
        log.info("  Threshold     : %d", best_config.threshold)
        log.info("  Rule weights  : token=%.2f code=%.2f reason=%.2f multi=%.2f",
                 best_config.w_token, best_config.w_code,
                 best_config.w_reasoning, best_config.w_multi_turn)
        if best_ever.result:
            log.info("  Fitness       : %.4f", best_ever.fitness)
            log.info("  Accuracy      : %.1f%%", best_ever.result.accuracy)
    log.info("═" * 60)

    return best_ever


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Genetic search for optimal AIPing Model Router configuration"
    )
    parser.add_argument(
        "--config", default="train_scripts/search_config.yaml",
        help="Path to search_config.yaml"
    )
    parser.add_argument(
        "--results-dir", default="train_scripts/results",
        help="Directory to store results and checkpoints"
    )
    parser.add_argument(
        "--resume", default=None,
        help="Path to checkpoint JSON to resume from"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print first generation without running evaluations"
    )
    args = parser.parse_args()

    cfg = yaml.safe_load(pathlib.Path(args.config).read_text())

    # Inject AIPING_KEY into evaluator module
    import evaluator as ev
    ev.AIPING_KEY   = os.environ.get("AIPING_KEY", ev.AIPING_KEY)
    ev.GATEWAY_PORT = cfg["benchmark"].get("gateway_port", 18789)

    results_dir = pathlib.Path(args.results_dir)

    if args.dry_run:
        rng = random.Random(cfg["genetic"]["seed"])
        pop = initial_population(cfg, rng)
        print(f"\nDry run — {len(pop)} individuals in initial population:")
        for i, ind in enumerate(pop):
            c = ind.to_config(cfg["local_models"], cfg["cloud_models"])
            print(f"  [{i+1:02d}] {c.label()}")
        return

    best = run_genetic_search(cfg, results_dir, resume_from=args.resume)
    if best:
        print("\n\nBest configuration:")
        print(json.dumps(best.to_dict(), indent=2))


if __name__ == "__main__":
    main()
