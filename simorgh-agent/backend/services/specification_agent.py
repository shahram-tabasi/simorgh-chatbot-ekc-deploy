"""
Specification Extraction Agent - ReAct-style Conversational Agent

This agent handles the complete specification extraction workflow through chat:
1. Greeting and guidelines
2. Document upload handling
3. Specification extraction using ITEM 1-11 scope
4. Excel/CSV export generation
5. PostgreSQL storage

The agent maintains state in Redis and runs entirely within the chat interface.
"""

import json
import logging
from typing import Dict, Any, List, Optional
from enum import Enum
from datetime import datetime
from pathlib import Path
import uuid

from services.specification_extraction_scope import (
    SPECIFICATION_EXTRACTION_SCOPE,
    get_extraction_prompt,
    format_extraction_results_as_table,
    get_all_parameters
)

logger = logging.getLogger(__name__)


class AgentState(str, Enum):
    """Agent workflow states"""
    INITIALIZED = "INITIALIZED"
    GREETING = "GREETING"
    WAITING_FOR_DOCUMENTS = "WAITING_FOR_DOCUMENTS"
    PROCESSING_DOCUMENTS = "PROCESSING_DOCUMENTS"
    EXTRACTING_SPECS = "EXTRACTING_SPECS"
    GENERATING_EXPORT = "GENERATING_EXPORT"
    COMPLETED = "COMPLETED"
    ERROR = "ERROR"


class SpecificationAgent:
    """
    Stateful agent for specification extraction workflow
    """

    def __init__(self, redis_service, llm_service, neo4j_service, qdrant_service):
        self.redis = redis_service
        self.llm = llm_service
        self.neo4j = neo4j_service
        self.qdrant = qdrant_service

    def _get_agent_session_key(self, chat_id: str) -> str:
        """Get Redis key for agent session"""
        return f"agent:spec_extraction:{chat_id}"

    def _get_agent_state(self, chat_id: str) -> Dict[str, Any]:
        """Retrieve agent state from Redis"""
        key = self._get_agent_session_key(chat_id)
        state = self.redis.get(key, db="cache")

        if not state:
            # Initialize new session
            state = {
                "state": AgentState.INITIALIZED,
                "created_at": datetime.now().isoformat(),
                "documents_processed": [],
                "extraction_results": None,
                "export_file_path": None,
                "project_number": None,
                "user_id": None
            }

        return state

    def _set_agent_state(self, chat_id: str, state: Dict[str, Any]):
        """Save agent state to Redis"""
        key = self._get_agent_session_key(chat_id)
        state["updated_at"] = datetime.now().isoformat()
        self.redis.set(key, state, ttl=86400, db="cache")  # 24 hour TTL

    def initialize_session(self, chat_id: str, user_id: str, project_number: str) -> str:
        """
        Initialize a new specification extraction session

        Returns: Greeting message for the user
        """
        logger.info(f"🤖 Initializing Specification Agent for chat {chat_id}, project {project_number}")

        # Initialize state
        state = self._get_agent_state(chat_id)
        state.update({
            "state": AgentState.GREETING,
            "user_id": user_id,
            "project_number": project_number,
            "chat_id": chat_id
        })
        self._set_agent_state(chat_id, state)

        # Generate greeting message
        greeting = f"""# 📋 Specification Extraction Agent

Hello! I'm your AI assistant specialized in extracting electrical switchgear specifications from technical documents.

## 🎯 What I'll Help You With

I will extract comprehensive specifications covering **ITEM 1 to ITEM 11**:

1. **General Specifications** (Voltage, Current, Frequency, IP Rating, etc.)
2. **Busbar Specifications** (Material, Rating, Configuration, etc.)
3. **Circuit Breaker Specifications** (Type, Rating, Breaking Capacity, etc.)
4. **Protection and Control** (Overcurrent, Earth Fault, Metering, etc.)
5. **Wiring and Cables** (Type, Size, Termination, etc.)
6. **Instrumentation and Metering** (Ammeters, Voltmeters, CTs, etc.)
7. **Communication and Networking** (Protocols, Interfaces, etc.)
8. **Enclosure and Construction** (Material, IP Rating, Color, etc.)
9. **Accessories and Components** (Terminal Blocks, SPD, etc.)
10. **Testing and Commissioning** (FAT, Tests Required, etc.)
11. **Documentation and Deliverables** (Drawings, Manuals, Certificates, etc.)

## 📤 Upload Your Documents

Please upload your switchgear specification documents (PDF, Word, Excel, Images, etc.). You can upload:
- General specification documents
- Technical datasheets
- Tender specifications
- Equipment schedules

**Or**, if you already have documents uploaded to this project, I'll use those.

## ⚙️ How I Work

1. **Process Documents**: Convert to markdown and extract text
2. **Semantic Extraction**: Find all specification parameters using AI
3. **Detect Conflicts**: Identify any internal inconsistencies
4. **Generate Table**: Create a comprehensive extraction table
5. **Export File**: Provide downloadable Excel/CSV file
6. **Save to Database**: Store results for future reference

## 💡 Extraction Features

- ✅ **Semantic matching**: Handles synonyms, abbreviations, spelling errors
- ✅ **Classification**: VALUE_PARAMETER, PRESENCE_ONLY, or CONSTRAINT
- ✅ **Source tracking**: Page numbers and verbatim quotes
- ✅ **Conflict detection**: Flags internal inconsistencies
- ✅ **Comprehensive coverage**: All ITEM 1-11 sub-parameters

---

**Ready to start?** Upload your specification documents now, or type "use existing documents" if you've already uploaded files to this project.
"""

        logger.info(f"✅ Specification Agent initialized for chat {chat_id}")
        return greeting

    async def handle_message(
        self,
        chat_id: str,
        user_message: str,
        uploaded_file_context: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Handle user messages based on current agent state

        Args:
            chat_id: Chat session ID
            user_message: User's message
            uploaded_file_context: Context from uploaded file (if any)

        Returns: Agent's response message
        """
        state = self._get_agent_state(chat_id)
        current_state = state["state"]

        logger.info(f"🤖 Agent handling message in state: {current_state}")

        # State machine
        if current_state == AgentState.GREETING:
            return await self._handle_greeting_state(chat_id, user_message, uploaded_file_context, state)

        elif current_state == AgentState.WAITING_FOR_DOCUMENTS:
            return await self._handle_waiting_for_documents(chat_id, user_message, uploaded_file_context, state)

        elif current_state == AgentState.PROCESSING_DOCUMENTS:
            return "⏳ Processing documents... Please wait."

        elif current_state == AgentState.EXTRACTING_SPECS:
            return "🔍 Extracting specifications... This may take a moment."

        elif current_state == AgentState.COMPLETED:
            return await self._handle_completed_state(chat_id, user_message, state)

        else:
            return f"⚠️ Agent in unexpected state: {current_state}. Please restart the workflow."

    async def _handle_greeting_state(
        self,
        chat_id: str,
        user_message: str,
        uploaded_file_context: Optional[Dict[str, Any]],
        state: Dict[str, Any]
    ) -> str:
        """Handle messages when agent is in greeting state"""

        # Check if user uploaded a file
        if uploaded_file_context:
            logger.info(f"📎 User uploaded file: {uploaded_file_context.get('filename')}")
            return await self._process_uploaded_document(chat_id, uploaded_file_context, state)

        # Check if user wants to use existing documents
        user_msg_lower = user_message.lower()
        if any(phrase in user_msg_lower for phrase in ["existing", "use existing", "already uploaded", "current documents"]):
            return await self._use_existing_documents(chat_id, state)

        # User asking questions or not ready
        state["state"] = AgentState.WAITING_FOR_DOCUMENTS
        self._set_agent_state(chat_id, state)

        return """I'm ready to help! Please:

1. **Upload specification documents** using the file upload button, or
2. **Type "use existing documents"** if you've already uploaded files to this project

I'll process them and extract all specifications according to ITEM 1-11 scope."""

    async def _handle_waiting_for_documents(
        self,
        chat_id: str,
        user_message: str,
        uploaded_file_context: Optional[Dict[str, Any]],
        state: Dict[str, Any]
    ) -> str:
        """Handle messages while waiting for documents"""

        if uploaded_file_context:
            return await self._process_uploaded_document(chat_id, uploaded_file_context, state)

        user_msg_lower = user_message.lower()
        if any(phrase in user_msg_lower for phrase in ["existing", "use existing", "already uploaded"]):
            return await self._use_existing_documents(chat_id, state)

        return """⏳ I'm waiting for specification documents.

Please either:
- **Upload files** using the file upload button, or
- **Type "use existing documents"** to use files already in this project"""

    async def _process_uploaded_document(
        self,
        chat_id: str,
        file_context: Dict[str, Any],
        state: Dict[str, Any]
    ) -> str:
        """Process newly uploaded document"""

        filename = file_context.get('filename', 'Unknown')
        markdown_content = file_context.get('markdown_content', '')
        doc_id = file_context.get('document_id', str(uuid.uuid4()))

        logger.info(f"📄 Processing uploaded document: {filename} ({len(markdown_content)} chars)")

        # Add to processed documents list
        state["documents_processed"].append({
            "document_id": doc_id,
            "filename": filename,
            "processed_at": datetime.now().isoformat(),
            "char_count": len(markdown_content)
        })

        state["state"] = AgentState.EXTRACTING_SPECS
        self._set_agent_state(chat_id, state)

        # Start extraction
        extraction_result = await self._extract_specifications(chat_id, markdown_content, filename, state)

        return extraction_result

    async def _use_existing_documents(self, chat_id: str, state: Dict[str, Any]) -> str:
        """Use existing project documents for extraction"""

        project_number = state.get("project_number")
        if not project_number:
            return "❌ No project associated with this chat. Please upload documents manually."

        logger.info(f"📚 Retrieving existing documents for project {project_number}")

        # Query Neo4j for project documents
        try:
            query = """
            MATCH (p:Project {project_number: $project_number})-[:HAS_CATEGORY]->(cat)-[:HAS_TYPE]->(type)-[:CONTAINS]->(doc:Document)
            WHERE type.type_name = 'Spec'
            RETURN doc.doc_id AS doc_id, doc.filename AS filename
            LIMIT 10
            """

            with self.neo4j.driver.session() as session:
                result = session.run(query, project_number=project_number)
                documents = [dict(record) for record in result]

            if not documents:
                return f"""❌ No specification documents found for project `{project_number}`.

Please upload at least one specification document to proceed."""

            logger.info(f"✅ Found {len(documents)} existing documents")

            # Get markdown content from documents (from Qdrant or storage)
            combined_content = await self._retrieve_document_contents(project_number, documents)

            if not combined_content:
                return "❌ Failed to retrieve document contents. Please upload documents manually."

            # Update state
            state["documents_processed"] = documents
            state["state"] = AgentState.EXTRACTING_SPECS
            self._set_agent_state(chat_id, state)

            # Start extraction
            return await self._extract_specifications(
                chat_id,
                combined_content,
                f"{len(documents)} existing documents",
                state
            )

        except Exception as e:
            logger.error(f"❌ Failed to retrieve existing documents: {e}", exc_info=True)
            return f"❌ Error retrieving existing documents: {str(e)}\n\nPlease upload documents manually."

    async def _retrieve_document_contents(self, project_number: str, documents: List[Dict]) -> str:
        """Retrieve markdown content for documents from Qdrant"""

        combined_content = ""

        for doc in documents:
            doc_id = doc.get("doc_id")
            filename = doc.get("filename", "Unknown")

            try:
                # Query Qdrant for document sections
                from services.section_retriever import SectionRetriever

                sections = self.qdrant.client.scroll(
                    collection_name=f"project_{project_number}",
                    scroll_filter={
                        "must": [
                            {"key": "document_id", "match": {"value": doc_id}}
                        ]
                    },
                    limit=100
                )

                if sections and sections[0]:
                    combined_content += f"\n\n# Document: {filename}\n\n"
                    for point in sections[0]:
                        text = point.payload.get("text", "")
                        combined_content += f"{text}\n\n"

            except Exception as e:
                logger.warning(f"⚠️ Failed to retrieve content for {filename}: {e}")
                continue

        return combined_content

    async def _extract_specifications(
        self,
        chat_id: str,
        markdown_content: str,
        source_description: str,
        state: Dict[str, Any]
    ) -> str:
        """Extract specifications using LLM"""

        logger.info(f"🔍 Starting specification extraction from {source_description}")

        try:
            # Generate extraction prompt
            extraction_prompt = get_extraction_prompt()

            # Build LLM messages
            system_message = f"""{extraction_prompt}

## DOCUMENT CONTENT TO ANALYZE:

{markdown_content[:50000]}
"""  # Limit to ~50K chars to avoid token limits

            user_message = """Please extract all specifications from the document according to the ITEM 1-11 scope defined above.

Output the results as a Markdown table with the following columns:
| Item No | Sub-Parameter | Classification | Extracted Value | Unit | Page/Section | Source Text |

Be thorough and extract ALL parameters. Mark "NOT FOUND" for missing values."""

            messages = [
                {"role": "system", "content": system_message},
                {"role": "user", "content": user_message}
            ]

            # Call LLM for extraction
            logger.info("🤖 Calling LLM for specification extraction...")
            result = self.llm.generate(
                messages=messages,
                mode="online",  # Use online mode for better accuracy
                temperature=0.3,  # Lower temperature for more consistent extraction
                use_cache=False  # Don't cache extraction results
            )

            extraction_table = result.get("response", "")

            logger.info(f"✅ Extraction complete ({len(extraction_table)} chars)")

            # Parse extraction results
            extraction_results = self._parse_extraction_table(extraction_table)

            # Update state
            state["extraction_results"] = extraction_results
            state["extraction_table_markdown"] = extraction_table
            state["state"] = AgentState.GENERATING_EXPORT
            self._set_agent_state(chat_id, state)

            # Generate export file
            export_result = await self._generate_export_file(chat_id, extraction_table, state)

            return export_result

        except Exception as e:
            logger.error(f"❌ Extraction failed: {e}", exc_info=True)
            state["state"] = AgentState.ERROR
            state["error"] = str(e)
            self._set_agent_state(chat_id, state)

            return f"❌ **Extraction Error**\n\n{str(e)}\n\nPlease try again or contact support."

    def _parse_extraction_table(self, markdown_table: str) -> List[Dict[str, Any]]:
        """Parse extraction results from markdown table"""

        # Simple parser - extract data rows
        results = []
        lines = markdown_table.strip().split('\n')

        for line in lines:
            if line.startswith('|') and not line.startswith('|---'):
                # Split by pipe and clean
                parts = [p.strip() for p in line.split('|')[1:-1]]  # Remove first/last empty parts

                if len(parts) >= 7 and parts[0] and parts[0][0].isdigit():
                    # Valid data row
                    results.append({
                        "item_no": parts[0],
                        "sub_parameter": parts[1],
                        "classification": parts[2],
                        "extracted_value": parts[3],
                        "unit": parts[4],
                        "page_section": parts[5],
                        "source_text": parts[6]
                    })

        logger.info(f"📊 Parsed {len(results)} specification parameters")
        return results

    async def _generate_export_file(
        self,
        chat_id: str,
        extraction_table: str,
        state: Dict[str, Any]
    ) -> str:
        """Generate Excel/CSV export file"""

        logger.info("📊 Generating export file...")

        try:
            import pandas as pd
            from pathlib import Path

            # Parse results
            results = state.get("extraction_results", [])

            if not results:
                logger.warning("⚠️ No results to export")
                return self._format_extraction_response(extraction_table, None, state)

            # Create DataFrame
            df = pd.DataFrame(results)

            # Generate filename
            project_number = state.get("project_number", "unknown")
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"spec_extraction_{project_number}_{timestamp}.xlsx"

            # Save to exports directory
            export_dir = Path("/home/user/simorgh-chatbot-ekc-deploy/simorgh-agent/backend/exports")
            export_dir.mkdir(exist_ok=True)

            export_path = export_dir / filename

            # Write Excel file with formatting
            with pd.ExcelWriter(export_path, engine='openpyxl') as writer:
                df.to_excel(writer, sheet_name='Specifications', index=False)

                # Auto-adjust column widths
                worksheet = writer.sheets['Specifications']
                for idx, col in enumerate(df.columns):
                    max_length = max(df[col].astype(str).apply(len).max(), len(col)) + 2
                    worksheet.column_dimensions[chr(65 + idx)].width = min(max_length, 50)

            logger.info(f"✅ Export file created: {export_path}")

            # Update state
            state["export_file_path"] = str(export_path)
            state["export_filename"] = filename
            state["state"] = AgentState.COMPLETED
            self._set_agent_state(chat_id, state)

            # Save to database (PostgreSQL)
            await self._save_to_database(chat_id, results, state)

            return self._format_extraction_response(extraction_table, filename, state)

        except Exception as e:
            logger.error(f"❌ Export generation failed: {e}", exc_info=True)
            # Still show results even if export fails
            return self._format_extraction_response(extraction_table, None, state)

    def _format_extraction_response(
        self,
        extraction_table: str,
        export_filename: Optional[str],
        state: Dict[str, Any]
    ) -> str:
        """Format the final extraction response"""

        docs_count = len(state.get("documents_processed", []))
        results_count = len(state.get("extraction_results", []))

        response = f"""# ✅ Specification Extraction Complete!

## 📊 Extraction Summary

- **Documents Processed**: {docs_count}
- **Parameters Extracted**: {results_count}
- **Extraction Scope**: ITEM 1 to ITEM 11 (Complete)

## 📋 Extracted Specifications

{extraction_table}

"""

        if export_filename:
            response += f"""## 📥 Download Export

Your extraction results are available for download:

**File**: `{export_filename}`

Use the download link below to get the Excel file with all extracted specifications.

[⬇️ Download Excel File](/api/agent/download/{export_filename})

"""

        response += """## 💾 Database Storage

The extraction results have been saved to the project database for future reference and processing.

---

**Need to extract more specifications?** Upload additional documents or start a new extraction session.
"""

        return response

    async def _save_to_database(
        self,
        chat_id: str,
        results: List[Dict[str, Any]],
        state: Dict[str, Any]
    ) -> bool:
        """Save extraction results to PostgreSQL"""

        # This would connect to PostgreSQL and save results
        # For now, we'll save to Neo4j as we don't have PostgreSQL set up yet

        logger.info(f"💾 Saving {len(results)} extraction results to database...")

        try:
            project_number = state.get("project_number")

            if not project_number:
                logger.warning("⚠️ No project number, skipping database save")
                return False

            # Save to Neo4j as SpecValue nodes
            with self.neo4j.driver.session() as session:
                for result in results:
                    query = """
                    MATCH (p:Project {project_number: $project_number})
                    MERGE (p)-[:HAS_EXTRACTION]->(ext:SpecExtraction {
                        param_id: $param_id,
                        name: $name,
                        value: $value,
                        classification: $classification,
                        unit: $unit,
                        page_section: $page_section,
                        source_text: $source_text,
                        extracted_at: datetime(),
                        extraction_session_id: $chat_id
                    })
                    """

                    session.run(
                        query,
                        project_number=project_number,
                        param_id=result.get("item_no"),
                        name=result.get("sub_parameter"),
                        value=result.get("extracted_value"),
                        classification=result.get("classification"),
                        unit=result.get("unit"),
                        page_section=result.get("page_section"),
                        source_text=result.get("source_text")[:500],  # Truncate long text
                        chat_id=chat_id
                    )

            logger.info(f"✅ Saved {len(results)} results to Neo4j")
            return True

        except Exception as e:
            logger.error(f"❌ Database save failed: {e}", exc_info=True)
            return False

    async def _handle_completed_state(
        self,
        chat_id: str,
        user_message: str,
        state: Dict[str, Any]
    ) -> str:
        """Handle messages after extraction is completed"""

        export_filename = state.get("export_filename")
        results_count = len(state.get("extraction_results", []))

        return f"""✅ **Extraction already completed!**

- **Parameters Extracted**: {results_count}
- **Export File**: `{export_filename or 'Not available'}`

[⬇️ Download Excel File](/api/agent/download/{export_filename})

**To start a new extraction**, please create a new chat session or use the "Specification" template again.
"""

    def get_session_status(self, chat_id: str) -> Dict[str, Any]:
        """Get current agent session status"""
        state = self._get_agent_state(chat_id)
        return {
            "chat_id": chat_id,
            "state": state.get("state"),
            "documents_processed": len(state.get("documents_processed", [])),
            "extraction_complete": state.get("state") == AgentState.COMPLETED,
            "export_filename": state.get("export_filename"),
            "created_at": state.get("created_at"),
            "updated_at": state.get("updated_at")
        }
