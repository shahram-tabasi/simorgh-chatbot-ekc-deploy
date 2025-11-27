"""
Industrial Electrical RAG Chatbot

Complete chatbot that:
1. Accepts user questions
2. Retrieves relevant context from Neo4j knowledge graph
3. Generates natural language answers using LLM
4. Provides citations from source documents
"""

from graph_retrieval import GraphRetrieval
import openai
import os
from typing import Dict, Any, List
import json

class IndustrialElectricalChatbot:
    """
    RAG Chatbot for industrial electrical documentation.
    
    Combines graph-based retrieval with LLM generation for
    accurate, citation-backed answers.
    """
    
    def __init__(self, neo4j_uri: str = "bolt://localhost:7687",
                 neo4j_user: str = "neo4j",
                 neo4j_password: str = "cocoindex",
                 model: str = "gpt-4o"):
        """Initialize chatbot with graph retrieval and OpenAI"""
        self.retrieval = GraphRetrieval(neo4j_uri, neo4j_user, neo4j_password)
        self.openai_client = openai.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.model = model
        self.conversation_history = []
    
    def _format_context(self, context: Dict[str, Any], intent: str) -> str:
        """
        Format retrieved graph context into text for LLM.
        
        Structures the context based on intent type for optimal LLM understanding.
        """
        
        if "error" in context:
            return f"Error: {context['error']}"
        
        formatted = []
        
        # Format based on intent
        if intent == "equipment_spec":
            formatted.append("=== EQUIPMENT SPECIFICATION ===\n")
            
            if "equipment" in context:
                equipment = context["equipment"]
                formatted.append(f"Equipment: {equipment}")
                formatted.append(f"Type: {context.get('equipment_type', 'N/A')}\n")
            
            if "parameters" in context and context["parameters"]:
                formatted.append("Technical Parameters:")
                for param in context["parameters"]:
                    value_str = f"{param['value']} {param.get('unit', '')}"
                    if param.get('tolerance'):
                        value_str += f" {param['tolerance']}"
                    formatted.append(f"  - {param['name']}: {value_str}")
                formatted.append("")
            
            if "location" in context and context["location"]:
                loc = context["location"]
                formatted.append(f"Location: {loc.get('room', '')} in {loc.get('building', '')}\n")
            
            if "standards" in context and context["standards"]:
                formatted.append(f"Standards: {', '.join(context['standards'])}\n")
        
        elif intent == "load_tracing":
            formatted.append("=== POWER TRACING ===\n")
            
            if "load" in context:
                load = context["load"]
                formatted.append(f"Load: {load.get('load_name', load.get('load_id'))}")
                formatted.append(f"  Type: {load.get('load_type')}")
                formatted.append(f"  Power: {load.get('power_kw')} kW")
                formatted.append(f"  Voltage: {load.get('voltage')}\n")
            
            if "circuit" in context and context["circuit"]:
                circuit = context["circuit"]
                formatted.append(f"Fed by Circuit: {circuit.get('circuit_number')}")
                formatted.append(f"  Description: {circuit.get('description')}")
                formatted.append(f"  Cable Size: {circuit.get('cable_size')}\n")
            
            if "panel" in context and context["panel"]:
                panel = context["panel"]
                formatted.append(f"Source Panel: {panel.get('panel_id')}")
                formatted.append(f"  Type: {panel.get('panel_type')}")
                formatted.append(f"  Rating: {panel.get('voltage_rating')}, {panel.get('current_rating')}\n")
            
            if "breaker" in context and context["breaker"]:
                breaker = context["breaker"]
                formatted.append(f"Protection: {breaker.get('breaker_type')}, {breaker.get('rated_current')}\n")
        
        elif intent == "circuit_topology":
            formatted.append("=== PANEL CIRCUITS ===\n")
            
            if "panel" in context:
                panel = context["panel"]
                formatted.append(f"Panel: {panel.get('panel_id')} ({panel.get('panel_type')})")
                formatted.append(f"Rating: {panel.get('voltage_rating')}, {panel.get('current_rating')}\n")
            
            if "circuits" in context:
                formatted.append(f"Number of Circuits: {len(context['circuits'])}\n")
                
                for i, circ in enumerate(context['circuits'][:10], 1):  # Limit to 10 for brevity
                    circuit = circ['circuit']
                    formatted.append(f"Circuit {i}: {circuit.get('circuit_number')}")
                    formatted.append(f"  Description: {circuit.get('description')}")
                    formatted.append(f"  Amperage: {circuit.get('amperage')}")
                    
                    if circ['loads']:
                        loads = [f"{l.get('load_name')} ({l.get('power_kw')}kW)" 
                                for l in circ['loads']]
                        formatted.append(f"  Loads: {', '.join(loads)}")
                    
                    formatted.append("")
                
                if len(context['circuits']) > 10:
                    formatted.append(f"... and {len(context['circuits']) - 10} more circuits")
        
        elif intent == "equipment_location":
            formatted.append("=== EQUIPMENT BY LOCATION ===\n")
            
            if "location" in context:
                loc = context["location"]
                formatted.append(f"Location: {loc.get('name')} ({context.get('location_type')})\n")
            
            if "equipment" in context:
                formatted.append(f"Equipment Found: {len(context['equipment'])} items\n")
                
                for item in context['equipment']:
                    equip = item['equipment']
                    formatted.append(f"- {equip.get('panel_id') or equip.get('name')} ({item['type']})")
                    
                    if item['parameters']:
                        key_params = [f"{p['name']}: {p['value']}{p.get('unit', '')}" 
                                     for p in item['parameters'][:3]]
                        formatted.append(f"  {', '.join(key_params)}")
                    
                    formatted.append("")
        
        elif intent == "compliance_check":
            formatted.append("=== COMPLIANCE CHECK ===\n")
            
            if "equipment" in context:
                formatted.append(f"Equipment: {context['equipment']}")
                formatted.append(f"Type: {context.get('equipment_type')}\n")
                
                if "standards" in context:
                    formatted.append("Compliant Standards:")
                    for std in context['standards']:
                        formatted.append(f"  - {std.get('standard_id')}: {std.get('name')}")
                        if std.get('applies_to'):
                            formatted.append(f"    Applies to: {std['applies_to']}")
                    formatted.append("")
                
                if "requirements" in context:
                    formatted.append("Requirements:")
                    for req in context['requirements']:
                        formatted.append(f"  - {req.get('name')}: {req.get('value')}{req.get('unit', '')}")
            
            elif "standard" in context:
                formatted.append(f"Standard: {context['standard'].get('standard_id')}")
                formatted.append(f"Description: {context['standard'].get('name')}\n")
                
                if "compliant_equipment" in context:
                    formatted.append("Compliant Equipment:")
                    for equip in context['compliant_equipment']:
                        formatted.append(f"  - {equip['equipment']} ({equip['type']})")
        
        elif intent == "cross_reference":
            formatted.append("=== CROSS-DOCUMENT INFORMATION ===\n")
            
            if "equipment" in context:
                equipment = context["equipment"]
                formatted.append(f"Equipment: {equipment}")
                formatted.append(f"Type: {context.get('equipment_type')}\n")
            
            if "documents" in context:
                formatted.append(f"Referenced in {len(context['documents'])} documents:")
                for doc_info in context['documents']:
                    doc = doc_info['document']
                    formatted.append(f"  - {doc.get('title')} ({doc.get('document_type')})")
                    formatted.append(f"    Relationship: {doc_info['relationship']}")
                formatted.append("")
            
            if "parameters" in context and context['parameters']:
                formatted.append("Aggregated Parameters:")
                for param in context['parameters']:
                    formatted.append(f"  - {param.get('name')}: {param.get('value')} {param.get('unit', '')}")
                formatted.append("")
            
            if "connections" in context and context['connections']:
                formatted.append("Power Connections:")
                for conn in context['connections'][:5]:
                    formatted.append(f"  - Connected to {conn['node']} ({conn['type']})")
        
        else:
            # Generic formatting for other intents
            formatted.append(json.dumps(context, indent=2))
        
        return "\n".join(formatted)
    
    def _generate_answer(self, question: str, context_text: str, 
                        citations: List[Dict[str, str]]) -> str:
        """
        Generate natural language answer using LLM with retrieved context.
        
        Args:
            question: User's question
            context_text: Formatted context from graph
            citations: Source documents
            
        Returns:
            Natural language answer with citations
        """
        
        # Prepare citation text
        citation_text = ""
        if citations:
            citation_text = "\n\nSOURCE DOCUMENTS:\n"
            for i, doc in enumerate(citations, 1):
                citation_text += f"[{i}] {doc.get('title', doc.get('filename'))}"
                if doc.get('document_number'):
                    citation_text += f" ({doc['document_number']})"
                citation_text += "\n"
        
        # Generate answer
        messages = [
            {
                "role": "system",
                "content": """You are an expert assistant for industrial electrical systems.

Your task is to answer questions based ONLY on the provided context from the knowledge graph.

Guidelines:
1. Be precise and technical when discussing electrical specifications
2. Always cite source documents using [number] notation
3. If the context doesn't contain enough information, say so explicitly
4. Use proper units (kV, kA, kW, Hz, etc.)
5. Structure your answer clearly with bullet points when listing multiple items
6. If discussing power flow, trace the complete path
7. When referencing standards, cite them properly (e.g., IEC 62271)
8. For safety-critical information, be extra careful about accuracy

Format your response naturally but include citations like:
"Panel MDB-01 has a voltage rating of 400V ±10% [1] and is located in Building A, Room MV-101 [2]."

If the question cannot be answered with the provided context, say:
"I don't have enough information in the knowledge base to answer this question fully. The available documents don't contain [specific missing information]."
"""
            },
            {
                "role": "user",
                "content": f"""Question: {question}

CONTEXT FROM KNOWLEDGE GRAPH:
{context_text}
{citation_text}

Please answer the question based on the context provided. Include citations to source documents."""
            }
        ]
        
        response = self.openai_client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=0.1,  # Low temperature for factual accuracy
            max_tokens=1000
        )
        
        return response.choices[0].message.content
    
    def ask(self, question: str, include_raw_context: bool = False) -> Dict[str, Any]:
        """
        Main method to ask a question and get an answer.
        
        Args:
            question: User's natural language question
            include_raw_context: Whether to include raw graph context in response
            
        Returns:
            Dictionary containing:
            - question: Original question
            - answer: Natural language answer
            - citations: Source documents
            - intent: Classified intent
            - entities: Extracted entities
            - raw_context: (optional) Raw graph context
        """
        
        # Step 1: Retrieve relevant context from graph
        retrieval_result = self.retrieval.retrieve(question)
        
        # Step 2: Format context for LLM
        context_text = self._format_context(
            retrieval_result["context"],
            retrieval_result["intent"]
        )
        
        # Step 3: Generate answer using LLM
        answer = self._generate_answer(
            question,
            context_text,
            retrieval_result["citations"]
        )
        
        # Step 4: Prepare response
        response = {
            "question": question,
            "answer": answer,
            "citations": retrieval_result["citations"],
            "intent": retrieval_result["intent"],
            "entities": retrieval_result["entities"]
        }
        
        if include_raw_context:
            response["raw_context"] = retrieval_result["context"]
            response["formatted_context"] = context_text
        
        # Store in conversation history
        self.conversation_history.append({
            "question": question,
            "answer": answer,
            "intent": retrieval_result["intent"]
        })
        
        return response
    
    def multi_turn_ask(self, question: str, include_raw_context: bool = False) -> Dict[str, Any]:
        """
        Ask a question with conversation history context.
        Enables follow-up questions like "What about its location?" after asking about equipment.
        """
        
        # Include recent conversation history in prompt
        history_context = ""
        if self.conversation_history:
            history_context = "\n\nRECENT CONVERSATION:\n"
            for turn in self.conversation_history[-3:]:  # Last 3 turns
                history_context += f"Q: {turn['question']}\nA: {turn['answer']}\n\n"
        
        # For now, just call regular ask()
        # Can be enhanced to use history for entity resolution
        return self.ask(question, include_raw_context)
    
    def clear_history(self):
        """Clear conversation history"""
        self.conversation_history = []
    
    def close(self):
        """Close connections"""
        self.retrieval.close()


# ============================================================================
# EXAMPLE USAGE & DEMO
# ============================================================================

def demo_chatbot():
    """Demonstrate chatbot capabilities"""
    
    print("="*80)
    print("INDUSTRIAL ELECTRICAL RAG CHATBOT")
    print("="*80)
    
    # Initialize chatbot
    chatbot = IndustrialElectricalChatbot()
    
    # Example questions
    questions = [
        "What are the specifications of Panel MDB-01?",
        "Which panel feeds Load ABC-123?",
        "Show me all circuits from Panel MCC-02",
        "What equipment is located in Building A, Room 101?",
        "Does the 33kV switchgear comply with IEC 62271 standard?",
        "Find all information about Transformer TR-01 across all documents"
    ]
    
    for question in questions:
        print(f"\n{'='*80}")
        print(f"USER: {question}")
        print(f"{'='*80}\n")
        
        # Get answer
        response = chatbot.ask(question, include_raw_context=False)
        
        # Print answer
        print(f"ASSISTANT: {response['answer']}\n")
        
        # Print metadata
        print(f"Intent: {response['intent']}")
        print(f"Entities: {response['entities']}")
        
        if response['citations']:
            print(f"\nSource Documents:")
            for i, cite in enumerate(response['citations'], 1):
                print(f"  [{i}] {cite.get('title', cite.get('filename'))}")
        
        print("\n" + "-"*80)
    
    # Clean up
    chatbot.close()


if __name__ == "__main__":
    demo_chatbot()