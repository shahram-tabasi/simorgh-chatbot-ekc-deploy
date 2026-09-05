"""
Conversation Memory Service
============================
Manages long-term conversation memory using Qdrant with LLM summarization.
Provides semantic search and chronological fallback for past context retrieval.

Author: Simorgh Industrial Assistant
"""

import logging
from typing import List, Dict, Any, Optional
from datetime import datetime
import uuid

logger = logging.getLogger(__name__)


class ConversationMemoryService:
    """
    Conversation memory service with LLM summarization and semantic retrieval
    """

    def __init__(self, qdrant_service, llm_service):
        """
        Initialize Conversation Memory Service

        Args:
            qdrant_service: QdrantService instance
            llm_service: LLMService instance for summarization
        """
        self.qdrant = qdrant_service
        self.llm = llm_service

    def store_conversation(
        self,
        user_id: str,
        user_message: str,
        ai_response: str,
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Store conversation with LLM summarization in session-specific collection

        Pipeline:
        1. Concatenate user query + AI response
        2. Generate LLM summary of the conversation
        3. Embed the summary
        4. Store in session-specific Qdrant collection

        Args:
            user_id: User identifier
            user_message: User's message
            ai_response: AI's response
            session_id: Optional session ID for general chats
            project_oenum: Optional project OE number for project chats
            metadata: Optional additional metadata

        Returns:
            True if successful
        """
        try:
            # 1. Concatenate conversation
            conversation_text = f"User: {user_message}\nAI: {ai_response}"

            # 2. Generate LLM summary
            logger.info(f"📝 Generating conversation summary...")
            summary = self._summarize_conversation(conversation_text)

            if not summary:
                logger.warning(f"⚠️ Failed to generate summary, using original text")
                summary = conversation_text[:500]  # Fallback: truncate

            # 3. Generate embedding from summary
            logger.info(f"🔄 Generating embedding from summary...")
            embedding = self.qdrant.generate_embedding(summary)

            # 4. Prepare payload
            conversation_id = str(uuid.uuid4())
            timestamp = datetime.utcnow().isoformat()

            payload = {
                "user_id": user_id,
                "user_message": user_message,
                "ai_response": ai_response,
                "conversation_text": conversation_text,
                "summary": summary,
                "timestamp": timestamp,
                "storage_type": "conversation_memory",
                "metadata": metadata or {}
            }

            # Add session context
            if project_oenum:
                payload["project_oenum"] = project_oenum
            if session_id:
                payload["session_id"] = session_id

            # 5. Create point
            from qdrant_client.models import PointStruct

            point = PointStruct(
                id=conversation_id,
                vector=embedding,
                payload=payload
            )

            # 6. Store in session-specific collection
            collection_name = self.qdrant._get_collection_name(user_id, session_id, project_oenum)

            # Ensure collection exists
            self.qdrant.ensure_collection_exists(user_id, session_id, project_oenum)

            # Upsert point
            self.qdrant.client.upsert(
                collection_name=collection_name,
                points=[point]
            )

            logger.info(f"✅ Stored conversation memory: {conversation_id[:8]}...")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to store conversation: {e}", exc_info=True)
            return False

    def retrieve_relevant_context(
        self,
        user_id: str,
        current_query: str,
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None,
        top_k: int = 5,
        score_threshold: float = 0.6,
        fallback_to_chronological: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Retrieve relevant past conversations using semantic search + chronological fallback

        Strategy:
        1. Perform semantic search for top K most relevant conversations
        2. If no results with sufficient score, fallback to last K chronological conversations
        3. Return formatted context for LLM prompt

        Args:
            user_id: User identifier
            current_query: Current user query
            session_id: Optional session ID for general chats
            project_oenum: Optional project OE number for project chats
            top_k: Number of conversations to retrieve (default: 5)
            score_threshold: Minimum similarity score (default: 0.6)
            fallback_to_chronological: If True, fallback to recent conversations (default: True)

        Returns:
            List of relevant conversations with scores
        """
        try:
            collection_name = self.qdrant._get_collection_name(user_id, session_id, project_oenum)

            # Check if collection exists
            collections = self.qdrant.client.get_collections().collections
            exists = any(c.name == collection_name for c in collections)

            if not exists:
                logger.info(f"ℹ️ No conversation history for this session yet")
                return []

            # Generate query embedding
            query_embedding = self.qdrant.generate_embedding(current_query)

            # Prepare filter for conversation memory only
            from qdrant_client.models import Filter, FieldCondition, MatchValue

            search_filter = Filter(
                must=[
                    FieldCondition(
                        key="storage_type",
                        match=MatchValue(value="conversation_memory")
                    )
                ]
            )

            # Semantic search with score threshold
            logger.info(f"🔍 Searching for relevant past conversations...")
            results = self.qdrant.client.search(
                collection_name=collection_name,
                query_vector=query_embedding,
                limit=top_k,
                query_filter=search_filter,
                score_threshold=score_threshold
            )

            # Format results
            relevant_conversations = []
            for result in results:
                relevant_conversations.append({
                    "conversation_id": result.id,
                    "score": result.score,
                    "user_message": result.payload.get("user_message", ""),
                    "ai_response": result.payload.get("ai_response", ""),
                    "summary": result.payload.get("summary", ""),
                    "timestamp": result.payload.get("timestamp", ""),
                    "is_semantic_match": True
                })

            # If no semantic matches and fallback enabled, get recent chronological conversations
            if len(relevant_conversations) == 0 and fallback_to_chronological:
                logger.info(f"💡 No semantic matches, falling back to {top_k} most recent conversations")

                # Search without score threshold
                all_results = self.qdrant.client.search(
                    collection_name=collection_name,
                    query_vector=query_embedding,
                    limit=top_k * 2,  # Get more to ensure we have enough after sorting
                    query_filter=search_filter,
                    score_threshold=None
                )

                # Sort by timestamp (most recent first)
                sorted_results = sorted(
                    all_results,
                    key=lambda x: x.payload.get("timestamp", ""),
                    reverse=True
                )[:top_k]

                # Format chronological results
                for result in sorted_results:
                    relevant_conversations.append({
                        "conversation_id": result.id,
                        "score": result.score,
                        "user_message": result.payload.get("user_message", ""),
                        "ai_response": result.payload.get("ai_response", ""),
                        "summary": result.payload.get("summary", ""),
                        "timestamp": result.payload.get("timestamp", ""),
                        "is_semantic_match": False,
                        "is_chronological_fallback": True
                    })

                logger.info(f"📚 Retrieved {len(relevant_conversations)} recent conversations")
            else:
                logger.info(f"✅ Found {len(relevant_conversations)} semantically relevant conversations")

            return relevant_conversations

        except Exception as e:
            logger.error(f"❌ Failed to retrieve conversation context: {e}", exc_info=True)
            return []

    def format_context_for_llm(self, conversations: List[Dict[str, Any]]) -> str:
        """
        Format retrieved conversations as context for LLM prompt

        Args:
            conversations: List of relevant conversations

        Returns:
            Formatted context string
        """
        if not conversations:
            return ""

        context_parts = ["## Past Conversation Context\n"]
        context_parts.append("Here are relevant past conversations from this session:\n")

        for idx, conv in enumerate(conversations, 1):
            is_semantic = conv.get("is_semantic_match", False)
            match_type = "Semantically Relevant" if is_semantic else "Recent"

            context_parts.append(f"\n### {match_type} Conversation {idx}")
            context_parts.append(f"**User**: {conv['user_message']}")
            context_parts.append(f"**AI**: {conv['ai_response'][:200]}...")  # Truncate for brevity
            context_parts.append("")

        return "\n".join(context_parts)

    def _summarize_conversation(self, conversation_text: str) -> str:
        """
        Generate LLM summary of conversation

        Args:
            conversation_text: Full conversation text

        Returns:
            Summary text
        """
        try:
            system_prompt = """You are a conversation summarizer. Given a conversation between a user and an AI assistant, generate a concise 2-3 sentence summary that captures:
1. The main topic or question
2. Key points discussed
3. Important information or conclusions

Be concise but preserve technical details and key facts."""

            user_prompt = f"Summarize this conversation:\n\n{conversation_text}"

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ]

            # Use offline mode for speed, no caching for summaries
            result = self.llm.generate(
                messages=messages,
                mode="offline",
                temperature=0.3,
                max_tokens=150,
                use_cache=False
            )

            summary = result.get("response", "").strip()

            if not summary:
                logger.warning(f"⚠️ Empty summary returned from LLM")
                return conversation_text[:300]  # Fallback

            logger.info(f"✅ Generated summary: {len(summary)} chars")
            return summary

        except Exception as e:
            logger.error(f"❌ LLM summarization failed: {e}")
            # Fallback: use first 300 chars of conversation
            return conversation_text[:300]

    def get_conversation_stats(
        self,
        user_id: str,
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get conversation memory statistics for a session

        Args:
            user_id: User identifier
            session_id: Optional session ID for general chats
            project_oenum: Optional project OE number for project chats

        Returns:
            Statistics dictionary
        """
        try:
            collection_name = self.qdrant._get_collection_name(user_id, session_id, project_oenum)

            # Check if collection exists
            collections = self.qdrant.client.get_collections().collections
            exists = any(c.name == collection_name for c in collections)

            if not exists:
                return {
                    "conversation_count": 0,
                    "exists": False
                }

            # Count conversation memory entries
            from qdrant_client.models import Filter, FieldCondition, MatchValue

            filter_conversations = Filter(
                must=[
                    FieldCondition(
                        key="storage_type",
                        match=MatchValue(value="conversation_memory")
                    )
                ]
            )

            # Scroll to count
            scroll_result = self.qdrant.client.scroll(
                collection_name=collection_name,
                scroll_filter=filter_conversations,
                limit=1000
            )

            conversation_count = len(scroll_result[0])

            return {
                "conversation_count": conversation_count,
                "exists": True,
                "collection_name": collection_name
            }

        except Exception as e:
            logger.error(f"❌ Failed to get conversation stats: {e}")
            return {
                "conversation_count": 0,
                "exists": False,
                "error": str(e)
            }
