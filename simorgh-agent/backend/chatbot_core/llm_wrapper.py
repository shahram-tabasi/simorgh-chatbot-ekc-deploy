"""
Enhanced LLM Wrapper
====================
LLM wrapper with context-aware prompt templates.

Features:
- Prompt templates for each chat type (General, Project)
- Context rules enforcement
- Project knowledge restriction for project chats
- Stage-aware prompting for project sessions

Author: Simorgh Industrial Assistant
"""

import logging
import time
from typing import List, Dict, Any, Optional, Iterator
from dataclasses import dataclass, field

from .models import (
    ChatType,
    SessionStage,
    ChatContext,
    GeneralSessionContext,
    ProjectSessionContext,
    PromptTemplate,
    LLMResponse,
    DocumentContext,
    ChatHistoryEntry,
    ExternalSearchResult,
)

logger = logging.getLogger(__name__)


# =============================================================================
# DEFAULT PROMPT TEMPLATES
# =============================================================================

GENERAL_SYSTEM_TEMPLATE = """You are Simorgh, an expert industrial electrical engineering assistant.

Your role is to help users with:
- Electrical engineering questions and calculations
- Technical specifications and standards
- Document analysis and information extraction
- General engineering knowledge

Guidelines:
- Provide accurate, helpful responses
- Use technical terminology appropriately
- Reference uploaded documents when relevant
- You may use external search results when provided
- Be concise but thorough"""

GENERAL_CONTEXT_TEMPLATE = """## Session Information
User: {username}
Session ID: {chat_id}"""

GENERAL_DOCUMENT_TEMPLATE = """### Document: {filename}
Category: {category}
Summary: {summary}"""

PROJECT_SYSTEM_TEMPLATE = """You are Simorgh, an expert industrial electrical engineering assistant working on a specific project.

CRITICAL INSTRUCTIONS:
- You are working within Project {project_number}: {project_name}
- Your responses MUST reference ONLY project-specific knowledge and documents
- DO NOT provide general information that is not in the project context
- All answers should be grounded in the project's specifications, documents, and knowledge graph
- If information is not available in the project context, clearly state this

Your role is to help with:
- Project-specific document analysis
- Technical specifications from project documents
- Entity relationships in the project knowledge graph
- Project domain expertise ({project_domain})"""

PROJECT_CONTEXT_TEMPLATE = """## Project Context
Project Number: {project_number}
Project Name: {project_name}
Domain: {project_domain}
Current Stage: {stage}
User: {username}"""

PROJECT_DOCUMENT_TEMPLATE = """### Project Document: {filename}
Category: {category}
Summary: {summary}"""

PROJECT_GRAPH_TEMPLATE = """## Project Knowledge Graph Context
The following entities and relationships are relevant to this query:
{graph_context}"""

ANALYSIS_STAGE_TEMPLATE = """## Analysis Stage Instructions
You are in the ANALYSIS stage. During this stage:
- You MAY use external search results to gather additional context
- You MAY reference general knowledge to support analysis
- Focus on understanding project requirements and specifications
- Document any external sources used"""

DESIGN_STAGE_TEMPLATE = """## Design Stage Instructions
You are in the DESIGN stage. During this stage:
- Reference ONLY project documents and specifications
- DO NOT use external search or general knowledge
- All design decisions must be based on project requirements
- Cite specific documents for all recommendations"""

IMPLEMENTATION_STAGE_TEMPLATE = """## Implementation Stage Instructions
You are in the IMPLEMENTATION stage. During this stage:
- Reference ONLY project documents and specifications
- Provide precise, actionable guidance
- All instructions must be based on project specifications
- Reference specific standards and requirements from project documents"""

REVIEW_STAGE_TEMPLATE = """## Review Stage Instructions
You are in the REVIEW stage. During this stage:
- Reference ONLY project documents and specifications
- Verify compliance with project requirements
- Check against specifications from project documents
- Identify any deviations from project standards"""


# =============================================================================
# PROMPT TEMPLATE REGISTRY
# =============================================================================

class PromptTemplateRegistry:
    """Registry for prompt templates"""

    def __init__(self):
        self._templates: Dict[str, PromptTemplate] = {}
        self._register_defaults()

    def _register_defaults(self):
        """Register default prompt templates"""

        # General chat template
        general_template = PromptTemplate(
            template_id="general_default",
            name="General Chat Default",
            chat_type=ChatType.GENERAL,
            system_template=GENERAL_SYSTEM_TEMPLATE,
            context_template=GENERAL_CONTEXT_TEMPLATE,
            document_template=GENERAL_DOCUMENT_TEMPLATE,
        )
        self.register(general_template)

        # Project chat template
        project_template = PromptTemplate(
            template_id="project_default",
            name="Project Chat Default",
            chat_type=ChatType.PROJECT,
            system_template=PROJECT_SYSTEM_TEMPLATE,
            context_template=PROJECT_CONTEXT_TEMPLATE,
            document_template=PROJECT_DOCUMENT_TEMPLATE,
            project_template=PROJECT_GRAPH_TEMPLATE,
            stage_templates={
                SessionStage.ANALYSIS: ANALYSIS_STAGE_TEMPLATE,
                SessionStage.DESIGN: DESIGN_STAGE_TEMPLATE,
                SessionStage.IMPLEMENTATION: IMPLEMENTATION_STAGE_TEMPLATE,
                SessionStage.REVIEW: REVIEW_STAGE_TEMPLATE,
            },
        )
        self.register(project_template)

    def register(self, template: PromptTemplate):
        """Register a prompt template"""
        self._templates[template.template_id] = template
        logger.info(f"Registered prompt template: {template.name}")

    def get(self, template_id: str) -> Optional[PromptTemplate]:
        """Get a template by ID"""
        return self._templates.get(template_id)

    def get_for_chat_type(self, chat_type: ChatType) -> Optional[PromptTemplate]:
        """Get default template for a chat type"""
        default_id = f"{chat_type.value}_default"
        return self._templates.get(default_id)

    def list_templates(self) -> List[str]:
        """List all registered template IDs"""
        return list(self._templates.keys())


# Global template registry
_template_registry = PromptTemplateRegistry()


def get_template_registry() -> PromptTemplateRegistry:
    """Get the global template registry"""
    return _template_registry


# =============================================================================
# ENHANCED LLM WRAPPER
# =============================================================================

class EnhancedLLMWrapper:
    """
    Enhanced LLM wrapper with context-aware prompting.

    Features:
    - Automatic prompt template selection based on chat type
    - Context injection (history, documents, graph)
    - Project knowledge restriction enforcement
    - Stage-aware prompting
    - Response validation for project chats
    """

    def __init__(
        self,
        llm_service=None,
        template_registry: Optional[PromptTemplateRegistry] = None,
    ):
        """
        Initialize the wrapper.

        Args:
            llm_service: Underlying LLM service
            template_registry: Prompt template registry
        """
        self.llm = llm_service
        self.template_registry = template_registry or get_template_registry()

        # Statistics
        self.stats = {
            "total_requests": 0,
            "general_requests": 0,
            "project_requests": 0,
            "tokens_used": 0,
        }

        logger.info("EnhancedLLMWrapper initialized")

    def set_services(self, llm_service=None):
        """Update LLM service"""
        if llm_service:
            self.llm = llm_service

    # =========================================================================
    # PROMPT BUILDING
    # =========================================================================

    def build_system_prompt(
        self,
        context: ChatContext,
        template_id: Optional[str] = None,
    ) -> str:
        """
        Build complete system prompt for the given context.

        Args:
            context: Chat context (GeneralSessionContext or ProjectSessionContext)
            template_id: Optional specific template ID

        Returns:
            Complete system prompt string
        """
        # Get template
        if template_id:
            template = self.template_registry.get(template_id)
        else:
            template = self.template_registry.get_for_chat_type(context.chat_type)

        if not template:
            logger.warning(f"No template found for {context.chat_type}, using default")
            return GENERAL_SYSTEM_TEMPLATE

        prompt_parts = []

        # Build main system prompt
        if isinstance(context, ProjectSessionContext) and context.project:
            system_prompt = template.system_template.format(
                project_number=context.project.project_number,
                project_name=context.project.project_name,
                project_domain=context.project.domain or "industrial electrical",
            )
        else:
            system_prompt = template.system_template

        prompt_parts.append(system_prompt)

        # Add context section
        if template.context_template:
            if isinstance(context, ProjectSessionContext) and context.project:
                context_section = template.context_template.format(
                    project_number=context.project.project_number,
                    project_name=context.project.project_name,
                    project_domain=context.project.domain or "industrial electrical",
                    stage=context.stage.value,
                    username=context.user.username or "User",
                    chat_id=context.chat_id,
                )
            else:
                context_section = template.context_template.format(
                    username=context.user.username or "User",
                    chat_id=context.chat_id,
                )
            prompt_parts.append(context_section)

        # Add stage-specific instructions for project chats
        if isinstance(context, ProjectSessionContext):
            if context.stage in template.stage_templates:
                stage_section = template.stage_templates[context.stage]
                prompt_parts.append(stage_section)

            # Add graph context if available
            if context.graph_context and template.project_template:
                graph_section = template.project_template.format(
                    graph_context=context.graph_context
                )
                prompt_parts.append(graph_section)

        return "\n\n".join(prompt_parts)

    def build_messages(
        self,
        context: ChatContext,
        current_message: str,
        include_documents: bool = True,
        include_search_results: bool = True,
        max_history: int = 20,
    ) -> List[Dict[str, str]]:
        """
        Build complete message list for LLM API.

        Args:
            context: Chat context
            current_message: Current user message
            include_documents: Whether to include document context
            include_search_results: Whether to include search results
            max_history: Maximum history messages to include

        Returns:
            List of messages in OpenAI format
        """
        messages = []

        # System message
        system_prompt = self.build_system_prompt(context)

        # Add document context to system prompt
        if include_documents and context.documents:
            doc_context = self._format_documents(context)
            if doc_context:
                system_prompt += f"\n\n## Available Documents\n{doc_context}"

        # For project chats, add project documents
        if isinstance(context, ProjectSessionContext):
            if context.project_documents:
                proj_doc_context = self._format_documents_list(
                    context.project_documents,
                    "Project Documents"
                )
                if proj_doc_context:
                    system_prompt += f"\n\n{proj_doc_context}"

            if context.process_documents:
                proc_doc_context = self._format_documents_list(
                    context.process_documents,
                    "Process Documents"
                )
                if proc_doc_context:
                    system_prompt += f"\n\n{proc_doc_context}"

        messages.append({"role": "system", "content": system_prompt})

        # Add chat history
        history = context.history_window[:max_history] if context.history_window else []

        # For project chats, also include cross-chat history
        if isinstance(context, ProjectSessionContext) and context.cross_chat_history:
            # Merge and sort by timestamp
            all_history = history + context.cross_chat_history[:10]
            all_history.sort(key=lambda x: x.timestamp if isinstance(x, ChatHistoryEntry) else x.get("timestamp", ""))
            history = all_history[:max_history]

        for entry in history:
            if isinstance(entry, ChatHistoryEntry):
                messages.append({
                    "role": entry.role,
                    "content": entry.content,
                })
            else:
                messages.append({
                    "role": entry.get("role", "user"),
                    "content": entry.get("content") or entry.get("text", ""),
                })

        # Add external search results if available and allowed
        if include_search_results:
            search_context = self._format_search_results(context)
            if search_context:
                # Inject as assistant context before user message
                messages.append({
                    "role": "assistant",
                    "content": f"I found the following relevant information:\n{search_context}"
                })

        # Add current user message
        messages.append({"role": "user", "content": current_message})

        return messages

    def _format_documents(self, context: ChatContext) -> str:
        """Format document context"""
        if not context.documents:
            return ""

        parts = []
        for doc in context.documents[:5]:  # Limit to 5 documents
            if isinstance(doc, DocumentContext):
                part = f"- **{doc.filename}** ({doc.category.value})"
                if doc.content_summary:
                    part += f": {doc.content_summary[:200]}..."
            else:
                part = f"- **{doc.get('filename', 'Unknown')}**"
                if doc.get("content_summary"):
                    part += f": {doc['content_summary'][:200]}..."
            parts.append(part)

        return "\n".join(parts)

    def _format_documents_list(
        self,
        documents: List[DocumentContext],
        title: str,
    ) -> str:
        """Format a list of documents with a title"""
        if not documents:
            return ""

        parts = [f"## {title}"]
        for doc in documents[:5]:
            if isinstance(doc, DocumentContext):
                part = f"- **{doc.filename}** ({doc.category.value})"
                if doc.content_summary:
                    part += f": {doc.content_summary[:200]}..."
            else:
                part = f"- **{doc.get('filename', 'Unknown')}**"
            parts.append(part)

        return "\n".join(parts)

    def _format_search_results(self, context: ChatContext) -> str:
        """Format external search results"""
        results = []

        if isinstance(context, GeneralSessionContext):
            results = context.external_search_results
        elif isinstance(context, ProjectSessionContext):
            # Only include search results if in analysis stage
            if context.allows_external_tools:
                results = context.external_search_results

        if not results:
            return ""

        parts = []
        for result in results[:3]:  # Limit to 3 results
            if isinstance(result, ExternalSearchResult):
                parts.append(f"**{result.title}** ({result.source})")
                parts.append(f"{result.content[:300]}...")
                if result.url:
                    parts.append(f"Source: {result.url}")
            else:
                parts.append(f"**{result.get('title', 'Result')}**")
                if result.get("content"):
                    parts.append(f"{result['content'][:300]}...")
            parts.append("")

        return "\n".join(parts)

    # =========================================================================
    # GENERATION METHODS
    # =========================================================================

    async def generate(
        self,
        context: ChatContext,
        current_message: str,
        mode: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
        use_cache: bool = True,
        include_documents: bool = True,
        include_search_results: bool = True,
        validate_response: bool = True,
    ) -> LLMResponse:
        """
        Generate LLM response with context-aware prompting.

        Args:
            context: Chat context
            current_message: User's message
            mode: LLM mode (online/offline/auto)
            temperature: Sampling temperature
            max_tokens: Max tokens to generate
            use_cache: Whether to use response caching
            include_documents: Include document context
            include_search_results: Include search results
            validate_response: Validate project responses

        Returns:
            LLMResponse with generation result
        """
        start_time = time.time()
        self.stats["total_requests"] += 1

        if context.chat_type == ChatType.GENERAL:
            self.stats["general_requests"] += 1
        else:
            self.stats["project_requests"] += 1

        if not self.llm:
            return LLMResponse(
                success=False,
                content="",
                model="",
                mode="",
                error="LLM service not available",
                latency_ms=(time.time() - start_time) * 1000,
            )

        try:
            # Build messages
            messages = self.build_messages(
                context=context,
                current_message=current_message,
                include_documents=include_documents,
                include_search_results=include_search_results,
            )

            # Generate response
            result = self.llm.generate(
                messages=messages,
                mode=mode,
                temperature=temperature,
                max_tokens=max_tokens,
                use_cache=use_cache,
            )

            response_content = result.get("response", "")
            model = result.get("model", "unknown")
            llm_mode = result.get("mode", "unknown")
            tokens = result.get("tokens", {})
            cached = result.get("cached", False)

            # Track tokens
            self.stats["tokens_used"] += tokens.get("total", 0)

            # Validate response for project chats
            sources_referenced = []
            if validate_response and isinstance(context, ProjectSessionContext):
                validation = self._validate_project_response(
                    response_content,
                    context,
                )
                if not validation["valid"]:
                    logger.warning(f"Project response validation failed: {validation['issues']}")
                sources_referenced = validation.get("sources", [])

            latency = (time.time() - start_time) * 1000

            return LLMResponse(
                success=True,
                content=response_content,
                model=model,
                mode=llm_mode,
                tokens_used=tokens.get("total", 0),
                cached=cached,
                sources_referenced=sources_referenced,
                metadata={
                    "prompt_tokens": tokens.get("prompt", 0),
                    "completion_tokens": tokens.get("completion", 0),
                    "chat_type": context.chat_type.value,
                },
                latency_ms=latency,
            )

        except Exception as e:
            logger.error(f"LLM generation error: {e}")
            return LLMResponse(
                success=False,
                content="",
                model="",
                mode="",
                error=str(e),
                latency_ms=(time.time() - start_time) * 1000,
            )

    def generate_stream(
        self,
        context: ChatContext,
        current_message: str,
        mode: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
        include_documents: bool = True,
        include_search_results: bool = True,
    ) -> Iterator[str]:
        """
        Generate streaming LLM response.

        Args:
            context: Chat context
            current_message: User's message
            mode: LLM mode
            temperature: Sampling temperature
            max_tokens: Max tokens
            include_documents: Include document context
            include_search_results: Include search results

        Yields:
            Response chunks
        """
        self.stats["total_requests"] += 1

        if context.chat_type == ChatType.GENERAL:
            self.stats["general_requests"] += 1
        else:
            self.stats["project_requests"] += 1

        if not self.llm:
            yield "Error: LLM service not available"
            return

        try:
            # Build messages
            messages = self.build_messages(
                context=context,
                current_message=current_message,
                include_documents=include_documents,
                include_search_results=include_search_results,
            )

            # Stream response
            for chunk in self.llm.generate_stream(
                messages=messages,
                mode=mode,
                temperature=temperature,
                max_tokens=max_tokens,
            ):
                yield chunk

        except Exception as e:
            logger.error(f"LLM streaming error: {e}")
            yield f"Error: {str(e)}"

    # =========================================================================
    # RESPONSE VALIDATION
    # =========================================================================

    def _validate_project_response(
        self,
        response: str,
        context: ProjectSessionContext,
    ) -> Dict[str, Any]:
        """
        Validate that project response references project knowledge.

        Args:
            response: Generated response
            context: Project context

        Returns:
            Validation result with issues list
        """
        issues = []
        sources = []

        # Check if response mentions project-related terms
        project_terms = []
        if context.project:
            project_terms.extend([
                context.project.project_number,
                context.project.project_name,
            ])

        # Check for document references
        doc_names = [d.filename for d in context.project_documents if isinstance(d, DocumentContext)]
        doc_names.extend([d.filename for d in context.process_documents if isinstance(d, DocumentContext)])

        # Check if any document is referenced
        for doc_name in doc_names:
            if doc_name.lower() in response.lower():
                sources.append(doc_name)

        # Validation checks (soft - just for logging)
        # In production, could add more sophisticated checks

        return {
            "valid": True,  # Currently soft validation
            "issues": issues,
            "sources": sources,
        }

    # =========================================================================
    # UTILITIES
    # =========================================================================

    def get_stats(self) -> Dict[str, Any]:
        """Get wrapper statistics"""
        return {
            **self.stats,
            "templates_available": self.template_registry.list_templates(),
        }

    def reset_stats(self):
        """Reset statistics"""
        self.stats = {
            "total_requests": 0,
            "general_requests": 0,
            "project_requests": 0,
            "tokens_used": 0,
        }


# =============================================================================
# SINGLETON
# =============================================================================

_llm_wrapper: Optional[EnhancedLLMWrapper] = None


def get_llm_wrapper(
    llm_service=None,
    template_registry: Optional[PromptTemplateRegistry] = None,
) -> EnhancedLLMWrapper:
    """Get or create LLM wrapper singleton"""
    global _llm_wrapper

    if _llm_wrapper is None:
        _llm_wrapper = EnhancedLLMWrapper(
            llm_service=llm_service,
            template_registry=template_registry,
        )
    elif llm_service:
        _llm_wrapper.set_services(llm_service=llm_service)

    return _llm_wrapper
