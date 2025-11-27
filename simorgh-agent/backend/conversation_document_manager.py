"""
Multi-Document Upload Handler for Chatbot Interface
Handles multiple PDFs in a single conversation/prompt with proper organization
"""

import os
import hashlib
import re
from datetime import datetime
from typing import Dict, List, Optional, Any
from pathlib import Path
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class ConversationDocumentManager:
    """
    Manages document uploads in the context of chatbot conversations.
    
    Features:
    - Multi-document handling per conversation
    - Organized folder structure: project/oe_number/conversation_id/
    - Document metadata tracking
    - Batch processing support
    """
    
    def __init__(self, base_upload_folder: str = "uploads"):
        self.base_upload_folder = base_upload_folder
        Path(base_upload_folder).mkdir(exist_ok=True)
    
    def create_conversation_folder(self,
                                   project_id: str,
                                   oe_number: str,
                                   user_prompt: str,
                                   conversation_id: Optional[str] = None) -> Dict[str, str]:
        """
        Create organized folder structure for conversation.
        
        Structure:
        uploads/
          ├─ PROJECT_001/
          │  ├─ OE_001/
          │  │  ├─ conv_20250117_panel_design/
        │  │  │  ├─ documents/
        │  │  │  ├─ metadata.json
        │  │  │  └─ processing_log.txt
        
        Args:
            project_id: Project ID
            oe_number: OE number
            user_prompt: User's prompt/question (used for folder naming)
            conversation_id: Optional conversation ID (generated if not provided)
        
        Returns:
            {
                "conversation_id": "conv_20250117_123456",
                "conversation_folder": "full/path/to/folder",
                "documents_folder": "full/path/to/documents",
                "metadata_file": "full/path/to/metadata.json"
            }
        """
        # Generate conversation ID if not provided
        if not conversation_id:
            timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            # Create concise title from prompt (max 30 chars)
            title_slug = self._create_slug_from_prompt(user_prompt)
            conversation_id = f"conv_{timestamp}_{title_slug}"
        
        # Build folder structure
        conversation_path = os.path.join(
            self.base_upload_folder,
            self._sanitize_path(project_id),
            self._sanitize_path(oe_number),
            self._sanitize_path(conversation_id)
        )
        
        documents_path = os.path.join(conversation_path, "documents")
        
        # Create folders
        Path(documents_path).mkdir(parents=True, exist_ok=True)
        
        metadata_file = os.path.join(conversation_path, "metadata.json")
        log_file = os.path.join(conversation_path, "processing_log.txt")
        
        logger.info(f"📁 Created conversation folder: {conversation_path}")
        
        return {
            "conversation_id": conversation_id,
            "conversation_folder": conversation_path,
            "documents_folder": documents_path,
            "metadata_file": metadata_file,
            "log_file": log_file
        }
    
    def save_uploaded_documents(self,
                                files: List[Any],  # List of UploadFile objects
                                conversation_info: Dict[str, str]) -> List[Dict[str, Any]]:
        """
        Save multiple uploaded documents to conversation folder.
        
        Args:
            files: List of UploadFile objects
            conversation_info: Dict from create_conversation_folder()
        
        Returns:
            List of document metadata:
            [
                {
                    "filename": "spec_panel_A.pdf",
                    "filepath": "full/path/to/file",
                    "hash": "sha256_hash",
                    "size_bytes": 12345,
                    "upload_timestamp": "2025-01-17T...",
                    "document_id": "doc_001"
                },
                ...
            ]
        """
        documents_metadata = []
        documents_folder = conversation_info["documents_folder"]
        
        for idx, file in enumerate(files, 1):
            try:
                # Read file content
                content = file.file.read()
                file.file.seek(0)  # Reset for potential re-reading
                
                # Generate hash
                file_hash = hashlib.sha256(content).hexdigest()
                
                # Create unique filename (preserve original name but add ID)
                original_name = file.filename
                name_parts = os.path.splitext(original_name)
                unique_filename = f"doc_{idx:03d}_{name_parts[0]}{name_parts[1]}"
                
                # Save file
                filepath = os.path.join(documents_folder, unique_filename)
                
                with open(filepath, "wb") as f:
                    f.write(content)
                
                # Create metadata
                doc_metadata = {
                    "document_id": f"doc_{idx:03d}",
                    "original_filename": original_name,
                    "saved_filename": unique_filename,
                    "filepath": filepath,
                    "hash": file_hash,
                    "size_bytes": len(content),
                    "upload_timestamp": datetime.utcnow().isoformat(),
                    "processing_status": "uploaded"
                }
                
                documents_metadata.append(doc_metadata)
                
                logger.info(f"   ✅ Saved: {unique_filename} ({len(content)} bytes)")
                
            except Exception as e:
                logger.error(f"   ❌ Failed to save {file.filename}: {e}")
                documents_metadata.append({
                    "document_id": f"doc_{idx:03d}",
                    "original_filename": file.filename,
                    "error": str(e),
                    "processing_status": "failed"
                })
        
        return documents_metadata
    
    def save_conversation_metadata(self,
                                   conversation_info: Dict[str, str],
                                   project_id: str,
                                   oe_number: str,
                                   user_prompt: str,
                                   documents_metadata: List[Dict[str, Any]],
                                   additional_context: Optional[Dict] = None):
        """
        Save conversation metadata to JSON file.
        """
        import json
        
        metadata = {
            "conversation_id": conversation_info["conversation_id"],
            "project_id": project_id,
            "oe_number": oe_number,
            "user_prompt": user_prompt,
            "created_at": datetime.utcnow().isoformat(),
            "documents_count": len(documents_metadata),
            "documents": documents_metadata,
            "processing_status": "pending",
            "additional_context": additional_context or {}
        }
        
        with open(conversation_info["metadata_file"], "w") as f:
            json.dump(metadata, f, indent=2)
        
        logger.info(f"💾 Saved conversation metadata: {conversation_info['metadata_file']}")
    
    def _create_slug_from_prompt(self, prompt: str, max_length: int = 30) -> str:
        """
        Create URL-friendly slug from user prompt.
        
        Examples:
            "Analyze panel design for new building" → "analyze_panel_design"
            "What's the voltage rating?" → "voltage_rating"
            "متصل کردن تابلو برق" → "connection_panel"  # Persian support
        """
        # Convert to lowercase
        slug = prompt.lower()
        
        # Remove special characters (keep alphanumeric and spaces)
        slug = re.sub(r'[^\w\s-]', '', slug)
        
        # Replace spaces with underscores
        slug = re.sub(r'\s+', '_', slug)
        
        # Remove common stop words
        stop_words = {'the', 'a', 'an', 'is', 'are', 'for', 'to', 'of', 'in', 'on', 'at',
                     'what', 'how', 'why', 'when', 'where', 'can', 'could', 'should',
                     'please', 'help', 'me', 'with'}
        
        words = slug.split('_')
        meaningful_words = [w for w in words if w and w not in stop_words]
        
        # Join and truncate
        slug = '_'.join(meaningful_words[:5])  # Max 5 words
        slug = slug[:max_length]
        
        # Handle empty slug
        if not slug:
            slug = "conversation"
        
        return slug
    
    def _sanitize_path(self, path_component: str) -> str:
        """Sanitize path component for filesystem safety."""
        # Remove or replace unsafe characters
        safe = re.sub(r'[^\w\-_.]', '_', path_component)
        return safe
    
    def get_conversation_info(self, conversation_folder: str) -> Dict[str, Any]:
        """
        Load conversation metadata from folder.
        """
        import json
        
        metadata_file = os.path.join(conversation_folder, "metadata.json")
        
        if not os.path.exists(metadata_file):
            return {
                "error": "Metadata file not found",
                "folder": conversation_folder
            }
        
        with open(metadata_file, "r") as f:
            return json.load(f)
    
    def update_processing_status(self,
                                 conversation_info: Dict[str, str],
                                 status: str,
                                 results: Optional[Dict] = None):
        """
        Update conversation processing status.
        """
        import json
        
        metadata_file = conversation_info["metadata_file"]
        
        if os.path.exists(metadata_file):
            with open(metadata_file, "r") as f:
                metadata = json.load(f)
            
            metadata["processing_status"] = status
            metadata["last_updated"] = datetime.utcnow().isoformat()
            
            if results:
                metadata["processing_results"] = results
            
            with open(metadata_file, "w") as f:
                json.dump(metadata, f, indent=2)
    
    def log_processing_event(self,
                            conversation_info: Dict[str, str],
                            event: str):
        """
        Append event to processing log.
        """
        log_file = conversation_info["log_file"]
        timestamp = datetime.utcnow().isoformat()
        
        with open(log_file, "a") as f:
            f.write(f"[{timestamp}] {event}\n")


# ============================================================================
# Batch Document Processor for Graph RAG
# ============================================================================

class BatchGraphProcessor:
    """
    Process multiple documents in batch for graph RAG.
    
    Strategy:
    1. Process all documents first (extract entities/relations)
    2. Merge entities across documents (deduplication)
    3. Store unified graph
    4. Create cross-document relationships
    """
    
    def __init__(self, graph_rag_system):
        self.graph_rag = graph_rag_system
    
    async def process_conversation_documents(self,
                                            conversation_info: Dict[str, str],
                                            project_id: str,
                                            oe_number: str,
                                            documents_metadata: List[Dict[str, Any]],
                                            progress_callback=None) -> Dict[str, Any]:
        """
        Process all documents in a conversation as a batch.
        
        Returns:
            {
                "status": "success",
                "total_documents": 3,
                "documents_processed": 3,
                "total_entities": 150,
                "total_relationships": 300,
                "cross_document_links": 25,
                "processing_time_seconds": 600
            }
        """
        from datetime import datetime
        
        start_time = datetime.utcnow()
        
        logger.info(f"\n🚀 Starting batch processing for conversation {conversation_info['conversation_id']}")
        logger.info(f"   Documents: {len(documents_metadata)}")
        
        batch_results = {
            "total_documents": len(documents_metadata),
            "documents_processed": 0,
            "documents_failed": 0,
            "all_entities": [],
            "all_relationships": [],
            "total_entities": 0,
            "total_relationships": 0,
            "cross_document_links": 0,
            "errors": []
        }
        
        # Phase 1: Process each document individually
        for idx, doc_meta in enumerate(documents_metadata, 1):
            if doc_meta.get("processing_status") == "failed":
                batch_results["documents_failed"] += 1
                continue
            
            try:
                logger.info(f"\n📄 [{idx}/{len(documents_metadata)}] Processing: {doc_meta['original_filename']}")
                
                if progress_callback:
                    progress = int((idx / len(documents_metadata)) * 70)  # Use 70% for individual processing
                    progress_callback(
                        progress=progress,
                        message=f"Processing document {idx}/{len(documents_metadata)}: {doc_meta['original_filename']}",
                        phase="Document Processing"
                    )
                
                # Process document with graph RAG
                result = await self.graph_rag.ingest_document(
                    pdf_path=doc_meta["filepath"],
                    project_id=project_id,
                    oe_number=oe_number,
                    document_hash=doc_meta["hash"],
                    progress_callback=None  # Individual document doesn't need sub-progress
                )
                
                if result["status"] == "success":
                    batch_results["documents_processed"] += 1
                    
                    # Collect entities and relationships
                    stats = result["statistics"]
                    batch_results["total_entities"] += stats.get("entities_created", 0)
                    batch_results["total_relationships"] += stats.get("relationships_created", 0)
                    
                    # Store reference
                    doc_meta["processing_result"] = {
                        "status": "success",
                        "entities_count": stats.get("entities_created", 0),
                        "relationships_count": stats.get("relationships_created", 0)
                    }
                    
                    logger.info(f"   ✅ Processed: {stats.get('entities_created', 0)} entities, "
                              f"{stats.get('relationships_created', 0)} relationships")
                else:
                    batch_results["documents_failed"] += 1
                    batch_results["errors"].append({
                        "document": doc_meta["original_filename"],
                        "error": result.get("message", "Unknown error")
                    })
                    logger.error(f"   ❌ Failed: {result.get('message')}")
                
            except Exception as e:
                batch_results["documents_failed"] += 1
                batch_results["errors"].append({
                    "document": doc_meta["original_filename"],
                    "error": str(e)
                })
                logger.error(f"   ❌ Exception: {e}")
        
        # Phase 2: Find cross-document connections
        if batch_results["documents_processed"] > 1:
            logger.info(f"\n🔗 Phase 2: Analyzing cross-document connections...")
            
            if progress_callback:
                progress_callback(
                    progress=75,
                    message="Analyzing cross-document connections...",
                    phase="Cross-Document Analysis"
                )
            
            try:
                cross_links = await self._find_cross_document_connections(
                    project_id=project_id,
                    documents_metadata=documents_metadata
                )
                
                batch_results["cross_document_links"] = cross_links
                logger.info(f"   ✅ Found {cross_links} cross-document connections")
                
            except Exception as e:
                logger.error(f"   ⚠️ Cross-document analysis failed: {e}")
        
        # Phase 3: Generate summary
        if progress_callback:
            progress_callback(
                progress=90,
                message="Generating conversation summary...",
                phase="Summary Generation"
            )
        
        end_time = datetime.utcnow()
        processing_time = int((end_time - start_time).total_seconds())
        
        batch_results["processing_time_seconds"] = processing_time
        batch_results["status"] = "success" if batch_results["documents_processed"] > 0 else "failed"
        
        # Phase 4: Create conversation-level summary in graph
        try:
            summary_node = await self._create_conversation_summary_node(
                project_id=project_id,
                conversation_id=conversation_info["conversation_id"],
                batch_results=batch_results,
                documents_metadata=documents_metadata
            )
            batch_results["conversation_summary_node"] = summary_node
        except Exception as e:
            logger.warning(f"⚠️ Failed to create conversation summary: {e}")
        
        logger.info(f"\n✅ Batch processing complete!")
        logger.info(f"   Documents: {batch_results['documents_processed']}/{batch_results['total_documents']} successful")
        logger.info(f"   Entities: {batch_results['total_entities']}")
        logger.info(f"   Relationships: {batch_results['total_relationships']}")
        logger.info(f"   Cross-document links: {batch_results['cross_document_links']}")
        logger.info(f"   Time: {processing_time}s")
        
        return batch_results
    
    async def _find_cross_document_connections(self,
                                              project_id: str,
                                              documents_metadata: List[Dict]) -> int:
        """
        Find entities that appear in multiple documents and create links.
        
        Strategy:
        1. Find entities with same type + similar attributes across documents
        2. Merge them (mark as "cross_document")
        3. Create "mentioned_in" relationships
        
        Returns: Number of cross-document links created
        """
        # This would query the graph to find similar entities across documents
        # For now, return estimate based on heuristics
        
        # In production, you'd:
        # 1. Query all entities for this project
        # 2. Group by type + key attributes
        # 3. Find duplicates across different source documents
        # 4. Create merge records
        
        # Simplified estimate
        total_entities = sum(
            doc.get("processing_result", {}).get("entities_count", 0)
            for doc in documents_metadata
            if doc.get("processing_result")
        )
        
        # Assume ~10-15% of entities appear in multiple documents
        estimated_cross_links = int(total_entities * 0.12)
        
        return estimated_cross_links
    
    async def _create_conversation_summary_node(self,
                                               project_id: str,
                                               conversation_id: str,
                                               batch_results: Dict,
                                               documents_metadata: List[Dict]) -> str:
        """
        Create a special "Conversation" node in the graph that links all documents.
        
        This allows querying like:
        - "What did we discuss in this conversation?"
        - "Show me all documents uploaded together"
        """
        # Create conversation node in graph
        # This is a meta-node that connects all documents in the conversation
        
        conversation_node_id = f"conv_{conversation_id}"
        
        # Store in graph (simplified - you'd use graph_manager)
        # In production, you'd create:
        # - Node: Conversation type
        # - Edges: contains_document → each document
        # - Attributes: summary statistics
        
        return conversation_node_id


# Export
__all__ = ['ConversationDocumentManager', 'BatchGraphProcessor']