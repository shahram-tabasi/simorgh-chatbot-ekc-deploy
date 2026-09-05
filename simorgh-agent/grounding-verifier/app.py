"""
grounding-verifier service — HHEM-2.1-Open CPU sidecar on .68.

Single endpoint POST /verify: given a list of (premise, hypothesis)
pairs, returns the HHEM faithfulness score (∈ [0, 1]) for each. The
agent's post-pass calls this after the numeric/standards regex check
in services/grounding_verifier.py.

HHEM-2.1-Open: 184M DeBERTa-v3-base derivative trained for hallucination
detection; ~600 MB at FP32 weights, runs comfortably on CPU; the
canonical NLI-style faithfulness model used in the 2024-2026 RAG
research (HALT-RAG, RAGAS, Vectara).

Reference: https://huggingface.co/vectara/hallucination_evaluation_model
"""
from __future__ import annotations

import logging
import os
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("grounding-verifier")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")

MODEL_NAME    = os.getenv("HHEM_MODEL", "vectara/hallucination_evaluation_model")
MODEL_CACHE   = os.getenv("HF_HOME", "/root/.cache/huggingface")
HF_OFFLINE    = os.getenv("HF_HUB_OFFLINE", "1") not in ("0", "false", "off")
# Threshold below which a hypothesis is flagged as unfaithful. HHEM
# outputs a probability of "supported"; 0.5 is the canonical cutoff.
DEFAULT_THRESHOLD = float(os.getenv("HHEM_THRESHOLD", "0.5"))

app = FastAPI(title="grounding-verifier", version="1.0.0")

# ---------------------------------------------------------------------------
# Lazy model load — warmed on first /verify call, not import. Keeps the
# /health probe answering before the ~3 GB working-set load completes.
# ---------------------------------------------------------------------------
_model = None
_loaded_at = None


def _load_model():
    global _model, _loaded_at
    if _model is not None:
        return _model
    import time as _t
    t0 = _t.perf_counter()
    logger.info("loading HHEM (%s); offline=%s", MODEL_NAME, HF_OFFLINE)
    if HF_OFFLINE:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from transformers import AutoModelForSequenceClassification
    _model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_NAME, trust_remote_code=True, cache_dir=MODEL_CACHE,
    )
    _model.eval()
    _loaded_at = _t.perf_counter()
    dur = _loaded_at - t0
    logger.info("HHEM loaded in %.1fs", dur)
    return _model


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class Pair(BaseModel):
    premise:    str = Field(..., description="The source passage / chunk.")
    hypothesis: str = Field(..., description="The model claim to verify.")


class VerifyRequest(BaseModel):
    pairs:     List[Pair]
    threshold: float = Field(DEFAULT_THRESHOLD, ge=0.0, le=1.0)


class PairResult(BaseModel):
    score:    float
    verified: bool


class VerifyResponse(BaseModel):
    threshold: float
    results:   List[PairResult]
    # Total verified count for cheap log lines.
    verified_count:   int
    total:            int


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "grounding-verifier",
        "model": MODEL_NAME,
        "model_loaded": _model is not None,
    }


@app.post("/verify", response_model=VerifyResponse)
def verify(req: VerifyRequest) -> VerifyResponse:
    if not req.pairs:
        return VerifyResponse(threshold=req.threshold, results=[],
                              verified_count=0, total=0)
    try:
        model = _load_model()
    except Exception as e:
        logger.exception("model load failed")
        raise HTTPException(
            status_code=503,
            detail=f"HHEM not loaded: {e!s}. "
                   f"Ensure the model dir is mounted and HF_HUB_OFFLINE=1.",
        )
    # HHEM-2.1-Open accepts a list of (premise, hypothesis) pairs through
    # its custom predict() method (see model card). Returns a tensor of
    # shape [N] with consistency scores in [0,1].
    pairs = [(p.premise, p.hypothesis) for p in req.pairs]
    try:
        scores = model.predict(pairs)
        # The model returns a torch tensor; .tolist() handles both 0d/1d.
        scores_list = scores.detach().cpu().tolist() \
            if hasattr(scores, "tolist") else list(scores)
    except Exception as e:
        logger.exception("HHEM predict failed")
        raise HTTPException(status_code=500, detail=f"predict failed: {e!s}")
    out = [
        PairResult(score=float(s), verified=float(s) >= req.threshold)
        for s in scores_list
    ]
    verified = sum(1 for r in out if r.verified)
    logger.info("verify: %d pairs, %d verified at threshold=%.2f",
                len(out), verified, req.threshold)
    return VerifyResponse(
        threshold=req.threshold, results=out,
        verified_count=verified, total=len(out),
    )


@app.post("/warmup")
def warmup() -> dict:
    """Eager-load the model on demand (used by the compose healthcheck
    or by the operator to amortise the load time before the first user
    query)."""
    _load_model()
    return {"loaded": True, "model": MODEL_NAME}
