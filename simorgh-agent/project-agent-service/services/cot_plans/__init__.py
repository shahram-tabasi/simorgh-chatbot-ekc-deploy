"""CoT plan registry. Plans are specialized chain-of-thought
strategies that the master router picks based on (source state,
upload state, input modality, prior plan).

Phase 3 ships six specialized plans on top of the Phase 2 DefaultPlan
fallback. The router dispatches based on PlanContext signature:

  KnowledgeOnlyPlan   — no source, no upload (the pure "ask the
                         knowledge base" case)
  SingleRepoPlan       — exactly one repo selected; deterministic
                         tree-first exploration order
  MultiRepoPlan        — 2+ repos selected; parallel-search + merge
  UploadDeepPlan       — upload only; investigative posture; Phase 4
                         adds MapReduce for >200K-char uploads
  RepoPlusUploadPlan   — repo + upload; cross-reference posture
  VoiceFirstPlan       — voice modality, no upload; conversational
                         tone overlay on KnowledgeOnly grounding

DefaultPlan stays as the fallback when no signature matches (defensive
catch-all in case future PlanContext fields slip through).
"""
from .base import CotPlan, PlanContext, PlanGrounding
from .default import DefaultPlan
from .knowledge_only import KnowledgeOnlyPlan
from .single_repo import SingleRepoPlan
from .multi_repo import MultiRepoPlan
from .upload_deep import UploadDeepPlan
from .repo_plus_upload import RepoPlusUploadPlan
from .voice_first import VoiceFirstPlan
from .techserver import TechserverPlan

__all__ = [
    "CotPlan", "PlanContext", "PlanGrounding",
    "DefaultPlan",
    "KnowledgeOnlyPlan", "SingleRepoPlan", "MultiRepoPlan",
    "UploadDeepPlan", "RepoPlusUploadPlan", "VoiceFirstPlan",
    "TechserverPlan",
]
