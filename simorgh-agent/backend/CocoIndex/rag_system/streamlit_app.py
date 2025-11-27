"""
Streamlit Web Interface for Industrial Electrical RAG Chatbot

Simple, user-friendly web UI for asking questions about electrical documentation.
"""

import streamlit as st
from rag_chatbot import IndustrialElectricalChatbot
import os

# Page configuration
st.set_page_config(
    page_title="Industrial Electrical Assistant",
    page_icon="⚡",
    layout="wide"
)

# Initialize chatbot (cached for performance)
@st.cache_resource
def get_chatbot():
    return IndustrialElectricalChatbot(
        neo4j_uri=os.getenv("NEO4J_URI", "bolt://localhost:7687"),
        neo4j_user=os.getenv("NEO4J_USERNAME", "neo4j"),
        neo4j_password=os.getenv("NEO4J_PASSWORD", "cocoindex")
    )

# Main UI
def main():
    st.title("⚡ Industrial Electrical Documentation Assistant")
    st.markdown("""
    Ask questions about your electrical documentation. I can help you find:
    - Equipment specifications and ratings
    - Power flow and circuit topology
    - Load connections and panel schedules
    - Compliance and standards
    - Equipment locations
    - IO mappings
    """)
    
    # Sidebar
    with st.sidebar:
        st.header("ℹ️ About")
        st.markdown("""
        This chatbot uses a **knowledge graph** built from your electrical documentation
        (specs, datasheets, load lists, IO lists, site layouts, etc.) to provide
        accurate, citation-backed answers.
        
        **Powered by:**
        - CocoIndex (document processing)
        - Neo4j (knowledge graph)
        - GPT-4 (answer generation)
        """)
        
        st.header("📄 Document Stats")
        
        # Get stats from Neo4j
        try:
            chatbot = get_chatbot()
            
            # Query document count
            with chatbot.retrieval.driver.session() as session:
                doc_count = session.run("MATCH (d:Document) RETURN COUNT(d) AS count").single()["count"]
                panel_count = session.run("MATCH (p:Panel) RETURN COUNT(p) AS count").single()["count"]
                load_count = session.run("MATCH (l:Load) RETURN COUNT(l) AS count").single()["count"]
                circuit_count = session.run("MATCH (c:Circuit) RETURN COUNT(c) AS count").single()["count"]
            
            st.metric("Documents", doc_count)
            st.metric("Panels", panel_count)
            st.metric("Loads", load_count)
            st.metric("Circuits", circuit_count)
        except:
            st.warning("Unable to connect to knowledge graph. Please check Neo4j is running.")
        
        st.header("🔧 Settings")
        show_intent = st.checkbox("Show intent classification", value=False)
        show_entities = st.checkbox("Show extracted entities", value=False)
        show_context = st.checkbox("Show raw context", value=False)
        
        if st.button("Clear Conversation"):
            if 'chatbot' in st.session_state:
                st.session_state.chatbot.clear_history()
            st.rerun()
    
    # Chat interface
    if "messages" not in st.session_state:
        st.session_state.messages = []
    
    # Display chat history
    for message in st.session_state.messages:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])
            
            # Show metadata if available
            if "metadata" in message and message["metadata"]:
                with st.expander("📊 Response Details"):
                    if show_intent:
                        st.write(f"**Intent:** {message['metadata'].get('intent', 'N/A')}")
                    if show_entities:
                        st.write(f"**Entities:** {message['metadata'].get('entities', [])}")
                    if "citations" in message["metadata"] and message["metadata"]["citations"]:
                        st.write("**Source Documents:**")
                        for cite in message["metadata"]["citations"]:
                            st.write(f"- {cite.get('title', cite.get('filename'))}")
                    if show_context and "formatted_context" in message["metadata"]:
                        st.code(message["metadata"]["formatted_context"])
    
    # Chat input
    if prompt := st.chat_input("Ask a question about your electrical documentation..."):
        # Display user message
        st.session_state.messages.append({"role": "user", "content": prompt})
        with st.chat_message("user"):
            st.markdown(prompt)
        
        # Get chatbot response
        with st.chat_message("assistant"):
            with st.spinner("Searching knowledge graph..."):
                try:
                    chatbot = get_chatbot()
                    response = chatbot.ask(prompt, include_raw_context=show_context)
                    
                    # Display answer
                    st.markdown(response["answer"])
                    
                    # Store response
                    st.session_state.messages.append({
                        "role": "assistant",
                        "content": response["answer"],
                        "metadata": {
                            "intent": response["intent"],
                            "entities": response["entities"],
                            "citations": response["citations"],
                            "formatted_context": response.get("formatted_context", "")
                        }
                    })
                
                except Exception as e:
                    error_msg = f"❌ Error: {str(e)}"
                    st.error(error_msg)
                    st.session_state.messages.append({
                        "role": "assistant",
                        "content": error_msg,
                        "metadata": {}
                    })
    
    # Example questions
    st.markdown("---")
    st.markdown("### 💡 Example Questions")
    
    examples = [
        "What are the specs of Panel MDB-01?",
        "Which panel feeds Load ABC-123?",
        "Show all circuits from Panel MCC-02",
        "What equipment is in Building A Room 101?",
        "Does the switchgear comply with IEC 62271?"
    ]
    
    cols = st.columns(len(examples))
    for col, example in zip(cols, examples):
        with col:
            if st.button(example, key=example):
                st.session_state.messages.append({"role": "user", "content": example})
                st.rerun()


# Run the app
if __name__ == "__main__":
    main()