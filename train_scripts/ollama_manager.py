#!/usr/bin/env python3
"""
ollama_manager.py — Start/stop/switch Ollama with a specific model.

Handles:
  - Downloading GGUF from ModelScope via modelscope-cli
  - Converting to Ollama Modelfile
  - Pulling via `ollama pull` if already on Ollama hub
  - Health-check waiting
  - GPU layer configuration for multi-GPU servers
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
MODELSCOPE_CACHE = Path(os.environ.get("MODELSCOPE_CACHE", Path.home() / ".modelscope" / "gguf"))


@dataclass
class ModelSpec:
    """Everything needed to provision a local model."""
    ollama_id: str           # e.g. "qwen2.5:7b"
    modelscope: Optional[str] = None  # e.g. "ggml-org/Qwen2.5-7B-Instruct-GGUF"
    file: Optional[str] = None        # e.g. "qwen2.5-7b-instruct-q4_k_m.gguf"
    min_vram_gb: float = 4.0


def wait_for_ollama(timeout: int = 30) -> bool:
    """Poll until Ollama API responds."""
    import urllib.request, urllib.error
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=3)
            return True
        except Exception:
            time.sleep(1)
    return False


def is_model_loaded(model_id: str) -> bool:
    """Check if model is already pulled in Ollama."""
    import urllib.request, urllib.error, json
    try:
        with urllib.request.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=5) as r:
            data = json.loads(r.read())
        models = [m["name"] for m in data.get("models", [])]
        base = model_id.split(":")[0]
        return any(m == model_id or m.startswith(base + ":") for m in models)
    except Exception:
        return False


def pull_from_hub(model_id: str) -> bool:
    """Pull model from Ollama hub (works for models in the official registry)."""
    log.info("Pulling %s from Ollama hub…", model_id)
    result = subprocess.run(
        ["ollama", "pull", model_id],
        timeout=600,
        check=False,
    )
    return result.returncode == 0


def download_from_modelscope(spec: ModelSpec, gpu_layers: int = 99) -> bool:
    """
    Download GGUF from ModelScope and register it with Ollama via Modelfile.
    Requires: pip install modelscope
    """
    if not spec.modelscope or not spec.file:
        return False

    MODELSCOPE_CACHE.mkdir(parents=True, exist_ok=True)
    local_path = MODELSCOPE_CACHE / spec.file

    if not local_path.exists():
        log.info("Downloading %s / %s from ModelScope…", spec.modelscope, spec.file)
        result = subprocess.run(
            [
                "modelscope", "download",
                "--model", spec.modelscope,
                "--local_dir", str(MODELSCOPE_CACHE),
                spec.file,
            ],
            timeout=3600,
            check=False,
        )
        if result.returncode != 0:
            log.error("ModelScope download failed for %s", spec.modelscope)
            return False

    if not local_path.exists():
        log.error("Expected file not found after download: %s", local_path)
        return False

    log.info("Creating Ollama Modelfile for %s", spec.ollama_id)
    modelfile_content = f"""FROM {local_path}
PARAMETER num_gpu {gpu_layers}
PARAMETER num_ctx 4096
"""
    with tempfile.NamedTemporaryFile("w", suffix=".Modelfile", delete=False) as f:
        f.write(modelfile_content)
        modelfile_path = f.name

    try:
        result = subprocess.run(
            ["ollama", "create", spec.ollama_id, "-f", modelfile_path],
            timeout=120,
            check=False,
        )
        return result.returncode == 0
    finally:
        Path(modelfile_path).unlink(missing_ok=True)


def ensure_model_available(spec: ModelSpec, gpu_layers: int = 99) -> bool:
    """
    Ensure the model is available in Ollama, downloading if necessary.
    Strategy:
      1. Already loaded → done
      2. Try Ollama hub pull
      3. Fall back to ModelScope download
    """
    if not wait_for_ollama(timeout=15):
        log.error("Ollama service not reachable at %s", OLLAMA_HOST)
        return False

    if is_model_loaded(spec.ollama_id):
        log.info("Model %s already available", spec.ollama_id)
        return True

    # Try Ollama hub first (fast, no extra deps)
    if pull_from_hub(spec.ollama_id):
        log.info("Pulled %s from Ollama hub", spec.ollama_id)
        return True

    # Fall back to ModelScope
    if spec.modelscope:
        log.info("Falling back to ModelScope for %s", spec.ollama_id)
        if download_from_modelscope(spec, gpu_layers=gpu_layers):
            log.info("Registered %s from ModelScope GGUF", spec.ollama_id)
            return True

    log.error("Failed to provision model: %s", spec.ollama_id)
    return False


def quick_inference_test(model_id: str, prompt: str = "Reply OK") -> Optional[float]:
    """
    Run a single inference and return latency in seconds (TTFT approximation).
    Returns None on failure.
    """
    import urllib.request, urllib.error, json
    payload = json.dumps({
        "model": model_id,
        "prompt": prompt,
        "stream": False,
        "options": {"num_predict": 5},
    }).encode()

    try:
        start = time.perf_counter()
        req = urllib.request.Request(
            f"{OLLAMA_HOST}/api/generate",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            elapsed = time.perf_counter() - start
            data = json.loads(r.read())
            return elapsed
    except Exception as e:
        log.warning("Inference test failed for %s: %s", model_id, e)
        return None
