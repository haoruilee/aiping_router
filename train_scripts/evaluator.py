#!/usr/bin/env python3
"""
evaluator.py — Run PinchBench on one (local_model, cloud_model, config) combo
               and return a structured FitnessResult.

The evaluator:
  1. Ensures the local model is available in Ollama
  2. Writes the router config (threshold + rule weights) to openclaw.json
  3. Registers the aiping provider with the gateway token
  4. Restarts the gateway so new threshold takes effect
  5. Runs `uv run scripts/benchmark.py` for the configured suite
  6. Parses the JSON result to compute fitness scores
"""
from __future__ import annotations

import json
import logging
import os
import pathlib
import subprocess
import tempfile
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

OPENCLAW_CONFIG = pathlib.Path.home() / ".openclaw" / "openclaw.json"
GATEWAY_PORT = int(os.environ.get("GATEWAY_PORT", "18789"))
AIPING_KEY   = os.environ.get("AIPING_KEY", "")


@dataclass
class RouterConfig:
    """One candidate configuration to evaluate."""
    local_model:    str
    cloud_model:    str
    threshold:      int       # 0-100
    # Rule weight multipliers (1.0 = default, 0 = disabled)
    w_token:        float = 1.0
    w_code:         float = 1.0
    w_reasoning:    float = 1.0
    w_multi_turn:   float = 1.0

    def gene_vector(self) -> List[float]:
        """Flat numeric representation for GA operators."""
        return [
            float(self.threshold),
            self.w_token, self.w_code,
            self.w_reasoning, self.w_multi_turn,
        ]

    def label(self) -> str:
        return (f"{self.local_model}+{self.cloud_model}"
                f"@t{self.threshold}"
                f"_wt{self.w_token:.1f}wc{self.w_code:.1f}"
                f"wr{self.w_reasoning:.1f}wm{self.w_multi_turn:.1f}")


@dataclass
class TaskResult:
    task_id: str
    score:   float     # 0..1
    time_s:  float
    timed_out: bool


@dataclass
class FitnessResult:
    config:       RouterConfig
    fitness:      float            # combined score (higher = better)
    accuracy:     float            # mean PinchBench score 0..100%
    ttft_score:   float            # 1/(1+avg_ttft) normalised
    tps_score:    float            # avg TPS / 100 normalised
    cloud_ratio:  float            # fraction of requests that hit cloud
    tasks:        List[TaskResult] = field(default_factory=list)
    error:        Optional[str]    = None

    def summary(self) -> str:
        return (f"fit={self.fitness:.3f} "
                f"acc={self.accuracy:.1f}% "
                f"ttft={self.ttft_score:.3f} "
                f"tps={self.tps_score:.3f} "
                f"cloud={self.cloud_ratio:.0%}")


def _read_openclaw_config() -> Dict[str, Any]:
    if OPENCLAW_CONFIG.exists():
        return json.loads(OPENCLAW_CONFIG.read_text())
    return {}


def _write_openclaw_config(d: Dict[str, Any]) -> None:
    OPENCLAW_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    OPENCLAW_CONFIG.write_text(json.dumps(d, indent=2))


def _apply_router_config(config: RouterConfig, gw_token: str) -> None:
    """Write config to openclaw.json so the gateway picks it up on restart."""
    d = _read_openclaw_config()

    # Plugin config
    plugins = d.setdefault("plugins", {})
    entries = plugins.setdefault("entries", {})
    entry   = entries.setdefault("model_router", {})
    cfg     = entry.setdefault("config", {})
    cfg["aipingApiKey"]      = AIPING_KEY
    cfg["localModel"]        = config.local_model
    cfg["localProxyUrl"]     = "http://localhost:11434"
    cfg["cloudModel"]        = config.cloud_model
    cfg["routingThreshold"]  = config.threshold
    cfg["fallbackToCloud"]   = True
    cfg["debugRouting"]      = False
    cfg["pinchbenchHeuristics"] = True
    # Store rule weights as custom fields (router reads them if present)
    cfg["ruleWeights"] = {
        "token_count":     config.w_token,
        "code_complexity": config.w_code,
        "reasoning_depth": config.w_reasoning,
        "multi_turn":      config.w_multi_turn,
    }

    # aiping provider (gateway self-call)
    models = d.setdefault("models", {})
    providers = models.setdefault("providers", {})
    providers["aiping"] = {
        "baseUrl": f"http://127.0.0.1:{GATEWAY_PORT}/aiping/v1",
        "apiKey":  gw_token,
        "auth":    "api-key",
        "api":     "openai-completions",
        "models":  [{"id": "aiping:claw", "name": "AIPing Router"}],
    }
    d.setdefault("agents", {}).setdefault("defaults", {})["model"] = "aiping/aiping:claw"

    # Disable hot-reload to prevent mid-bench restarts
    d.setdefault("gateway", {}).setdefault("reload", {})["mode"] = "off"

    _write_openclaw_config(d)


def _restart_gateway() -> Optional[str]:
    """Kill and restart the OpenClaw gateway; return new auth token."""
    subprocess.run(
        ["pkill", "-f", "openclaw-gateway"],
        check=False, capture_output=True
    )
    time.sleep(2)

    log.info("Starting gateway on port %d…", GATEWAY_PORT)
    subprocess.Popen(
        ["openclaw", "gateway", "--port", str(GATEWAY_PORT), "--allow-unconfigured"],
        stdout=open(f"/tmp/gw-eval-{int(time.time())}.log", "w"),
        stderr=subprocess.STDOUT,
    )

    # Wait for gateway to be ready
    import urllib.request
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            urllib.request.urlopen(
                f"http://localhost:{GATEWAY_PORT}/aiping/health", timeout=2
            )
            break
        except Exception:
            time.sleep(1)

    # Read token
    d = _read_openclaw_config()
    return d.get("gateway", {}).get("auth", {}).get("token", "")


def _run_pinchbench(
    skill_dir: str,
    suite: str,
    runs: int,
    output_dir: str,
) -> Optional[Dict[str, Any]]:
    """Run PinchBench and return the parsed JSON result, or None on failure."""
    pathlib.Path(output_dir).mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                "uv", "run", "scripts/benchmark.py",
                "--model", "aiping/aiping:claw",
                "--suite", suite,
                "--runs", str(runs),
                "--output-dir", output_dir,
                "--no-upload",
            ],
            cwd=skill_dir,
            timeout=1800,
            check=True,
        )
    except subprocess.CalledProcessError as e:
        log.error("PinchBench failed: %s", e)
        return None
    except subprocess.TimeoutExpired:
        log.error("PinchBench timed out")
        return None

    results = sorted(pathlib.Path(output_dir).glob("*.json"))
    if not results:
        log.error("No result JSON found in %s", output_dir)
        return None
    return json.loads(results[-1].read_text())


def _extract_metrics(
    bench_data: Dict[str, Any],
    fitness_weights: Dict[str, float],
) -> FitnessResult:
    """Parse PinchBench JSON into a FitnessResult."""
    config_label = bench_data.get("model", "?")
    tasks_raw    = bench_data.get("tasks", [])
    efficiency   = bench_data.get("efficiency", {})

    task_results, scores = [], []
    for t in tasks_raw:
        mean = t.get("grading", {}).get("mean", 0.0)
        scores.append(mean)
        task_results.append(TaskResult(
            task_id   = t["task_id"],
            score     = mean,
            time_s    = t.get("execution_time", 0.0),
            timed_out = t.get("timed_out", False),
        ))

    accuracy = (sum(scores) / len(scores) * 100) if scores else 0.0

    # TTFT: use avg execution time / transcript length as proxy
    # (real TTFT requires streaming measurement; approximation here)
    avg_time = (sum(t.time_s for t in task_results) / len(task_results)
                if task_results else 30.0)
    ttft_score = 1.0 / (1.0 + avg_time / 60.0)   # normalised: 60s → 0.5

    # TPS from efficiency data if available
    tps_raw  = efficiency.get("throughput", {}).get("tokens_per_second", 0.0)
    tps_score = min(tps_raw / 100.0, 1.0) if tps_raw else 0.0

    # Cloud ratio: fraction of tasks that timed out (proxy for local failures)
    cloud_ratio = 0.3  # default assumption; replace with actual routing log

    wt = fitness_weights
    fitness = (
        accuracy / 100.0 * wt.get("accuracy", 0.6)
        + ttft_score       * wt.get("ttft",     0.2)
        + tps_score        * wt.get("tps",       0.1)
        - cloud_ratio      * wt.get("cost",      0.1)
    )

    return FitnessResult(
        config      = RouterConfig("?", "?", 0),  # filled by caller
        fitness     = max(0.0, fitness),
        accuracy    = accuracy,
        ttft_score  = ttft_score,
        tps_score   = tps_score,
        cloud_ratio = cloud_ratio,
        tasks       = task_results,
    )


def evaluate(
    config: RouterConfig,
    skill_dir: str,
    suite: str      = "automated-only",
    runs: int       = 1,
    fitness_weights: Optional[Dict[str, float]] = None,
    output_base: str = "/tmp/ga-eval",
) -> FitnessResult:
    """
    Full evaluation pipeline for a RouterConfig.
    Returns FitnessResult (fitness=-1 on hard failure).
    """
    weights = fitness_weights or {
        "accuracy": 0.6, "ttft": 0.2, "tps": 0.1, "cost": 0.1
    }

    log.info("▶ Evaluating: %s", config.label())

    # 1. Apply config and restart gateway
    gw_token = _restart_gateway()
    if not gw_token:
        log.warning("Could not get gateway token after restart, using empty string")
        gw_token = ""
    _apply_router_config(config, gw_token)
    time.sleep(2)  # let gateway pick up new config on next eval (it's reload=off)

    # 2. Run PinchBench
    out_dir = f"{output_base}/{config.label().replace('/', '_')}"
    bench_data = _run_pinchbench(skill_dir, suite, runs, out_dir)
    if bench_data is None:
        return FitnessResult(
            config=config, fitness=-1.0,
            accuracy=0, ttft_score=0, tps_score=0, cloud_ratio=1.0,
            error="PinchBench failed or timed out",
        )

    # 3. Parse metrics
    result = _extract_metrics(bench_data, weights)
    result.config = config
    log.info("  ← %s", result.summary())
    return result
