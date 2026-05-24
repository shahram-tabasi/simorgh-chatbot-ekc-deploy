"""CoT plan registry. Plans are specialized chain-of-thought
strategies that the master router picks based on (source state,
upload state, input modality, prior plan).

Phase 2 ships only the abstract base + DefaultPlan; Phase 3 adds
the per-source specializations (KnowledgeOnly, SingleRepo,
MultiRepo, UploadDeep, RepoPlusUpload, VoiceFirst).
"""
from .base import CotPlan, PlanContext, PlanGrounding
from .default import DefaultPlan

__all__ = ["CotPlan", "PlanContext", "PlanGrounding", "DefaultPlan"]
